-- Daily / weekly (Monday) / monthly candles over token_price_hourly, for /tokens/:address/prices.
-- open/close are the first/last sampled hour in the bucket; `hours` says how full the bucket is.
-- Buckets are UTC whatever the session time zone. The (network_id, token_key, hour desc) index
-- from 20260917170000 already serves these; nothing new to add.

create or replace view token_price_daily as
select network_id, token_key,
       date_trunc('day', hour at time zone 'UTC') at time zone 'UTC' as bucket,
       (array_agg(usd order by hour asc))[1]  as open_usd,
       (array_agg(usd order by hour desc))[1] as close_usd,
       max(usd)                               as high_usd,
       min(usd)                               as low_usd,
       count(*)::int                          as hours
  from token_price_hourly
 group by 1, 2, 3;

create or replace view token_price_weekly as
select network_id, token_key,
       date_trunc('week', hour at time zone 'UTC') at time zone 'UTC' as bucket,
       (array_agg(usd order by hour asc))[1]  as open_usd,
       (array_agg(usd order by hour desc))[1] as close_usd,
       max(usd)                               as high_usd,
       min(usd)                               as low_usd,
       count(*)::int                          as hours
  from token_price_hourly
 group by 1, 2, 3;

create or replace view token_price_monthly as
select network_id, token_key,
       date_trunc('month', hour at time zone 'UTC') at time zone 'UTC' as bucket,
       (array_agg(usd order by hour asc))[1]  as open_usd,
       (array_agg(usd order by hour desc))[1] as close_usd,
       max(usd)                               as high_usd,
       min(usd)                               as low_usd,
       count(*)::int                          as hours
  from token_price_hourly
 group by 1, 2, 3;

comment on view token_price_daily   is 'UTC-day candles over token_price_hourly; hours = samples in the day.';
comment on view token_price_weekly  is 'ISO-week (Monday) candles over token_price_hourly; hours = samples in the week.';
comment on view token_price_monthly is 'Calendar-month candles over token_price_hourly; hours = samples in the month.';
