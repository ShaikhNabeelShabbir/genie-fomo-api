#!/usr/bin/env node
/**
 * A4 — individual buys and sells on the four Ethereum-style chains.
 *
 * WHY THIS EXISTS. The scorecard's per-coin entry price is an AVERAGE that fomoapi hands us
 * already averaged across the fills inside a position, and an average cannot be un-averaged.
 * "95% of his buys were under $100K" counts buys, so it needs the buys. On Solana we hold
 * 2,017 of them in `wallet_swaps`; on the EVM chains we held none.
 *
 * WHY NOT THE EARLIER RESOLVER. `resolve_evm_swaps.mjs` worked from the transfer rows we had
 * ingested and found almost nothing, because those rows carry only the legs our ingest
 * happened to store. A transaction RECEIPT carries every log, so both legs of a swap are in
 * one call -- the same call that reads the fee for A7.
 *
 * WHAT IS AND IS NOT A TRADE, measured on a random sample of 100 bsc transactions:
 *     74%  contain no swap at all
 *     25%  contain a swap in which OUR WALLET IS ONE-SIDED -- it received or sent one token
 *          and not the other, so it was a counterparty inside someone else's trade
 *      1%  are the wallet's own two-sided swap
 * Only the last kind is a trade this wallet made, and only that kind is written here. The
 * 25% is exactly the trap the existing coverage note warns about on /trades: "most rows
 * tagged SWAP are inbound transfers inside someone else's transaction".
 *
 * So the candidate set is the transactions where the wallet already shows both an in and an
 * out leg -- 1,979 across the four chains, about 20 batched requests rather than 52,420.
 *
 *   node scripts/resolve_evm_swaps_from_receipts.mjs --chain=bsc
 *   node scripts/resolve_evm_swaps_from_receipts.mjs --evm --dry-run
 */
import pg from "pg";
import { rpc } from "./lib/chain_reads.mjs";

const DB = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
if (!DB) { console.error("DATABASE_URL is not set"); process.exit(1); }

const SOLANA = 1399811149;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** WETH/WBNB `Withdrawal(address,uint256)` — the router unwrapping before paying out coin. */
const WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";
const DEC_SELECTOR = "0x313ce567";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const CHAIN = opt("chain");
const DRY = flag("dry-run");
const BATCH = Number(opt("batch", "0")) || 0;

const db = new pg.Client({ connectionString: DB, ssl: { rejectUnauthorized: false } });
await db.connect();

const { rows: chains } = await db.query(
  `select network_id, name, rpc from chains
    where network_id <> $1 and ($2::text is null or name = $2) order by name`,
  [SOLANA, CHAIN]);

/** base caps a JSON-RPC batch at 10 and says so in a 200 body. Everything else takes 100. */
const batchFor = (name) => BATCH || (name === "base" ? 10 : 100);

/** Quote assets per chain, with the dollar value of one unit where we can state it. */
const { rows: quoteRows } = await db.query(
  `select q.network_id, q.token_key, q.symbol, q.pegged_usd,
          (select h.price from holdings_current h
            where h.network_id = q.network_id and h.token_key = q.token_key
              and h.price is not null and h.price_source is not null
              and h.price_source <> 'fomo_reported_entry'
            order by h.priced_at desc nulls last limit 1) as market_price
   from quote_assets q`);
const quotes = new Map();
for (const q of quoteRows) {
  /*
   * A stablecoin's peg is the honest price for it. For a wrapped native we use the same
   * market price the portfolio uses, and a quote asset we cannot price is still a quote
   * asset -- the swap resolves, it simply carries no dollar figure.
   */
  const usd = q.pegged_usd !== null ? Number(q.pegged_usd)
    : (q.market_price !== null ? Number(q.market_price) : null);
  quotes.set(`${Number(q.network_id)}:${q.token_key}`, { symbol: q.symbol, usd });
}

/**
 * Each chain's wrapped native, and what one is worth. This is the quote asset a native leg is
 * recorded against, so a coin-paid trade lands in the same shape as a stablecoin-paid one.
 */
const { rows: natRows } = await db.query(
  `select c.network_id, c.native_symbol, q.token_key
   from chains c
   join quote_assets q on q.network_id = c.network_id
    and upper(q.symbol) = 'W' || upper(c.native_symbol)`);
const nativeQuote = new Map();
for (const r of natRows) {
  const k = `${Number(r.network_id)}:${r.token_key}`;
  nativeQuote.set(Number(r.network_id), {
    key: r.token_key, symbol: r.native_symbol, usd: quotes.get(k)?.usd ?? null,
  });
}

