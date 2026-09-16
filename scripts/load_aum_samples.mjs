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
 * THE RULE THAT MATTERS MOST. Every chain is read on its own. A chain that will not answer
 * gets its own row with a reason, and the parent row says `chains_answered < chains_expected`
 * so nothing downstream mistakes the partial total for a drawdown. Nothing asked is `null`,
 * never 0. Everywhere else in this file: a coin we cannot price is counted in
 * `totalPositions` and excluded from `totalUsd` — never valued at zero.
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
/*
 * MAX_POSITION_USD WAS $1 TRILLION, WHICH CAUGHT NOTHING.
 *
 * Measured 16 September: four readings over $1bn had been written, topping out at
 * cupseyy $473,460,243,525. The cause is not a price over the per-token ceiling -- the
 * offending tokens price at $28,159 and $8,923, which is plausible beside BTC at $79,035 and
 * sails through. It is 10.4 MILLION units of an unnamed token multiplied by that price.
 *
 * Seventeen held positions price at $1bn or more and every one is a token we cannot even
 * name. The real ones stop far below: 78 positions between $1m and $10m, 21 between $10m and
 * $100m, and the largest genuine PORTFOLIO in the directory is unipcs at $16.5m.
 *
 * $1bn therefore leaves a position sixty times larger than the biggest real portfolio and
 * still refuses every broken one. A number that large is not a rich trader, it is a broken
 * price, and it must never reach a chart.
 */
const MAX_POSITION_USD    = 1_000_000_000;

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
 * Read ONE chain for one trader. Never throws: a chain that will not answer is a reason on
 * its own row, and the other chains still count (Z2, R5). Twin of readChain() in
 * supabase/functions/aum-sample/index.ts.
 */
async function readChain(t, c, decimals, tradedByNet) {
  const net = Number(c.network_id);
  const pos = (b) => ({ network_id: net, token_key: b.address.toLowerCase(), address: b.address, amount: Number(b.amount) });
  try {
    if (net === SOLANA_NETWORK_ID) {
      const bals = await solanaBalances(t.sol_address, KEY);
      if (bals === null) return { positions: null, reason: "service_timeout" };
      return { positions: bals.map(pos), reason: null };
    }
    const tokens = tradedByNet.get(`${t.handle}|${net}`) ?? [];
    // Nothing to ask for is unread, not empty (Z1). Lift once evmBalances reads the native balance.
    if (!tokens.length) return { positions: null, reason: "no_tokens_known" };
    const view = { get: (k) => decimals.get(`${net}:${k}`), set: (k, v) => decimals.set(`${net}:${k}`, v) };
    const res = await evmBalances(c.rpc, t.evm_address, tokens, view);
    return { positions: res.balances.map(pos), reason: null };
  } catch (e) {
    console.error(`  ${t.handle} ${c.name}: ${e.message}`);
    return { positions: null, reason: "wallet_unreadable" };
  }
}

const hasWallet = (t, net) => (net === SOLANA_NETWORK_ID ? t.sol_address !== null : t.evm_address !== null);

/** Twin of decideTotal() in supabase/functions/aum-sample/value.ts. */
function decideTotal(answered, priced, sum, total, failures) {
  if (answered === 0) {
    const distinct = new Set(failures);
    return { totalUsd: null, reason: distinct.size === 1 ? [...distinct][0] : "wallet_unreadable" };
  }
  if (priced > 0) return { totalUsd: sum, reason: null };
  if (total === 0) return { totalUsd: 0, reason: null };
  return { totalUsd: null, reason: "no_prices" };
}

