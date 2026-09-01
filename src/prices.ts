/**
 * USD valuation for the *known* side of a trade.
 *
 * The trick that makes per-trade PnL affordable: in most swaps one leg is a token whose
 * dollar value we already know — a stablecoin, or a major (ETH / SOL / BNB). That leg IS
 * the valuation, so a memecoin never needs a price feed of its own:
 *
 *     sold 400,000 SIRIUS for 6,000 USDC   ->  the trade is worth $6,000, exactly
 *     price of SIRIUS = 6,000 / 400,000    ->  $0.015, derived for free
 *
 * Only token->token swaps (neither leg known) fall outside this, and those are handled by
 * carrying basis across rather than by guessing a price. See pnl.ts.
 *
 * Stablecoins are pinned at $1.00. Majors are read from Binance 1m klines — free, no key,
 * and minute-granularity, which matters when a token moves 50% inside an hour. If Binance
 * is unreachable the value comes back null and the trade is reported as unpriced rather
 * than being quietly assigned a wrong number.
 */

const NATIVE = "native";

type QuoteKind = "stable" | "asset";
type QuoteToken = { symbol: string; kind: QuoteKind; /** Binance base asset */ asset?: string };

/**
 * Known quote tokens keyed by `chain:contract`. Matching on the contract, not the symbol,
 * is deliberate: anyone can deploy a token called "USDC", and valuing a trade off a
 * spoofed stablecoin would invent profit out of nothing.
 */
const QUOTE_BY_ADDRESS: Record<string, QuoteToken> = {
  // ---- ethereum
  "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", kind: "stable" },
  "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", kind: "stable" },
  "ethereum:0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI", kind: "stable" },
  "ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", kind: "asset", asset: "ETH" },
  "ethereum:native": { symbol: "ETH", kind: "asset", asset: "ETH" },

  // ---- base
  "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", kind: "stable" },
  "base:0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": { symbol: "USDbC", kind: "stable" },
  "base:0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { symbol: "DAI", kind: "stable" },
  "base:0x4200000000000000000000000000000000000006": { symbol: "WETH", kind: "asset", asset: "ETH" },
  "base:native": { symbol: "ETH", kind: "asset", asset: "ETH" },

  // ---- bsc
  "bsc:0x55d398326f99059ff775485246999027b3197955": { symbol: "USDT", kind: "stable" },
  "bsc:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": { symbol: "USDC", kind: "stable" },
  "bsc:0xe9e7cea3dedca5984780bafc599bd69add087d56": { symbol: "BUSD", kind: "stable" },
  "bsc:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": { symbol: "WBNB", kind: "asset", asset: "BNB" },
  "bsc:native": { symbol: "BNB", kind: "asset", asset: "BNB" },

  // ---- solana (mints)
  "solana:epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v": { symbol: "USDC", kind: "stable" },
  "solana:es9vmfrzacermjfrf4h2fyd4kconky11mcce8benwnyb": { symbol: "USDT", kind: "stable" },
  "solana:so11111111111111111111111111111111111111112": { symbol: "WSOL", kind: "asset", asset: "SOL" },
  "solana:native": { symbol: "SOL", kind: "asset", asset: "SOL" },

  // ---- robinhood chain: native gas token only. Its stablecoin deployments are not
  // pinned here yet, so they resolve through the symbol fallback below (lower trust).
  "robinhood:native": { symbol: "ETH", kind: "asset", asset: "ETH" },
};

/** Last-resort match when a chain's contracts are not catalogued above. */
const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI", "BUSD", "USDBC", "FDUSD", "TUSD", "USDE"]);
const ASSET_SYMBOLS: Record<string, string> = {
  WETH: "ETH", ETH: "ETH", WBNB: "BNB", BNB: "BNB", WSOL: "SOL", SOL: "SOL",
};

export type QuoteMatch = {
  symbol: string;
  kind: QuoteKind;
  asset?: string;
  /** `address` is trustworthy; `symbol` is a guess on an uncatalogued chain. */
  via: "address" | "symbol";
};

/** Is this leg a token we can put a dollar value on? */
export function asQuote(chain: string, contract: string, symbol: string): QuoteMatch | null {
  const hit = QUOTE_BY_ADDRESS[`${chain}:${(contract || "").toLowerCase()}`];
  if (hit) return { ...hit, via: "address" };

  const s = (symbol || "").toUpperCase();
  if (STABLE_SYMBOLS.has(s)) return { symbol: s, kind: "stable", via: "symbol" };
  if (ASSET_SYMBOLS[s]) return { symbol: s, kind: "asset", asset: ASSET_SYMBOLS[s], via: "symbol" };
  return null;
}

// ------------------------------------------------------------------ major prices

/** `ETH:29803701` (minute bucket) -> USD. One process-lifetime cache; klines are immutable. */
const klineCache = new Map<string, number | null>();
const BINANCE_PAIR: Record<string, string> = { ETH: "ETHUSDT", BNB: "BNBUSDT", SOL: "SOLUSDT" };

/** Historical USD price of a major at a point in time, to the minute. */
async function assetPrice(asset: string, timeSec: number): Promise<number | null> {
  const pair = BINANCE_PAIR[asset];
  if (!pair || !timeSec) return null;

  const minute = Math.floor(timeSec / 60);
  const key = `${asset}:${minute}`;
  const cached = klineCache.get(key);
  if (cached !== undefined) return cached;

  let price: number | null = null;
  try {
    const start = minute * 60_000;
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1m` +
      `&startTime=${start}&endTime=${start + 60_000}&limit=1`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (r.ok) {
      const rows = (await r.json()) as unknown[];
      // [ openTime, open, high, low, close, ... ] — mid of the minute is steadier than close.
      const k = Array.isArray(rows) && Array.isArray(rows[0]) ? (rows[0] as string[]) : null;
      if (k) {
        const o = Number(k[1]);
        const c = Number(k[4]);
        if (Number.isFinite(o) && Number.isFinite(c)) price = (o + c) / 2;
      }
    }
  } catch {
    price = null; // unreachable or rate-limited: report unpriced, never guess
  }

  klineCache.set(key, price);
  return price;
}

/** USD value of `amount` of a known quote token at `timeSec`. Null when unavailable. */
export async function quoteValueUsd(
  q: QuoteMatch, amount: number, timeSec: number,
): Promise<number | null> {
  if (!Number.isFinite(amount)) return null;
  if (q.kind === "stable") return amount;
  const p = q.asset ? await assetPrice(q.asset, timeSec) : null;
  return p === null ? null : amount * p;
}

/** Warm the cache for many timestamps at once so a replay does not serialise its lookups. */
export async function warmAssetPrices(
  wanted: { asset: string; time: number }[],
): Promise<void> {
  const seen = new Set<string>();
  const jobs: Promise<unknown>[] = [];
  for (const w of wanted) {
    const key = `${w.asset}:${Math.floor(w.time / 60)}`;
    if (seen.has(key) || klineCache.has(key)) continue;
    seen.add(key);
    jobs.push(assetPrice(w.asset, w.time));
    // Binance allows generous burst, but keep concurrency civil.
    if (jobs.length >= 24) {
      await Promise.all(jobs.splice(0, jobs.length));
    }
  }
  await Promise.all(jobs);
}
