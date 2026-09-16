import { n, round } from "../db.ts";

/** One `creators` row, as /tokens/:address and /creators/:address both publish it. */
// deno-lint-ignore no-explicit-any
export const ledgerBody = (r: any) =>
  r?.launches === null || r?.launches === undefined
    ? null
    : {
      launches: Number(r.launches),
      bestPeakMcapUsd: round(n(r.best_peak_mcap_usd)),
      bestToken: (r.best_token_key as string | null) ?? null,
      stillHoldingCount: Number(r.still_holding_count),
      soldCount: Number(r.sold_count),
      honeypotCount: Number(r.honeypot_count),
      lastLaunchAt: r.last_launch_at ? new Date(String(r.last_launch_at)).toISOString() : null,
    };
