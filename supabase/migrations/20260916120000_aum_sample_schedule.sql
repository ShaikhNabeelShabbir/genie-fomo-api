-- Schedule the AUM sampler inside Supabase, instead of depending on GitHub Actions.
--
-- WHY THIS MOVED. `refresh.yml` carries `cron: '0 6 * * *'` and stopped firing on 14
-- September. Nobody noticed for six days: every balance reading in the database falls on one
-- of three moments against a published daily promise, and 81 of the 88 traders answering
-- `no_reading` are waiting on that job. The schedule was correct the whole time; the runner
-- was not there.
--
-- Over the same week the Edge Function `helius-webhook` took 292,970 rows without missing.
-- The half of the system that stayed up is the half that lives in Supabase, so the sampler
-- moves here: one less runner to be silently absent, and the schedule sits beside the data it
-- writes.
--
-- WHAT THIS DOES NOT REPLACE. `refresh.yml` still owns the directory build, the trade loader,
-- token info and the fee passes. This takes the AUM sampling leg only -- the one whose
-- freshness is read directly off a chart.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- The secret the function checks, and the URL to reach it.
--
-- Stored in Vault rather than inline: the cron job body is readable by anyone who can read
-- cron.job, and a shared secret written there is a shared secret published. Set both once:
--
--   select vault.create_secret('<the AUM_SAMPLE_SECRET value>', 'aum_sample_secret');
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/aum-sample',
--                              'aum_sample_url');
--
-- and set AUM_SAMPLE_SECRET on the function itself to the same value:
--   npx supabase secrets set AUM_SAMPLE_SECRET=<value> HELIUS_SOLANA_KEY=<value>
-- ---------------------------------------------------------------------------

create or replace function public.run_aum_sample(slice int default 10)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_url text;
  v_secret text;
  v_id bigint;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'aum_sample_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'aum_sample_secret';
  if v_url is null or v_secret is null then
    raise notice 'aum_sample_url or aum_sample_secret is not in vault; nothing scheduled';
    return null;
  end if;

  /*
   * Fire and forget. pg_net queues the request and returns immediately, so a slow chain read
   * cannot hold a database worker open -- which is the failure mode that matters here, given
   * the loaders once exhausted this pooler and took the read API to 503.
   */
  select net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-sample-secret', v_secret),
    body    := jsonb_build_object('limit', slice),
    timeout_milliseconds := 120000
  ) into v_id;
  return v_id;
end;
$$;

comment on function public.run_aum_sample(int) is
  'POSTs one slice to the aum-sample Edge Function. Called by cron; safe to call by hand.';

-- ---------------------------------------------------------------------------
-- The schedule.
--
-- Every five minutes, ten traders, oldest-sampled first. The function picks who by age, so
-- there is no queue table to get out of step and a new trader is picked up on the next tick.
--
-- 441 traders / 10 per slice = 45 slices, one every five minutes = under four hours for a
-- full rotation. Measured cost per slice: ~21 seconds of chain reads, ~10 Helius calls.
-- Raise the slice or the frequency to rotate faster; both are one UPDATE away.
--
-- Deliberately NOT one big hourly job: a slice that dies takes ten traders with it and the
-- next tick picks them up again, where an hourly sweep that dies takes the hour.
-- ---------------------------------------------------------------------------
select cron.unschedule('aum-sample-rotate')
  where exists (select 1 from cron.job where jobname = 'aum-sample-rotate');

select cron.schedule(
  'aum-sample-rotate',
  '*/5 * * * *',
  $$select public.run_aum_sample(10)$$
);
