import { assertEquals } from "jsr:@std/assert@1";
import {
  IMPLIED_MCAP_CEILING_USD, MAX_POSITION_USD, MAX_PRICE_PER_TOKEN, NO_MARKET_CEILING_USD,
  concentrationSuspect, decideTotal, noMarketSuspect, priceSuspectReason, suspectRows, value,
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
  // V1b: no supply to check and the one position tops the USD ceiling: suspect whatever its share.
  assertEquals(priceSuspectReason(8923.86, null, 291e9, 473e9), "concentration_over_ceiling");
  assertEquals(priceSuspectReason(8923.86, null, 291e9, 291e9), "concentration_over_ceiling");
});

Deno.test("suspectRows: two absurd coins in one wallet are both flagged, the sane remainder is not (V1b)", () => {
  const rows = [
    { price: 8923.86, supply: null, usd: 291e9, liquidityUsd: null },   // cupseyy's $291B coin, no supply row
    { price: 1019.42, supply: null, usd: 182e9, liquidityUsd: null },   // the second absurd one, 38 % of the gross
    { price: 1.18, supply: 1e9, usd: 27e6, liquidityUsd: 40e6 },
    { price: null, supply: null, usd: null, liquidityUsd: null },
  ];
  assertEquals(suspectRows(rows), ["concentration_over_ceiling", "concentration_over_ceiling", null, null]);
  // Under the USD ceiling the iteration alone catches the second: 95 of 100 with cap unknown, then 4.6 of 5.
  assertEquals(suspectRows([{ price: 1, supply: null, usd: 95, liquidityUsd: 1e4 }, { price: 1, supply: null, usd: 4.6, liquidityUsd: 1e4 }, { price: 1, supply: 1e6, usd: 0.4, liquidityUsd: 1e4 }]),
    ["concentration_over_ceiling", "concentration_over_ceiling", null]);
  // A known cap and a sane total: nothing is flagged, however concentrated.
  assertEquals(suspectRows([{ price: 1, supply: 1e6, usd: 95, liquidityUsd: 1e4 }, { price: 1, supply: 1e6, usd: 5, liquidityUsd: 1e4 }]), [null, null]);
  // An implied-cap failure is flagged first and leaves the base to the rest.
  assertEquals(suspectRows([{ price: 100, supply: 1e9, usd: 10, liquidityUsd: 1e4 }, { price: 1, supply: null, usd: 50, liquidityUsd: 1e4 }, { price: 1, supply: 1e6, usd: 40, liquidityUsd: 1e4 }]),
    ["implied_mcap_over_ceiling", null, null]);
  assertEquals(suspectRows([]), []);
});

Deno.test("noMarketSuspect: over 10x the pool, or over the ceiling with no pool known", () => {
  assertEquals(noMarketSuspect(14.7e6, 12e3), true);
  assertEquals(noMarketSuspect(5e6, 40e6), false);
  assertEquals(noMarketSuspect(NO_MARKET_CEILING_USD + 1, null), true);
  assertEquals(noMarketSuspect(500e3, null), false);
  assertEquals(noMarketSuspect(null, null), false);
});

Deno.test("suspectRows: no market behind the price is flagged on every row, not only the largest (V1d)", () => {
  // cupseyy-shaped: three absurd coins, each under 90 % of the remaining base, no pair anywhere.
  assertEquals(suspectRows([
    { price: 10, supply: null, usd: 800e6, liquidityUsd: null },
    { price: 10, supply: null, usd: 800e6, liquidityUsd: null },
    { price: 10, supply: null, usd: 800e6, liquidityUsd: null },
  ]), ["no_market_over_ceiling", "no_market_over_ceiling", "no_market_over_ceiling"]);
  // shahh-shaped: supply known, cap under $20B, 99.5 % of the wallet, but a $12k pool.
  assertEquals(suspectRows([
    { price: 1019.42, supply: 1e6, usd: 14.7e6, liquidityUsd: 12e3 },
    { price: 1, supply: 1e9, usd: 70e3, liquidityUsd: 5e6 },
  ]), ["no_market_over_ceiling", null]);
  // A real whale in a deep pool, and a mid-size position with no pair known: neither is flagged.
  assertEquals(suspectRows([
    { price: 2, supply: 1e9, usd: 5e6, liquidityUsd: 40e6 },
    { price: 1, supply: null, usd: 500e3, liquidityUsd: null },
  ]), [null, null]);
});

