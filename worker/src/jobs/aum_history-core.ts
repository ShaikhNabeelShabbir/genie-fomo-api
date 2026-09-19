import type { Sql } from "../d1.ts";

/**
 * Pure range planner for the aum_history builder (rule 3 in the 17 Sep 2026 decision):
 * hours run from the hour after the last built one (or the earliest source hour when nothing
 * is built) up to the current hour, the last two hours are always recomputed because prices
 * arrive late, and the span is cut into chunks of at most `chunkHours` so a fresh install
 * backfills over several runs. The planner does no I/O: tested in tests/aum_history_test.ts.
 * `ranges` at the foot is the one statement here, taking its `sql`, so a test can run it too.
 */

export const CHUNK_HOURS = 168;
/** Hours re-built every run even when already present: this hour and the previous one. */
export const RECOMPUTE_HOURS = 2;
const HOUR_MS = 3_600_000;

export interface TraderRange {
  readonly handle: string;
  /** max(aum_history.hour) for the trader, or null when nothing is built yet. */
  readonly lastBuilt: Date | null;
  /** Oldest built hour; when `earliest` moved back (a new source), the gap before it is built too. */
  readonly firstBuilt?: Date | null;
  /** least(min(holdings.captured_at), min(aum_samples.at)). */
  readonly earliest: Date;
}

export interface Chunk {
  readonly handle: string;
  readonly from: Date;
  /** Inclusive; the builder's generate_series ends here. */
  readonly to: Date;
  readonly hours: number;
}

export function truncHour(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);
}

/** Chunks for one trader, oldest first. Empty only when `earliest` is after `now`. */
export function planChunks(t: TraderRange, now: Date, chunkHours: number = CHUNK_HOURS): Chunk[] {
  const end = truncHour(now);
  const recomputeFrom = new Date(end.getTime() - (RECOMPUTE_HOURS - 1) * HOUR_MS);
  const resume = t.lastBuilt ? new Date(truncHour(t.lastBuilt).getTime() + HOUR_MS) : truncHour(t.earliest);
  const start = new Date(Math.max(truncHour(t.earliest).getTime(), Math.min(resume.getTime(), recomputeFrom.getTime())));
  const chunks: Chunk[] = [];
  const first = t.firstBuilt ? truncHour(t.firstBuilt) : null;
  if (first && truncHour(t.earliest).getTime() < first.getTime()) {
    const stop = new Date(first.getTime() - HOUR_MS);
    for (let from = truncHour(t.earliest); from <= stop; from = new Date(from.getTime() + chunkHours * HOUR_MS)) {
      const to = new Date(Math.min(from.getTime() + (chunkHours - 1) * HOUR_MS, stop.getTime()));
      chunks.push({ handle: t.handle, from, to, hours: (to.getTime() - from.getTime()) / HOUR_MS + 1 });
    }
  }
  for (let from = start; from <= end; from = new Date(from.getTime() + chunkHours * HOUR_MS)) {
    const to = new Date(Math.min(from.getTime() + (chunkHours - 1) * HOUR_MS, end.getTime()));
    chunks.push({ handle: t.handle, from, to, hours: (to.getTime() - from.getTime()) / HOUR_MS + 1 });
  }
  return chunks;
}

/** Every trader's chunks in one list, oldest `from` first so a backfill is shared fairly. */
export function planWork(traders: readonly TraderRange[], now: Date, chunkHours: number = CHUNK_HOURS): Chunk[] {
  return traders.flatMap((t) => planChunks(t, now, chunkHours))
    .sort((a, b) => a.from.getTime() - b.from.getTime() || a.handle.localeCompare(b.handle));
}

/**
 * Rule 3 in one query: every trader with a chain capture or a sampled reading, and where their
 * history stands. Here, not in aum_history.ts, so tests/aum_history_ranges_test.ts can run it.
 */
export async function ranges(sql: Sql): Promise<TraderRange[]> {
  // SQLite `min(a, b)` is null when either side is, where Postgres `least` skipped nulls.
  const rows = await sql<{ handle: string; last_built: string | null; first_built: string | null; earliest: string | null }[]>`
    select handle, last_built, first_built, coalesce(min(held_from, read_from), held_from, read_from) as earliest
      from (
        select t.handle,
               (select max(hour) from aum_history a where a.handle = t.handle) as last_built,
               (select min(hour) from aum_history a where a.handle = t.handle) as first_built,
               -- The unary plus keeps the planner off (source, captured_at): that index walked every chain
               -- capture older than the first one of this trader, per trader; holdings_handle_idx seeks it.
               (select min(captured_at) from holdings h where h.handle = t.handle and +h.source = 'chain') as held_from,
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
