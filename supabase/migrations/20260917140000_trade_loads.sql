-- T1 — trades stuck at 7–8 Sep for the same 16 traders (docs/TO-DO-BEFORE-MIGRATION.md §11).
--
-- `trades.captured_at` is fomo's snapshot time and `trades.ingested_at` only moves when a
-- fetch returns rows, so a trader fomo will not serve (degraded / 404 / error) leaves no
-- trace at all: the loader reselects him every pass and the scorecard's `loadedAt` ages
-- forever with nothing to say why. One row per attempt, whatever the answer was.
create table if not exists trade_loads (
  handle       text        not null,
  attempted_at timestamptz not null default now(),
  outcome      text        not null
               check (outcome in ('loaded', 'unavailable', 'degraded', 'not_found', 'error')),
  detail       text,
  primary key (handle, attempted_at)
);

create index if not exists trade_loads_handle_attempted_idx on trade_loads (handle, attempted_at desc);

comment on table trade_loads is
  'One row per fomoapi trade fetch per trader, including the ones that wrote nothing. '
  '`loaded` = a document came back (possibly with zero trades); `unavailable` = fomo does '
  'not serve this trader (not on its leaderboard); `degraded` = fomo shed load twice; '
  '`not_found` = HTTP 404; `error` = transport or non-2xx.';
