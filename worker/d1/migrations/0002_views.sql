-- D1 (SQLite) views: the 12 views of the final Postgres state, same names and columns.
-- Postgres features each one used, and what replaced them: worker/d1/SCHEMA_MAP.md.
-- Bucket columns are TEXT 'YYYY-MM-DDT00:00:00.000Z' (UTC), like every other timestamp.

-- Newest fomo build timestamp (20260909100000).
create view if not exists latest_capture as
  select max(captured_at) as captured_at from holdings where source = 'fomo';

-- Balances read from chain, with the newest fomo build filling any (trader, network) we have
-- not read ourselves; chain wins because a running total is not a balance (20260910180000).
create view if not exists holdings_current as
  with chain_latest as (
    select handle, network_id, max(captured_at) as captured_at
    from holdings where source = 'chain'
    group by handle, network_id
  ),
  chain as (
    select h.* from holdings h
    join chain_latest cl
      on cl.handle = h.handle and cl.network_id = h.network_id and cl.captured_at = h.captured_at
    where h.source = 'chain'
  )
  select * from chain
  union all
  select h.* from holdings h
  where h.source = 'fomo'
    and h.captured_at = (select captured_at from latest_capture)
    and not exists (
      select 1 from chain c where c.handle = h.handle and c.network_id = h.network_id
    );

-- The newest trader_stats row per handle (20260914120000). Was `distinct on (handle)`.
create view if not exists trader_stats_current as
  select handle, captured_at, rank, pnl_usd, volume_usd, trade_count, followers
  from (
    select handle, captured_at, rank, pnl_usd, volume_usd, trade_count, followers,
           row_number() over (partition by handle order by captured_at desc) as rn
    from trader_stats
  )
  where rn = 1;

-- Chains each trader has been OBSERVED trading on (20260910160000).
create view if not exists wallet_chain_presence as
  select tr.handle,
         tr.network_id,
         ch.name             as chain,
         count(*)            as trades_seen,
         max(tr.captured_at) as last_active_at
  from trades tr
  join chains ch on ch.network_id = tr.network_id
  group by tr.handle, tr.network_id, ch.name;

-- holdings_current rolled forward on Solana by the signed sum of transactions since the read
-- (webhook feed, not a chain read). EVM rows pass through with delta null. Positions opened
-- since the read appear with human_amount 0 and no price (20260917190000).
-- The Postgres `left join lateral` became three correlated subqueries over the same predicate.
create view if not exists holdings_live as
  with sol_read as (
    select handle, max(captured_at) as captured_at
    from holdings_current where network_id = 1399811149
    group by handle
  ),
  rolled as (
    select h.handle, h.network_id, h.token_key, h.captured_at, h.human_amount, h.price,
           h.value, h.source, h.price_source, h.priced_at,
           case when h.network_id = 1399811149 then
             (select sum(case t.direction when 'in' then t.amount when 'out' then -t.amount end)
                from transactions t
                join wallets w on w.sol_address_key = t.address_key
               where w.handle = h.handle
                 and t.network_id = h.network_id
                 and t.token_key = h.token_key
                 and t.direction in ('in', 'out')
                 and t.amount is not null
                 and t.block_time > h.captured_at)
           end as delta,
           case when h.network_id = 1399811149 then
             (select max(t.block_time)
                from transactions t
                join wallets w on w.sol_address_key = t.address_key
               where w.handle = h.handle
                 and t.network_id = h.network_id
                 and t.token_key = h.token_key
                 and t.direction in ('in', 'out')
                 and t.amount is not null
                 and t.block_time > h.captured_at)
           end as last_transfer_at,
           case when h.network_id = 1399811149 then
             (select count(*)
                from transactions t
                join wallets w on w.sol_address_key = t.address_key
               where w.handle = h.handle
                 and t.network_id = h.network_id
                 and t.token_key = h.token_key
                 and t.direction in ('in', 'out')
                 and t.amount is not null
                 and t.block_time > h.captured_at)
           else 0 end as transfers
    from holdings_current h
  )
  select handle, network_id, token_key, captured_at, human_amount, price,
         value, source, price_source, priced_at,
         case when network_id = 1399811149 then coalesce(delta, 0) end as delta,
         case when network_id = 1399811149 then human_amount + coalesce(delta, 0) end as human_amount_live,
         case when network_id = 1399811149 then captured_at end as delta_since,
         last_transfer_at,
         transfers as transfers_since_read
  from rolled
  union all
  -- Brand-new positions: moved since the read, absent from the read.
  select w.handle, t.network_id, t.token_key,
         null as captured_at, 0 as human_amount, null as price,
         null as value, null as source, null as price_source, null as priced_at,
         sum(case t.direction when 'in' then t.amount when 'out' then -t.amount end) as delta,
         sum(case t.direction when 'in' then t.amount when 'out' then -t.amount end) as human_amount_live,
         r.captured_at as delta_since,
         max(t.block_time) as last_transfer_at,
         count(*) as transfers_since_read
  from transactions t
  join wallets w on w.sol_address_key = t.address_key
  left join sol_read r on r.handle = w.handle
  where t.network_id = 1399811149
    and t.direction in ('in', 'out')
    and t.amount is not null
    and (r.captured_at is null or t.block_time > r.captured_at)
    and not exists (
      select 1 from holdings_current h
      where h.handle = w.handle and h.network_id = t.network_id and h.token_key = t.token_key
    )
  group by w.handle, t.network_id, t.token_key, r.captured_at;