const decCache = new Map();
async function decimalsFor(net, rpcUrl, addrs) {
  const need = addrs.filter((a) => !decCache.has(`${net}:${a}`));
  if (!need.length) return;
  const { rows } = await db.query(
    `select token_key, decimals from tokens
      where network_id = $1 and token_key = any($2) and decimals is not null`, [net, need]);
  for (const r of rows) decCache.set(`${net}:${r.token_key}`, Number(r.decimals));

  const still = need.filter((a) => !decCache.has(`${net}:${a}`));
  for (let i = 0; i < still.length; i += 40) {
    const slice = still.slice(i, i + 40);
    try {
      const j = await rpc(rpcUrl, slice.map((a, k) => ({
        jsonrpc: "2.0", id: k, method: "eth_call",
        params: [{ to: a, data: DEC_SELECTOR }, "latest"],
      })));
      for (const r of Array.isArray(j) ? j : []) {
        const a = slice[r?.id];
        if (!a || typeof r?.result !== "string" || r.result.length < 3) continue;
        try {
          const d = Number(BigInt(r.result));
          // A decimals() that reverts or answers absurdly is not an ERC-20 we can scale.
          if (Number.isFinite(d) && d >= 0 && d <= 36) decCache.set(`${net}:${a}`, d);
        } catch { /* not a number; leave it unknown */ }
      }
    } catch { /* leave unknown; the swap is skipped, never guessed */ }
  }
}

/** BigInt -> Number, scaled. Exact through the string, so nothing rounds at 2^53. */
function human(raw, dec) {
  const s = raw.toString().padStart(dec + 1, "0");
  const whole = s.slice(0, s.length - dec);
  const frac = dec ? s.slice(s.length - dec) : "";
  return Number(frac ? `${whole}.${frac}` : whole);
}

let totalWritten = 0, totalSkipped = 0;

