-- Balance history, BUILT from stored data rather than sampled from chain (18 Sep 2026).
-- See docs/DECISIONS.md "Added 18 Sep 2026 — aum_history" and docs/AUM_ROUTES.md.
--
-- One row per trader per UTC hour. A row is either a `reading` (an aum_samples measurement
-- taken in that hour) or `priced` (the latest chain capture before the hour's end, valued at
-- that hour's stored prices). total_usd NULL means not valued, never zero; `reason` says why.

create table if not exists aum_history (
  handle           text        not null references traders(handle) on delete cascade,
  hour             timestamptz not null,   -- bucket start, date_trunc('hour', …), UTC
  total_usd        numeric,                -- null = not valued; see reason
  priced_positions int         not null default 0,
  total_positions  int         not null default 0,
  basis            text        not null check (basis in ('reading','priced')),
  reason           text        check (reason in ('no_holdings','no_prices','too_little_priced')),
  computed_at      timestamptz not null default now(),
  primary key (handle, hour)
);

comment on table aum_history is
  'Hourly AUM per trader, rebuilt from holdings + stored prices (basis priced) or copied from '
  'an aum_samples measurement (basis reading). total_usd NULL means not valued, never zero.';

create index if not exists aum_history_hour_idx on aum_history (hour desc);

-- ------------------------------------------------------------------- rollups
-- total_usd = the LAST valued hour in the bucket (the close); high/low over valued hours.
create or replace view aum_history_daily as
  select handle, date_trunc('day', hour, 'UTC') as bucket,
         (array_agg(total_usd order by hour desc) filter (where total_usd is not null))[1] as total_usd,
         max(total_usd) as high_usd, min(total_usd) as low_usd,
         count(total_usd)::int as valued_hours, count(*)::int as hours
    from aum_history group by handle, date_trunc('day', hour, 'UTC');

create or replace view aum_history_weekly as
  select handle, date_trunc('week', hour, 'UTC') as bucket,
         (array_agg(total_usd order by hour desc) filter (where total_usd is not null))[1] as total_usd,
         max(total_usd) as high_usd, min(total_usd) as low_usd,
         count(total_usd)::int as valued_hours, count(*)::int as hours
    from aum_history group by handle, date_trunc('week', hour, 'UTC');

create or replace view aum_history_monthly as
  select handle, date_trunc('month', hour, 'UTC') as bucket,
         (array_agg(total_usd order by hour desc) filter (where total_usd is not null))[1] as total_usd,
         max(total_usd) as high_usd, min(total_usd) as low_usd,
         count(total_usd)::int as valued_hours, count(*)::int as hours
    from aum_history group by handle, date_trunc('month', hour, 'UTC');

-- ------------------------------------------------------------------- builder
-- Upserts every hour in [p_from, p_to] (hour-truncated, inclusive) for one trader. Returns
-- the number of rows written. Called by worker/src/jobs/aum_history.ts in chunks of <= 168 h.
--
-- Ceiling literals mirror supabase/functions/aum-sample/value.ts (source of truth):
--   MAX_PRICE_PER_TOKEN = 1000000, MAX_POSITION_USD = 1000000000, IMPLIED_MCAP_CEILING_USD = 20e9.
-- Floor literals mirror supabase/functions/api/shared/aum-rules.ts:
--   PRICED_FLOOR = 0.25 (count share), PARTIAL_SERVE_FLOOR_USD = 100.
create or replace function aum_history_build(p_handle text, p_from timestamptz, p_to timestamptz)
returns int language sql volatile as $$
  with hours as (
    select h as hour
      from generate_series(date_trunc('hour', p_from), date_trunc('hour', p_to), interval '1 hour') h
  ),
  -- Rule 1: a sampled measurement inside the hour wins; take the latest one.
  reading as (
    select hr.hour, s.total_usd, s.priced_positions, s.total_positions
      from hours hr
      cross join lateral (
        select total_usd, priced_positions, total_positions
          from aum_samples
         where handle = p_handle and basis = 'sampled' and total_usd is not null
           and at >= hr.hour and at < hr.hour + interval '1 hour'
         order by at desc limit 1
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

comment on function aum_history_build(text, timestamptz, timestamptz) is
  'Upserts aum_history for one trader over [p_from, p_to] hours inclusive; returns rows written. '
  'Ceilings and floors are literals mirroring aum-sample/value.ts and api/shared/aum-rules.ts.';
