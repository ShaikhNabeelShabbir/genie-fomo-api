-- T3a: contract safety from GMGN /v1/token/security.
--
-- The gap this closes: we rank tokens by how many tracked leaders hold them and say NOTHING
-- about whether the contract lets you sell. Two comments in our own routes already work
-- around the absence -- one reads "34 of 150 traders once held the same honeypot". Probing
-- found 14 confirmed honeypots among tokens our leaders currently hold.
--
-- Stored on token_info rather than in its own table: same token, same nightly cadence, same
-- loader, always fetched together.
--
-- THE FIELDS ARE CHAIN-DEPENDENT, and the loader must not paper over it:
--
--   EVM (eth/bsc/base/robinhood)  is_honeypot / is_open_source / is_renounced are real
--                                 booleans; renounced_mint and renounced_freeze_account come
--                                 back FALSE but are Solana concepts and mean nothing here
--   Solana                        the exact mirror -- is_honeypot / is_open_source /
--                                 is_renounced are NULL (not assessed) and mint/freeze carry
--                                 the signal
--
-- A `false` for a check that does not exist on a chain reads as "we looked and it failed".
-- Inapplicable checks are therefore stored NULL, per chain, by the loader.
--
-- `if not exists` throughout: these columns already exist in the live database from an
-- earlier pass, and this file is what documents them.
alter table token_info
  add column if not exists is_honeypot          boolean,
  add column if not exists buy_tax              numeric,
  add column if not exists sell_tax             numeric,
  add column if not exists is_open_source       boolean,
  add column if not exists is_renounced         boolean,
  add column if not exists renounced_mint       boolean,
  add column if not exists renounced_freeze     boolean,
  add column if not exists rug_ratio            numeric,
  add column if not exists burn_ratio           numeric,
  add column if not exists is_blacklisted       boolean,
  add column if not exists can_not_sell         boolean,
  add column if not exists security_raw         jsonb,
  add column if not exists security_fetched_at  timestamptz;

comment on column token_info.is_honeypot is
  'TRUE = buying succeeds and selling fails. NULL = not assessed on this chain (always NULL '
  'on Solana, where GMGN does not evaluate it). NULL is never "safe".';

comment on column token_info.renounced_mint is
  'Solana only. NULL on EVM chains, where GMGN returns false for a concept that does not '
  'exist there -- storing that false would read as an unrenounced mint authority.';

comment on column token_info.security_fetched_at is
  'Separate from fetched_at: security comes from a second endpoint and can be older or '
  'missing while the fundamentals are current.';

create index if not exists token_info_honeypot_idx
  on token_info (is_honeypot) where is_honeypot is true;
