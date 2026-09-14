-- Fees a trader paid, per chain, per day.
--
-- A7 asks for fees per scorecard window. Summing them at request time was measured at 24.5
-- seconds for our busiest trader: the honest query has to take DISTINCT transactions out of
-- `transactions`, which stores one row per transfer leg, and that trader's Solana address
-- alone carries hundreds of thousands of them. A route cannot pay that, and the last time a
-- route did, it answered 503.
--
-- So the heavy pass runs once, off the request path, into daily buckets. Any rolling window
-- the scorecard asks for -- 24h, 7d, 30d, all -- is then a sum over at most a few hundred
-- small rows per trader.
--
-- DAILY, not per window, on purpose. Windows are rolling: a table of window totals is wrong
-- an hour after it is built, while a day bucket stays true forever once its day has closed.
-- It also answers questions we have not been asked yet without another table.
--
-- `fee_native` only. Dollars are derived at read time from the same native price the
-- portfolio uses, because we hold no historical native price and a stored conversion would
-- freeze an approximation into a column that looks measured.

create table if not exists trader_fees_daily (
  handle      text   not null references traders(handle) on delete cascade,
  network_id  bigint not null references chains(network_id),
  day         date   not null,
  fee_native  numeric not null,
  -- How many transactions that day's total covers, so a thin day is visible as a thin day.
  tx_count    integer not null,
  computed_at timestamptz not null default now(),
  primary key (handle, network_id, day)
);

comment on table trader_fees_daily is
  'Fees per trader per chain per day, in the chain''s own coin. Built off the request path; '
  'a rolling window is a sum over these buckets.';

-- The read is always "this trader, recent days first".
create index if not exists trader_fees_daily_lookup_idx
  on trader_fees_daily (handle, day desc);
