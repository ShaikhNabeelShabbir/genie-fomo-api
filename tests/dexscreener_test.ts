import { assertEquals } from "jsr:@std/assert@1";
import { athUpdate, bestPairs } from "../supabase/functions/_shared/dexscreener.ts";

// Expected values mirror scripts/lib/dexscreener.mjs (the twin) line for line.

Deno.test("bestPairs: deepest priced pool per token wins, keyed lower-case", () => {
  const best = bestPairs([
    { baseToken: { address: "0xAAA" }, priceUsd: "1.0", liquidity: { usd: 10 }, pairAddress: "p1", dexId: "uniswap", labels: ["v2"] },
    { baseToken: { address: "0xaaa" }, priceUsd: "1.1", liquidity: { usd: 1000 }, pairAddress: "p2", dexId: "uniswap", labels: ["v3"] },
    { baseToken: { address: "0xaaa" }, priceUsd: "1.2", liquidity: { usd: 1000 }, pairAddress: "p3", dexId: "uniswap", labels: ["v3"] },
  ]);
  // A tie on liquidity keeps the first seen (strictly deeper replaces).
  assertEquals([...best.entries()], [["0xaaa", { usd: 1.1, liquidity: 1000, pair: "p2", dex: "uniswap:v3", logo: null }]]);
});

Deno.test("bestPairs: a pair with no positive USD price is no pair", () => {
  const best = bestPairs([
    { baseToken: { address: "0xbbb" }, priceUsd: null, liquidity: { usd: 5000 }, pairAddress: "p3", dexId: "uniswap" },
    { baseToken: { address: "0xccc" }, priceUsd: "0", liquidity: { usd: 5000 }, pairAddress: "p4", dexId: "uniswap" },
    { baseToken: { address: "0xddd" }, priceUsd: "abc", liquidity: { usd: 5000 }, pairAddress: "p5", dexId: "uniswap" },
    { baseToken: { address: "0xeee" }, priceUsd: "2", liquidity: { usd: 5000 }, pairAddress: "p6", dexId: "raydium", labels: ["clmm"] },
  ]);
  assertEquals([...best.keys()], ["0xeee"]);
  assertEquals(best.get("0xeee"), { usd: 2, liquidity: 5000, pair: "p6", dex: "raydium:clmm", logo: null });
});

Deno.test("bestPairs: missing liquidity, labels and pair address fall back to 0, '?' and ''", () => {
  const best = bestPairs([{ baseToken: { address: "0xCCC" }, priceUsd: "0.5", dexId: "uniswap" }]);
  assertEquals(best.get("0xccc"), { usd: 0.5, liquidity: 0, pair: "", dex: "uniswap:?", logo: null });
  assertEquals(bestPairs([{ priceUsd: "0.5" }]).size, 0, "no base token address is no pair");
  assertEquals(bestPairs([null, { baseToken: { address: "x" }, priceUsd: 3, labels: ["a", "b"] }]).get("x")?.dex, "?:a+b");
});

Deno.test("bestPairs: several tokens each keep their own best pool", () => {
  const best = bestPairs([
    { baseToken: { address: "a" }, priceUsd: "1", liquidity: { usd: 1 }, pairAddress: "a1", dexId: "d" },
    { baseToken: { address: "b" }, priceUsd: "2", liquidity: { usd: 9 }, pairAddress: "b1", dexId: "d" },
    { baseToken: { address: "a" }, priceUsd: "1.5", liquidity: { usd: 3 }, pairAddress: "a2", dexId: "d" },
  ]);
  assertEquals(best.get("a")?.pair, "a2");
  assertEquals(best.get("b")?.pair, "b1");
  assertEquals(best.size, 2);
});

const T0 = "2026-09-17T10:00:00.000Z";
const T1 = "2026-09-17T11:00:00.000Z";

Deno.test("athUpdate: the first sample is the high with zero drawdown", () => {
  assertEquals(athUpdate(null, { usd: 2, at: T0 }), { athUsd: 2, athAt: T0, drawdownShare: 0 });
});

