-- Rug Dodger (docs/consumer/composite-workflows-coverage-17-sep.md C3).
--
-- `is_honeypot` is the LATEST read only, so it cannot say whether a trader exited before the
-- coin turned. This is when we first saw it turn: scripts/load_token_info.mjs sets it on the
-- first nightly refresh where `is_honeypot` or `can_not_sell` becomes true, and never clears
-- it — a coin that was a honeypot once is a coin that was a honeypot.
alter table token_info add column if not exists honeypot_since timestamptz;

comment on column token_info.honeypot_since is
  'First nightly refresh where is_honeypot or can_not_sell became true; never cleared. Null: never flagged.';
