/**
 * Backfill the `transactions` table from the chains.
 *
 * Written in Node rather than Python so it reuses `dist/transactions.js` — the same
 * five-provider fetch the API already uses (Helius for Solana, Blockscout for Robinhood
 * and Ethereum, Etherscan for Ethereum, Bitquery for BSC and Base). Reimplementing that
 * in a second language would mean two things to keep correct.
 *
 * Measured: 5 wallets -> 1,800 rows in 12.2s, every chain returning data. So a full pass
 * over 97 wallets is ~1 minute at fanout 4, not the hours my first estimate implied — the
 * Helius enhanced endpoint returns 100 parsed transactions per call, not one.
 *
 *   node scripts/backfill_transactions.mjs                 # all wallets, 5 pages
 *   node scripts/backfill_transactions.mjs --pages 2       # shallower, faster
 *   node scripts/backfill_transactions.mjs --limit 5       # smoke test
 *   node scripts/backfill_transactions.mjs --only unipcs
 */
import { fetchTransactions } from "../dist/transactions.js";
import { EVM_CHAINS, SOLANA_NETWORK_ID } from "../dist/settings.js";
import { Pool } from "pg";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PAGES = Number(arg("pages", 5));
const LIMIT = arg("limit", null);
const ONLY = arg("only", null);
const FANOUT = Number(arg("fanout", 4));

const NETWORK_OF = { solana: SOLANA_NETWORK_ID };
for (const [id, cfg] of Object.entries(EVM_CHAINS)) NETWORK_OF[cfg.name] = Number(id);

/**
 * Prefer the TRANSACTION pooler (6543) over the session pooler (5432).
 *
 * Session mode holds one Postgres connection per client for the life of the connection and
 * caps at 15. This script opening 4 alongside horizontally-scaled Edge Functions exhausted
 * that pool mid-run — the workflow died with EMAXCONNSESSION and the live API 500'd with it.
 * Transaction mode multiplexes, and every query here is a single statement per checkout,
 * which is exactly the shape it suits.
 */
const url = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
if (!url) { console.error("SUPABASE_DB_URL is not set"); process.exit(1); }
const pool = new Pool({ connectionString: url, max: 4, ssl: { rejectUnauthorized: false } });

