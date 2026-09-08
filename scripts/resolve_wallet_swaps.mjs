#!/usr/bin/env node
/**
 * T2.2 · Resolve which stored SWAP rows are the trader's OWN swap, and both of its sides.
 *
 * `transactions.tx_type` is the transaction's type, not the wallet's action in it. Measured on
 * 60 random stored rows tagged SWAP, the wallet was not even among the transaction's
 * accountKeys in 57 of them — somebody else swapped and sent tokens to the wallet's token
 * account. Only 3 of 60 were a genuine two-sided swap by the wallet.
 *
 * Helius RPC `getTransaction` gives the NET balance change per (owner, mint) through
 * pre/postTokenBalances, plus native SOL through pre/postBalances. That is immune to how a
 * router shuffled funds internally, which is why it works where the Enhanced Transactions
 * parser did not — its swap event was empty on 88 of 100 sampled and named a different wallet
 * on the rest.
 *
 * Uses the Helius key we already hold. No new provider, no paid endpoint.
 *
 *   node scripts/resolve_wallet_swaps.mjs                 # everything unresolved
 *   node scripts/resolve_wallet_swaps.mjs --limit 500     # smoke test
 *   node scripts/resolve_wallet_swaps.mjs --fanout 16
 */
import pg from "pg";

const DB = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
const KEY = (process.env.HELIUS_SOLANA_KEY ?? "").trim();
if (!DB) { console.error("DATABASE_URL is not set"); process.exit(1); }
if (!KEY) { console.error("HELIUS_SOLANA_KEY is not set"); process.exit(1); }

const SOLANA = 1399811149;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
/** Native SOL, under the same key `quote_assets` uses, so it prices like any other quote. */
const SOL_MINT = "11111111111111111111111111111111";

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const LIMIT = Number(arg("limit", "0")) || null;
/** 16 measured at 49 req/s with zero errors. Higher risks 429s for no real gain. */
const FANOUT = Number(arg("fanout", "16"));

const pool = new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 4 });

async function getTx(sig) {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "getTransaction",
    params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
  });
  const r = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
    signal: AbortSignal.timeout(45_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(String(j.error?.message ?? "rpc error").slice(0, 60));
  return j.result ?? null;
}

/**
 * The wallet's net position change in one transaction.
 *
 * Returns every mint whose balance moved, plus native SOL when the wallet is an account of the
 * transaction. Dust below 1e-12 is discarded: a rounding artifact is not a leg.
 */
function deltas(tx, owner) {
  const m = tx.meta;
  const pre = new Map(), post = new Map();
  for (const b of m.preTokenBalances ?? []) {
    if (b.owner === owner) pre.set(b.mint, Number(b.uiTokenAmount?.uiAmount ?? 0));
  }
  for (const b of m.postTokenBalances ?? []) {
    if (b.owner === owner) post.set(b.mint, Number(b.uiTokenAmount?.uiAmount ?? 0));
  }
  const out = new Map();
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const d = (post.get(mint) ?? 0) - (pre.get(mint) ?? 0);
    if (Math.abs(d) > 1e-12) out.set(mint, d);
  }
  const keys = (tx.transaction?.message?.accountKeys ?? [])
    .map((k) => (typeof k === "string" ? k : k.pubkey));
  const i = keys.indexOf(owner);
  if (i >= 0) {
    // Fees are paid by whoever submitted, and for these traders that is a relayer — so a
    // native change here is real movement, not gas. Still filtered at 1e-7 so a lamport of
    // rent does not masquerade as a swap leg.
    const d = ((m.postBalances?.[i] ?? 0) - (m.preBalances?.[i] ?? 0)) / 1e9;
    if (Math.abs(d) > 1e-7) out.set(SOL_MINT, (out.get(SOL_MINT) ?? 0) + d);
  }
  return out;
}

