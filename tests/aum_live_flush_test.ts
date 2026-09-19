import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { DatabaseSync } from "node:sqlite";
import { openSchema } from "./_sqlite_harness.ts";
import { getDefaultSql } from "../supabase/functions/api/db.ts";
import { flushMarked, type Mark, markedQueue } from "../worker/src/jobs/aum_live_flush-core.ts";

const MARKED_AT = "2026-09-19T10:00:00.000Z";
const FAR = Date.now() + 60_000;

/** Traders with a wallet and a mark; `poison`'s valuation cannot be written, as when D1 kills his statement. */
function seed(db: DatabaseSync, handles: readonly string[]): Mark[] {
  db.exec(`create trigger poison before insert on aum_live when new.handle = 'poison'
           begin select raise(abort, 'D1 DB exceeded its CPU time limit and was reset'); end`);
  for (const h of handles) {
    db.prepare("insert into traders (handle, display_handle, id) values (?,?,?)").run(h, h, `id-${h}`);
    db.prepare("insert into wallets (handle, evm_address) values (?,?)").run(h, `0xW${h}`);
    db.prepare("insert into aum_live_dirty (handle, marked_at) values (?,?)").run(h, MARKED_AT);
  }
  return handles.map((handle) => ({ handle, marked_at: MARKED_AT }));
}

const column = (db: DatabaseSync, text: string): unknown[] =>
  (db.prepare(text).all() as { handle: string }[]).map((r) => r.handle);

/** Runs `body` with console.error captured: each of the flush's own lines is one refresh that threw (the shim logs the statement too). */
async function failures<T>(body: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = [];
  const real = console.error;
  console.error = (...a: unknown[]): void => { logged.push(a.join(" ")); };
  try {
    const result = await body();
    return { result, logged: logged.filter((l) => l.startsWith("aum_live_flush:")) };
  } finally {
    console.error = real;
  }
}

Deno.test("flushMarked: a slice that throws is retried one trader at a time, and the run moves on (load F1)", async () => {
  const db = await openSchema();
  const marked = seed(db, ["poison", "h1", "h2", "h3", "h4", "h5", "h6"]);
  /* h6 is marked again while the run is under way: the newer mark must survive the clearing. */
  db.prepare("update aum_live_dirty set marked_at = '2026-09-19T10:05:00.000Z' where handle = 'h6'").run();

  const { result, logged } = await failures(() => flushMarked(getDefaultSql()!, marked, FAR));
  assertEquals(result, { refreshed: 6, reached: 6, failed: 1 });
  assertEquals(column(db, "select handle from aum_live order by handle"), ["h1", "h2", "h3", "h4", "h5", "h6"]);
  assertEquals(column(db, "select handle from aum_live_dirty order by handle"), ["h6", "poison"]);
  /* He leads the slice and everyone else went through alone, so his statement is not run a second time. */
  assertEquals(logged.length, 1, logged.join("\n"));
});

Deno.test("flushMarked: a failing trader who does not lead his slice fails alone, and everyone else is still valued", async () => {
  const db = await openSchema();
  const marked = seed(db, ["h1", "poison", "h2"]);
  const { result, logged } = await failures(() => flushMarked(getDefaultSql()!, marked, FAR));
  assertEquals(result, { refreshed: 2, reached: 2, failed: 1 });
  assertEquals(column(db, "select handle from aum_live_dirty"), ["poison"]);
  assertEquals(logged.map((l) => l.split(" ")[1]), ["h1,poison,h2", "poison"]);
});

Deno.test("flushMarked: over many runs of the job's own queue, only the trader who fails is never valued", async () => {
  /* Kept whole, the failed slice re-formed at the head of every run: four runs left whale AND t0-t3 unvalued. */
  const db = await openSchema();
  const handles = ["poison", ...Array.from({ length: 12 }, (_, i) => `t${i}`)];
  seed(db, handles);
  const sql = getDefaultSql()!;
  for (let run = 0; run < 4; run++) {
    /* A busy wallet is marked again on every push, so everyone is back in the queue each run. */
    for (const h of handles) db.prepare("insert or replace into aum_live_dirty (handle, marked_at) values (?,?)").run(h, MARKED_AT);
    const { result } = await failures(async () => flushMarked(sql, await markedQueue(sql), FAR));
    assertEquals(result, { refreshed: 12, reached: 12, failed: 1 });
  }
  assertEquals(column(db, "select t.handle from traders t where not exists (select 1 from aum_live l where l.handle = t.handle)"), ["poison"]);
});

Deno.test("flushMarked: nobody revalued is a failed run, and a spent deadline reaches nobody", async () => {
  const db = await openSchema();
  const marked = seed(db, ["poison"]);
  const { logged } = await failures(() =>
    assertRejects(() => flushMarked(getDefaultSql()!, marked, FAR), Error, "1 slices failed and no trader was revalued"));
  assertEquals(logged.length, 1, "a slice of one is not run twice");
  assertEquals(await flushMarked(getDefaultSql()!, marked, Date.now() - 1), { refreshed: 0, reached: 0, failed: 0 });
});
