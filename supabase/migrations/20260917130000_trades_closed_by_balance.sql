-- TO-DO-BEFORE-MIGRATION item 10: /pnl counted trades fomo still calls open for tokens the
-- wallet no longer holds. scripts/close_stale_trades.mjs marks those `closed_by_balance`
-- nightly; `closed_by` records who closed it, since fomo never did.
--
-- trades.status carries no check constraint (see 20260904070000), so the new status word
-- needs no SQL change; the column is the only thing the table lacked.
alter table trades add column if not exists closed_by text;

comment on column trades.closed_by is
  'Who closed the trade when fomo did not: ''balance'' = the wallet no longer holds the '
  'token on a chain read within 36 h (status = ''closed_by_balance''). NULL otherwise.';
