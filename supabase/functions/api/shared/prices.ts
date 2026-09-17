import { sql, n } from "../db.ts";

// ------------------------------------------------------------- T11/T13/T14

/** Each chain's own coin, and what one of them costs — so a chain's dollars can also be said… See docs/DECISIONS.md#d137 */
export type NativePrice = { symbol: string; usd: number | null; source: string | null };
export let nativeCache: { at: number; by: Map<number, NativePrice> } | null = null;

export async function nativePrices(): Promise<Map<number, NativePrice>> {
  if (nativeCache && Date.now() - nativeCache.at < 5 * 60_000) return nativeCache.by;
  const rows = await sql`
    with native as (
      select c.network_id, c.name, c.native_symbol,
             -- The key that HAS a price first: the native sentinel (0x000…0) must not shadow a priced WETH/WBNB.
             -- SQLite refuses an outer reference in a subquery's ORDER BY, so both ranks
             -- are computed as columns of a derived table and ordered by name.
             (select token_key from (
                select q.token_key,
                       (exists (select 1 from token_prices p
                                 where p.network_id = q.network_id
                                   and p.token_key = q.token_key)) as priced,
                       (upper(q.symbol) = upper(c.native_symbol)) as exact_symbol
                  from quote_assets q
                 where q.network_id = c.network_id
                   and upper(q.symbol) in ('W' || upper(c.native_symbol), upper(c.native_symbol)))
               order by priced desc, exact_symbol desc
               limit 1) as token_key
      from chains c)
    select n.network_id, n.native_symbol,
           coalesce(tp.usd, hp.price, xc.usd) as usd,
           case when tp.usd is not null then 'token_prices_daily'
                when hp.price is not null then hp.price_source
                when xc.usd is not null then xc.source || ' (via ' || xc.chain || ')'
                else null end as source
    from native n
    -- Each Postgres left join lateral (... limit 1) is the rn = 1 row of the same ordering.
    left join (
      select network_id, token_key, usd,
             row_number() over (partition by network_id, token_key order by day desc) as rn
      from token_prices) tp
      on tp.network_id = n.network_id and tp.token_key = n.token_key and tp.rn = 1
    left join (
      select h.network_id, h.token_key, h.price, h.price_source,
             row_number() over (
               partition by h.network_id, h.token_key order by h.priced_at desc) as rn
      from holdings_current h
      where h.price is not null
        and h.price_source is not null and h.price_source <> 'fomo_reported_entry') hp
      on hp.network_id = n.network_id and hp.token_key = n.token_key and hp.rn = 1
    /*
     * ETH IS ETH, whichever chain it is the native coin of.
     *
     * ethereum and base carry no market price for their own native in our store, while
     * robinhood's curated WETH is priced at 2,478.49 and Solana's at 2,497.98 -- two
     * independent sources agreeing within 0.8%, which is a real price for the asset rather
     * than a quirk of one chain. Refusing to use it would leave two chains unpriced for no
     * reason a reader would accept.
     *
     * Matched on the NATIVE SYMBOL against the curated quote assets only, never on any token
     * calling itself ETH: the store holds several impostors under that symbol, one of them
     * priced at 0.00. The chain it came from is named in the source string, so the borrowing
     * is visible rather than implied.
     *
     * The lateral was correlated on the native symbol rather than on a key, so the derived
     * table carries the symbol it serves and the outer join takes its newest priced row.
     */
    left join (
      select cn.native_symbol, h.price as usd, h.price_source as source, c2.name as chain,
             row_number() over (
               partition by upper(cn.native_symbol) order by h.priced_at desc) as rn
      from quote_assets q2
      join chains c2 on c2.network_id = q2.network_id
      join holdings_current h
        on h.network_id = q2.network_id and h.token_key = q2.token_key
      join (select distinct native_symbol from chains) cn
        on upper(q2.symbol) in ('W' || upper(cn.native_symbol), upper(cn.native_symbol))
      where h.price is not null and h.price > 0
        and h.price_source is not null and h.price_source <> 'fomo_reported_entry') xc
      on upper(xc.native_symbol) = upper(n.native_symbol) and xc.rn = 1`;
  const by = new Map<number, NativePrice>();
  for (const r of rows) {
    by.set(Number(r.network_id), {
      symbol: String(r.native_symbol),
      usd: n(r.usd),
      source: r.source ? String(r.source) : null,
    });
  }
  nativeCache = { at: Date.now(), by };
  return by;
}
