#!/usr/bin/env node
/**
 * Launch metadata for Solana tokens (docs/LAUNCH_METADATA.md; workflow gap 3).
 *
 * One `getAccountInfo` on the pump.fun bonding-curve PDA says whether a mint launched there,
 * how far along the curve it is and whether it graduated; the curve's oldest signature is the
 * creation time. A token with no curve account is read once and left null. A graduated token
 * is never re-read; an ungraduated one is re-read every night until it graduates.
 *
 *   node scripts/load_token_launch.mjs                      # held or recently traded, unread or ungraduated
 *   node scripts/load_token_launch.mjs --limit 50 --dry-run
 *   node scripts/load_token_launch.mjs --dry-run --token <mint>[,<mint>]   # no database at all
 */
import pg from "pg";
import { rpc, SOLANA_NETWORK_ID } from "./lib/chain_reads.mjs";
import { bondingCurveAddress, decodeCurve } from "./lib/pumpfun.mjs";

const arg  = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const DRY    = flag("dry-run");
const LIMIT  = Number(arg("limit", "0")) || null;
const TOKENS = arg("token")?.split(",").map((a) => a.trim()).filter(Boolean) ?? null;

const DB = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
if (!DB && !(DRY && TOKENS)) { console.error("DATABASE_URL is not set (or pass --dry-run --token <mint>)"); process.exit(1); }
const HELIUS = (process.env.HELIUS_SOLANA_KEY ?? process.env.HELIUS_KEY ?? "").trim();
const RPC = HELIUS ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS}` : "https://api.mainnet-beta.solana.com";
// ponytail: 20 pages = 20,000 signatures, the deepest curve history measured (31 s public).
// Past it created_at stays null; raise, or move to a Helius-indexed read, if that shows up often.
const MAX_SIG_PAGES = 20;

async function readCurve(mint) {
  const curve = bondingCurveAddress(mint);
  const j = await rpc(RPC, { jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [curve, { encoding: "base64" }] });
  if (j.error) throw new Error(String(j.error.message ?? "rpc error").slice(0, 80));
  const b64 = j.result?.value?.data?.[0];
  const decoded = b64 ? decodeCurve(Buffer.from(b64, "base64")) : null;
  return decoded ? { curve, ...decoded } : null;
}

/** Block time of the oldest signature on the account, or null past MAX_SIG_PAGES. */
async function createdAt(account) {
  let before, oldest = null;
  for (let page = 0; page < MAX_SIG_PAGES; page++) {
    const j = await rpc(RPC, { jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [account, { limit: 1000, before }] });
    const sigs = j.result ?? [];
    if (!sigs.length) break;
    oldest = sigs[sigs.length - 1];
    before = oldest.signature;
    if (sigs.length < 1000) return oldest.blockTime ? new Date(oldest.blockTime * 1000) : null;
  }
  return null;
}

async function targets(c) {
  if (TOKENS) return TOKENS.map((a) => ({ address: a, token_key: a.toLowerCase(), created_at: null }));
  const { rows } = await c.query(
    `select tk.address, tk.token_key, tk.created_at
       from tokens tk
      where tk.network_id = $1
        and (tk.launch_read_at is null or tk.graduated = false)
        and (exists (select 1 from holdings_current h where h.network_id = tk.network_id and h.token_key = tk.token_key)
          or exists (select 1 from transactions t where t.network_id = tk.network_id and t.token_key = tk.token_key
                        and t.block_time > now() - interval '30 days'))
      order by tk.launch_read_at nulls first, tk.address
      ${LIMIT ? "limit $2" : ""}`,
    LIMIT ? [SOLANA_NETWORK_ID, LIMIT] : [SOLANA_NETWORK_ID],
  );
  return rows;
}

async function main() {
  const pool = DB ? new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 2 }) : null;
  const c = pool ? await pool.connect() : null;
  try {
    const list = await targets(c);
    console.log(`solana tokens to read: ${list.length}${DRY ? " (dry run)" : ""}`);
    let pump = 0, failed = 0;
    for (const t of list) {
      let launch;
      try {
        launch = await readCurve(t.address);
      } catch (e) {
        failed++;
        console.log(`  ${t.address}  read failed: ${e.message}`);
        continue;
      }
      if (!launch) {
        console.log(`  ${t.address}  no bonding curve`);
      } else {
        pump++;
        // Creation is immutable: read it once, the first time the curve is seen.
        const created = t.created_at ?? await createdAt(launch.curve);
        launch.created_at = created;
        console.log(`  ${t.address}  pump.fun  progress ${launch.progress}  graduated ${launch.graduated}  created ${created?.toISOString() ?? "unknown"}`);
      }
      if (DRY) continue;
      await c.query(
        `update tokens
            set launchpad = $3, curve_progress = $4, graduated = $5,
                created_at = coalesce(created_at, $6), launch_read_at = now()
          where network_id = $1 and token_key = $2`,
        [SOLANA_NETWORK_ID, t.token_key, launch ? "pump.fun" : null, launch?.progress ?? null, launch?.graduated ?? null, launch?.created_at ?? null],
      );
    }
    console.log(`\n${DRY ? "would write" : "wrote"} ${list.length - failed} of ${list.length} · ${pump} pump.fun · ${failed} failed`);
  } finally {
    c?.release();
    await pool?.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
