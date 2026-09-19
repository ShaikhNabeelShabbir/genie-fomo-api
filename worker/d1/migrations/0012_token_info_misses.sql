-- A GMGN read that found no document for a coin must leave the head of the queue (19 Sep 2026).
-- Without a trace of the miss, never-fetched coins sorted first and were asked again on every run.
create table if not exists token_info_misses (
  network_id integer not null,
  token_key  text    not null,
  missed_at  text    not null,
  detail     text,
  primary key (network_id, token_key)
);
