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

-- No index is added. The backward walk's `order by block_time asc limit 1` per
-- (address_key, network_id) is served by the existing
-- `transactions_wallet_time_idx (address_key, network_id, block_time desc)`, which SQLite walks
-- in reverse for an ascending order. A second copy in ascending order would cost an index build
-- over 1.39M rows and slow every insert for nothing.
