-- /v1/health gained a per-feed freshness block, and `max(block_time) from transactions`
-- turned it into a full sequential scan of 766,330 rows -- measured at 28 seconds, which
-- pushed /health past its own timeout and made it 503 on every call.
--
-- No index led with block_time: the three that exist all lead with address_key, so they can
-- answer "this wallet, newest first" but not "newest overall". This one is small, answers
-- max()/min() as an index-only scan, and also unblocks date-range queries on the table --
-- which had the same problem for any caller who tried one.
--
-- CONCURRENTLY so it does not take a write lock on a table the webhook writes to.
create index concurrently if not exists transactions_block_time_idx
  on transactions (block_time desc);

comment on index transactions_block_time_idx is
  'Newest-first across all wallets. Added for /health freshness; a plain max(block_time) '
  'was a 28-second sequential scan without it.';
