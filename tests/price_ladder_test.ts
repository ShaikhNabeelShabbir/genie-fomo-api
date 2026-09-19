import { assertEquals } from "jsr:@std/assert@1";
import {
  DAILY_CLOSE_STALE_DAYS, INFO_STALE_DAYS, infoFresh, ladderPrice, oldestUsableDay, STATS_STALE_HOURS, statsFresh, unpackDaily,
} from "../supabase/functions/api/shared/price-ladder.ts";

const NOW = new Date("2026-09-17T14:00:00Z");

Deno.test("ladderPrice: the rungs are taken in order", () => {
  const all = {
    pegged_usd: 1, stats_usd: 2, daily: "2026-09-16|3", info_usd: 4,
    stats_at: "2026-09-17T13:00:00Z", info_at: "2026-09-17T06:00:00Z",
  };
  assertEquals(ladderPrice(all, NOW)?.source, "pegged");
  assertEquals(ladderPrice({ ...all, pegged_usd: null }, NOW)?.source, "token_price_stats");
  assertEquals(ladderPrice({ ...all, pegged_usd: null, stats_usd: null }, NOW)?.source, "token_prices");
  assertEquals(ladderPrice({ pegged_usd: null, stats_usd: null, daily: null, info_usd: 4, info_at: all.info_at }, NOW)?.source, "token_info");
  assertEquals(ladderPrice({}, NOW), null);
});

Deno.test("ladderPrice: a price past its rung's age prices nothing — the next rung, else null, never an old figure", () => {
  /* claims F5: with DexScreener refusing us, 2-to-10-day-old prices were served as current. */
  const old = { stats_usd: 5, stats_at: "2026-09-15T12:00:00.000Z", info_usd: 4, info_at: "2026-09-09T06:00:00.000Z" };
  assertEquals(ladderPrice(old, NOW), null, "stats 50 h old, GMGN 8 days old: unpriced");
  assertEquals(ladderPrice({ ...old, daily: "2026-09-16|3" }, NOW)?.source, "token_prices", "an aged hourly price falls to the close");
  assertEquals(ladderPrice({ ...old, info_at: "2026-09-12T06:00:00.000Z" }, NOW)?.source, "token_info", "GMGN's is usable for a week");
  assertEquals(ladderPrice({ stats_usd: 5 }, NOW), null, "no stamp, no proof of age");
  assertEquals(ladderPrice({ pegged_usd: 1, ...old }, NOW)?.source, "pegged", "a peg does not age");

  assertEquals([STATS_STALE_HOURS, INFO_STALE_DAYS], [24, 7]);
  assertEquals(statsFresh("2026-09-16T14:00:00.000Z", NOW), true, "exactly 24 h is still usable");
  assertEquals(statsFresh("2026-09-16T13:59:59.999Z", NOW), false);
  assertEquals(infoFresh("2026-09-10T14:00:00.000Z", NOW), true);
  assertEquals(infoFresh("2026-09-10T13:59:59.999Z", NOW), false);
  assertEquals([statsFresh(null, NOW), statsFresh("not a date", NOW), infoFresh(undefined, NOW)], [false, false, false]);
});

Deno.test("ladderPrice: zero and negative are not prices, and each rung carries its own stamp", () => {
  /* 0 means "we hold no figure", never "this coin is worthless" — the repo's whole null rule. */
  assertEquals(ladderPrice({ pegged_usd: 0, stats_usd: 0, stats_at: NOW, daily: "2026-09-16|0", info_usd: 0, info_at: NOW }, NOW), null);
  assertEquals(ladderPrice({ pegged_usd: -1, stats_usd: -2, stats_at: NOW }, NOW), null);
  assertEquals(ladderPrice({ pegged_usd: 1 }, NOW), { usd: 1, source: "pegged", at: null });
  assertEquals(ladderPrice({ stats_usd: 2444.29, stats_at: "2026-09-17T13:00:00.000Z" }, NOW),
    { usd: 2444.29, source: "token_price_stats", at: "2026-09-17T13:00:00.000Z" });
  assertEquals(ladderPrice({ daily: "2026-09-16|725.9" }, NOW),
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
