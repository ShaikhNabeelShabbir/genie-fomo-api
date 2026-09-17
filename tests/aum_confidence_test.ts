import { assertEquals } from "jsr:@std/assert@1";
import {
  PRICED_FLOOR, PUBLISH_FLOOR, confidence, fillHourGaps, pricedShare,
} from "../supabase/functions/api/shared/aum-history-rules.ts";

Deno.test("confidence: a figure above the priced floor is a figure", () => {
  assertEquals(confidence({ totalUsd: 351321.95, pricedPositions: 217, totalPositions: 279, reason: null }), {
    totalUsd: 351321.95, partial: false, partialUsd: null, pricedShare: 0.7778, reason: null,
  });
});

Deno.test("confidence: between the floors it is published and labelled partial", () => {
  /* 30 of 279 is 10.75%: over the publish floor, under the priced floor. */
  assertEquals(confidence({ totalUsd: 1685.57, pricedPositions: 30, totalPositions: 279, reason: null }), {
    totalUsd: 1685.57, partial: true, partialUsd: null, pricedShare: 0.1075, reason: null,
  });
});

Deno.test("confidence: A4 — the 2-of-289 rung is withheld, and its figure is kept apart", () => {
  /* 397397's flat $43,780.82, built from 0.7% of his wallet and served as a balance. */
  assertEquals(confidence({ totalUsd: 43780.82, pricedPositions: 2, totalPositions: 289, reason: null }), {
    totalUsd: null, partial: false, partialUsd: 43780.82, pricedShare: 0.0069,
    reason: "too_little_priced",
  });
});

Deno.test("confidence: a stored null keeps its own reason and is never called partial", () => {
  assertEquals(confidence({ totalUsd: null, pricedPositions: 0, totalPositions: 11278, reason: "no_prices" }), {
    totalUsd: null, partial: false, partialUsd: null, pricedShare: 0, reason: "no_prices",
  });
  /* No holdings at all: a share of nothing is null, not zero. */
  assertEquals(confidence({ totalUsd: null, pricedPositions: 0, totalPositions: 0, reason: "no_holdings" }).pricedShare, null);
});

Deno.test("confidence: the two floors are the documented ones", () => {
  assertEquals([PUBLISH_FLOOR, PRICED_FLOOR], [0.05, 0.25]);
  assertEquals(pricedShare(1135, 11301), 0.1004);
  assertEquals(pricedShare(0, 0), null);
});

Deno.test("fillHourGaps: A3 — a missing hour is a null point, never a hole", () => {
  const pts: { at: string; totalUsd: number | null }[] = [
    { at: "2026-09-17T07:00:00.000Z", totalUsd: 1 },
    { at: "2026-09-17T10:00:00.000Z", totalUsd: 2 },
  ];
  const out = fillHourGaps(pts, (at) => ({ at, totalUsd: null }));
  assertEquals(out.map((p) => p.at), [
    "2026-09-17T07:00:00.000Z", "2026-09-17T08:00:00.000Z",
    "2026-09-17T09:00:00.000Z", "2026-09-17T10:00:00.000Z",
  ]);
  assertEquals(out.map((p) => p.totalUsd), [1, null, null, 2]);
});

Deno.test("fillHourGaps: nothing is invented outside the points we hold", () => {
  assertEquals(fillHourGaps([], (at) => ({ at })), []);
  const one = [{ at: "2026-09-17T07:00:00.000Z" }];
  assertEquals(fillHourGaps(one, (at) => ({ at })), one);
  /* Contiguous hours gain nothing. */
  const two = [{ at: "2026-09-17T07:00:00.000Z" }, { at: "2026-09-17T08:00:00.000Z" }];
  assertEquals(fillHourGaps(two, (at) => ({ at })).length, 2);
});
