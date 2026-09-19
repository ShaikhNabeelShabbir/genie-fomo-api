/**
 * Whole-table reads the plan audit (tests/routes_sql_test.ts) tolerates: "route | table" -> why.
 * A key that stops being found fails the test as `stale`, so a fix removes its line. Shrink this
 * list; never grow it without measuring the table on D1.
 */
export const ACCEPTED_WHOLE_READS: Record<string, string> = {
  "GET /chains | trades": "a global aggregate over every trade (per-chain realised PnL / fill rates): whole by nature, behind a 60 s cache that serves stale on error",
  "GET /fields | trades": "a global aggregate over every trade (per-chain realised PnL / fill rates): whole by nature, behind a 60 s cache that serves stale on error",
  "GET /health | aum_chain_samples": "scheduler only: the snapshot job computes this body every 10 min; a request reads one row (inline only while health_snapshot is empty)",
  "GET /health | aum_history": "scheduler only: the snapshot job computes this body every 10 min; a request reads one row (inline only while health_snapshot is empty)",
  "GET /health | aum_samples": "scheduler only: the snapshot job computes this body every 10 min; a request reads one row (inline only while health_snapshot is empty)",
  "GET /health | holdings": "scheduler only: the snapshot job computes this body every 10 min; a request reads one row (inline only while health_snapshot is empty)",
  "GET /health | tokens": "scheduler only: the snapshot job computes this body every 10 min; a request reads one row (inline only while health_snapshot is empty)",
  "GET /health | trades": "scheduler only: the snapshot job computes this body every 10 min; a request reads one row (inline only while health_snapshot is empty)",
  "GET /health | transactions": "scheduler only: the snapshot job computes this body every 10 min; a request reads one row (inline only while health_snapshot is empty)",
  "GET /market/regime | tokens": "baseline 19 Sep 2026 — not yet fixed",
  "GET /market/regime | trades": "baseline 19 Sep 2026 — not yet fixed",
  "GET /tokens | holdings": "baseline 19 Sep 2026 — not yet fixed",
  "GET /tokens | trader_stats": "baseline 19 Sep 2026 — not yet fixed",
  "GET /tokens/0x00000000000000000000000000000000000000aa | holdings": "baseline 19 Sep 2026 — not yet fixed",
  "GET /tokens/0x00000000000000000000000000000000000000aa | trader_stats": "baseline 19 Sep 2026 — not yet fixed",
  "GET /tokens/0x00000000000000000000000000000000000000aa | trades": "baseline 19 Sep 2026 — not yet fixed",
  "GET /tokens/0x00000000000000000000000000000000000000aa/activity | holdings": "baseline 19 Sep 2026 — not yet fixed",
  "GET /tokens/0x00000000000000000000000000000000000000aa/activity | trades": "baseline 19 Sep 2026 — not yet fixed",
  "GET /tokens/0x00000000000000000000000000000000000000aa/prices | token_price_hourly": "baseline 19 Sep 2026 — not yet fixed",
  "GET /tokens/0x00000000000000000000000000000000000000aa/prices | tokens": "baseline 19 Sep 2026 — not yet fixed",
  "GET /tokens/momentum | holdings": "baseline 19 Sep 2026 — not yet fixed",
  "POST /tokens/prices | token_price_hourly": "baseline 19 Sep 2026 — not yet fixed",
  "POST /tokens/prices | tokens": "baseline 19 Sep 2026 — not yet fixed",
};
