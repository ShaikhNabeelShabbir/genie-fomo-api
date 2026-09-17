import { assert, assertEquals } from "jsr:@std/assert@1";

/**
 * worker/d1/migrations is the SQLite twin of the FINAL state of supabase/migrations. These
 * tests parse both sides: every Postgres table exists in D1, every `check (col in (...))` word
 * list is identical, and no Postgres-only syntax survived the translation.
 */

const ROOT = new URL("../", import.meta.url);
const PG_DIR = new URL("supabase/migrations/", ROOT);
const D1_SCHEMA = new URL("worker/d1/migrations/0001_schema.sql", ROOT);
const D1_VIEWS = new URL("worker/d1/migrations/0002_views.sql", ROOT);

const stripComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, "");

/** The Postgres migrations, in order, comments stripped and split on `;`. */
async function pgStatements(): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(PG_DIR)) if (e.name.endsWith(".sql")) names.push(e.name);
  names.sort();
  const out: string[] = [];
  for (const name of names) out.push(...stripComments(await Deno.readTextFile(new URL(name, PG_DIR))).split(";"));
  return out;
}

async function d1Statements(): Promise<string[]> {
  const sql = (await Deno.readTextFile(D1_SCHEMA)) + "\n" + (await Deno.readTextFile(D1_VIEWS));
  return stripComments(sql).split(";");
}

const TABLE_STATEMENT = /^\s*(create|alter)\s+table\s+(if\s+not\s+exists\s+)?(\w+)\b/i;
const DROP_TABLE = /^\s*drop\s+table\s+(if\s+exists\s+)?(\w+)\b/i;
const CREATE_TABLE = /^\s*create\s+table\s+(if\s+not\s+exists\s+)?(\w+)\b/i;
const WORD_CHECK = /(\w+)\s+in\s*\(\s*('[^)]*)\)/gi;

/** table -> column -> allowed words; later statements win, `drop table` forgets the table. */
function wordChecks(statements: string[]): Map<string, Map<string, string[]>> {
  const out = new Map<string, Map<string, string[]>>();
  for (const st of statements) {
    const dropped = st.match(DROP_TABLE);
    if (dropped) out.delete(dropped[2].toLowerCase());
    const owner = st.match(TABLE_STATEMENT);
    if (!owner) continue;
    const table = owner[3].toLowerCase();
    const cols = out.get(table) ?? new Map<string, string[]>();
    for (const m of st.matchAll(WORD_CHECK)) {
      cols.set(m[1].toLowerCase(), [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    }
    out.set(table, cols);
  }
  return out;
}

function createdTables(statements: string[]): Set<string> {
  const out = new Set<string>();
  for (const st of statements) {
    const m = st.match(CREATE_TABLE);
    if (m) out.add(m[2].toLowerCase());
  }
  return out;
}

Deno.test("every Postgres table is created in D1", async () => {
  const pg = createdTables(await pgStatements());
  const d1 = createdTables(await d1Statements());
  assert(pg.size >= 30, `expected the Postgres tables, saw ${pg.size}`);
  for (const t of pg) assert(d1.has(t), `missing in D1: ${t}`);
});

Deno.test("every check (col in (...)) word list matches Postgres exactly", async () => {
  const pg = wordChecks(await pgStatements());
  const d1 = wordChecks(await d1Statements());
  let seen = 0;
  for (const [table, cols] of pg) {
    for (const [col, words] of cols) {
      seen++;
      assertEquals(d1.get(table)?.get(col), words, `${table}.${col}`);
    }
  }
  assert(seen >= 10, `expected the vocabulary constraints, saw ${seen}`);
});

const POSTGRES_ONLY = [
  "::",
  "timestamptz",
  "numeric(",
  "filter (where",
  "distinct on",
  "lateral",
  "unnest",
  "array_agg",
  "interval '",
];

Deno.test("no Postgres-only syntax remains in the D1 files", async () => {
  const sql = (await d1Statements()).join(";").toLowerCase();
  for (const token of POSTGRES_ONLY) assert(!sql.includes(token), `found ${JSON.stringify(token)}`);
});
