-- Launch metadata on tokens (docs/LAUNCH_METADATA.md; consumer workflow gap 3: W-B, W-C, W-D).
--
-- Written nightly by scripts/load_token_launch.mjs from one on-chain read per Solana mint:
-- pump.fun's bonding-curve account. Every column is nullable with no default: an unread token
-- is unknown, never "not pump.fun" and never "0 % along the curve".

alter table tokens
  add column if not exists created_at      timestamptz,
  add column if not exists launchpad       text check (launchpad in ('pump.fun')),
  add column if not exists curve_progress  numeric check (curve_progress between 0 and 1),
  add column if not exists graduated       boolean,
  add column if not exists launch_read_at  timestamptz;

comment on column tokens.created_at is
  'Block time of the oldest signature on the launch account (pump.fun bonding curve). NULL: unread, '
  'not a launchpad token, or history deeper than the loader walks.';
comment on column tokens.launchpad is
  'Where the token launched. Only pump.fun is detected today; NULL after a read means no curve account.';
comment on column tokens.curve_progress is
  '1 - real_token_reserves / initial_real_token_reserves (793,100,000 tokens). 1 once graduated.';
comment on column tokens.graduated is
  'pump.fun `complete`: the curve filled and liquidity migrated to PumpSwap. NULL when not a launchpad token.';
comment on column tokens.launch_read_at is
  'When the loader last read the chain for this token. NULL: never read.';
