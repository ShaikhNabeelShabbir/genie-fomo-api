#!/usr/bin/env node
/**
 * Step 4a of AXIS_ALIGNMENT.md §6 — the trader's OWN swaps on EVM chains, both sides resolved.
 *
 * The EVM counterpart of resolve_wallet_swaps.mjs (T2.2, Solana). Same output table, same
 * quote/token split, same rule that a swap the wallet did not make is ABSENT rather than zero.
 *
 * WHY IT DOES NOT REUSE `transactions`. Step 3 measured that table and it is not the trades:
 * of 49,248 robinhood wallet-transactions only 23 have both an in and an out leg, fifty
 * receipts read from chain came back 0 two-sided at 1.0 transfer legs each, and our trader's
 * wallet was the transaction SENDER in 0 of 50. Those rows are inbound transfers -- airdrops
 * and distributions. The trades were never ingested, so this script discovers them itself.
 *
 * WHY IT DOES NOT USE tx.from. The wallet was the sender in none of the fifty. These traders
 * route through relayers, exactly as T2.2 found on Solana, where believing `feePayer` was the
 * trader was the second of two wrong diagnoses. Attribution here is by NET BALANCE CHANGE per
 * (wallet, token) inside one transaction, which is what survived there.
 *
 * DISCOVERY, per chain, using only what we already hold:
 *   robinhood  eth_getLogs on the chain's own public RPC, Transfer topic, every wallet OR'd
 *              into the topic array. Keyless. Measured: 139 wallets over a 500k-block window
 *              answers in 2.5s, and the chain is 58.4M blocks old, so a full scan is ~234
 *              requests. blockscout is not an option -- it is behind Cloudflare and 403s.
 *   ethereum   Etherscan V2 `tokentx` on ETHERSCAN_KEY, whose free tier serves chainid 1.
 *              (It refuses bsc and base on the free tier -- that is step 4b's problem.)
 *
 *   node scripts/resolve_evm_swaps.mjs                    # robinhood + ethereum
 *   node scripts/resolve_evm_swaps.mjs --chain robinhood
 *   node scripts/resolve_evm_swaps.mjs --from-block 57000000 --dry-run
 */
import pg from "pg";

const DB  = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
const ESK = (process.env.ETHERSCAN_KEY ?? "").trim();
if (!DB) { console.error("DATABASE_URL is not set"); process.exit(1); }

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** Measured envelope: 139 wallets x 500k blocks = 6,923 logs in 2.5s. Larger times out. */
const WINDOW = 500_000;
const DEC_SELECTOR = "0x313ce567";

const arg  = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i+1] ? process.argv[i+1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const ONLY_CHAIN = arg("chain");
const FROM_BLOCK = Number(arg("from-block", "0")) || 0;
const DRY = flag("dry-run");

const pool = new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 4 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad32 = (a) => "0x" + a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const unpad = (t) => "0x" + t.slice(-40).toLowerCase();

/**
 * One in-flight request per host with a floor between them.
 *
 * Without this the scan collapses: a 139-wallet 2M-block query came back "log query timed
 * out" and the next two came back 429, which reads like a range limit and is really the node
 * shedding load. Throttled, the same shape answers in 2.5s.
 */
const GAP_MS = 450;
let chainq = Promise.resolve();
function throttled(fn) {
  const next = chainq.then(async () => { const t = Date.now(); try { return await fn(); } finally { await sleep(Math.max(0, GAP_MS - (Date.now() - t))); } });
  chainq = next.catch(() => {});
  return next;
}
async function rpc(url, method, params, tries = 6) {
  for (let i = 1; ; i++) {
    try {
      return await throttled(async () => {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(120_000) });
        if (r.status === 429 || r.status === 403) { const e = new Error("HTTP " + r.status); e.retry = true; throw e; }
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        if (j.error) { const e = new Error(String(j.error.message).slice(0, 80)); e.retry = /timed out|limit/i.test(e.message); throw e; }
        return j.result;
      });
    } catch (e) {
      if (i >= tries || !e.retry) throw e;
      await sleep(Math.min(1200 * i, 10_000));
    }
  }
}

/** BigInt -> exact decimal string. Number() would round anything past 2^53. */
function scale(raw, decimals) {
  const neg = raw < 0n; const s = (neg ? -raw : raw).toString().padStart(decimals + 1, "0");
  const w = s.slice(0, s.length - decimals);
  const f = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return (neg ? "-" : "") + (f ? `${w}.${f}` : w);
}

