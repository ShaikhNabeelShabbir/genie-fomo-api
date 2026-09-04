-- ============================================================================
-- Two additions asked for by the consuming team.
--
-- 1. A STABLE ID. `handle` is our primary key and is stable in this schema, but
--    it is derived from fomo's display handle — which is theirs to change, not
--    ours. A consumer keying rows on `handle` would silently lose a trader the
--    day fomo renames them. `id` is ours, generated once, and never reissued.
--
-- 2. TOKEN SUPPLY. Average entry is read on their screen as a market cap
--    ("Avg. entry: $717K MC"), not a per-token price. Sending a price and
--    letting them multiply is not safe: they measured one coin whose implied
--    supply moved 12.45% in a day, so their conversion and ours would disagree
--    with no way to tell which was right. Storing the supply WE used, with the
--    time we read it, makes the two reconcilable.
-- ============================================================================

create extension if not exists "pgcrypto";

alter table traders
  add column if not exists id uuid not null default gen_random_uuid();

create unique index if not exists traders_id_idx on traders (id);

comment on column traders.id is
  'Stable identifier, ours. Survives a fomo handle change; `handle` may not.';

alter table tokens
  add column if not exists total_supply     numeric,
  add column if not exists decimals         integer,
  add column if not exists supply_source    text,
  add column if not exists supply_read_at   timestamptz;

comment on column tokens.total_supply is
  'Human-readable supply used to turn a per-token price into a market cap. '
  'Nullable with no default: an unknown supply must never become 0, which would '
  'render every market cap as $0 rather than as "not known".';
