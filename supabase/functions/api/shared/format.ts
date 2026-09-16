import { round } from "../db.ts";

// ============================================================================
// The three below are NOT ports. The Express versions call fomoapi live on every
// request; these read the `trades` table the loader fills once a day. That is the
// whole point of the migration — and it is what turns K5-K8 from a 25-holder,
// 45-second fan-out into a query over all 896 rankable tokens.
// ============================================================================

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const cov = (of: number, total: number) => ({
  of, total, share: total ? Number((of / total).toFixed(4)) : null,
});
export const money = (v: number) =>
  `${v < 0 ? "-" : ""}$${Math.abs(Math.round(v)).toLocaleString("en-US")}`;
