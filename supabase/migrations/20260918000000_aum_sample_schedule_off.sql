-- The Worker `genie-copy-trading-api` samples on its own cron trigger (worker/wrangler.toml
-- [triggers]) from 18 Sep 2026. Two samplers writing the same tables double the readings, so
-- the pg_cron rotation that drove the Supabase `aum-sample` function is retired. Re-run the
-- schedule block of 20260916120000_aum_sample_schedule.sql to bring it back.
select cron.unschedule('aum-sample-rotate')
  where exists (select 1 from cron.job where jobname = 'aum-sample-rotate');
