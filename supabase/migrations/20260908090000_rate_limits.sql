-- Shared rate-limit counter.
--
-- The limiter was a `Map` held in the Edge Function's module scope. That cannot work:
-- every invocation gets a fresh isolate, so the map was empty on arrival and discarded on
-- exit. Measured before this migration: 132 consecutive calls each reported
-- `RateLimit-Remaining: 239`, and an earlier burst of 400 calls never produced a 429. The
-- limit did not bind, and the header published a constant dressed up as a budget.
--
-- The counter has to live somewhere every instance can see, and the database is the only
-- shared thing this service already has.

create table if not exists rate_limits (
  key          text        primary key,
  window_start timestamptz not null default now(),
  count        integer     not null default 0
);

comment on table rate_limits is
  'Request counter per caller key (x-api-key, else x-forwarded-for). Rows are transient; '
  'bump_rate_limit() prunes stale ones opportunistically.';

create index if not exists rate_limits_window_start_idx on rate_limits (window_start);

-- One statement, so the read-modify-write cannot interleave between instances. Returns the
-- post-increment count and the seconds left in the window.
create or replace function bump_rate_limit(
  p_key            text,
  p_window_seconds integer
) returns table (hit_count integer, reset_seconds integer)
language plpgsql
as $$
declare
  v_window interval := p_window_seconds * interval '1 second';
  v_start  timestamptz;
  v_count  integer;
begin
  insert into rate_limits as r (key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do update
    set count        = case when r.window_start < now() - v_window then 1 else r.count + 1 end,
        window_start = case when r.window_start < now() - v_window then now() else r.window_start end
  returning r.count, r.window_start into v_count, v_start;

  -- Keys are mostly client IPs, so the table would otherwise grow without bound. Pruning
  -- on ~1% of calls keeps it small without needing a scheduled job.
  if random() < 0.01 then
    delete from rate_limits where window_start < now() - interval '10 minutes';
  end if;

  return query select
    v_count,
    greatest(1, ceil(extract(epoch from (v_start + v_window) - now()))::integer);
end
$$;
