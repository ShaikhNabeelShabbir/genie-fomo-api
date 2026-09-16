import { assertEquals } from "jsr:@std/assert@1";

const { regimeFrom, RULE } = await import("../supabase/functions/api/routes/market.ts");

Deno.test("regimeFrom: green share sets the step at the published edges", () => {
  assertEquals(regimeFrom(1, null), "open");
  assertEquals(regimeFrom(RULE.cautionBelow, null), "open");
  assertEquals(regimeFrom(0.4999, null), "caution");
  assertEquals(regimeFrom(RULE.closedBelow, null), "caution");
  assertEquals(regimeFrom(0.2499, null), "closed");
  assertEquals(regimeFrom(0, null), "closed");
});

Deno.test("regimeFrom: survival below the floor downgrades one step, never past closed", () => {
  assertEquals(regimeFrom(0.6, RULE.survivalDowngradeBelow), "open");
  assertEquals(regimeFrom(0.6, 0.0999), "caution");
  assertEquals(regimeFrom(0.3, 0.05), "closed");
  assertEquals(regimeFrom(0.1, 0), "closed");
});

Deno.test("regimeFrom: no green-share reading means no regime", () => {
  assertEquals(regimeFrom(null, 0.5), null);
  assertEquals(regimeFrom(null, null), null);
});
