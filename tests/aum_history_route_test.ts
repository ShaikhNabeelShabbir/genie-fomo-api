import { assertEquals } from "jsr:@std/assert@1";
import {
  HISTORY_STEPS, HISTORY_WINDOWS, HistoryWindow, defaultStep, windowRange, isHistoryStep, isHistoryWindow,
} from "../supabase/functions/api/shared/aum-history-rules.ts";

Deno.test("defaultStep: every window implies the documented step", () => {
  assertEquals(defaultStep("1d"), "1h");
  assertEquals(defaultStep("1w"), "1h");
  assertEquals(defaultStep("1m"), "1d");
  assertEquals(defaultStep("3m"), "1d");
  assertEquals(defaultStep("1y"), "1w");
  assertEquals(defaultStep("all"), "1mo");
  for (const w of Object.keys(HISTORY_WINDOWS) as HistoryWindow[]) assertEquals(isHistoryStep(defaultStep(w)), true);
});

Deno.test("windowRange: bounded windows end now and start span earlier; all has no lower bound", () => {
  const now = new Date("2026-09-18T12:00:00.000Z");
  assertEquals(windowRange("1d", now), { from: "2026-09-17T12:00:00.000Z", to: "2026-09-18T12:00:00.000Z" });
  assertEquals(windowRange("1w", now), { from: "2026-09-11T12:00:00.000Z", to: "2026-09-18T12:00:00.000Z" });
  assertEquals(windowRange("1m", now).from, "2026-08-19T12:00:00.000Z");
  assertEquals(windowRange("3m", now).from, "2026-06-20T12:00:00.000Z");
  assertEquals(windowRange("1y", now).from, "2025-09-18T12:00:00.000Z");
  assertEquals(windowRange("all", now), { from: null, to: "2026-09-18T12:00:00.000Z" });
});

Deno.test("isHistoryStep / isHistoryWindow: only the published words", () => {
  assertEquals([...HISTORY_STEPS], ["1h", "1d", "1w", "1mo"]);
  assertEquals(isHistoryStep("1M"), false);
  assertEquals(isHistoryStep("1mo"), true);
  assertEquals(isHistoryWindow("2w"), false);
  assertEquals(isHistoryWindow("all"), true);
});