/** Price what the chains answered and decide the parent total. */
async function settle(client, reads) {
  const perChain = new Map();
  for (const [net, r] of reads) if (r.positions) perChain.set(net, { usd: 0, priced: 0, total: 0 });
  const positions = [...reads.values()].flatMap((r) => r.positions ?? []);
  const px = await pricesFor(client, positions);
  let sum = 0, priced = 0, rejected = 0;
  for (const p of positions) {
    const c = perChain.get(p.network_id);
    c.total++;
    const v = value(p.amount, px.get(`${p.network_id}:${p.token_key}`) ?? null);
    if (v.rejected) rejected++;
    else if (v.usd !== undefined) { sum += v.usd; priced++; c.usd += v.usd; c.priced++; }
  }
  const failures = [...reads.values()].flatMap((r) => (r.reason ? [r.reason] : []));
  const { totalUsd, reason } = decideTotal(perChain.size, priced, sum, positions.length, failures);
  return { totalUsd, reason, priced, total: positions.length, rejected, perChain };
}

/** The parent row and one row per chain asked, answered or not. */
async function write(client, handle, at, expected, reads, s) {
  const answered = s.perChain.size;
  const valueShare = s.total > 0 ? Number((s.priced / s.total).toFixed(4)) : null;
  await client.query(`
    insert into aum_samples
      (handle, at, total_usd, refused_reason, priced_positions, total_positions,
       value_share, basis, tier, chains_answered, chains_expected)
    values ($1, $2, $3, $4, $5, $6, $7, 'sampled', 'verified', $8, $9)
    on conflict (handle, at, basis) do update set
      total_usd = excluded.total_usd, refused_reason = excluded.refused_reason,
      priced_positions = excluded.priced_positions, total_positions = excluded.total_positions,
      value_share = excluded.value_share, chains_answered = excluded.chains_answered,
      chains_expected = excluded.chains_expected, sampled_at = now()`,
    [handle, at, s.totalUsd, s.totalUsd === null ? s.reason : null,
     answered === 0 ? null : s.priced, answered === 0 ? null : s.total, valueShare, answered, expected]);

  if (!reads.size) return;
  const nets = [...reads.keys()];
  const tally = (net) => s.perChain.get(net) ?? null;
  await client.query(`
    insert into aum_chain_samples (handle, at, basis, network_id, total_usd, priced_share, reason)
    select $1, $2, 'sampled', u.n, u.v, u.s, u.r
    from unnest($3::bigint[], $4::numeric[], $5::numeric[], $6::text[]) as u(n, v, s, r)
    on conflict (handle, at, basis, network_id) do update set
      total_usd = excluded.total_usd, priced_share = excluded.priced_share,
      reason = excluded.reason`,
    [handle, at, nets,
     // Not asked: null. Held nothing: a true zero. Priced something: the sum.
     nets.map((n) => { const c = tally(n); return !c ? null : c.total === 0 ? 0 : c.priced > 0 ? c.usd : null; }),
     nets.map((n) => { const c = tally(n); return !c || c.total === 0 ? null : Number((c.priced / c.total).toFixed(4)); }),
     nets.map((n) => { const c = tally(n); return !c ? reads.get(n).reason : c.total === 0 ? null : c.priced > 0 ? null : "no_prices"; })]);
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
    /*
     * Token decimals, fetched once and shared by every trader. An ERC-20 balance is
     * meaningless without them and they never change, so re-reading them per trader was
     * pure waste -- see readChain.
     */
    const { rows: known } = await client.query(
      `select network_id::bigint, token_key, decimals from tokens where decimals is not null`);
    const decimals = new Map(known.map((r) => [`${r.network_id}:${r.token_key}`, Number(r.decimals)]));
    console.log(`decimals cached for ${decimals.size} tokens (once, not per trader)`);

    const handles = targets.map((t) => t.handle);
    // Traded-token lists per (handle, chain), once for the run rather than once per trader.
    const { rows: traded } = await client.query(`
      select handle, network_id::bigint, token_key, min(token_address) as address
      from trades where handle = any($1) and network_id <> $2 and token_address is not null
      group by 1, 2, 3`, [handles, SOLANA_NETWORK_ID]);
    const tradedByNet = new Map();
    for (const r of traded) {
      const k = `${r.handle}|${r.network_id}`;
      if (!tradedByNet.has(k)) tradedByNet.set(k, []);
      tradedByNet.get(k).push({ token_key: r.token_key, address: r.address });
    }
    // EXPECTED CHAINS ARE THE ONES /aum PUBLISHES: presence ∪ holdings ∪ chain samples.
    // Twin of the `seen` CTE in api/shared/chains.ts knownChainsFor(); change both.
    const { rows: seen } = await client.query(`
      select s.handle, s.network_id::bigint
      from (select handle, network_id from wallet_chain_presence where handle = any($1)
            union select handle, network_id from holdings_current where handle = any($1) and human_amount > 0
            union select handle, network_id from aum_chain_samples where handle = any($1) and total_usd is not null) s
      join chains using (network_id)`, [handles]);
    const knownByHandle = new Map();
    for (const r of seen) {
      if (!knownByHandle.has(r.handle)) knownByHandle.set(r.handle, new Set());
      knownByHandle.get(r.handle).add(Number(r.network_id));
    }
    const chainById = new Map(chains.map((c) => [Number(c.network_id), c]));

    const at = new Date();
    at.setUTCMinutes(0, 0, 0);
    console.log(`sampling ${targets.length} trader(s) for ${at.toISOString()}${DRY ? "  [DRY RUN]" : ""}`);

    /** The last verdict per trader; a retry replaces the first one. */
    const verdict = new Map();
    const retry = [];
    const finish = async (job, label) => {
      const s = await settle(client, job.reads);
      verdict.set(job.trader.handle, s.totalUsd);
      const failed = [...job.reads].filter(([, r]) => r.reason)
        .map(([net, r]) => `${chainById.get(net).name}=${r.reason}`).join(" ");
      const cover = `${s.perChain.size}/${job.expected.size} chains${failed ? `  ${failed}` : ""}`;
      console.log(s.totalUsd === null
        ? `${label} refused — ${s.reason}  ${cover}`
        : `${label} $${Math.round(s.totalUsd).toLocaleString().padStart(14)}  ${s.priced}/${s.total} priced  ${cover}` +
          (s.rejected ? `  ${s.rejected} price_rejected` : ""));
      if (!DRY) await write(client, job.trader.handle, at, job.expected.size, job.reads, s);
    };

    for (const [i, t] of targets.entries()) {
      const trader = { handle: t.handle, sol_address: t.sol_address ?? null, evm_address: t.evm_address ?? null };
      // Solana lists everything held, so it is always asked when he has that wallet.
      const expected = new Set(knownByHandle.get(trader.handle) ?? []);
      if (trader.sol_address) expected.add(SOLANA_NETWORK_ID);

      const reads = new Map();
      for (const net of expected) {
        const c = chainById.get(net);
        // Known without the wallet that reaches it: expected, not askable; the row says partial.
        if (!c || !hasWallet(trader, net)) continue;
        reads.set(net, await readChain(trader, c, decimals, tradedByNet));
      }
      const job = { trader, expected, reads };
      await finish(job, `[${String(i + 1).padStart(4)}/${targets.length}] ${t.handle.padEnd(22)}`);
      if ([...reads.values()].some((r) => r.reason === "wallet_unreadable")) retry.push(job);
      await sleep(120);
    }

    // ONE MORE ASK for every chain that would not answer, after the other traders gave the RPC a rest.
    for (const job of retry) {
      let flipped = false;
      for (const [net, r] of job.reads) {
        if (r.reason !== "wallet_unreadable") continue;
        const again = await readChain(job.trader, chainById.get(net), decimals, tradedByNet);
        if (again.positions) { job.reads.set(net, again); flipped = true; }
      }
      if (flipped) await finish(job, `[retry     ] ${job.trader.handle.padEnd(22)}`);
    }
    const ok = [...verdict.values()].filter((v) => v !== null).length;
    const refused = verdict.size - ok;

    console.log(`\n${ok} sampled · ${refused} refused`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