/**
 * Turn one transaction's Transfer logs into the wallet's net movement per token.
 *
 * A router can move the same token through a wallet several times inside one transaction;
 * only the NET matters, which is the whole reason this is immune to router internals.
 */
function netDeltas(logs, wallet) {
  const me = wallet.toLowerCase();
  const net = new Map();
  for (const lg of logs) {
    if (lg.topics.length < 3) continue;
    const from = unpad(lg.topics[1]), to = unpad(lg.topics[2]);
    let v; try { v = BigInt(lg.data && lg.data !== "0x" ? lg.data.slice(0, 66) : "0x0"); } catch { continue; }
    if (v === 0n) continue;
    const key = lg.address.toLowerCase();
    if (to === me)   net.set(key, (net.get(key) ?? 0n) + v);
    if (from === me) net.set(key, (net.get(key) ?? 0n) - v);
  }
  for (const [k, v] of net) if (v === 0n) net.delete(k);
  return net;
}

/** decimals() for tokens we have not read before, batched, cached in `tokens.decimals`. */
async function learnDecimals(client, rpcUrl, networkId, keys, cache) {
  const need = [...keys].filter((k) => !cache.has(k));
  if (!need.length) return;
  for (let i = 0; i < need.length; i += 40) {
    const slice = need.slice(i, i + 40);
    let out;
    try {
      out = await throttled(async () => {
        const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(slice.map((a, k) => ({ jsonrpc: "2.0", id: k, method: "eth_call", params: [{ to: a, data: DEC_SELECTOR }, "latest"] }))),
          signal: AbortSignal.timeout(60_000) });
        return r.ok ? await r.json() : [];
      });
    } catch { continue; }
    for (const r of Array.isArray(out) ? out : []) {
      const t = slice[r?.id]; if (!t) continue;
      if (typeof r.result !== "string" || r.result.length < 3) continue;
      let d; try { d = BigInt(r.result); } catch { continue; }
      if (d <= 36n) cache.set(t, Number(d));
    }
  }
  const rows = need.filter((k) => cache.has(k));
  if (rows.length && !DRY) {
    await client.query(`
      insert into tokens (network_id, address, decimals)
      select * from unnest($1::bigint[], $2::text[], $3::smallint[])
      on conflict (network_id, token_key) do update set decimals = coalesce(tokens.decimals, excluded.decimals)`,
      [rows.map(() => networkId), rows, rows.map((k) => cache.get(k))]);
  }
}

/**
 * The quote/token split, identical in intent to the Solana resolver.
 *
 * A swap between two quote assets, or between two non-quote tokens, is skipped: neither
 * gives a dollar-denominated entry or exit, and picking which side was "the trade" would be
 * inventing an answer. Both sides must move in OPPOSITE directions -- same-sign is a deposit
 * that happened to touch two tokens, not a trade.
 */
function classify(net, quoteSet, decimals) {
  const legs = [...net].filter(([k]) => decimals.has(k));
  if (legs.length < 2) return null;
  const qs = legs.filter(([k]) => quoteSet.has(k));
  const ts = legs.filter(([k]) => !quoteSet.has(k));
  if (qs.length !== 1 || ts.length !== 1) return null;
  const [qk, qv] = qs[0], [tk, tv] = ts[0];
  if ((qv > 0n) === (tv > 0n)) return null;
  return { token_key: tk, token_delta: scale(tv, decimals.get(tk)),
           quote_key: qk, quote_delta: scale(qv, decimals.get(qk)) };
}

async function blockTimes(rpcUrl, numbers) {
  const out = new Map();
  const list = [...numbers];
  for (let i = 0; i < list.length; i += 40) {
    const slice = list.slice(i, i + 40);
    try {
      const res = await throttled(async () => {
        const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(slice.map((b, k) => ({ jsonrpc: "2.0", id: k, method: "eth_getBlockByNumber", params: ["0x" + b.toString(16), false] }))),
          signal: AbortSignal.timeout(60_000) });
        return r.ok ? await r.json() : [];
      });
      for (const r of Array.isArray(res) ? res : []) {
        if (slice[r?.id] === undefined || !r.result?.timestamp) continue;
        out.set(slice[r.id], new Date(parseInt(r.result.timestamp, 16) * 1000).toISOString());
      }
    } catch { /* a window with no times still resolves, block_time just stays null */ }
  }
  return out;
}