async function main() {
  const c = await pool.connect();
  try {
    const { rows: quotes } = await c.query(
      `select token_key, pegged_usd from quote_assets where network_id = $1`, [SOLANA],
    );
    const quoteSet = new Map(quotes.map((q) => [q.token_key, q.pegged_usd]));

    const { rows: work } = await c.query(
      `select t.tx_hash, w.sol_address as owner, lower(w.sol_address) as address_key,
              min(t.block_time) as block_time
         from transactions t
         join wallets w on lower(w.sol_address) = t.address_key
         left join wallet_swaps s
           on s.network_id = t.network_id and s.tx_hash = t.tx_hash
          and s.address_key = t.address_key
        where t.network_id = $1 and t.tx_type = 'SWAP' and s.tx_hash is null
        group by t.tx_hash, w.sol_address
        order by min(t.block_time) desc
        ${LIMIT ? `limit ${LIMIT}` : ""}`,
      [SOLANA],
    );
    if (!work.length) { console.log("nothing to resolve"); return; }
    console.log(`resolving ${work.length} swap event(s) · fanout ${FANOUT} · ~${Math.ceil(work.length / 49 / 60)} min`);

    let done = 0, twoSided = 0, oneSided = 0, failed = 0, stored = 0;
    const batch = [];

    const flush = async () => {
      if (!batch.length) return;
      const vals = [], params = [];
      batch.forEach((r, i) => {
        const b = i * 8;
        vals.push(`($${b+1},$${b+2},$${b+3},$${b+4}::timestamptz,$${b+5},$${b+6},$${b+7},$${b+8})`);
        params.push(SOLANA, r.tx_hash, r.address_key, r.block_time,
                    r.token_key, r.token_delta, r.quote_key, r.quote_delta);
      });
      await c.query(
        `insert into wallet_swaps
           (network_id, tx_hash, address_key, block_time, token_key, token_delta, quote_key, quote_delta)
         values ${vals.join(",")}
         on conflict (network_id, tx_hash, address_key) do nothing`, params,
      );
      stored += batch.length;
      batch.length = 0;
    };

    for (let i = 0; i < work.length; i += FANOUT) {
      const slice = work.slice(i, i + FANOUT);
      const got = await Promise.all(slice.map(async (r) => {
        try { return { r, tx: await getTx(r.tx_hash) }; }
        catch { return { r, tx: null, err: true }; }
      }));

      for (const { r, tx, err } of got) {
        done++;
        if (err || !tx) { failed++; continue; }
        const d = deltas(tx, r.owner);
        if (d.size < 2) { oneSided++; continue; }

        /**
         * Split the legs into the quote side and the token side. A swap between two quote
         * assets, or between two non-quote tokens, is skipped: neither shape gives a
         * dollar-denominated entry or exit, and guessing which side was "the trade" would be
         * inventing an answer.
         */
        // `quote_assets.token_key` and `tokens.token_key` are lower(address) throughout this
        // schema, but a Solana mint from RPC is case-sensitive base58. Comparing the two
        // directly matches nothing — which is exactly what the first run did, reporting 0 of
        // 400 when a random sample had already shown 5%.
        const qs = [...d].filter(([m]) => quoteSet.has(m.toLowerCase()));
        const ts = [...d].filter(([m]) => !quoteSet.has(m.toLowerCase()));
        if (qs.length !== 1 || ts.length !== 1) { oneSided++; continue; }
        const [quoteKey, quoteDelta] = qs[0];
        const [tokenKey, tokenDelta] = ts[0];
        // Both sides must move in OPPOSITE directions to be a trade. Same-sign is a deposit
        // or an airdrop that happened to touch two mints.
        if (Math.sign(quoteDelta) === Math.sign(tokenDelta)) { oneSided++; continue; }

        twoSided++;
        batch.push({
          tx_hash: r.tx_hash, address_key: r.address_key,
          block_time: r.block_time ? new Date(r.block_time).toISOString() : null,
          // Stored lowercased, matching `tokens.token_key` so these join to the rest of the
          // schema without a case dance at every call site.
          token_key: tokenKey.toLowerCase(), token_delta: tokenDelta,
          quote_key: quoteKey.toLowerCase(), quote_delta: quoteDelta,
        });
        if (batch.length >= 200) await flush();
      }
      if (done % 2000 < FANOUT) {
        console.log(`  ${done}/${work.length} · ${twoSided} swaps · ${oneSided} not the wallet's · ${failed} failed`);
      }
    }
    await flush();

    /**
     * Value the quote side. Pegged assets are their own amount; floating ones use the daily
     * close already loaded by T2.1. NULL where neither applies — never 0.
     */
    const { rowCount: priced } = await c.query(
      `update wallet_swaps s
          set quote_usd = s.quote_delta * coalesce(q.pegged_usd, p.usd)
         from quote_assets q
         left join token_prices p
           on p.network_id = q.network_id and p.token_key = q.token_key
        where q.network_id = s.network_id and q.token_key = s.quote_key
          and (q.pegged_usd is not null or p.day = s.block_time::date)
          and s.quote_usd is null`,
    );

    console.log(
      `\ndone · ${twoSided} of ${done} were the wallet's own swap (${(100*twoSided/Math.max(done,1)).toFixed(1)}%)` +
      `\n       ${stored} stored · ${priced} valued in USD · ${failed} rpc failures`,
    );
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
