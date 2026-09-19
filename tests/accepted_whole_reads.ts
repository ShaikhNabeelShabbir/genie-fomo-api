/**
 * Whole-table reads the plan audit (tests/routes_sql_test.ts) tolerates: "route | table" -> why.
 * A key that stops being found fails the test as `stale`, so a fix removes its line. Shrink this
 * list; never grow it without measuring the table on D1.
 */
export const ACCEPTED_WHOLE_READS: Record<string, string> = {
  "GET /chains | trades": "a global aggregate over every trade (per-chain realised PnL / fill rates): whole by nature, behind a 60 s cache that serves stale on error",
  "GET /fields | trades": "a global aggregate over every trade (per-chain realised PnL / fill rates): whole by nature, behind a 60 s cache that serves stale on error",
  "GET /health | aum_chain_samples": "scheduler only: the snapshot job computes this body every 10 min; a request reads one row",
  "GET /health | aum_history": "scheduler only: the snapshot job computes this body every 10 min; a request reads one row",
  "GET /health | aum_samples": "scheduler only: the snapshot job computes this body every 10 min; a request reads one row",
  "GET /health | holdings": "scheduler only: the snapshot job computes this body every 10 min; a request reads one row",
  "GET /health | tokens": "scheduler only: the snapshot job computes this body every 10 min; a request reads one row",
  "GET /health | trades": "scheduler only: the snapshot job computes this body every 10 min; a request reads one row",
  "GET /health | transactions": "scheduler only: the snapshot job computes this body every 10 min; a request reads one row",
  "GET /market/regime | tokens": "a 7-day window on a column no index carries (trades.closed_at / tokens.created_at); global, behind a 60 s cache that serves stale. Two small partial indexes would clear it: owner decision, see tasks/todo.md",
  "GET /market/regime | trades": "a 7-day window on a column no index carries (trades.closed_at / tokens.created_at); global, behind a 60 s cache that serves stale. Two small partial indexes would clear it: owner decision, see tasks/todo.md",
};
