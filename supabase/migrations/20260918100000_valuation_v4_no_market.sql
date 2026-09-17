-- Valuation v4 (17 Sep 2026, V1d). Verified live after the v3 deploy: the three suspect rules
-- still pass (a) several absurd coins each under 90 % of the remaining base, summing to $2.5B,
-- and (b) one coin at 99.5 % of a wallet whose supply is now known and whose implied cap is
-- under $20B. Both have no market behind the price. Both SQL valuers are re-created with the
-- v3 bodies (20260918060000) and this change only: a fourth rule, no_market_over_ceiling,
-- after the existing ones, on every row. Liquidity is the best pair's, from the latest
-- token_price_hourly row, else token_info.liquidity_usd; null = no pair known anywhere.
-- Literals mirror supabase/functions/aum-sample/value.ts (source of truth):
--   NO_MARKET_LIQUIDITY_MULTIPLE = 10 (value > 10 x liquidity), NO_MARKET_CEILING_USD = 1e6
--   (liquidity unknown and value > 1e6). Everything else unchanged from v3.

-- ------------------------------------------------------------------- live refresh
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
  -- Price per position, first hit wins: peg, latest hourly sample, latest daily close (<= 7 days),
  -- GMGN token info. A rung whose price is <= 0 is skipped.
  valued as (
    select b.handle,
           (coalesce(ti.is_honeypot, false) or coalesce(ti.can_not_sell, false)) as unsellable,
           coalesce(nullif(tk.total_supply, 0), nullif(ti.total_supply, 0)) as supply,
           p.usd as price,
           coalesce(ph.liquidity_usd, ti.liquidity_usd) as liquidity,
           case when p.usd is null or p.usd <= 0 then null
                when p.usd > 1000000 then null                                              -- MAX_PRICE_PER_TOKEN
                else b.human_amount * p.usd end as raw_usd
      from balances b
      left join tokens tk on tk.network_id = b.network_id and tk.token_key = b.token_key
      left join token_info ti on ti.network_id = b.network_id and ti.token_key = b.token_key
      left join lateral (
        select usd from (
          (select 1 as pri, q.pegged_usd as usd from quote_assets q
            where q.network_id = b.network_id and q.token_key = b.token_key and q.pegged_usd > 0)
          union all
          (select 2, s.last_usd from token_price_stats s
            where s.network_id = b.network_id and s.token_key = b.token_key and s.last_usd > 0)
          union all
          (select 3, tp.usd from token_prices tp
            where tp.network_id = b.network_id and tp.token_key = b.token_key
              and tp.usd > 0 and tp.day <= now()::date and tp.day > now()::date - 7
            order by tp.day desc limit 1)
          union all
          (select 4, nullif(ti2.price_usd, 0) from token_info ti2
            where ti2.network_id = b.network_id and ti2.token_key = b.token_key and ti2.price_usd > 0)
        ) candidates order by pri limit 1
      ) p on true
      -- V1d: the best pair's liquidity, latest hourly sample first, else GMGN's; null = no pair known.
      left join lateral (
        select liquidity_usd from token_price_hourly
         where network_id = b.network_id and token_key = b.token_key
         order by hour desc limit 1
      ) ph on true
  ),
  -- The value.ts rules, per row: unsellable first, then implied cap, then concentration against
  -- the wallet's sellable gross, then the position ceiling (suspect when the cap is unknown),
  -- then no market behind the price (V1d, value.ts noMarketSuspect): worth over 10x the pool,
  -- or over $1M with no pool known.
  classified as (
    select handle, raw_usd,
           case when raw_usd is null then 'unpriced'
                when unsellable then 'unsellable'
                when supply is not null and price * supply > 20e9 then 'suspect'            -- IMPLIED_MCAP_CEILING_USD
                when raw_usd > 0.9 * sum(raw_usd) filter (where not unsellable) over (partition by handle)   -- CONCENTRATION_SHARE
                     and (supply is null
                          or sum(raw_usd) filter (where not unsellable) over (partition by handle) > 1e9)   -- CONCENTRATION_TOTAL_USD
                     then 'suspect'
                when raw_usd > 1000000000 then case when supply is null then 'suspect' else 'unpriced' end  -- MAX_POSITION_USD
                when liquidity is not null and raw_usd > 10 * liquidity then 'suspect'      -- NO_MARKET_LIQUIDITY_MULTIPLE
                when liquidity is null and raw_usd > 1e6 then 'suspect'                     -- NO_MARKET_CEILING_USD
                else 'priced' end as kind
      from valued
  ),
  priced as (
    select handle, count(*)::int as total_positions,
           count(*) filter (where kind = 'priced' and raw_usd > 0)::int as priced_positions,
           sum(raw_usd) filter (where kind = 'priced' and raw_usd > 0) as total,
           sum(raw_usd) filter (where kind = 'suspect') as suspect_usd,
           sum(raw_usd) filter (where kind = 'unsellable') as unsellable_usd
      from classified group by handle
  ),
  computed as (
    select t.handle,
           case when p.handle is null then 'no_holdings'
                when p.priced_positions = 0 and p.suspect_usd is not null then 'price_suspect'
                when p.priced_positions = 0 then 'no_prices'
                when p.priced_positions::numeric / p.total_positions < 0.25 and p.total < 100 then 'too_little_priced'
                else null end as reason,
           p.total as priced_usd,
           p.suspect_usd, p.unsellable_usd,
           coalesce(p.priced_positions, 0) as priced_positions,
           coalesce(p.total_positions, 0) as total_positions
      from targets t
      left join priced p on p.handle = t.handle
  ),
  live as (
    insert into aum_live (handle, at, total_usd, suspect_usd, unsellable_usd, priced_positions, total_positions, reason, source)
    select handle, now(), case when reason is null then priced_usd end, suspect_usd, unsellable_usd,
           priced_positions, total_positions, reason, p_source
      from computed
    on conflict (handle) do update
      set at = excluded.at, total_usd = excluded.total_usd, suspect_usd = excluded.suspect_usd,
          unsellable_usd = excluded.unsellable_usd, priced_positions = excluded.priced_positions,
          total_positions = excluded.total_positions, reason = excluded.reason, source = excluded.source
    returning 1
  ),
  hour_point as (
    insert into aum_history (handle, hour, total_usd, suspect_usd, unsellable_usd, priced_positions, total_positions, basis, reason, computed_at)
    select handle, date_trunc('hour', now()), case when reason is null then priced_usd end, suspect_usd, unsellable_usd,
           priced_positions, total_positions, 'priced', reason, now()
      from computed
    on conflict (handle, hour) do update
      set total_usd = excluded.total_usd, suspect_usd = excluded.suspect_usd,
          unsellable_usd = excluded.unsellable_usd, priced_positions = excluded.priced_positions,
          total_positions = excluded.total_positions, basis = excluded.basis,
          reason = excluded.reason, computed_at = excluded.computed_at
    returning 1
  )
  select count(*)::int from live;
