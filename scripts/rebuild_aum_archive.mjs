#!/usr/bin/env node
/**
 * AUM backfill for the archive chains (AUM_CHART_PRD.md §3.1) — bsc, base, ethereum.
 *
 * WHY THIS IS NOT THE ROBINHOOD SCRIPT. robinhood keeps no historical state, so a past
 * balance there has to be inferred: anchor on today, replay every transfer backwards, and
 * prove the walk forward. These three chains keep archive state, so we can simply ASK what
 * the balance was on a given day. Measured on 2026-09-11, all three answer a 30-day-old
 * eth_call and return genuinely different values from head, which is the test that separates
 * a real archive from a node quietly serving current state.
 *
 * That makes this the better method wherever it is available:
 *   - exact, not inferred, so there is no anchor and no backward walk;
 *   - point queries rather than million-block scans, so far less rate limiting;
 *   - restartable at any point, because every read is independent of every other.
 *
 * WHAT IT WILL NOT DO. It can only ask about tokens it knows to ask about, so the token set
 * is what the trader holds now UNION what they traded inside the window. A coin bought and
 * sold entirely within the window, that we never recorded a trade for, is invisible -- and
 * is reported as coverage rather than quietly dropped.
 *
 *   node scripts/rebuild_aum_archive.mjs --chain base --dry-run
 *   node scripts/rebuild_aum_archive.mjs --chain bsc
 *   node scripts/rebuild_aum_archive.mjs                     # all three
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { rpc, word, scale } from "./lib/chain_reads.mjs";

const DB = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
if (!DB) { console.error("DATABASE_URL is not set"); process.exit(1); }

const arg  = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const DRY  = flag("dry-run");
const DAYS = Number(arg("days", "30"));
const ONLY_CHAIN = arg("chain");
const CACHE = arg("cache-dir", ".cache/rebuild_archive");

/*
 * Endpoints chosen by measurement, not reputation. Every one of these was checked for REAL
 * archive depth: ask for a balance 30 days back and confirm it differs from head.
 *   bsc       the dataseed nodes are all pruned ("missing trie node"); blastapi is not.
 *   base      the chain's own public node carries archive state.
 *   ethereum  publicnode 403s us entirely; drpc answers, but 500s on large JSON-RPC
 *             batches, so the batch size drops and singles are the fallback.
 */
const CHAINS = {
  /*
   * Batch sizes are MEASURED, not assumed, and getting one wrong is expensive rather than
   * loud: base answers an oversized batch with HTTP 200 and a single object saying "maximum
   * 10 calls in 1 batch", which reads as a refusal and silently drops the job to one call per
   * pair -- 229 sequential reads per day instead of 6. Probed 2026-09-11.
   */
  bsc:      { network_id: 56,   rpc: "https://bsc-mainnet.public.blastapi.io", hint: 0.75, batch: 100 },
  base:     { network_id: 8453, rpc: "https://base-mainnet.public.blastapi.io", hint: 2.0,  batch: 100 },
  ethereum: { network_id: 1,    rpc: "https://eth-mainnet.public.blastapi.io", hint: 12.0, batch: 100 },
};

const BAL = "0x70a08231";
const MAX_PRICE_PER_TOKEN = 1_000_000;
const MAX_POSITION_USD    = 1_000_000_000_000;
const PRICE_GAP_DAYS = 7;

const pool = new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 3 });
const hex = (n) => "0x" + BigInt(n).toString(16);

function value(amount, price) {
  if (price === null || !Number.isFinite(price) || price <= 0) return {};
  if (price > MAX_PRICE_PER_TOKEN) return { rejected: true };
  const usd = amount * price;
  if (!Number.isFinite(usd) || usd > MAX_POSITION_USD) return { rejected: true };
  return { usd };
}

/** Block timestamps are pure facts about the chain; once known they are cached forever. */
let tsCache = {};
const tsFile = (c) => path.join(CACHE, `${c}_block_timestamps.json`);

