import { assertEquals } from "jsr:@std/assert@1";

// db.ts no longer touches the database at import; the pure rules load with no env at all.
const { AUM_WINDOWS, PARTIAL_SERVE_FLOOR_USD, applyFloor, chooseStep, resolveWindow } = await import(
  "../supabase/functions/api/shared/aum-rules.ts"
);

Deno.test("resolveWindow: canonical keys and aliases, null otherwise", () => {
  assertEquals(resolveWindow("1w"), "1w");
  assertEquals(resolveWindow(" 30D "), "1m");
  assertEquals(resolveWindow("lifetime"), "all");
  assertEquals(resolveWindow("2y"), null);
});

Deno.test("chooseStep: coarsest step leaving >= 24 buckets; `all` takes 1d", () => {
  assertEquals(chooseStep(AUM_WINDOWS["1d"]).name, "1h");
  assertEquals(chooseStep(AUM_WINDOWS["1w"]).name, "6h");
  assertEquals(chooseStep(AUM_WINDOWS["1m"]).name, "1d");
  assertEquals(chooseStep(null).name, "1d");
  assertEquals(chooseStep(AUM_WINDOWS["1m"]).chosenFrom, "window");
});

Deno.test("chooseStep: a shorter tracked span decides the step", () => {
  const day = 86_400_000;
  assertEquals(chooseStep(AUM_WINDOWS["1m"], 6 * day), { name: "6h", ms: 6 * 3_600_000, chosenFrom: "tracked_span" });
  assertEquals(chooseStep(null, 1 * day), { name: "1h", ms: 3_600_000, chosenFrom: "tracked_span" });
  assertEquals(chooseStep(AUM_WINDOWS["1w"], 60 * day).chosenFrom, "window");
  assertEquals(chooseStep(AUM_WINDOWS["1w"], 60 * day).name, "6h");
});

Deno.test("applyFloor: below the priced floor AND below $100 is refused with the figure kept beside it", () => {
  const thin = applyFloor({ total_usd: "99.99", value_share: "0.2" });
  assertEquals(thin.total_usd, null);
  assertEquals(thin.refused_reason, "too_little_priced");
  assertEquals(thin.partial_usd, 99.99);
  const ok = { total_usd: "100", value_share: "0.25" };
  assertEquals(applyFloor(ok), ok);
  const refused = { total_usd: null, value_share: "0.1", refused_reason: "no_prices" };
  assertEquals(applyFloor(refused), refused);
});

Deno.test("applyFloor: below the priced floor but >= $100 is served, figure kept, nothing refused", () => {
  const served = applyFloor({ total_usd: String(PARTIAL_SERVE_FLOOR_USD), value_share: "0.2" });
  assertEquals(served, { total_usd: String(PARTIAL_SERVE_FLOOR_USD), value_share: "0.2" });
  const row = { total_usd: "150", value_share: "0.2" };
  const kept = applyFloor(row);
  assertEquals(kept.total_usd, "150");
  assertEquals(kept.refused_reason, undefined);
  assertEquals(kept.partial_usd, undefined);
});
