/**
 * Give a chain to tokens that were traded but are no longer held.
 *
 * `trades.network_id` is filled by matching the traded token against `tokens`, which only
 * holds what someone CURRENTLY holds. A trader who sold out entirely leaves a trade whose
 * token matches nothing — 913 tokens across 1,244 trades. That single gap blocks two things
 * at once: the market-cap form of average entry (no chain -> no supply lookup), and
 * per-chain profitability (39% of realized P&L sitting in an "unmatched" bucket worth
 * -$2.46M, which is far too large to publish a chain breakdown around).
 *
 * Resolution is free and needs no key:
 *   base58 shape        -> Solana. The shape IS the answer.
 *   0x… shape           -> probe eth_getCode on each EVM chain; a contract exists on the
 *                          chain that returns bytecode. Same technique the directory
 *                          builder already uses.
 *
 * An address that answers on more than one EVM chain is left UNRESOLVED rather than
 * guessed: the same address really can be deployed twice, and picking one would quietly
 * attribute P&L to the wrong chain.
 */
import { EVM_CHAINS, SOLANA_NETWORK_ID } from "../dist/settings.js";
import { Pool } from "pg";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i+1] : d; };
const LIMIT = arg("limit", null);
const FANOUT = Number(arg("fanout", 6));
const EVM_IDS = Object.keys(EVM_CHAINS).map(Number);

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

const isEvm = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
const isSol = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

async function batches(items, n, work) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i+n).map(work)));
  return out;
}

async function hasCode(networkId, address) {
  const cfg = EVM_CHAINS[networkId];
  if (!cfg) return false;
  try {
    const r = await fetch(cfg.rpc, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json();
    return typeof j?.result === "string" && j.result.length > 4;
  } catch { return false; }
}

async function main() {
  let sql = `select distinct token_address, token_key from trades
             where network_id is null and token_address is not null`;
  if (LIMIT) sql += ` limit ${Number(LIMIT)}`;
  const { rows } = await pool.query(sql);
  console.log(`resolving a chain for ${rows.length} tokens (fanout ${FANOUT})`);

  let sol = 0, evm = 0, ambiguous = 0, unknown = 0, done = 0;
  const resolved = [];

  await batches(rows, FANOUT, async (t) => {
    const a = t.token_address;
    let net = null;
    if (isSol(a)) { net = SOLANA_NETWORK_ID; sol++; }
    else if (isEvm(a)) {
      const hits = [];
      for (const id of EVM_IDS) if (await hasCode(id, a)) hits.push(id);
      if (hits.length === 1) { net = hits[0]; evm++; }
      else if (hits.length > 1) ambiguous++;   // deployed on several chains — do not guess
      else unknown++;
    } else unknown++;
    done++;
    if (net !== null) resolved.push([net, a, t.token_key]);
    if (done % 100 === 0) console.log(`  [${done}/${rows.length}] sol ${sol} · evm ${evm} · ambiguous ${ambiguous} · unknown ${unknown}`);
  });

  const c = await pool.connect();
  try {
    for (const [net, addr, key] of resolved) {
      // The token may be new to us entirely; create it before pointing trades at it.
      await c.query(
        `insert into tokens (network_id, address) values ($1,$2)
         on conflict (network_id, token_key) do nothing`, [net, addr]);
      await c.query(
        `update trades set network_id = $1 where token_key = $2 and network_id is null`,
        [net, key]);
    }
  } finally { c.release(); }

  const { rows: [after] } = await pool.query(
    `select count(*) filter (where network_id is null)::int as still_null,
            count(*)::int as total from trades`);
  console.log(`\nresolved ${resolved.length} (solana ${sol}, evm ${evm}) · ambiguous ${ambiguous} · unknown ${unknown}`);
  console.log(`trades without a chain: ${after.still_null} of ${after.total}`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
