-- Precompute what GET /traders/:id/positions was recomputing on every request.
--
-- positionTiming() groups one wallet's transactions by (network_id, token_key) to find when a
-- token was first received, last sent, and last touched. A covering index made that an
-- index-only scan and cut the disk reads 100-fold, but it could not change the shape of the
-- work: our busiest wallet has 66,773 transactions and aggregating them still costs ~9
-- seconds of CPU, every time anyone opens that trader. The route sat at the edge of its
-- 15-second budget and returned 503 past it.
--
-- The answer is not a faster aggregate, it is not doing the aggregate per request. These
-- values change only when new transactions arrive, so they are computed once by the loader
-- and read back by primary key.
--
--   0xangeryy      7,954 transactions   1.4s -> index lookup
--   frankdegods   38,432 transactions   4.9s -> index lookup
--   unipcs        66,773 transactions  12.5s -> index lookup

create table if not exists position_timing (
  address_key text        not null,
  network_id  bigint      not null references chains(network_id),
  token_key   text        not null,

  -- First time this wallet RECEIVED the token. Null when we have only outbound rows for it,
  -- which is a real state: we started watching after they already held it.
  start_at    timestamptz,
  -- Last time they sent it. Null while they have never sent any, which is not the same as
  -- "sent none recently" and must not be shown as a date.
  end_at      timestamptz,
  -- Last movement in either direction.
  last_at     timestamptz not null,

  -- When this row was derived, so a stale row is visible as stale rather than assumed fresh.
  computed_at timestamptz not null default now(),

  primary key (address_key, network_id, token_key)
);

comment on table position_timing is
  'Derived from transactions: per (wallet, chain, token) first-in, last-out and last-touch. '
  'Rebuilt by scripts/refresh_position_timing.mjs; never written by the API.';

-- The route asks for one wallet at a time and wants every token it has touched.
create index if not exists position_timing_address_idx
  on position_timing (address_key);
