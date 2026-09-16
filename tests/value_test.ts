import { assertEquals } from "jsr:@std/assert@1";
import {
  IMPLIED_MCAP_CEILING_USD, MAX_POSITION_USD, MAX_PRICE_PER_TOKEN,
  concentrationSuspect, priceSuspectReason, value,
} from "../supabase/functions/aum-sample/value.ts";

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

Deno.test("value: a price whose implied market cap tops the ceiling is rejected; unknown supply is not checked", () => {
  const price = IMPLIED_MCAP_CEILING_USD / 1e9 + 1;      // x 1e9 supply = just over the ceiling
  assertEquals(value(1, price, 1e9), { rejected: true });
  assertEquals(value(1, price, null), { usd: price });
  assertEquals(value(1, price, 0), { usd: price });
  assertEquals(value(1, 2, 1e9), { usd: 2 });
});

Deno.test("concentrationSuspect: one coin over 90% refuses the reading unless its cap is known and the total is sane", () => {
  assertEquals(concentrationSuspect(95, 100, false), true);
  assertEquals(concentrationSuspect(95, 100, true), false);
  assertEquals(concentrationSuspect(0.95e10, 1e10, true), true);
  assertEquals(concentrationSuspect(50, 100, false), false);
  assertEquals(concentrationSuspect(0, 0, false), false);
});

Deno.test("priceSuspectReason: names the failed check on a /positions row, or null", () => {
  assertEquals(priceSuspectReason(null, 1e9, null, 100), null);
  assertEquals(priceSuspectReason(8923.86, 999_917_541, 1.015e11, 1.016e11), "implied_mcap_over_ceiling");
  assertEquals(priceSuspectReason(1019.42, null, 14.7e6, 14.8e6), "concentration_over_ceiling");
  assertEquals(priceSuspectReason(1.18, 1e9, 27e6, 1.016e11), null);
});
