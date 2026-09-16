import { assertEquals } from "jsr:@std/assert@1";

// db.ts no longer touches the database at import; the pure helpers load with no env at all.
const { sellFlags, unsellable, chainCoverage, coverageLow, positionsPartialReason } =
  await import("../supabase/functions/api/shared/positions-core.ts");

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
