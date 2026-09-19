/**
 * Pure half of the quote-price loader (`jobs/quote_prices.ts`): the Binance pair map and the
 * klines parse, twins of `scripts/load_quote_prices.mjs`. No I/O: tested in tests/quote_prices_test.ts.
 */

export const DAY_MS = 86_400_000;
/** Binance returns at most this many candles a call; ~2.7 years of days. */
export const KLINES_LIMIT = 1000;

/** Quote symbol -> exchange pair. Binance and Bybit spell these the same, so one map serves both.
 *  Symbols absent here cannot be priced and are reported. */
export const PAIR: Readonly<Record<string, string>> = {
  SOL: "SOLUSDT",
  wSOL: "SOLUSDT",
  WETH: "ETHUSDT",
  ETH: "ETHUSDT",
  WBNB: "BNBUSDT",
  BNB: "BNBUSDT",
};

/**
 * Bybit wraps its candles in `result.list`; each row is
 * `[startMs, open, high, low, close, volume, turnover]`, so index 0 and index 4 mean exactly what
 * they mean in a Binance kline and `parseKlines` reads it unchanged. Anything else is an empty page.
 */
export function bybitList(body: unknown): unknown[] {
  const result = typeof body === "object" && body !== null ? (body as { result?: unknown }).result : undefined;
  const list = typeof result === "object" && result !== null ? (result as { list?: unknown }).list : undefined;
  return Array.isArray(list) ? list : [];
}

/** Kraken's USD pair for each exchange pair above. It answers from the US, where Binance and (since 19 Sep 2026) Bybit refuse this Worker's egress with 403. USD, not USDT: within a few basis points on a daily close. */
export const KRAKEN_PAIR: Readonly<Record<string, string>> = { SOLUSDT: "SOLUSD", ETHUSDT: "ETHUSD", BNBUSDT: "BNBUSD" };

/**
 * Kraken keys `result` by ITS OWN name for the pair (ETHUSD comes back as XETHZUSD) beside a `last`
 * cursor, and stamps candles in SECONDS. Rows are otherwise kline-shaped (close at index 4), so the
 * open time is scaled to milliseconds and `parseKlines` reads the rest unchanged.
 */
export function krakenList(body: unknown): unknown[] {
  const result = typeof body === "object" && body !== null ? (body as { result?: unknown }).result : undefined;
  if (typeof result !== "object" || result === null) return [];
  const rows = Object.entries(result).find(([k, v]) => k !== "last" && Array.isArray(v))?.[1];
  return Array.isArray(rows) ? rows.map((r: unknown) => (Array.isArray(r) ? [Number(r[0]) * 1000, ...r.slice(1)] : r)) : [];
}

export interface Closes {
  /** UTC day -> close, in candle order. */
  readonly byDay: ReadonlyMap<string, number>;
  /** Open time of the last candle, or null when the page was empty. */
  readonly lastOpenMs: number | null;
  readonly count: number;
}

/**
 * Daily closes out of one klines page. `close` (index 4) rather than a mid: a daily close is
 * the figure every other source publishes, so ours can be checked. Malformed rows are skipped.
 */
export function parseKlines(body: unknown): Closes {
  const byDay = new Map<string, number>();
  let lastOpenMs: number | null = null, count = 0;
  for (const k of Array.isArray(body) ? body : []) {
    if (!Array.isArray(k)) continue;
    count += 1;
    const open = Number(k[0]), close = Number(k[4]);
    if (!Number.isFinite(open)) continue;
    lastOpenMs = open;
    if (Number.isFinite(close)) byDay.set(new Date(open).toISOString().slice(0, 10), close);
  }
  return { byDay, lastOpenMs, count };
}

/** Where a series starts: the first swap day (a year back when unknown), minus one day of slack so a swap just after midnight UTC still finds a row. */
export function seriesStartMs(firstDay: Date | null, now: Date): number {
  const first = firstDay ?? new Date(now.getTime() - 365 * DAY_MS);
  return first.getTime() - DAY_MS;
}