$$;

comment on function aum_live_refresh(text[], text, interval) is
  'Revalues holdings_live for p_handles (null/empty = every trader with a wallet; p_older_than '
  'limits to stale/missing aum_live rows), upserting aum_live and the current hour of '
  'aum_history. Suspect and unsellable value is kept beside the total, never in it. '
  'Returns rows upserted. Ceilings/floors mirror aum-sample/value.ts and aum-rules.ts.';

-- ------------------------------------------------------------------- history build
create or replace function aum_history_build(p_handle text, p_from timestamptz, p_to timestamptz)
returns int language sql volatile as $$
  with hours as (
    select h as hour
      from generate_series(date_trunc('hour', p_from), date_trunc('hour', p_to), interval '1 hour') h
  ),
  -- Rule 1 (unchanged): a measurement inside the hour wins: a sampled one first, else a rebuilt one.
  reading as (
    select hr.hour, s.total_usd, s.priced_positions, s.total_positions
      from hours hr
      cross join lateral (
        select total_usd, priced_positions, total_positions
          from aum_samples
         where handle = p_handle and basis in ('sampled', 'rebuilt') and total_usd is not null
           and at >= hr.hour and at < hr.hour + interval '1 hour'
         order by (basis = 'sampled') desc, at desc limit 1
      ) s
  ),
  -- Rule 2: per (hour, network), the latest chain capture before the hour ends.
  captures as (
    select hr.hour, n.network_id, c.captured_at
      from hours hr
      cross join (select distinct network_id from holdings where handle = p_handle and source = 'chain') n
      cross join lateral (
        select max(captured_at) as captured_at
          from holdings
         where handle = p_handle and network_id = n.network_id and source = 'chain'
           and captured_at < hr.hour + interval '1 hour'
      ) c
     where c.captured_at is not null
       and not exists (select 1 from reading r where r.hour = hr.hour)
  ),
  balances as (
    select c.hour, h.network_id, h.token_key, h.human_amount
      from captures c
      join holdings h on h.handle = p_handle and h.network_id = c.network_id
                     and h.captured_at = c.captured_at and h.source = 'chain'
     where h.human_amount > 0
  ),
  -- Price per position, first hit wins: peg, hourly (<= 24 h stale), daily, live (current hour only).
  -- A rung whose price is <= 0 is skipped.
  valued as (
    select b.hour,
           (coalesce(ti.is_honeypot, false) or coalesce(ti.can_not_sell, false)) as unsellable,
           coalesce(nullif(tk.total_supply, 0), nullif(ti.total_supply, 0)) as supply,
           p.usd as price,
           coalesce(ph.liquidity_usd, ti.liquidity_usd) as liquidity,
           case when p.usd is null or p.usd <= 0 then null
                when p.usd > 1000000 then null                                              -- MAX_PRICE_PER_TOKEN
                else b.human_amount * p.usd end as raw_usd
      from balances b
      left join tokens tk on tk.network_id = b.network_id and tk.token_key = b.token_key
      left join token_info ti on ti.network_id = b.network_id and ti.token_key = b.token_key
      left join lateral (
        select usd from (
          (select 1 as pri, q.pegged_usd as usd from quote_assets q
            where q.network_id = b.network_id and q.token_key = b.token_key and q.pegged_usd > 0)
          union all
          (select 2, ph.usd from token_price_hourly ph
            where ph.network_id = b.network_id and ph.token_key = b.token_key and ph.usd > 0
              and ph.hour <= b.hour and ph.hour > b.hour - interval '24 hours'
            order by ph.hour desc limit 1)
          union all
          (select 3, tp.usd from token_prices tp
            where tp.network_id = b.network_id and tp.token_key = b.token_key and tp.usd > 0
              and tp.day = (b.hour at time zone 'UTC')::date)
          union all
          (select 4, nullif(ti2.price_usd, 0) from token_info ti2
            where ti2.network_id = b.network_id and ti2.token_key = b.token_key and ti2.price_usd > 0
              and b.hour = date_trunc('hour', now()))
        ) candidates order by pri limit 1
      ) p on true
      -- V1d: the best pair's liquidity, latest hourly sample first, else GMGN's; null = no pair known.
      left join lateral (
        select liquidity_usd from token_price_hourly
         where network_id = b.network_id and token_key = b.token_key
         order by hour desc limit 1
      ) ph on true
  ),
  -- The value.ts rules, per row (same as aum_live_refresh), partitioned by hour.
  classified as (
    select hour, raw_usd,
           case when raw_usd is null then 'unpriced'
                when unsellable then 'unsellable'
                when supply is not null and price * supply > 20e9 then 'suspect'            -- IMPLIED_MCAP_CEILING_USD
                when raw_usd > 0.9 * sum(raw_usd) filter (where not unsellable) over (partition by hour)     -- CONCENTRATION_SHARE
                     and (supply is null
                          or sum(raw_usd) filter (where not unsellable) over (partition by hour) > 1e9)     -- CONCENTRATION_TOTAL_USD
                     then 'suspect'
                when raw_usd > 1000000000 then case when supply is null then 'suspect' else 'unpriced' end  -- MAX_POSITION_USD
                when liquidity is not null and raw_usd > 10 * liquidity then 'suspect'      -- NO_MARKET_LIQUIDITY_MULTIPLE
                when liquidity is null and raw_usd > 1e6 then 'suspect'                     -- NO_MARKET_CEILING_USD
                else 'priced' end as kind
      from valued
  ),
  priced as (
    select hour, count(*)::int as total_positions,
           count(*) filter (where kind = 'priced' and raw_usd > 0)::int as priced_positions,
           sum(raw_usd) filter (where kind = 'priced' and raw_usd > 0) as total,
           sum(raw_usd) filter (where kind = 'suspect') as suspect_usd,
           sum(raw_usd) filter (where kind = 'unsellable') as unsellable_usd
      from classified group by hour
  ),
  computed as (
    select hr.hour,
           case when r.hour is not null then 'reading' else 'priced' end as basis,
           case when r.hour is not null then null
                when p.hour is null then 'no_holdings'
                when p.priced_positions = 0 and p.suspect_usd is not null then 'price_suspect'
                when p.priced_positions = 0 then 'no_prices'
                when p.priced_positions::numeric / p.total_positions < 0.25 and p.total < 100 then 'too_little_priced'
                else null end as reason,
           r.total_usd as reading_usd, p.total as priced_usd,
           case when r.hour is null then p.suspect_usd end as suspect_usd,
           case when r.hour is null then p.unsellable_usd end as unsellable_usd,
           coalesce(r.priced_positions, p.priced_positions, 0) as priced_positions,
           coalesce(r.total_positions, p.total_positions, 0) as total_positions
      from hours hr
      left join reading r on r.hour = hr.hour
      left join priced p on p.hour = hr.hour
  ),
  written as (
    insert into aum_history (handle, hour, total_usd, suspect_usd, unsellable_usd, priced_positions, total_positions, basis, reason, computed_at)
    select p_handle, hour,
           case when basis = 'reading' then reading_usd when reason is null then priced_usd end,
           suspect_usd, unsellable_usd,
           priced_positions, total_positions, basis, reason, now()
      from computed
    on conflict (handle, hour) do update
      set total_usd = excluded.total_usd, suspect_usd = excluded.suspect_usd,
          unsellable_usd = excluded.unsellable_usd, priced_positions = excluded.priced_positions,
          total_positions = excluded.total_positions, basis = excluded.basis,
          reason = excluded.reason, computed_at = excluded.computed_at
    returning 1
  )
  select count(*)::int from written;
$$;
