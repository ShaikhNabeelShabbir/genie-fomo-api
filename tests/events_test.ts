import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { encodeCursor } from "../supabase/functions/api/shared/cursor.ts";
import { ApiError } from "../supabase/functions/api/errors.ts";
import {
  decodeEventCursor, encodeEventCursor, toEvent, type EventRow,
} from "../supabase/functions/api/routes/events.ts";

const row = (over: Partial<EventRow>): EventRow => ({
  kind: "transfer", at: "2026-09-17T10:00:00.000Z", id: "0xabc", sub: "unipcs|1|0xw|leg1",
  handle: "unipcs", display_handle: "Unipcs", trader_source: "fomoapi.io",
  chain: "solana", direction: "in", token_address: "So111", amount: "12.5",
  counterparty: "Cp1", source: "PUMP_FUN", tx_type: "SWAP",
  token_delta: null, quote_delta: null, quote_usd: null,
  total_usd: null, refused_reason: null,
  has_info: false, is_honeypot: null, can_not_sell: null,
  ...over,
});

Deno.test("event cursor: round-trips, and rejects shapes from other routes", () => {
  const c = { at: "2026-09-17T10:00:00.000Z", kind: "swap" as const, id: "0xabc", sub: "unipcs|1|0xw" };
  assertEquals(decodeEventCursor(encodeEventCursor(c)), c);
  /* A cursor handed out before `sub` existed still decodes, and resumes before every leg of its transaction. */
  assertEquals(decodeEventCursor(encodeCursor([c.at, c.kind, c.id])), { ...c, sub: "" });
  for (const bad of [
    encodeCursor(["2026-09-17T10:00:00.000Z", "0xabc"]),          // transactions-shaped
    encodeCursor(["2026-09-17T10:00:00.000Z", "trade", "0xabc"]), // unknown kind
    encodeCursor(["not a date", "swap", "0xabc"]),
    encodeCursor(["2026-09-17T10:00:00.000Z", "swap", "0xabc", 7]),
    "garbage!",
  ]) {
    const e = assertThrows(() => decodeEventCursor(bad), ApiError);
    assertEquals([e.status, e.code], [400, "bad_request"]);
  }
});

Deno.test("toEvent: one shape per kind, gates null without a token_info row", () => {
  const transfer = toEvent(row({}));
  assertEquals(transfer, {
    kind: "transfer", at: "2026-09-17T10:00:00.000Z", handle: "Unipcs", traderSource: "fomoapi.io",
    chain: "solana", tokenAddress: "So111", txHash: "0xabc", gates: null,
    direction: "in", amount: 12.5, counterparty: "Cp1", source: "PUMP_FUN", txType: "SWAP",
  });

  const swap = toEvent(row({
    kind: "swap", token_delta: "100", quote_delta: "-1.5", quote_usd: "-210.456",
    has_info: true, is_honeypot: true, can_not_sell: null,
  }));
  assertEquals(swap.kind, "swap");
  /* H2 (v5 fixes): a confirmed honeypot cannot be sold, whatever `can_not_sell` says. */
  assertEquals((swap as { gates: unknown }).gates, { isHoneypot: true, canSell: false, priceSuspect: null });
  assertEquals((swap as { quoteUsd: unknown }).quoteUsd, -210.46);
  assertEquals("direction" in swap, false);

  const refused = toEvent(row({ kind: "reading", id: "unipcs", total_usd: null, refused_reason: "no_prices" }));
  assertEquals(refused, {
    kind: "reading", at: "2026-09-17T10:00:00.000Z", handle: "Unipcs", traderSource: "fomoapi.io",
    totalUsd: null, refusedReason: "no_prices",
  });
});
