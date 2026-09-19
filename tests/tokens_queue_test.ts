import { assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { getDefaultSql } from "../supabase/functions/api/db.ts";
import { gmgnFailure, infoTargets } from "../worker/src/jobs/tokens-core.ts";

Deno.test("gmgnFailure: the source turning us away stops the run; no document for a coin parks the coin", () => {
  for (const m of ["HTTP 401", "HTTP 403", "HTTP 429", "HTTP 502", "RATE_LIMIT", "The operation timed out", "fetch failed"]) assertEquals(gmgnFailure(m), "refused", m);
  for (const m of ["token not found", "malformed document", "gmgn error", "HTTP 400", "HTTP 404"]) assertEquals(gmgnFailure(m), "nothing", m);
});

Deno.test("the GMGN queue: most-held first, then longest-waiting; a coin GMGN had nothing for waits a week", async () => {
  const db = await openSchema();
  const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
  const now = new Date().toISOString();
  const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();
  for (const h of ["a", "b", "c"]) run("insert into traders (handle, display_handle, id) values (?,?,?)", h, h, `id-${h}`);
  const coin = (key: string, holders: string[], fetchedAt: string | null, missedAt: string | null): void => {
    run("insert into tokens (network_id, address, token_key) values (1,?,?)", key, key);
    for (const h of holders) run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, source) values (?,1,?,?,5,'chain')", h, key, now);
    if (fetchedAt) run("insert into token_info (network_id, token_key, source, fetched_at, security_fetched_at) values (1,?,'gmgn',?,?)", key, fetchedAt, fetchedAt);
    if (missedAt) run("insert into token_info_misses (network_id, token_key, missed_at) values (1,?,?)", key, missedAt);
  };
  coin("0xdust_unknown", ["a"], null, ago(1));          // GMGN had nothing yesterday: parked, NOT first in line
  coin("0xpopular_stale", ["a", "b", "c"], ago(9), null); // the app's complaint: read 9 days ago, held by three
  coin("0xnever_read", ["a"], null, null);
  coin("0xone_holder_stale", ["b"], ago(3), null);
  coin("0xfresh", ["a", "b"], ago(0.1), null);           // inside the 20 h window: not due
  coin("0xmissed_long_ago", ["c"], null, ago(8));        // parked a week ago: due again
  const queue = await infoTargets(getDefaultSql()!, "-20 hours", "-7 days");
  assertEquals(queue.map((t) => t.token_key), ["0xpopular_stale", "0xmissed_long_ago", "0xnever_read", "0xone_holder_stale"]);
});
