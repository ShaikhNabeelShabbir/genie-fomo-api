-- ============================================================================
-- wallets: one row per trader, both addresses side by side.
--
-- Replaces the row-per-wallet shape. Every trader today has at most one address
-- per chain kind (0 traders have two of the same kind, 183 rows / 97 traders),
-- so the normalised form bought flexibility nothing was using and made the most
-- common read — "give me this trader's two addresses" — a filtered aggregate.
--
-- Provenance is kept PER CHAIN rather than dropped, because a fomoapi-reported
-- address and one we verify ourselves are different claims (PARAMETERS.md §5).
-- `balanceOf` is free and keyless on all five chains (C5), so verification is
-- cheap and expected; these columns are where its result lands.
--
-- The one thing this shape cannot express is a RIVAL candidate for the same
-- trader+chain. resolvers.ts already discards losing candidates (it returns a
-- single `address` plus `candidates_considered`), so nothing is lost today.
-- ============================================================================

drop table if exists wallets;

create table wallets (
  handle             text        primary key references traders(handle) on delete cascade,

  -- EVM addresses are case-insensitive; the key column exists for joins.
  evm_address        text,
  evm_address_key    text        generated always as (lower(evm_address)) stored,
  evm_source         text,
  evm_confidence     text,
  evm_verified_at    timestamptz,

  -- Solana base58 IS case-sensitive, so `sol_address` keeps its exact casing and
  -- only the derived key is lowercased. Lowercasing the stored mint would give us
  -- an address we can no longer query.
  sol_address        text,
  sol_address_key    text        generated always as (lower(sol_address)) stored,
  sol_source         text,
  sol_confidence     text,
  sol_verified_at    timestamptz,

  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),

  -- A row with neither address is not a wallet record, it is noise.
  constraint wallets_has_an_address check (evm_address is not null or sol_address is not null)
);

comment on table wallets is
  'One row per trader. fomo''s own evm/sol fields are empty for all 100 traders; '
  'these come from fomoapi''s src_evm/src_sol and are REPORTED, not verified — '
  'the *_confidence and *_verified_at columns are where balanceOf results land.';

create index wallets_evm_idx on wallets (evm_address_key);
create index wallets_sol_idx on wallets (sol_address_key);

alter table wallets enable row level security;
