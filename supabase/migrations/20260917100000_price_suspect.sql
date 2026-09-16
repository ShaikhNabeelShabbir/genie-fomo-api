-- V1 (docs/TO-DO-BEFORE-MIGRATION.md §1): an impossible price was served as a verified $101B.
--
-- A reading whose largest position is over 90% of it, and whose price cannot be checked
-- against the coin's supply (or whose total is over $1B), is refused as `price_suspect`.
-- The sampler writes the word; this lets the table store it, then re-classifies what is
-- already written: no genuine portfolio in the directory tops $1B.

alter table aum_samples drop constraint if exists aum_samples_refused_reason_check;

alter table aum_samples add constraint aum_samples_refused_reason_check
  check (refused_reason is null or refused_reason in
    ('wallet_unreadable','service_timeout','no_prices','price_rejected',
     'chains_unrebuildable',
     -- One coin is most of the reading and its price is not believable: implied market cap
     -- unknown or over the ceiling. A price fault, never a balance.
     'price_suspect'));

update aum_samples set total_usd = null, refused_reason = 'price_suspect' where total_usd > 1e9;

-- The re-classified parent's chain rows and tier follow it: a priced chain row carries the
-- same word (the sampler stamps only chains that answered with a figure), and a refused
-- reading is never `verified`.
update aum_chain_samples c set total_usd = null, reason = 'price_suspect'
  from aum_samples s
  where c.handle = s.handle and c.at = s.at and c.basis = s.basis
    and c.total_usd is not null and s.refused_reason = 'price_suspect';
update aum_samples set tier = 'reported' where refused_reason = 'price_suspect';
