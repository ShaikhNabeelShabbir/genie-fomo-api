-- Let the transaction feed page without sorting the wallet's whole history.
--
-- GET /traders/:id/transactions returned 503 for busy traders. The page query asks for one
-- wallet's rows newest-first, and its ORDER BY carries four tiebreak columns after
-- block_time -- necessary, because 23,916 (block_time, tx_hash) pairs carry more than one row
-- and keyset pagination cannot resume through an arbitrary order. But transactions_address_idx
-- stops at (address_key, block_time DESC), so Postgres could not walk the index in the
-- requested order: it fetched all 66,773 rows for the wallet and sorted them, every request.
--
--   before: 11,670ms for LIMIT 1
--   after:     232ms
--
-- This index is the sort order, exactly -- including `nulls last`, which a plain DESC index
-- does not provide. `address_key` leads because every caller filters on it.
create index concurrently if not exists transactions_keyset_idx
  on transactions (address_key, block_time desc nulls last, tx_hash, network_id, transfer_key);

comment on index transactions_keyset_idx is
  'Matches the ORDER BY of the /transactions page query so it pages by index instead of '
  'sorting the wallet history. See GET /traders/:id/transactions.';
