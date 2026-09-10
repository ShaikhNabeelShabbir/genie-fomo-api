#!/usr/bin/env node
/**
 * AUM over time (AUM_PLAN.md phase 2) — sample every trader's whole balance, hourly.
 *
 * WHY SAMPLING AND NOT RECONSTRUCTION. The swap stream is roughly 86% buys to 14% sells, so
 * a balance rolled backwards from it drifts upward and never sees an exit; and a coin already
 * sold never appears in a holdings list at all, so a past moment cannot be priced from
 * present positions. Our own resolver measured the same shape — 696 genuine two-sided swaps
 * in 132,128 SWAP-tagged Solana transactions. Nobody records the balance when it happens.
 * This does.
 *
 * WHAT IT WRITES. One `aum_samples` row per trader per hour, plus one `aum_chain_samples`
 * row per chain. Aggregates only: the per-coin breakdown stays on /positions, and storing it
 * hourly would be ~262M rows a year.
 *
 * THE RULE THAT MATTERS MOST. If any wallet will not answer, the WHOLE trader-hour is
 * refused with a reason rather than totalled from the wallets that did. A partial total reads
 * low, looks exactly like a real drawdown, and nothing downstream can tell the two apart.
 * Everywhere else in this file: a coin we cannot price is counted in `totalPositions` and
 * excluded from `totalUsd` — never valued at zero.
 *
 *   node scripts/load_aum_samples.mjs --limit 5 --dry-run
 *   node scripts/load_aum_samples.mjs --handle frankdegods
 *   node scripts/load_aum_samples.mjs                       # the whole board
 */
import pg from "pg";
import { SOLANA_NETWORK_ID, solanaBalances, evmBalances } from "./lib/chain_reads.mjs";

const DB  = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
const KEY = (process.env.HELIUS_SOLANA_KEY ?? "").trim();
if (!DB) { console.error("DATABASE_URL is not set"); process.exit(1); }

const arg  = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const ONLY_HANDLE = arg("handle");
const LIMIT = Number(arg("limit", "0")) || null;
const DRY = flag("dry-run");

/*
 * A hard cap, deliberately small. An hourly job that runs beside the live API shares the
 * transaction-mode pooler with it, and refresh.yml already records what happens when that is
 * exhausted: the loaders took the API to 503 mid-run. We reproduced it on 2026-09-09.
 */
const pool = new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 3 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Price ceilings, applied BEFORE any multiplication.
 *
 * Not theoretical: one Orca pool quoted STONK at $3,110 against 29 pools at $0.187, and a
 * deepest-pool rule turned that into a $26.7 BILLION portfolio for one trader. A number that
 * large is not a rich trader, it is a broken pool, and it must never reach a chart.
 *
 * The PRD also asks to refuse a price more than 50x off the median of the coin's other pools.
 * That needs PER-POOL prices; every source we hold returns one price per token, so there is
 * nothing to take a median of. The two absolute ceilings below are what is buildable today —
 * see AUM_PLAN.md §4.2.
 */
const MAX_PRICE_PER_TOKEN = 1_000_000;
const MAX_POSITION_USD    = 1_000_000_000_000;

/**
 * Value one position, or refuse it.
 *
 * Returns `{ usd }` when it can be valued, `{ rejected: true }` when a price exists but is
 * not believable, and `{}` when we simply have no price. The three are different states and
 * the caller reports them differently — an unpriced coin is a coverage gap, a rejected one
 * is a finding.
 */
function value(amount, price) {
  if (price === null || !Number.isFinite(price) || price <= 0) return {};
  if (price > MAX_PRICE_PER_TOKEN) return { rejected: true };
  const usd = amount * price;
  if (!Number.isFinite(usd) || usd > MAX_POSITION_USD) return { rejected: true };
  return { usd };
}

/**
 * Prices for a set of (network, token) pairs, from what this service already holds.
 *
 * Order is deliberate and matches the holdings loader, so an AUM point and a /portfolio total
 * cannot disagree on which price they used:
 *   quote_assets.pegged_usd   a dollar coin is a dollar, by definition
 *   token_info.price_usd      GMGN's live price, refreshed by the T3d loader
 *   token_prices              the most recent daily close
 *
 * NOTE (AUM_PLAN.md §4.1): this is enough to price what we have already crawled, but it is
 * NOT enough to price ~30,000 positions every hour — GMGN runs at 1 request/second. Hourly
 * cadence needs a batch price source, which is an open decision. Until then this samples
 * correctly at whatever cadence it is actually run.
 */
