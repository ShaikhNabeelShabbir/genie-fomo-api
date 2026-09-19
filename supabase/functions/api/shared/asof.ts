import { sql } from "../db.ts";

/**
 * When the underlying data was measured.
 *
 * Every money figure this API returns carries one. A dollar amount with no age goes stale
 * silently and a consumer cannot tell a fresh total from yesterday's — which is the whole
 * point of the field, so it is computed once here rather than per route.
 */
export const asOfHoldings = async (handle?: string): Promise<string | null> => {
  const [r] = handle
    ? await sql`select max(captured_at) as at from holdings_current where handle = ${handle}`
    /*
     * max() over holdings_current ran its correlated maximum on every chain row. The view's newest
     * row is the newest chain capture, or the newest fomo build when that is later AND still fills
     * a (trader, network) never read on chain: index seeks, plus at most one build's rows.
     */
    : await sql`
      select max(at) as at from (
        select max(captured_at) as at from holdings where source = 'chain'
        union all
        select * from (
          -- The unary + leaves captured_at to seek on; by source alone the planner reads every fomo row.
          select h.captured_at from holdings h
           where +h.source = 'fomo' and h.captured_at = (select captured_at from latest_capture)
             and (select captured_at from latest_capture)
                 > coalesce((select max(captured_at) from holdings where source = 'chain'), '')
             and not exists (select 1 from holdings c
                              where c.source = 'chain' and c.handle = h.handle
                                and c.network_id = h.network_id)
           limit 1))`;
  return r?.at ? new Date(String(r.at)).toISOString() : null;
};
/** When THIS trader's trade records were measured — not the board's. See docs/DECISIONS.md#d122 */
export const asOfTrades = async (handle?: string): Promise<string | null> => {
  const [r] = handle
    ? await sql`select max(captured_at) as at from trades where handle = ${handle}`
    : await sql`select max(captured_at) as at from trades`;
  return r?.at ? new Date(String(r.at)).toISOString() : null;
};

/** Freshness of the trade records behind one token, for the K5-K8 route. */
export const asOfToken = async (tokenKey: string): Promise<string | null> => {
  const [r] = await sql`select max(captured_at) as at from trades where token_key = ${tokenKey}`;
  return r?.at ? new Date(String(r.at)).toISOString() : null;
};
