import { assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { getDefaultSql } from "../supabase/functions/api/db.ts";
import { balanceTargets, notAttemptedSince, stampAttempt } from "../worker/src/jobs/balances-core.ts";

Deno.test("the balances queue: ordered by the last ATTEMPT, so a refused or emptied wallet leaves the head", async () => {
  const db = await openSchema();
  const sql = getDefaultSql()!;
  const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
  for (const h of ["a_refused", "b_read", "c_never", "d_emptied"]) {
    run("insert into traders (handle, display_handle, id) values (?,?,?)", h, h, `id-${h}`);
    run("insert into wallets (handle, sol_address) values (?,?)", h, `So1${h}`);
  }
  // Only b ever wrote a capture. Ordered by the newest holdings row, a, c and d tied for the head on every run.
  run("insert into tokens (network_id, address, token_key) values (1,'0xcoin','0xcoin')");
  run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, source) values ('b_read',1,'0xcoin','2026-09-19T01:00:00.000Z',5,'chain')");
  const queue = async (limit: number): Promise<string[]> => (await balanceTargets(sql, limit)).map((t) => t.handle);

  await stampAttempt(sql, "b_read", "2026-09-19T01:00:00.000Z");
  await stampAttempt(sql, "a_refused", "2026-09-19T02:00:00.000Z"); // Helius answered 429: no row, still an attempt
  await stampAttempt(sql, "d_emptied", "2026-09-19T03:00:00.000Z"); // answered with nothing held: no row either
  assertEquals(await queue(3), ["c_never", "b_read", "a_refused"]);
  assertEquals(Number((await notAttemptedSince(sql, "2026-09-19T02:30:00.000Z"))[0].n), 3, "c (never), b and a; d was attempted after");

  // The next run is refused on everyone it asks, and the head still moves on.
  await stampAttempt(sql, "c_never", "2026-09-19T04:00:00.000Z");
  await stampAttempt(sql, "b_read", "2026-09-19T04:00:00.000Z");
  assertEquals(await queue(2), ["a_refused", "d_emptied"]);
  assertEquals(Number((await notAttemptedSince(sql, "2026-09-19T04:00:00.000Z"))[0].n), 2);
});
