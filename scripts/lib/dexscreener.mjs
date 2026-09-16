/**
 * DexScreener's keyless token endpoint, for chains GMGN does not price (R4: robinhood).
 * docs/R4_ROBINHOOD_PRICES.md has the measurement; 30 addresses per call, 300 calls/min.
 */
import { throttled } from "./chain_reads.mjs";

export const DEXSCREENER = "https://api.dexscreener.com/tokens/v1";
export const ADDRESSES_PER_CALL = 30;

/** One pair per token: the deepest pool wins, and a pair with no USD price is no pair. */
export function bestPairs(pairs) {
  const best = new Map();
  for (const p of pairs) {
    const usd = Number(p?.priceUsd);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    const key = String(p.baseToken?.address ?? "").toLowerCase();
    if (!key) continue;
    const liq = Number(p.liquidity?.usd ?? 0);
    const prev = best.get(key);
    if (!prev || liq > prev.liquidity) {
      best.set(key, { usd, liquidity: liq, pair: String(p.pairAddress ?? ""), dex: `${p.dexId ?? "?"}:${(p.labels ?? []).join("+") || "?"}` });
    }
  }
  return best;
}

/** Pairs for up to ADDRESSES_PER_CALL token addresses on one chain, raw. */
export async function fetchPairs(chain, addresses) {
  if (addresses.length > ADDRESSES_PER_CALL) throw new Error(`dexscreener takes ${ADDRESSES_PER_CALL} addresses per call, got ${addresses.length}`);
  const url = `${DEXSCREENER}/${chain}/${addresses.join(",")}`;
  return throttled(url, async () => {
    const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`dexscreener HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error("dexscreener answered a non-array");
    return j;
  });
}
