import { assertEquals } from "jsr:@std/assert@1";

// db.ts no longer touches the database at import; the pure helpers load with no env at all.
const { onChainFrom, chainEntriesFrom, chainExitsFrom } =
  await import("../supabase/functions/api/shared/scorecard-core.ts");
type Swap = Parameters<typeof onChainFrom>[0][number];

const swap = (o: Partial<Swap>): Swap => ({
  handle: "h", net: 1, tokenKey: "tok", txHash: "x", at: null, tokenDelta: 0, quoteUsd: null, ...o,
});
const onChain = (swaps: Swap[], seen: number) =>
  onChainFrom(swaps, seen, chainExitsFrom(swaps, chainEntriesFrom(swaps)));

Deno.test("T3: onChainFrom pairs sells against the average buy cost, like perExit", () => {
  const swaps = [
    swap({ at: "2026-09-01T00:00:00.000Z", tokenDelta: 10, quoteUsd: -100 }),   // buy 10 @ $10
    swap({ at: "2026-09-02T00:00:00.000Z", tokenDelta: 10, quoteUsd: -300 }),   // buy 10 @ $30 -> avg $20
    swap({ at: "2026-09-03T00:00:00.000Z", tokenDelta: -5, quoteUsd: 150 }),    // sell 5 @ $30: +50
    swap({ at: "2026-09-04T00:00:00.000Z", tokenDelta: -5, quoteUsd: 50 }),     // sell 5 @ $10: -50
    swap({ at: "2026-09-05T00:00:00.000Z", tokenKey: "unv", tokenDelta: -1 }),  // unvalued: not paired
  ];
  const b = onChain(swaps, 20);
  assertEquals(b.basis, "wallet_swaps");
  assertEquals([b.swaps, b.buys, b.sells], [5, 2, 3]);
  assertEquals(b.volumeUsd, 600);
  assertEquals([b.realizedPnlUsd, b.winRate, b.wins, b.losses], [0, 0.5, 1, 1]);
  assertEquals(b.coverage, { of: 5, total: 20, share: 0.25 });
  assertEquals(b.asOf, "2026-09-05T00:00:00.000Z");
});

Deno.test("T3: no resolved swaps is null figures, never zero; swaps stays a real count", () => {
  const b = onChain([], 1252);
  assertEquals(b.swaps, 0);
  assertEquals([b.buys, b.sells, b.volumeUsd, b.realizedPnlUsd, b.winRate, b.wins, b.losses, b.asOf],
               [null, null, null, null, null, null, null, null]);
  assertEquals(b.coverage, { of: 0, total: 1252, share: 0 });
  // Buys only: volume is real, but nothing has closed, so the P&L side is null.
  const open = onChain([swap({ tokenDelta: 3, quoteUsd: -30 })], 1);
  assertEquals([open.volumeUsd, open.realizedPnlUsd, open.winRate, open.wins], [30, null, null, null]);
});

const { coinMultiples } = await import("../supabase/functions/api/shared/scorecard-core.ts");

Deno.test("C1: coinMultiples divides by the weighted entry; the peak counts only after the first open", () => {
  const base = { entryPx: 2, exitPx: 10, currentPx: 1, athPx: 40, athAtMs: 200, firstOpenedMs: 100,
                 entryQty: 100, exitQty: 60 };
  assertEquals(coinMultiples(base),
    { multipleRealized: 5, multipleCurrent: 0.5, multiplePeak: 20, realizedShare: 0.6 });
  // High sampled before he bought: someone else's run, so no peak.
  assertEquals(coinMultiples({ ...base, athAtMs: 50 }).multiplePeak, null);
  // No entry price: nothing to divide by, and null is not 0.
  assertEquals(coinMultiples({ ...base, entryPx: null }),
    { multipleRealized: null, multipleCurrent: null, multiplePeak: null, realizedShare: 0.6 });
  // No entry quantity: no share; sold more than bought clamps to 1; nothing sold is a real 0.
  assertEquals(coinMultiples({ ...base, entryQty: null }).realizedShare, null);
  assertEquals(coinMultiples({ ...base, exitQty: 150 }).realizedShare, 1);
  assertEquals(coinMultiples({ ...base, exitQty: null }).realizedShare, 0);
});

