import { assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { getDefaultSql } from "../supabase/functions/api/db.ts";
import { parkable, pending, readBatch, recordMisses } from "../worker/src/jobs/fees-core.ts";

const BSC = 56;

Deno.test("the fee queue: a fresh miss and an errored item are offered again; a 2-day-old explicit null is parked", async () => {
  const db = await openSchema();
  const sql = getDefaultSql()!;
  const SOLANA = 1399811149;
  const swap = db.prepare(`insert into wallet_swaps (network_id, tx_hash, address_key, block_time, token_key, token_delta) values (${SOLANA}, ?, 'w', ?, 'mint', 1)`);
  const now = Date.now();
  swap.run("sigFresh", new Date(now - 9_000).toISOString());
  swap.run("sigErrored", new Date(now - 3 * 86_400_000).toISOString());
  swap.run("sigOld", new Date(now - 2 * 86_400_000).toISOString());

  // What readChain does with one answered batch: read it, park what may be parked.
  const p = await pending(sql, SOLANA, true, 10, "-7 days");
  assertEquals(p.hashes, ["sigFresh", "sigOld", "sigErrored"]);
  const read = readBatch([{ id: 0, result: null }, { id: 1, result: null }, { id: 2, error: { code: -32429 } }], p.hashes)!;
  const parked = parkable(read.absent, p.blockTime, now);
  assertEquals(parked, ["sigOld"]);
  await recordMisses(sql, SOLANA, parked);
  assertEquals((await pending(sql, SOLANA, true, 10, "-7 days")).hashes, ["sigFresh", "sigErrored"]);

  // An undated hash is parked: no later run could date it. One a day and a minute old is; one 23 hours old is not.
  const at = new Map<string, string | null>([["u", null], ["d", new Date(now - 86_460_000).toISOString()], ["h", new Date(now - 23 * 3_600_000).toISOString()]]);
  assertEquals(parkable(["u", "d", "h"], at, now), ["u", "d"]);
});

Deno.test("the fee queue: newest first, and a hash the source had nothing for is parked, so old hashes cannot hold the head", async () => {
  const db = await openSchema();
  const sql = getDefaultSql()!;
  const tx = db.prepare(`insert into transactions (network_id, tx_hash, address_key, transfer_key, block_time, source) values (${BSC}, ?, ?, ?, ?, 'bitquery')`);
  const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();
  for (let i = 0; i < 5; i++) tx.run(`0xold${i}`, "0xw1", "k", ago(60 + i));
  tx.run("0xnew", "0xw2", "k", ago(0.01));
  tx.run("0xnew", "0xw2", "k2", ago(0.01));                       // a second leg of the same transaction
  tx.run("0xpaid", "0xw2", "k", ago(0.02));
  tx.run("0xundated", "0xw3", "k", null);
  db.prepare(`insert into transaction_fees (network_id, tx_hash, fee_native, fee_native_symbol, source) values (${BSC}, '0xpaid', 0.001, 'BNB', 't')`).run();

  await recordMisses(sql, 1, ["0xnew"]);                           // the same hash parked on ANOTHER chain is not this chain's miss
  // As shipped: oldest first, so a slice of 5 was the five old hashes on every run and 0xnew was never asked.
  const first = await pending(sql, BSC, false, 5, "-7 days");
  assertEquals(first.hashes, ["0xnew", "0xold0", "0xold1", "0xold2", "0xold3"]);
  assertEquals(first.total, 7);
  assertEquals([...first.addresses].sort(), ["0xw1", "0xw2"]);

  // The realtime source answers 0xnew only: the rest are parked, and the next run reaches what it never asked.
  await recordMisses(sql, BSC, first.hashes.filter((h) => h !== "0xnew"));
  db.prepare(`insert into transaction_fees (network_id, tx_hash, fee_native, fee_native_symbol, source) values (${BSC}, '0xnew', 0.002, 'BNB', 't')`).run();
  const second = await pending(sql, BSC, false, 5, "-7 days");
  assertEquals(second.hashes, ["0xold4", "0xundated"]);
  assertEquals(second.total, 2);

  // A miss is a wait, not a verdict: after the retry window the hash is offered again, and a repeat miss restarts the wait.
  db.prepare("update transaction_fee_misses set missed_at = ? where tx_hash = '0xold0'").run(ago(8));
  assertEquals((await pending(sql, BSC, false, 5, "-7 days")).hashes, ["0xold0", "0xold4", "0xundated"]);
  await recordMisses(sql, BSC, ["0xold0"]);
  assertEquals((await pending(sql, BSC, false, 5, "-7 days")).hashes, ["0xold4", "0xundated"]);
});

Deno.test("the fee queue: swapsOnly reads wallet_swaps alone", async () => {
  const db = await openSchema();
  const SOLANA = 1399811149;
  db.prepare(`insert into transactions (network_id, tx_hash, address_key, transfer_key, block_time, source) values (${SOLANA}, 'sigTransfer', 'w', 'k', '2026-09-19T00:00:00.000Z', 'helius')`).run();
  db.prepare(`insert into wallet_swaps (network_id, tx_hash, address_key, block_time, token_key, token_delta) values (${SOLANA}, 'sigSwap', 'w', '2026-09-19T00:00:00.000Z', 'mint', 1)`).run();
  assertEquals((await pending(getDefaultSql()!, SOLANA, true, 5, "-7 days")).hashes, ["sigSwap"]);
});
