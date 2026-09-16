import { assertEquals } from "jsr:@std/assert@1";
import { decideTotal, MAX_POSITION_USD, MAX_PRICE_PER_TOKEN, value } from "../supabase/functions/aum-sample/value.ts";

Deno.test("value: no price is a coverage gap, not a zero", () => {
  assertEquals(value(10, null), {});
  assertEquals(value(10, 0), {});
  assertEquals(value(10, NaN), {});
});

Deno.test("value: a price over the per-token ceiling is rejected before multiplying", () => {
  assertEquals(value(1, MAX_PRICE_PER_TOKEN + 1), { rejected: true });
});

Deno.test("value: a position over the USD ceiling is rejected", () => {
  assertEquals(value(MAX_POSITION_USD, 2), { rejected: true });
  assertEquals(value(2, 3), { usd: 6 });
});

Deno.test("decideTotal: nothing asked is null with the one reason, never 0", () => {
  assertEquals(decideTotal(0, 0, 0, 0, ["no_tokens_known"]), { totalUsd: null, reason: "no_tokens_known" });
  assertEquals(decideTotal(0, 0, 0, 0, ["wallet_unreadable", "no_tokens_known"]),
    { totalUsd: null, reason: "wallet_unreadable" });
});

Deno.test("decideTotal: 0 only when a chain answered and every answer was empty", () => {
  assertEquals(decideTotal(1, 0, 0, 0, ["wallet_unreadable"]), { totalUsd: 0, reason: null });
  assertEquals(decideTotal(2, 1, 12.5, 3, []), { totalUsd: 12.5, reason: null });
  assertEquals(decideTotal(1, 0, 0, 2, []), { totalUsd: null, reason: "no_prices" });
});
