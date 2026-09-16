import { assertEquals } from "jsr:@std/assert@1";

const { ledgerBody } = await import("../supabase/functions/api/shared/creators-core.ts");

Deno.test("gap 5a: ledgerBody is null without a creators row, and never coerces a missing peak to 0", () => {
  assertEquals(ledgerBody({ launches: null }), null);
  assertEquals(ledgerBody(undefined), null);
  assertEquals(
    ledgerBody({
      launches: "3", best_peak_mcap_usd: "1035942.504", best_token_key: "0xabc",
      still_holding_count: 2, sold_count: 1, honeypot_count: 0, last_launch_at: "2026-09-10T00:00:00Z",
    }),
    {
      launches: 3, bestPeakMcapUsd: 1035942.5, bestToken: "0xabc",
      stillHoldingCount: 2, soldCount: 1, honeypotCount: 0, lastLaunchAt: "2026-09-10T00:00:00.000Z",
    },
  );
  const bare = ledgerBody({ launches: 1, best_peak_mcap_usd: null, best_token_key: null,
    still_holding_count: 0, sold_count: 0, honeypot_count: 0, last_launch_at: null });
  assertEquals([bare?.bestPeakMcapUsd, bare?.bestToken, bare?.lastLaunchAt], [null, null, null]);
});
