-- T2.2: the trader's OWN swaps, resolved to both sides.
--
-- Why this table exists rather than a query over `transactions`:
--
-- `transactions.tx_type` is the TRANSACTION's type as Helius classifies it, not the wallet's
-- action in it. Measured on 60 random stored rows tagged SWAP: in 57 the wallet is not even
-- among the transaction's accountKeys -- someone else swapped and sent tokens to the wallet's
-- token account. Only 3 of 60 (5%) were the wallet's own two-sided swap.
--
-- That is why chain-derived P&L disagreed with fomo 84% of the time: it was being computed
-- over transactions that were mostly inbound transfers, not trades.
--
-- The resolution comes from Helius RPC `getTransaction` pre/post balances, which give the NET
-- change per (owner, mint) and are immune to how a router moved funds internally. Enhanced
-- Transactions could not do this: its parsed swap event was empty on 88 of 100 sampled, and
-- named a different wallet on the other 12.
--
-- One row per swap the wallet actually made. A swap it did not make is absent, not zero.
create table if not exists wallet_swaps (
  network_id   bigint      not null references chains(network_id),
  tx_hash      text        not null,
  address_key  text        not null,
  block_time   timestamptz,
  -- The non-quote side: what they bought (+) or sold (-), in UI units.
  token_key    text        not null,
  token_delta  numeric     not null,
  -- The quote side: what they paid (-) or received (+).
  quote_key    text,
  quote_delta  numeric,
  -- The quote side in dollars, via quote_assets.pegged_usd or token_prices. NULL when the
  -- quote asset is not one we can value -- never 0.
  quote_usd    numeric,
  resolved_at  timestamptz not null default now(),
  primary key (network_id, tx_hash, address_key)
);

comment on table wallet_swaps is
  'Swaps the tracked wallet actually made, both sides resolved from Helius RPC pre/post '
  'balances. ~5% of rows tagged SWAP in `transactions` qualify; the rest are inbound '
  'transfers inside someone else''s transaction.';

create index if not exists wallet_swaps_wallet_token_idx
  on wallet_swaps (address_key, token_key);
create index if not exists wallet_swaps_time_idx on wallet_swaps (block_time desc);
