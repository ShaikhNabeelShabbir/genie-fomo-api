import type { Env } from "../env";
import { jobSql } from "../sql";
import { type Sql } from "../sql";
import { refreshAumLive, refreshAumLiveUnmoved } from "./valuation.ts";
import { chunk } from "./directory-core";

export interface AumLiveFlushSummary {
  readonly marked: number;
  readonly refreshed: number;
  /** A2: unmoved traders topped up this run, over and above the marked ones. */
  readonly toppedUp: number;
  readonly elapsedMs: number;
}

/**
 * A2 (v5 fixes, 17 Sep 2026). CADENCE, NOT COST, IS WHAT KEEPS A FIGURE UNDER AN HOUR OLD.
 *
 * The catch-up used to live in the hourly history job, and an hourly pass against a one-hour
 * staleness threshold can never hold `liveStale` near zero: the cohort refreshed at :25 ages
 * out together at :25 the next hour. Measured on 17 Sep, `liveStale` read 136 before a pass
 * and 195 twenty minutes later, with the pass having refreshed every trader that was eligible
 * when it ran. Nothing was failing; the schedule simply could not meet the definition.
 *
 * It lives here instead, on the five-minute cron: twelve passes an hour, so a trader is picked
 * up within minutes of crossing the line rather than at the top of the next hour. One job now
 * owns live freshness and the history job is back to building history.
 */
/**
 * 0 SINCE 19 Sep 2026 — THE TOP-UP IS SWITCHED OFF, NOT REMOVED.
 *
 * At 60 it made this job run 231 s / 382 s / 625 s against a 300 s cadence (measured from the
 * Worker tail, 19 Sep 07:05-07:20 UTC), so the job overlapped itself, and twice in 40 minutes a
 * run ended in "D1 DB's isolate exceeded its memory limit and was reset" — after which D1
 * refuses every statement for about a minute and the API serves those refusals as errors. The
 * "about 0.1 s a trader" this was sized on measured only the balance read; `revalue` then runs
 * `loadFacts`, five serial statements per 80 token keys, which is where the time and the crash
 * are. Re-enable only with a per-run budget AND a batched `loadFacts` (tasks/todo.md, P1).
 */
const TOP_UP_PER_RUN = 0;
/**
 * This job's own ceiling. The scheduler hands every cron JOB_BUDGET_MS (600 s), twice this
 * job's period, so honouring that would still let it overlap itself; a fifth of the period
 * leaves D1 to the API for the other four.
 */
const FLUSH_BUDGET_MS = 60_000;
/** Marked traders per `refreshAumLive` call: small, so the budget is checked often. */
const MARKED_SLICE = 5;
/** Handles per statement; the same slice the marked flush uses. */
const TOP_UP_SLICE = 20;

/**
 * Traders over an hour old that nothing has marked as moved, oldest first. A marked trader is
 * excluded because the flush above revalues it with the roll-forward it needs; this set is
 * valued from the balances as read, which is ~20x less database work a trader.
 */
async function topUpUnmoved(sql: Sql, limit: number): Promise<number> {
  if (limit <= 0) return 0;
  const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const stale = (await sql<{ handle: string }[]>`
    select t.handle from traders t
    left join aum_live l on l.handle = t.handle
    where (l.at is null or l.at < ${anHourAgo})
      and exists (select 1 from wallets w where w.handle = t.handle)
      and not exists (select 1 from aum_live_dirty d where d.handle = t.handle)
    order by l.at limit ${limit}`).map((r) => r.handle);
  let n = 0;
  for (const part of chunk(stale, TOP_UP_SLICE)) n += await refreshAumLiveUnmoved(sql, part, "build");
  return n;
}

/**
 * Every minute: refresh the live value of every trader the Helius receiver marked dirty since
 * the last run, in ONE `refreshAumLive` call, then clear exactly the handles refreshed. A
 * trader marked again while the refresh ran keeps the newer mark for the next minute.
 */
export async function runAumLiveFlush(env: Env, budgetMs: number): Promise<AumLiveFlushSummary> {
  const started = Date.now();
  const deadline = started + Math.min(budgetMs, FLUSH_BUDGET_MS);
  const sql = jobSql(env);
  try {
    // Oldest marks first, a bounded slice a run: the cron is every 5 minutes and each trader
    // costs a `holdings_live` pass, which D1 charges CPU for.
    // 20, not 40: a 40-trader run measured 373 s against a 5-minute cron, so it overlapped itself
    // and competed with every read for D1's single thread (17 Sep 2026). 20 a run is 240 an hour,
    // well above the rate wallets are marked at.
    /**
     * A2. ORDERED BY THE AGE OF THE VALUE, NOT THE AGE OF THE MARK.
     *
     * `order by marked_at` served whoever was marked longest ago — and a busy wallet is
     * re-marked on every webhook push, so its mark is always seconds old and it sat at the back
     * of the queue for ever. The most active traders held the stalest figures, which is exactly
     * backwards. Measured 17 Sep: `bertluvv` carried a value from 12:25 with a mark refreshed
     * at 16:47, and was one of 34 traders in that state.
     *
     * `l.at` ascending puts the longest-unvalued first, and SQLite sorts NULL first, so a
     * trader with no figure at all leads.
     */
    const marked = (await sql<{ handle: string; marked_at: string }[]>`
      select d.handle, d.marked_at from aum_live_dirty d
      left join aum_live l on l.handle = d.handle
      order by l.at limit 20`);
    if (!marked.length) {
      return { marked: 0, refreshed: 0, toppedUp: await topUpUnmoved(sql, TOP_UP_PER_RUN), elapsedMs: Date.now() - started };
    }
    /*
     * In slices, stopping at the deadline: a trader not reached keeps its mark and leads the
     * next run (the queue is stalest-value-first), so nothing is lost by stopping early.
     *
     * Each mark is cleared against ITS OWN captured value, so a trader re-marked while the
     * refresh ran keeps the newer mark and comes back next run.
     */
    let refreshed = 0, reached = 0;
    for (const part of chunk(marked, MARKED_SLICE)) {
      if (Date.now() >= deadline) break;
      refreshed += await refreshAumLive(sql, part.map((m) => m.handle), "webhook");
      await sql.begin(async (tx) => {
        for (const m of part) {
          await tx`delete from aum_live_dirty where handle = ${m.handle} and marked_at <= ${m.marked_at}`;
        }
      });
      reached += part.length;
    }
    return {
      marked: reached,
      refreshed,
      toppedUp: await topUpUnmoved(sql, TOP_UP_PER_RUN),
      elapsedMs: Date.now() - started,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
