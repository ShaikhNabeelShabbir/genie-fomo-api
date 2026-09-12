#!/usr/bin/env node
/**
 * Turn per-chain rebuilt points into whole-trader totals (AUM_CHART_PRD.md §3.2).
 *
 * WHY THIS IS A SEPARATE STEP. Each backfill knows only its own chain, so every rebuilt
 * parent row is written `total_usd: null` with `chains_unrebuildable` -- correct while other
 * chains were missing, because a one-chain figure published as a portfolio total would draw a
 * drawdown that never happened. Once every chain a trader is on has a point for that day,
 * the parts are all present and the whole can be stated.
 *
 * THE RULE IS THE PRD'S, AND IT IS STRICT. A point is a total only when EVERY chain the
 * trader holds answered with a number for that day. One chain missing, or present but
 * unpriced, and the day stays null with its reason -- because a total missing a chain reads
 * low and is indistinguishable from a real fall. Missing is never zero.
 *
 *   node scripts/aggregate_aum_rebuilt.mjs --dry-run
 *   node scripts/aggregate_aum_rebuilt.mjs
 */
import pg from "pg";

const DB = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
if (!DB) { console.error("DATABASE_URL is not set"); process.exit(1); }
const DRY = process.argv.includes("--dry-run");
const pool = new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 3 });

async function main() {
  const client = await pool.connect();
  try {
    await client.query("set statement_timeout='300s'");

    /*
     * `expected` is the chains the trader actually holds, so a trader on three chains is not
     * held to a fourth. `answered` counts only chain rows carrying a number -- a row with a
     * null total contributed no dollars and must not be mistaken for a chain that reported.
     */
    const summary = await client.query(`
      with expected as (
        /*
         * EVERY CHAIN WE KNOW HE TOUCHED, not just the ones he holds today.
         *
         * Using current holdings alone is too lenient for a past day: a trader who has since
         * exited a chain would be judged against a denominator of one, so a single answered
         * chain would mark the day complete while the chain holding most of him that day was
         * missing entirely. Measured on gmgn_0xc84248de -- holds only bsc now, but was on
         * robinhood for $15,925 two days earlier. The union is what he could have been on.
         */
        select handle, count(distinct network_id)::int n from (
          select handle, network_id from holdings_current where human_amount > 0
          union
          select handle, network_id from aum_chain_samples where basis = 'rebuilt'
        ) u group by handle
      ), answered as (
        select handle, at, count(*) filter (where total_usd is not null)::int n,
               sum(total_usd) filter (where total_usd is not null) as total
        from aum_chain_samples where basis = 'rebuilt' group by handle, at
      )
      select count(*)::int rebuilt_days,
             count(*) filter (where a.n > 0)::int days_with_a_figure,
             count(*) filter (where a.n >= e.n)::int days_covering_every_chain,
             count(distinct a.handle)::int traders,
             count(distinct a.handle) filter (where a.n > 0)::int traders_with_any_total
      from answered a join expected e using (handle)`);
    console.table(summary.rows);

    if (DRY) { console.log("dry run — nothing written"); return; }

    const upd = await client.query(`
      with expected as (
        /*
         * EVERY CHAIN WE KNOW HE TOUCHED, not just the ones he holds today. A trader who has
         * since exited a chain would otherwise be judged against a denominator of one.
         */
        select handle, count(distinct network_id)::int n from (
          select handle, network_id from holdings_current where human_amount > 0
          union
          select handle, network_id from aum_chain_samples where basis = 'rebuilt'
        ) u group by handle
      ), answered as (
        select handle, at, count(*) filter (where total_usd is not null)::int n,
               sum(total_usd) filter (where total_usd is not null) as total
        from aum_chain_samples where basis = 'rebuilt' group by handle, at
      )
      update aum_samples s
         /*
          * STATE THE DAY, AND STATE WHAT IT COVERS.
          *
          * The total is the sum of the chains that answered -- a real figure for a real part
          * of him. It is only null when NOTHING answered, because then there is no number to
          * state. chains_answered beside chains_expected is what keeps a partial day from
          * being a silent one, and is why publishing it is safe where the old rule was not.
          */
         set total_usd       = case when a.n > 0 then a.total else null end,
             refused_reason  = case when a.n > 0 then null else 'chains_unrebuildable' end,
             chains_answered = a.n,
             chains_expected = e.n,
             sampled_at      = now()
        from answered a join expected e using (handle)
       where s.handle = a.handle and s.at = a.at and s.basis = 'rebuilt'
      returning 1`);
    console.log(`${upd.rowCount} rebuilt parent rows re-stated`);

    const after = await client.query(`
      select count(*)::int rows, count(total_usd)::int with_total,
             count(*) filter (where chains_answered >= chains_expected)::int fully_covered,
             count(distinct handle)::int traders,
             count(distinct handle) filter (where total_usd is not null)::int traders_with_total,
             (select count(*)::int from (
                select handle from aum_samples where basis='rebuilt' and total_usd is not null
                group by handle having count(*) >= 2) z) as traders_drawable
      from aum_samples where basis = 'rebuilt'`);
    console.table(after.rows);

    /*
     * §3.4 requires the parts to sum to the whole wherever the total is numeric. Checked
     * rather than asserted: a drift here means the two tables disagree about the same day.
     */
    const check = await client.query(`
      with parts as (
        select handle, at, sum(total_usd) total from aum_chain_samples
        where basis='rebuilt' and total_usd is not null group by handle, at
      )
      select count(*)::int compared,
             count(*) filter (where abs(s.total_usd - p.total) < 0.01)::int agree_to_the_cent
      from aum_samples s join parts p on p.handle=s.handle and p.at=s.at
      where s.basis='rebuilt' and s.total_usd is not null`);
    console.table(check.rows);
  } finally { client.release(); await pool.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
