import { assertEquals } from "jsr:@std/assert@1";
import { evmBalances, evmTxCount, scale, word, ZERO_ADDRESS } from "../supabase/functions/_shared/chain_reads.ts";

Deno.test("scale: exact past 2^53, trailing zeros trimmed", () => {
  assertEquals(scale(1_190_000_000_000_000_000n, 18), "1.19");
  assertEquals(scale(1n, 18), "0.000000000000000001");
  assertEquals(scale(0n, 18), "0");
  assertEquals(scale(123456789012345678901234567890n, 0), "123456789012345678901234567890");
});

Deno.test("word: '0x' and garbage are null, not zero", () => {
  assertEquals(word("0x"), null);
  assertEquals(word(undefined), null);
  assertEquals(word("0x0"), 0n);
});

Deno.test("evmBalances: native balance becomes a position under the sentinel (N1)", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (_u, init) => {
    const body = JSON.parse(String(init?.body));
    assertEquals(body.method, "eth_getBalance");
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (1_190_000_000_000_000_000n).toString(16) })));
  };
  try {
    const { balances } = await evmBalances("https://rpc.test", "0xabc", [], new Map());
    assertEquals(balances, [{ address: ZERO_ADDRESS, amount: "1.19" }]);
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("evmTxCount: the nonce as a number; an unreadable answer is null, not 0 (R6)", async () => {
  const real = globalThis.fetch;
  let result: string | undefined = "0x8a9f";
  globalThis.fetch = (_u, init) => {
    const body = JSON.parse(String(init?.body));
    assertEquals(body.method, "eth_getTransactionCount");
    assertEquals(body.params, ["0xabc", "latest"]);
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result })));
  };
  try {
    assertEquals(await evmTxCount("https://rpc.test", "0xabc"), 35487);
    result = undefined;
    assertEquals(await evmTxCount("https://rpc.test", "0xabc"), null);
  } finally {
    globalThis.fetch = real;
  }
});
