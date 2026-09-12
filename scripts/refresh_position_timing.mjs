#!/usr/bin/env node
/**
 * Rebuild position_timing from transactions.
 *
 * WHY THIS EXISTS. GET /traders/:id/positions used to compute these values per request, by
 * grouping one wallet's whole transaction history every time anyone opened the trader. For
 * our busiest wallet that is 66,773 rows and about 9 seconds of CPU, which put the route past
 * its 15-second budget and returned 503. A covering index cut the disk reads a hundredfold
 * and could not help with the rest: the work was the wrong shape, not merely slow.
 *
 * These numbers only move when new transactions arrive, so the loader computes them once.
 *
 * WHOLE-TABLE BY DEFAULT, because the alternative is worse. An incremental pass would have to
 * know which wallets changed, and a wallet missed by that logic keeps serving a first-seen
 * date that is quietly wrong -- the kind of error nothing downstream can detect. The whole
 * table is one aggregate the database is good at, and it is cheap enough to simply redo.
 *
 *   node scripts/refresh_position_timing.mjs --dry-run
 *   node scripts/refresh_position_timing.mjs
 */
import pg from "pg";

const DB = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
if (!DB) { console.error("DATABASE_URL is not set"); process.exit(1); }
const DRY = process.argv.includes("--dry-run");
const pool = new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 2 });

async function main() {
  const c = await pool.connect();
  try {
    await c.query("set statement_timeout='0'");

    const before = await c.query(`select count(*)::int n from position_timing`);
    const src = await c.query(`select count(*)::int n from transactions`);
    console.log(`${src.rows[0].n.toLocaleString()} transactions → position_timing ` +
                `(currently ${before.rows[0].n.toLocaleString()} rows)`);

    if (DRY) {
      const t = Date.now();
      const r = await c.query(`
        select count(*)::int n from (
          select address_key, network_id, token_key
          from transactions group by address_key, network_id, token_key) s`);
      console.log(`would write ${r.rows[0].n.toLocaleString()} rows · aggregate took ${((Date.now() - t) / 1000).toFixed(1)}s`);
      return;
    }

    /*
     * Built beside the live table and swapped in, so the route never reads a half-filled one.
     * A truncate-then-insert would leave every trader with no holding dates for the minute
     * the rebuild takes.
     */
    const t = Date.now();
    await c.query(`drop table if exists position_timing_next`);
    await c.query(`
      create table position_timing_next as
      select address_key, network_id, token_key,
             min(block_time) filter (where direction = 'in')  as start_at,
             max(block_time) filter (where direction = 'out') as end_at,
             max(block_time)                                  as last_at,
             now()                                            as computed_at
      from transactions
      group by address_key, network_id, token_key`);
    const built = await c.query(`select count(*)::int n from position_timing_next`);
    console.log(`aggregated ${built.rows[0].n.toLocaleString()} rows in ${((Date.now() - t) / 1000).toFixed(1)}s`);

    await c.query(`alter table position_timing_next add primary key (address_key, network_id, token_key)`);
    await c.query(`create index on position_timing_next (address_key)`);

    await c.query("begin");
    await c.query(`drop table if exists position_timing_old`);
    await c.query(`alter table position_timing rename to position_timing_old`);
    await c.query(`alter table position_timing_next rename to position_timing`);
    await c.query("commit");
    await c.query(`drop table if exists position_timing_old`);

    const after = await c.query(`
      select count(*)::int rows, count(distinct address_key)::int wallets,
             count(start_at)::int with_start, count(end_at)::int with_end
      from position_timing`);
    const a = after.rows[0];
    console.log(`swapped in: ${a.rows.toLocaleString()} rows · ${a.wallets} wallets · ` +
                `${a.with_start.toLocaleString()} with a first-in · ${a.with_end.toLocaleString()} with a last-out`);
    console.log(`total ${((Date.now() - t) / 1000).toFixed(1)}s`);
  } finally { c.release(); await pool.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
