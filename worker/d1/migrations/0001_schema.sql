-- D1 (SQLite) schema: the FINAL state of the 55 Postgres migrations under
-- supabase/migrations/ (decision of 17 Sep 2026: the database moves to Cloudflare D1).
-- Type map, dropped objects and per-column notes: worker/d1/SCHEMA_MAP.md.
--
-- Conventions (fixed across agents):
--   timestamps  TEXT, ISO-8601 UTC 'YYYY-MM-DDTHH:MM:SS.sssZ'; `now()` default written the same way
--   dates       TEXT 'YYYY-MM-DD'
--   numbers     REAL for numeric / double precision, INTEGER for bigint / int
--   booleans    INTEGER 0/1 with check (col in (0,1)); NULL still means "not assessed"
--   json        TEXT holding a JSON document; text[] -> TEXT holding a JSON array
--   uuid        TEXT; no default, the Worker supplies crypto.randomUUID()
-- Foreign keys are declared inline (D1 enforces them). Names of tables, columns, indexes and
-- views are identical to Postgres.

-- ---------------------------------------------------------------- reference

create table if not exists chains (
  network_id        integer      primary key,
  name              text         not null unique,
  native_symbol     text         not null,
  history_provider  text,
  explorer          text,
  rpc               text
);

create table if not exists quote_assets (
  network_id        integer  not null references chains(network_id),
  token_key         text     not null,
  symbol            text     not null,
  -- USD value of one unit for dollar-pegged assets; NULL for floating assets.
  pegged_usd        real,
  primary key (network_id, token_key)
);

-- ---------------------------------------------------------------- identity

create table if not exists traders (
  handle            text         primary key,
  display_handle    text         not null,
  name              text,
  avatar            text,
  bio               text,
  twitter           text,
  verified          integer      not null default 0 check (verified in (0,1)),
  source            text         not null default 'fomoapi.io',
  first_seen_at     text         not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at      text         not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Stable identifier, ours. Was uuid default gen_random_uuid(); the Worker supplies it.
  id                text         not null,
  handle_changed_at text,
  listed            integer      not null default 1 check (listed in (0,1)),
  delisted_at       text,
  delisted_reason   text
);

create unique index if not exists traders_id_idx  on traders (id);
create unique index if not exists traders_id_uidx on traders (id);
create index if not exists traders_listed_idx on traders (listed) where listed = 1;

-- One row per trader, both addresses side by side (20260904073000).
create table if not exists wallets (
  handle             text        primary key references traders(handle) on delete cascade,
  evm_address        text,
  evm_address_key    text        generated always as (lower(evm_address)) stored,
  evm_source         text,
  evm_confidence     text,
  evm_verified_at    text,
  -- Solana base58 is case-sensitive: sol_address keeps its casing, only the key is lowered.
  sol_address        text,
  sol_address_key    text        generated always as (lower(sol_address)) stored,
  sol_source         text,
  sol_confidence     text,
  sol_verified_at    text,
  first_seen_at      text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at       text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  constraint wallets_has_an_address check (evm_address is not null or sol_address is not null)
);

create index if not exists wallets_evm_idx on wallets (evm_address_key);
create index if not exists wallets_sol_idx on wallets (sol_address_key);

-- ---------------------------------------------------------------- snapshots

create table if not exists trader_stats (
  handle            text         not null references traders(handle) on delete cascade,
  captured_at       text         not null,
  rank              integer,
  pnl_usd           real,
  volume_usd        real,
  trade_count       integer,
  followers         integer,
  primary key (handle, captured_at)
);

create index if not exists trader_stats_captured_idx on trader_stats (captured_at desc);

