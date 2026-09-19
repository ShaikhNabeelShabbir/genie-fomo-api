import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { d1sql, type D1Like, type D1Outcome, type D1Statement } from "../worker/src/d1.ts";

/* Compile-only: a fake D1 that records `prepare(text).bind(params)` and answers with canned outcomes. */
type Recorded = { text: string; params: unknown[] };

const fake = (outcome: D1Outcome = { results: [], meta: { changes: 1 } }) => {
  const prepared: Recorded[] = [];
  const batches: Recorded[][] = [];
  const stmt = (rec: Recorded): D1Statement => ({
    bind: (...values) => { rec.params = values; return stmt(rec); },
    all: () => Promise.resolve(outcome),
  });
  const db: D1Like = {
    prepare: (text) => { const rec = { text, params: [] as unknown[] }; prepared.push(rec); return stmt(rec); },
    batch: (stmts) => { batches.push(stmts.map((_s, i) => prepared[prepared.length - stmts.length + i])); return Promise.resolve(stmts.map(() => outcome)); },
  };
  return { db, prepared, batches };
};

Deno.test("d1sql: scalars bind as ?, dates as ISO, booleans as 0/1, null stays null", async () => {
  const { db, prepared } = fake();
  const sql = d1sql(db);
  const at = new Date("2026-09-17T10:00:00Z");
  await sql`select * from t where at > ${at} and live = ${true} and gone = ${null} and n = ${7n}`;
  assertEquals(prepared[0].text, "select * from t where at > ? and live = ? and gone = ? and n = ?");
  assertEquals(prepared[0].params, ["2026-09-17T10:00:00.000Z", 1, null, 7]);
});

Deno.test("d1sql: an array after `in (` or `= any(` is ONE json_each parameter; elsewhere it is JSON too", async () => {
  const { db, prepared } = fake();
  const sql = d1sql(db);
  const handles = ["a", "b", "c"];
  await sql`select 1 where handle = any(${handles}) and k in (${[1, 2]}) and blob = ${["x"]}`;
  assertEquals(prepared[0].text,
    "select 1 where handle in (select value from json_each(?)) and k in (select value from json_each(?)) and blob = ?");
  assertEquals(prepared[0].params, ['["a","b","c"]', "[1,2]", '["x"]']);
  /* An empty list is valid SQL that matches nothing; `in ()` was a syntax error. */
  await sql`select 1 where handle in (${[]})`;
  assertEquals(prepared[1].text, "select 1 where handle in (select value from json_each(?))");
  assertEquals(prepared[1].params, ["[]"]);
});

Deno.test("d1sql: a page of 448 ids is one bind — the 19 Sep outage cannot recur", async () => {
  /* /traders?include=wallets with no limit bound 448 parameters; limit=100 bound 101 and 200. */
  const { db, prepared } = fake();
  const sql = d1sql(db);
  const ids = Array.from({ length: 448 }, (_v, i) => `h${i}`);
  await sql`select 1 from wallets where handle in (${ids}) and x in (${ids}) and net = ${1}`;
  assertEquals(prepared[0].params.length, 3);
});

Deno.test("d1sql: nested fragments splice text and params in order; empty fragment is nothing", async () => {
  const { db, prepared } = fake();
  const sql = d1sql(db);
  const net: number | null = 5;
  const clause = net === null ? sql`` : sql`and network_id = ${net}`;
  await sql`select * from t where a = ${1} ${clause} ${sql``} and b = ${2}`;
  assertEquals(prepared[0].text, "select * from t where a = ? and network_id = ?  and b = ?");
  assertEquals(prepared[0].params, [1, 5, 2]);
});

Deno.test("d1sql: sql(identifier) is a bare name; anything else is refused", async () => {
  const { db, prepared } = fake();
  const sql = d1sql(db);
  await sql`select * from ${sql("token_price_daily")} limit 1`;
  assertEquals(prepared[0].text, "select * from token_price_daily limit 1");
  assertThrows(() => sql("token_price_daily; drop table x"), Error, "not a bare identifier");
});

Deno.test("d1sql: unsafe binds the given params; end resolves; count comes from meta.changes", async () => {
  const { db, prepared } = fake({ results: [], meta: { changes: 3 } });
  const sql = d1sql(db);
  const r = await sql.unsafe("delete from t where k = ?", [true]);
  assertEquals(prepared[0].params, [1]);
  assertEquals(r.count, 3);
  assertEquals(await sql.end({ timeout: 5 }), undefined);
});

Deno.test("d1sql: the 100-parameter limit still guards multi-row writes, naming the statement", () => {
  const sql = d1sql(fake().db);
  const cells = Array.from({ length: 101 }, (_v, i) => i);
  const text = `insert into t (a) values ${cells.map(() => "(?)").join(",")}`;
  assertThrows(() => sql.unsafe(text, cells), Error, "binds 101 parameters, D1 allows 100");
});

Deno.test("d1sql: begin collects statements into one batch; an await is a batch boundary", async () => {
  const { db, batches } = fake({ results: [{ k: 1 }], meta: { changes: 1 } });
  const sql = d1sql(db);
  const out = await sql.begin(async (tx) => {
    tx`insert into a values (${1})`;
    tx`insert into b values (${2})`;
    const seen = await tx`insert into c values (${3}) returning k`;
    tx`delete from d where k in (${[4, 5]})`;
    return seen;
  });
  assertEquals(out, Object.assign([{ k: 1 }], { count: 1 }));
  assertEquals(batches.map((b) => b.map((s) => s.text)), [
    ["insert into a values (?)", "insert into b values (?)", "insert into c values (?) returning k"],
    ["delete from d where k in (select value from json_each(?))"],
  ]);
});

Deno.test("d1sql: a failed batch rejects begin even when nothing inside was awaited", async () => {
  const db: D1Like = { ...fake().db, batch: () => Promise.reject(new Error("D1_ERROR: boom")) };
  const sql = d1sql(db);
  await assertRejects(() => sql.begin((tx) => { tx`insert into a values (1)`; }), Error, "boom");
});