// ------------------------------------------------------------------ robinhood
async function scanLogs(client, chain, wallets, quoteSet, decimals, stats) {
  const url = chain.rpc;
  const latest = parseInt(await rpc(url, "eth_blockNumber", []), 16);
  const padded = wallets.map(pad32);
  const start = FROM_BLOCK || 0;
  console.log(`  ${chain.name}: scanning blocks ${start}..${latest} in ${Math.ceil((latest - start) / WINDOW)} windows`);

  const found = [];
  for (let from = start; from <= latest; from += WINDOW) {
    const to = Math.min(from + WINDOW - 1, latest);
    let logs = [];
    // Both topic positions: the wallet as sender and as recipient. A swap has one of each,
    // so the two scans have to be merged inside the SAME window or the halves never meet.
    for (const pos of [1, 2]) {
      const topics = pos === 1 ? [TRANSFER, padded, null] : [TRANSFER, null, padded];
      try { logs = logs.concat(await rpc(url, "eth_getLogs", [{ fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics }])); }
      catch (e) { stats.windowErrors++; }
    }
    if (!logs.length) continue;

    // De-duplicate: a wallet-to-wallet transfer between two tracked wallets matches both scans.
    const seen = new Set();
    const byTxWallet = new Map();
    const walletSet = new Set(wallets.map((w) => w.toLowerCase()));
    for (const lg of logs) {
      const id = `${lg.transactionHash}|${lg.logIndex}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (lg.topics.length < 3) continue;
      for (const who of [unpad(lg.topics[1]), unpad(lg.topics[2])]) {
        if (!walletSet.has(who)) continue;
        const k = `${lg.transactionHash}|${who}`;
        if (!byTxWallet.has(k)) byTxWallet.set(k, { tx: lg.transactionHash, wallet: who, block: parseInt(lg.blockNumber, 16), logs: [] });
        byTxWallet.get(k).logs.push(lg);
      }
    }

    const contracts = new Set();
    for (const g of byTxWallet.values()) for (const lg of g.logs) contracts.add(lg.address.toLowerCase());
    await learnDecimals(client, url, chain.network_id, contracts, decimals);

    const hits = [];
    for (const g of byTxWallet.values()) {
      stats.candidates++;
      const c = classify(netDeltas(g.logs, g.wallet), quoteSet, decimals);
      if (!c) { stats.notASwap++; continue; }
      stats.swaps++;
      hits.push({ ...c, tx_hash: g.tx, address_key: g.wallet, block: g.block });
    }
    if (hits.length) {
      const times = await blockTimes(url, new Set(hits.map((h) => h.block)));
      for (const h of hits) h.block_time = times.get(h.block) ?? null;
      found.push(...hits);
    }
    if (((from - start) / WINDOW) % 20 === 0) {
      console.log(`    block ${to} · ${stats.swaps} swaps from ${stats.candidates} candidates`);
    }
  }
  return found;
}

// ------------------------------------------------------------------- ethereum
async function scanEtherscan(chainId, wallets, quoteSet, decimals, stats) {
  if (!ESK) { console.log("  ethereum: ETHERSCAN_KEY not set, skipped"); return []; }
  const found = [];
  for (const w of wallets) {
    const rows = [];
    for (let page = 1; page <= 10; page++) {
      const u = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=tokentx` +
                `&address=${w}&page=${page}&offset=1000&sort=asc&apikey=${ESK}`;
      let j; try { j = await (await fetch(u, { signal: AbortSignal.timeout(45_000) })).json(); } catch { break; }
      if (j.status !== "1" || !Array.isArray(j.result)) break;
      rows.push(...j.result);
      if (j.result.length < 1000) break;
      await sleep(250);
    }
    await sleep(250);
    const byTx = new Map();
    for (const r of rows) {
      decimals.set(r.contractAddress.toLowerCase(), Number(r.tokenDecimal));
      if (!byTx.has(r.hash)) byTx.set(r.hash, []);
      byTx.get(r.hash).push(r);
    }
    for (const [tx, rs] of byTx) {
      stats.candidates++;
      const net = new Map();
      for (const r of rs) {
        const k = r.contractAddress.toLowerCase(); let v;
        try { v = BigInt(r.value); } catch { continue; }
        if (r.to.toLowerCase() === w)   net.set(k, (net.get(k) ?? 0n) + v);
        if (r.from.toLowerCase() === w) net.set(k, (net.get(k) ?? 0n) - v);
      }
      for (const [k, v] of net) if (v === 0n) net.delete(k);
      const c = classify(net, quoteSet, decimals);
      if (!c) { stats.notASwap++; continue; }
      stats.swaps++;
      found.push({ ...c, tx_hash: tx, address_key: w,
                   block_time: new Date(Number(rs[0].timeStamp) * 1000).toISOString() });
    }
  }
  return found;
}

