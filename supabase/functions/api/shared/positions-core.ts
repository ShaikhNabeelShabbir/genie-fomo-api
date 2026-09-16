import { sql, n, round } from "../db.ts";
import { get } from "../router.ts";
import { cov } from "../shared/format.ts";

/** WHAT A TRADER PAID FOR WHAT HE STILL HOLDS. See docs/DECISIONS.md#d136 */
export type CostBasis = {
  costKnownAmount: number | null; costUsd: number | null; avgCostPrice: number | null;
  realizedUsd: number | null; openPositions: number; openPriced: number;
};

export async function costBasisFor(handles: string[]): Promise<Map<string, Map<string, CostBasis>>> {
  const out = new Map<string, Map<string, CostBasis>>();
  if (!handles.length) return out;
  const rows = await sql`
    select handle, network_id, token_key,
           sum(amount) filter (
             where status = 'open' and avg_entry_price is not null and amount > 0) as cost_qty,
           sum(avg_entry_price * amount) filter (
             where status = 'open' and avg_entry_price is not null and amount > 0) as cost_usd,
           count(*) filter (where status = 'open')::int as open_positions,
           count(*) filter (
             where status = 'open' and avg_entry_price is not null and amount > 0)::int
             as open_priced,
           sum(realized_pnl_usd) filter (where status = 'closed') as realized_usd
    from trades
    where handle = any(${handles})
    group by handle, network_id, token_key`;
  for (const r of rows) {
    const h = String(r.handle);
    let m = out.get(h); if (!m) out.set(h, m = new Map());
    const qty = n(r.cost_qty), usd = n(r.cost_usd);
    m.set(`${Number(r.network_id)}:${r.token_key}`, {
      costKnownAmount: qty,
      costUsd: usd === null ? null : round(usd),
      avgCostPrice: qty !== null && qty > 0 && usd !== null
        ? Number((usd / qty).toPrecision(12)) : null,
      realizedUsd: n(r.realized_usd) === null ? null : round(n(r.realized_usd)),
      openPositions: Number(r.open_positions),
      openPriced: Number(r.open_priced),
    });
  }
  return out;
}

/** The A12 block for one holding, shared by the single and batch routes. */
export function costBlock(cb: CostBasis | undefined, amount: number | null, priceUsd: number | null) {
  if (!cb || cb.openPositions === 0) {
    return {
      costKnownAmount: null, avgCostPrice: null, costUsd: null,
      realizedUsd: cb?.realizedUsd ?? null, unrealizedUsd: null,
      costMethod: null, costSource: null,
      costCoverage: cov(0, 0),
      costReason: "no stored position for this holding — it may have arrived as a transfer, " +
                  "and a transfer in is not a purchase at zero",
    };
  }
  const known = cb.costKnownAmount;
  const unrealized = known !== null && known > 0 && cb.avgCostPrice !== null && priceUsd !== null
    ? round((priceUsd - cb.avgCostPrice) * known) : null;
  return {
    costKnownAmount: known,
    avgCostPrice: cb.avgCostPrice,
    costUsd: cb.costUsd,
    /** Realised on this coin's CLOSED positions — a different quantity, and said so here. */
    realizedUsd: cb.realizedUsd,
    /** Against `costKnownAmount` only, never against the whole holding. */
    unrealizedUsd: unrealized,
    costMethod: cb.openPriced === 0 ? null
      : (cb.openPriced === cb.openPositions ? "weighted_open_positions"
                                            : "weighted_open_positions_partial"),
    costSource: cb.openPriced === 0 ? null : "stored trades: avg_entry_price x amount",
    costCoverage: cov(cb.openPriced, cb.openPositions),
    costReason: cb.openPriced > 0 ? null
      : "this coin's open positions carry no entry price, so what was paid is unknown",
    /** The share of the holding the cost covers, so a partial basis is never read as whole. */
    costAmountShare: known !== null && amount !== null && amount > 0
      ? Number(Math.min(1, known / amount).toFixed(4)) : null,
  };
}

/** V2. A confirmed honeypot or unsellable coin is held, priced, and NOT part of the total. */
export const unsellable = (r: { is_honeypot?: unknown; can_not_sell?: unknown }) =>
  r.is_honeypot === true || r.can_not_sell === true;
export const sellFlags = (r: { is_honeypot?: unknown; can_not_sell?: unknown }) => ({
  isHoneypot: r.is_honeypot === true,
  /** null when the security source never judged it; false when it said "cannot sell". */
  canSell: r.can_not_sell === null || r.can_not_sell === undefined ? null : !r.can_not_sell,
});
