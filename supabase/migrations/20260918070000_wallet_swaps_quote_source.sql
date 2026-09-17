-- X2 / X1 (fix request v3, 17 Sep 2026): which price arm valued a swap's money leg, and a
-- ledger of the candidates the swaps job has already asked about.
--
-- `quote_source` is published as `trades[].valueSource`; the words are the vocabulary's.
-- `quote_usd` is signed (`quote_delta` x unit price), as the deleted Solana script wrote it
-- and as /scorecard sums it.
alter table wallet_swaps add column if not exists quote_source text;
alter table wallet_swaps drop constraint if exists wallet_swaps_quote_source_check;
alter table wallet_swaps add constraint wallet_swaps_quote_source_check
  check (quote_source in ('money_side_pegged', 'money_side_daily_close', 'money_side_market'));

-- Rows valued before the column existed: a pegged quote was the peg; Solana floating quotes
-- came from the script's daily-close update; the EVM remainder from the portfolio price.
update wallet_swaps s
   set quote_source = 'money_side_pegged'
  from quote_assets q
 where q.network_id = s.network_id and q.token_key = s.quote_key
   and q.pegged_usd is not null and s.quote_usd is not null and s.quote_source is null;
update wallet_swaps
   set quote_source = 'money_side_daily_close'
 where quote_usd is not null and quote_source is null and network_id = 1399811149;
update wallet_swaps
   set quote_source = 'money_side_market'
 where quote_usd is not null and quote_source is null;

-- Every (tx, wallet) the job resolved, swap or not. 95% of SWAP-tagged transactions are not
-- the wallet's own swap and write no `wallet_swaps` row; without this ledger a newest-first,
-- capped candidate query would re-ask the same head of the feed every run.
create table if not exists wallet_swaps_checked (
  network_id   bigint      not null references chains(network_id),
  tx_hash      text        not null,
  address_key  text        not null,
  checked_at   timestamptz not null default now(),
  primary key (network_id, tx_hash, address_key)
);
comment on table wallet_swaps_checked is
  'Candidates the swaps job has resolved (worker/src/jobs/swaps.ts), whether or not they were '
  'a swap. The anti-join for the next run; a row here is never asked again.';

insert into wallet_swaps_checked (network_id, tx_hash, address_key)
select network_id, tx_hash, address_key from wallet_swaps
on conflict do nothing;
