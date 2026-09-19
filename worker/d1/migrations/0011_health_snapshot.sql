-- /health reads this ONE row; the scheduler writes it every 10 minutes (19 Sep 2026).
-- The heavy body (counts over 1.29 M transactions, five aggregates) no longer runs per request.
create table if not exists health_snapshot (
  id          integer primary key check (id = 1),
  computed_at text    not null,
  took_ms     integer not null,
  body        text    not null
);
