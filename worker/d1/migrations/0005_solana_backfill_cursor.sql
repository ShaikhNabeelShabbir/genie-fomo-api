-- W2 (v5 fixes, 17 Sep 2026). THE SOLANA RECORD HAD A MOVING FLOOR.
--
-- `transfers.ts` called Helius with `before = null` on every run and walked 5 pages of 100, so
-- it re-pulled the newest 500 signatures of each wallet forever and never reached further back.
-- On an airdrop-spammed wallet 500 signatures is a few weeks: smokey0x's stored Solana swaps
-- stopped on 6 Aug although he traded that morning, and `/trades` still answered
-- `complete: true` because `complete` only meant "the page was not capped".
--
-- The cursor itself needs no column: the next `before` is the oldest Solana `tx_hash` we already
-- hold for the wallet. What cannot be derived is when to STOP, so that is the one flag here.
-- 1 = a backward page came back empty, the wallet's history is in.
alter table wallets add column sol_backfill_done integer;

-- The backward walk seeks the oldest row per address; without this it scans the address's rows.
create index if not exists transactions_address_net_time_idx
  on transactions (address_key, network_id, block_time);
