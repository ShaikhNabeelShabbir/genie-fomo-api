import type { Sql } from "../../../worker/src/d1.ts";

/**
 * EVERY CURRENT HOLDING, FOR A STATEMENT THAT NEEDS THEM ALL. Same rows and columns as the
 * `holdings_current` view; a derived table to put after `from`.
 *
 * The view is written for one trader: its chain arm keeps a row when `captured_at` equals a
 * correlated max, which an index answers at once for a named handle. Read WHOLE, that test runs for
 * every chain row ever captured — about 950,000 of them, growing ~107,000 a day — to keep ~40,000.
 * Three jobs did that on every run (tokens 6.6 s / 1.6 M rows, prices 5.9 s / 1.46 M, the health
 * snapshot 2.6 s / 1.98 M, 19 Sep 2026), and every API statement queued behind them.
 *
 * Here the question is asked per (trader, chain) PAIR — 2,240 seeks for the newest capture, then
 * that capture's rows through the same index. `cross join` states the order: D1 has picked a worse
 * one than local SQLite before. The fomo arm is the view's, unchanged: it was already a range read
 * of one build.
 *
 * `limit -1` changes no row. It is there because a subquery with a LIMIT is never flattened into
 * its caller: flattened, a caller with a big table to the LEFT of this one ran that table OUTSIDE
 * the pair walk — 424 ms became 28 s on a production-sized database, past D1's 30 s limit, and no
 * plan line looked wrong. It also means a caller's `where` is not pushed inside, so a statement
 * naming ONE trader reads the VIEW (which seeks for a named handle), never this.
 *
 * Two things a caller must know. (1) Equality with the view rests on holdings' foreign keys: every
 * chain row's handle is a trader and every network a chain (D1 enforces both). (2) The rows come in
 * another ORDER than the view's (chains by name inside a trader): order by a total key, or do not
 * depend on order. Do not name a CTE traders, chains, holdings or latest_capture around it.
 */
export const currentHoldings = (sql: Sql) => sql`(
  select h.*
    from traders t
    cross join chains c
    cross join holdings h
      on h.source = 'chain' and h.handle = t.handle and h.network_id = c.network_id
     and h.captured_at = (select max(h2.captured_at) from holdings h2
                           where h2.source = 'chain' and h2.handle = t.handle
                             and h2.network_id = c.network_id)
  union all
  select h.* from holdings h
   where h.source = 'fomo'
     and h.captured_at = (select captured_at from latest_capture)
     and not exists (select 1 from holdings c2
                      where c2.source = 'chain' and c2.handle = h.handle
                        and c2.network_id = h.network_id)
  limit -1)`;
