#!/usr/bin/env node
/**
 * A7 — what each transaction cost to make.
 *
 * WHY THIS EXISTS. The consumer's version 8 report asks for fees in dollars per trade and per
 * scorecard window, and the API could only answer `includesFees: false`. No fee or gas column
 * existed anywhere, and `transactions.raw` is empty on all 1,025,559 rows, so it was not
 * recoverable from what we had already stored either.
 *
 * NO NEW PROVIDER, NO NEW KEY, NOTHING PAID. Measured before writing any of this:
 *   robinhood, bsc, base, ethereum   the public RPC in `chains.rpc`, batched
 *                                    eth_getTransactionReceipt -> gasUsed x effectiveGasPrice
 *   solana                           Helius getTransaction (HELIUS_SOLANA_KEY, already held)
 *                                    -> meta.fee, in lamports
 * Both accept JSON-RPC batches, so 52,420 EVM transactions cost about 525 requests rather
 * than 52,420.
 *
 * WHAT IS STORED IS THE MEASUREMENT, NOT A CONVERSION. `fee_native` is exact and in the
 * chain's own coin. Dollars are derived at read time from the same native price the portfolio
 * uses, so the two cannot disagree and a stored rate cannot go stale. We hold no historical
 * native price, so any USD fee is a current rate applied to a past payment -- the API says so
 * rather than freezing an approximation into a column that would look measured.
 *
 * RESUMABLE BY CONSTRUCTION. Every pass asks the database which transactions it still has no
 * fee for, so an interrupted run costs nothing and a repeat run is free.
 *
 *   node scripts/load_transaction_fees.mjs --chain=base --limit=500
 *   node scripts/load_transaction_fees.mjs --evm                 # all four EVM chains
 *   node scripts/load_transaction_fees.mjs --chain=solana --swaps-only
 *   node scripts/load_transaction_fees.mjs --evm --dry-run
 */
import pg from "pg";
import { rpc } from "./lib/chain_reads.mjs";

const DB = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
const HELIUS = (process.env.HELIUS_SOLANA_KEY ?? "").trim();
if (!DB) { console.error("DATABASE_URL is not set"); process.exit(1); }

const SOLANA = 1399811149;
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const CHAIN = opt("chain");
const EVM_ALL = flag("evm");
const DRY = flag("dry-run");
const SWAPS_ONLY = flag("swaps-only");
const LIMIT = Number(opt("limit", "0")) || 0;
/*
 * 100 is what the nodes accept and what makes the job short. base refused batches above 10 on
 * one provider during earlier work and answered HTTP 200 with a refusal in the body rather
 * than an error, so the batch size is a flag and the reader below treats a short reply as a
 * refusal instead of as missing data.
 */
const BATCH = Number(opt("batch", "100")) || 100;

const db = new pg.Client({ connectionString: DB, ssl: { rejectUnauthorized: false } });
await db.connect();

/** Chains to work, resolved to rows so the RPC url and native symbol travel together. */
const { rows: chains } = await db.query(
  `select network_id, name, native_symbol, rpc from chains
    where ($1::text is null or name = $1)
      and ($2::bool is false or network_id <> $3)
    order by name`,
  [CHAIN, EVM_ALL, SOLANA],
);
if (!chains.length) { console.error("no chain matched"); process.exit(1); }

/**
 * The transactions we still have no fee for.
 *
 * Union of both places a transaction hash can appear. `wallet_swaps` is the one that matters
 * for a per-trade fee; `transactions` is what a per-window total is summed over. The anti-join
 * against transaction_fees is what makes a repeat run free.
 */
async function pending(net, limit) {
  const swapsOnly = SWAPS_ONLY;
  const { rows } = await db.query(
    `select tx_hash from (
        select tx_hash from wallet_swaps where network_id = $1
        union
        select tx_hash from transactions where network_id = $1 and $2::bool is false
     ) t
     where not exists (
       select 1 from transaction_fees f where f.network_id = $1 and f.tx_hash = t.tx_hash)
     ${limit ? "limit " + Number(limit) : ""}`,
    [net, swapsOnly],
  );
  return rows.map((r) => r.tx_hash);
}

