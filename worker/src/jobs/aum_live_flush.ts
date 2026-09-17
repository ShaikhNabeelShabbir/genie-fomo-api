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
const TOP_UP_PER_RUN = 60;
/** Handles per statement; the same slice the marked flush uses. */
const TOP_UP_SLICE = 20;

/**
 * Traders over an hour old that nothing has marked as moved, oldest first. A marked trader is
 * excluded because the flush above revalues it with the roll-forward it needs; this set is
 * valued from the balances as read, which is ~20x less database work a trader.
 */
async function topUpUnmoved(sql: Sql, limit: number): Promise<number> {
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
export async function runAumLiveFlush(env: Env, _budgetMs: number): Promise<AumLiveFlushSummary> {
  const started = Date.now();
  const sql = jobSql(env);
  try {
    // Oldest marks first, a bounded slice a run: the cron is every 5 minutes and each trader
    // costs a `holdings_live` pass, which D1 charges CPU for.
    // 20, not 40: a 40-trader run measured 373 s against a 5-minute cron, so it overlapped itself
    // and competed with every read for D1's single thread (17 Sep 2026). 20 a run is 240 an hour,
    // well above the rate wallets are marked at.
    const marked = (await sql<{ handle: string; marked_at: string }[]>`
      select handle, marked_at from aum_live_dirty order by marked_at limit 20`);
    if (!marked.length) {
      return { marked: 0, refreshed: 0, toppedUp: await topUpUnmoved(sql, TOP_UP_PER_RUN), elapsedMs: Date.now() - started };
    }
    const handles = marked.map((m) => m.handle);
    const refreshed = await refreshAumLive(sql, handles, "webhook");
    const newest = marked[marked.length - 1].marked_at;
    // 80 ids plus `newest` stays under D1's 100 bound parameters a statement.
    for (const part of chunk(handles, 80)) {
      await sql`delete from aum_live_dirty where handle in (${part}) and marked_at <= ${newest}`;
    }
    return {
      marked: handles.length,
      refreshed,
      toppedUp: await topUpUnmoved(sql, TOP_UP_PER_RUN),
      elapsedMs: Date.now() - started,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
