import { assertEquals } from "jsr:@std/assert@1";
import { fetchTransactions } from "../supabase/functions/_shared/transactions.ts";
import { isSourceRefusal, walkBackTargets } from "../worker/src/jobs/transfers-core.ts";

Deno.test("the Solana head pull stops at the newest signature already stored: one call for a quiet wallet", async () => {
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    asked.push(String(input));
    return Promise.resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  try {
    const out = await fetchTransactions({ helius: "k" }, null, "SoLWaLLet11111111111111111111111111111111111", ["solana"], 200,
      { pages: 5, includeNative: true, solanaUntil: "sigNEWEST" });
    assertEquals(asked.length, 1, "an empty first page ends the walk; it used to be five calls an hour per wallet");
    assertEquals(new URL(asked[0]).searchParams.get("until"), "sigNEWEST");
    assertEquals(new URL(asked[0]).searchParams.get("before"), null);
    assertEquals(out.chains.map((c) => [c.chain, c.count, c.error, c.exhausted]), [["solana", 0, null, true]]);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("a refused source is told apart from a wallet's own trouble, and only unfinished wallets are walked back", () => {
  assertEquals(["HTTP 429", "Helius rejected the key", "HTTP 403", "HTTP 500", "bad address", null].map(isSourceRefusal),
    [true, true, true, false, false, false]);
  const w = (handle: string, done: number | null, oldest: string | null, sol: string | null = "So1") =>
    ({ handle, evm_address: null, sol_address: sol, sol_backfill_done: done, sol_oldest_signature: oldest });
  const picked = walkBackTargets([w("done", 1, "s"), w("a", null, "s"), w("no-rows-yet", null, null), w("evm-only", null, "s", null), w("b", 0, "s"), w("c", null, "s")], 2);
  assertEquals(picked.map((x) => x.handle), ["a", "b"]);
});
