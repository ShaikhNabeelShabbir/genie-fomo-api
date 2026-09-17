import type { Env } from "../env";
import { db } from "../db";

export interface AumLiveFlushSummary {
  readonly marked: number;
  readonly refreshed: number;
  readonly elapsedMs: number;
}

/**
 * Every minute: refresh the live value of every trader the Helius receiver marked dirty since
 * the last run, in ONE `aum_live_refresh` call, then clear exactly the handles refreshed. A
 * trader marked again while the refresh ran keeps the newer mark for the next minute.
 */
export async function runAumLiveFlush(env: Env, _budgetMs: number): Promise<AumLiveFlushSummary> {
  const started = Date.now();
  const sql = db(env);
  try {
    const marked = (await sql<{ handle: string; marked_at: Date }[]>`
      select handle, marked_at from aum_live_dirty order by marked_at`);
    if (!marked.length) return { marked: 0, refreshed: 0, elapsedMs: Date.now() - started };
    const handles = marked.map((m) => m.handle);
    const [row] = await sql<{ n: number }[]>`select aum_live_refresh(${handles}::text[], 'webhook') as n`;
    const newest = marked[marked.length - 1].marked_at;
    await sql`delete from aum_live_dirty where handle = any(${handles}) and marked_at <= ${newest}`;
    return { marked: handles.length, refreshed: Number(row?.n ?? 0), elapsedMs: Date.now() - started };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