Deno.test("decideTotal: nothing asked is null with the most common failure word, never 0", () => {
  assertEquals(decideTotal(0, 0, 0, 0, ["no_tokens_known"]), { totalUsd: null, reason: "no_tokens_known" });
  assertEquals(decideTotal(0, 0, 0, 0, ["wallet_unreadable", "no_tokens_known", "no_tokens_known"]),
    { totalUsd: null, reason: "no_tokens_known" });
  assertEquals(decideTotal(0, 0, 0, 0, ["service_timeout", "no_tokens_known"]),
    { totalUsd: null, reason: "service_timeout" });
});

Deno.test("decideTotal: no chain asked at all is nothing_answered, not wallet_unreadable", () => {
  assertEquals(decideTotal(0, 0, 0, 0, []), { totalUsd: null, reason: "nothing_answered" });
});

Deno.test("decideTotal: 0 only when a chain answered and every answer was empty", () => {
  assertEquals(decideTotal(1, 0, 0, 0, ["wallet_unreadable"]), { totalUsd: 0, reason: null });
  assertEquals(decideTotal(2, 1, 12.5, 3, []), { totalUsd: 12.5, reason: null });
  assertEquals(decideTotal(1, 0, 0, 2, []), { totalUsd: null, reason: "no_prices" });
});

Deno.test("suspectRows: N1 — a wallet that is all ETH is not a broken price", () => {
  /* The native sentinel carries no total_supply, so capKnown is false and the row is 100% of
     the total: without the exemption this is concentration_over_ceiling and the trader's whole
     balance disappears into suspectUsd. */
  const nativeOnly = [
    { price: 2464.97, supply: null, usd: 2889.02, liquidityUsd: null, quoteAsset: true },
    { price: 1.5e-7, supply: null, usd: 7.6e-7, liquidityUsd: null, quoteAsset: false },
  ];
  assertEquals(suspectRows(nativeOnly), [null, null]);
  /* Without the flag, the same rows are exactly the bug this exempts. */
  assertEquals(suspectRows(nativeOnly.map((r) => ({ ...r, quoteAsset: false })))[0],
    "concentration_over_ceiling");
});

Deno.test("suspectRows: a quote asset skips the no-market check, an unknown coin does not", () => {
  /* Over $1M with no pool known is no_market_over_ceiling — unless it is a dollar coin.
     A known supply keeps the concentration rule (which fires first) out of the way. */
  const usdc = { price: 1, supply: 1e6, usd: 1_059_250.04, liquidityUsd: null, quoteAsset: true };
  const memecoin = { ...usdc, quoteAsset: false };
  assertEquals(suspectRows([usdc]), [null]);
  assertEquals(suspectRows([memecoin]), ["no_market_over_ceiling"]);
});

Deno.test("suspectRows: the exemption does not shelter a broken price or the rest of the wallet", () => {
  /* Implied market cap still applies to a quote asset with a supply we can check. */
  assertEquals(
    suspectRows([{ price: 1e9, supply: 1e9, usd: 10, liquidityUsd: null, quoteAsset: true }]),
    ["implied_mcap_over_ceiling"],
  );
  /* An exempt row stays in the base, so a junk row beside it is still judged against real value. */
  const [eth, junk] = suspectRows([
    { price: 2464.97, supply: null, usd: 2_000_000, liquidityUsd: null, quoteAsset: true },
    { price: 5, supply: null, usd: 50, liquidityUsd: 900, quoteAsset: false },
  ]);
  assertEquals(eth, null);
  assertEquals(junk, null);
});