/** gasUsed x effectiveGasPrice, exact in wei, then scaled to the native coin. */
function evmFee(receipt) {
  const g = receipt?.gasUsed, p = receipt?.effectiveGasPrice;
  if (typeof g !== "string" || typeof p !== "string") return null;
  try {
    const wei = BigInt(g) * BigInt(p);
    // 18 decimals, as a decimal string so nothing rounds through a float.
    const s = wei.toString().padStart(19, "0");
    const whole = s.slice(0, s.length - 18);
    const frac = s.slice(s.length - 18).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole;
  } catch { return null; }
}

async function writeFees(net, rowsToWrite) {
  if (!rowsToWrite.length || DRY) return 0;
  const hashes = rowsToWrite.map((r) => r.hash);
  const fees = rowsToWrite.map((r) => r.fee);
  const syms = rowsToWrite.map((r) => r.symbol);
  const srcs = rowsToWrite.map((r) => r.source);
  await db.query(
    `insert into transaction_fees (network_id, tx_hash, fee_native, fee_native_symbol, source)
     select $1, h, f::numeric, s, src
     from unnest($2::text[], $3::text[], $4::text[], $5::text[]) as u(h, f, s, src)
     on conflict (network_id, tx_hash) do nothing`,
    [net, hashes, fees, syms, srcs],
  );
  return rowsToWrite.length;
}

for (const c of chains) {
  const net = Number(c.network_id);
  const isSolana = net === SOLANA;
  if (isSolana && !HELIUS) { console.log(`${c.name}: skipped, HELIUS_SOLANA_KEY is not set`); continue; }

  const todo = await pending(net, LIMIT);
  if (!todo.length) { console.log(`${c.name}: nothing pending`); continue; }
  const url = isSolana ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS}` : c.rpc;
  console.log(`${c.name}: ${todo.length} transactions pending, batches of ${BATCH}`);

  let done = 0, missing = 0, wrote = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    const body = slice.map((h, k) => isSolana
      ? { jsonrpc: "2.0", id: k, method: "getTransaction",
          params: [h, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }] }
      : { jsonrpc: "2.0", id: k, method: "eth_getTransactionReceipt", params: [h] });

    let reply;
    try { reply = await rpc(url, body); }
    catch (e) { console.log(`  ${c.name} batch ${i / BATCH + 1}: ${e.message}`); continue; }

    /*
     * A reply that is not an array of the length we sent is a REFUSAL, not an empty answer.
     * base once returned HTTP 200 carrying "maximum 10 calls in 1 batch", and reading that as
     * "these transactions have no fee" would have written a silent hole across a whole chain.
     */
    if (!Array.isArray(reply)) {
      console.log(`  ${c.name}: node refused a batch of ${slice.length} — ${JSON.stringify(reply).slice(0, 160)}`);
      console.log(`  retry with --batch=10`);
      break;
    }

    const out = [];
    for (const r of reply) {
      const h = slice[r?.id];
      if (!h) continue;                       // an id we never sent; never trusted
      const res = r?.result;
      if (!res) { missing++; continue; }      // dropped from the ledger, or not yet indexed
      if (isSolana) {
        const lamports = res?.meta?.fee;
        if (typeof lamports !== "number") { missing++; continue; }
        // Lamports are integers; 9 decimals, kept as a string so nothing rounds.
        const s = String(lamports).padStart(10, "0");
        const frac = s.slice(s.length - 9).replace(/0+$/, "");
        out.push({
          hash: h, symbol: c.native_symbol, source: "helius getTransaction",
          fee: frac ? `${s.slice(0, s.length - 9)}.${frac}` : s.slice(0, s.length - 9),
        });
      } else {
        const fee = evmFee(res);
        if (fee === null) { missing++; continue; }
        out.push({ hash: h, fee, symbol: c.native_symbol, source: "eth_getTransactionReceipt" });
      }
    }
    wrote += await writeFees(net, out);
    done += slice.length;
    if ((i / BATCH) % 10 === 0 || i + BATCH >= todo.length) {
      console.log(`  ${c.name}: ${done}/${todo.length} read, ${wrote} written, ${missing} without a fee`);
    }
  }
  console.log(`${c.name}: done — ${wrote} fees written, ${missing} transactions carried none`);
}

await db.end();
