import { assert, assertEquals } from "jsr:@std/assert@1";
import { VOCABULARY } from "../supabase/functions/api/shared/vocabulary.ts";

/** The allowed values of a `check (col in (...))` from the LAST migration that defines it. */
async function sqlAllowed(column: string): Promise<string[]> {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const files = [];
  for await (const e of Deno.readDir(dir)) if (e.name.endsWith(".sql")) files.push(e.name);
  files.sort();
  let found: string[] = [];
  for (const name of files) {
    const sql = await Deno.readTextFile(new URL(name, dir));
    const re = new RegExp(`${column}\\s+in\\s*\\(([^)]*)\\)`, "gi");
    for (const m of sql.matchAll(re)) found = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  assert(found.length, `no check constraint found for ${column}`);
  return found;
}

Deno.test("every refused_reason the database can store is published", async () => {
  const published = new Set<string>(VOCABULARY.fields["aum.points[].refused"]);
  for (const w of await sqlAllowed("refused_reason")) assert(published.has(w), `unpublished: ${w}`);
});

/** Every `check (col in (...))` across the migrations, one list per constraint. */
async function sqlAllowedEach(column: string): Promise<string[][]> {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const found: string[][] = [];
  for await (const e of Deno.readDir(dir)) {
    if (!e.name.endsWith(".sql")) continue;
    const sql = await Deno.readTextFile(new URL(e.name, dir));
    /* Whole column name only: `reason` must not match `refused_reason`. */
    const re = new RegExp(`(?<![a-z_])${column}\\s+in\\s*\\(([^)]*)\\)`, "gi");
    for (const m of sql.matchAll(re)) found.push([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  }
  return found;
}

Deno.test("basis and tier match their check constraints exactly", async () => {
  /* `basis` is constrained on aum_samples (sampled/rebuilt) and on aum_history (reading/priced). */
  const published = [VOCABULARY.fields["aum.points[].basis"], VOCABULARY.fields["aumHistory.points[].basis"]]
    .map((w) => [...w].sort().join(","));
  for (const allowed of await sqlAllowedEach("basis")) assert(published.includes(allowed.sort().join(",")), `unpublished basis set: ${allowed}`);
  assertEquals([...VOCABULARY.fields["aum.points[].tier"]].sort(), (await sqlAllowed("tier")).sort());
});

Deno.test("every aum_history reason the database can store is published", async () => {
  const published = new Set<string>(VOCABULARY.fields["aumHistory.points[].reason"]);
  for (const allowed of await sqlAllowedEach("reason")) for (const w of allowed) assert(published.has(w), `unpublished: ${w}`);
});

Deno.test("points[].refused and gaps[].reason publish the same words", () => {
  assertEquals([...VOCABULARY.fields["aum.points[].refused"]], [...VOCABULARY.fields["aum.gaps[].reason"]]);
});

Deno.test("every trade_loads.outcome the database can store is published", async () => {
  const published = new Set<string>(VOCABULARY.fields["scorecard.loadOutcome"]);
  for (const w of await sqlAllowed("outcome")) assert(published.has(w), `unpublished: ${w}`);
});
