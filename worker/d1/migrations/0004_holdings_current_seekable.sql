-- `holdings_current` computed `max(captured_at) group by handle, network_id` over the WHOLE
-- table in a CTE, so SQLite materialised it before the caller's `where handle = ?` could apply:
-- one trader's read touched 252,975 rows, and `holdings_live` multiplied that by its per-row
-- subqueries until four traders exceeded D1's per-query CPU limit (17 Sep 2026).
--
-- The same rule as a correlated maximum instead: with `holdings_source_handle_net_idx`
-- (source, handle, network_id, captured_at desc) both the outer filter and the subquery are
-- index seeks, so the cost follows the trader asked for rather than the table. Rows, columns
-- and order are unchanged: the newest chain capture per (handle, network), plus the newest
-- fomo capture for a (handle, network) never read on chain.
drop view if exists holdings_current;

create view holdings_current as
  select h.* from holdings h
   where h.source = 'chain'
     and h.captured_at = (select max(h2.captured_at) from holdings h2
                           where h2.source = 'chain' and h2.handle = h.handle
                             and h2.network_id = h.network_id)
  union all
  select h.* from holdings h
   where h.source = 'fomo'
     and h.captured_at = (select captured_at from latest_capture)
     and not exists (select 1 from holdings c
                      where c.source = 'chain' and c.handle = h.handle
                        and c.network_id = h.network_id);
