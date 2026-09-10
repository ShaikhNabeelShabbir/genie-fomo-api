-- Genie plugin PRD §1 and §2 — a stable identity, and wallets that say where they live.

-- ------------------------------------------------------------------- §1 identity
-- `traders.id` already exists: uuid, NOT NULL, unique across all 435 rows. What was missing
-- is that nothing could be looked up BY it, and that a display name could collide.
--
-- The collision was real and ours: the GMGN loader checked `handle` for uniqueness but not
-- `display_handle`, so `yeon__` and `gmgn_yeon__` both displayed as "yeon__" -- two people
-- under one name, which is exactly what §1 reports.
create unique index if not exists traders_id_uidx on traders (id);

-- A handle is a display name and people change them. Recording when it last changed lets a
-- consumer notice, rather than silently following a name onto a different person.
alter table traders add column if not exists handle_changed_at timestamptz;

comment on column traders.handle_changed_at is
  'When `handle` last changed. NULL means never observed changing. `id` is the stable key.';

-- Break the display collision by qualifying the newer of the two. The GMGN-sourced row is
-- the one that moves: fomo''s handle is the older claim on that name.
update traders t
   set display_handle = t.display_handle || ' (gmgn)',
       handle_changed_at = now()
 where t.source = 'gmgn'
   and exists (
     select 1 from traders o
     where o.handle <> t.handle
       and lower(o.display_handle) = lower(t.display_handle)
       and o.source <> 'gmgn'
   );

-- ------------------------------------------------------------------ §2 presence
-- "An Ethereum-style address is the same wallet on Ethereum, Base, BNB Chain and Robinhood
-- Chain at once, so a consumer cannot know where to read without asking every chain."
--
-- We can already answer it: `trades` carries network_id per trader and covers all five
-- chains. This view turns that into the shape §2 asks for -- observed presence, never
-- inferred from the address's format. A chain we have never seen the wallet on is ABSENT,
-- not `tradesSeen: 0`, because those are different claims.
create or replace view wallet_chain_presence as
  select tr.handle,
         tr.network_id,
         ch.name                     as chain,
         count(*)::int               as trades_seen,
         max(tr.captured_at)         as last_active_at
  from trades tr
  join chains ch using (network_id)
  group by tr.handle, tr.network_id, ch.name;

comment on view wallet_chain_presence is
  'Chains each trader has been OBSERVED trading on, with a count and a last-seen time. '
  'Absence means never observed, which is not the same as zero.';
