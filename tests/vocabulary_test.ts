import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse } from "jsr:@std/yaml@1";
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
  // THE schema since 17 Sep 2026. This read the frozen Postgres history, so a word D1 can store went unchecked.
  const dir = new URL("../worker/d1/migrations/", import.meta.url);
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

/*
 * THE SPEC AND THE WORD LIST ARE HELD TOGETHER (19 Sep 2026). The consumer's build fails — or shows
 * a blank — on a word /fields has not published, and we told them every enumerated value is there.
 * Seventeen documented response enums were not. Any string enum in a response schema whose property
 * is one a consumer renders or branches on must be made of published words.
 */
const RENDERED = /^(reason|state|basis|tier|verdict|status|kind|method|confidence|side|code|severity|presence|error|source|outcome|fallback|regime|launchpad)$|Reason$|State$|Method$|Tier$|Source$/;
/** Echoes of the request and constants naming the endpoint: not vocabulary. */
const NOT_VOCABULARY = new Set(["d1 · trades", "postgres", "cloudflare d1"]);

Deno.test("every rendered enum in the API reference is made of published words", async () => {
  const doc = parse(await Deno.readTextFile(new URL("../docs/openapi.yaml", import.meta.url))) as { components: { schemas: unknown } };
  const published = new Set(Object.values(VOCABULARY.fields).flat() as string[]);
  const missing: string[] = [];
  const walk = (node: unknown, path: string, key: string): void => {
    if (Array.isArray(node)) { node.forEach((v) => walk(v, path, key)); return; }
    if (typeof node !== "object" || node === null) return;
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.enum) && RENDERED.test(key)) {
      for (const w of n.enum) if (typeof w === "string" && !published.has(w) && !NOT_VOCABULARY.has(w)) missing.push(`${path}: ${w}`);
    }
    for (const [k, v] of Object.entries(n)) walk(v, `${path}/${k}`, k === "items" || k === "properties" || k === "allOf" || k === "oneOf" || k === "anyOf" ? key : k);
  };
  walk(doc.components.schemas, "schemas", "");
  assertEquals(missing, []);
});
