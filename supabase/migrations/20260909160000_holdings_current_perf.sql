-- holdings_current was rewritten in 20260909100000 to let chain-read balances fill the gaps
-- fomo does not cover. It was correct and, once the cohort tripled, slow: a plain
-- count(*) took 7.4s and /v1/tokens took 33-39s.
--
-- The cause was the anti-join. `not exists (select 1 from fomo f ...)` referenced a CTE, and
-- a CTE has no indexes, so the planner had no choice but to re-scan 2,918 fomo rows for each
-- of ~27,000 chain rows. Measured at 22s inside EXPLAIN ANALYZE.
--
-- Same semantics, expressed so the planner can use an index: the anti-join now references
-- `holdings` itself, whose primary key already begins (handle, network_id).
create or replace view holdings_current as
  select h.* from holdings h
  where h.source = 'fomo'
    and h.captured_at = (select captured_at from latest_capture)
  union all
  select h.* from holdings h
  join (
    -- Newest chain snapshot per (trader, network). Each network is read by a different
    -- transport, so a failed pass on one must not invalidate a good pass on another.
    select handle, network_id, max(captured_at) as captured_at
    from holdings where source = 'chain'
    group by handle, network_id
  ) cl on cl.handle = h.handle and cl.network_id = h.network_id and cl.captured_at = h.captured_at
  where h.source = 'chain'
    -- Chain rows FILL GAPS and never override fomo, so the two sources are never summed
    -- into one ratio. Unchanged in meaning from the version this replaces.
    and not exists (
      select 1 from holdings f
      where f.source = 'fomo'
        and f.captured_at = (select captured_at from latest_capture)
        and f.handle = h.handle
        and f.network_id = h.network_id
    );

comment on view holdings_current is
  'The newest fomo build, plus chain-read balances for any (trader, network) that build '
  'did not cover. History stays in `holdings`. The anti-join deliberately references the '
  'base table rather than a CTE so it can use an index -- the CTE form cost 7.4s a count.';

-- Serves both the anti-join and the per-(trader, network) grouping above.
create index if not exists holdings_source_handle_net_idx
  on holdings (source, handle, network_id, captured_at desc);
