-- Gap 1 (docs/consumer/workflow-coverage-17-sep.md): token price history with ATH and drawdown.
--
-- `token_prices` is a daily close per quote asset (plus Robinhood coins since R4). The app
-- team's "past runner" / "off peak" / "dump" workflows need every held token, hourly, with a
-- rolling all-time high. Written by scripts/load_token_prices.mjs (.github/workflows/prices.yml,
-- hourly) from DexScreener; read by /tokens/:address (price block) and /positions (drawdownShare).

create table if not exists token_price_hourly (
  network_id    bigint      not null references chains(network_id),
  token_key     text        not null,
  hour          timestamptz not null,
  usd           numeric     not null,
  liquidity_usd numeric,
  source        text        not null,
  primary key (network_id, token_key, hour)
);

comment on table token_price_hourly is
  'One DexScreener sample per held token per UTC hour (deepest pool). The ATH in '
  'token_price_stats is the running max over these rows.';

create index if not exists token_price_hourly_token_hour_idx
  on token_price_hourly (network_id, token_key, hour desc);

create table if not exists token_price_stats (
  network_id     bigint      not null references chains(network_id),
  token_key      text        not null,
  ath_usd        numeric     not null,
  ath_at         timestamptz not null,
  last_usd       numeric     not null,
  last_at        timestamptz not null,
  drawdown_share numeric     not null,
  source         text,
  updated_at     timestamptz not null default now(),
  primary key (network_id, token_key)
);

comment on table token_price_stats is
  'Rolling ATH and latest price per held token, maintained by scripts/load_token_prices.mjs. '
  'The ATH is the max over token_price_hourly since we started sampling, not the token''s '
  'lifetime high.';

comment on column token_price_stats.drawdown_share is
  'drawdown_share = 1 - last_usd / ath_usd, in 0..1. 0 means the latest sample IS the high.';

comment on column token_price_stats.source is
  'Source of the latest sample (dexscreener:<dex>:<version>).';
