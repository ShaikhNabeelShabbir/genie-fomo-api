#!/usr/bin/env node
/**
 * Rebuild the dev ledger from the GMGN creator signals already stored in token_info.raw.
 *
 * Two upserts, both derived: token_creators (token -> creator, status as GMGN gave it), then
 * creators (one row per creator: launches, best peak, still holding / sold / honeypot
 * counts). Reads `raw->'dev'->>'creator_address'`, `->>'creator_token_status'` and
 * `->'ath_token_info'` ({ath_token, ath_mc}) — the same keys /tokens/:address publishes.
 *
 *   node scripts/refresh_creators.mjs --dry-run
 *   node scripts/refresh_creators.mjs
 */
import pg from "pg";

const DB = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
if (!DB) { console.error("DATABASE_URL is not set"); process.exit(1); }
const DRY = process.argv.includes("--dry-run");
const pool = new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 1 });

const TOKEN_CREATORS = `
  select network_id, token_key,
         lower(raw->'dev'->>'creator_address')            as creator_address_key,
         nullif(raw->'dev'->>'creator_token_status', '')   as creator_status
  from token_info
  where nullif(raw->'dev'->>'creator_address', '') is not null`;

const CREATORS = `
  with per_token as (
    select tc.network_id, tc.creator_address_key, tc.token_key, tc.creator_status,
           ti.is_honeypot, tk.first_seen_at,
           lower(nullif(ti.raw->'dev'->'ath_token_info'->>'ath_token', '')) as ath_token_key,
           nullif((ti.raw->'dev'->'ath_token_info'->>'ath_mc')::numeric, 0)  as ath_mc
    from token_creators tc
    join token_info ti using (network_id, token_key)
    join tokens tk using (network_id, token_key)
  ),
  best as (
    select distinct on (network_id, creator_address_key)
           network_id, creator_address_key, ath_token_key, ath_mc
    from per_token
    order by network_id, creator_address_key, ath_mc desc nulls last
  )
  select p.network_id, p.creator_address_key,
         count(distinct p.token_key)::int                                   as launches,
         b.ath_mc                                                           as best_peak_mcap_usd,
         b.ath_token_key                                                    as best_token_key,
         count(*) filter (where p.creator_status = 'creator_hold')::int      as still_holding_count,
         count(*) filter (where p.creator_status = 'creator_close')::int     as sold_count,
         count(*) filter (where p.is_honeypot)::int                          as honeypot_count,
         max(p.first_seen_at)                                                as last_launch_at
  from per_token p
  join best b using (network_id, creator_address_key)
  group by p.network_id, p.creator_address_key, b.ath_mc, b.ath_token_key`;

async function main() {
  const c = await pool.connect();
  try {
    await c.query("set statement_timeout='0'");
    if (DRY) {
      const tc = await c.query(`select count(*)::int n from (${TOKEN_CREATORS}) s`);
      console.log(`would write ${tc.rows[0].n.toLocaleString()} token_creators rows`);
      return;
    }
    await c.query("begin");
    const tc = await c.query(`
      insert into token_creators (network_id, token_key, creator_address_key, creator_status)
      ${TOKEN_CREATORS}
      on conflict (network_id, token_key) do update set
        creator_address_key = excluded.creator_address_key,
        creator_status      = excluded.creator_status`);
    const cr = await c.query(`
      insert into creators (network_id, creator_address_key, launches, best_peak_mcap_usd,
                            best_token_key, still_holding_count, sold_count, honeypot_count,
                            last_launch_at, updated_at)
      select *, now() from (${CREATORS}) s
      on conflict (network_id, creator_address_key) do update set
        launches            = excluded.launches,
        best_peak_mcap_usd  = excluded.best_peak_mcap_usd,
        best_token_key      = excluded.best_token_key,
        still_holding_count = excluded.still_holding_count,
        sold_count          = excluded.sold_count,
        honeypot_count      = excluded.honeypot_count,
        last_launch_at      = excluded.last_launch_at,
        updated_at          = now()`);
    await c.query("commit");
    console.log(`token_creators ${tc.rowCount.toLocaleString()} rows · creators ${cr.rowCount.toLocaleString()} rows`);
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
