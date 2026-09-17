import { assertEquals } from "jsr:@std/assert@1";
import {
  DAILY_CLOSE_STALE_DAYS, ladderPrice, oldestUsableDay, unpackDaily,
} from "../supabase/functions/api/shared/price-ladder.ts";

Deno.test("ladderPrice: the rungs are taken in order", () => {
  const all = {
    pegged_usd: 1, stats_usd: 2, daily: "2026-09-16|3", info_usd: 4,
    stats_at: "2026-09-17T13:00:00Z", info_at: "2026-09-17T06:00:00Z",
  };
  assertEquals(ladderPrice(all)?.source, "pegged");
  assertEquals(ladderPrice({ ...all, pegged_usd: null })?.source, "token_price_stats");
  assertEquals(ladderPrice({ ...all, pegged_usd: null, stats_usd: null })?.source, "token_prices");
  assertEquals(ladderPrice({ pegged_usd: null, stats_usd: null, daily: null, info_usd: 4 })?.source, "token_info");
  assertEquals(ladderPrice({}), null);
});

Deno.test("ladderPrice: zero and negative are not prices, and each rung carries its own stamp", () => {
  /* 0 means "we hold no figure", never "this coin is worthless" — the repo's whole null rule. */
  assertEquals(ladderPrice({ pegged_usd: 0, stats_usd: 0, daily: "2026-09-16|0", info_usd: 0 }), null);
  assertEquals(ladderPrice({ pegged_usd: -1, stats_usd: -2 }), null);
  assertEquals(ladderPrice({ pegged_usd: 1 }), { usd: 1, source: "pegged", at: null });
  assertEquals(ladderPrice({ stats_usd: 2444.29, stats_at: "2026-09-17T13:00:00.000Z" }),
    { usd: 2444.29, source: "token_price_stats", at: "2026-09-17T13:00:00.000Z" });
  assertEquals(ladderPrice({ daily: "2026-09-16|725.9" }),
    { usd: 725.9, source: "token_prices", at: "2026-09-16T00:00:00.000Z" });
});

Deno.test("unpackDaily: the packed day|usd, and the junk it must refuse", () => {
  assertEquals(unpackDaily("2026-09-16|725.9"), { day: "2026-09-16", usd: 725.9 });
  assertEquals(unpackDaily(null), null);
  assertEquals(unpackDaily(""), null);
  assertEquals(unpackDaily("2026-09-16|"), null);
  assertEquals(unpackDaily("2026-09-16|0"), null);
  assertEquals(unpackDaily("|12"), null);
});

Deno.test("oldestUsableDay: the close window, as the day column spells it", () => {
  assertEquals(oldestUsableDay(new Date("2026-09-17T13:00:00Z")), "2026-09-10");
  assertEquals(DAILY_CLOSE_STALE_DAYS, 7);
});
