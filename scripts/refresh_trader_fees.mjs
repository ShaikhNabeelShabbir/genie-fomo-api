#!/usr/bin/env node
/**
 * Build `trader_fees_daily` from the fees `load_transaction_fees.mjs` has fetched.
 *
 * WHY A DERIVED TABLE. Summing a trader's fees at request time was measured at 24.5 seconds:
 * the honest query takes DISTINCT transactions out of `transactions`, which holds one row per
 * transfer leg, and our busiest trader's Solana address carries hundreds of thousands. That
 * cost belongs off the request path -- the last time a route paid a bill like it, the route
 * answered 503. Same reasoning, and same shape, as `refresh_position_timing.mjs`.
 *
 * Everything happens server-side: one INSERT ... SELECT, no rows cross the wire.
 *
 * BUILT BESIDE, THEN SWAPPED IN. A rebuild that truncates first leaves the scorecard with no
 * fees for as long as the pass takes. The new set is built into a scratch table and swapped
 * in one transaction, so a reader sees the old totals or the new ones and never a half-built
 * table.
 *
 *   node scripts/refresh_trader_fees.mjs
 *   node scripts/refresh_trader_fees.mjs --handle unipcs   # one trader, for checking
 */
import pg from "pg";

const DB = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
if (!DB) { console.error("DATABASE_URL is not set"); process.exit(1); }

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`) || a === `--${n}`);
  if (!hit) return d;
  return hit.includes("=") ? hit.slice(n.length + 3) : (argv[argv.indexOf(hit) + 1] ?? d);
};
const ONE = opt("handle");

const db = new pg.Client({ connectionString: DB, ssl: { rejectUnauthorized: false } });
await db.connect();

/*
 * CHUNKED BY TRADER, because one statement cannot be made long enough.
 *
 * The obvious shape is a single INSERT ... SELECT over every trader, and it fails: DATABASE_URL
 * points at the TRANSACTION pooler, where `set statement_timeout` does not survive to the next
 * statement -- each one can land on a different backend. A 25-trader chunk finishes well inside
 * the default timeout, so the pass needs no session settings at all and works through either
 * pooler.
 *
 * It also makes the job report progress and survive a single bad chunk, which one long
 * statement could not.
 */
const CHUNK = Number(opt("chunk", "25")) || 25;

const t0 = Date.now();

/*
 * A trader's transactions are reached through the addresses on their wallet row. Both
 * families are unnested so one query covers a trader who trades on Solana and on the EVM
 * chains, and `lower()` matches how address_key is stored.
 */
const BUILD = `
  with w as (
    select t.handle, lower(x.addr) as address_key
    from traders t
    join wallets wl using (handle),
    lateral (values (wl.evm_address_key), (lower(wl.sol_address))) x(addr)
    where x.addr is not null
      and ($1::text[] is null or t.handle = any($1))
  ),
  /*
   * DISTINCT is the whole point: transactions holds one row per transfer leg, and one
   * transaction pays one fee however many legs it moved. Without this every multi-leg swap
   * would count its fee two, three or fifteen times.
   */
  tx as (
    select distinct w.handle, t.network_id, t.tx_hash, t.block_time
    from w
    join transactions t on t.address_key = w.address_key
  )
  select tx.handle, tx.network_id, (tx.block_time at time zone 'utc')::date as day,
         sum(f.fee_native) as fee_native,
         count(*)::int     as tx_count
  from tx
  join transaction_fees f
    on f.network_id = tx.network_id and f.tx_hash = tx.tx_hash
  where tx.block_time is not null
  group by 1, 2, 3`;

if (ONE) {
  // One trader: replace just their rows, in place. Cheap enough not to need the swap dance.
  await db.query("begin");
  await db.query("delete from trader_fees_daily where handle = $1", [ONE]);
  const r = await db.query(
    `insert into trader_fees_daily (handle, network_id, day, fee_native, tx_count)
     ${BUILD}`, [[ONE]]);
  await db.query("commit");
  console.log(`${ONE}: ${r.rowCount} day rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} else {
  await db.query("drop table if exists trader_fees_daily_next");
  await db.query(
    `create table trader_fees_daily_next
     (like trader_fees_daily including defaults including indexes)`);

  const { rows: all } = await db.query(
    `select t.handle from traders t join wallets w using (handle)
      where w.evm_address_key is not null or w.sol_address is not null
      order by t.handle`);
  const handles = all.map((r) => r.handle);
  console.log(`${handles.length} traders with a wallet, chunks of ${CHUNK}`);

  let built = 0, failed = 0;
  for (let i = 0; i < handles.length; i += CHUNK) {
    const slice = handles.slice(i, i + CHUNK);
    try {
      const r = await db.query(
        `insert into trader_fees_daily_next (handle, network_id, day, fee_native, tx_count)
         ${BUILD}`, [slice]);
      built += r.rowCount;
    } catch (e) {
      /*
       * A chunk that times out is REPORTED AND SKIPPED, never silently dropped: its traders
       * would otherwise appear to have paid no fees, which is a figure, not a gap.
       */
      failed += slice.length;
      console.log(`  chunk ${i / CHUNK + 1} failed (${slice.length} traders): ${e.message}`);
    }
    if ((i / CHUNK) % 4 === 0 || i + CHUNK >= handles.length) {
      console.log(`  ${Math.min(i + CHUNK, handles.length)}/${handles.length} traders, ${built} day rows`);
    }
  }
  console.log(`built ${built} day rows in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
              (failed ? `, ${failed} traders skipped` : ""));
  if (failed > handles.length / 2) {
    console.error("more than half the traders failed — not swapping, the old table stands");
    await db.end();
    process.exit(1);
  }

  /*
   * The swap. Constraints are not carried by LIKE, and re-adding the foreign keys would
   * re-validate a million joins for no gain -- the rows were just derived FROM those tables,
   * so they cannot dangle. The primary key and the read index come across with the table.
   */
  await db.query("begin");
  await db.query("alter table trader_fees_daily rename to trader_fees_daily_old");
  await db.query("alter table trader_fees_daily_next rename to trader_fees_daily");
  await db.query("drop table trader_fees_daily_old");
  await db.query("commit");
  console.log("swapped in");
}

const { rows: [sum] } = await db.query(
  `select count(*)::int as rows, count(distinct handle)::int as traders,
          min(day) as first_day, max(day) as last_day
   from trader_fees_daily`);
console.log(`trader_fees_daily: ${sum.rows} rows, ${sum.traders} traders, ${sum.first_day?.toISOString?.().slice(0,10)} .. ${sum.last_day?.toISOString?.().slice(0,10)}`);

await db.end();