// ----------------------------------------------------------------------- main
async function main() {
  const client = await pool.connect();
  try {
    const { rows: chains } = await client.query(
      `select network_id::bigint, name, rpc from chains where name = any($1)`,
      [ONLY_CHAIN ? [ONLY_CHAIN] : ["robinhood", "ethereum"]]);
    const { rows: ws } = await client.query(
      `select distinct evm_address_key from wallets where evm_address is not null`);
    const wallets = ws.map((r) => r.evm_address_key);
    console.log(`${wallets.length} EVM wallets · chains: ${chains.map((c) => c.name).join(", ")}${DRY ? "  [DRY RUN]" : ""}`);

    for (const chain of chains) {
      const net = Number(chain.network_id);
      const { rows: qs } = await client.query(`select token_key from quote_assets where network_id = $1`, [net]);
      if (!qs.length) { console.log(`  ${chain.name}: no quote_assets rows — a swap needs a quote side, skipping`); continue; }
      const quoteSet = new Set(qs.map((q) => q.token_key));

      const { rows: dk } = await client.query(`select token_key, decimals from tokens where network_id=$1 and decimals is not null`, [net]);
      const decimals = new Map(dk.map((r) => [r.token_key, Number(r.decimals)]));

      const stats = { candidates: 0, swaps: 0, notASwap: 0, windowErrors: 0 };
      const t0 = Date.now();
      const found = net === 1
        ? await scanEtherscan(1, wallets, quoteSet, decimals, stats)
        : await scanLogs(client, chain, wallets, quoteSet, decimals, stats);

      console.log(`  ${chain.name}: ${stats.swaps} swaps · ${stats.notASwap} not a two-sided swap · ` +
                  `${stats.candidates} candidates · ${stats.windowErrors} window errors · ${((Date.now()-t0)/1000|0)}s`);

      if (DRY || !found.length) continue;
      for (let i = 0; i < found.length; i += 500) {
        const b = found.slice(i, i + 500);
        await client.query(`
          insert into wallet_swaps (network_id, tx_hash, address_key, block_time, token_key, token_delta, quote_key, quote_delta)
          select $1, * from unnest($2::text[], $3::text[], $4::timestamptz[], $5::text[], $6::numeric[], $7::text[], $8::numeric[])
          on conflict (network_id, tx_hash, address_key) do nothing`,
          [net, b.map(r=>r.tx_hash), b.map(r=>r.address_key), b.map(r=>r.block_time),
           b.map(r=>r.token_key), b.map(r=>r.token_delta), b.map(r=>r.quote_key), b.map(r=>r.quote_delta)]);
      }
      console.log(`  ${chain.name}: stored ${found.length}`);
    }

    if (DRY) { console.log("\n[DRY RUN] nothing written"); return; }

    /*
     * Value the quote side, exactly as T2.1/T2.2 do: pegged assets are their own amount,
     * floating ones use the daily close, and NULL stands where neither applies -- never 0.
     */
    const { rowCount: priced } = await client.query(`
      update wallet_swaps s
         set quote_usd = s.quote_delta * coalesce(q.pegged_usd, p.usd, ti.price_usd)
        from quote_assets q
        left join token_prices p on p.network_id = q.network_id and p.token_key = q.token_key
        left join token_info  ti on ti.network_id = q.network_id and ti.token_key = q.token_key
       where q.network_id = s.network_id and q.token_key = s.quote_key
         and s.network_id <> 1399811149 and s.quote_usd is null
         and (q.pegged_usd is not null or p.day = s.block_time::date or ti.price_usd is not null)`);
    console.log(`\npriced ${priced} quote sides`);

    const { rows: [tot] } = await client.query(`
      select count(*)::int rows, count(distinct address_key)::int wallets,
             count(quote_usd)::int priced from wallet_swaps where network_id <> 1399811149`);
    console.log(`wallet_swaps on EVM: ${tot.rows} rows · ${tot.wallets} wallets · ${tot.priced} priced`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
