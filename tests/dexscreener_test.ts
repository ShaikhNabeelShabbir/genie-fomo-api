import { assertEquals } from "jsr:@std/assert@1";
import { bestPairs } from "../scripts/lib/dexscreener.mjs";

Deno.test("bestPairs: deepest priced pool per token, unpriced pairs dropped", () => {
  const pairs = [
    { baseToken: { address: "0xAAA" }, priceUsd: "1.0", liquidity: { usd: 10 }, pairAddress: "p1", dexId: "uniswap", labels: ["v2"] },
    { baseToken: { address: "0xaaa" }, priceUsd: "1.1", liquidity: { usd: 1000 }, pairAddress: "p2", dexId: "uniswap", labels: ["v3"] },
    { baseToken: { address: "0xbbb" }, priceUsd: null, liquidity: { usd: 5000 }, pairAddress: "p3", dexId: "uniswap", labels: ["v4"] },
    { baseToken: { address: "0xccc" }, priceUsd: "0.5", pairAddress: "p4", dexId: "uniswap" },
  ];
  const best = bestPairs(pairs);
  assertEquals(best.get("0xaaa"), { usd: 1.1, liquidity: 1000, pair: "p2", dex: "uniswap:v3" });
  assertEquals(best.has("0xbbb"), false);
  assertEquals(best.get("0xccc"), { usd: 0.5, liquidity: 0, pair: "p4", dex: "uniswap:?" });
});
