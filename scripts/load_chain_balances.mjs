#!/usr/bin/env node
/**
 * Step 2 of AXIS_ALIGNMENT.md §6 — Axis 4 (risk control) · read wallet balances from chain.
 *
 * WHY THIS EXISTS. Axis 4 needs `cashShare` and `concentration`; both are ratios over
 * holdings_current. 67 of 144 traders had no holdings row at all, so the axis could not
 * render for them under any formula. That was never missing data — we were only ever
 * asking fomo, and build_directory_fomoapi.py records that /v2/users/{handle} answers
 * "trader not found" for anyone outside its top 100. 44 of the 67 are outside it and fomo
 * will never serve them; the other 23 are inside it and came back empty.
 *
 * NO NEW PROVIDER, NO NEW KEY, NOTHING PAID.
 *   solana                     Helius getTokenAccountsByOwner  (HELIUS_SOLANA_KEY, already held)
 *   robinhood, bsc, base, eth  the public RPC in `chains.rpc`, batched eth_call balanceOf
 *
 * Blockscout was the first choice for robinhood and is what `chains.history_provider` names,
 * but robinhoodchain.blockscout.com sits behind Cloudflare and answers 403 to any client
 * without a browser. The chain's own RPC answers the same question for free, so every EVM
 * chain now goes down one code path instead of three.
 *
 * A snapshot, not a history. Axis 4 asks what they hold NOW — one query per wallet per
 * chain. That is why this is a day of work and the EVM swap resolver (Axes 2 and 5, which
 * need every buy and sell reconstructed) is two to three.
 *
 *   node scripts/load_chain_balances.mjs               # traders with no holdings (default)
 *   node scripts/load_chain_balances.mjs --all         # every trader that has a wallet
 *   node scripts/load_chain_balances.mjs --handle soby0x
 *   node scripts/load_chain_balances.mjs --chain solana --dry-run
 */
import pg from "pg";
import {
  SOLANA_NETWORK_ID, SOL_MINT, solanaBalances, evmBalances,
} from "./lib/chain_reads.mjs";

const DB  = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
const KEY = (process.env.HELIUS_SOLANA_KEY ?? "").trim();
if (!DB) { console.error("DATABASE_URL is not set"); process.exit(1); }

const SOLANA = SOLANA_NETWORK_ID;

const arg  = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const ONLY_HANDLE = arg("handle");
const ONLY_CHAIN  = arg("chain");
const DRY = flag("dry-run");
const ALL = flag("all");

const pool = new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 4 });

/*
 * The chain reads live in scripts/lib/chain_reads.mjs so the hourly AUM sampler reads
 * balances THE SAME WAY this does. Two implementations would drift the first time either
 * was edited, and "a running total is not a balance" is exactly the bug AUM exists to fix.
 */