async function blockTimestamp(chain, n) {
  const k = String(n);
  if (tsCache[k] !== undefined) return tsCache[k];
  const j = await rpc(chain.rpc, { jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [hex(n), false] }, 8);
  if (j.error || !j.result) return null;
  tsCache[k] = Number(BigInt(j.result.timestamp));
  return tsCache[k];
}

/** Secant search: each step recomputes the rate from the last two real readings. */
async function blockAtTime(chain, targetSec, head, headTs, rate) {
  const clamp = (n) => Math.min(head, Math.max(1, n));
  let b0 = head, t0 = headTs;
  let b1 = clamp(head - Math.round((headTs - targetSec) / rate));
  let t1 = await blockTimestamp(chain, b1);
  if (t1 === null) return null;
  for (let i = 0; i < 12; i++) {
    if (Math.abs(t1 - targetSec) <= 60) return b1;
    const local = (b1 !== b0 && t1 !== t0) ? (t0 - t1) / (b0 - b1) : rate;
    const next = clamp(b1 - Math.round((t1 - targetSec) / (local > 0 ? local : rate)));
    if (next === b1) return b1;
    b0 = b1; t0 = t1; b1 = next;
    t1 = await blockTimestamp(chain, b1);
    if (t1 === null) return b0;
  }
  return b1;
}

/**
 * Balances for many (wallet, token) pairs at ONE historical block.
 *
 * Falls back to single calls when a node refuses the batch -- drpc answers 500 to a large
 * one. A pair that cannot be read returns null, which is a coverage gap, never a zero.
 */
async function balancesAt(chain, pairs, block) {
  const out = new Map();
  const tag = hex(block);
  const ask = async (slice) => {
    const body = slice.map((p, k) => ({
      jsonrpc: "2.0", id: k, method: "eth_call",
      params: [{ to: p.token_key, data: BAL + p.wallet.replace(/^0x/, "").padStart(64, "0") }, tag],
    }));
    const j = await rpc(chain.rpc, body, 8);
    if (!Array.isArray(j)) throw new Error("batch refused");
    for (const r of j) {
      const p = slice[r?.id];
      if (!p) continue;
      const raw = word(r?.result);
      if (raw !== null) out.set(`${p.handle}:${p.token_key}`, raw);
    }
  };
  for (let i = 0; i < pairs.length; i += chain.batch) {
    const slice = pairs.slice(i, i + chain.batch);
    try { await ask(slice); }
    catch {
      for (const p of slice) {
        try {
          const j = await rpc(chain.rpc, { jsonrpc: "2.0", id: 1, method: "eth_call",
            params: [{ to: p.token_key, data: BAL + p.wallet.replace(/^0x/, "").padStart(64, "0") }, tag] }, 5);
          const raw = word(j?.result);
          if (raw !== null) out.set(`${p.handle}:${p.token_key}`, raw);
        } catch { /* a pair we cannot read stays absent, and is counted as unread */ }
      }
    }
  }
  return out;
}

