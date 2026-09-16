import { assertEquals } from "jsr:@std/assert@1";

// db.ts no longer touches the database at import; the pure helpers load with no env at all.
const { sellFlags, unsellable, chainCoverage, coverageLow, positionsPartialReason, portfolioFrom, latestIso } =
  await import("../supabase/functions/api/shared/positions-core.ts");

/*
 * /portfolio aggregates, derived in memory. Expected figures are what the former SQL produced:
 *   positions = count(*)                                         -> 6
 *   priced    = count(value) filter (value > 0)                  -> 4  (100, 50, 30, 20)
 *   total     = sum(value)  filter (value > 0 and not unsellable) -> 170 (100 + 50 + 20; honeypot 30 out)
 *   top_value = max(value)  filter (same)                        -> 100 (SOL)
 *   unsellable= sum(value)  filter (value > 0 and unsellable)    -> 30
 *   cash      = sum(value)  filter (value > 0 and quote)         -> 50
 *   byChain   = group by chain: solana 4/3/180 (honeypot IN), base 2/1/20; order by positions desc
 *   asOf      = max(captured_at)                                 -> 2026-09-17T00:00:00.000Z
 * Numerics are strings, as postgres.js hands them over.
 */
const SOL = 1399811149, BASE = 8453;
const PORTFOLIO_ROWS = [
  { address: "So11111111111111111111111111111111111111112", network_id: SOL, chain: "solana",
    value: "100", captured_at: "2026-09-16T00:00:00Z", is_quote: false, is_honeypot: null, can_not_sell: null },
  { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", network_id: SOL, chain: "solana",
    value: "50", captured_at: "2026-09-17T00:00:00Z", is_quote: true, is_honeypot: false, can_not_sell: false },
  { address: "HoneyPot111111111111111111111111111111111111", network_id: SOL, chain: "solana",
    value: "30", captured_at: "2026-09-16T00:00:00Z", is_quote: false, is_honeypot: true, can_not_sell: null },
  { address: "Unpriced1111111111111111111111111111111111111", network_id: SOL, chain: "solana",
    value: null, captured_at: "2026-09-16T00:00:00Z", is_quote: false, is_honeypot: null, can_not_sell: null },
  { address: "0x4200000000000000000000000000000000000006", network_id: BASE, chain: "base",
    value: "20", captured_at: "2026-09-15T00:00:00Z", is_quote: false, is_honeypot: false, can_not_sell: false },
  { address: "0x0000000000000000000000000000000000000000", network_id: BASE, chain: "base",
    value: "0", captured_at: "2026-09-15T00:00:00Z", is_quote: false, is_honeypot: null, can_not_sell: null },
];

Deno.test("portfolioFrom: totals, top, cash, unsellable and per-chain match the former SQL", () => {
  const p = portfolioFrom(PORTFOLIO_ROWS);
  assertEquals(p.positions, 6);
  assertEquals(p.priced, 4);
  assertEquals(p.total, 170);
  assertEquals(p.top, PORTFOLIO_ROWS[0]);
  assertEquals(p.unsellable, 30);
  assertEquals(p.cash, 50);
  assertEquals(p.asOf, "2026-09-17T00:00:00.000Z");
  assertEquals(p.byChain, [
    { chain: "solana", network_id: SOL, positions: 4, priced: 3, value: 180 },
    { chain: "base", network_id: BASE, positions: 2, priced: 1, value: 20 },
  ]);
  // The route's own derivations on top of these, as the former route computed them.
  assertEquals(Number((100 / p.total!).toFixed(4)), 0.5882);
  assertEquals(Number((p.cash / p.total!).toFixed(4)), 0.2941);
});

Deno.test("portfolioFrom: no rows / nothing sellable -> null total and top, as SQL sum/max over none", () => {
  const empty = portfolioFrom([]);
  assertEquals(empty, { asOf: null, positions: 0, priced: 0, total: null, top: null, unsellable: 0, cash: 0, byChain: [] });
  const onlyHoneypot = portfolioFrom([PORTFOLIO_ROWS[2], PORTFOLIO_ROWS[3]]);
  assertEquals(onlyHoneypot.priced, 1);
  assertEquals(onlyHoneypot.total, null);
  assertEquals(onlyHoneypot.top, null);
  assertEquals(onlyHoneypot.unsellable, 30);
  assertEquals(onlyHoneypot.byChain, [{ chain: "solana", network_id: SOL, positions: 2, priced: 1, value: 30 }]);
  assertEquals(latestIso([null, "2026-09-01T00:00:00Z", undefined, "2026-09-02T12:00:00Z"]), "2026-09-02T12:00:00.000Z");
  assertEquals(latestIso([]), null);
});

Deno.test("R6: coverage share is rows / nonce, null when either is unknown; partial composes", () => {
  const thin = chainCoverage({ chain_nonce: 35487, rows_held: 24, read_at: "2026-09-17T10:00:00Z" });
  assertEquals(thin, { chainTxCount: 35487, rowsHeld: 24, share: 0.0007, readAt: "2026-09-17T10:00:00.000Z" });
  assertEquals(chainCoverage({ chain_nonce: null, rows_held: 24, read_at: null }).share, null);
  assertEquals(chainCoverage({ chain_nonce: 0, rows_held: 0, read_at: null }).share, null);
  const full = chainCoverage({ chain_nonce: 10, rows_held: 9, read_at: null });
  assertEquals(coverageLow({ bsc: thin, base: full }), true);
  assertEquals(coverageLow({ base: full }), false);
  assertEquals(coverageLow({}), false);
  assertEquals(positionsPartialReason(false, false), null);
  assertEquals(positionsPartialReason(true, false), "unsellable_positions");
  assertEquals(positionsPartialReason(false, true), "indexer_coverage_low");
  assertEquals(positionsPartialReason(true, true), "unsellable_positions_and_indexer_coverage_low");
});

Deno.test("V2: honeypot / cannot-sell flags mark a row unsellable; unjudged stays null", () => {
  assertEquals(unsellable({ is_honeypot: true, can_not_sell: null }), true);
  assertEquals(unsellable({ is_honeypot: false, can_not_sell: true }), true);
  assertEquals(unsellable({ is_honeypot: null, can_not_sell: null }), false);
  assertEquals(sellFlags({ is_honeypot: null, can_not_sell: null }), { isHoneypot: false, canSell: null });
  assertEquals(sellFlags({ is_honeypot: true, can_not_sell: true }), { isHoneypot: true, canSell: false });
  assertEquals(sellFlags({ is_honeypot: false, can_not_sell: false }), { isHoneypot: false, canSell: true });
});