async function main() {
  const { rows: chains } = await pool.query(`select network_id::bigint, name, rpc from chains order by network_id`);
  const chainById = new Map(chains.map((c) => [String(c.network_id), c]));

  const { rows: targets } = await pool.query(`
    select t.handle, w.evm_address, w.sol_address
    from traders t
    join wallets w on w.handle = t.handle
    where ($1::text is null or t.handle = $1)
      -- Naming a handle means that handle, whether or not it already has holdings;
      -- otherwise the default is gap-fill and --all overrides it.
      --
      -- "Gap" is measured against FOMO's coverage, not against holdings_current, so that a
      -- run which lost one chain to a 403 is retried by the next run instead of counting
      -- as done on the strength of the chains that did succeed.
      and ($1::text is not null or $2::bool
           or not exists (select 1 from holdings_current hc
                          where hc.handle = t.handle and hc.source = 'fomo'))
    order by t.handle`, [ONLY_HANDLE, ALL]);

  console.log(`${targets.length} trader(s) to read` +
              (ALL ? " (--all)" : " — these have no holdings row today") +
              (DRY ? "  [DRY RUN]" : ""));
  if (!targets.length) { await pool.end(); return; }

  // Every EVM token any target has traded, grouped by chain. One query, not one per trader.
  const { rows: traded } = await pool.query(`
    select tr.handle, tr.network_id::bigint, tr.token_key, min(tr.token_address) as address
    from trades tr
    where tr.handle = any($1) and tr.network_id <> $2
    group by 1,2,3`, [targets.map((t) => t.handle), SOLANA]);

  const { rows: known } = await pool.query(`select network_id::bigint, token_key, decimals from tokens where decimals is not null`);
  const decimals = new Map();               // "networkId:token_key" -> decimals
  for (const r of known) decimals.set(`${r.network_id}:${r.token_key}`, Number(r.decimals));

  const byHandleChain = new Map();
  for (const r of traded) {
    const k = `${r.handle}|${r.network_id}`;
    if (!byHandleChain.has(k)) byHandleChain.set(k, []);
    byHandleChain.get(k).push({ token_key: r.token_key, address: r.address });
  }

  const capturedAt = new Date();
  const rowsOut = [];                       // [handle, network_id, token_key, address, amount]
  const learnedDecimals = new Map();
  const perChain = new Map();
  const bump = (net, field) => {
    const c = perChain.get(net) ?? { wallets: 0, positions: 0, failed: 0 };
    c[field]++; perChain.set(net, c);
  };

  let done = 0;
  for (const t of targets) {
    const label = `[${++done}/${targets.length}] ${t.handle}`;
    const found = [];

    if (t.sol_address && (!ONLY_CHAIN || ONLY_CHAIN === "solana")) {
      try {
        const bals = await solanaBalances(t.sol_address, KEY);
        if (bals) {
          bump("solana", "wallets");
          for (const b of bals) {
            // Solana base58 is case sensitive; only the KEY is lowercased, matching tokens.token_key.
            rowsOut.push([t.handle, SOLANA, b.address.toLowerCase(), b.address, b.amount]);
            bump("solana", "positions");
          }
          found.push(`solana ${bals.length}`);
        }
      } catch (e) { bump("solana", "failed"); found.push(`solana FAILED ${e.message}`); }
    }

    if (t.evm_address) {
      for (const c of chains) {
        const net = String(c.network_id);
        if (net === String(SOLANA)) continue;
        if (ONLY_CHAIN && ONLY_CHAIN !== c.name) continue;
        const tokens = byHandleChain.get(`${t.handle}|${net}`) ?? [];
        if (!tokens.length) continue;
        const view = { get: (k) => decimals.get(`${net}:${k}`), set: (k, v) => decimals.set(`${net}:${k}`, v) };
        try {
          const { balances, learned } = await evmBalances(c.rpc, t.evm_address, tokens, view);
          bump(c.name, "wallets");
          for (const [k, v] of learned) learnedDecimals.set(`${net}:${k}`, v);
          for (const b of balances) {
            rowsOut.push([t.handle, Number(net), b.address.toLowerCase(), b.address, b.amount]);
            bump(c.name, "positions");
          }
          if (balances.length) found.push(`${c.name} ${balances.length}`);
        } catch (e) { bump(c.name, "failed"); found.push(`${c.name} FAILED ${e.message}`); }
      }
    }

    console.log(`${label.padEnd(28)} ${found.join(" · ") || "nothing held"}`);
  }

  console.log(`\n${rowsOut.length} non-zero positions across ${new Set(rowsOut.map((r) => r[0])).size} traders`);
  for (const [name, c] of perChain) console.log(`  ${name.padEnd(11)} ${String(c.wallets).padStart(4)} wallets  ${String(c.positions).padStart(5)} positions  ${c.failed} failed`);
  if (DRY) { console.log("\n[DRY RUN] nothing written"); await pool.end(); return; }
  if (!rowsOut.length) { await pool.end(); return; }

  const client = await pool.connect();
  try {
    await client.query("begin");

    // FK: holdings -> tokens. A mint we have never seen is still a real position.
    await client.query(`
      insert into tokens (network_id, address)
      select * from unnest($1::bigint[], $2::text[])
      on conflict (network_id, token_key) do nothing`,
      [rowsOut.map((r) => r[1]), rowsOut.map((r) => r[3])]);

    if (learnedDecimals.size) {
      const nets = [], keys = [], decs = [];
      for (const [k, v] of learnedDecimals) { const i = k.indexOf(":"); nets.push(Number(k.slice(0, i))); keys.push(k.slice(i + 1)); decs.push(v); }
      await client.query(`
        update tokens t set decimals = u.d
        from unnest($1::bigint[], $2::text[], $3::smallint[]) as u(n, k, d)
        where t.network_id = u.n and t.token_key = u.k and t.decimals is null`, [nets, keys, decs]);
    }

    /*
     * Price from what we already hold, and leave NULL where we hold nothing. token_info is
     * GMGN's live price (the T3d loader); token_prices is the daily close. A position we
     * cannot price is still written — the portfolio route counts it in `positions`, excludes
     * it from `totalValueUsd` and reports the gap as `pricedShare`. Dropping it instead would
     * understate how many coins they hold and flatter `concentration`.
     */
    const ins = await client.query(`
      with incoming as (
        select * from unnest($1::text[], $2::bigint[], $3::text[], $4::numeric[])
                 as t(handle, network_id, token_key, human_amount)
      ),
      priced as (
        select i.*,
               coalesce(qa.pegged_usd, ti.price_usd, tp.usd) as price
        from incoming i
        -- pegged_usd FIRST and deliberately. A dollar-pegged asset is a dollar by
        -- definition, and it is the one thing cashShare actually measures -- neither
        -- token_info nor token_prices carries a row for any stablecoin, so consulting
        -- them first left every USDC balance unpriced and cashShare reading near zero
        -- for exactly the traders holding cash.
        left join quote_assets qa
               on qa.network_id = i.network_id and qa.token_key = i.token_key
        left join token_info ti
               on ti.network_id = i.network_id and ti.token_key = i.token_key and ti.price_usd is not null
        left join lateral (
          select usd from token_prices p
          where p.network_id = i.network_id and p.token_key = i.token_key
          order by day desc limit 1
        ) tp on true
      )
      insert into holdings (handle, network_id, token_key, captured_at, human_amount, price, value, source)
      select handle, network_id, token_key, $5, human_amount, price,
             case when price is null then null else human_amount * price end, 'chain'
      from priced
      on conflict (handle, network_id, token_key, captured_at) do update
        set human_amount = excluded.human_amount, price = excluded.price,
            value = excluded.value, source = excluded.source
      returning value`,
      [rowsOut.map((r) => r[0]), rowsOut.map((r) => r[1]), rowsOut.map((r) => r[2]), rowsOut.map((r) => r[4]), capturedAt]);

    await client.query("commit");
    const withValue = ins.rows.filter((r) => r.value !== null).length;
    console.log(`\nwrote ${ins.rowCount} chain rows at ${capturedAt.toISOString()} — ` +
                `${withValue} priced, ${ins.rowCount - withValue} held but unpriced`);
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }

  /*
   * Re-price anything we could not value at insert time.
   *
   * The order matters and is why this is a separate pass: a chain read discovers tokens, and
   * the T3d loader prices them AFTERWARDS. Pricing only at insert left 7,936 real positions
   * carrying `value = null` even once their price existed -- Axis 4's priced coverage sat at
   * 29.5% when the data supported 76.9%. Running it here means the pipeline is correct in one
   * pass instead of needing someone to remember a follow-up statement.
   *
   * Only rows we have NEVER valued are touched. A price already stored is a measurement, and
   * this pass does not overwrite measurements.
   */
  const { rowCount: repriced } = await pool.query(`
    update holdings h
       set price = p.px, value = h.human_amount * p.px
      from (
        select t.network_id, t.token_key,
               coalesce(qa.pegged_usd, ti.price_usd, tp.usd) as px
        from tokens t
        left join quote_assets qa on qa.network_id = t.network_id and qa.token_key = t.token_key
        left join token_info  ti on ti.network_id = t.network_id and ti.token_key = t.token_key
                                and ti.price_usd is not null
        left join lateral (select usd from token_prices x
                           where x.network_id = t.network_id and x.token_key = t.token_key
                           order by day desc limit 1) tp on true
      ) p
     where h.source = 'chain' and h.value is null and h.human_amount is not null
       and p.network_id = h.network_id and p.token_key = h.token_key and p.px is not null`);
  if (repriced) console.log(`re-priced ${repriced} previously unvalued chain rows`);

  const { rows: [after] } = await pool.query(`
    select count(distinct handle)::int as handles,
           count(*)::int as positions,
           count(value) filter (where value > 0)::int as priced
    from holdings_current`);
  console.log(`traders with holdings now: ${after.handles} · ` +
              `${after.priced}/${after.positions} positions priced`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
