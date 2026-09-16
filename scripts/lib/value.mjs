/**
 * Position valuation and its ceilings, for the Node jobs. Twin of
 * supabase/functions/aum-sample/value.ts: edit both. Rationale in docs/DECISIONS.md#d189, #d190.
 */
export const MAX_PRICE_PER_TOKEN = 1_000_000;
export const MAX_POSITION_USD = 1_000_000_000;
/** V1: a price whose implied market cap (price x total supply) tops this is a broken price, not a rich trader. */
export const IMPLIED_MCAP_CEILING_USD = 20e9;
/** V1: one position over this share of a reading refuses the reading when its cap is unknown or the total tops the USD ceiling. */
export const CONCENTRATION_SHARE = 0.9;
export const CONCENTRATION_TOTAL_USD = 1e9;

/**
 * Value one position, or refuse it.
 *
 * Returns `{ usd }` when it can be valued, `{ rejected: true }` when a price exists but is
 * not believable, and `{}` when we simply have no price. The three are different states and
 * the caller reports them differently: an unpriced coin is a coverage gap, a rejected one
 * is a finding. `supply` unknown (null) skips the implied-cap check.
 */
export function value(amount, price, supply = null) {
  if (price === null || !Number.isFinite(price) || price <= 0) return {};
  if (price > MAX_PRICE_PER_TOKEN) return { rejected: true };
  if (supply !== null && supply > 0 && price * supply > IMPLIED_MCAP_CEILING_USD) return { rejected: true };
  const usd = amount * price;
  if (!Number.isFinite(usd) || usd > MAX_POSITION_USD) return { rejected: true };
  return { usd };
}

/** One position is most of the total, and either its cap cannot be checked or the total is absurd. */
export function concentrationSuspect(usd, total, capKnown) {
  return total > 0 && usd > CONCENTRATION_SHARE * total && (!capKnown || total > CONCENTRATION_TOTAL_USD);
}
