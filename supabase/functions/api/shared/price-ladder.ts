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
 *   2. `token_price_stats.last_usd` — the hourly DexScreener price, at most STATS_STALE_HOURS old.
 *   3. `token_prices.usd` — the daily close, at most DAILY_CLOSE_STALE_DAYS old.
 *   4. `token_info.price_usd` — GMGN's, last, and only as old as its fetch: at most INFO_STALE_DAYS.
 *
 * A price past its rung's age prices nothing: the row is unpriced (null), never valued at an
 * old figure under a fresh total. `statsFresh` / `infoFresh` are the one rule every reader follows.
 */

/** Vocabulary `positions[].priceSource`; `fomo_reported_entry` is the directory build's own and never comes from here. */
export const PRICE_SOURCES = ["pegged", "token_price_stats", "token_prices", "token_info"] as const;
export type PriceSource = typeof PRICE_SOURCES[number];

/** A daily close older than this prices nothing: the token may not have traded since. */
export const DAILY_CLOSE_STALE_DAYS = 7;

/** The oldest `day` a daily close may carry, as the `YYYY-MM-DD` the column stores. */
export const oldestUsableDay = (now: Date): string =>
  new Date(now.getTime() - DAILY_CLOSE_STALE_DAYS * 86_400_000).toISOString().slice(0, 10);

/** The history builder's hourly rung uses the same 24 h, so `now` and the newest point agree. */
export const STATS_STALE_HOURS = 24;
/** No rung admits an older price than the daily close does. */
export const INFO_STALE_DAYS = DAILY_CLOSE_STALE_DAYS;

/** A price with no readable stamp cannot be shown to be young, so it is not. */
const youngerThan = (at: unknown, now: Date, maxAgeMs: number): boolean =>
  !!at && now.getTime() - new Date(String(at)).getTime() <= maxAgeMs;

/** `token_price_stats.last_at` is young enough for `last_usd` to price a position at `now`. */
export const statsFresh = (lastAt: unknown, now: Date): boolean => youngerThan(lastAt, now, STATS_STALE_HOURS * 3_600_000);
/** `token_info.fetched_at` is young enough for `price_usd` to price a position at `now`. */
export const infoFresh = (fetchedAt: unknown, now: Date): boolean => youngerThan(fetchedAt, now, INFO_STALE_DAYS * 86_400_000);

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
 * The first rung that carries a usable price at `now`, or null. Pure: the caller decides where
 * the columns came from, and a stale daily close is excluded by the query, not here (the `day`
 * column is indexed and the filter belongs in the seek).
 */
export function ladderPrice(r: LadderColumns, now: Date): LadderPrice | null {
  const pegged = positive(r.pegged_usd);
  if (pegged !== null) return { usd: pegged, source: "pegged", at: null };
  const stats = statsFresh(r.stats_at, now) ? positive(r.stats_usd) : null;
  if (stats !== null) return { usd: stats, source: "token_price_stats", at: iso(r.stats_at) };
  const daily = unpackDaily(r.daily);
  if (daily !== null) return { usd: daily.usd, source: "token_prices", at: `${daily.day}T00:00:00.000Z` };
  const info = infoFresh(r.info_at, now) ? positive(r.info_usd) : null;
  if (info !== null) return { usd: info, source: "token_info", at: iso(r.info_at) };
  return null;
}
