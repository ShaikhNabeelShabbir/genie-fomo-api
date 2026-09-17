import type postgres from "postgres";
import type { Env } from "../env";
import { db, longStatement } from "../db";
import { CHUNK_HOURS, planWork, type Chunk, type TraderRange } from "./aum_history-core";

/**
 * Hourly aum_history builder (17 Sep 2026): balance history is BUILT from stored holdings
 * and prices by the SQL function `aum_history_build` (migration 20260918010000), not sampled.
 * This job only decides which (trader, hour range) to build next and calls the function per
 * chunk of <= CHUNK_HOURS, oldest first, until the wall-clock budget is spent. Same shape as
 * prices.ts: one client, a budget check per unit of work, a summary that says how far it got.
 */

type Sql = postgres.Sql;

export interface AumHistorySummary {
  /** Traders with at least one hour to build this run. */
  readonly traders: number;
  /** Hours upserted. */
  readonly hours: number;
  /** Hours planned but not built because the budget ran out (or the call failed). */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  /** Traders whose aum_live row was missing or older than an hour and got revalued after the build. */
  readonly liveRefreshed: number;
  readonly elapsedMs: number;
}

/** Rule 3 in one query: every trader with a chain capture or a sampled reading, and where their history stands. */
async function ranges(sql: Sql): Promise<TraderRange[]> {
  const rows = await sql<{ handle: string; last_built: Date | null; first_built: Date | null; earliest: Date }[]>`
    select t.handle,
           (select max(hour) from aum_history a where a.handle = t.handle) as last_built,
           (select min(hour) from aum_history a where a.handle = t.handle) as first_built,
           least((select min(captured_at) from holdings h where h.handle = t.handle and h.source = 'chain'),
                 (select min(at) from aum_samples s where s.handle = t.handle and s.basis in ('sampled', 'rebuilt') and s.total_usd is not null)) as earliest
      from traders t
     where exists (select 1 from holdings h where h.handle = t.handle and h.source = 'chain')
        or exists (select 1 from aum_samples s where s.handle = t.handle and s.basis = 'sampled')`;
  return rows.map((r) => ({
    handle: r.handle,
    lastBuilt: r.last_built ? new Date(r.last_built) : null,
    firstBuilt: r.first_built ? new Date(r.first_built) : null,
    earliest: new Date(r.earliest),
  }));
}

async function build(sql: Sql, c: Chunk): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select aum_history_build(${c.handle}, ${c.from.toISOString()}::timestamptz, ${c.to.toISOString()}::timestamptz) as n`;
  return Number(row?.n ?? 0);
}

/**
 * One pass within `budgetMs`. Throws only when work was planned and none of it could be
 * built, so the cron shows as failed rather than quietly building nothing.
 */
/** On-demand rebuild: `handles` and `from` (POST /jobs/aum_history?handles=a,b&from=ISO) re-run every hour from `from` to now for those traders; the build upserts, so no delete is needed. */
export interface AumHistoryOptions { readonly handles?: readonly string[]; readonly from?: Date }

export async function runAumHistory(env: Env, budgetMs: number, opts: AumHistoryOptions = {}): Promise<AumHistorySummary> {
  const started = Date.now();
  const sql = db(env);
  try {
    let traders = await ranges(sql);
    if (opts.handles?.length && opts.from) {
      const wanted = new Set(opts.handles);
      const resumeFrom = new Date(opts.from.getTime() - 3_600_000);
      traders = traders.filter((t) => wanted.has(t.handle)).map((t) => ({ ...t, lastBuilt: resumeFrom, firstBuilt: null }));
    }
    const work = planWork(traders, new Date(started), CHUNK_HOURS);
    const planned = work.reduce((n, c) => n + c.hours, 0);
    let hours = 0, attempted = 0, failed = 0, stoppedEarly = false;
    for (const c of work) {
      if (Date.now() - started > budgetMs) { stoppedEarly = true; break; }
      attempted += 1;
      try {
        hours += await build(sql, c);
      } catch (e) {
        failed += 1;
        console.error(`aum_history: ${c.handle} ${c.from.toISOString()}..${c.to.toISOString()} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (attempted > 0 && failed === attempted) throw new Error(`aum_history: all ${attempted} chunks failed`);
    // Catch-up for the live value: anyone no feed has revalued in the last hour (aum_live, migration 20260918030000).
    // Stale live values in slices of 40, each its own statement, so no single call holds the
    // database for minutes (the whole-roster form did, 17 Sep 08:5x UTC).
    const stale = (await sql<{ handle: string }[]>`
      select t.handle from traders t
      left join aum_live l on l.handle = t.handle
      where (l.at is null or l.at < now() - interval '1 hour')
        and exists (select 1 from wallets w where w.handle = t.handle)
      order by l.at nulls first limit 400`).map((r) => r.handle);
    let liveN = 0;
    for (let i = 0; i < stale.length && Date.now() - started < budgetMs; i += 40) {
      const [r] = await sql<{ n: number }[]>`select aum_live_refresh(${stale.slice(i, i + 40)}::text[], 'build') as n`;
      liveN += Number(r?.n ?? 0);
    }
    const live = { n: liveN };
    return {
      traders: new Set(work.map((c) => c.handle)).size,
      hours,
      remaining: planned - hours,
      stoppedEarly,
      liveRefreshed: Number(live?.n ?? 0),
      elapsedMs: Date.now() - started,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
