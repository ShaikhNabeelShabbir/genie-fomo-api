import type { Env } from "../env";
import { jobSql, type Sql } from "../sql";
import { buildAumHistory } from "./valuation.ts";
import { CHUNK_HOURS, planWork, type Chunk, type TraderRange } from "./aum_history-core";

/**
 * Hourly aum_history builder (17 Sep 2026): balance history is BUILT from stored holdings
 * and prices by `buildAumHistory` (./valuation.ts, the port of the dropped SQL function
 * `aum_history_build`), not sampled. This job only decides which (trader, hour range) to build
 * next and calls it per chunk of <= CHUNK_HOURS, oldest first, until the budget is spent. Same shape as
 * prices.ts: one client, a budget check per unit of work, a summary that says how far it got.
 */

/**
 * V1d (v5 fixes, 17 Sep 2026). ONE-OFF HEAL OF THE HOURS BUILT UNDER THE CLOCK-DEPENDENT LADDER.
 *
 * Until this morning the builder could price an hour with GMGN's untimestamped `token_info`
 * price, but only when the hour being built was the hour we were in. Those rows are exactly the
 * ones whose `computed_at` falls inside their own `hour`, and they are wrong: cupseyy's 07:00
 * reads $2,509,077,756 that way. 2,078 of them exist across 443 traders, all written on
 * 17 Sep between 07:00 and 17:00, because D1 is a day old.
 *
 * Rebuilding one moves its `computed_at` past its `hour`, so the predicate stops matching and
 * this converges and then costs nothing. The date bound keeps it a bounded scan rather than a
 * full pass over `aum_history` for ever; DELETE THIS FUNCTION AND ITS CALL once the count is 0
 * (`select count(*) from aum_history where basis='priced' and computed_at < '2026-09-17T15:45:00.000Z'
 * and substr(computed_at,1,13)=substr(hour,1,13)`).
 *
 * This exists because the on-demand rebuild endpoint needs `JOB_SECRET`, which nobody on the
 * team currently holds. The cron can heal it without one.
 */
const HEAL_PER_RUN = 100;
/** The only day the old ladder ever wrote; nothing outside it can match. */
const HEAL_FROM = "2026-09-17T00:00:00.000Z";
const HEAL_TO = "2026-09-18T00:00:00.000Z";
/**
 * Written BEFORE the ladder fix deployed. This, not "built inside its own hour", is what marks
 * a poisoned row: the current hour is always built during itself, so that test matches every
 * fresh row too and the pass could never converge — the count rose from 2,078 to 2,102 on the
 * first run precisely because it kept re-selecting the hour it had just written.
 */
const HEAL_WRITTEN_BEFORE = "2026-09-17T15:45:00.000Z";
/** Share of the run's budget the heal may spend before the ordinary build starts. */
const HEAL_BUDGET_SHARE = 0.5;

async function healClockBuiltHours(sql: Sql, started: number, budgetMs: number): Promise<number> {
  const rows = await sql<{ handle: string; from_hour: string; to_hour: string }[]>`
    select handle, min(hour) as from_hour, max(hour) as to_hour
      from aum_history
     where basis = 'priced'
       and hour >= ${HEAL_FROM} and hour < ${HEAL_TO}
       and computed_at < ${HEAL_WRITTEN_BEFORE}
       and substr(computed_at, 1, 13) = substr(hour, 1, 13)
     group by handle
     order by min(hour)
     limit ${HEAL_PER_RUN}`;
  let healed = 0;
  for (const r of rows) {
    if (Date.now() - started > budgetMs) break;
    try {
      healed += await buildAumHistory(sql, r.handle, r.from_hour, r.to_hour);
    } catch (e) {
      console.error(`aum_history: heal ${r.handle} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return healed;
}

export interface AumHistorySummary {
  /** Traders with at least one hour to build this run. */
  readonly traders: number;
  /** Hours upserted. */
  readonly hours: number;
  /** Hours planned but not built because the budget ran out (or the call failed). */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  /** V1d: hours rewritten by the one-off heal above. Zero for good once it has converged. */
  readonly healed: number;
  readonly elapsedMs: number;
}

/** Rule 3 in one query: every trader with a chain capture or a sampled reading, and where their history stands. */
async function ranges(sql: Sql): Promise<TraderRange[]> {
  // SQLite `min(a, b)` is null when either side is, where Postgres `least` skipped nulls.
  const rows = await sql<{ handle: string; last_built: string | null; first_built: string | null; earliest: string | null }[]>`
    select handle, last_built, first_built, coalesce(min(held_from, read_from), held_from, read_from) as earliest
      from (
        select t.handle,
               (select max(hour) from aum_history a where a.handle = t.handle) as last_built,
               (select min(hour) from aum_history a where a.handle = t.handle) as first_built,
               (select min(captured_at) from holdings h where h.handle = t.handle and h.source = 'chain') as held_from,
               (select min(at) from aum_samples s where s.handle = t.handle
                  and s.basis in ('sampled', 'rebuilt') and s.total_usd is not null) as read_from
          from traders t
         where exists (select 1 from holdings h where h.handle = t.handle and h.source = 'chain')
            or exists (select 1 from aum_samples s where s.handle = t.handle and s.basis = 'sampled')
      )`;
  // No earliest source hour means nothing to build; without the guard the planner would backfill from 1970.
  return rows.filter((r) => r.earliest !== null).map((r) => ({
    handle: r.handle,
    lastBuilt: r.last_built ? new Date(r.last_built) : null,
    firstBuilt: r.first_built ? new Date(r.first_built) : null,
    earliest: new Date(r.earliest!),
  }));
}

const build = (sql: Sql, c: Chunk): Promise<number> =>
  buildAumHistory(sql, c.handle, c.from.toISOString(), c.to.toISOString());

export interface AumHistoryOptions { readonly handles?: readonly string[]; readonly from?: Date }

export async function runAumHistory(env: Env, budgetMs: number, opts: AumHistoryOptions = {}): Promise<AumHistorySummary> {
  const started = Date.now();
  const sql = jobSql(env);
  try {
    let traders = await ranges(sql);
    if (opts.handles?.length && opts.from) {
      const wanted = new Set(opts.handles);
      const resumeFrom = new Date(opts.from.getTime() - 3_600_000);
      traders = traders.filter((t) => wanted.has(t.handle)).map((t) => ({ ...t, lastBuilt: resumeFrom, firstBuilt: null }));
    }
    /* V1d: the wrong rows go first — they are being served to consumers right now. */
    const healed = await healClockBuiltHours(sql, started, budgetMs * HEAL_BUDGET_SHARE);

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
    return {
      traders: new Set(work.map((c) => c.handle)).size,
      hours,
      remaining: planned - hours,
      stoppedEarly,
      healed,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
