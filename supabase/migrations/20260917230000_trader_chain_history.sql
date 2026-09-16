-- One definition of "the chains a trader is on" (docs/REVIEW_EFFICIENCY_17_SEP.md, structural
-- note). `knownChainsFor` (api/shared/chains.ts) and /health's `historyState` used to carry
-- twin `seen`/`ah`/`hist` CTEs with a comment promising they matched; now both read this.
--
-- A (trader, chain) pair is SEEN when any of three feeds evidences it: a trade on that chain
-- (wallet_chain_presence), a live position there (holdings_current, human_amount > 0), or a
-- chain sample that answered with a figure (aum_chain_samples, total_usd not null: the
-- sampler's own definition of a known chain, aum-sample/index.ts). `history_state` is the
-- two-point rule the /aum series uses: `none` has never produced a reading, `warming` one,
-- `ready` two or more.
--
-- Written as one UNION ALL aggregated once, not as CTEs: a CTE referenced twice is
-- materialised and stops `where handle = any($1)` / `where network_id = $1` reaching the
-- base tables. Every handle column here is a foreign key to traders, so no join to traders
-- is needed to exclude unknown handles.

create or replace view trader_chain_history as
  select e.handle,
         e.network_id,
         c.name                     as chain,
         sum(e.positions)::int      as positions,
         sum(e.history_points)::int as history_points,
         case when sum(e.history_points) >= 2 then 'ready'
              when sum(e.history_points) = 1  then 'warming'
              else 'none' end       as history_state
  from (
    select handle, network_id, 0 as positions, 0 as history_points
    from wallet_chain_presence
    union all
    select handle, network_id, 1, 0
    from holdings_current where human_amount > 0
    union all
    select handle, network_id, 0, 1
    from aum_chain_samples where total_usd is not null
  ) e
  join chains c using (network_id)
  group by e.handle, e.network_id, c.name;

comment on view trader_chain_history is
  'One row per (trader, chain) evidenced by a trade, a live position or an accepted chain '
  'sample. positions = live positions with a balance; history_points = chain samples that '
  'answered with a figure; history_state = ready (>= 2) | warming (1) | none (0). The single '
  'definition behind knownChainsFor and /health feeds.aum.historyState.';
