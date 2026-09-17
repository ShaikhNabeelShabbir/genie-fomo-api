import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { bitquery, evmBalancesBitquery, parseBalances } from "../supabase/functions/_shared/bitquery.ts";
import { ZERO_ADDRESS } from "../supabase/functions/_shared/chain_reads.ts";

/** One `EVM.Balances` reply as https://docs.bitquery.io/docs/examples/balances/balance-api/ shapes it. */
const reply = {
  EVM: {
    Balances: [
      { Currency: { Symbol: "ETH", SmartContract: "0x", Native: true, Decimals: 18 }, Balance: { Amount: "1.19" } },
      { Currency: { Symbol: "USDC", SmartContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", Native: false, Decimals: 6 }, Balance: { Amount: "250.5" } },
      { Currency: { Symbol: "", SmartContract: "0xdead000000000000000000000000000000000001", Native: false, Decimals: 18 }, Balance: { Amount: "0" } },
      { Currency: { Symbol: "NEG", SmartContract: "0xdead000000000000000000000000000000000002", Native: false, Decimals: 18 }, Balance: { Amount: "-3" } },
      { Currency: { Symbol: "BAD", SmartContract: "0xdead000000000000000000000000000000000003", Native: false, Decimals: 18 }, Balance: { Amount: "abc" } },
      { Currency: { Symbol: "DUP", SmartContract: "0xDEAD000000000000000000000000000000000004", Native: false, Decimals: 9 }, Balance: { Amount: "1.5" } },
      { Currency: { Symbol: "DUP", SmartContract: "0xdead000000000000000000000000000000000004", Native: false, Decimals: 9 }, Balance: { Amount: "2" } },
    ],
  },
};

Deno.test("parseBalances: fixture reply becomes rows, contract lower-cased, decimals and symbol carried", () => {
  const rows = parseBalances(reply);
  assertEquals(rows.find((r) => r.symbol === "USDC"), {
    address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", amount: "250.5", decimals: 6, symbol: "USDC",
  });
  assertEquals(rows.map((r) => r.symbol), ["ETH", "USDC", "DUP"]);
});

Deno.test("parseBalances: zero, negative and unreadable amounts are dropped; a repeated currency is summed", () => {
  const rows = parseBalances(reply);
  assertEquals(rows.some((r) => r.address.endsWith("01") || r.address.endsWith("02") || r.address.endsWith("03")), false);
  assertEquals(rows.find((r) => r.symbol === "DUP")?.amount, "3.5");
});

Deno.test("parseBalances: the native coin lands under the zero-address sentinel with 18 decimals (N1)", () => {
  const eth = parseBalances(reply).find((r) => r.symbol === "ETH");
  assertEquals(eth, { address: ZERO_ADDRESS, amount: "1.19", decimals: 18, symbol: "ETH" });
  // `SmartContract: "0x"` alone marks it too, as the eth_getBalance doc page filters it.
  const only0x = parseBalances({ EVM: { Balances: [{ Currency: { Symbol: "BNB", SmartContract: "0x", Decimals: 18 }, Balance: { Amount: "2" } }] } });
  assertEquals(only0x[0]?.address, ZERO_ADDRESS);
});

Deno.test("parseBalances: an empty or malformed reply is no rows, not a throw", () => {
  assertEquals(parseBalances(undefined), []);
  assertEquals(parseBalances({ EVM: { Balances: [{ Currency: null, Balance: { Amount: "1" } }] } }), []);
});

Deno.test("bitquery: a points-limit error maps to the quota message; a missing key refuses before any fetch", async () => {
  await assertRejects(() => bitquery("", "{}"), Error, "BITQUERY_KEY is not set");
  const real = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({ errors: [{ message: "Points limit exceeded" }] })));
  try {
    await assertRejects(() => bitquery("k", "{}"), Error, "Bitquery quota reached");
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("evmBalancesBitquery: posts the network word in the query text and the wallet as a variable", async () => {
  const real = globalThis.fetch;
  let sent: { query: string; variables: { wallet: string } } | null = null;
  globalThis.fetch = (_u, init) => {
    sent = JSON.parse(String(init?.body));
    return Promise.resolve(new Response(JSON.stringify({ data: reply })));
  };
  try {
    const { balances } = await evmBalancesBitquery("k", "base", "0xAbC");
    assertEquals(balances.length, 3);
    assertEquals(sent!.variables, { wallet: "0xAbC" });
    assertEquals(/EVM\(network: base, dataset: realtime\)/.test(sent!.query), true);
    await assertRejects(() => evmBalancesBitquery("k", "base; drop", "0x1"), Error, "network word");
  } finally {
    globalThis.fetch = real;
  }
});
