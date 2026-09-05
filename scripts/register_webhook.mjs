/**
 * Point the Helius webhook at our receiver, with the current wallet list.
 *
 * Run after any change to `wallets` — a trader entering or leaving the top 100 changes who
 * should be watched, and Helius only delivers for addresses explicitly registered. Left
 * unrun, a new trader is silently invisible to the live feed while every other route shows
 * them, which is the sort of gap nobody notices for weeks.
 *
 * Idempotent: it updates the single existing webhook rather than creating another. Two
 * webhooks on the same addresses means every event delivered twice — harmless given the
 * upsert, but it doubles the traffic and confuses the logs.
 *
 *   node scripts/register_webhook.mjs                 # sync addresses
 *   node scripts/register_webhook.mjs --list          # show what is registered
 */
import { Pool } from "pg";

const KEY = (process.env.HELIUS_SOLANA_KEY ?? process.env.HELIUS_KEY ?? "").trim();
const SECRET = (process.env.HELIUS_WEBHOOK_SECRET ?? "").trim();
const TARGET = process.env.WEBHOOK_URL ??
  "https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/helius-webhook";
// Cloudflare fronts the Helius API and 403s a bare client with `error code: 1010`. The
// same trap the directory builder documents on its RPC probe.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

if (!KEY) { console.error("HELIUS_SOLANA_KEY is not set"); process.exit(1); }

const api = async (path, init = {}) => {
  const r = await fetch(`https://api.helius.xyz/v0/webhooks${path}${path.includes("?") ? "&" : "?"}api-key=${KEY}`, {
    ...init,
    headers: { "Content-Type": "application/json", "User-Agent": UA, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(45_000),
  });
  if (!r.ok) throw new Error(`helius ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

const existing = await api("");
if (process.argv.includes("--list")) {
  for (const w of existing) {
    console.log(`${w.webhookID}  ${w.accountAddresses.length} addresses  -> ${w.webhookURL}`);
  }
  process.exit(0);
}

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
const pool = new Pool({ connectionString: url, max: 2, ssl: { rejectUnauthorized: false } });
const { rows } = await pool.query(
  "select sol_address from wallets where sol_address is not null order by handle");
const addresses = rows.map((r) => r.sol_address);
await pool.end();

const body = {
  webhookURL: TARGET,
  transactionTypes: ["Any"],
  accountAddresses: addresses,
  webhookType: "enhanced",
  // Without this the receiver cannot tell a Helius delivery from anyone who learned the
  // URL, and the ledger we use to check fomo's claims becomes writable by strangers.
  ...(SECRET ? { authHeader: SECRET } : {}),
};
if (!SECRET) console.warn("! HELIUS_WEBHOOK_SECRET is not set — the endpoint will accept unsigned posts");

const mine = existing.find((w) => w.webhookURL === TARGET) ?? existing[0];
const saved = mine
  ? await api(`/${mine.webhookID}`, { method: "PUT", body: JSON.stringify(body) })
  : await api("", { method: "POST", body: JSON.stringify(body) });

console.log(`${mine ? "updated" : "created"} webhook ${saved.webhookID}`);
console.log(`  -> ${saved.webhookURL}`);
console.log(`  watching ${saved.accountAddresses.length} solana wallets`);
console.log(`  auth header: ${SECRET ? "set" : "NOT SET"}`);
