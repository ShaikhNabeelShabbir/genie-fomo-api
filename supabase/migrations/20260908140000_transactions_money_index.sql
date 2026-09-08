-- T2.1 follow-up: make the per-wallet money aggregate an index-only scan.
--
-- `/traders/:handle/transactions` gained a spent/received block. Measured on unipcs
-- (30,907 rows):
--
--   existing count/min/max aggregate   21 ms    Index Only Scan  (covered by
--                                               transactions_address_idx)
--   new spent/received aggregate    4,398 ms    Bitmap Heap Scan (value_usd, direction and
--                                               tx_type are not in any index, so it visits
--                                               every heap row)
--
-- 200x, and it took the route from 2.5s to 3.9s while two untouched control routes stayed
-- at 2.8s. INCLUDE rather than a composite key: these three columns are only ever read, never
-- searched on, so they belong in the leaf payload and not in the b-tree ordering.
create index if not exists transactions_address_money_idx
  on transactions (address_key)
  include (value_usd, direction, tx_type);

comment on index transactions_address_money_idx is
  'Covers the per-wallet spent/received aggregate on /traders/:handle/transactions so it is '
  'an index-only scan rather than a heap visit per row.';
