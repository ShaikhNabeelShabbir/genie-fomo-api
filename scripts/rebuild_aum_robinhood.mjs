#!/usr/bin/env node
/**
 * AUM backfill (AUM_PLAN.md phase 3) — reconstruct 30 days of robinhood balances.
 *
 * WHY THIS CHAIN AND NO OTHER. A rebuild needs the chain to answer for a 30-day span. We
 * measured all five before writing a line of this:
 *
 *   robinhood  eth_getLogs takes 1,000,000-block windows and address topic arrays, so the
 *              whole 30 days is ~28 requests.                                    REBUILT
 *   solana     no historical-balance method exists, and our stored transfers reach a full
 *              30 days back for only 17 of 170 wallets.                          REFUSED
 *   bsc        every keyless RPC is pruned -- historical state says missing trie node.
 *   base       archive works, but 139 positions is 0.9% of value.
 *   ethereum   archive works on one endpoint, 1,462 positions, 0.7% of value.
 *
 * WHY THE OUTPUT IS PER-CHAIN. Only 31 of the 276 traders holding robinhood hold robinhood
 * alone. Putting a robinhood-only figure in the same series as a whole-portfolio sample
 * would draw a 36% drawdown that never happened, so the rebuilt series lives in
 * aum_chain_samples, where a per-chain number is what the column means. The parent row
 * carries a total only when robinhood is the whole story, and otherwise says why not.
 *
 * WHAT IT IS NOT. This is not sampling. It infers a past balance from transfers, so it is
 * written basis=rebuilt / tier=reported and never mixed into a measured segment -- the
 * route joins the two at trackedSince.
 *
 *   node scripts/rebuild_aum_robinhood.mjs --dry-run
 *   node scripts/rebuild_aum_robinhood.mjs --days 7 --handle frankdegods
 *   node scripts/rebuild_aum_robinhood.mjs
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { rpc, scale } from "./lib/chain_reads.mjs";

const DB = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
if (!DB) { console.error("DATABASE_URL is not set"); process.exit(1); }

const arg  = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const DRY  = flag("dry-run");
const DAYS = Number(arg("days", "30"));
const ONLY = arg("handle");
const VERIFY = flag("verify");
/*
 * A 30-day scan is ~742 requests against a node that rate-limits, and losing the last one
 * throws away the other 741. Each (window, chunk, side) is cached on disk the moment it
 * lands, so a re-run resumes instead of restarting. Delete the directory to force a refetch.
 */
const CACHE = arg("cache-dir", ".cache/rebuild_robinhood");

const RH_NETWORK_ID = 4663;
const RPC_URL   = "https://rpc.mainnet.chain.robinhood.com";
const TRANSFER  = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/*
 * A STARTING GUESS ONLY -- the real rate is measured at run time, and this is why.
 *
 * 0.195 s/block was correct when we characterised the chain against its whole history. Over
 * the last 30 days it actually runs at ~0.10, so the constant put the 30-day boundary 12
 * MILLION blocks too late and the search crawled toward the answer instead of landing on it.
 * calibrate() below replaces this with two real block reads before any boundary is resolved.
 */
const BLOCK_SEC_HINT = 0.195;

/*
 * Measured against OUR OWN wallets, which is the only measurement that counts -- a probe
 * with addresses that match nothing returns instantly at any range and proves nothing. With
 * 64 real addresses this node served 500,000-block windows in ~430ms and answered
 * "log query timed out" at 1,000,000. The 429s that appear at every shape are rate limiting
 * rather than a range limit; rpc() in chain_reads.mjs already backs off on those, and on the
 * 403 this node sends instead of them.
 *
 * The window is a starting point, not a promise: splitLogs() below halves any range the node
 * refuses, so a busy stretch costs two requests instead of failing the run.
 */
const WINDOW_BLOCKS = 500_000;
const ADDR_CHUNK    = 64;
const MIN_WINDOW    = 2_000;

