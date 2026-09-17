import type { Env } from "../env";
import { jobSql } from "../sql";
import { refreshAumLive } from "./valuation.ts";
import { chunk } from "./directory-core";

export interface AumLiveFlushSummary {
  readonly marked: number;
  readonly refreshed: number;
  readonly elapsedMs: number;
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
    const marked = (await sql<{ handle: string; marked_at: string }[]>`
      select handle, marked_at from aum_live_dirty order by marked_at`);
    if (!marked.length) return { marked: 0, refreshed: 0, elapsedMs: Date.now() - started };
    const handles = marked.map((m) => m.handle);
    const refreshed = await refreshAumLive(sql, handles, "webhook");
    const newest = marked[marked.length - 1].marked_at;
    // 80 ids plus `newest` stays under D1's 100 bound parameters a statement.
    for (const part of chunk(handles, 80)) {
      await sql`delete from aum_live_dirty where handle in (${part}) and marked_at <= ${newest}`;
    }
    return { marked: handles.length, refreshed, elapsedMs: Date.now() - started };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
