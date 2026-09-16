-- Sampler partial readings (docs/TO-DO-BEFORE-MIGRATION.md items 3 and 4: Z1, Z2, R5).
--
-- The sampler now reads each chain on its own. A chain that will not answer gets its own
-- aum_chain_samples row with total_usd NULL and a reason, and the parent row says
-- chains_answered < chains_expected instead of refusing the whole trader-hour. No new
-- columns: those two already express "partial".
--
-- One new word. An EVM chain the sampler has no token list for was being read as "held
-- nothing" and written as $0. Nothing was asked, so nothing was answered: the reading is
-- refused with this reason, and a chain row carries the same word.

alter table aum_samples drop constraint if exists aum_samples_refused_reason_check;

alter table aum_samples add constraint aum_samples_refused_reason_check
  check (refused_reason is null or refused_reason in
    ('wallet_unreadable','service_timeout','no_prices','price_rejected',
     'chains_unrebuildable',
     -- One coin is most of the reading and its price is not believable (20260917100000_price_suspect.sql).
     'price_suspect',
     -- No chain could be asked: the sampler holds no token list for any of his EVM chains
     -- and he has no Solana wallet. Unread, not empty.
     'no_tokens_known',
     -- No chain could be asked at all: none of his known chains is reached by a wallet he has.
     'nothing_answered'));

comment on column aum_chain_samples.reason is
  'Why total_usd is NULL on this chain: no_prices, wallet_unreadable, service_timeout, '
  'or no_tokens_known. NULL with total_usd 0 is a chain that answered and held nothing.';
