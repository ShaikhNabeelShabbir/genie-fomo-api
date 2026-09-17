import { assert, assertEquals } from "jsr:@std/assert@1";
import { VOCABULARY } from "../supabase/functions/api/shared/vocabulary.ts";

/**
 * The allowed values of a `check (col in (...))` on `table` from the LAST migration that
 * defines it. Scoped to the table's create/alter statements: aum_history has its own `basis`.
 */
async function sqlAllowed(table: string, column: string): Promise<string[]> {
  let found: string[] = [];
  const re = new RegExp(`${column}\\s+in\\s*\\(([^)]*)\\)`, "gi");
  for (const sql of await tableStatements(table)) {
    for (const m of sql.matchAll(re)) found = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  assert(found.length, `no check constraint found for ${column}`);
  return found;
}

/** The create/alter statements for `table`, one string per migration file, in order; comments stripped. */
async function tableStatements(table: string): Promise<string[]> {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const files = [];
  for await (const e of Deno.readDir(dir)) if (e.name.endsWith(".sql")) files.push(e.name);
  files.sort();
  const owns = new RegExp(`^\\s*(create|alter)\\s+table\\s+(if\\s+not\\s+exists\\s+)?${table}\\b`, "im");
  const out: string[] = [];
  for (const name of files) {
    const sql = (await Deno.readTextFile(new URL(name, dir)))
      .replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, "")  // comments may hold a `;` that is not a statement end
      .split(";").filter((st) => owns.test(st)).join(";");
    if (sql) out.push(sql);
  }
  return out;
}

Deno.test("every refused_reason the database can store is published", async () => {
  const published = new Set<string>(VOCABULARY.fields["aum.points[].refused"]);
  for (const w of await sqlAllowed("aum_samples", "refused_reason")) assert(published.has(w), `unpublished: ${w}`);
});

/** Every `check (col in (...))` across the migrations, one list per constraint. */

Deno.test("basis and tier match their check constraints exactly", async () => {
  assertEquals([...VOCABULARY.fields["aum.points[].basis"]].sort(), (await sqlAllowed("aum_samples", "basis")).sort());
  assertEquals([...VOCABULARY.fields["aum.points[].tier"]].sort(), (await sqlAllowed("aum_samples", "tier")).sort());
  assertEquals([...VOCABULARY.fields["aumHistory.points[].basis"]].sort(), (await sqlAllowed("aum_history", "basis")).sort());
});

Deno.test("every aum_history reason the database can store is published", async () => {
  const published = new Set<string>(VOCABULARY.fields["aumHistory.points[].reason"]);
  for (const w of await sqlAllowed("aum_history", "reason")) assert(published.has(w), `unpublished: ${w}`);
});

/*
 * `aum_live` is built by a sibling change; until its migration lands there is no constraint to
 * read, so these show as ignored (never as silently green) rather than failing on a table
 * this branch does not define.
 */
const AUM_LIVE_DEFINED = (await tableStatements("aum_live")).length > 0;

Deno.test({
  name: "every aum_live reason the database can store is published",
  ignore: !AUM_LIVE_DEFINED,
  async fn() {
    const published = new Set<string>(VOCABULARY.fields["aumHistory.now.reason"]);
    for (const w of await sqlAllowed("aum_live", "reason")) assert(published.has(w), `unpublished: ${w}`);
  },
});

Deno.test({
  name: "aum_live source matches its check constraint exactly",
  ignore: !AUM_LIVE_DEFINED,
  async fn() {
    assertEquals([...VOCABULARY.fields["aumHistory.now.source"]].sort(), (await sqlAllowed("aum_live", "source")).sort());
  },
});

/*
 * The live figure and a history point are refused for the same reasons, with one exception the
 * route owns: `not_built` is an hour inside the window that the builder never wrote (A3), and
 * `now` is one figure with no hours to have holes in. So the live words are a SUBSET, not a
 * copy: anything a point can say about a figure, `now` may say too.
 */
Deno.test("every aumHistory.now.reason is also a points[].reason", () => {
  const points = new Set<string>(VOCABULARY.fields["aumHistory.points[].reason"]);
  for (const w of VOCABULARY.fields["aumHistory.now.reason"]) {
    assert(points.has(w), `published on now but not on a point: ${w}`);
  }
  assertEquals(
    VOCABULARY.fields["aumHistory.points[].reason"].filter((w) =>
      !(VOCABULARY.fields["aumHistory.now.reason"] as readonly string[]).includes(w)),
    ["not_built"],
  );
});

Deno.test("points[].refused and gaps[].reason publish the same words", () => {
  assertEquals([...VOCABULARY.fields["aum.points[].refused"]], [...VOCABULARY.fields["aum.gaps[].reason"]]);
});

Deno.test("every trade_loads.outcome the database can store is published", async () => {
  const published = new Set<string>(VOCABULARY.fields["scorecard.loadOutcome"]);
  for (const w of await sqlAllowed("trade_loads", "outcome")) assert(published.has(w), `unpublished: ${w}`);
});
