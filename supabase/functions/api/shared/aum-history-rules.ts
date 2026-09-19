/**
 * Pure rules for /aum/history: which steps and windows exist, which step a window implies,
 * and the time range a window covers. Shared by the GET and the batch POST so the two cannot
 * drift; the SQL lives in routes/aum-history.ts.
 */
export const HISTORY_STEPS = ["1h", "1d", "1w", "1mo"] as const;
export type HistoryStep = typeof HISTORY_STEPS[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Window -> { span (null = unbounded), the step a chart wants at that span }. */
export const HISTORY_WINDOWS = {
  "1d": { ms: DAY_MS, step: "1h" },
  "1w": { ms: 7 * DAY_MS, step: "1h" },
  "1m": { ms: 30 * DAY_MS, step: "1d" },
  "3m": { ms: 90 * DAY_MS, step: "1d" },
  "1y": { ms: 365 * DAY_MS, step: "1w" },
  all: { ms: null, step: "1mo" },
} as const satisfies Record<string, { ms: number | null; step: HistoryStep }>;
export type HistoryWindow = keyof typeof HISTORY_WINDOWS;

export const isHistoryStep = (v: string): v is HistoryStep =>
  (HISTORY_STEPS as readonly string[]).includes(v);
export const isHistoryWindow = (v: string): v is HistoryWindow => v in HISTORY_WINDOWS;

/** The step a window implies when the caller names none. */
export const defaultStep = (window: HistoryWindow): HistoryStep => HISTORY_WINDOWS[window].step;

/** The range a window covers, ending now. `from` is null for `all` (no lower bound). */
export const windowRange = (window: HistoryWindow, now: Date): { from: string | null; to: string } => {
  const span = HISTORY_WINDOWS[window].ms;
  return { from: span === null ? null : new Date(now.getTime() - span).toISOString(), to: now.toISOString() };
};

/** Whole seconds between a live figure's `at` and `now`; never negative (clock skew reads as 0). */
export const ageSeconds = (at: Date | string, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - new Date(at).getTime()) / 1000));

/** The newest point that carries a value: a `null` total (price_suspect, no_prices, ...) never stands in for the latest. */
export const latestValued = <P extends { at: string; totalUsd: number | null }>(points: readonly P[]): P | undefined =>
  points.filter((p) => p.totalUsd !== null).at(-1);

/**
 * A4 / V1d (v5 fixes, 17 Sep 2026). HOW MUCH OF A WALLET A FIGURE IS BUILT FROM.
 *
 * `aum_history` and `aum_live` store a total beside the counts it came from, and the builder
 * published any total above $100 whatever the coverage. Measured that day: 25,492 of 32,866
 * valued hours -- 78% -- were built from under a quarter of the wallet, and one trader's chart
 * alternated a 0.7%-coverage $43,780.82 with a 78%-coverage $354,000 every third hour. Both
 * were presented as facts, and the sawtooth that produced is what a consumer charts.
 *
 * The rule is applied HERE, at read time, on the counts every row already carries: the whole
 * stored series is judged by it the moment this deploys, with nothing rebuilt. The rollup steps
 * cannot call this per hour, so `points` (routes/aum-history.ts) spells the publish floor in SQL;
 * tests/aum_fixes_test.ts holds the two to the same hours.
 *
 * Above PRICED_FLOOR: a figure.
 * Between the two floors: a figure, `partial: true`, with `pricedShare` to label it.
 * Below PUBLISH_FLOOR: withheld -- `totalUsd` null, `reason` too_little_priced, and
 *   `partialUsd` keeps what it would have been. `partialUsd` is NOT a balance.
 */
export const PRICED_FLOOR = 0.25;
export const PUBLISH_FLOOR = 0.05;

export interface Coverage {
  readonly totalUsd: number | null;
  readonly pricedPositions: number;
  readonly totalPositions: number;
  readonly reason: string | null;
}

export interface Confidence {
  readonly totalUsd: number | null;
  readonly partial: boolean;
  readonly partialUsd: number | null;
  readonly pricedShare: number | null;
  readonly reason: string | null;
}

/** The share of the wallet a figure was priced from; null when nothing is held. */
export const pricedShare = (priced: number, total: number): number | null =>
  total > 0 ? Number((priced / total).toFixed(4)) : null;

/** What to publish for one stored figure. Pure; tested in tests/aum_history_route_test.ts. */
export function confidence(c: Coverage): Confidence {
  const share = pricedShare(c.pricedPositions, c.totalPositions);
  if (c.totalUsd === null || share === null) {
    return { totalUsd: null, partial: false, partialUsd: null, pricedShare: share, reason: c.reason };
  }
  if (share < PUBLISH_FLOOR) {
    return { totalUsd: null, partial: false, partialUsd: c.totalUsd, pricedShare: share,
             reason: "too_little_priced" };
  }
  return { totalUsd: c.totalUsd, partial: share < PRICED_FLOOR, partialUsd: null,
           pricedShare: share, reason: c.reason };
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * A3 (v5 fixes, 17 Sep 2026). An hour the builder never wrote came back as a HOLE: one trader's
 * `window=1d` returned 22 points with 08:00 and 09:00 simply absent, while another's empty
 * hours came back as null with a reason. A chart cannot tell a gap from the end of the data.
 *
 * Every hour between the first and last point that carries no row is filled with a null point
 * and `reason: "not_built"`. Only between them: hours before the first are hours the trader was
 * not tracked, and inventing those would claim knowledge we do not have.
 *
 * Hourly only. The 1d / 1w / 1mo rollups come from views whose buckets are already contiguous.
 */
export function fillHourGaps<P extends { at: string }>(
  points: readonly P[], gap: (at: string) => P,
): P[] {
  if (points.length < 2) return [...points];
  const out: P[] = [];
  for (let i = 0; i < points.length; i++) {
    out.push(points[i]);
    if (i === points.length - 1) continue;
    const from = Date.parse(points[i].at), to = Date.parse(points[i + 1].at);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    for (let t = from + HOUR_MS; t < to; t += HOUR_MS) out.push(gap(new Date(t).toISOString()));
  }
  return out;
}
