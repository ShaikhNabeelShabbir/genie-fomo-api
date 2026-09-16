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

Deno.test("basis and tier match their check constraints exactly", async () => {
  assertEquals([...VOCABULARY.fields["aum.points[].basis"]].sort(), (await sqlAllowed("basis")).sort());
  assertEquals([...VOCABULARY.fields["aum.points[].tier"]].sort(), (await sqlAllowed("tier")).sort());
});

Deno.test("points[].refused and gaps[].reason publish the same words", () => {
  assertEquals([...VOCABULARY.fields["aum.points[].refused"]], [...VOCABULARY.fields["aum.gaps[].reason"]]);
});