create table if not exists tokens (
  network_id        integer      not null references chains(network_id),
  address           text         not null,
  -- Was `generated always as (lower(address)) stored`; SQLite refuses a generated column in a
  -- primary key, so the writer supplies lower(address) and the check keeps the invariant.
  token_key         text         not null check (token_key = lower(address)),
  symbol            text,
  first_seen_at     text         not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at      text         not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  total_supply      real,
  decimals          integer,
  supply_source     text,
  supply_read_at    text,
  created_at        text,
  launchpad         text         check (launchpad in ('pump.fun')),
  curve_progress    real         check (curve_progress between 0 and 1),
  graduated         integer      check (graduated in (0,1)),
  launch_read_at    text,
  primary key (network_id, token_key)
);

create table if not exists holdings (
  handle            text         not null,
  network_id        integer      not null,
  token_key         text         not null,
  captured_at       text         not null,
  human_amount      real,
  -- NULL means "we have no price", NEVER zero.
  price             real,
  value             real,
  source            text         not null default 'fomo',
  price_source      text,
  priced_at         text,
  primary key (handle, network_id, token_key, captured_at),
  foreign key (handle) references traders(handle) on delete cascade,
  foreign key (network_id, token_key) references tokens(network_id, token_key),
  constraint holdings_source_known check (source in ('fomo','chain'))
);

create index if not exists holdings_captured_idx        on holdings (captured_at desc);
create index if not exists holdings_token_idx           on holdings (network_id, token_key, captured_at desc);
create index if not exists holdings_handle_idx          on holdings (handle, captured_at desc);
create index if not exists holdings_source_capture_idx  on holdings (source, captured_at desc);
create index if not exists holdings_source_handle_net_idx on holdings (source, handle, network_id, captured_at desc);

-- ---------------------------------------------------------------- fomoapi trades

create table if not exists trades (
  trade_id             text         primary key,
  handle               text         not null references traders(handle) on delete cascade,
  network_id           integer,
  token_address        text,
  token_key            text,
  token_symbol         text,
  status               text,
  amount               real,
  avg_entry_price      real,
  avg_exit_price       real,
  realized_pnl_usd     real,
  unrealized_pnl_usd   real,
  opened_at            text,
  closed_at            text,
  captured_at          text         not null,
  ingested_at          text         not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_by            text
);

create index if not exists trades_token_idx           on trades (network_id, token_key);
create index if not exists trades_status_idx          on trades (status);
create index if not exists trades_handle_captured_idx on trades (handle, captured_at desc);
create index if not exists trades_captured_idx        on trades (captured_at desc);

create table if not exists trade_loads (
  handle       text        not null,
  attempted_at text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  outcome      text        not null
               check (outcome in ('loaded', 'unchanged', 'unavailable', 'degraded', 'not_found', 'error')),
  detail       text,
  primary key (handle, attempted_at)
);

create index if not exists trade_loads_handle_attempted_idx on trade_loads (handle, attempted_at desc);

-- ---------------------------------------------------------------- chain transactions

-- One row per TRANSFER: transfer_key is the deterministic digest of (token, direction,
-- counterparty, amount) inside one tx_hash (20260904120000).
create table if not exists transactions (
  network_id        integer      not null references chains(network_id),
  tx_hash           text         not null,
  address_key       text         not null,
  block_time        text,
  direction         text,
  counterparty      text,
  token_key         text,
  token_symbol      text,
  amount            real,
  value_usd         real,
  source            text         not null,
  raw               text,
  ingested_at       text         not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  transfer_key      text         not null,
  tx_type           text,
  tx_source         text,
  primary key (network_id, tx_hash, address_key, transfer_key)
);

create index if not exists transactions_address_idx     on transactions (address_key, block_time desc);
create index if not exists transactions_wallet_time_idx on transactions (address_key, network_id, block_time desc);
create index if not exists transactions_type_idx        on transactions (tx_type) where tx_type is not null;
-- Postgres `include (...)` payload columns become trailing key columns: same covering effect.
create index if not exists transactions_address_money_idx on transactions (address_key, value_usd, direction, tx_type);
create index if not exists transactions_block_time_idx  on transactions (block_time desc);
create index if not exists transactions_timing_idx      on transactions (address_key, network_id, token_key, direction, block_time);
-- `desc nulls last` in Postgres; SQLite DESC already sorts NULLs last.
create index if not exists transactions_keyset_idx      on transactions (address_key, block_time desc, tx_hash, network_id, transfer_key);

