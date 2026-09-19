import { assert, assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { getDefaultSql } from "../supabase/functions/api/db.ts";
import { byChain, candidateRange, lapRange } from "../worker/src/jobs/swaps-core.ts";

const SOL = 1399811149;

Deno.test("swap candidates: only unchecked legs inside the rowid range, and the range is what the statement costs", async () => {
  const db = await openSchema();
  const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
  const leg = (hash: string, at: string | null, type: string | null, net = SOL, key = hash): void =>
    run(`insert into transactions (network_id, tx_hash, address_key, transfer_key, block_time, direction, token_key, amount, source, tx_type)
         values (?,?,?,?,?,'in','mint',1,'helius',?)`, net, hash, "wallet1", key, at, type);
  leg("old-unchecked", "2026-08-01T00:00:00.000Z", "SWAP");           // rowid 1: below the range, the lap's business
  leg("swap-checked", "2026-09-19T09:00:00.000Z", "SWAP");            // 2
  leg("swap-new", "2026-09-19T10:00:00.000Z", "SWAP", SOL, "leg-a");  // 3
  leg("swap-new", "2026-09-19T10:00:00.000Z", "SWAP", SOL, "leg-b");  // 4: the second leg of the same transaction
  leg("sol-transfer", "2026-09-19T08:00:00.000Z", "TRANSFER");        // 5: Solana reads SWAP legs only
  leg("evm-new", "2026-09-19T07:00:00.000Z", null, 1);                // 6: EVM rows carry no type
  leg("undated", null, "SWAP");                                       // 7: cannot be ordered or priced
  run("insert into wallet_swaps_checked (network_id, tx_hash, address_key) values (?,?,?)", SOL, "swap-checked", "wallet1");
  const sql = getDefaultSql()!;
  const found = await candidateRange(sql, SOL, 1, 7);
  assertEquals(found.map((r) => [r.rid, r.tx_hash]), [[6, "evm-new"], [4, "swap-new"], [3, "swap-new"]]);
  assertEquals((await candidateRange(sql, SOL, 0, 1)).map((r) => r.tx_hash), ["old-unchecked"]);
  const q = candidateRange(sql, SOL, 1, 7);
  const plan = (db.prepare("explain query plan " + q.text).all(...(q.params as number[])) as { detail: string }[]).map((r) => r.detail);
  assert(plan.some((d) => /SEARCH t USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/.test(d)), plan.join(" | "));
  assert(!plan.some((d) => /USE TEMP B-TREE|SCAN t\b/.test(d)), "no sort and no scan: " + plan.join(" | "));

  const chains = byChain(found, (net) => (net === SOL ? 3000 : 2000));
  assertEquals([...chains.keys()].sort(), [1, SOL]);
  assertEquals(chains.get(SOL)!.map((c) => c.tx_hash), ["swap-new"], "two legs of one transaction are one candidate");
  assertEquals(byChain(found, () => 0).size, 0, "a chain's limit is respected");
});

Deno.test("the lap walks down from the run's place one range a run and wraps at the first row", () => {
  const first = lapRange(null, 60_000, 25_000);
  assertEquals([first.upto, first.after, first.next], [60_000, 35_000, 35_000]);
  const second = lapRange(first.next, 61_000, 25_000);
  assertEquals([second.upto, second.after, second.next], [35_000, 10_000, 10_000]);
  const third = lapRange(second.next, 62_000, 25_000);
  assertEquals([third.upto, third.after, third.next], [10_000, 0, null], "it reached the first row: the next lap starts under the run's place again");
  assertEquals(lapRange(90_000, 60_000, 25_000).upto, 60_000, "a stored place above the run's own (a re-import renumbered rowids) is ignored");
  assertEquals(lapRange(null, 0, 25_000), { after: 0, upto: 0, next: null });
});
