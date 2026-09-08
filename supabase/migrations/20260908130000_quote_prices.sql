-- T2.1: USD value per swap.
--
-- 108,499 of 114,566 swap rows are a quote asset, which is what makes this tractable: we
-- know the wallet moved 1.5 SOL even though we did not store what came back. Valuing the
-- quote leg gives the dollar size of the trade without needing a price for the memecoin.
--
-- Measured split of those rows:
--   USDC  102,547  (94.5%)  dollar-pegged
--   wSOL    5,511  ( 5.1%)  needs a real price series
--   USDT      448  ( 0.4%)  dollar-pegged
--
-- So 94.9% needs no price feed at all, and exactly one asset does.

-- A stablecoin's USD value is its amount. Stating that once, here, is more honest than
-- writing 285 days x 2 assets of fabricated "measurements" of 1.00 into token_prices --
-- we did not observe USDC at a dollar on any particular day, we are assuming the peg.
-- NULL means "floating, look up a real price".
alter table quote_assets add column if not exists pegged_usd numeric;

comment on column quote_assets.pegged_usd is
  'USD value of one unit for dollar-pegged assets. NULL for floating assets, whose price '
  'lives in token_prices. A peg is an assumption, not a measurement: stablecoins do break '
  '(USDC traded at 0.87 in March 2023), so a figure derived through a peg is marked as such.';

update quote_assets set pegged_usd = 1
 where symbol in ('USDC', 'USDT', 'DAI', 'BUSD', 'USDBC', 'FDUSD', 'TUSD', 'USDE');

-- Daily closes for floating quote assets. Daily, not per-minute: a swap's dollar size to the
-- nearest day is enough to answer "how much did they put in", and per-minute would mean one
-- API call per transaction instead of one per asset per day.
create table if not exists token_prices (
  network_id bigint      not null references chains(network_id),
  token_key  text        not null,
  day        date        not null,
  usd        numeric     not null,
  source     text        not null,
  fetched_at timestamptz not null default now(),
  primary key (network_id, token_key, day)
);

comment on table token_prices is
  'Daily USD close per quote asset. Populated by scripts/load_quote_prices.mjs from Binance '
  'klines (free, keyless). Only floating assets appear here; pegged ones carry '
  'quote_assets.pegged_usd instead.';

create index if not exists token_prices_day_idx on token_prices (day);
