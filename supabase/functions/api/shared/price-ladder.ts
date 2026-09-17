import { n } from "../db.ts";

/**
 * THE price ladder. One definition, read at request time by /positions and /portfolio and at
 * valuation time by `refreshAumLive` (worker/src/jobs/valuation.ts), so the three figures a
 * consumer compares — a row's `priceUsd`, `/positions.totalValueUsd` and `/aum/now.totalUsd` —
 * cannot be built from different prices.
 *
 * Until 17 Sep 2026 there were three ladders: the balances job wrote a price into
 * `holdings.price` at read time and /positions served that frozen figure; the live valuation
 * used its own rungs; the history builder a third set. A trader read at 04:31 therefore showed
 * `priceUsd: null` on his native ETH all day while `/aum/now` priced it, and cupseyy's list
 * disagreed with his live figure by 64x. See docs/DECISIONS.md and the v5 reply (A1, N1, R7).
 *
 * Rung order, freshest and most trustworthy first:
 *   1. `quote_assets.pegged_usd` — a dollar coin is a dollar, and no market check applies.
 *   2. `token_price_stats.last_usd` — the hourly DexScreener price, the freshest we hold.
 *   3. `token_prices.usd` — the daily close, at most DAILY_CLOSE_STALE_DAYS old.
 *   4. `token_info.price_usd` — GMGN's, last because it has no staleness stamp we trust.
 */

/** Vocabulary `positions[].priceSource`; `fomo_reported_entry` is the directory build's own and never comes from here. */
export const PRICE_SOURCES = ["pegged", "token_price_stats", "token_prices", "token_info"] as const;
export type PriceSource = typeof PRICE_SOURCES[number];

/** A daily close older than this prices nothing: the token may not have traded since. */
export const DAILY_CLOSE_STALE_DAYS = 7;

/** The oldest `day` a daily close may carry, as the `YYYY-MM-DD` the column stores. */
export const oldestUsableDay = (now: Date): string =>
  new Date(now.getTime() - DAILY_CLOSE_STALE_DAYS * 86_400_000).toISOString().slice(0, 10);

/**
 * The four rungs as a query hands them over; every field optional so a caller may omit a rung.
 * `daily` is the packed `YYYY-MM-DD|usd` of the newest usable close — packed because the two
 * halves would otherwise cost two correlated seeks per row on a list 11,000 rows long.
 */
export interface LadderColumns {
  readonly pegged_usd?: unknown;
  readonly stats_usd?: unknown;
  readonly stats_at?: unknown;
  readonly daily?: unknown;
  readonly info_usd?: unknown;
  readonly info_at?: unknown;
}

/** `"2026-09-17|2444.29"` -> `{ day, usd }`; null when absent or malformed. */
export const unpackDaily = (v: unknown): { day: string; usd: number } | null => {
  if (v === null || v === undefined) return null;
  const [day, raw] = String(v).split("|");
  const usd = Number(raw);
  return day && Number.isFinite(usd) && usd > 0 ? { day, usd } : null;
};

export interface LadderPrice {
  readonly usd: number;
  readonly source: PriceSource;
  /** When that price was true; null when the rung carries no stamp. */
  readonly at: string | null;
}

/** A price is only a price when it is a finite number above zero; 0 means "we have no figure". */
const positive = (v: unknown): number | null => {
  const x = n(v);
  return x !== null && x > 0 ? x : null;
};

const iso = (v: unknown): string | null => (v ? new Date(String(v)).toISOString() : null);

/**
 * The first rung that carries a price, or null. Pure: the caller decides where the columns
 * came from, and a stale daily close is excluded by the query, not here (the `day` column is
 * indexed and the filter belongs in the seek).
 */
export function ladderPrice(r: LadderColumns): LadderPrice | null {
  const pegged = positive(r.pegged_usd);
  if (pegged !== null) return { usd: pegged, source: "pegged", at: null };
  const stats = positive(r.stats_usd);
  if (stats !== null) return { usd: stats, source: "token_price_stats", at: iso(r.stats_at) };
  const daily = unpackDaily(r.daily);
  if (daily !== null) return { usd: daily.usd, source: "token_prices", at: `${daily.day}T00:00:00.000Z` };
  const info = positive(r.info_usd);
  if (info !== null) return { usd: info, source: "token_info", at: iso(r.info_at) };
  return null;
}