-- One row per (trader, chain) evidenced by a trade, a live position or an accepted chain
-- sample; history_state = ready (>= 2) | warming (1) | none (0) (20260917230000).
create view if not exists trader_chain_history as
  select e.handle,
         e.network_id,
         c.name                 as chain,
         sum(e.positions)       as positions,
         sum(e.history_points)  as history_points,
         case when sum(e.history_points) >= 2 then 'ready'
              when sum(e.history_points) = 1  then 'warming'
              else 'none' end   as history_state
  from (
    select handle, network_id, 0 as positions, 0 as history_points
    from wallet_chain_presence
    union all
    select handle, network_id, 1, 0
    from holdings_current where human_amount > 0
    union all
    select handle, network_id, 0, 1
    from aum_chain_samples where total_usd is not null
  ) e
  join chains c on c.network_id = e.network_id
  group by e.handle, e.network_id, c.name;

-- ------------------------------------------------------------------- aum_history rollups
-- total_usd = the LAST valued hour in the bucket (the close); high/low over valued hours
-- (20260918010000). Postgres `(array_agg(total_usd order by hour desc) filter (where total_usd
-- is not null))[1]` is a row_number over the valued rows of the bucket, newest first.
-- Week buckets start on Monday: `-6 days` then `weekday 1` (0 = Sunday) lands on the Monday
-- on or before the hour (Mon -> itself, Sun -> six days back), the same as date_trunc('week').
create view if not exists aum_history_daily as
  select handle, bucket,
         max(case when rn = 1 then total_usd end) as total_usd,
         max(total_usd) as high_usd, min(total_usd) as low_usd,
         count(total_usd) as valued_hours, count(*) as hours
  from (
    select handle, total_usd,
           strftime('%Y-%m-%dT00:00:00.000Z', hour) as bucket,
           row_number() over (
             partition by handle, strftime('%Y-%m-%dT00:00:00.000Z', hour), total_usd is null
             order by hour desc) as rn
    from aum_history
  )
  group by handle, bucket;

create view if not exists aum_history_weekly as
  select handle, bucket,
         max(case when rn = 1 then total_usd end) as total_usd,
         max(total_usd) as high_usd, min(total_usd) as low_usd,
         count(total_usd) as valued_hours, count(*) as hours
  from (
    select handle, total_usd,
           strftime('%Y-%m-%dT00:00:00.000Z', hour, '-6 days', 'weekday 1') as bucket,
           row_number() over (
             partition by handle, strftime('%Y-%m-%dT00:00:00.000Z', hour, '-6 days', 'weekday 1'), total_usd is null
             order by hour desc) as rn
    from aum_history
  )
  group by handle, bucket;

create view if not exists aum_history_monthly as
  select handle, bucket,
         max(case when rn = 1 then total_usd end) as total_usd,
         max(total_usd) as high_usd, min(total_usd) as low_usd,
         count(total_usd) as valued_hours, count(*) as hours
  from (
    select handle, total_usd,
           strftime('%Y-%m-01T00:00:00.000Z', hour) as bucket,
           row_number() over (
             partition by handle, strftime('%Y-%m-01T00:00:00.000Z', hour), total_usd is null
             order by hour desc) as rn
    from aum_history
  )
  group by handle, bucket;

-- ------------------------------------------------------------------- token price candles
-- open/close are the first/last sampled hour in the bucket; `hours` says how full the bucket
-- is (20260918020000). Week buckets start on Monday, as above.
create view if not exists token_price_daily as
  select network_id, token_key, bucket,
         max(case when rn_asc  = 1 then usd end) as open_usd,
         max(case when rn_desc = 1 then usd end) as close_usd,
         max(usd) as high_usd,
         min(usd) as low_usd,
         count(*) as hours
  from (
    select network_id, token_key, usd,
           strftime('%Y-%m-%dT00:00:00.000Z', hour) as bucket,
           row_number() over (partition by network_id, token_key, strftime('%Y-%m-%dT00:00:00.000Z', hour) order by hour asc)  as rn_asc,
           row_number() over (partition by network_id, token_key, strftime('%Y-%m-%dT00:00:00.000Z', hour) order by hour desc) as rn_desc
    from token_price_hourly
  )
  group by network_id, token_key, bucket;

create view if not exists token_price_weekly as
  select network_id, token_key, bucket,
         max(case when rn_asc  = 1 then usd end) as open_usd,
         max(case when rn_desc = 1 then usd end) as close_usd,
         max(usd) as high_usd,
         min(usd) as low_usd,
         count(*) as hours
  from (
    select network_id, token_key, usd,
           strftime('%Y-%m-%dT00:00:00.000Z', hour, '-6 days', 'weekday 1') as bucket,
           row_number() over (partition by network_id, token_key, strftime('%Y-%m-%dT00:00:00.000Z', hour, '-6 days', 'weekday 1') order by hour asc)  as rn_asc,
           row_number() over (partition by network_id, token_key, strftime('%Y-%m-%dT00:00:00.000Z', hour, '-6 days', 'weekday 1') order by hour desc) as rn_desc
    from token_price_hourly
  )
  group by network_id, token_key, bucket;

create view if not exists token_price_monthly as
  select network_id, token_key, bucket,
         max(case when rn_asc  = 1 then usd end) as open_usd,
         max(case when rn_desc = 1 then usd end) as close_usd,
         max(usd) as high_usd,
         min(usd) as low_usd,
         count(*) as hours
  from (
    select network_id, token_key, usd,
           strftime('%Y-%m-01T00:00:00.000Z', hour) as bucket,
           row_number() over (partition by network_id, token_key, strftime('%Y-%m-01T00:00:00.000Z', hour) order by hour asc)  as rn_asc,
           row_number() over (partition by network_id, token_key, strftime('%Y-%m-01T00:00:00.000Z', hour) order by hour desc) as rn_desc
    from token_price_hourly
  )
  group by network_id, token_key, bucket;
