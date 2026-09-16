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
    : await sql`select max(captured_at) as at from holdings_current`;
  return r?.at ? new Date(String(r.at)).toISOString() : null;
};
/**
 * When THIS trader's trade records were measured — not the board's.
 *
 * The unscoped version reported `max(captured_at)` across all 114 traders, so a trader last
 * refreshed two days ago still showed today's timestamp on their own page. That is exactly
 * the failure the consuming team reported against /v1/traders ("we cannot tell a trader
 * refreshed a minute ago from one refreshed a day ago"), which was fixed there with a
 * per-trader `updatedAt` and then quietly reintroduced here.
 *
 * Passing no handle keeps the board-wide value, which is the right answer only for
 * board-wide questions.
 */
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
