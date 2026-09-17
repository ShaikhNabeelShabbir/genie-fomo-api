import { assertEquals, assertThrows } from "jsr:@std/assert@1";

// Pure step/window rules; db.ts does not touch the database at import.
const { rangeFor, seriesQuery, stepFor } = await import("../supabase/functions/api/shared/series-rules.ts");

const NOW = new Date("2026-09-18T12:00:00.000Z");
type Thrown = { status: number; extra?: { parameter?: string } };

Deno.test("stepFor: hourly up to a week, daily to a quarter, weekly for a year, monthly for all", () => {
  assertEquals(stepFor("1d"), "1h");
  assertEquals(stepFor("1w"), "1h");
  assertEquals(stepFor("1m"), "1d");
  assertEquals(stepFor("3m"), "1d");
  assertEquals(stepFor("1y"), "1w");
  assertEquals(stepFor("all"), "1mo");
});

Deno.test("rangeFor: the window counts back from now; `all` has no start", () => {
  assertEquals(rangeFor("1d", null, null, NOW), { from: "2026-09-17T12:00:00.000Z", to: NOW.toISOString() });
  assertEquals(rangeFor("1w", null, null, NOW).from, "2026-09-11T12:00:00.000Z");
  assertEquals(rangeFor("all", null, null, NOW), { from: null, to: NOW.toISOString() });
});

Deno.test("rangeFor: explicit from/to override the window; from after to is a 400", () => {
  assertEquals(rangeFor("1m", "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z", NOW),
    { from: "2026-09-01T00:00:00.000Z", to: "2026-09-02T00:00:00.000Z" });
  assertEquals(rangeFor("1d", null, "2026-09-10T00:00:00.000Z", NOW).from, "2026-09-09T00:00:00.000Z");
  const e = assertThrows(() => rangeFor("1d", "2026-09-18T13:00:00.000Z", null, NOW)) as Thrown;
  assertEquals(e.status, 400);
  assertEquals(e.extra?.parameter, "from");
});

Deno.test("seriesQuery: defaults, case-insensitive words, and named 400s", () => {
  assertEquals(seriesQuery({}, NOW).window, "1w");
  assertEquals(seriesQuery({}, NOW).step, "1h");
  assertEquals(seriesQuery({ window: " 1Y " }, NOW).step, "1w");
  assertEquals(seriesQuery({ window: "1y", step: "1D" }, NOW).step, "1d");
  assertEquals((assertThrows(() => seriesQuery({ step: "5m" }, NOW)) as Thrown).extra?.parameter, "step");
  assertEquals((assertThrows(() => seriesQuery({ window: "2y" }, NOW)) as Thrown).extra?.parameter, "window");
  assertEquals((assertThrows(() => seriesQuery({ to: "yesterday" }, NOW)) as Thrown).extra?.parameter, "to");
});
