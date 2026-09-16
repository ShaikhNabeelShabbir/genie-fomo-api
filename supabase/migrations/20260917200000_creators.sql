-- Dev ledger (docs/consumer/workflow-coverage-17-sep.md gap 5, W-C).
--
-- GMGN's /token/info carries the creator's address, whether they still hold, and their best
-- launch (`raw->'dev'`), one token at a time. These two tables turn that into one row per
-- creator across every token we hold info for, rebuilt nightly by scripts/refresh_creators.mjs.

create table if not exists token_creators (
  network_id          bigint      not null references chains(network_id),
  token_key           text        not null,
  creator_address_key text        not null,
  -- GMGN's word as given: creator_hold / creator_close. NULL when GMGN was silent.
  creator_status      text,
  primary key (network_id, token_key)
);
create index if not exists token_creators_creator_idx on token_creators (network_id, creator_address_key);

create table if not exists creators (
  network_id          bigint      not null references chains(network_id),
  creator_address_key text        not null,
  launches            int         not null,
  best_peak_mcap_usd  numeric,
  best_token_key      text,
  still_holding_count int         not null,
  sold_count          int         not null,
  honeypot_count      int         not null,
  -- When we first saw the newest launch, not when it was minted: tokens.first_seen_at.
  last_launch_at      timestamptz,
  updated_at          timestamptz not null default now(),
  primary key (network_id, creator_address_key)
);
