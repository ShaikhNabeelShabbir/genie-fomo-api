-- Workflow gap 4 (docs/consumer/workflow-coverage-17-sep.md): per-token holdings BETWEEN
-- nightly reads, for Solana, at read time. No new writer.
--
-- holdings_live = holdings_current rolled forward by the signed sum of `transactions`
-- (in +, out -) that landed after the balance was read. This is a ROLL-FORWARD FROM THE
-- WEBHOOK FEED, NOT A CHAIN READ: it is only as complete as the Helius webhook's coverage
-- (token and native transfers for registered wallets). A transfer the webhook did not
-- deliver, a wallet not registered, or a rebase/burn the feed does not carry, all leave
-- `human_amount_live` off by that much until the next nightly read replaces the base.
-- EVM rows pass through untouched (delta null): there is no real-time EVM feed.
--
-- A token that moved after the read but was not in the read (a brand-new position) is a
-- row too, with human_amount 0 as its base and no price -- the second UNION branch.
--
-- Written as holdings_current LEFT JOIN LATERAL + UNION ALL rather than a FULL OUTER JOIN
-- over one grouped aggregate, so `where handle = X` pushes into both branches and each
-- reads only that wallet's transfers via transactions_address_idx (address_key, block_time).
create or replace view holdings_live as
  with sol_read as (
    -- When each trader's Solana balances were last read (chain or fomo build). A transfer
    -- at or before that moment is already inside the read balance.
    select handle, max(captured_at) as captured_at
    from holdings_current where network_id = 1399811149
    group by handle
  )
  select h.handle, h.network_id, h.token_key, h.captured_at, h.human_amount, h.price,
         h.value, h.source, h.price_source, h.priced_at,
         case when h.network_id = 1399811149 then coalesce(d.delta, 0) end as delta,
         case when h.network_id = 1399811149 then h.human_amount + coalesce(d.delta, 0) end
           as human_amount_live,
         case when h.network_id = 1399811149 then h.captured_at end as delta_since,
         d.last_transfer_at,
         coalesce(d.transfers, 0) as transfers_since_read
  from holdings_current h
  left join lateral (
    select sum(case t.direction when 'in' then t.amount when 'out' then -t.amount end) as delta,
           max(t.block_time) as last_transfer_at,
           count(*) as transfers
    from transactions t
    join wallets w on w.sol_address_key = t.address_key
    where h.network_id = 1399811149
      and w.handle = h.handle
      and t.network_id = h.network_id
      and t.token_key = h.token_key
      and t.direction in ('in', 'out')
      and t.amount is not null
      and t.block_time > h.captured_at
  ) d on true
  union all
  -- Brand-new positions: moved since the read, absent from the read.
  select w.handle, t.network_id, t.token_key,
         null::timestamptz as captured_at, 0::numeric as human_amount, null::numeric as price,
         null::numeric as value, null::text as source, null::text as price_source,
         null::timestamptz as priced_at,
         sum(case t.direction when 'in' then t.amount when 'out' then -t.amount end) as delta,
         sum(case t.direction when 'in' then t.amount when 'out' then -t.amount end)
           as human_amount_live,
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

comment on view holdings_live is
  'holdings_current rolled forward on Solana by the signed sum of transactions since the '
  'read (webhook feed, not a chain read: only as complete as the webhook''s coverage). EVM '
  'rows pass through with delta null. Positions opened since the read appear with '
  'human_amount 0 and no price.';