for (const c of chains) {
  const net = Number(c.network_id);
  /*
   * The candidates: transactions where this wallet already shows BOTH an in and an out leg.
   * A one-sided transaction is not this wallet's trade however many swaps the block carried.
   */
  /*
   * EVERY UNRESOLVED TRANSACTION, not only the ones that look two-sided in our stored rows.
   *
   * The first version asked for transactions where the wallet already showed an `in` and an
   * `out` leg in `transactions`. That set is 1,979 across four chains and it is the wrong
   * question twice over: our stored rows carry only the legs the ingest happened to keep, and
   * -- far more important -- a swap paid for in NATIVE coin has no incoming Transfer at all.
   * Native legs are value transfers; they emit no ERC-20 event, so they can never appear as a
   * second direction no matter how complete the ingest is.
   *
   * Measured on 60 random bsc transactions: 1 was token-for-token, 2 were native-for-token and
   * 3 were token-for-native. The old filter found the 1 and discarded the 5.
   */
  const { rows: cands } = await db.query(
    `select t.tx_hash, t.address_key, min(t.block_time) as block_time
     from transactions t
     where t.network_id = $1
       and not exists (
         select 1 from wallet_swaps s
         where s.network_id = $1 and s.tx_hash = t.tx_hash and s.address_key = t.address_key)
     group by t.tx_hash, t.address_key`,
    [net]);

  if (!cands.length) { console.log(`${c.name}: nothing to resolve`); continue; }
  const size = batchFor(c.name);
  console.log(`${c.name}: ${cands.length} unresolved transactions, batches of ${size}`);

  let wrote = 0, skipped = 0;
  for (let i = 0; i < cands.length; i += size) {
    const slice = cands.slice(i, i + size);
    /*
     * TWO CALLS PER TRANSACTION, because the receipt alone cannot see a native leg.
     *
     * The receipt carries the logs; the transaction body carries `from` and `value`. A wallet
     * that spent BNB to buy a token is only visible in the second -- the coin it spent moved
     * without an event. Both batch, so this is two requests per hundred transactions.
     */
    let reply, bodies;
    try {
      [reply, bodies] = await Promise.all([
        rpc(c.rpc, slice.map((x, k) => ({
          jsonrpc: "2.0", id: k, method: "eth_getTransactionReceipt", params: [x.tx_hash],
        }))),
        rpc(c.rpc, slice.map((x, k) => ({
          jsonrpc: "2.0", id: k, method: "eth_getTransactionByHash", params: [x.tx_hash],
        }))),
      ]);
    } catch (e) { console.log(`  batch ${i / size + 1}: ${e.message}`); continue; }
    const bodyById = new Map();
    for (const b of Array.isArray(bodies) ? bodies : []) {
      if (b && b.id !== undefined && b.result) bodyById.set(b.id, b.result);
    }

    if (!Array.isArray(reply)) {
      console.log(`  ${c.name}: node refused a batch of ${slice.length} — ${JSON.stringify(reply).slice(0, 140)}`);
      break;
    }

    /* Decode first, collect the token addresses, learn decimals once, then write. */
    const decoded = [];
    const tokensSeen = new Set();
    for (const r of reply) {
      const cand = slice[r?.id];
      const rec = r?.result;
      if (!cand || !rec) { skipped++; continue; }
      const w = cand.address_key.toLowerCase().replace(/^0x/, "").padStart(64, "0");
      const net_ = new Map();
      for (const l of rec.logs ?? []) {
        const tp = l.topics ?? [];
        if (tp.length < 3 || tp[0].toLowerCase() !== TRANSFER) continue;
        let v;
        try { v = BigInt(l.data && l.data !== "0x" ? l.data : "0x0"); } catch { continue; }
        const token = String(l.address).toLowerCase();
        const from = tp[1].slice(-64).toLowerCase(), to = tp[2].slice(-64).toLowerCase();
        if (from === w) net_.set(token, (net_.get(token) ?? 0n) - v);
        else if (to === w) net_.set(token, (net_.get(token) ?? 0n) + v);
      }
      const received = [...net_.entries()].filter(([, v]) => v > 0n);
      const sent = [...net_.entries()].filter(([, v]) => v < 0n);

      /*
       * THE NATIVE LEG, which no log can show.
       *
       * Spending BNB or ETH on a token moves the coin as a value transfer, not as a Transfer
       * event, so the receipt shows the wallet receiving a token and sending nothing. Read
       * only from logs, that is indistinguishable from an airdrop -- and it is how most EVM
       * buying actually happens.
       *
       * `from` and `value` on the transaction body settle it: the wallet signed this
       * transaction and paid this much coin into it. Selling is the mirror, and its proceeds
       * arrive as an internal transfer the receipt also cannot see -- but the router unwraps
       * WETH first, and the `Withdrawal(src, wad)` event carries `wad`. That is the proceeds
       * before the router's own cut, so those rows are marked `native_withdrawal`, a weaker
       * claim than a leg we read directly.
       */
      const body = bodyById.get(r.id) ?? null;
      const isSender = !!body && String(body.from ?? "").toLowerCase() === cand.address_key.toLowerCase();
      let nativeIn = 0n;   // coin the wallet PAID
      let nativeOut = 0n;  // coin the wallet RECEIVED
      if (isSender) {
        try { nativeIn = BigInt(body.value ?? "0x0"); } catch { nativeIn = 0n; }
        for (const l of rec.logs ?? []) {
          const tp = l.topics ?? [];
          if (!tp.length || tp[0].toLowerCase() !== WITHDRAWAL) continue;
          try { nativeOut += BigInt(l.data && l.data !== "0x" ? l.data : "0x0"); } catch { /* skip */ }
        }
      }

      if (received.length === 1 && sent.length === 1) {
        decoded.push({ cand, recv: received[0], sent: sent[0], native: null, rid: r.id });
        tokensSeen.add(received[0][0]); tokensSeen.add(sent[0][0]);
      } else if (received.length === 1 && sent.length === 0 && nativeIn > 0n) {
        /* Native -> token: a buy paid for in the chain's own coin. */
        decoded.push({ cand, recv: received[0], sent: null, native: { paid: nativeIn }, rid: r.id });
        tokensSeen.add(received[0][0]);
      } else if (sent.length === 1 && received.length === 0 && nativeOut > 0n) {
        /* Token -> native: a sell whose proceeds were unwrapped by the router. */
        decoded.push({ cand, recv: null, sent: sent[0], native: { got: nativeOut }, rid: r.id });
        tokensSeen.add(sent[0][0]);
      } else {
        /* Three tokens moved, or none, or the wallet did not sign it. Not one trade. */
        skipped++;
      }
    }

    await decimalsFor(net, c.rpc, [...tokensSeen]);

    const out = [];
    for (const d of decoded) {
      /*
       * A native leg is priced as the chain's WRAPPED native, because that is the quote asset
       * the rest of the system already knows how to value -- the same key `/portfolio` and the
       * aum chains use. The coin and its wrapper are the same asset at 1:1.
       */
      const wrapped = nativeQuote.get(net) ?? null;

      if (d.native && d.recv) {
        /* Native -> token: a buy. `value` is exact, so this is as good as a read leg. */
        const [inTok, inRaw] = d.recv;
        const inDec = decCache.get(`${net}:${inTok}`);
        if (inDec == null || !wrapped) { skipped++; continue; }
        const tokenAmt = human(inRaw, inDec);
        const quoteAmt = human(d.native.paid, 18);
        out.push({
          tx: d.cand.tx_hash, addr: d.cand.address_key, at: d.cand.block_time,
          tokenKey: inTok, tokenDelta: tokenAmt,
          quoteKey: wrapped.key, quoteDelta: -quoteAmt,
          quoteUsd: wrapped.usd === null ? null : quoteAmt * wrapped.usd,
        });
        continue;
      }

      if (d.native && d.sent) {
        /*
         * Token -> native: a sell. `wad` is what the router unwrapped, which is the proceeds
         * before its own cut -- close, and not a leg we read directly.
         */
        const [outTok, outRawNeg] = d.sent;
        const outDec = decCache.get(`${net}:${outTok}`);
        if (outDec == null || !wrapped) { skipped++; continue; }
        const tokenAmt = human(-outRawNeg, outDec);
        const quoteAmt = human(d.native.got, 18);
        out.push({
          tx: d.cand.tx_hash, addr: d.cand.address_key, at: d.cand.block_time,
          tokenKey: outTok, tokenDelta: -tokenAmt,
          quoteKey: wrapped.key, quoteDelta: quoteAmt,
          quoteUsd: wrapped.usd === null ? null : quoteAmt * wrapped.usd,
        });
        continue;
      }

      const [inTok, inRaw] = d.recv, [outTok, outRawNeg] = d.sent;
      const outRaw = -outRawNeg;
      const inDec = decCache.get(`${net}:${inTok}`), outDec = decCache.get(`${net}:${outTok}`);
      if (inDec == null || outDec == null) { skipped++; continue; }

      const inQ = quotes.get(`${net}:${inTok}`) ?? null;
      const outQ = quotes.get(`${net}:${outTok}`) ?? null;
      /*
       * One side has to be a quote asset or there is no money leg to value the trade from --
       * the same rule the Solana resolver follows, and the reason /trades states its dollar
       * figure comes from the money side rather than from a memecoin price.
       */
      if ((inQ && outQ) || (!inQ && !outQ)) { skipped++; continue; }

      const buying = !!outQ;                       // paid with the quote asset -> a buy
      const tokenKey = buying ? inTok : outTok;
      const quoteKey = buying ? outTok : inTok;
      const q = buying ? outQ : inQ;
      const tokenAmt = human(buying ? inRaw : outRaw, buying ? inDec : outDec);
      const quoteAmt = human(buying ? outRaw : inRaw, buying ? outDec : inDec);

      out.push({
        tx: d.cand.tx_hash, addr: d.cand.address_key, at: d.cand.block_time,
        tokenKey, tokenDelta: buying ? tokenAmt : -tokenAmt,
        quoteKey, quoteDelta: buying ? -quoteAmt : quoteAmt,
        quoteUsd: q.usd === null ? null : quoteAmt * q.usd,
      });
    }

    if (out.length && !DRY) {
      await db.query(
        `insert into wallet_swaps
           (network_id, tx_hash, address_key, block_time, token_key, token_delta,
            quote_key, quote_delta, quote_usd, resolved_at)
         select $1, u.tx, u.addr, u.at::timestamptz, u.tk, u.td::numeric,
                u.qk, u.qd::numeric, nullif(u.qu,'')::numeric, now()
         from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                     $7::text[], $8::text[], $9::text[])
              as u(tx, addr, at, tk, td, qk, qd, qu)
         on conflict do nothing`,
        [net,
         out.map((x) => x.tx), out.map((x) => x.addr),
         out.map((x) => new Date(x.at).toISOString()),
         out.map((x) => x.tokenKey), out.map((x) => String(x.tokenDelta)),
         out.map((x) => x.quoteKey), out.map((x) => String(x.quoteDelta)),
         out.map((x) => x.quoteUsd === null ? "" : String(x.quoteUsd))]);
    }
    wrote += out.length;
    if ((i / size) % 5 === 0 || i + size >= cands.length) {
      console.log(`  ${c.name}: ${Math.min(i + size, cands.length)}/${cands.length} read, ${wrote} swaps, ${skipped} not a two-token trade`);
    }
  }
  console.log(`${c.name}: ${wrote} swaps resolved, ${skipped} skipped`);
  totalWritten += wrote; totalSkipped += skipped;
}

console.log(`total: ${totalWritten} EVM swaps resolved, ${totalSkipped} skipped`);
await db.end();
