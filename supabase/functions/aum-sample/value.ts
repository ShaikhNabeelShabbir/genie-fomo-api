/** Position valuation and its ceilings. Pure; shared by the sampler and /positions, tested in tests/. Twin: scripts/lib/value.mjs. */
/** Price ceilings, applied BEFORE any multiplication. Identical to the Node job. */
export const MAX_PRICE_PER_TOKEN = 1_000_000;
/** MAX_POSITION_USD WAS $1 TRILLION, WHICH CAUGHT NOTHING. See docs/DECISIONS.md#d189 */
export const MAX_POSITION_USD = 1_000_000_000;
/** V1: a price whose implied market cap (price x total supply) tops this is a broken price, not a rich trader. */
export const IMPLIED_MCAP_CEILING_USD = 20e9;
/** V1: one position over this share of a reading refuses the reading when its cap is unknown or the total tops the USD ceiling. */
export const CONCENTRATION_SHARE = 0.9;
export const CONCENTRATION_TOTAL_USD = 1e9;
/** V1d: a position over this much with no pool anywhere (liquidity unknown) has no market behind its price. */
export const NO_MARKET_CEILING_USD = 1_000_000;
/** V1d: a position worth more than this many times its best pool cannot be realised. */
export const NO_MARKET_LIQUIDITY_MULTIPLE = 10;

export type PriceSuspectReason = "implied_mcap_over_ceiling" | "concentration_over_ceiling" | "no_market_over_ceiling";

/** Value one position, or refuse it. `supply` unknown (null) skips the implied-cap check. See docs/DECISIONS.md#d190 */
export function value(amount: number, price: number | null, supply: number | null = null): { usd?: number; rejected?: boolean } {
  if (price === null || !Number.isFinite(price) || price <= 0) return {};
  if (price > MAX_PRICE_PER_TOKEN) return { rejected: true };
  if (supply !== null && supply > 0 && price * supply > IMPLIED_MCAP_CEILING_USD) return { rejected: true };
  const usd = amount * price;
  if (!Number.isFinite(usd) || usd > MAX_POSITION_USD) return { rejected: true };
  return { usd };
}

/** One position is most of the total, and either its cap cannot be checked or the total is absurd. */
export function concentrationSuspect(usd: number, total: number, capKnown: boolean): boolean {
  return total > 0 && usd > CONCENTRATION_SHARE * total && (!capKnown || total > CONCENTRATION_TOTAL_USD);
}

/**
 * Why a /positions row's price is not to be trusted, or null. `usd`/`total` are the row's and the
 * trader's gross amount x price. With no cap to check, one position over the USD ceiling is a
 * broken price too (V1b), whatever its share of the total.
 */
export function priceSuspectReason(
  price: number | null, supply: number | null, usd: number | null, total: number,
): PriceSuspectReason | null {
  if (price === null) return null;
  const capKnown = supply !== null && supply > 0;
  if (capKnown && price * supply > IMPLIED_MCAP_CEILING_USD) return "implied_mcap_over_ceiling";
  if (usd !== null && !capKnown && usd > MAX_POSITION_USD) return "concentration_over_ceiling";
  if (usd !== null && concentrationSuspect(usd, total, capKnown)) return "concentration_over_ceiling";
  return null;
}

/** V1d: no market behind the price: worth over 10x the pool, or over the ceiling with no pool known. */
export function noMarketSuspect(usd: number | null, liquidityUsd: number | null): boolean {
  if (usd === null) return false;
  return liquidityUsd === null ? usd > NO_MARKET_CEILING_USD : usd > NO_MARKET_LIQUIDITY_MULTIPLE * liquidityUsd;
}

export interface SuspectRow {
  readonly price: number | null; readonly supply: number | null; readonly usd: number | null;
  /** DexScreener liquidity of the best pair; null when no pair is known anywhere. */
  readonly liquidityUsd: number | null;
}

/**
 * V1b: every row's verdict at once, aligned with the input. The concentration base is the sum of
 * the rows not yet suspect: the largest row is judged against it, dropped from it when flagged,
 * and the next largest judged again, so two absurd prices in one wallet cannot hide each other.
 * Then every row still clean is checked against its own pool (V1d), whatever its share.
 */
export function suspectRows(rows: readonly SuspectRow[]): (PriceSuspectReason | null)[] {
  const out: (PriceSuspectReason | null)[] = rows.map((r) =>
    r.price !== null && r.supply !== null && r.supply > 0 && r.price * r.supply > IMPLIED_MCAP_CEILING_USD
      ? "implied_mcap_over_ceiling" : null);
  let base = rows.reduce((s, r, i) => s + (out[i] === null ? r.usd ?? 0 : 0), 0);
  for (;;) {
    let top = -1;
    rows.forEach((r, i) => { if (out[i] === null && r.usd !== null && (top < 0 || r.usd > rows[top].usd!)) top = i; });
    if (top < 0) break;
    const reason = priceSuspectReason(rows[top].price, rows[top].supply, rows[top].usd, base);
    if (reason === null) break;
    out[top] = reason;
    base -= rows[top].usd!;
  }
  rows.forEach((r, i) => { if (out[i] === null && noMarketSuspect(r.usd, r.liquidityUsd)) out[i] = "no_market_over_ceiling"; });
  return out;
}

/**
 * The parent total from what the chains answered. A zero is written only when at least one
 * chain was asked and every answer was empty; nothing asked is null with the most common failure word, or
 * `nothing_answered` when no chain could even be asked (no wallet reaches any known chain).
 */
export function decideTotal(
  answered: number, priced: number, sum: number, total: number, failures: string[],
): { totalUsd: number | null; reason: string | null } {
  if (answered === 0) {
    const counts = new Map<string, number>();
    for (const f of failures) counts.set(f, (counts.get(f) ?? 0) + 1);
    const most = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { totalUsd: null, reason: most ?? "nothing_answered" };
  }
  if (priced > 0) return { totalUsd: sum, reason: null };
  if (total === 0) return { totalUsd: 0, reason: null };
  return { totalUsd: null, reason: "no_prices" };
}
