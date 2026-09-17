-- Traders whose Solana wallet moved since their live value was last refreshed. The Helius
-- receiver only marks (one cheap upsert per push, ~40 pushes a minute); a one-minute cron
-- refreshes the marked traders in one set-based call and clears them. Refreshing inside every
-- push (18 Sep 2026, 04:40-05:15) ran holdings_live per push and saturated the database.
create table if not exists aum_live_dirty (
  handle    text        primary key references traders(handle) on delete cascade,
  marked_at timestamptz not null default now()
);
