-- Make the position-timing aggregate index-only.
--
-- GET /v1/traders/:id/positions returned 503 for our busiest traders. The cause was not the
-- row count -- it was the heap. positionTiming() groups transactions by (network_id,
-- token_key) for one wallet, and the planner reached for transactions_address_money_idx,
-- which INCLUDEs value_usd, direction and tx_type but NOT network_id, token_key or
-- block_time. So it found the 65,425 matching rows by index and then fetched every one of
-- them from the table:
--
--   HashAggregate (actual time=26958..27016 rows=782)
--     -> Index Scan using transactions_address_money_idx
--        Buffers: shared hit=10649 read=21149      -- ~165 MB of random reads
--
-- 27 seconds, against a 15-second route budget. Measured per trader:
--   0xangeryy      7,954 transactions ->  1.4s
--   frankdegods   38,432 transactions ->  4.9s
--   unipcs        66,773 transactions -> 12.5s   (503)
--
-- This index carries everything the aggregate reads, so it never touches the table. The
-- grouping columns are in the key (already sorted, so no hash needed) and the two values the
-- filters need are payload.
create index concurrently if not exists transactions_timing_idx
  on transactions (address_key, network_id, token_key)
  include (direction, block_time);

comment on index transactions_timing_idx is
  'Covers positionTiming(): group by (network_id, token_key) for one wallet without heap '
  'access. See GET /traders/:id/positions.';
