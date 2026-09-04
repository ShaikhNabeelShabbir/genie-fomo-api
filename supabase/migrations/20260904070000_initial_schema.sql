-- ============================================================================
-- genie-fomo — initial schema
--
-- Two design rules drive almost every decision below. Both come from bugs this
-- project already had, so neither is stylistic.
--
--   1. A MISSING PRICE IS NOT ZERO.  `holdings.value` is nullable with no
--      default. 1,710 of 2,038 rows in the current snapshot carry no price. A
--      DEFAULT 0 would silently inflate denominators and change concentration,
--      cash share, chain value and every coverage figure in PARAMETERS.md.
--
--   2. INGESTION IS APPEND-ONLY.  `captured_at` is part of the primary key on
--      every table that varies per build. The JSON file it replaces overwrote
--      itself: between 2026-09-02 and 2026-09-04 the busiest chain flipped from
--      Solana to Robinhood and priced coverage fell from 78% to 16%, and the
--      earlier state is now unrecoverable. Here that drift is history, and K2
--      momentum is a self-join over it rather than a separate archive.
--
-- Address casing: EVM addresses are case-insensitive, Solana base58 addresses
-- are NOT. So every table stores the address exactly as received and keys on a
-- generated lowercase `*_key` column. Grouping stays case-insensitive (matching
-- metrics.ts) without corrupting a Solana mint we later need for an RPC call.
-- ============================================================================

-- ---------------------------------------------------------------- reference

create table if not exists chains (
  network_id        bigint       primary key,
  name              text         not null unique,
  native_symbol     text         not null,
  -- Which provider can serve transaction history here. Drives PARAMETERS.md C4.
  history_provider  text,
  explorer          text,
  rpc               text
);

comment on table chains is
  'The 5 networks we index. C4 (coverage warning) reads history_provider.';

create table if not exists quote_assets (
  network_id        bigint  not null references chains(network_id),
  token_key         text    not null,
  symbol            text    not null,
  primary key (network_id, token_key)
);

comment on table quote_assets is
  'Stablecoins and wrapped natives — the currency, not a trade. Was a hardcoded '
  'Set in metrics.ts; as data it is editable without a redeploy. Excluding these '
  'is mandatory: 85 of 100 leaders "hold" USDC.';

-- ---------------------------------------------------------------- identity

create table if not exists traders (
  -- Lowercased canonical handle. directory.ts already looks up case-insensitively.
  handle            text         primary key,
  display_handle    text         not null,
  name              text,
  avatar            text,
  bio               text,
  twitter           text,
  verified          boolean      not null default false,
  source            text         not null default 'fomoapi.io',
  first_seen_at     timestamptz  not null default now(),
  last_seen_at      timestamptz  not null default now()
);

comment on table traders is
  'Stable identity only. Anything that moves per build lives in trader_stats.';

create table if not exists wallets (
  handle            text         not null references traders(handle) on delete cascade,
  -- 'evm' or 'solana' — one address can serve every EVM chain, so this is not network_id.
  chain_kind        text         not null check (chain_kind in ('evm','solana')),
  address           text         not null,
  address_key       text         generated always as (lower(address)) stored,
  -- Who resolved it. fomo's own evm/sol fields are empty for all 100 traders;
  -- these come from fomoapi's src_evm/src_sol and were live when sampled.
  source            text         not null default 'fomoapi.io',
  first_seen_at     timestamptz  not null default now(),
  last_seen_at      timestamptz  not null default now(),
  primary key (handle, chain_kind, address_key)
);

comment on column wallets.source is
  'Provenance matters: a fomoapi-resolved address is Reported, not Verified. '
  'See PARAMETERS.md section 5.';

-- ---------------------------------------------------------------- snapshots

create table if not exists trader_stats (
  handle            text         not null references traders(handle) on delete cascade,
  captured_at       timestamptz  not null,
  rank              integer,
  pnl_usd           numeric,
  volume_usd        numeric,
  trade_count       integer,
  followers         integer,
  primary key (handle, captured_at)
);

comment on table trader_stats is
  'Per-build leaderboard figures. These are REPORTED numbers — 44 of 100 traders '
  'claim a pnl larger than their entire lifetime volume, so nothing here is '
  'corroborated by us.';

create table if not exists tokens (
  network_id        bigint       not null references chains(network_id),
  address           text         not null,
  token_key         text         generated always as (lower(address)) stored,
  symbol            text,
  first_seen_at     timestamptz  not null default now(),
  last_seen_at      timestamptz  not null default now(),
  primary key (network_id, token_key)
);

create table if not exists holdings (
  handle            text         not null,
  network_id        bigint       not null,
  token_key         text         not null,
  captured_at       timestamptz  not null,
  human_amount      numeric,
  -- NULL means "we have no price", NEVER zero. See rule 1 at the top of this file.
  price             numeric,
  value             numeric,
  primary key (handle, network_id, token_key, captured_at),
  foreign key (handle) references traders(handle) on delete cascade,
  foreign key (network_id, token_key) references tokens(network_id, token_key)
);

comment on column holdings.value is
  'NULLABLE WITH NO DEFAULT, deliberately. A missing price is excluded from every '
  'aggregate, never treated as 0. Adding a default here breaks T13, T14, K3 and C2 '
  'silently.';

-- ---------------------------------------------------------------- fomoapi trades