create table if not exists transaction_fees (
  network_id        integer     not null references chains(network_id),
  tx_hash           text        not null,
  fee_native        real        not null,
  fee_native_symbol text        not null,
  source            text        not null,
  fetched_at        text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (network_id, tx_hash)
);

create index if not exists transaction_fees_chain_idx on transaction_fees (network_id, fetched_at desc);

create table if not exists trader_fees_daily (
  handle      text    not null references traders(handle) on delete cascade,
  network_id  integer not null references chains(network_id),
  day         text    not null,
  fee_native  real    not null,
  tx_count    integer not null,
  computed_at text    not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (handle, network_id, day)
);

create index if not exists trader_fees_daily_lookup_idx on trader_fees_daily (handle, day desc);

create table if not exists position_timing (
  address_key text        not null,
  network_id  integer     not null references chains(network_id),
  token_key   text        not null,
  start_at    text,
  end_at      text,
  last_at     text        not null,
  computed_at text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (address_key, network_id, token_key)
);

create index if not exists position_timing_address_idx on position_timing (address_key);

create table if not exists chain_coverage (
  handle       text        not null,
  network_id   integer     not null references chains(network_id),
  address_key  text,
  chain_nonce  integer,
  rows_held    integer,
  read_at      text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (handle, network_id)
);

-- ---------------------------------------------------------------- swaps

create table if not exists wallet_swaps (
  network_id   integer     not null references chains(network_id),
  tx_hash      text        not null,
  address_key  text        not null,
  block_time   text,
  token_key    text        not null,
  token_delta  real        not null,
  quote_key    text,
  quote_delta  real,
  quote_usd    real,
  resolved_at  text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  quote_source text,
  primary key (network_id, tx_hash, address_key),
  constraint wallet_swaps_quote_source_check
    check (quote_source in ('money_side_pegged', 'money_side_daily_close', 'money_side_market'))
);

create index if not exists wallet_swaps_wallet_token_idx on wallet_swaps (address_key, token_key);
create index if not exists wallet_swaps_time_idx         on wallet_swaps (block_time desc);

create table if not exists wallet_swaps_checked (
  network_id   integer     not null references chains(network_id),
  tx_hash      text        not null,
  address_key  text        not null,
  checked_at   text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (network_id, tx_hash, address_key)
);

-- ---------------------------------------------------------------- prices and token facts

create table if not exists token_prices (
  network_id integer     not null references chains(network_id),
  token_key  text        not null,
  day        text        not null,
  usd        real        not null,
  source     text        not null,
  fetched_at text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (network_id, token_key, day)
);

create index if not exists token_prices_day_idx on token_prices (day);

create table if not exists token_price_hourly (
  network_id    integer     not null references chains(network_id),
  token_key     text        not null,
  hour          text        not null,
  usd           real        not null,
  liquidity_usd real,
  source        text        not null,
  primary key (network_id, token_key, hour)
);

create index if not exists token_price_hourly_token_hour_idx on token_price_hourly (network_id, token_key, hour desc);

create table if not exists token_price_stats (
  network_id     integer     not null references chains(network_id),
  token_key      text        not null,
  ath_usd        real        not null,
  ath_at         text        not null,
  last_usd       real        not null,
  last_at        text        not null,
  drawdown_share real        not null,
  source         text,
  updated_at     text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (network_id, token_key)
);