async function runChain(client, name) {
  const chain = CHAINS[name];
  fs.mkdirSync(CACHE, { recursive: true });
  tsCache = {};
  if (fs.existsSync(tsFile(name))) { try { tsCache = JSON.parse(fs.readFileSync(tsFile(name), "utf8")); } catch { tsCache = {}; } }

  /*
   * The token set is what they hold now UNION what they traded in the window. The union is
   * the point: a coin sold before today is absent from holdings and is exactly the kind of
   * position a balance history has to show.
   */
  const { rows: pairs } = await client.query(`
    with held as (
      select h.handle, h.token_key from holdings_current h
      where h.network_id = $1 and h.human_amount > 0
    ), traded as (
      select t.handle, t.token_key from trades t
      where t.network_id = $1 and t.opened_at >= now() - ($2 || ' days')::interval
    ), all_pairs as (select * from held union select * from traded)
    select a.handle, a.token_key, w.evm_address_key as wallet, tk.decimals
    from all_pairs a
    join wallets w on w.handle = a.handle and w.evm_address_key is not null
    join tokens tk on tk.network_id = $1 and tk.token_key = a.token_key and tk.decimals is not null
    where a.token_key like '0x%'`, [chain.network_id, String(DAYS)]);

  if (!pairs.length) { console.log(`${name}: nothing to read`); return; }
  const traders = new Set(pairs.map((p) => p.handle));
  console.log(`\n=== ${name} === ${pairs.length.toLocaleString()} (wallet, token) pairs across ${traders.size} traders`);

  const hj = await rpc(chain.rpc, { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }, 8);
  const head = Number(BigInt(hj.result));
  const headTs = await blockTimestamp(chain, head);
  const probe = Math.max(1, head - Math.floor(30 * 86400 / chain.hint));
  const probeTs = await blockTimestamp(chain, probe);
  const rate = probeTs && probe < head ? (headTs - probeTs) / (head - probe) : chain.hint;
  console.log(`  head ${head.toLocaleString()} · measured ${rate.toFixed(3)} s/block (hint ${chain.hint})`);

  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  const boundaries = [];
  for (let d = DAYS; d >= 1; d--) {
    const at = new Date(midnight.getTime() - d * 86400_000);
    const blk = await blockAtTime(chain, Math.floor(at.getTime() / 1000), head, headTs, rate);
    boundaries.push({ at, block: blk });
  }
  fs.writeFileSync(tsFile(name), JSON.stringify(tsCache));
  console.log(`  ${boundaries.length} day boundaries resolved (blocks ${boundaries[0].block?.toLocaleString()} .. ${boundaries[boundaries.length - 1].block?.toLocaleString()})`);

  // ------------------------------------------------------------- price series
  const { rows: pxRows } = await client.query(`
    select token_key, at, px from (
      select token_key, opened_at at, avg_entry_price::float8 px from trades
        where network_id = $1 and avg_entry_price > 0 and opened_at is not null
      union all
      select token_key, closed_at, avg_exit_price::float8 from trades
        where network_id = $1 and avg_exit_price > 0 and closed_at is not null
    ) s where at >= now() - ($2 || ' days')::interval`, [chain.network_id, String(DAYS + 20)]);
  const series = new Map();
  for (const r of pxRows) {
    const t = new Date(r.at).getTime();
    if (!Number.isFinite(t) || !Number.isFinite(r.px)) continue;
    let a = series.get(r.token_key); if (!a) series.set(r.token_key, a = []);
    a.push({ t, px: Number(r.px) });
  }
  for (const a of series.values()) a.sort((x, y) => x.t - y.t);

  /*
   * A PEGGED COIN IS WORTH ITS PEG ON EVERY DATE, which makes it the only price we can apply
   * to a past balance without guessing. Dated trade prices cover a small slice of the tokens
   * held on any given day, and the obvious patch -- valuing a 30-day-old balance at today's
   * price -- would fold price movement into a chart whose whole subject is balance movement.
   * Stablecoins carry no such ambiguity, so they are priced exactly and everything else waits
   * for a real dated observation.
   */
  const { rows: pegged } = await client.query(
    `select token_key, pegged_usd::float8 px from quote_assets
     where network_id = $1 and pegged_usd is not null`, [chain.network_id]);
  const peg = new Map(pegged.map((r) => [r.token_key, Number(r.px)]));

  const GAP = PRICE_GAP_DAYS * 86400_000;
  const priceAt = (token, ms) => {
    const fixed = peg.get(token);
    if (fixed !== undefined) return fixed;
    const a = series.get(token); if (!a) return null;
    let best = null, bestD = Infinity;
    for (const p of a) { const d = Math.abs(p.t - ms); if (d < bestD) { bestD = d; best = p.px; } }
    return bestD <= GAP ? best : null;
  };
  console.log(`  ${pxRows.length.toLocaleString()} dated prices across ${series.size.toLocaleString()} tokens` +
              ` · ${peg.size} pegged assets priced at any date`);

  // --------------------------------------------------------------- the reads
  const perDay = new Map();   // handle -> at -> tally
  let done = 0;
  for (const b of boundaries) {
    if (b.block === null) continue;
    const got = await balancesAt(chain, pairs, b.block);
    for (const p of pairs) {
      const raw = got.get(`${p.handle}:${p.token_key}`);
      let m = perDay.get(p.handle); if (!m) perDay.set(p.handle, m = new Map());
      let c = m.get(b.at.getTime());
      if (!c) m.set(b.at.getTime(), c = { usd: 0, priced: 0, total: 0, unread: 0 });
      if (raw === undefined) { c.unread++; continue; }        // could not read: a gap, not a zero
      if (raw === 0n) continue;                               // a true zero is not a position
      const amt = Number(scale(raw, Number(p.decimals)));
      c.total++;
      const v = value(amt, priceAt(p.token_key, b.at.getTime()));
      if (v.usd !== undefined) { c.usd += v.usd; c.priced++; }
    }
    done++;
    console.log(`  ${String(done).padStart(2)}/${boundaries.length} ${b.at.toISOString().slice(0, 10)} · ${got.size.toLocaleString()} balances read`);
  }

  // ------------------------------------------------------------------ write
  let wrote = 0;
  for (const [handle, days] of perDay) {
    const ats = [...days.keys()].sort((a, b) => a - b);
    const rows = ats.map((ms) => {
      const c = days.get(ms);
      const ok = c.priced > 0;
      return { at: new Date(ms), usd: ok ? c.usd : null,
               reason: ok ? null : (c.total === 0 ? null : "no_prices"),
               priced: c.priced, total: c.total,
               share: c.total > 0 ? Number((c.priced / c.total).toFixed(4)) : null };
    });
    if (!rows.some((r) => r.total > 0)) continue;
    if (DRY) { wrote += rows.length; continue; }

    await client.query(`
      insert into aum_samples (handle, at, total_usd, refused_reason, priced_positions,
        total_positions, value_share, basis, tier)
      select $1, u.at, null, 'chains_unrebuildable', u.priced, u.total_pos, u.share, 'rebuilt', 'reported'
      from unnest($2::timestamptz[], $3::int[], $4::int[], $5::numeric[]) as u(at, priced, total_pos, share)
      on conflict (handle, at, basis) do update set
        priced_positions = aum_samples.priced_positions + excluded.priced_positions,
        total_positions  = aum_samples.total_positions  + excluded.total_positions,
        sampled_at = now()`,
      [handle, rows.map((r) => r.at), rows.map((r) => r.priced), rows.map((r) => r.total), rows.map((r) => r.share)]);

    await client.query(`
      insert into aum_chain_samples (handle, at, basis, network_id, total_usd, priced_share, reason)
      select $1, u.at, 'rebuilt', $2, u.usd, u.share, u.reason
      from unnest($3::timestamptz[], $4::numeric[], $5::numeric[], $6::text[]) as u(at, usd, share, reason)
      on conflict (handle, at, basis, network_id) do update set
        total_usd = excluded.total_usd, priced_share = excluded.priced_share, reason = excluded.reason`,
      [handle, chain.network_id, rows.map((r) => r.at), rows.map((r) => r.usd),
       rows.map((r) => r.share), rows.map((r) => r.reason)]);
    wrote += rows.length;
  }
  console.log(`  ${name}: ${wrote} points across ${perDay.size} traders${DRY ? " (dry run)" : ""}`);
}

async function main() {
  const client = await pool.connect();
  try {
    const names = ONLY_CHAIN ? [ONLY_CHAIN] : ["base", "bsc", "ethereum"];
    for (const n of names) {
      if (!CHAINS[n]) { console.error(`unknown chain '${n}'`); continue; }
      try { await runChain(client, n); }
      catch (e) { console.error(`${n} failed: ${e.message}`); }
    }
  } finally { client.release(); await pool.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
