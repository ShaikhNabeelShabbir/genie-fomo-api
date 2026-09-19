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
  readonly info?: { readonly imageUrl?: string | null };
}
export interface BestPair {
  readonly usd: number; readonly liquidity: number; readonly pair: string; readonly dex: string;
  /** The token image DexScreener shows, null when the pair carries none. */
  readonly logo: string | null;
}
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
      best.set(key, {
        usd, liquidity: liq, pair: String(p?.pairAddress ?? ""), dex: `${p?.dexId ?? "?"}:${(p?.labels ?? []).join("+") || "?"}`,
        logo: p?.info?.imageUrl || null,
      });
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
    // What they SAY when they refuse: for two days we knew only "429", not whether it named a wait.
    if (!r.ok) {
      const said = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 80);
      throw new Error(`dexscreener HTTP ${r.status} (retry-after: ${r.headers.get("retry-after") ?? "none"}; ${said || "no body"})`);
    }
    const j: unknown = await r.json();
    if (!Array.isArray(j)) throw new Error("dexscreener answered a non-array");
    return j as DexPair[];
  });
}

export const isRefusal = (message: string): boolean => /HTTP (?:403|429)\b/.test(message);

/**
 * Batches of `size` that never mix chains (the endpoint is per chain), worked in the order of the
 * FIRST token each holds in `ranked`. Chain by chain, one chain's one-holder dust was priced before
 * another chain's most-held coin — and a run cut short never reached the second chain at all.
 */
export function rankedBatches<T extends { readonly chain: string }>(ranked: readonly T[], size: number): T[][] {
  const byChain = new Map<string, T[]>();
  for (const t of ranked) byChain.set(t.chain, [...(byChain.get(t.chain) ?? []), t]);
  const rank = new Map(ranked.map((t, i) => [t, i]));
  return [...byChain.values()]
    .flatMap((tokens) => Array.from({ length: Math.ceil(tokens.length / size) }, (_, i) => tokens.slice(i * size, (i + 1) * size)))
    .sort((a, b) => (rank.get(a[0]) ?? 0) - (rank.get(b[0]) ?? 0));
}

/** After a run of refusals the prices job waits and tries again, at most this many times an hour. */
export const REFUSAL_PAUSE_MS = 60_000;
export const REFUSAL_PAUSES_PER_RUN = 8;

/**
 * How long to wait after a refusal: what DexScreener ASKED for, plus a little, within bounds. Its
 * refusals are Cloudflare 1015 ("you are being rate limited") with `retry-after: 24..46` — measured
 * 19 Sep 2026, 14:17 UTC, the first time the refusal's own words were logged. A fixed 60 s wait was
 * refused again every time; the limit is per IP and a Worker shares its egress IPs with strangers.
 */
export function refusalWaitMs(message: string): number {
  const asked = Number(/retry-after: (\d+)/.exec(message)?.[1]);
  return Number.isFinite(asked) && asked > 0 ? Math.min(90_000, (asked + 3) * 1000) : REFUSAL_PAUSE_MS;
}

/** What to do after a batch was refused: go on, wait and go on, or leave the hour. Pure, so the rule is testable. */
export function afterRefusal(refusedInARow: number, pausesTaken: number, limit: number): "continue" | "pause" | "stop" {
  if (refusedInARow < limit) return "continue";
  return pausesTaken < REFUSAL_PAUSES_PER_RUN ? "pause" : "stop";
}
