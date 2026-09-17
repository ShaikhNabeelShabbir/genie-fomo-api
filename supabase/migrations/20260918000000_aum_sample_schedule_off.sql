-- Applied 17 Sep 2026 ~03:52 UTC. Balance history is BUILT from stored balances and prices
-- (aum_history, migration 20260918010000) and refreshed live (aum_live); nothing samples any
-- more, so the pg_cron rotation that drove the Supabase `aum-sample` function is retired. Re-run the
-- schedule block of 20260916120000_aum_sample_schedule.sql to bring it back.
select cron.unschedule('aum-sample-rotate')
  where exists (select 1 from cron.job where jobname = 'aum-sample-rotate');
