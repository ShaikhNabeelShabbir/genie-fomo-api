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
