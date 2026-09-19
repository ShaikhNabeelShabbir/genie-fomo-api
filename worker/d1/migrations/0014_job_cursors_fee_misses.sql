-- Two queues that re-asked their own head for ever while reporting success (19 Sep 2026). Both
-- needed a record of what was already tried, which is all these two small tables hold. No index.

-- quote_prices: the 5,000-row value_usd pick filled with memecoin legs nothing can price, so it
-- updated 0 rows every hour. The pass now walks transactions in rowid order and remembers where
-- it stopped, so a leg that cannot be priced is passed once instead of holding its slot.
-- Delete the row to walk the whole table again: after an exchange outage longer than the pass's 2-day
-- wait (a leg passed without its close is not offered again), or after a re-import that renumbers
-- rowids (a place past the newest rowid restarts by itself; one still inside the table does not).
create table if not exists job_cursors (
  job        text    primary key,
  position   integer not null,
  updated_at text    not null
);

-- fees: a hash the source had no row for left no trace, so the anti-join offered it again first.
-- Same shape and purpose as token_info_misses (0012).
create table if not exists transaction_fee_misses (
  network_id integer not null,
  tx_hash    text    not null,
  missed_at  text    not null,
  primary key (network_id, tx_hash)
);
