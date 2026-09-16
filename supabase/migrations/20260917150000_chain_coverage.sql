-- Per-chain indexer coverage (docs/TO-DO-BEFORE-MIGRATION.md R6, consumer §2c).
--
-- One row per trader per EVM chain, written by the sampler after a successful balance read:
-- the wallet's nonce (eth_getTransactionCount, one free call) against the transaction rows
-- the indexer holds for it. /positions publishes the ratio and says `partial` when it is
-- under a half. Solana has no nonce and gets no row.

create table if not exists chain_coverage (
  handle       text        not null,
  network_id   bigint      not null references chains(network_id),
  address_key  text,
  -- The chain's own count of his outgoing transactions. NULL: the node would not say.
  chain_nonce  bigint,
  -- count(*) from transactions for this wallet on this chain, at read_at.
  rows_held    bigint,
  read_at      timestamptz not null default now(),
  primary key (handle, network_id)
);
