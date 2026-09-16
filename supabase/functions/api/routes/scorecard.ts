import { sql, n, round } from "../db.ts";
import { get, post } from "../router.ts";
import { notFound } from "../errors.ts";
import { asOfTrades } from "../shared/asof.ts";
import { intParam } from "../shared/params.ts";
import { cov, money } from "../shared/format.ts";
import { nativePrices } from "../shared/prices.ts";
import { resolveTrader } from "../shared/traders.ts";
import { scorecardRows, feesFor, swapsFor, chainEntriesFrom, chainExitsFrom, buysFrom, onChainFrom, monthStartCapital, scorecardBody, latestLoad } from "../shared/scorecard-core.ts";
import { pnlAgg, pnlBody } from "../shared/pnl-core.ts";

get("/v1/traders/:handle/scorecard", async ({ handle }, url) => {
  const [t] = await sql`
    select t.handle, t.display_handle, t.name, t.source, s.volume_usd, s.trade_count, ld.*
    from traders t left join trader_stats_current s using (handle) ${latestLoad()}
    where t.handle = ${await resolveTrader(handle)}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const h = t.handle as string;
  /*
   * Three queries became one. The entry price, the exit P&L and the individual buys are all
   * derived from the same swap rows, so they are fetched once -- see `swapsFor`.
   */
  const [rows, swapBy, feeBy, [seen]] = await Promise.all([
    scorecardRows([h]),
    swapsFor([h]),
    nativePrices().then((nat) => feesFor([h], nat)),
    /** T3. Swap-shaped groups in `transactions` — the denominator of `onChain.coverage`. */
    sql`select count(*)::int as n from (
          select x.network_id, x.tx_hash from transactions x
          join wallets w on lower(w.sol_address) = x.address_key or w.evm_address_key = x.address_key
          where w.handle = ${h} and x.tx_type = 'SWAP'
          group by x.network_id, x.tx_hash) g`,
  ]);
  if (!rows.length) throw notFound(`no stored trades for '${t.handle}'`);

  const swaps = swapBy.get(h) ?? [];
  const entries = chainEntriesFrom(swaps);
  const startCap = (await monthStartCapital([h])).get(h) ?? null;
  return await scorecardBody(t, rows, intParam(url, "tokens", { min: 0, fallback: null }), {
    entries,
    exits: chainExitsFrom(swaps, entries),
  }, feeBy.get(h) ?? null, buysFrom(swaps), startCap, onChainFrom(swaps, Number(seen?.n ?? 0)));
});


/** T2.2. See docs/DECISIONS.md#d078 */
const chainPnl = (addrs: string[]) => sql`
  select count(*)::int                                             as swaps,
         count(distinct token_key)::int                            as tokens,
         coalesce(sum(quote_usd), 0)                               as net_cash_usd,
         count(*) filter (where quote_usd is null)::int            as unvalued,
         min(block_time)                                           as first_at,
         max(block_time)                                           as last_at
  from wallet_swaps where address_key = any(${addrs})`;

/** Positions the wallet opened AND fully closed on chain — where the token quantity nets to a… See docs/DECISIONS.md#d079 */
const chainRoundTrips = (addrs: string[]) => sql`
  select count(*)::int                          as closed_positions,
         coalesce(sum(net_usd), 0)              as realized_usd,
         count(*) filter (where net_usd > 0)::int as winners
  from (
    select token_key,
           sum(quote_usd)  as net_usd,
           sum(token_delta) as residual
    from wallet_swaps
    where address_key = any(${addrs}) and quote_usd is not null
    group by token_key
    having abs(sum(token_delta)) < 1e-6 and count(*) > 1
  ) s`;

get("/v1/traders/:handle/pnl", async ({ handle }) => {
  const [t] = await sql`
    select t.handle, t.display_handle, t.name, w.sol_address
    from traders t left join wallets w using (handle)
    where t.handle = ${await resolveTrader(handle)}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const addrs = t.sol_address ? [String(t.sol_address).toLowerCase()] : [];
  const [[r], [chain], [rt], [seen]] = await Promise.all([
    pnlAgg([t.handle as string]),
    addrs.length ? chainPnl(addrs) : Promise.resolve([undefined]),
    addrs.length ? chainRoundTrips(addrs) : Promise.resolve([undefined]),
    addrs.length
      ? sql`select count(*)::int as n from (
              select tx_hash from transactions
               where network_id = 1399811149 and tx_type = 'SWAP'
                 and address_key = any(${addrs}) group by tx_hash) x`
      : Promise.resolve([{ n: 0 }]),
  ]);

  const body = pnlBody(t, r) as Record<string, unknown>;
  /*
   * The fomo figures in `body` date from the trade load; `chainDerived` below dates from the
   * swaps we resolved ourselves. `asOf` names the first, and `chainDerived.lastSwapAt` the
   * second, so neither one is read as speaking for the other.
   */
  body.asOf = await asOfTrades(t.handle as string);
  const swaps = Number(chain?.swaps ?? 0);
  body.chainDerived = swaps
    ? {
      /**
       * Realised profit over positions opened and fully closed on chain. `null` rather than
       * 0 when none have round-tripped — "no closed position" is not "made nothing".
       */
      realizedUsd: Number(rt?.closed_positions ?? 0) > 0 ? round(n(rt?.realized_usd)) : null,
      closedPositions: Number(rt?.closed_positions ?? 0),
      winners: Number(rt?.winners ?? 0),
      /**
       * Dollars out minus dollars in across every resolved swap, open positions included.
       * Negative for anyone still holding, which is correct and is why it is named for cash
       * flow rather than profit.
       */
      netCashUsd: round(n(chain?.net_cash_usd)),
      swapsResolved: swaps,
      tokensTraded: Number(chain?.tokens ?? 0),
      firstSwapAt: chain?.first_at ? new Date(String(chain.first_at)).toISOString() : null,
      lastSwapAt: chain?.last_at ? new Date(String(chain.last_at)).toISOString() : null,
      tier: "verified",
      source: "postgres · wallet_swaps (helius rpc pre/post balances)",
      basis: "both sides of each swap resolved from the wallet's net balance change, so a " +
             "buy and its matching sell reconcile on quantity. Solana only.",
      coverage: cov(swaps, Number(seen?.n ?? 0)),
      note: "coverage is low BY CONSTRUCTION: most rows tagged SWAP are inbound transfers " +
            "inside someone else's transaction, not trades the wallet made. Only two-sided " +
            "swaps are counted, and this figure is independent of the fomo numbers above.",
    }
    : null;
  return body;
});
