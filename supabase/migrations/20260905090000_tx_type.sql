-- ============================================================================
-- Record WHAT a transaction was, not just that it moved tokens.
--
-- The consuming team's review asked for actual swaps — "buy or sell" — and was
-- told the feed could only offer transfers. Helius's enhanced payload labels
-- each transaction (`SWAP`, `TRANSFER`, `INITIALIZE_ACCOUNT`, `UNKNOWN`), which
-- is exactly the distinction they needed: a SWAP is a trade, a TRANSFER very
-- often is not.
--
-- Nullable, because every row backfilled before this column existed has no type
-- and must not be given a fabricated one. A consumer can then tell "this was a
-- transfer" from "we do not know what this was".
-- ============================================================================

alter table transactions
  add column if not exists tx_type text,
  add column if not exists tx_source text;

comment on column transactions.tx_type is
  'Helius classification: SWAP, TRANSFER, INITIALIZE_ACCOUNT, UNKNOWN. NULL on rows '
  'ingested before this existed — absent, not "unknown".';
comment on column transactions.tx_source is
  'The protocol Helius attributes it to (JUPITER, RAYDIUM, ...), where known.';

create index if not exists transactions_type_idx on transactions (tx_type)
  where tx_type is not null;
