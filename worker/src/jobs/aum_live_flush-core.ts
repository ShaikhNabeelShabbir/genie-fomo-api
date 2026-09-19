import type { Sql } from "../d1.ts";
import { chunk } from "./directory-core.ts";
import { refreshAumLive } from "./valuation.ts";

/** A row of `aum_live_dirty` as the flush read it. */
export interface Mark { readonly handle: string; readonly marked_at: string }

export interface FlushedMarks { readonly refreshed: number; readonly reached: number; readonly failed: number }

/** Marked traders per `refreshAumLive` call: small, so the budget is checked often. */
const MARKED_SLICE = 5;

/** The run's queue, longest-unvalued first (the why is at its call site). Here so the tests run the statement the job runs. */
export const markedQueue = (sql: Sql) => sql<Mark[]>`
      select d.handle, d.marked_at from aum_live_dirty d
      left join aum_live l on l.handle = d.handle
      order by l.at limit 20`;

/**
 * Revalue `part`, then clear each mark against ITS OWN captured value, so a trader re-marked
 * while the refresh ran keeps the newer mark and comes back next run. Null when the refresh
 * threw: it is logged and every mark of `part` is kept.
 */
async function flushSlice(sql: Sql, part: readonly Mark[]): Promise<number | null> {
  let refreshed: number;
  try {
    refreshed = await refreshAumLive(sql, part.map((m) => m.handle), "webhook");
  } catch (e) {
    console.error(`aum_live_flush: ${part.map((m) => m.handle).join(",")} failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  // Un-awaited inside `begin`, the slice's deletes go out as one batch.
  await sql.begin((tx) => Promise.all(part.map((m) =>
    tx`delete from aum_live_dirty where handle = ${m.handle} and marked_at <= ${m.marked_at}`)));
  return refreshed;
}

/**
 * The marked queue in slices, stopping at the deadline: a trader not reached keeps its mark and
 * leads the next run (the queue is stalest-value-first), so nothing is lost by stopping early.
 *
 * A slice that THROWS is retried one trader at a time and the run moves on, so only the trader
 * who fails ALONE keeps his mark. It used to end the run; and kept whole, the failed slice
 * re-formed at the head of every later run, so the four beside him were never valued either.
 * Here, not in aum_live_flush.ts, so tests/aum_live_flush_test.ts can run it.
 */
export async function flushMarked(sql: Sql, marked: readonly Mark[], deadline: number): Promise<FlushedMarks> {
  let refreshed = 0, reached = 0, failed = 0;
  for (const part of chunk(marked, MARKED_SLICE)) {
    if (Date.now() >= deadline) break;
    const whole = await flushSlice(sql, part);
    if (whole !== null) {
      refreshed += whole;
      reached += part.length;
      continue;
    }
    failed += 1;
    /*
     * Stalest LAST: a trader who fails every run never advances `aum_live.at`, so he leads his
     * slice. When every other member has gone through alone he is the one that failed, and D1's
     * single thread is not spent on his statement a second time.
     */
    let alone = 0;
    for (const [i, m] of [...part].reverse().entries()) {
      if (Date.now() >= deadline || (i === part.length - 1 && alone === i)) break;
      const one = await flushSlice(sql, [m]);
      if (one === null) continue;
      refreshed += one;
      reached += 1;
      alone += 1;
    }
  }
  if (failed > 0 && reached === 0) throw new Error(`aum_live_flush: ${failed} slices failed and no trader was revalued`);
  return { refreshed, reached, failed };
}
