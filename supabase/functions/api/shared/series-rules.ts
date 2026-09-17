import { badRequest } from "../errors.ts";
import { parseIso } from "./params.ts";

/** Pure step/window rules for the time-series routes (token prices). No database. */

export const SERIES_STEPS = ["1h", "1d", "1w", "1mo"] as const;
export type SeriesStep = (typeof SERIES_STEPS)[number];

export const SERIES_WINDOWS = ["1d", "1w", "1m", "3m", "1y", "all"] as const;
export type SeriesWindow = (typeof SERIES_WINDOWS)[number];

const DAY_MS = 86_400_000;
const WINDOW_MS: Readonly<Record<SeriesWindow, number | null>> = {
  "1d": DAY_MS, "1w": 7 * DAY_MS, "1m": 30 * DAY_MS, "3m": 90 * DAY_MS, "1y": 365 * DAY_MS, all: null,
};

/** The step a window reads at when the caller names none: hourly up to a week, then coarser. */
const STEP_FOR: Readonly<Record<SeriesWindow, SeriesStep>> = {
  "1d": "1h", "1w": "1h", "1m": "1d", "3m": "1d", "1y": "1w", all: "1mo",
};
export const stepFor = (window: SeriesWindow): SeriesStep => STEP_FOR[window];

const isStep = (v: string): v is SeriesStep => (SERIES_STEPS as readonly string[]).includes(v);
const isWindow = (v: string): v is SeriesWindow => (SERIES_WINDOWS as readonly string[]).includes(v);

/**
 * The bounds a window reads over. Explicit `from`/`to` (ISO) override the window; `to` defaults to
 * `now`; `from` is `null` only for `all` with no explicit start. Both ISO strings, UTC.
 */
export function rangeFor(
  window: SeriesWindow, from: string | null, to: string | null, now: Date,
): { from: string | null; to: string } {
  const toIso = to ?? now.toISOString();
  const span = WINDOW_MS[window];
  const fromIso = from ?? (span === null ? null : new Date(Date.parse(toIso) - span).toISOString());
  if (fromIso !== null && Date.parse(fromIso) >= Date.parse(toIso)) {
    throw badRequest(`'from' must be before 'to' — got ${fromIso} >= ${toIso}`, { parameter: "from" });
  }
  return { from: fromIso, to: toIso };
}

export type SeriesQuery = { step: SeriesStep; window: SeriesWindow; from: string | null; to: string };

/** Validate the raw step/window/from/to words from a query string or a body. 400 names the parameter. */
export function seriesQuery(
  raw: { step?: unknown; window?: unknown; from?: unknown; to?: unknown }, now: Date,
): SeriesQuery {
  const word = (v: unknown): string => (v === null || v === undefined ? "" : String(v)).trim().toLowerCase();
  const windowRaw = word(raw.window) || "1w";
  if (!isWindow(windowRaw)) {
    throw badRequest(`'window' must be one of ${SERIES_WINDOWS.join(", ")} — got '${windowRaw}'`,
      { parameter: "window", valid: SERIES_WINDOWS });
  }
  const stepRaw = word(raw.step) || stepFor(windowRaw);
  if (!isStep(stepRaw)) {
    throw badRequest(`'step' must be one of ${SERIES_STEPS.join(", ")} — got '${stepRaw}'`,
      { parameter: "step", valid: SERIES_STEPS });
  }
  const range = rangeFor(windowRaw, parseIso(raw.from, "from"), parseIso(raw.to, "to"), now);
  return { step: stepRaw, window: windowRaw, ...range };
}
