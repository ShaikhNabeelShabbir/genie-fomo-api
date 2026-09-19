import { assertEquals } from "jsr:@std/assert@1";
import { DAY_MS, PAIR, bybitList, parseKlines, seriesStartMs } from "../worker/src/jobs/quote_prices-core.ts";

// Expected values mirror scripts/load_quote_prices.mjs (the twin).

const D0 = Date.UTC(2026, 8, 1);
const kline = (openMs: number, close: string | number): unknown[] => [openMs, "1", "2", "0.5", close, "100", openMs + DAY_MS - 1];

Deno.test("parseKlines: day -> close from index 0 and 4, last open time and raw count", () => {
  const c = parseKlines([kline(D0, "150.25"), kline(D0 + DAY_MS, 151)]);
  assertEquals([...c.byDay], [["2026-09-01", 150.25], ["2026-09-02", 151]]);
  assertEquals(c.lastOpenMs, D0 + DAY_MS);
  assertEquals(c.count, 2);
});

Deno.test("parseKlines: a non-finite close is skipped but still counted; junk bodies parse to nothing", () => {
  const c = parseKlines([kline(D0, "abc"), "junk", kline(D0 + DAY_MS, 3)]);
  assertEquals([...c.byDay], [["2026-09-02", 3]]);
  assertEquals(c.count, 2);
  assertEquals(parseKlines({ code: -1 }), { byDay: new Map(), lastOpenMs: null, count: 0 });
});

Deno.test("seriesStartMs: the newest stored day minus one day of slack; a year back when none is stored", () => {
  const now = new Date(D0);
  assertEquals(seriesStartMs(new Date("2026-08-10T00:00:00Z"), now), Date.UTC(2026, 7, 9));
  assertEquals(seriesStartMs(null, now), D0 - 366 * DAY_MS);
});

Deno.test("PAIR: wSOL and SOL both price from SOLUSDT; an unmapped symbol is undefined", () => {
  assertEquals([PAIR.wSOL, PAIR.SOL, PAIR.WETH, PAIR.WBNB], ["SOLUSDT", "SOLUSDT", "ETHUSDT", "BNBUSDT"]);
  assertEquals(PAIR.USDC, undefined);
});

Deno.test("bybitList: candles come out of result.list, and parseKlines reads them as klines", () => {
  const body = {
    retCode: 0,
    result: {
      symbol: "BNBUSDT",
      // [startMs, open, high, low, close, volume, turnover] — open at 0 and close at 4, as a kline.
      list: [["1789603200000", "725.9", "729.2", "720.9", "725.1", "2146.0", "1556825.2"]],
    },
  };
  const closes = parseKlines(bybitList(body));
  assertEquals(closes.count, 1);
  assertEquals(closes.byDay.get("2026-09-17"), 725.1);
});

Deno.test("bybitList: a refusal or an unexpected envelope is an empty page, never a throw", () => {
  for (const body of [null, {}, { result: null }, { result: { list: "nope" } }, { retCode: 10001 }]) {
    assertEquals(bybitList(body).length, 0);
    assertEquals(parseKlines(bybitList(body)).count, 0);
  }
});

Deno.test("krakenList: Kraken names the pair its own way and stamps seconds; the closes come out as any kline's", async () => {
  const { krakenList, KRAKEN_PAIR, PAIR } = await import("../worker/src/jobs/quote_prices-core.ts");
  /* A real reply of 19 Sep 2026, trimmed: ETHUSD is answered as XETHZUSD, beside a `last` cursor. */
  const body = { error: [], result: { XETHZUSD: [[1727568000, "2675.74", "2683.66", "2635.50", "2657.89", "2657.17", "5689.9", 6177],
                                                 [1727654400, "2658.03", "2662.14", "2575.40", "2602.97", "2619.31", "8302.7", 9792]], last: 1727654400 } };
  const closes = parseKlines(krakenList(body));
  assertEquals([...closes.byDay.entries()], [["2024-09-29", 2657.89], ["2024-09-30", 2602.97]]);
  assertEquals(krakenList({ error: ["EQuery:Unknown asset pair"] }), []);
  assertEquals(krakenList(null), []);
  /* Every exchange pair the job can ask for has a Kraken spelling, or the fallback is a hole. */
  assertEquals([...new Set(Object.values(PAIR))].filter((p) => !(p in KRAKEN_PAIR)), []);
});
