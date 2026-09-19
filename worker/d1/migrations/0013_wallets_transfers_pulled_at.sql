-- When the transfers job last pulled this wallet on every chain (19 Sep 2026). The job's queue was
-- ordered by max(transactions.ingested_at) per wallet, which read all 1.29 M transfers every run.
alter table wallets add column transfers_pulled_at text;