async function pricesFor(client, pairs) {
  if (!pairs.length) return new Map();
  const nets = pairs.map((p) => p.network_id);
  const keys = pairs.map((p) => p.token_key);
  const { rows } = await client.query(`
    select u.n as network_id, u.k as token_key,
           coalesce(qa.pegged_usd, ti.price_usd, tp.usd)::float8 as px
    from unnest($1::bigint[], $2::text[]) as u(n, k)
    left join quote_assets qa on qa.network_id = u.n and qa.token_key = u.k
    left join token_info  ti on ti.network_id = u.n and ti.token_key = u.k and ti.price_usd is not null
    left join lateral (
      select usd from token_prices p
      where p.network_id = u.n and p.token_key = u.k order by day desc limit 1
    ) tp on true`, [nets, keys]);
  const m = new Map();
  for (const r of rows) if (r.px !== null) m.set(`${r.network_id}:${r.token_key}`, Number(r.px));
  return m;
}

/**
 * Read every wallet this trader has, on every chain, from the chain itself.
 *
 * Throws on the first unreadable wallet. That is the point: the caller turns the throw into
 * a refusal for the whole trader-hour rather than a total missing one wallet's worth.
 */
async function readBalances(client, t, chains) {
  const out = [];   // { network_id, token_key, address, amount }

  if (t.sol_address) {
    let bals;
    try { bals = await solanaBalances(t.sol_address, KEY); }
    catch (e) { throw Object.assign(new Error(`solana: ${e.message}`), { reason: "wallet_unreadable" }); }
    if (bals === null) throw Object.assign(new Error("no helius key"), { reason: "service_timeout" });
    for (const b of bals) {
      out.push({ network_id: SOLANA_NETWORK_ID, token_key: b.address.toLowerCase(),
                 address: b.address, amount: Number(b.amount) });
    }
  }

  if (t.evm_address) {
    // Scoped to tokens this trader has actually traded: an EVM chain has no cheap "list
    // everything held" primitive without a paid indexer, and a token they never touched is
    // one we could neither price nor name.
    const { rows: traded } = await client.query(`
      select network_id::bigint, token_key, min(token_address) as address
      from trades where handle = $1 and network_id <> $2 group by 1, 2`,
      [t.handle, SOLANA_NETWORK_ID]);
    const byNet = new Map();
    for (const r of traded) {
      const k = String(r.network_id);
      if (!byNet.has(k)) byNet.set(k, []);
      byNet.get(k).push({ token_key: r.token_key, address: r.address });
    }
    const { rows: known } = await client.query(
      `select network_id::bigint, token_key, decimals from tokens where decimals is not null`);
    const dec = new Map(known.map((r) => [`${r.network_id}:${r.token_key}`, Number(r.decimals)]));

    for (const c of chains) {
      const net = String(c.network_id);
      if (net === String(SOLANA_NETWORK_ID)) continue;
      const tokens = byNet.get(net) ?? [];
      if (!tokens.length) continue;
      const view = { get: (k) => dec.get(`${net}:${k}`), set: (k, v) => dec.set(`${net}:${k}`, v) };
      let res;
      try { res = await evmBalances(c.rpc, t.evm_address, tokens, view); }
      catch (e) { throw Object.assign(new Error(`${c.name}: ${e.message}`), { reason: "wallet_unreadable" }); }
      for (const b of res.balances) {
        out.push({ network_id: Number(net), token_key: b.address.toLowerCase(),
                   address: b.address, amount: Number(b.amount) });
      }
    }
  }
  return out;
}

