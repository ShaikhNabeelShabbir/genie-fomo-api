-- ============================================================================
-- builds — one row per ingested generation.
--
-- The JSON carried two things the row tables do not: `window` ("30d", which
-- leaderboard period the figures describe) and `generated_at`. Losing `window`
-- was the single regression in the file -> Postgres move; every other field of
-- all 100 traders came across identical.
--
-- It belongs here rather than as a column on trader_stats because it describes
-- the BUILD, not a trader — repeating "30d" on 100 rows would invite it to
-- disagree with itself. This also gives later build metadata somewhere to go.
-- ============================================================================

create table if not exists builds (
  captured_at   timestamptz primary key,
  window_label  text,
  source        text        not null default 'fomoapi.io',
  trader_count  integer,
  holding_count integer,
  ingested_at   timestamptz not null default now()
);

comment on table builds is
  'One row per generation of the directory. `window_label` is the leaderboard '
  'period the trader_stats figures describe.';

alter table builds enable row level security;
