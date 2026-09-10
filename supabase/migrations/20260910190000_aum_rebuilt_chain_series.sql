-- AUM backfill (AUM_PLAN.md phase 3) — make room for a REBUILT series that is per-chain.
--
-- The rebuild reconstructs balances backwards from ERC-20 Transfer logs. That is only
-- possible where the chain will actually answer for a 30-day span, and we measured that it
-- is true on exactly one of our five:
--
--   robinhood  eth_getLogs accepts 1,000,000-block windows and address topic arrays, so
--              30 days is ~28 requests. THIS IS THE ONE WE REBUILD.
--   solana     no historical-balance method exists, and our stored transfer history reaches
--              a full 30 days back for only 17 of 170 wallets -- rolling backwards would
--              stop at the start of tracking and look like a balance rather than a gap.
--   bsc        every keyless RPC is pruned; historical state answers "missing trie node".
--   base       archive works, but 139 positions is 0.9% of value -- not worth a resolver.
--   ethereum   archive works on one endpoint, 1,462 positions, 0.7% of value -- same.
--
-- SO A REBUILT POINT IS A CHAIN'S TOTAL, NOT A TRADER'S. Only 31 of the 276 traders holding
-- robinhood hold robinhood alone; for the other 245 a robinhood-only figure would sit in the
-- same series as a whole-portfolio sample and read as a 36% drawdown that never happened.
--
-- The per-chain rows in aum_chain_samples are correct by construction, so that is where the
-- rebuilt series lives. The parent row still has to exist (aum_chain_samples references it),
-- and it carries a total only when robinhood is the whole story.

alter table aum_samples drop constraint if exists aum_samples_refused_reason_check;

alter table aum_samples add constraint aum_samples_refused_reason_check
  check (refused_reason is null or refused_reason in
    ('wallet_unreadable','service_timeout','no_prices','price_rejected',
     -- A trader-level total we decline to state because chains we cannot rebuild are part
     -- of it. The per-chain row for robinhood beside it is complete; this one is not, and
     -- says so rather than publishing a number that is missing 36% of him.
     'chains_unrebuildable'));

comment on column aum_samples.refused_reason is
  'Why total_usd is NULL. Never a zero and never a partial total. '
  'chains_unrebuildable means the per-chain rows are good but the trader total is not.';

-- The rebuild writes one row per trader per DAY, and the route reads a chain series over a
-- window. Without this it scans the whole table per trader.
create index if not exists aum_chain_samples_chain_at_idx
  on aum_chain_samples (handle, network_id, at desc);
