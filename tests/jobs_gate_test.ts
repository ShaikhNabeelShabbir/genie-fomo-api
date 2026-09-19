import { assertEquals } from "jsr:@std/assert@1";

/*
 * The job table is looked up by a name from the URL. A plain object answers `constructor` with the
 * global Object function, and Object(env) returns env: POST /jobs/constructor handed every Worker
 * secret to a holder of JOB_SECRET (found by review on 19 Sep 2026, reproduced in workerd). index.ts
 * cannot be imported here (extension-less imports), so this pins the RULE the fix relies on and
 * reads the source for the line that applies it.
 */
Deno.test("a job name from the URL resolves only to the table's own entries", async () => {
  const table: Readonly<Record<string, () => string>> = { tokens: () => "ran" };
  const pick = (name: string) => (Object.hasOwn(table, name) ? table[name] : undefined);
  assertEquals(pick("tokens")?.(), "ran");
  for (const name of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty", ""]) assertEquals(pick(name), undefined, name);
  assertEquals(typeof table["constructor" as string], "function", "the unguarded lookup DOES find the inherited function: the guard is not optional");
  const source = await Deno.readTextFile(new URL("../worker/src/index.ts", import.meta.url));
  assertEquals(/const job = JOB_BY_NAME\[name\];/.test(source), false, "the unguarded lookup must not come back");
  assertEquals(source.includes("Object.hasOwn(JOB_BY_NAME, name)"), true);
});