async function main() {
  const client = await pool.connect();
  try {
    const { rows: chains } = await client.query(
      `select network_id::bigint, name, rpc from chains order by network_id`);
    const { rows: targets } = await client.query(`
      select t.handle, w.sol_address, w.evm_address
      from traders t join wallets w on w.handle = t.handle
      where ($1::text is null or t.handle = $1)
      order by t.handle ${LIMIT ? `limit ${LIMIT}` : ""}`, [ONLY_HANDLE]);

    // The hour this sample describes. Truncated so a run at :07 and one at :52 do not
    // produce two points for the same hour that a chart would draw as a spike.
    const at = new Date();
    at.setUTCMinutes(0, 0, 0);
    console.log(`sampling ${targets.length} trader(s) for ${at.toISOString()}${DRY ? "  [DRY RUN]" : ""}`);

    let ok = 0, refused = 0;
    for (const [i, t] of targets.entries()) {
      let positions, reason = null;
      try {
        positions = await readBalances(client, t, chains);
      } catch (e) {
        reason = e.reason ?? "wallet_unreadable";
        positions = null;
      }

      let totalUsd = null, priced = 0, total = 0, rejected = 0;
      const perChain = new Map();

      if (positions !== null) {
        total = positions.length;
        const px = await pricesFor(client, positions);
        let sum = 0;
        for (const p of positions) {
          const c = perChain.get(p.network_id) ?? { usd: 0, priced: 0, total: 0 };
          c.total++;
          const v = value(p.amount, px.get(`${p.network_id}:${p.token_key}`) ?? null);
          if (v.rejected) rejected++;
          else if (v.usd !== undefined) { sum += v.usd; priced++; c.usd += v.usd; c.priced++; }
          perChain.set(p.network_id, c);
        }
        if (priced > 0) {
          totalUsd = sum;
        } else if (total === 0) {
          /*
           * Every wallet answered and held nothing. This is the one place a zero is the
           * TRUE value rather than a stand-in for a missing one, and reporting null here
           * would hide a real empty wallet behind "we could not tell".
           *
           * It is only reachable because the reads SUCCEEDED — an unreadable wallet threw
           * long before this and is refused above.
           */
          totalUsd = 0;
        } else {
          // He holds things and we could price none of them. That is a coverage failure,
          // not a balance of zero, and it must not be drawn as one.
          reason = "no_prices";
        }
      }

      /*
       * valueShare = priced / total positions.
       *
       * The PRD describes it as "the share of totalUsd the priced positions represent",
       * which reads circular — totalUsd IS the priced positions. Its own worked example
       * settles the intent: pricedPositions 41, totalPositions 72, valueShare 0.57, and
       * 41/72 = 0.569. It is the share of his positions we could value, which is what makes
       * a thin line legible as thin.
       */
      const valueShare = total > 0 ? Number((priced / total).toFixed(4)) : null;
      const line = `[${String(i + 1).padStart(4)}/${targets.length}] ${t.handle.padEnd(22)}`;
      if (totalUsd === null) {
        refused++;
        console.log(`${line} refused — ${reason}`);
      } else {
        ok++;
        console.log(`${line} $${Math.round(totalUsd).toLocaleString().padStart(14)}  ${priced}/${total} priced` +
                    (rejected ? `  ${rejected} price_rejected` : ""));
      }

      if (DRY) continue;

      await client.query(`
        insert into aum_samples
          (handle, at, total_usd, refused_reason, priced_positions, total_positions,
           value_share, basis, tier)
        values ($1, $2, $3, $4, $5, $6, $7, 'sampled', 'verified')
        on conflict (handle, at, basis) do update set
          total_usd = excluded.total_usd, refused_reason = excluded.refused_reason,
          priced_positions = excluded.priced_positions, total_positions = excluded.total_positions,
          value_share = excluded.value_share, sampled_at = now()`,
        [t.handle, at, totalUsd, totalUsd === null ? (reason ?? "wallet_unreadable") : null,
         positions === null ? null : priced, positions === null ? null : total, valueShare]);

      if (perChain.size) {
        const nets = [...perChain.keys()];
        await client.query(`
          insert into aum_chain_samples (handle, at, basis, network_id, total_usd, priced_share, reason)
          select $1, $2, 'sampled', u.n, u.v, u.s, u.r
          from unnest($3::bigint[], $4::numeric[], $5::numeric[], $6::text[]) as u(n, v, s, r)
          on conflict (handle, at, basis, network_id) do update set
            total_usd = excluded.total_usd, priced_share = excluded.priced_share,
            reason = excluded.reason`,
          [t.handle, at, nets,
           nets.map((n) => (perChain.get(n).priced > 0 ? perChain.get(n).usd : null)),
           nets.map((n) => Number((perChain.get(n).priced / perChain.get(n).total).toFixed(4))),
           nets.map((n) => (perChain.get(n).priced > 0 ? null : "no_prices"))]);
      }
      await sleep(120);
    }

    console.log(`\n${ok} sampled · ${refused} refused`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
