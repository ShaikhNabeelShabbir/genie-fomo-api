-- `holdings_live` rolls a Solana balance forward with three correlated subqueries over
-- `transactions`, each filtering address_key + network_id + token_key + block_time. The keyset
-- index leads with (address_key, block_time), so the token filter was a scan: one trader's view
-- read 2,246,790 rows and four of them exceeded D1's per-query CPU limit (17 Sep 2026).
-- This index turns each subquery into a narrow range scan.
create index if not exists transactions_addr_token_time_idx
  on transactions (address_key, network_id, token_key, block_time);