create table if not exists token_info (
  network_id         integer     not null references chains(network_id),
  token_key          text        not null,
  symbol             text,
  name               text,
  price_usd          real,
  liquidity_usd      real,
  market_cap_usd     real,
  total_supply       real,
  circulating_supply real,
  max_supply         real,
  holder_count       integer,
  top_10_holder_rate real,
  raw                text,
  source             text        not null default 'gmgn',
  fetched_at         text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Chain-dependent security checks; NULL = not assessed on this chain, never "safe".
  is_honeypot        integer     check (is_honeypot in (0,1)),
  buy_tax            real,
  sell_tax           real,
  is_open_source     integer     check (is_open_source in (0,1)),
  is_renounced       integer     check (is_renounced in (0,1)),
  renounced_mint     integer     check (renounced_mint in (0,1)),
  renounced_freeze   integer     check (renounced_freeze in (0,1)),
  rug_ratio          real,
  burn_ratio         real,
  is_blacklisted     integer     check (is_blacklisted in (0,1)),
  can_not_sell       integer     check (can_not_sell in (0,1)),
  security_raw       text,
  security_fetched_at text,
  honeypot_since     text,
  logo_url           text,
  primary key (network_id, token_key)
);

create index if not exists token_info_fetched_idx  on token_info (fetched_at);
create index if not exists token_info_honeypot_idx on token_info (is_honeypot) where is_honeypot = 1;

create table if not exists token_creators (
  network_id          integer     not null references chains(network_id),
  token_key           text        not null,
  creator_address_key text        not null,
  creator_status      text,
  primary key (network_id, token_key)
);

create index if not exists token_creators_creator_idx on token_creators (network_id, creator_address_key);

create table if not exists creators (
  network_id          integer     not null references chains(network_id),
  creator_address_key text        not null,
  launches            integer     not null,
  best_peak_mcap_usd  real,
  best_token_key      text,
  still_holding_count integer     not null,
  sold_count          integer     not null,
  honeypot_count      integer     not null,
  last_launch_at      text,
  updated_at          text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (network_id, creator_address_key)
);

create table if not exists linked_wallets (
  handle                  text        not null references traders(handle) on delete cascade,
  network_id              integer     not null references chains(network_id),
  address_key             text        not null,
  address                 text,
  linked_from_address_key text        not null,
  link_kind               text        not null check (link_kind in ('funded_by', 'submitted')),
  first_seen_at           text,
  evidence_tx             text,
  watch                   integer     not null default 1 check (watch in (0,1)),
  primary key (handle, network_id, address_key)
);

-- ---------------------------------------------------------------- AUM

create table if not exists aum_samples (
  handle            text        not null references traders(handle) on delete cascade,
  at                text        not null,
  -- NULL means the sample was REFUSED (refused_reason says why), never zero.
  total_usd         real,
  refused_reason    text        check (refused_reason is null or refused_reason in
                      ('wallet_unreadable','service_timeout','no_prices','price_rejected',
                       'chains_unrebuildable',
                       'price_suspect',
                       'no_tokens_known',
                       'nothing_answered')),
  priced_positions  integer,
  total_positions   integer,
  value_share       real,
  basis             text        not null check (basis in ('sampled','rebuilt')),
  tier              text        not null check (tier in ('verified','reported')),
  sampled_at        text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  chains_answered   integer,
  chains_expected   integer,
  primary key (handle, at, basis)
);

create index if not exists aum_samples_handle_at_idx on aum_samples (handle, at desc);
create index if not exists aum_samples_at_idx        on aum_samples (at desc);
create index if not exists aum_samples_sampled_idx   on aum_samples (sampled_at desc) where basis = 'sampled';

create table if not exists aum_chain_samples (
  handle       text        not null,
  at           text        not null,
  basis        text        not null,
  network_id   integer     not null references chains(network_id),
  total_usd    real,
  priced_share real,
  reason       text,
  primary key (handle, at, basis, network_id),
  foreign key (handle, at, basis) references aum_samples (handle, at, basis) on delete cascade
);

create index if not exists aum_chain_samples_lookup_idx   on aum_chain_samples (handle, at desc);
create index if not exists aum_chain_samples_chain_at_idx on aum_chain_samples (handle, network_id, at desc);
create index if not exists aum_chain_samples_net_at_idx   on aum_chain_samples (network_id, at desc) where basis = 'sampled';

