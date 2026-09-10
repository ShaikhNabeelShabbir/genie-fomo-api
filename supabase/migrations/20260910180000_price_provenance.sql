-- Genie plugin PRD §3 — "amount is the balance read from the chain", and every position
-- carries priceUsd, priceSource, pricedAt and valueUsd.

-- ------------------------------------------------------------- price provenance
-- A price with no source and no timestamp cannot be judged. fomo's reported entry price
-- from three weeks ago and GMGN's live price are both usable, and they are not the same
-- kind of claim -- so each row now says which it got and when that price was true.
alter table holdings add column if not exists price_source text;
alter table holdings add column if not exists priced_at    timestamptz;

comment on column holdings.price_source is
  'pegged_usd | gmgn_token_info | token_prices_daily | fomo_reported_entry | wallet_swap_derived. '
  'NULL means unpriced, which is never the same as zero.';
comment on column holdings.priced_at is
  'When the price was true. For a live price that is the fetch time; for a reported entry '
  'price it is when the position was opened, which may be weeks old.';

-- --------------------------------------------------------- chain beats reported
-- The plugin team measured frankdegods'' positions counting 196,001.62 USDC against a wallet
-- holding 12,081.96, and ten of twelve traders differing from us by more than a tenth. They
-- are right, and the reason is that a running total is not a balance.
--
-- Until now holdings_current preferred FOMO and let chain rows fill only the gaps, which was
-- the safe choice while chain coverage was partial. Coverage is no longer partial: 368 of
-- 435 traders have chain-read balances across all five chains. So the precedence flips --
-- a balance we read ourselves beats a total somebody reported.
--
-- Still resolved per (trader, network), never blended: mixing a chain reading of one network
-- with a reported total of another would double-count nothing but would mean a single
-- portfolio total whose parts came from two different kinds of measurement.
create or replace view holdings_current as
  with chain_latest as (
    select handle, network_id, max(captured_at) as captured_at
    from holdings where source = 'chain'
    group by handle, network_id
  ),
  chain as (
    select h.* from holdings h
    join chain_latest cl
      on cl.handle = h.handle and cl.network_id = h.network_id and cl.captured_at = h.captured_at
    where h.source = 'chain'
  )
  select * from chain
  union all
  -- fomo now fills the gaps rather than winning them: a (trader, network) we have never
  -- read from chain still answers, rather than disappearing.
  select h.* from holdings h
  where h.source = 'fomo'
    and h.captured_at = (select captured_at from latest_capture)
    and not exists (
      select 1 from chain c where c.handle = h.handle and c.network_id = h.network_id
    );

comment on view holdings_current is
  'Balances read from chain, with the newest fomo build filling any (trader, network) we '
  'have not read ourselves. Chain wins because a running total is not a balance.';
