-- The directory's figures, taken per trader rather than per load.
--
-- trader_stats_current published one capture for everybody:
--
--     where captured_at = (select max(captured_at) from trader_stats)
--
-- Two loaders write this table and they do not run together. The fomo leaderboard writes 100
-- rows; the GMGN load writes 291. Whichever ran last became "current" for the whole
-- directory, and every trader the other loader owns fell out of the view entirely -- so
-- pnl_usd, volume_usd, trade_count and the row's own captured_at all read null on the
-- directory for 342 of 442 traders, while their figures sat in the table unchanged.
--
-- The latest capture PER HANDLE is the thing that was always meant. It costs nothing: the
-- table is 1,325 rows in 280 kB, and distinct on (handle) walks the existing primary key
-- (handle, captured_at) in 3.0 ms, so no index is added here.
--
-- captured_at now varies between rows, which is the point -- it is that trader's own
-- freshness rather than the directory's newest load, and a consumer reading it per row gets
-- an honest date instead of one borrowed from a trader it is not looking at.

create or replace view trader_stats_current as
  select distinct on (handle)
         handle,
         captured_at,
         rank,
         pnl_usd,
         volume_usd,
         trade_count,
         followers
  from trader_stats
  order by handle, captured_at desc;

comment on view trader_stats_current is
  'The newest trader_stats row per handle. Not the newest load: two loaders write this table '
  'at different times, so one capture never covers the whole directory.';
