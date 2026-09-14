-- What each transaction cost to make.
--
-- A7 asks for fees in dollars per trade and per scorecard window, and nothing in this database
-- could answer it: no fee or gas column existed on any table, and `transactions.raw` is empty
-- on all 1,025,559 rows, so it was not recoverable from what we had already stored either.
--
-- A fee is a property of a TRANSACTION, not of a transfer. One transaction moves several
-- tokens -- one measured base swap carried 15 Transfer events across 3 tokens -- and charges
-- one fee for all of it. Storing the fee on `transactions` would repeat it per leg and invite
-- exactly the double count this table exists to prevent, so it is keyed by the transaction.
--
-- `fee_native` is the measurement and is exact: gas_used x effective_gas_price on the four
-- Ethereum-style chains, and meta.fee on Solana. It is never converted here. Dollars are
-- computed at read time from the same native price the portfolio uses, so the two can never
-- disagree, and so a stored conversion cannot go stale in the table.
--
-- NOT stored: a dollar figure. We hold no historical native price, so any USD fee is the
-- current rate applied to a past payment. That is an approximation and the API labels it as
-- one rather than freezing it into a column that looks measured.

create table if not exists transaction_fees (
  network_id        bigint      not null references chains(network_id),
  tx_hash           text        not null,
  -- Exact, in the chain's own coin. Wei on the EVM chains, lamports scaled to SOL on Solana.
  fee_native        numeric     not null,
  fee_native_symbol text        not null,
  -- Which call produced it, so a figure can be rechecked against the chain.
  source            text        not null,
  fetched_at        timestamptz not null default now(),
  primary key (network_id, tx_hash)
);

comment on table transaction_fees is
  'One row per transaction: what it cost to make, in the chain''s own coin. Dollars are '
  'derived at read time from the current native price, never stored.';

-- The loader asks "which transactions do I still need", which is an anti-join against
-- transactions and wallet_swaps. The primary key serves that lookup already; this index
-- serves the read side, where a trader's fees are summed over a time window and the rows
-- are reached by hash from the transfer tables.
create index if not exists transaction_fees_chain_idx
  on transaction_fees (network_id, fetched_at desc);
