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

/** Why a /positions row's price is not to be trusted, or null. `usd`/`total` are the row's and the trader's gross amount x price. */
export function priceSuspectReason(price, supply, usd, total) {
  if (price === null) return null;
  const capKnown = supply !== null && supply > 0;
  if (capKnown && price * supply > IMPLIED_MCAP_CEILING_USD) return "implied_mcap_over_ceiling";
  if (usd !== null && concentrationSuspect(usd, total, capKnown)) return "concentration_over_ceiling";
  return null;
}

/**
 * The parent total from what the chains answered. A zero is written only when at least one
 * chain was asked and every answer was empty; nothing asked is null with the most common failure word, or
 * `nothing_answered` when no chain could even be asked (no wallet reaches any known chain).
 */
export function decideTotal(answered, priced, sum, total, failures) {
  if (answered === 0) {
    const counts = new Map();
    for (const f of failures) counts.set(f, (counts.get(f) ?? 0) + 1);
    const most = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { totalUsd: null, reason: most ?? "nothing_answered" };
  }
  if (priced > 0) return { totalUsd: sum, reason: null };
  if (total === 0) return { totalUsd: 0, reason: null };
  return { totalUsd: null, reason: "no_prices" };
}
