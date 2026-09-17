import { assert, assertEquals } from "jsr:@std/assert@1";
import { VOCABULARY } from "../supabase/functions/api/shared/vocabulary.ts";

/**
 * The allowed values of a `check (col in (...))` on `table` from the LAST migration that
 * defines it. Scoped to the table's create/alter statements: aum_history has its own `basis`.
 */
async function sqlAllowed(table: string, column: string): Promise<string[]> {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const files = [];
  for await (const e of Deno.readDir(dir)) if (e.name.endsWith(".sql")) files.push(e.name);
  files.sort();
  let found: string[] = [];
  const owns = new RegExp(`^\\s*(create|alter)\\s+table\\s+(if\\s+not\\s+exists\\s+)?${table}\\b`, "im");
  for (const name of files) {
    const sql = (await Deno.readTextFile(new URL(name, dir)))
      .replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, "")  // comments may hold a `;` that is not a statement end
      .split(";").filter((st) => owns.test(st)).join(";");
    const re = new RegExp(`${column}\\s+in\\s*\\(([^)]*)\\)`, "gi");
    for (const m of sql.matchAll(re)) found = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  assert(found.length, `no check constraint found for ${column}`);
  return found;
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

Deno.test("points[].refused and gaps[].reason publish the same words", () => {
  assertEquals([...VOCABULARY.fields["aum.points[].refused"]], [...VOCABULARY.fields["aum.gaps[].reason"]]);
});

Deno.test("every trade_loads.outcome the database can store is published", async () => {
  const published = new Set<string>(VOCABULARY.fields["scorecard.loadOutcome"]);
  for (const w of await sqlAllowed("trade_loads", "outcome")) assert(published.has(w), `unpublished: ${w}`);
});
