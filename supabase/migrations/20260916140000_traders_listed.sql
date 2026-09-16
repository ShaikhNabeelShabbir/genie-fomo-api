-- Delisting, for traders the source no longer carries.
--
-- WHY. Seven traders are published with no wallet, so they reach a person's screen with no
-- balance and no chart. Asked directly on 16 September, neither source can help: fomoapi still
-- lists three with `wallets.status: "resolving"` and has dropped the other four from every
-- leaderboard window, and a scan of 377 GMGN KOL and smart-money entries matched none of them.
-- There is no address to fetch.
--
-- A2 in the acceptance tests is explicit about what to do with the ones that will never
-- resolve: "A trader with no wallet is either given one or dropped from the directory --
-- being listed and unpriceable is the worst of both."
--
-- A FLAG, NOT A DELETE, and the difference is the whole point. `cmbarce` alone carries 103
-- holdings and 144 trades; deleting the row orphans or destroys them for a condition that may
-- reverse the moment the source lists him again. Flipping a boolean is reversible, keeps every
-- figure we ever measured, and still takes him off the board.
--
-- DELISTED IS NOT DELETED, downstream either. The directory stops listing them; asking for one
-- BY NAME still answers, because a link that used to work should not start 404ing over a
-- condition upstream of us.

alter table traders
  add column if not exists listed boolean not null default true,
  add column if not exists delisted_at timestamptz,
  /* A machine word. `absent_from_source` is the only one in use today. */
  add column if not exists delisted_reason text;

comment on column traders.listed is
  'False when the source no longer carries this trader. Excluded from the directory; still '
  'answerable by name. Never deleted — the flag is reversible and the history stays.';

-- The four fomoapi has dropped from every leaderboard window. The three it still lists with
-- `status: "resolving"` are deliberately NOT touched: they are current traders whose wallets
-- upstream has not finished resolving, and they will fix themselves.
update traders
   set listed = false,
       delisted_at = now(),
       delisted_reason = 'absent_from_source'
 where lower(display_handle) in
       ('bumpyfancycoral', 'cmbarce', 'driftybearskis', 'stigstigstig_')
   and listed;

-- The directory reads "listed traders, ranked", so the flag belongs in that index.
create index if not exists traders_listed_idx on traders (listed) where listed;
