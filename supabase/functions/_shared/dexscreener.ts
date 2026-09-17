// The only copy since 17 Sep 2026 (the scripts/ twin was deleted with the GitHub loaders).
/**
 * DexScreener's keyless token endpoint, for chains GMGN does not price (R4: robinhood).
 * docs/R4_ROBINHOOD_PRICES.md has the measurement; 30 addresses per call, 300 calls/min.
 */
import { throttled } from "./chain_reads.ts";

export const DEXSCREENER = "https://api.dexscreener.com/tokens/v1";
export const ADDRESSES_PER_CALL = 30;
/** DexScreener chain ids by our network_id; the same words as chains.name. */
export const CHAIN_IDS: Readonly<Record<number, string>> = {
  1399811149: "solana", 1: "ethereum", 56: "bsc", 8453: "base", 4663: "robinhood",
};

/** The fields of a DexScreener pair this module reads; everything else is ignored. */
export interface DexPair {
  readonly priceUsd?: string | number | null;
  readonly baseToken?: { readonly address?: string };
  readonly liquidity?: { readonly usd?: number };
  readonly pairAddress?: string;
  readonly dexId?: string;
  readonly labels?: readonly string[];
}
export interface BestPair { readonly usd: number; readonly liquidity: number; readonly pair: string; readonly dex: string }
export interface Ath { readonly athUsd: number; readonly athAt: string }
export interface AthStats extends Ath { readonly drawdownShare: number }
export interface PriceSample { readonly usd: number; readonly at: string }

/**
 * Fold one sample into a token's running ATH. `prev` is null for a token never sampled;
 * `drawdownShare = 1 - usd / athUsd`, 0..1, 0 when the sample IS the high.
 */
export function athUpdate(prev: Ath | null, sample: PriceSample): AthStats {
  const isHigh = !prev || sample.usd >= prev.athUsd;
  const athUsd = isHigh ? sample.usd : prev.athUsd;
  return { athUsd, athAt: isHigh ? sample.at : prev.athAt, drawdownShare: Number((1 - sample.usd / athUsd).toFixed(4)) };
}

/** One pair per token: the deepest pool wins, and a pair with no USD price is no pair. */
export function bestPairs(pairs: readonly (DexPair | null)[]): Map<string, BestPair> {
  const best = new Map<string, BestPair>();
  for (const p of pairs) {
    const usd = Number(p?.priceUsd);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    const key = String(p?.baseToken?.address ?? "").toLowerCase();
    if (!key) continue;
    const liq = Number(p?.liquidity?.usd ?? 0);
    const prev = best.get(key);
    if (!prev || liq > prev.liquidity) {
      best.set(key, { usd, liquidity: liq, pair: String(p?.pairAddress ?? ""), dex: `${p?.dexId ?? "?"}:${(p?.labels ?? []).join("+") || "?"}` });
    }
  }
  return best;
}

/** Pairs for up to ADDRESSES_PER_CALL token addresses on one chain, raw. */
export async function fetchPairs(chain: string, addresses: readonly string[]): Promise<DexPair[]> {
  if (addresses.length > ADDRESSES_PER_CALL) throw new Error(`dexscreener takes ${ADDRESSES_PER_CALL} addresses per call, got ${addresses.length}`);
  const url = `${DEXSCREENER}/${chain}/${addresses.join(",")}`;
  return throttled(url, async () => {
    const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`dexscreener HTTP ${r.status}`);
    const j: unknown = await r.json();
    if (!Array.isArray(j)) throw new Error("dexscreener answered a non-array");
    return j as DexPair[];
  });
}
