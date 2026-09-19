import { assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { getDefaultSql } from "../supabase/functions/api/db.ts";
import { gmgnFailure, infoTargets } from "../worker/src/jobs/tokens-core.ts";

Deno.test("gmgnFailure: the source turning us away stops the run; no document for a coin parks the coin", () => {
  for (const m of ["HTTP 401", "HTTP 403", "HTTP 429", "HTTP 502", "RATE_LIMIT", "The operation timed out", "fetch failed"]) assertEquals(gmgnFailure(m), "refused", m);
  for (const m of ["token not found", "malformed document", "gmgn error", "HTTP 400", "HTTP 404"]) assertEquals(gmgnFailure(m), "nothing", m);
});

/** Seeds one held coin; returns nothing. `fetchedAt`/`missedAt` null means never. */
type Seed = (key: string, holders: string[], fetchedAt: string | null, missedAt: string | null) => void;
const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

async function seeded(): Promise<Seed> {
  const db = await openSchema();
  const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
  const now = new Date().toISOString();
  for (const h of ["a", "b", "c"]) run("insert into traders (handle, display_handle, id) values (?,?,?)", h, h, `id-${h}`);
  return (key, holders, fetchedAt, missedAt) => {
    run("insert into tokens (network_id, address, token_key) values (1,?,?)", key, key);
    for (const h of holders) run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, source) values (?,1,?,?,5,'chain')", h, key, now);
    if (fetchedAt) run("insert into token_info (network_id, token_key, source, fetched_at, security_fetched_at) values (1,?,'gmgn',?,?)", key, fetchedAt, fetchedAt);
    if (missedAt) run("insert into token_info_misses (network_id, token_key, missed_at) values (1,?,?)", key, missedAt);
  };
}

Deno.test("the GMGN queue: most-held and longest-since-asked take turns; a coin GMGN had nothing for waits a week", async () => {
  const coin = await seeded();
  coin("0xdust_unknown", ["a"], null, ago(1));          // GMGN had nothing yesterday: parked, NOT first in line
  coin("0xpopular_stale", ["a", "b", "c"], ago(9), null); // the app's complaint: read 9 days ago, held by three
  coin("0xpopular_too", ["a", "b"], ago(2), null);
  coin("0xnever_read", ["a"], null, null);
  coin("0xone_holder_stale", ["b"], ago(3), null);
  coin("0xfresh", ["a", "b"], ago(0.1), null);           // inside the 20 h window: not due
  coin("0xmissed_long_ago", ["c"], null, ago(8));        // parked a week ago: due again, and it waited 8 days, not for ever
  coin("0xdropped", ["a"], ago(30), ago(7.5));           // read once, then GMGN dropped it: last ASKED 7.5 days ago, not 30
  const queue = await infoTargets(getDefaultSql()!, "-20 hours", "-7 days");
  // Places 1 and 3 by holders, place 2 to the never-asked coin: most-held-first alone put 0xpopular_too second.
  // 0xdropped waits behind the coin asked 8 days ago: ranked by its old answer it took place 4 every 7 days.
  assertEquals(queue.map((t) => t.token_key), ["0xpopular_stale", "0xnever_read", "0xpopular_too", "0xmissed_long_ago", "0xdropped", "0xone_holder_stale"]);
});

Deno.test("the GMGN queue: a run's places are split, so popular coins falling due every run cannot starve the tail", async () => {
  const coin = await seeded();
  for (let i = 1; i <= 6; i++) coin(`0xpopular${i}`, ["a", "b", "c"], ago(1), null);
  for (let i = 1; i <= 6; i++) coin(`0xtail${i}`, ["a"], ago(11 - i), null); // tail1 has waited longest
  const queue = await infoTargets(getDefaultSql()!, "-20 hours", "-7 days");
  assertEquals(queue.slice(0, 6).map((t) => t.token_key), ["0xpopular1", "0xtail1", "0xpopular2", "0xtail2", "0xpopular3", "0xtail3"]);
  assertEquals(queue.length, 12);
});
