-- T3d: token fundamentals from GMGN, cached.
--
-- Why this is proxied rather than computed: price, liquidity and chain-wide holder counts are
-- facts about a token across every holder. We observe 137 traders. No amount of our own data
-- produces them, and deriving them from our slice and publishing under GMGN's names would be
-- a number that looks authoritative while being scoped to a fraction of the chain.
--
-- What it unblocks: 1,889 of 2,918 holdings (64.7%) carry no price, so 689 of 1,095 board
-- tokens return totalValueUsd: null. That silently degrades six features already shipped --
-- value sorting, leader concentration, portfolio totals, cash share, position shares, and
-- every coverage figure that counts a priced holding.
--
-- `raw` is kept deliberately. One /v1/token/info response also carries the holder
-- concentration (T3b), creator signals (T3c) and wallet tags (T3e) this plan lists as separate
-- items. Storing the whole document means those become a read of this table rather than three
-- more 18-minute crawls.
create table if not exists token_info (
  network_id         bigint      not null references chains(network_id),
  token_key          text        not null,
  symbol             text,
  name               text,
  price_usd          numeric,
  liquidity_usd      numeric,
  market_cap_usd     numeric,
  total_supply       numeric,
  circulating_supply numeric,
  max_supply         numeric,
  holder_count       integer,
  top_10_holder_rate numeric,
  raw                jsonb,
  source             text        not null default 'gmgn',
  fetched_at         timestamptz not null default now(),
  primary key (network_id, token_key)
);

comment on table token_info is
  'Third-party token fundamentals from GMGN /v1/token/info, refreshed nightly. Everything '
  'here is tier=third_party and must stay distinguishable from figures we compute: the '
  'reported-vs-verified split is the one thing this API has that GMGN does not.';

comment on column token_info.raw is
  'The full response. Holder concentration, creator signals and wallet tags are already in '
  'here, so surfacing them later costs a query rather than another crawl of every token.';

comment on column token_info.market_cap_usd is
  'GMGN''s figure where they give one; otherwise price x circulating_supply, computed by the '
  'loader and only when both inputs are present. NULL when it cannot be established -- never '
  '0, which would read as "worthless" rather than "unknown".';

create index if not exists token_info_fetched_idx on token_info (fetched_at);
