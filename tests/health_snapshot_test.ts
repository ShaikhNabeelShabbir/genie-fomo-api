import { assert, assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { handle } from "../supabase/functions/api/app.ts";
import { getDefaultSql, setDefaultSql } from "../supabase/functions/api/db.ts";
import {
  PROBE_MS, refreshHealthSnapshot, SNAPSHOT_STALE_MINUTES, tokenInfoFeed, withSnapshotAge,
} from "../supabase/functions/api/routes/health.ts";
import "../supabase/functions/api/routes.ts";

const issued: string[] = [];
const db = await openSchema((text) => issued.push(text));
db.exec("insert into builds (captured_at, window_label, trader_count, holding_count) values ('2026-09-19T01:00:00.000Z','30d',0,0)");

const health = (): Promise<Response> => handle(new Request("https://test.local/v2/health"));

Deno.test("health: the scheduler's snapshot runs every heavy statement against the real schema and stores one row", async () => {
  const snap = await refreshHealthSnapshot();
  const body = JSON.parse(snap.body);
  assertEquals(typeof body.rows.transactions, "number");
  assert("prices" in body.feeds && "tokenInfo" in body.feeds, "the two feeds added on 19 Sep are published");
  assertEquals((db.prepare("select count(*) as n from health_snapshot").get() as { n: number }).n, 1);
  await refreshHealthSnapshot();
  assertEquals((db.prepare("select count(*) as n from health_snapshot").get() as { n: number }).n, 1, "a second run replaces the row");
});

Deno.test("health: a request reads ONE row and reports the database it just probed", async () => {
  issued.length = 0;
  const res = await health();
  const body = await res.json();
  assertEquals([res.status, body.status, body.database.answering, body.cached], [200, "ok", true, true]);
  assertEquals(typeof body.database.latencyMs, "number");
  assertEquals(body.apiVersion, "v2");
  const reads = issued.filter((t) => /^\s*select/i.test(t));
  assertEquals(reads.length, 1, `expected the snapshot read alone, got:\n${reads.join("\n")}`);
  assert(/from health_snapshot/.test(reads[0]));
});

Deno.test("health: a snapshot the scheduler stopped renewing degrades the verdict and names the scheduler", () => {
  const fresh = { dataState: "current", staleFeeds: [] as string[] };
  assertEquals(withSnapshotAge(fresh, SNAPSHOT_STALE_MINUTES * 60), fresh);
  assertEquals(withSnapshotAge(fresh, SNAPSHOT_STALE_MINUTES * 60 + 1), { dataState: "degraded", staleFeeds: ["scheduler"] });
  assertEquals(withSnapshotAge({ dataState: "degraded", staleFeeds: ["aum"] }, 7200).staleFeeds, ["aum", "scheduler"]);
});

Deno.test("health: tokenInfo is stale when a tenth of HELD coins are past the limit, whatever the clock says", () => {
  const clock = { state: "current", staleAfterHours: 48 };
  assertEquals(tokenInfoFeed(clock, { held: 100, stale: 10, never_fetched: 50 }).state, "current"); // never-read coins are counted, not judged
  const behind = tokenInfoFeed(clock, { held: 100, stale: 11, never_fetched: 0 });
  assertEquals([behind.state, behind.heldCoinsStaleShare, behind.heldCoinsNeverRead], ["stale", 0.11, 0]);
  assertEquals(tokenInfoFeed(clock, { held: 0, stale: 0, never_fetched: 0 }).heldCoinsStaleShare, null); // nothing held is not 0% stale
  assertEquals(tokenInfoFeed({ state: "never" }, { held: 5, stale: 0, never_fetched: 5 }).state, "never");
});

Deno.test("health: a database that does not answer is a 503 that says so, at the probe deadline", async () => {
  const previous = getDefaultSql();
  const never = new Promise(() => {});
  const hung = Object.assign(() => ({ then: (r: unknown, j: unknown) => never.then(r as never, j as never) }), {
    unsafe: () => never, begin: () => never, end: () => Promise.resolve(),
  });
  setDefaultSql(hung as never);
  const original = console.error;
  console.error = () => undefined;
  try {
    const started = Date.now();
    const res = await health();
    const body = await res.json();
    assertEquals([res.status, body.error.code, body.error.database.answering], [503, "unavailable", false]);
    assertEquals(res.headers.get("retry-after"), "5");
    /* The rate limiter's own 2 s deadline runs first, then the probe's. */
    assert(Date.now() - started < PROBE_MS * 2 + 1500, "must answer at the deadlines, not hang");
  } finally {
    console.error = original;
    setDefaultSql(previous);
  }
});