/** The same ceilings the sampler applies, so a rebuilt point and a sampled one cannot disagree. */
const MAX_PRICE_PER_TOKEN = 1_000_000;
const MAX_POSITION_USD    = 1_000_000_000_000;

/** A dated price may stand in for a day this far away, and no further. */
const PRICE_GAP_DAYS = 7;

/*
 * getLogs gets more patience than a balance read. A window that will not answer ends the
 * whole run, so it is worth waiting out a rate limit that a cheaper call could just retry.
 */
const LOG_TRIES = 10;

const pool  = new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 3 });
const hex   = (n) => "0x" + BigInt(n).toString(16);
const padTopic = (a) => "0x" + a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const addrOf   = (topic) => "0x" + topic.slice(-40).toLowerCase();

function value(amount, price) {
  if (price === null || !Number.isFinite(price) || price <= 0) return {};
  if (price > MAX_PRICE_PER_TOKEN) return { rejected: true };
  const usd = amount * price;
  if (!Number.isFinite(usd) || usd > MAX_POSITION_USD) return { rejected: true };
  return { usd };
}

async function call(method, params, tries = 5) {
  const j = await rpc(RPC_URL, { jsonrpc: "2.0", id: 1, method, params }, tries);
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/** One compact line per transfer: everything the walk needs and nothing else. */
const encode = (l) => `${l.address.toLowerCase()},${l.topics[1]},${l.topics[2]},${l.data},${l.blockNumber},${l.transactionHash},${l.logIndex}`;
const decode = (line) => {
  const [address, t1, t2, data, blockNumber, transactionHash, logIndex] = line.split(",");
  return { address, topics: [TRANSFER, t1, t2], data, blockNumber, transactionHash, logIndex };
};

/**
 * splitLogs, but written down. The cache key is the exact request, so a resumed run cannot
 * mistake one range for another, and a range only counts as cached once it is fully written.
 */
async function cachedLogs(from, to, topics, key) {
  const file = path.join(CACHE, `${key}.csv`);
  if (fs.existsSync(file)) {
    const body = fs.readFileSync(file, "utf8");
    cacheHits++;
    return body ? body.split("\n").filter(Boolean).map(decode) : [];
  }
  const got = await splitLogs(from, to, topics);
  const tmp = file + ".part";
  fs.writeFileSync(tmp, got.filter((l) => l.topics && l.topics.length >= 3).map(encode).join("\n"));
  fs.renameSync(tmp, file);            // a half-written file must never look like a cached range
  return got;
}
let cacheHits = 0;

/**
 * Every log in a range, halving the range whenever the node says it looked too long.
 *
 * There is deliberately no catch that returns an empty list. A range we cannot read is not a
 * gap in one trader -- it is a wrong balance for everyone who moved a coin inside it, and
 * nothing in the resulting numbers would show which. Below MIN_WINDOW we stop splitting and
 * let the error end the run, before anything has been written.
 */
async function splitLogs(from, to, topics, depth = 0) {
  try {
    return await call("eth_getLogs", [{ fromBlock: hex(from), toBlock: hex(to), topics }], LOG_TRIES);
  } catch (e) {
    const span = to - from + 1;
    if (!/timed out|too large|limit|range/i.test(String(e.message)) || span <= MIN_WINDOW) throw e;
    const mid = from + Math.floor(span / 2);
    splits++;
    const [a, b] = [await splitLogs(from, mid, topics, depth + 1),
                    await splitLogs(mid + 1, to, topics, depth + 1)];
    return a.concat(b);
  }
}
let splits = 0;

async function blockTimestamp(n) {
  const b = await call("eth_getBlockByNumber", [hex(n), false]);
  return b ? Number(BigInt(b.timestamp)) : null;
}

/** The chain's true recent block rate, from two real reads. Never assumed. */
async function calibrate(head, headTs) {
  const probe = Math.max(1, head - 20_000_000);
  const probeTs = await blockTimestamp(probe);
  if (probeTs === null || probe >= head) return BLOCK_SEC_HINT;
  const rate = (headTs - probeTs) / (head - probe);
  return rate > 0 ? rate : BLOCK_SEC_HINT;
}

/**
 * The block that was current at a given instant.
 *
 * Secant refinement, not a fixed-rate guess: each step recomputes the rate from the last two
 * real readings, so it lands in two or three reads even when the chain's speed has drifted.
 * A fixed rate that is 2x off halves its error per step and needs fifteen.
 */
async function blockAtTime(targetSec, head, headTs, rate) {
  const clamp = (n) => Math.min(head, Math.max(1, n));
  let b0 = head, t0 = headTs;
  let b1 = clamp(head - Math.round((headTs - targetSec) / rate));
  let t1 = await blockTimestamp(b1);
  if (t1 === null) return null;

  for (let i = 0; i < 12; i++) {
    if (Math.abs(t1 - targetSec) <= 30) return b1;
    const local = (b1 !== b0 && t1 !== t0) ? (t0 - t1) / (b0 - b1) : rate;
    const next = clamp(b1 - Math.round((t1 - targetSec) / (local > 0 ? local : rate)));
    if (next === b1) return b1;
    b0 = b1; t0 = t1;
    b1 = next;
    t1 = await blockTimestamp(b1);
    if (t1 === null) return b0;
  }
  return b1;
}

async function main() {
  const client = await pool.connect();
  try {
    // ------------------------------------------------------------------ inputs
    const { rows: wallets } = await client.query(`
      select w.handle, w.evm_address_key
      from wallets w
      where w.evm_address_key is not null
        ${ONLY ? "and w.handle = $1" : ""}`, ONLY ? [ONLY.toLowerCase()] : []);
    if (!wallets.length) { console.error("no EVM wallets to rebuild"); process.exit(1); }

    const handleOf = new Map(wallets.map((w) => [w.evm_address_key.toLowerCase(), w.handle]));
    const addresses = [...handleOf.keys()];

    const { rows: anchorRows } = await client.query(`
      select h.handle, h.token_key, h.human_amount::float8 as amount, h.captured_at,
             tk.decimals,
             (qa.token_key is not null) as is_native
      from holdings_current h
      left join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
      left join quote_assets qa on qa.network_id = h.network_id and qa.token_key = h.token_key
      where h.network_id = ${RH_NETWORK_ID} and h.human_amount > 0
        ${ONLY ? "and h.handle = $1" : ""}`, ONLY ? [ONLY.toLowerCase()] : []);

    const { rows: decRows } = await client.query(
      `select token_key, decimals from tokens where network_id = ${RH_NETWORK_ID} and decimals is not null`);
    const decimalsOf = new Map(decRows.map((r) => [r.token_key, Number(r.decimals)]));

    const { rows: onlyRh } = await client.query(`
      select handle from holdings_current where human_amount > 0
      group by handle having count(distinct network_id) = 1
         and max(network_id) = ${RH_NETWORK_ID}`);
    const robinhoodOnly = new Set(onlyRh.map((r) => r.handle));

    console.log(`${addresses.length} wallets · ${anchorRows.length} anchor positions · ` +
                `${decimalsOf.size} token decimals · ${robinhoodOnly.size} robinhood-only traders`);

    // ------------------------------------------------------- day boundaries
    const head   = Number(BigInt(await call("eth_blockNumber", [])));
    const headTs = await blockTimestamp(head);
    const rate   = await calibrate(head, headTs);
    console.log(`block rate measured at ${rate.toFixed(4)} s/block (hint was ${BLOCK_SEC_HINT})`);
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);

    const boundaries = [];
    for (let d = DAYS; d >= 1; d--) {
      const at = new Date(midnight.getTime() - d * 86400_000);
      boundaries.push({ at, sec: Math.floor(at.getTime() / 1000) });
    }
    for (const b of boundaries) b.block = await blockAtTime(b.sec, head, headTs, rate);
    const startBlock = boundaries[0].block;
    console.log(`head ${head} (${new Date(headTs * 1000).toISOString()}) · ` +
                `oldest boundary ${boundaries[0].at.toISOString().slice(0, 10)} at block ${startBlock} · ` +
                `${(head - startBlock).toLocaleString()} blocks to scan`);

    /*
     * Every trader's anchor was captured at a slightly different moment, and the walk back
     * must start from the block that matched it -- starting from the head would subtract
     * transfers that happened AFTER the balance we are anchored on. Truncated to the hour
     * so a few hundred traders share a handful of lookups.
     */
    const anchorBlockAt = new Map();
    for (const r of anchorRows) {
      const hr = Math.floor(new Date(r.captured_at).getTime() / 3600_000) * 3600;
      if (!anchorBlockAt.has(hr)) anchorBlockAt.set(hr, await blockAtTime(hr, head, headTs, rate));
    }

    // --------------------------------------------------------------- the logs
    const chunks = [];
    for (let i = 0; i < addresses.length; i += ADDR_CHUNK) chunks.push(addresses.slice(i, i + ADDR_CHUNK).map(padTopic));

    const windows = [];
    for (let from = startBlock; from <= head; from += WINDOW_BLOCKS) {
      windows.push([from, Math.min(head, from + WINDOW_BLOCKS - 1)]);
    }
    const planned = windows.length * chunks.length * 2;
    console.log(`fetching logs: ${windows.length} windows x ${chunks.length} address chunks x 2 sides = ${planned} requests`);

    fs.mkdirSync(CACHE, { recursive: true });
    const seen = new Set();
    const logs = [];
    let done = 0;
    for (const [from, to] of windows) {
      for (const [ci, chunk] of chunks.entries()) {
        for (const side of [1, 2]) {
          const topics = side === 1 ? [TRANSFER, chunk, null] : [TRANSFER, null, chunk];
          for (const l of await cachedLogs(from, to, topics, `${from}-${to}-c${ci}-s${side}`)) {
            const k = `${l.transactionHash}:${l.logIndex}`;
            if (seen.has(k)) continue;       // an internal transfer matches both sides
            seen.add(k);
            if (!l.topics || l.topics.length < 3) continue;
            logs.push({
              token: l.address.toLowerCase(),
              from:  addrOf(l.topics[1]),
              to:    addrOf(l.topics[2]),
              raw:   (() => { try { return BigInt(l.data); } catch { return null; } })(),
              block: Number(BigInt(l.blockNumber)),
            });
          }
          if (++done % 20 === 0 || done === planned) {
            console.log(`  ${String(done).padStart(4)}/${planned} requests · ${logs.length.toLocaleString()} transfers` +
                        (cacheHits ? ` · ${cacheHits} from cache` : ""));
          }
        }
      }
    }
    console.log(`${logs.length.toLocaleString()} distinct transfers touching our wallets` +
                (splits ? ` · ${splits} ranges halved` : "") +
                (cacheHits ? ` · ${cacheHits} of ${planned} ranges resumed from cache` : ""));

    // ------------------------------------------------- deltas per handle+token
    const deltas = new Map();   // handle:token -> [{ block, raw }]
    const push = (handle, token, block, raw) => {
      const k = `${handle}:${token}`;
      let a = deltas.get(k); if (!a) deltas.set(k, a = []);
      a.push({ block, raw });
    };
    for (const l of logs) {
      if (l.raw === null) continue;
      const hFrom = handleOf.get(l.from), hTo = handleOf.get(l.to);
      if (hFrom) push(hFrom, l.token, l.block, -l.raw);
      if (hTo)   push(hTo,   l.token, l.block,  l.raw);
    }

    const anchorOf = new Map();  // handle:token -> { amount, decimals, isNative, anchorBlock }
    for (const r of anchorRows) {
      const hr = Math.floor(new Date(r.captured_at).getTime() / 3600_000) * 3600;
      anchorOf.set(`${r.handle}:${r.token_key}`, {
        amount: Number(r.amount), decimals: r.decimals === null ? null : Number(r.decimals),
        isNative: r.is_native === true, anchorBlock: anchorBlockAt.get(hr) ?? head,
      });
    }
    // A coin fully sold inside the window has no anchor row. Its past balance is still
    // recoverable -- it is zero now, and the sells we just read put it back.
    for (const k of deltas.keys()) {
      if (anchorOf.has(k)) continue;
      const token = k.slice(k.indexOf(":") + 1);
      anchorOf.set(k, { amount: 0, decimals: decimalsOf.get(token) ?? null, isNative: false, anchorBlock: head });
    }

    // ------------------------------------------------------------------ verify
    /*
     * PROVING THE ARITHMETIC. robinhood keeps no archive state, so a past balance cannot be
     * checked against the chain directly. It can be checked FORWARD: the balance we anchored
     * on, plus every transfer since that block, must equal what the wallet holds right now.
     * That exercises the same transfer set and the same sum the backward walk depends on, so
     * if it holds the walk is sound; if it does not, the log set is incomplete and every
     * rebuilt point is wrong.
     */
    if (VERIFY) {
      const addrOfHandle = new Map();
      for (const [addr, h] of handleOf) if (!addrOfHandle.has(h)) addrOfHandle.set(h, addr);

      const cands = [];
      const perTrader = new Map();
      for (const [key, a] of anchorOf) {
        if (a.isNative || a.decimals === null || a.amount <= 0) continue;
        const handle = key.slice(0, key.indexOf(":"));
        if (!addrOfHandle.has(handle)) continue;
        const n = perTrader.get(handle) ?? 0;
        if (n >= 4) continue;                       // spread the sample over many wallets
        perTrader.set(handle, n + 1);
        cands.push({ key, handle, token: key.slice(key.indexOf(":") + 1), a });
        if (cands.length >= 40) break;
      }

      let exact = 0, off = 0;
      for (let i = 0; i < cands.length; i += 20) {
        const slice = cands.slice(i, i + 20);
        const res = await rpc(RPC_URL, slice.map((c, k) => ({
          jsonrpc: "2.0", id: k, method: "eth_call",
          params: [{ to: c.token,
                     data: "0x70a08231" + addrOfHandle.get(c.handle).replace(/^0x/, "").padStart(64, "0") },
                   "latest"],
        })));
        const byId = new Map((Array.isArray(res) ? res : []).map((r) => [r.id, r]));
        for (const [k, c] of slice.entries()) {
          const r = byId.get(k);
          if (!r || typeof r.result !== "string" || r.result.length < 3) continue;
          let live; try { live = Number(scale(BigInt(r.result), c.a.decimals)); } catch { continue; }

          let acc = 0n;
          for (const d of deltas.get(c.key) ?? []) if (d.block > c.a.anchorBlock) acc += d.raw;
          const moved = Number(scale(acc < 0n ? -acc : acc, c.a.decimals)) * (acc < 0n ? -1 : 1);
          const predicted = c.a.amount + moved;

          const tol = Math.max(Math.abs(live), Math.abs(predicted), 1) * 1e-6;
          if (Math.abs(predicted - live) <= tol) exact++;
          else {
            off++;
            if (off <= 6) {
              console.log(`  MISMATCH ${c.handle}/${c.token.slice(0, 10)} ` +
                          `anchor ${c.a.amount} + moved ${moved} = ${predicted} vs live ${live}`);
            }
          }
        }
      }
      console.log(`\nverify: ${exact} of ${exact + off} balances reproduce exactly from ` +
                  `anchor + transfers since the anchor block`);
      if (off > 0) {
        console.error("the transfer set does not explain the live balances -- refusing to write");
        process.exit(1);
      }
    }

    // ------------------------------------------------------------- price series
    const { rows: pxRows } = await client.query(`
      select token_key, at, px from (
        select token_key, opened_at as at, avg_entry_price::float8 as px from trades
          where network_id = ${RH_NETWORK_ID} and avg_entry_price > 0 and opened_at is not null
        union all
        select token_key, closed_at, avg_exit_price::float8 from trades
          where network_id = ${RH_NETWORK_ID} and avg_exit_price > 0 and closed_at is not null
      ) s where at >= now() - interval '${DAYS + 20} days'`);
    const series = new Map();
    for (const r of pxRows) {
      const t = new Date(r.at).getTime();
      if (!Number.isFinite(t) || !Number.isFinite(r.px)) continue;
      let a = series.get(r.token_key); if (!a) series.set(r.token_key, a = []);
      a.push({ t, px: Number(r.px) });
    }
    for (const a of series.values()) a.sort((x, y) => x.t - y.t);
    console.log(`${pxRows.length.toLocaleString()} dated price observations across ${series.size.toLocaleString()} tokens`);

    /** Nearest dated observation, within PRICE_GAP_DAYS. Beyond that the day is unpriced. */
    const GAP = PRICE_GAP_DAYS * 86400_000;
    const priceAt = (token, ms) => {
      const a = series.get(token); if (!a) return null;
      let lo = 0, hi = a.length - 1, best = null, bestD = Infinity;
      while (lo <= hi) {
        const m = (lo + hi) >> 1, d = Math.abs(a[m].t - ms);
        if (d < bestD) { bestD = d; best = a[m].px; }
        if (a[m].t < ms) lo = m + 1; else hi = m - 1;
      }
      for (const i of [lo - 1, lo, hi, hi + 1]) {
        if (i >= 0 && i < a.length) { const d = Math.abs(a[i].t - ms); if (d < bestD) { bestD = d; best = a[i].px; } }
      }
      return bestD <= GAP ? best : null;
    };

    // ------------------------------------------------------------- the walk back
    const boundariesDesc = [...boundaries].reverse();
    const perDay = new Map();   // handle -> Map(atMs -> { usd, priced, total, rejected, negative })
    const bump = (handle, ms) => {
      let m = perDay.get(handle); if (!m) perDay.set(handle, m = new Map());
      let c = m.get(ms); if (!c) m.set(ms, c = { usd: 0, priced: 0, total: 0, rejected: 0, negative: 0, unrebuildable: 0 });
      return c;
    };

    for (const [key, a] of anchorOf) {
      const handle = key.slice(0, key.indexOf(":"));
      const token  = key.slice(key.indexOf(":") + 1);

      /*
       * Native ETH does not emit a Transfer log, so its past balance is not in what we just
       * read. It is counted as a position and never valued -- 76 positions worth $20,926,
       * 0.014% of robinhood. Reporting it flat would be inventing a balance; dropping it
       * would quietly shrink the denominator that tells you how complete the point is.
       */
      if (a.isNative) {
        for (const b of boundariesDesc) { const c = bump(handle, b.at.getTime()); c.total++; c.unrebuildable++; }
        continue;
      }
      if (a.decimals === null) {
        for (const b of boundariesDesc) { const c = bump(handle, b.at.getTime()); c.total++; c.unrebuildable++; }
        continue;
      }

      const ds = (deltas.get(key) ?? []).filter((d) => d.block <= a.anchorBlock)
                                        .sort((x, y) => y.block - x.block);
      let acc = 0n, i = 0;
      for (const b of boundariesDesc) {
        while (i < ds.length && ds[i].block > b.block) { acc += ds[i].raw; i++; }
        const moved = Number(scale(acc < 0n ? -acc : acc, a.decimals)) * (acc < 0n ? -1 : 1);
        const bal = a.amount - moved;
        const c = bump(handle, b.at.getTime());

        // Below the last decimal place the coin can express, it is zero, not a position.
        if (Math.abs(bal) < Number.EPSILON) continue;
        if (bal < 0) {
          /*
           * The transfers say he sent out more than he ever had. That means our view of this
           * coin is incomplete, not that he was short it. Counted as a position we cannot
           * state, never clamped to zero -- a clamp would look exactly like a real exit.
           */
          c.total++; c.negative++; continue;
        }
        c.total++;
        const v = value(bal, priceAt(token, b.at.getTime()));
        if (v.rejected) c.rejected++;
        else if (v.usd !== undefined) { c.usd += v.usd; c.priced++; }
      }
    }

    // ------------------------------------------------------------------ write
    let wrote = 0, statedTotals = 0, noPrices = 0;
    const summary = [];
    for (const [handle, days] of perDay) {
      const ats = [...days.keys()].sort((a, b) => a - b);
      const rows = ats.map((ms) => {
        const c = days.get(ms);
        const priceable = c.priced > 0;
        return {
          at: new Date(ms),
          chainUsd: priceable ? c.usd : null,
          reason: priceable ? null : (c.total === 0 ? null : "no_prices"),
          priced: c.priced, total: c.total,
          share: c.total > 0 ? Number((c.priced / c.total).toFixed(4)) : null,
        };
      });
      // A trader with no robinhood position on any day of the window has nothing to say.
      if (!rows.some((r) => r.total > 0)) continue;

      const whole = robinhoodOnly.has(handle);
      summary.push({ handle, days: rows.length, whole,
                     newest: rows[rows.length - 1].chainUsd });
      if (DRY) { wrote += rows.length; if (whole) statedTotals += rows.length; continue; }

      /*
       * The parent row states a TOTAL only when robinhood is the whole trader. Otherwise it
       * carries the coverage and a reason, and the number lives on the chain row below --
       * where a robinhood-only figure is what the column is supposed to mean.
       */
      await client.query(`
        insert into aum_samples
          (handle, at, total_usd, refused_reason, priced_positions, total_positions,
           value_share, basis, tier)
        select $1, u.at, u.total, u.reason, u.priced, u.total_pos, u.share, 'rebuilt', 'reported'
        from unnest($2::timestamptz[], $3::numeric[], $4::text[], $5::int[], $6::int[],
                    $7::numeric[]) as u(at, total, reason, priced, total_pos, share)
        on conflict (handle, at, basis) do update set
          total_usd = excluded.total_usd, refused_reason = excluded.refused_reason,
          priced_positions = excluded.priced_positions, total_positions = excluded.total_positions,
          value_share = excluded.value_share, sampled_at = now()`,
        [handle,
         rows.map((r) => r.at),
         rows.map((r) => (whole ? r.chainUsd : null)),
         rows.map((r) => (whole ? r.reason : "chains_unrebuildable")),
         rows.map((r) => r.priced),
         rows.map((r) => r.total),
         rows.map((r) => r.share)]);

      await client.query(`
        insert into aum_chain_samples (handle, at, basis, network_id, total_usd, priced_share, reason)
        select $1, u.at, 'rebuilt', ${RH_NETWORK_ID}, u.usd, u.share, u.reason
        from unnest($2::timestamptz[], $3::numeric[], $4::numeric[], $5::text[])
             as u(at, usd, share, reason)
        on conflict (handle, at, basis, network_id) do update set
          total_usd = excluded.total_usd, priced_share = excluded.priced_share,
          reason = excluded.reason`,
        [handle,
         rows.map((r) => r.at),
         rows.map((r) => r.chainUsd),
         rows.map((r) => r.share),
         rows.map((r) => r.reason)]);

      wrote += rows.length;
      if (whole) statedTotals += rows.length;
      if (rows.some((r) => r.reason === "no_prices")) noPrices++;
    }
    const withValue = summary.filter((s) => s.newest !== null).length;
    console.log(`\n${wrote} rebuilt points across ${summary.length} traders` +
                `${DRY ? " (dry run, nothing written)" : ""}`);
    console.log(`  ${statedTotals} of them state a whole-trader total (robinhood-only traders)`);
    console.log(`  ${withValue} traders have a priced robinhood series; ${noPrices} hit a day with no prices`);
    const top = summary.filter((s) => s.newest !== null).sort((a, b) => b.newest - a.newest).slice(0, 8);
    for (const t of top) {
      console.log(`  ${t.handle.padEnd(24)} ${String(t.days).padStart(3)}d  ` +
                  `newest $${Math.round(t.newest).toLocaleString().padStart(14)}${t.whole ? "  (whole trader)" : ""}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
