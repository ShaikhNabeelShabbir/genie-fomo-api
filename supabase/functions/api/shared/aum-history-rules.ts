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
