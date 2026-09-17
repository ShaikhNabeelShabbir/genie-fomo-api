-- T1 (v3 fixes) — a sixth `trade_loads.outcome`: `unchanged`.
--
-- The scorecards job now targets `max(trades.captured_at)` (fomo's snapshot time, the column
-- the API judges) and retries a stale trader every 6 h. A document fomo answered whose
-- snapshot did not advance (re-served, or empty so nothing was written) is recorded as
-- `unchanged`, so `loadAttemptedAt`/`loadOutcome` say what happened instead of staying null.
alter table trade_loads drop constraint if exists trade_loads_outcome_check;
alter table trade_loads add constraint trade_loads_outcome_check
  check (outcome in ('loaded', 'unchanged', 'unavailable', 'degraded', 'not_found', 'error'));

comment on table trade_loads is
  'One row per fomoapi trade fetch per trader, including the ones that wrote nothing. '
  '`loaded` = a document came back and its snapshot advanced max(trades.captured_at); '
  '`unchanged` = a document came back but the snapshot did not advance (re-served or empty); '
  '`unavailable` = fomo does not serve this trader (not on its leaderboard); `degraded` = fomo '
  'shed load twice; `not_found` = HTTP 404; `error` = transport or non-2xx.';
