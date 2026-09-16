import { assertEquals } from "jsr:@std/assert@1";
import { MAX_POSITION_USD, MAX_PRICE_PER_TOKEN, value } from "../supabase/functions/aum-sample/value.ts";

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
