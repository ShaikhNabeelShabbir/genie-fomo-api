import { assertEquals } from "jsr:@std/assert@1";

// db.ts no longer touches the database at import; the pure helpers load with no env at all.
const { nextSixHourlySlot, stalenessFrom, onChainFrom } =
  await import("../supabase/functions/api/shared/scorecard-core.ts");

Deno.test("nextSixHourlySlot: the next 0 */6 UTC tick, never the current one", () => {
  const at = (s: string) => nextSixHourlySlot(Date.parse(s));
  assertEquals(at("2026-09-18T05:59:59Z"), "2026-09-18T06:00:00.000Z");
  assertEquals(at("2026-09-18T06:00:00Z"), "2026-09-18T12:00:00.000Z");
  assertEquals(at("2026-09-18T06:00:01Z"), "2026-09-18T12:00:00.000Z");
  assertEquals(at("2026-09-18T18:30:00Z"), "2026-09-19T00:00:00.000Z");
  assertEquals(at("2026-12-31T23:00:00Z"), "2027-01-01T00:00:00.000Z");
});

const NOW = Date.parse("2026-09-18T06:00:00Z");
/** An onChain block with `swaps` rows against `seen` swap-shaped transactions (the route's coverage). */
const block = (swaps: number, seen: number) => ({
  ...onChainFrom([], seen, []), swaps,
  coverage: { of: swaps, total: seen, share: seen ? Number((swaps / seen).toFixed(4)) : null },
});

Deno.test("stalenessFrom: current, stale and never from loadedAt against 72 h", () => {
  assertEquals(stalenessFrom("2026-09-17T06:00:00Z", null, NOW).state, "current");
  assertEquals(stalenessFrom("2026-09-15T06:00:00Z", null, NOW).state, "current");
  assertEquals(stalenessFrom("2026-09-15T05:59:59Z", null, NOW).state, "stale");
  assertEquals(stalenessFrom(null, null, NOW), {
    state: "never", ageSeconds: null, staleAfterHours: 72, fallback: null, fallbackReason: null,
  });
});

Deno.test("T3: on_chain only when the swap store covers half the profile's swaps; else swap_store_incomplete", () => {
  const stale = "2026-09-01T00:00:00Z";
  const pick = (s: ReturnType<typeof stalenessFrom>) => [s.fallback, s.fallbackReason];
  assertEquals(pick(stalenessFrom(stale, block(627, 1254), NOW)), ["on_chain", null]);
  assertEquals(pick(stalenessFrom(stale, block(4, 1254), NOW)), [null, "swap_store_incomplete"]);
  assertEquals(pick(stalenessFrom(stale, block(0, 0), NOW)), [null, "swap_store_incomplete"]);
  assertEquals(pick(stalenessFrom(null, block(626, 1254), NOW)), [null, "swap_store_incomplete"]);
  /* A current record needs no fallback; the embedded scorecard computes no onChain block at all. */
  assertEquals(pick(stalenessFrom("2026-09-17T06:00:00Z", block(4, 1254), NOW)), [null, null]);
  assertEquals(pick(stalenessFrom(stale, null, NOW)), [null, null]);
});
