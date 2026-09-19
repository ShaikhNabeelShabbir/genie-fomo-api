-- `holdings_live` found each wallet's last Solana read in a CTE, `sol_read`, that grouped ALL of
-- `holdings_current` by handle. An aggregate is materialised before the caller's
-- `where handle = ?` can reach it, so every /positions call (the most frequent in the API) and
-- every 4-trader chunk of `refreshAumLive` read every chain capture in `holdings` (19 Sep 2026).
--
-- The same read time, asked per wallet instead. SQLite has no LATERAL, but a table-valued
-- function may read the row before it: `json_each` carries the one value, computed ONCE per
-- wallet by index seeks, and `cross join` pins wallet -> read time -> transfers. Every
-- `holdings_current` row of one (handle, network) shares one captured_at, so the newest IS the
-- max() the CTE took. Rows, columns and order are unchanged; the first branch is untouched.
drop view if exists holdings_live;

create view holdings_live as
  with rolled as (
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
         sr.value as delta_since,
         max(t.block_time) as last_transfer_at,
         count(*) as transfers_since_read
  from wallets w
  cross join json_each(json_array(
    (select hc.captured_at from holdings_current hc
      where hc.handle = w.handle and hc.network_id = 1399811149
      order by hc.captured_at desc limit 1))) sr
  -- The index the old plan walked (0003), named so the amounts are summed in the same order.
  cross join transactions t indexed by transactions_addr_token_time_idx
    on t.address_key = w.sol_address_key
  where t.network_id = 1399811149
    and t.direction in ('in', 'out')
    and t.amount is not null
    and (sr.value is null or t.block_time > sr.value)
    and not exists (
      select 1 from holdings_current h
      where h.handle = w.handle and h.network_id = t.network_id and h.token_key = t.token_key
    )
  group by w.handle, t.network_id, t.token_key, sr.value;