-- Hourly AUM per trader, built from holdings + stored prices (basis priced) or copied from an
-- aum_samples measurement (basis reading). total_usd NULL means not valued, never zero.
create table if not exists aum_history (
  handle           text        not null references traders(handle) on delete cascade,
  hour             text        not null,
  total_usd        real,
  priced_positions integer     not null default 0,
  total_positions  integer     not null default 0,
  basis            text        not null check (basis in ('reading','priced')),
  reason           text        check (reason in ('no_holdings','no_prices','too_little_priced','price_suspect')),
  computed_at      text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  suspect_usd      real,
  unsellable_usd   real,
  primary key (handle, hour)
);

create index if not exists aum_history_hour_idx on aum_history (hour desc);

create table if not exists aum_live (
  handle           text        primary key references traders(handle) on delete cascade,
  at               text        not null,
  total_usd        real,
  priced_positions integer     not null default 0,
  total_positions  integer     not null default 0,
  reason           text        check (reason in ('no_holdings','no_prices','too_little_priced','price_suspect')),
  source           text        not null check (source in ('webhook','balances','prices','build')),
  suspect_usd      real,
  unsellable_usd   real
);

create index if not exists aum_live_at_idx on aum_live (at desc);

create table if not exists aum_live_dirty (
  handle    text        primary key references traders(handle) on delete cascade,
  marked_at text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------- builds and rate limits

create table if not exists builds (
  captured_at   text        primary key,
  window_label  text,
  source        text        not null default 'fomoapi.io',
  trader_count  integer,
  holding_count integer,
  ingested_at   text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Request counter per caller key. bump_rate_limit() is now a TypeScript statement (SCHEMA_MAP).
create table if not exists rate_limits (
  key          text        primary key,
  window_start text        not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  count        integer     not null default 0
);

create index if not exists rate_limits_window_start_idx on rate_limits (window_start);

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

-- pegged_usd folded in from 20260908130000: 1 for the dollar stables, NULL for floating assets.
insert into quote_assets (network_id, token_key, symbol, pegged_usd) values
  (1399811149, lower('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 'USDC', 1),
  (1399811149, lower('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'), 'USDT', 1),
  (1399811149, lower('So11111111111111111111111111111111111111112'),  'wSOL', null),
  (1399811149, lower('11111111111111111111111111111111'),             'SOL',  null),
  (1,          '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',          'USDC', 1),
  (1,          '0xdac17f958d2ee523a2206206994597c13d831ec7',          'USDT', 1),
  (1,          '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',          'WETH', null),
  (8453,       '0x4200000000000000000000000000000000000006',          'WETH', null),
  (8453,       '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',          'USDC', 1),
  (56,         '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',          'USDC', 1),
  (56,         '0x55d398326f99059ff775485246999027b3197955',          'USDT', 1),
  (56,         '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',          'WBNB', null),
  -- Robinhood chain (20260909120000): USDG is Paxos's Global Dollar; WETH floats.
  (4663,       '0x5fc5360d0400a0fd4f2af552add042d716f1d168',          'USDG', 1),
  (4663,       '0x0bd7d308f8e1639fab988df18a8011f41eacad73',          'WETH', null),
  -- Native EVM coins under the zero-address sentinel (20260917110000); floating.
  (1,          '0x0000000000000000000000000000000000000000',          'ETH',  null),
  (56,         '0x0000000000000000000000000000000000000000',          'BNB',  null),
  (8453,       '0x0000000000000000000000000000000000000000',          'ETH',  null),
  (4663,       '0x0000000000000000000000000000000000000000',          'ETH',  null)
on conflict (network_id, token_key) do update set symbol = excluded.symbol, pegged_usd = excluded.pegged_usd;

-- token_key is spelled out because it is no longer generated (see tokens).
insert into tokens (network_id, address, token_key, symbol, decimals) values
  (1,    '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 'ETH', 18),
  (56,   '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 'BNB', 18),
  (8453, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 'ETH', 18),
  (4663, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 'ETH', 18)
on conflict (network_id, token_key) do nothing;