/** Run `work` over `items` at most `n` at a time. */
async function pool_(items, n, work) {
  const out = [];
  for (let i = 0; i < items.length; i += n) {
    out.push(...(await Promise.all(items.slice(i, i + n).map(work))));
  }
  return out;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function main() {
  let sql = `select w.handle, w.evm_address, w.sol_address
             from wallets w join trader_stats_current s using (handle)
             where (w.evm_address is not null or w.sol_address is not null)`;
  const params = [];
  if (ONLY) { params.push(ONLY.toLowerCase()); sql += ` and w.handle = $${params.length}`; }
  sql += ` order by s.rank nulls last`;
  if (LIMIT) sql += ` limit ${Number(LIMIT)}`;
  const { rows: wallets } = await pool.query(sql, params);

  console.log(`backfilling ${wallets.length} wallets · pages=${PAGES} · fanout=${FANOUT}`);
  const t0 = Date.now();
  let done = 0, written = 0, failed = 0;
  const perChain = {};

  await pool_(wallets, FANOUT, async (w) => {
    let out;
    try {
      out = await fetchTransactions(w.evm_address, w.sol_address, null, 200, { pages: PAGES });
    } catch (e) {
      failed++; done++;
      console.log(`  [${done}/${wallets.length}] ${w.handle} FAILED: ${String(e.message).slice(0, 60)}`);
      return;
    }
    for (const c of out.chains) {
      if (!c.error) perChain[c.chain] = (perChain[c.chain] ?? 0) + c.count;
    }

    // The wallet the row was fetched FOR. A transfer belongs to whichever of the two
    // addresses could have produced it, so solana rows key on the solana wallet.
    const rows = [];
    for (const t of out.transfers) {
      const net = NETWORK_OF[t.chain];
      if (net === undefined || !t.tx_hash) continue;
      const addr = (net === SOLANA_NETWORK_ID ? w.sol_address : w.evm_address);
      if (!addr) continue;
      // `side` is relative to the wallet we asked about, so the counterparty is the
      // other end of that leg — not simply `to`.
      const counterparty = t.side === "in" ? t.from : t.to;
      rows.push([
        net, t.tx_hash, addr.toLowerCase(),
        t.time_iso ?? (t.time ? new Date(t.time * 1000).toISOString() : null),
        t.side ?? null,
        counterparty ? String(counterparty).toLowerCase() : null,
        t.contract ? String(t.contract).toLowerCase() : null,
        t.token ?? null,
        num(t.amount),
        // `source` means WHO TOLD US — the provider. It previously stored `t.source`,
        // which for Solana is Helius's PROTOCOL attribution (JUPITER, PUMP_AMM), so the
        // column ended up conflating provenance with protocol and neither was queryable.
        c_source(t.chain),
        t.type ?? null,      // SWAP / TRANSFER / ... — a swap is a trade, a transfer often is not
        t.source ?? null,    // the protocol, where the provider attributes one
      ]);
    }
    // Postgres refuses an ON CONFLICT statement that touches the same row twice, so two
    // byte-identical transfers inside one transaction (same token, direction, counterparty
    // and amount) must be collapsed BEFORE the insert, not by the conflict clause. Keyed on
    // exactly the fields the SQL digest uses, so the two agree by construction.
    const seen = new Set();
    const deduped = rows.filter((r) => {
      const k = `${r[0]}|${r[1]}|${r[2]}|${r[6] ?? ""}|${r[4] ?? ""}|${r[5] ?? ""}|${r[8] ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    rows.length = 0;
    rows.push(...deduped);

    if (rows.length) {
      const client = await pool.connect();
      try {
        // One multi-row insert per wallet. `transfer_key` is generated in SQL so it stays
        // identical to the migration's definition — computing it in two places is how the
        // two quietly drift apart.
        const values = rows.map((_, i) => {
          const b = i * 12;
          return `($${b+1},$${b+2},$${b+3},md5(coalesce($${b+7},'')||'|'||coalesce($${b+5},'')||'|'||coalesce($${b+6},'')||'|'||coalesce($${b+9}::text,'')),$${b+4}::timestamptz,$${b+5},$${b+6},$${b+7},$${b+8},$${b+9}::numeric,$${b+10},$${b+11},$${b+12})`;
        }).join(",");
        await client.query(
          `insert into transactions
             (network_id, tx_hash, address_key, transfer_key, block_time, direction,
              counterparty, token_key, token_symbol, amount, source, tx_type, tx_source)
           values ${values}
           on conflict (network_id, tx_hash, address_key, transfer_key) do update set
             block_time = excluded.block_time, token_symbol = excluded.token_symbol,
             amount = excluded.amount, source = excluded.source,
             tx_type = coalesce(excluded.tx_type, transactions.tx_type),
             tx_source = coalesce(excluded.tx_source, transactions.tx_source),
             ingested_at = now()`,
          rows.flat(),
        );
        written += rows.length;
      } finally { client.release(); }
    }
    done++;
    if (done % 10 === 0 || done === wallets.length) {
      console.log(`  [${done}/${wallets.length}] ${written.toLocaleString()} rows written`);
    }
  });

  const { rows: [tot] } = await pool.query("select count(*)::int n from transactions");
  const el = (Date.now() - t0) / 1000;
  console.log(`\ndone in ${el.toFixed(0)}s · ${written.toLocaleString()} rows written · ${failed} wallets failed`);
  console.log(`per chain: ${JSON.stringify(perChain)}`);
  console.log(`transactions table now holds ${tot.n.toLocaleString()} rows`);
  await pool.end();
}

const c_source = (chain) =>
  chain === "solana" ? "helius" : chain === "bsc" || chain === "base" ? "bitquery" : "blockscout";

main().catch((e) => { console.error(e); process.exit(1); });
