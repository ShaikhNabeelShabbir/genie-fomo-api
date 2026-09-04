-- ============================================================================
-- transactions: one row per TRANSFER, not per transaction hash.
--
-- The original primary key was (network_id, tx_hash, address_key), which assumed
-- one row per hash. That is wrong for the data we actually fetch: a swap emits
-- several transfers under a single hash — token out, token in, sometimes a fee
-- leg — and every one of them is a row. Under the old key they would collide and
-- the upsert would silently keep only the last leg of every swap, turning "sold X
-- for Y" into "received Y".
--
-- `transfer_key` is a DETERMINISTIC digest of what identifies a transfer inside
-- its transaction. Deterministic matters more than it looks: a positional index
-- would depend on provider ordering, which is not guaranteed stable between
-- fetches, so re-running the backfill would insert duplicates instead of being
-- idempotent. Two byte-identical transfers in one hash collapse to one row, which
-- is the correct reading of "the same transfer twice".
-- ============================================================================

alter table transactions
  add column if not exists direction_norm text,
  add column if not exists transfer_key text;

update transactions set transfer_key = md5(
  coalesce(token_key,'') || '|' || coalesce(direction,'') || '|' ||
  coalesce(counterparty,'') || '|' || coalesce(amount::text,'')
) where transfer_key is null;

alter table transactions drop constraint if exists transactions_pkey;
alter table transactions alter column transfer_key set not null;
alter table transactions add primary key (network_id, tx_hash, address_key, transfer_key);

alter table transactions drop column if exists direction_norm;

comment on column transactions.transfer_key is
  'Deterministic digest of (token, direction, counterparty, amount). A swap is '
  'several transfers under one tx_hash; this keeps them apart while keeping a '
  're-run idempotent.';

-- The route reads newest-first for one wallet, optionally filtered to a chain.
create index if not exists transactions_wallet_time_idx
  on transactions (address_key, network_id, block_time desc);
