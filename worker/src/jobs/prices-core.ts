/**
 * The price job's target statement (`./prices.ts`), which takes `sql` so
 * tests/current_holdings_jobs_test.ts can run it against the schema.
 */
import type { Sql } from "../d1.ts";
import { SOL_MINT, ZERO_ADDRESS } from "../../../supabase/functions/_shared/chain_reads.ts";
import { currentHoldings } from "../../../supabase/functions/_shared/current_holdings.ts";

export interface Target { readonly network_id: number; readonly chain: string; readonly token_key: string; readonly address: string }

/**
 * Every held, non-native token with the chain word DexScreener wants, MOST-HELD FIRST, then
 * stalest first. ~26k tokens are held and one run prices ~20k at the DexScreener pace, so the
 * order decides what an hourly run guarantees: the tokens most balances depend on are always
 * priced this hour; the one-holder dust tail rotates by `token_price_stats.last_at` (SQLite `asc`
 * already puts the never-sampled first, so the Postgres `nulls first` is implied).
 */
export const priceTargets = (sql: Sql) => sql<Target[]>`
  select h.network_id, ch.name as chain, h.token_key, tk.address
    from ${currentHoldings(sql)} h
    -- The cross joins state the order, h then tokens then chains: left free, the small derived table is drained into an automatic index.
    cross join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    cross join chains ch on ch.network_id = h.network_id
    left join token_price_stats ps on ps.network_id = h.network_id and ps.token_key = h.token_key
   where h.human_amount > 0 and h.token_key not in (${ZERO_ADDRESS}, ${SOL_MINT})
   group by h.network_id, ch.name, h.token_key, tk.address, ps.last_at
   order by count(distinct h.handle) desc, ps.last_at asc, h.network_id, h.token_key`;
