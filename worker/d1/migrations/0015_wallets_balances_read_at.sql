-- When the balances job last ATTEMPTED this trader, answered or not (19 Sep 2026). The queue was
-- ordered by the newest holdings row, which only a SUCCESS writes: while Helius refused, the same
-- 25 traders stayed at its head and nobody else was read. Null (never attempted) sorts first.
alter table wallets add column balances_read_at text;
