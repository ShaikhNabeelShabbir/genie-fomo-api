/**
 * Pure range planner for the aum_history builder (rule 3 in the 18 Sep 2026 decision):
 * hours run from the hour after the last built one (or the earliest source hour when nothing
 * is built) up to the current hour, the last two hours are always recomputed because prices
 * arrive late, and the span is cut into chunks of at most `chunkHours` so a fresh install
 * backfills over several runs. No I/O: tested in tests/aum_history_test.ts.
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
