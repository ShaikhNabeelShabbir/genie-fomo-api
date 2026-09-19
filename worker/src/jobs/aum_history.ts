import type { Env } from "../env";
import { jobSql, type Sql } from "../sql";
import { buildAumHistory } from "./valuation.ts";
import { CHUNK_HOURS, planWork, ranges, type Chunk } from "./aum_history-core";

/**
 * Hourly aum_history builder (17 Sep 2026): balance history is BUILT from stored holdings
 * and prices by `buildAumHistory` (./valuation.ts, the port of the dropped SQL function
 * `aum_history_build`), not sampled. This job only decides which (trader, hour range) to build
 * next and calls it per chunk of <= CHUNK_HOURS, oldest first, until the budget is spent. Same shape as
 * prices.ts: one client, a budget check per unit of work, a summary that says how far it got.
 */

export interface AumHistorySummary {
  /** Traders with at least one hour to build this run. */
  readonly traders: number;
  /** Hours upserted. */
  readonly hours: number;
  /** Hours planned but not built because the budget ran out (or the call failed). */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
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
      elapsedMs: Date.now() - started,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
