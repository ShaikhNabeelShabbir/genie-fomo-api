-- AUM over time (AUM_PLAN.md phase 1) — storage for one sampled balance series per trader.
--
-- The API answers "what does he hold now" (/portfolio) and cannot answer "what did he hold
-- on Tuesday". Consumers have been rebuilding that from the swap stream, and the rebuild
-- cannot be made correct: the stream is ~86% buys to 14% sells, so a balance rolled backwards
-- from it drifts upward and never sees an exit, and a coin already sold never appears in a
-- holdings list at all. Our own resolver measured the same shape -- 696 genuine two-sided
-- swaps in 132,128 SWAP-tagged Solana transactions.
--
-- So this records the balance when it happens instead of deriving it afterwards.
--
-- AGGREGATES, NOT POSITIONS. One row per trader per hour, plus one per trader-hour-chain.
-- Storing the per-position detail hourly would be ~262M rows a year against ~30,000 open
-- positions; the totals plus coverage are what the route serves and what a chart needs.
-- The per-coin breakdown stays on /positions, where it already lives.

create table if not exists aum_samples (
  handle            text        not null references traders(handle) on delete cascade,
  -- The hour this describes, truncated. `sampled_at` below is when we actually read it.
  at                timestamptz not null,

  /*
   * NULL means the sample was REFUSED, and `refused_reason` says why. It never means zero
   * and it is never a smaller number standing in for a complete one.
   *
   * This is the whole point of the table. If one wallet will not answer, the trader-hour is
   * refused outright rather than totalled from the wallets that did -- a partial total reads
   * low, looks exactly like a real drawdown, and nothing downstream can tell them apart.
   */
  total_usd         numeric,
  refused_reason    text        check (refused_reason is null or refused_reason in
                      ('wallet_unreadable','service_timeout','no_prices','price_rejected')),

  -- Coverage travels with the number, as everywhere else in this API. A line built from 41
  -- coins worth 57% of him and one built from 2 coins worth 0.3% are different claims.
  priced_positions  integer,
  total_positions   integer,
  value_share       numeric,

  /*
   * How this point was arrived at, and how much to trust it.
   *   sampled  — amounts read from chain at the time.            tier = verified
   *   rebuilt  — amounts inferred from swaps we happened to see. tier = reported
   * They are never mixed inside one segment of a response; the join is `trackedSince`.
   */
  basis             text        not null check (basis in ('sampled','rebuilt')),
  tier              text        not null check (tier in ('verified','reported')),

  sampled_at        timestamptz not null default now(),

  -- `basis` is in the key so a rebuilt point and a real sample for the same hour can coexist
  -- and be told apart, rather than a backfill silently overwriting a measurement.
  primary key (handle, at, basis)
);

comment on table aum_samples is
  'One sampled balance per trader per hour, in USD, across every wallet and chain. '
  'total_usd NULL means refused, never zero. See AUM_PLAN.md.';
comment on column aum_samples.value_share is
  'Share of total_usd the priced positions represent — what makes a thin line legible as thin.';

-- The route reads one trader over a window, newest first.
create index if not exists aum_samples_handle_at_idx on aum_samples (handle, at desc);
-- The sampler asks "who have I not done this hour" across the whole board.
create index if not exists aum_samples_at_idx on aum_samples (at desc);

-- ------------------------------------------------------------------- per chain
-- The response carries a per-chain breakdown, and §8 requires that the parts sum to the
-- whole on every response. Keeping them in their own table means that identity is checkable
-- rather than asserted.
create table if not exists aum_chain_samples (
  handle       text        not null,
  at           timestamptz not null,
  basis        text        not null,
  network_id   bigint      not null references chains(network_id),

  -- NULL for the same reason as above: a chain we could not price contributes no dollars and
  -- must not contribute a zero. `reason` says which.
  total_usd    numeric,
  priced_share numeric,
  reason       text,

  primary key (handle, at, basis, network_id),
  foreign key (handle, at, basis) references aum_samples (handle, at, basis) on delete cascade
);

comment on table aum_chain_samples is
  'Per-chain split of an aum_samples row. sum(total_usd) must equal the parent total_usd.';

create index if not exists aum_chain_samples_lookup_idx
  on aum_chain_samples (handle, at desc);
