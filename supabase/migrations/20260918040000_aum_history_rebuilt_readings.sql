-- aum_history_build v2 (18 Sep 2026): rule 1 also accepts `rebuilt` readings so the hourly
-- series reaches back as far as the archive rebuild (late August) instead of the first chain
-- capture (9 Sep). Sampled readings still win inside an hour. Body otherwise identical to
-- 20260918010000_aum_history.sql.
create or replace function aum_history_build(p_handle text, p_from timestamptz, p_to timestamptz)
returns int language sql volatile as $$
  with hours as (
    select h as hour
      from generate_series(date_trunc('hour', p_from), date_trunc('hour', p_to), interval '1 hour') h
  ),
  -- Rule 1: a measurement inside the hour wins: a sampled one first, else a rebuilt one
  -- (the archive rebuild reaches back to late August, chain captures only to 9 Sep); the
  -- latest of the preferred kind.
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
  valued as (
    select b.hour,
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
          (select 2, ph.usd from token_price_hourly ph
            where ph.network_id = b.network_id and ph.token_key = b.token_key
              and ph.hour <= b.hour and ph.hour > b.hour - interval '24 hours'
            order by ph.hour desc limit 1)
          union all
          (select 3, tp.usd from token_prices tp
            where tp.network_id = b.network_id and tp.token_key = b.token_key and tp.day = (b.hour at time zone 'UTC')::date)
          union all
          (select 4, ti.price_usd from token_info ti
            where ti.network_id = b.network_id and ti.token_key = b.token_key and ti.price_usd is not null
              and b.hour = date_trunc('hour', now()))
        ) candidates order by pri limit 1
      ) p on true
  ),
  priced as (
    select hour, count(*)::int as total_positions, count(value_usd)::int as priced_positions, sum(value_usd) as total
      from valued group by hour
  ),
  computed as (
    select hr.hour,
           case when r.hour is not null then 'reading' else 'priced' end as basis,
           case when r.hour is not null then null
                when p.hour is null then 'no_holdings'
                when p.priced_positions = 0 then 'no_prices'
                when p.priced_positions::numeric / p.total_positions < 0.25 and p.total < 100 then 'too_little_priced'
                else null end as reason,
           r.total_usd as reading_usd, p.total as priced_usd,
           coalesce(r.priced_positions, p.priced_positions, 0) as priced_positions,
           coalesce(r.total_positions, p.total_positions, 0) as total_positions
      from hours hr
      left join reading r on r.hour = hr.hour
      left join priced p on p.hour = hr.hour
  ),
  written as (
    insert into aum_history (handle, hour, total_usd, priced_positions, total_positions, basis, reason, computed_at)
    select p_handle, hour,
           case when basis = 'reading' then reading_usd when reason is null then round(priced_usd, 2) end,
           priced_positions, total_positions, basis, reason, now()
      from computed
    on conflict (handle, hour) do update
      set total_usd = excluded.total_usd, priced_positions = excluded.priced_positions,
          total_positions = excluded.total_positions, basis = excluded.basis,
          reason = excluded.reason, computed_at = excluded.computed_at
    returning 1
  )
  select count(*)::int from written;
$$;
