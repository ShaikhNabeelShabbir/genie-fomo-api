import { assert, assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { getDefaultSql } from "../supabase/functions/api/db.ts";
import { candidatePage, LAP_DAYS, lapWindow } from "../worker/src/jobs/swaps-core.ts";

const SOL = 1399811149;
const DAY = 86_400;

Deno.test("swap candidates: only unchecked legs inside the window, newest first, and the time index drives", async () => {
  const db = await openSchema();
  const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
  const leg = (hash: string, at: string, type: string | null, net = SOL): void =>
    run(`insert into transactions (network_id, tx_hash, address_key, transfer_key, block_time, direction, token_key, amount, source, tx_type)
         values (?,?,?,?,?,'in','mint',1,'helius',?)`, net, hash, "wallet1", hash, at, type);
  leg("new-unchecked", "2026-09-19T10:00:00.000Z", "SWAP");
  leg("new-checked", "2026-09-19T09:00:00.000Z", "SWAP");
  leg("new-transfer", "2026-09-19T08:00:00.000Z", "TRANSFER");       // Solana reads SWAP legs only
  leg("old-unchecked", "2026-08-01T00:00:00.000Z", "SWAP");           // outside the window: the lap's business
  leg("evm-unchecked", "2026-09-19T07:00:00.000Z", null, 1);
  run("insert into wallet_swaps_checked (network_id, tx_hash, address_key) values (?,?,?)", SOL, "new-checked", "wallet1");
  const sql = getDefaultSql()!;
  const from = "2026-09-16T00:00:00.000Z", to = "2026-09-19T12:00:00.000Z";
  assertEquals((await candidatePage(sql, SOL, true, from, to, 100)).map((r) => r.tx_hash), ["new-unchecked"]);
  assertEquals((await candidatePage(sql, 1, false, from, to, 100)).map((r) => r.tx_hash), ["evm-unchecked"]);
  assertEquals((await candidatePage(sql, SOL, true, "2026-07-20T00:00:00.000Z", "2026-08-03T00:00:00.000Z", 100)).map((r) => r.tx_hash), ["old-unchecked"]);
  const q = candidatePage(sql, SOL, true, from, to, 100);
  const plan = (db.prepare("explain query plan " + q.text).all(...(q.params as string[])) as { detail: string }[]).map((r) => r.detail);
  assert(plan.some((d) => /SEARCH t USING INDEX transactions_block_time_idx \(block_time>\? AND block_time<\?\)/.test(d)), plan.join(" | "));
  assert(!plan.some((d) => /USE TEMP B-TREE/.test(d)), "the order must come from the index, not a sort: " + plan.join(" | "));
});

Deno.test("the lap walks down from the recent floor one window a run and wraps past the oldest transfer", () => {
  const floor = 1_000 * DAY, oldest = floor - 30 * DAY;
  const first = lapWindow(null, floor, oldest);
  assertEquals([first.toSec, first.fromSec, first.nextSec], [floor, floor - LAP_DAYS * DAY, floor - LAP_DAYS * DAY]);
  const second = lapWindow(first.nextSec, floor, oldest);
  assertEquals([second.toSec, second.fromSec], [floor - LAP_DAYS * DAY, floor - 2 * LAP_DAYS * DAY]);
  const third = lapWindow(second.nextSec, floor, oldest);
  assertEquals(third.nextSec, null, "its window reaches past the oldest transfer: the next run starts again at the floor");
  assertEquals(lapWindow(floor + 5 * DAY, floor, oldest).toSec, floor, "a stored place above the floor (the clock moved) is ignored");
  assertEquals(lapWindow(null, floor, null).nextSec, null, "an empty table has nothing to lap");
});