Deno.test("athUpdate: a lower sample keeps the high and draws down, to 4 decimals", () => {
  const prev = { athUsd: 2, athAt: T0 };
  assertEquals(athUpdate(prev, { usd: 0.5, at: T1 }), { athUsd: 2, athAt: T0, drawdownShare: 0.75 });
  assertEquals(athUpdate({ athUsd: 3, athAt: T0 }, { usd: 1, at: T1 }).drawdownShare, 0.6667);
});

Deno.test("athUpdate: a higher sample resets the high and its time", () => {
  assertEquals(athUpdate({ athUsd: 2, athAt: T0 }, { usd: 3, at: T1 }), { athUsd: 3, athAt: T1, drawdownShare: 0 });
});

Deno.test("athUpdate: a sample equal to the high is the high (time moves to the sample)", () => {
  assertEquals(athUpdate({ athUsd: 2, athAt: T0 }, { usd: 2, at: T1 }), { athUsd: 2, athAt: T1, drawdownShare: 0 });
});

Deno.test("bestPairs: the winning pair's info.imageUrl is the logo; absent or empty is null", () => {
  const best = bestPairs([
    { baseToken: { address: "0xA" }, priceUsd: "1", liquidity: { usd: 1 }, info: { imageUrl: "https://cdn/x.png" } },
    { baseToken: { address: "0xA" }, priceUsd: "1", liquidity: { usd: 9 } },
    { baseToken: { address: "0xB" }, priceUsd: "1", info: { imageUrl: "" } },
  ]);
  assertEquals(best.get("0xa")?.logo, null, "deepest pool wins even when a shallower one had the image");
  assertEquals(best.get("0xb")?.logo, null);
  assertEquals(bestPairs([{ baseToken: { address: "c" }, priceUsd: 2, info: { imageUrl: "https://cdn/c.png" } }]).get("c")?.logo, "https://cdn/c.png");
});

Deno.test("rankedBatches: never mixes chains, and the most-held coin of EVERY chain is priced before any chain's tail", async () => {
  const { rankedBatches, isRefusal } = await import("../supabase/functions/_shared/dexscreener.ts");
  // Ranked most-held first: solana's two leaders, then base's leader, then solana's tail.
  const ranked = [{ chain: "solana", k: "s1" }, { chain: "solana", k: "s2" }, { chain: "base", k: "b1" }, { chain: "solana", k: "s3" }, { chain: "solana", k: "s4" }, { chain: "base", k: "b2" }];
  const out = rankedBatches(ranked, 2).map((b) => b.map((t) => t.k).join(","));
  assertEquals(out, ["s1,s2", "b1,b2", "s3,s4"]); // chain by chain it was s1,s2 | s3,s4 | b1,b2
  assertEquals(rankedBatches([], 30), []);
  assertEquals([isRefusal("dexscreener HTTP 429"), isRefusal("dexscreener HTTP 403"), isRefusal("dexscreener HTTP 500"), isRefusal("dexscreener answered a non-array")], [true, true, false, false]);
});

Deno.test("afterRefusal: a run of refusals earns a wait, three waits an hour, then the hour is left", async () => {
  const { afterRefusal, REFUSAL_PAUSES_PER_RUN } = await import("../supabase/functions/_shared/dexscreener.ts");
  assertEquals(afterRefusal(4, 0, 5), "continue");
  assertEquals(afterRefusal(5, 0, 5), "pause");
  assertEquals(afterRefusal(5, REFUSAL_PAUSES_PER_RUN - 1, 5), "pause");
  assertEquals(afterRefusal(5, REFUSAL_PAUSES_PER_RUN, 5), "stop");
});

Deno.test("refusalWaitMs: the wait is what DexScreener asked for plus a little, bounded; a minute when it names none", async () => {
  const { refusalWaitMs } = await import("../supabase/functions/_shared/dexscreener.ts");
  assertEquals(refusalWaitMs("dexscreener HTTP 429 (retry-after: 40; error code: 1015 )"), 43_000);
  assertEquals(refusalWaitMs("dexscreener HTTP 429 (retry-after: 600; error code: 1015 )"), 90_000);
  assertEquals(refusalWaitMs("dexscreener HTTP 429 (retry-after: none; no body)"), 60_000);
});
