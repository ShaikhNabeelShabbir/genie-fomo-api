-- Real-time current AUM (17 Sep 2026). aum_history is hourly; the product wants the CURRENT
-- value refreshed the moment a watched wallet transacts. One row per trader, overwritten by
-- whichever feed moved last: the Helius webhook (Solana transfers), the balances job (EVM
-- captures), the prices job (new hourly prices) or the aum_history job (catch-up).
-- total_usd NULL means not valued, never zero; `reason` says why (same words as aum_history).

create table if not exists aum_live (
  handle           text        primary key references traders(handle) on delete cascade,
  at               timestamptz not null,               -- when this value was computed
  total_usd        numeric,                            -- null = not valued; see reason
  priced_positions int         not null default 0,
  total_positions  int         not null default 0,
  reason           text        check (reason in ('no_holdings','no_prices','too_little_priced')),
  source           text        not null check (source in ('webhook','balances','prices','build'))
);

comment on table aum_live is
  'Current AUM per trader, revalued on every feed event (webhook, balances, prices, build). '
  'Values holdings_live at the latest stored prices. total_usd NULL means not valued, never zero.';

create index if not exists aum_live_at_idx on aum_live (at desc);

-- ------------------------------------------------------------------- refresh
-- Values the CURRENT holdings (holdings_live: Solana rolled forward from the webhook feed,
-- other chains at their latest capture) for p_handles (null/empty = every trader with a
-- wallet), optionally only those whose aum_live row is missing or older than p_older_than.
-- Upserts aum_live AND the current hour's aum_history row (basis priced), so the hourly
-- series' last point is as fresh as the live value. Returns rows upserted. Set-based: no loops.
--
-- Ceiling literals mirror supabase/functions/aum-sample/value.ts (source of truth):
--   MAX_PRICE_PER_TOKEN = 1000000, MAX_POSITION_USD = 1000000000, IMPLIED_MCAP_CEILING_USD = 20e9.
-- Floor literals mirror supabase/functions/api/shared/aum-rules.ts:
--   PRICED_FLOOR = 0.25 (count share), PARTIAL_SERVE_FLOOR_USD = 100.
create or replace function aum_live_refresh(p_handles text[], p_source text, p_older_than interval default null)
returns int language sql volatile as $$
  with targets as (
    select t.handle
      from traders t
     where exists (select 1 from wallets w
                    where w.handle = t.handle and (w.sol_address is not null or w.evm_address is not null))
       and (p_handles is null or cardinality(p_handles) = 0 or t.handle = any(p_handles))
       and (p_older_than is null
            or not exists (select 1 from aum_live l where l.handle = t.handle and l.at >= now() - p_older_than))
  ),
  balances as (
    select h.handle, h.network_id, h.token_key, coalesce(h.human_amount_live, h.human_amount) as human_amount
      from holdings_live h
      join targets t on t.handle = h.handle
     where coalesce(h.human_amount_live, h.human_amount) > 0
  ),
  -- Price per position, first hit wins: peg, latest hourly sample, GMGN token info.
  valued as (
    select b.handle,
           case when p.usd is null then null
                when p.usd > 1000000 then null                                              -- MAX_PRICE_PER_TOKEN
                when b.human_amount * p.usd > 1000000000 then null                          -- MAX_POSITION_USD
                when tk.total_supply > 0 and p.usd * tk.total_supply > 20e9 then null      -- IMPLIED_MCAP_CEILING_USD
                else b.human_amount * p.usd end as value_usd
      from balances b
      left join tokens tk on tk.network_id = b.network_id and tk.token_key = b.token_key
      left join lateral (
        select usd from (
          (select 1 as pri, q.pegged_usd as usd from quote_assets q
            where q.network_id = b.network_id and q.token_key = b.token_key and q.pegged_usd is not null)
          union all
          (select 2, s.last_usd from token_price_stats s
            where s.network_id = b.network_id and s.token_key = b.token_key)
          union all
          (select 3, ti.price_usd from token_info ti
            where ti.network_id = b.network_id and ti.token_key = b.token_key and ti.price_usd is not null)
        ) candidates order by pri limit 1
      ) p on true
  ),
  priced as (
    select handle, count(*)::int as total_positions, count(value_usd)::int as priced_positions, sum(value_usd) as total
      from valued group by handle
  ),
  computed as (
    select t.handle,
           case when p.handle is null then 'no_holdings'
                when p.priced_positions = 0 then 'no_prices'
                when p.priced_positions::numeric / p.total_positions < 0.25 and p.total < 100 then 'too_little_priced'
                else null end as reason,
           p.total as priced_usd,
           coalesce(p.priced_positions, 0) as priced_positions,
           coalesce(p.total_positions, 0) as total_positions
      from targets t
      left join priced p on p.handle = t.handle
  ),
  live as (
    insert into aum_live (handle, at, total_usd, priced_positions, total_positions, reason, source)
    select handle, now(), case when reason is null then round(priced_usd, 2) end,
           priced_positions, total_positions, reason, p_source
      from computed
    on conflict (handle) do update
      set at = excluded.at, total_usd = excluded.total_usd, priced_positions = excluded.priced_positions,
          total_positions = excluded.total_positions, reason = excluded.reason, source = excluded.source
    returning 1
  ),
  hour_point as (
    insert into aum_history (handle, hour, total_usd, priced_positions, total_positions, basis, reason, computed_at)
    select handle, date_trunc('hour', now()), case when reason is null then round(priced_usd, 2) end,
           priced_positions, total_positions, 'priced', reason, now()
      from computed
    on conflict (handle, hour) do update
      set total_usd = excluded.total_usd, priced_positions = excluded.priced_positions,
          total_positions = excluded.total_positions, basis = excluded.basis,
          reason = excluded.reason, computed_at = excluded.computed_at
    returning 1
  )
  select count(*)::int from live;
$$;

comment on function aum_live_refresh(text[], text, interval) is
  'Revalues holdings_live for p_handles (null/empty = every trader with a wallet; p_older_than '
  'limits to stale/missing aum_live rows), upserting aum_live and the current hour of '
  'aum_history. Returns rows upserted. Ceilings/floors mirror aum-sample/value.ts and aum-rules.ts.';