create table if not exists trades (
  trade_id             text         primary key,
  handle               text         not null references traders(handle) on delete cascade,
  network_id           bigint,
  token_address        text,
  token_key            text,
  token_symbol         text,
  status               text,
  amount               numeric,
  -- fomo returns 0 for "unknown"; the loader stores NULL instead, because a $0
  -- entry price implies someone got in for nothing.
  avg_entry_price      numeric,
  avg_exit_price       numeric,
  realized_pnl_usd     numeric,
  unrealized_pnl_usd   numeric,
  opened_at            timestamptz,
  closed_at            timestamptz,
  captured_at          timestamptz  not null,
  ingested_at          timestamptz  not null default now()
);

comment on table trades is
  'One row per fomoapi trade. Storing these is what turns K5-K8 from a 25-holder, '
  '45-second fan-out into a SQL query over all 896 rankable tokens.';

-- ---------------------------------------------------------------- chain transactions

create table if not exists transactions (
  network_id        bigint       not null references chains(network_id),
  tx_hash           text         not null,
  -- The wallet this row was fetched for; a tx can touch several.
  address_key       text         not null,
  block_time        timestamptz,
  direction         text,
  counterparty      text,
  token_key         text,
  token_symbol      text,
  amount            numeric,
  value_usd         numeric,
  source            text         not null,
  -- Providers disagree on shape; keep the original so a schema change does not
  -- require a refetch. Sized by measurement in plan step 2.4, not by guess.
  raw               jsonb,
  ingested_at       timestamptz  not null default now(),
  primary key (network_id, tx_hash, address_key)
);

-- ---------------------------------------------------------------- indexes

create index if not exists holdings_captured_idx     on holdings (captured_at desc);
create index if not exists holdings_token_idx        on holdings (network_id, token_key, captured_at desc);
create index if not exists holdings_handle_idx       on holdings (handle, captured_at desc);
create index if not exists trader_stats_captured_idx on trader_stats (captured_at desc);
create index if not exists trades_handle_idx         on trades (handle);
create index if not exists trades_token_idx          on trades (network_id, token_key);
create index if not exists trades_status_idx         on trades (status);
create index if not exists transactions_address_idx  on transactions (address_key, block_time desc);
create index if not exists wallets_address_idx       on wallets (address_key);

-- ---------------------------------------------------------------- current views

-- Most routes want "now". Without these, every query needs a correlated max().
create or replace view latest_capture as
  select max(captured_at) as captured_at from holdings;

create or replace view holdings_current as
  select h.* from holdings h
  where h.captured_at = (select captured_at from latest_capture);

create or replace view trader_stats_current as
  select s.* from trader_stats s
  where s.captured_at = (select max(captured_at) from trader_stats);

comment on view holdings_current is
  'The newest build only. History stays in `holdings` — that is what K2 momentum '
  'diffs and what makes the 2026-09-02 -> 2026-09-04 drift visible.';

-- ---------------------------------------------------------------- RLS

-- Locked by default. The builder connects as `postgres` over the pooler and
-- bypasses RLS; the anon key gets nothing until plan step 5.2 opens reads
-- deliberately. Enabling this now means we never accidentally ship it open.
alter table chains        enable row level security;
alter table quote_assets  enable row level security;
alter table traders       enable row level security;
alter table wallets       enable row level security;
alter table trader_stats  enable row level security;
alter table tokens        enable row level security;
alter table holdings      enable row level security;
alter table trades        enable row level security;
alter table transactions  enable row level security;

-- ---------------------------------------------------------------- seeds

insert into chains (network_id, name, native_symbol, history_provider, explorer, rpc) values
  (1399811149, 'solana',    'SOL', 'helius',     'https://solscan.io',                    'https://mainnet.helius-rpc.com'),
  (4663,       'robinhood', 'ETH', 'blockscout', 'https://robinhoodchain.blockscout.com', 'https://rpc.mainnet.chain.robinhood.com'),
  (1,          'ethereum',  'ETH', 'blockscout', 'https://etherscan.io',                  'https://ethereum-rpc.publicnode.com'),
  (56,         'bsc',       'BNB', 'bitquery',   'https://bscscan.com',                   'https://bsc-dataseed.binance.org'),
  (8453,       'base',      'ETH', 'bitquery',   'https://basescan.org',                  'https://mainnet.base.org')
on conflict (network_id) do update
  set name = excluded.name,
      native_symbol = excluded.native_symbol,
      history_provider = excluded.history_provider,
      explorer = excluded.explorer,
      rpc = excluded.rpc;

insert into quote_assets (network_id, token_key, symbol) values
  (1399811149, lower('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 'USDC'),
  (1399811149, lower('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'), 'USDT'),
  (1399811149, lower('So11111111111111111111111111111111111111112'),  'wSOL'),
  (1399811149, lower('11111111111111111111111111111111'),             'SOL'),
  (1,          '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',          'USDC'),
  (1,          '0xdac17f958d2ee523a2206206994597c13d831ec7',          'USDT'),
  (1,          '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',          'WETH'),
  (8453,       '0x4200000000000000000000000000000000000006',          'WETH'),
  (8453,       '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',          'USDC'),
  (56,         '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',          'USDC'),
  (56,         '0x55d398326f99059ff775485246999027b3197955',          'USDT'),
  (56,         '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',          'WBNB')
on conflict (network_id, token_key) do update set symbol = excluded.symbol;
