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
 * of one build. Read ONE trader through the view, never through this.
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
                        and c2.network_id = h.network_id))`;
