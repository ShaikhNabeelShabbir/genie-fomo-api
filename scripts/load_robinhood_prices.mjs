#!/usr/bin/env node
/**
 * R4 · Price the Robinhood-chain coins GMGN does not, into `token_prices`.
 *
 * Source is DexScreener's keyless token endpoint (docs/R4_ROBINHOOD_PRICES.md): it sees
 * every Uniswap v2/v3/v4 pool on chain 4663, 30 tokens per call. Only tokens a leader holds
 * today and that token_info carries no price for are asked; a quote asset is never asked.
 * One row per (token, UTC day), so the balances loader and the AUM sampler both pick it up
 * as `token_prices_daily` -- no new price_source word.
 *
 *   node scripts/load_robinhood_prices.mjs                       # every unpriced held token
 *   node scripts/load_robinhood_prices.mjs --limit 50 --dry-run  # first 50, print only
 *   node scripts/load_robinhood_prices.mjs --dry-run --token 0x…[,0x…]   # no database at all
 */
import pg from "pg";
import { ADDRESSES_PER_CALL, bestPairs, fetchPairs } from "./lib/dexscreener.mjs";

const NETWORK_ID = 4663;
const CHAIN = "robinhood";
const SOURCE = "dexscreener";

const arg  = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const DRY   = flag("dry-run");
const LIMIT = Number(arg("limit", "0")) || null;
const TOKENS = arg("token")?.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean) ?? null;

const DB = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
if (!DB && !(DRY && TOKENS)) { console.error("DATABASE_URL is not set (or pass --dry-run --token 0x…)"); process.exit(1); }

async function targets(c) {
  if (TOKENS) return TOKENS.map((a) => ({ token_key: a, address: a }));
  const { rows } = await c.query(
    `select distinct h.token_key, tk.address
       from holdings_current h
       join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
       left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
       left join token_info ti on ti.network_id = h.network_id and ti.token_key = h.token_key
      where h.network_id = $1 and q.token_key is null and ti.price_usd is null
      order by h.token_key
      ${LIMIT ? "limit $2" : ""}`,
    LIMIT ? [NETWORK_ID, LIMIT] : [NETWORK_ID],
  );
  return rows;
}

async function main() {
  const pool = DB ? new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 2 }) : null;
  const c = pool ? await pool.connect() : null;
  try {
    const list = await targets(c);
    console.log(`robinhood tokens to price: ${list.length}${DRY ? " (dry run)" : ""}`);
    const day = new Date().toISOString().slice(0, 10);
    let priced = 0;
    for (let i = 0; i < list.length; i += ADDRESSES_PER_CALL) {
      const chunk = list.slice(i, i + ADDRESSES_PER_CALL);
      const best = bestPairs(await fetchPairs(CHAIN, chunk.map((t) => t.address)));
      for (const t of chunk) {
        const b = best.get(t.address.toLowerCase());
        if (!b) { console.log(`  ${t.address}  no pool`); continue; }
        console.log(`  ${t.address}  ${b.usd} USD  liq $${Math.round(b.liquidity)}  ${b.dex}`);
        priced++;
        if (DRY) continue;
        await c.query(
          `insert into token_prices (network_id, token_key, day, usd, source)
           values ($1, $2, $3, $4, $5)
           on conflict (network_id, token_key, day)
           do update set usd = excluded.usd, source = excluded.source, fetched_at = now()`,
          [NETWORK_ID, t.token_key, day, b.usd, `${SOURCE}:${b.dex}`],
        );
      }
    }
    console.log(`\n${DRY ? "would write" : "wrote"} ${priced} of ${list.length} prices for ${day}`);
  } finally {
    c?.release();
    await pool?.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
