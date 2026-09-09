-- Step 2 of the axis build order (AXIS_ALIGNMENT.md §6) — Axis 4, risk control.
--
-- Axis 4 needs cashShare and concentration, both of which read holdings_current. 67 of our
-- 144 traders had NO holdings row at all, so the axis could not render for them at any
-- formula. The cause was never missing data: we were only ever asking fomo, and
-- build_directory_fomoapi.py records that /v2/users/{handle} answers "trader not found"
-- for anyone outside its top 100. The chain answers for all of them.
--
-- This migration makes room for balances we read ourselves, WITHOUT changing a single
-- number for the 77 traders who already work.

-- ------------------------------------------------------------------ provenance
-- 'fomo'  — reported to us in a build payload, priced by fomo.
-- 'chain' — read by us from the chain (scripts/load_chain_balances.mjs), priced from
--           token_info / token_prices, and NULL-priced where we have no price. A holding
--           we cannot value is still a holding; dropping it would understate `positions`
--           and flatter `concentration`.
alter table holdings add column if not exists source text not null default 'fomo';

do $$ begin
  alter table holdings add constraint holdings_source_known check (source in ('fomo','chain'));
exception when duplicate_object then null; end $$;

comment on column holdings.source is
  'Who measured this row. Chain rows fill gaps in fomo''s coverage; see holdings_current.';

create index if not exists holdings_source_capture_idx on holdings (source, captured_at desc);

-- The primary key is deliberately left alone. captured_at is already in it and every chain
-- run stamps its own read time, so chain rows cannot collide with a fomo build — and
-- load_to_db.py's `on conflict (handle, network_id, token_key, captured_at)` keeps working.

-- ------------------------------------------------------------- latest_capture
-- Was `max(captured_at) from holdings`. Left unscoped, the first chain snapshot would
-- become "the newest capture" and holdings_current would drop all 77 fomo traders on the
-- spot. It means the newest fomo BUILD, and now says so.
create or replace view latest_capture as
  select max(captured_at) as captured_at from holdings where source = 'fomo';

comment on view latest_capture is
  'Newest fomo build timestamp. Chain snapshots have their own read times and are resolved '
  'per (handle, network_id) inside holdings_current.';

-- ----------------------------------------------------------- holdings_current
-- Two rules, both chosen so that shipping this cannot move an existing number:
--
--   1. Chain rows FILL GAPS. They never override fomo. If fomo reported anything for a
--      (handle, network_id), that is what you get.
--   2. Resolution is per (handle, network_id), not per handle. Each network is read by a
--      different transport, so a BSC pass that fails must not invalidate a Solana pass
--      that succeeded, and a fomo-covered network must not be replaced wholesale.
--
-- Never a union of both sources within one network: that would count a token twice and
-- quietly inflate totalValueUsd, which concentration and cashShare are both ratios of.
create or replace view holdings_current as
  with fomo as (
    select h.* from holdings h
    where h.source = 'fomo'
      and h.captured_at = (select captured_at from latest_capture)
  ),
  chain_latest as (
    select handle, network_id, max(captured_at) as captured_at
    from holdings where source = 'chain'
    group by handle, network_id
  ),
  chain as (
    select h.* from holdings h
    join chain_latest cl
      on  cl.handle     = h.handle
      and cl.network_id = h.network_id
      and cl.captured_at = h.captured_at
    where h.source = 'chain'
  )
  select * from fomo
  union all
  select c.* from chain c
  where not exists (
    select 1 from fomo f where f.handle = c.handle and f.network_id = c.network_id
  );

comment on view holdings_current is
  'The newest fomo build, plus chain-read balances for any (trader, network) that build '
  'did not cover. History stays in `holdings` — that is what K2 momentum diffs and what '
  'makes the 2026-09-02 -> 2026-09-04 drift visible.';

-- ------------------------------------------------------------------ decimals
-- Nothing to add: `tokens.decimals` has existed since 20260904140000_stable_ids_and_supply
-- and load_token_supply.mjs already fills it (decimals() over RPC on EVM, getTokenSupply on
-- Solana). load_chain_balances.mjs reads what is there and only calls decimals() for the
-- tokens still missing one, so the two writers agree by construction rather than by luck.
-- Restated here only because a raw ERC-20 balance is meaningless without it.
comment on column tokens.decimals is
  'Token decimals, read from chain by load_token_supply.mjs or load_chain_balances.mjs. '
  'NULL means not yet read, never "0 decimals" -- an unscaled balance is off by 10^18.';
