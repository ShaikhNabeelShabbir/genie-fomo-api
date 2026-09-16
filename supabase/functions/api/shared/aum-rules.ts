import { n } from "../db.ts";

/** Window, step and refusal rules for /aum, kept pure so they can be tested without a database. */

/** The windows the route accepts, and how far back each reaches. */
export const AUM_WINDOWS: Record<string, number | null> = {
  "1d": 86_400_000,
  "1w": 7 * 86_400_000,
  "1m": 30 * 86_400_000,
  all: null,
};
/** THE SAME WINDOW, SPELLED THE WAY PEOPLE SPELL IT. See docs/DECISIONS.md#d014 */
export const WINDOW_ALIASES: Record<string, string> = {
  "24h": "1d", "1day": "1d",
  "7d": "1w", "1week": "1w", "7day": "1w",
  "30d": "1m", "1month": "1m", "30day": "1m", "1mo": "1m",
  everything: "all", lifetime: "all", max: "all",
};

/** Canonical window for a requested one, or null when it is not a window we serve. */
export function resolveWindow(raw: string): string | null {
  const k = raw.trim().toLowerCase();
  if (k in AUM_WINDOWS) return k;
  return WINDOW_ALIASES[k] ?? null;
}

/** Step sizes, coarsest last. The default picks the coarsest that still leaves >= 24 points. */
export const AUM_STEPS: { name: string; ms: number }[] = [
  { name: "1h", ms: 3_600_000 },
  { name: "6h", ms: 6 * 3_600_000 },
  { name: "1d", ms: 24 * 3_600_000 },
];

export const PRICED_FLOOR = 0.25;
/** A partial figure at least this large is served as partial rather than refused (R1). */
export const PARTIAL_SERVE_FLOOR_USD = 100;
/** Two dated figures are a line; fewer is not drawable. */
export const MIN_DRAWABLE_POINTS = 2;

export type StepChosenFrom = "window" | "tracked_span" | "fallback";

/**
 * The coarsest step that still leaves >= 24 buckets over the span; `all` (null span) takes the
 * coarsest. Given `trackedSpan` (now − trackedSince), the shorter of the two decides, so a
 * short record is not folded into one daily point (S1).
 */
export function chooseStep(
  span: number | null,
  trackedSpan: number | null = null,
): { name: string; ms: number; chosenFrom: StepChosenFrom } {
  const useTracked = trackedSpan !== null && (span === null || trackedSpan < span);
  const eff = useTracked ? trackedSpan : span;
  const step = [...AUM_STEPS].reverse().find((s) => eff === null || Math.floor(eff / s.ms) >= 24) ?? AUM_STEPS[0];
  return { ...step, chosenFrom: useTracked ? "tracked_span" : "window" };
}

/** A FIGURE BUILT FROM ALMOST NONE OF A WALLET IS NOT A BALANCE. See docs/DECISIONS.md#d016 */
/** THE REFUSED FIGURE IS KEPT, not discarded. See docs/DECISIONS.md#d017 */
/** A LARGE FIGURE BELOW THE COUNT FLOOR IS SERVED AS PARTIAL, not refused: the floor counts positions, not value (R1). */
export function applyFloor(r: Record<string, unknown>): Record<string, unknown> {
  const share = n(r.value_share);
  const total = n(r.total_usd);
  /* A served-partial row is returned as is: the route derives `partial` from `value_share`. */
  if (total === null || share === null || share >= PRICED_FLOOR || total >= PARTIAL_SERVE_FLOOR_USD) return r;
  return {
    ...r,
    total_usd: null,
    refused_reason: "too_little_priced",
    /** What `total_usd` would have been. Not a balance — see the note above. */
    partial_usd: total,
  };
}
