#!/usr/bin/env node
/**
 * Gap 1 · Hourly DexScreener price per held token, on every chain, with a rolling ATH.
 *
 * Every token in holdings_current with a positive balance is asked (natives excluded: their
 * price comes from shared/prices.ts). 30 addresses a call under the shared per-host
 * throttle (docs/R4_ROBINHOOD_PRICES.md). The current UTC hour lands in token_price_hourly;
 * token_price_stats gets the running ATH and drawdown (athUpdate in lib/dexscreener.mjs).
 * The daily Robinhood row in token_prices is still load_robinhood_prices.mjs's job.
 *
 *   node scripts/load_token_prices.mjs                         # every held token
 *   node scripts/load_token_prices.mjs --limit 50 --dry-run    # first 50, print only
 *   node scripts/load_token_prices.mjs --dry-run --token <mint>,base:0x…   # no database
 *
 * `--token` entries take an optional `<chain>:` prefix (solana, ethereum, bsc, base,
 * robinhood); unprefixed base58 is solana and unprefixed 0x is robinhood.
 */
import pg from "pg";
import { ADDRESSES_PER_CALL, CHAIN_IDS, athUpdate, bestPairs, fetchPairs } from "./lib/dexscreener.mjs";
import { SOL_MINT, ZERO_ADDRESS } from "./lib/chain_reads.mjs";

const arg  = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const DRY   = flag("dry-run");
const LIMIT = Number(arg("limit", "0")) || null;
const TOKENS = arg("token")?.split(",").map((a) => a.trim()).filter(Boolean) ?? null;

const DB = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
if (!DB && !(DRY && TOKENS)) { console.error("DATABASE_URL is not set (or pass --dry-run --token …)"); process.exit(1); }

const networkOf = (chain) => Number(Object.keys(CHAIN_IDS).find((id) => CHAIN_IDS[id] === chain));

function parseToken(spec) {
  const [chain, address] = spec.includes(":") ? spec.split(":", 2) : [spec.startsWith("0x") ? "robinhood" : "solana", spec];
  if (!networkOf(chain)) throw new Error(`unknown chain '${chain}' in --token ${spec}`);
  return { network_id: networkOf(chain), chain, token_key: address.toLowerCase(), address };
}

async function targets(c) {
  if (TOKENS) return TOKENS.map(parseToken);
  const { rows } = await c.query(
    `select distinct h.network_id, ch.name as chain, h.token_key, tk.address
       from holdings_current h
       join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
       join chains ch on ch.network_id = h.network_id
      where h.human_amount > 0 and h.token_key not in ($1, $2)
      order by h.network_id, h.token_key
      ${LIMIT ? "limit $3" : ""}`,
    LIMIT ? [ZERO_ADDRESS, SOL_MINT, LIMIT] : [ZERO_ADDRESS, SOL_MINT],
  );
  return rows.map((r) => ({ ...r, network_id: Number(r.network_id) }));
}

/** Previous stats for a chunk, keyed `network_id:token_key`; one select per chunk. */
async function prevStats(c, chunk) {
  const { rows } = await c.query(
    `select s.network_id, s.token_key, s.ath_usd, s.ath_at
       from token_price_stats s
       join unnest($1::bigint[], $2::text[]) as k(network_id, token_key) using (network_id, token_key)`,
    [chunk.map((t) => t.network_id), chunk.map((t) => t.token_key)],
  );
  return new Map(rows.map((r) => [`${r.network_id}:${r.token_key}`, { athUsd: Number(r.ath_usd), athAt: new Date(r.ath_at).toISOString() }]));
}

async function writeChunk(c, hour, priced, prev) {
  const col = (f) => priced.map(f);
  await c.query(
    `insert into token_price_hourly (network_id, token_key, hour, usd, liquidity_usd, source)
     select * from unnest($1::bigint[], $2::text[], $3::timestamptz[], $4::numeric[], $5::numeric[], $6::text[])
     on conflict (network_id, token_key, hour) do update
       set usd = excluded.usd, liquidity_usd = excluded.liquidity_usd, source = excluded.source`,
    [col((p) => p.t.network_id), col((p) => p.t.token_key), col(() => hour), col((p) => p.b.usd), col((p) => p.b.liquidity), col((p) => p.source)],
  );
  const stats = priced.map((p) => athUpdate(prev.get(`${p.t.network_id}:${p.t.token_key}`) ?? null, { usd: p.b.usd, at: hour }));
  await c.query(
    `insert into token_price_stats (network_id, token_key, ath_usd, ath_at, last_usd, last_at, drawdown_share, source)
     select * from unnest($1::bigint[], $2::text[], $3::numeric[], $4::timestamptz[], $5::numeric[], $6::timestamptz[], $7::numeric[], $8::text[])
     on conflict (network_id, token_key) do update
       set ath_usd = excluded.ath_usd, ath_at = excluded.ath_at, last_usd = excluded.last_usd, last_at = excluded.last_at,
           drawdown_share = excluded.drawdown_share, source = excluded.source, updated_at = now()`,
    [col((p) => p.t.network_id), col((p) => p.t.token_key), stats.map((s) => s.athUsd), stats.map((s) => s.athAt),
     col((p) => p.b.usd), col(() => hour), stats.map((s) => s.drawdownShare), col((p) => p.source)],
  );
}

async function main() {
  const pool = DB ? new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 2 }) : null;
  const c = pool ? await pool.connect() : null;
  try {
    const list = await targets(c);
    const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
    console.log(`tokens to price: ${list.length} for ${hour}${DRY ? " (dry run)" : ""}`);
    let priced = 0;
    // DexScreener's endpoint is per chain, so a batch never mixes chains.
    for (const [chain, tokens] of Map.groupBy(list, (t) => t.chain)) {
      for (let i = 0; i < tokens.length; i += ADDRESSES_PER_CALL) {
        const chunk = tokens.slice(i, i + ADDRESSES_PER_CALL);
        const best = bestPairs(await fetchPairs(chain, chunk.map((t) => t.address)));
        const hits = [];
        for (const t of chunk) {
          const b = best.get(t.address.toLowerCase());
          if (!b) { console.log(`  ${chain} ${t.address}  no pool`); continue; }
          console.log(`  ${chain} ${t.address}  ${b.usd} USD  liq $${Math.round(b.liquidity)}  ${b.dex}`);
          hits.push({ t, b, source: `dexscreener:${b.dex}` });
        }
        priced += hits.length;
        if (DRY || !hits.length) continue;
        await writeChunk(c, hour, hits, await prevStats(c, chunk));
      }
    }
    console.log(`\n${DRY ? "would write" : "wrote"} ${priced} of ${list.length} prices for ${hour}`);
  } finally {
    c?.release();
    await pool?.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