const { compositeWindows } = await import("../supabase/functions/api/shared/scorecard-core.ts");
const DAY = 86_400_000;
const NOW = Date.parse("2026-09-17T00:00:00.000Z");
type Close = Parameters<typeof compositeWindows>[0][number];
const close = (daysAgo: number, realizedUsd: number | null, o: Partial<Close> = {}): Close =>
  ({ closedMs: NOW - daysAgo * DAY, openedMs: NOW - (daysAgo + 1) * DAY, realizedUsd, entryMcapUsd: null, ...o });

Deno.test("C2: medians, windows and bigWinMonths from closes and coins", () => {
  const closes = [close(1, 100), close(2, -50), close(3, 300), close(40, -10), close(60, null)];
  const coins = [
    { betUsd: 100, multipleRealized: 12, closedMonth: "2026-09", lastClosedMs: NOW - DAY },
    { betUsd: 300, multipleRealized: 6, closedMonth: "2026-08", lastClosedMs: NOW - 40 * DAY },
    { betUsd: null, multipleRealized: null, closedMonth: null, lastClosedMs: null },
  ];
  const w = compositeWindows(closes, coins, NOW);
  assertEquals([w.typicalBetPerCoinUsd, w.medianWinUsd, w.medianLossUsd, w.bigWinMonths], [200, 200, -30, 1]);
  assertEquals([w.recent.closes4w, w.recent.green4w], [3, 2]);
  assertEquals(w.recent.lastBigWinAt, new Date(NOW - DAY).toISOString());
  assertEquals(w.career.avgRealizedUsd, 85);
  assertEquals([w.career.holdHoursMedian, w.career.tradesPerDay], [24, 0.08]);
  assertEquals(w.recent.last20.redShare, 0.5);
  assertEquals(w.bleeding, false);
});

Deno.test("C2: bleeding fires on the floor only: a red streak, or recent trailing career by more than a typical bet", () => {
  // 25 closes: the 5 oldest made $1,000 each, the last 20 made $10 each. Career avg $208,
  // recent avg $10: the $198 gap clears a $100 floor and not a $300 one.
  const closes = [...Array(5)].map((_, i) => close(30 + i, 1000))
    .concat([...Array(20)].map((_, i) => close(i, 10)));
  const coin = (betUsd: number) => [{ betUsd, multipleRealized: null, closedMonth: null, lastClosedMs: null }];
  assertEquals(compositeWindows(closes, coin(100), NOW).bleeding, true);
  assertEquals(compositeWindows(closes, coin(300), NOW).bleeding, false);
  // No floor known: the gap test cannot run, and green closes are not bleeding.
  assertEquals(compositeWindows(closes, [], NOW).bleeding, false);
  // 12 of 20 red (60 %) fires whatever the floor; 11 does not.
  const red = (k: number) => [...Array(20)].map((_, i) => close(i, i < k ? -1 : 1));
  assertEquals(compositeWindows(red(12), coin(1e9), NOW).bleeding, true);
  assertEquals(compositeWindows(red(11), coin(1e9), NOW).bleeding, false);
  // No dated close at all: null, not false.
  const w = compositeWindows([], [], NOW);
  assertEquals([w.bleeding, w.medianWinUsd, w.bigWinMonths, w.recent.closes4w, w.career.avgRealizedUsd],
               [null, null, null, 0, null]);
});

const { exitTimingScoreFrom } = await import("../supabase/functions/api/shared/scorecard-core.ts");

Deno.test("C5: exitTimingScoreFrom counts coins now below the weighted exit, null under five priced coins", () => {
  const row = (exitPrice: number | null, currentPrice: number | null) => ({ exitPrice, currentPrice });
  const five = [row(10, 5), row(10, 20), row(1, 0.5), row(2, 1), row(3, 3)];
  assertEquals(exitTimingScoreFrom(five), 0.6);
  // Unpriced coins do not count towards the five, and a zero exit is no exit.
  assertEquals(exitTimingScoreFrom([...five.slice(0, 4), row(null, 1), row(4, null), row(0, 1)]), null);
  assertEquals(exitTimingScoreFrom([]), null);
});
