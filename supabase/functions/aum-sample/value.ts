/** Position valuation and its ceilings. Pure; shared by the sampler, tested in tests/.
/** Price ceilings, applied BEFORE any multiplication. Identical to the Node job. */
export const MAX_PRICE_PER_TOKEN = 1_000_000;
/** MAX_POSITION_USD WAS $1 TRILLION, WHICH CAUGHT NOTHING. See docs/DECISIONS.md#d189 */
export const MAX_POSITION_USD = 1_000_000_000;

/** Value one position, or refuse it. See docs/DECISIONS.md#d190 */
export function value(amount: number, price: number | null): { usd?: number; rejected?: boolean } {
  if (price === null || !Number.isFinite(price) || price <= 0) return {};
  if (price > MAX_PRICE_PER_TOKEN) return { rejected: true };
  const usd = amount * price;
  if (!Number.isFinite(usd) || usd > MAX_POSITION_USD) return { rejected: true };
  return { usd };
}
