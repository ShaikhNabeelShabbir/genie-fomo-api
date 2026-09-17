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

/** R6. Per chain: the wallet's sent-transaction count against the transaction rows the indexer holds for it. */
export type ChainCoverage = {
  chainTxCount: number | null; rowsHeld: number | null; share: number | null; readAt: string | null;
  basis: "bitquery_realtime";
};
export const COVERAGE_FLOOR = 0.5;

export const chainCoverage = (
  r: { chain_nonce?: unknown; rows_held?: unknown; read_at?: unknown },
): ChainCoverage => {
  const chainTxCount = n(r.chain_nonce), rowsHeld = n(r.rows_held);
  return {
    chainTxCount, rowsHeld,
    /* null, not 0, when either side is unknown; a wallet that never sent has nothing to cover. */
    share: chainTxCount !== null && rowsHeld !== null && chainTxCount > 0
      ? Number((rowsHeld / chainTxCount).toFixed(4)) : null,
    readAt: r.read_at ? new Date(String(r.read_at)).toISOString() : null,
    /* The count is Bitquery's realtime window, a LOWER bound on the wallet's nonce, so `share` is an upper bound. */
    basis: "bitquery_realtime",
  };
};

export const coverageLow = (c: Record<string, ChainCoverage>): boolean =>
  Object.values(c).some((x) => x.share !== null && x.share < COVERAGE_FLOOR);

/** Which of the three made the list partial; several, joined the way aum.coverage.partialReason is. */
export const positionsPartialReason = (unsellable: boolean, low: boolean, suspect = false): string | null =>
  [suspect && "price_suspect", unsellable && "unsellable_positions", low && "indexer_coverage_low"]
    .filter(Boolean).join("_and_") || null;

/** `{ handle -> { chainName -> coverage } }` from the sampler's chain_coverage rows. */
export async function indexerCoverageFor(handles: string[]): Promise<Map<string, Record<string, ChainCoverage>>> {
  const out = new Map<string, Record<string, ChainCoverage>>();
  if (!handles.length) return out;
  const rows = await sql`
    select cc.handle, c.name as chain, cc.chain_nonce, cc.rows_held, cc.read_at
    from chain_coverage cc join chains c using (network_id)
    where cc.handle = any(${handles})`;
  for (const r of rows) {
    const h = String(r.handle);
    out.set(h, { ...(out.get(h) ?? {}), [String(r.chain)]: chainCoverage(r) });
  }
  return out;
}

/** One `holdings_current` row as `/portfolio` reads it. */
export type PortfolioRow = {
  address?: unknown; network_id: unknown; chain?: unknown; value: unknown; captured_at?: unknown;
  is_quote?: unknown; is_honeypot?: unknown; can_not_sell?: unknown;
};
export type ChainTotal = {
  chain: unknown; network_id: number; positions: number; priced: number; value: number | null;
};

/**
 * The `/portfolio` totals, derived in memory from the trader's rows (one query, not five).
 *
 * Same filters the SQL used: `priced` is `value > 0`; `total`/`top` exclude unsellable coins,
 * `byChain.value` does NOT (a chain's dollars are what sits on it); `total`/`top` are null when
 * nothing sellable is priced, as `sum`/`max` over no rows were.
 */
export const portfolioFrom = (rows: PortfolioRow[]) => {
  const priced = rows.filter((r) => (n(r.value) ?? 0) > 0);
  const sellable = priced.filter((r) => !unsellable(r));
  const sum = (xs: PortfolioRow[]) => xs.reduce((s, r) => s + (n(r.value) ?? 0), 0);
  const top = sellable.reduce<PortfolioRow | null>(
    (best, r) => best === null || n(r.value)! > n(best.value)! ? r : best, null);
  const byChain = new Map<string, ChainTotal>();
  for (const r of rows) {
    const key = `${r.chain}:${Number(r.network_id)}`;
    const c = byChain.get(key) ??
      { chain: r.chain, network_id: Number(r.network_id), positions: 0, priced: 0, value: null };
    const v = n(r.value) ?? 0;
    byChain.set(key, {
      ...c,
      positions: c.positions + 1,
      priced: c.priced + (v > 0 ? 1 : 0),
      value: v > 0 ? (c.value ?? 0) + v : c.value,
    });
  }
  return {
    asOf: latestIso(rows.map((r) => r.captured_at)),
    positions: rows.length,
    priced: priced.length,
    total: sellable.length ? sum(sellable) : null,
    top,
    unsellable: sum(priced.filter(unsellable)),
    cash: sum(priced.filter((r) => !!r.is_quote)),
    byChain: [...byChain.values()].sort((a, b) => b.positions - a.positions),
  };
};

/** `max(captured_at)` over rows already in hand, as ISO; null when none carries one. */
export const latestIso = (ats: unknown[]): string | null =>
  ats.reduce<string | null>((best, v) => {
    if (!v) return best;
    const at = new Date(String(v)).toISOString();
    return best === null || at > best ? at : best;
  }, null);
