// Postgres CSV export -> Cloudflare D1. See docs/D1_MIGRATION.md "Import".
//
//   deno run -A scripts/csv_to_d1.ts <indir> <d1 name> [--local] [--only <table>] [--config <wrangler.toml>]
//
// <indir> holds <table>.csv + <table>.columns.json per table and manifest.json ({ table: rows }).
// SQL goes to <indir>/sql/<table>.<n>.sql; <file>.done marks an imported file, <table>.done a
// finished table, so a rerun resumes. Tables load foreign-key parents first (graph read from the
// migrations). Ends with a count per table against the manifest; exits 1 on any mismatch.

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { CsvParseStream } from "jsr:@std/csv@1";
import { type Column, convertRow, insertStatements } from "./lib/d1_rows.ts";

// wrangler reads the whole file as one JS string before uploading; V8 caps a string near 512 MB.
const MAX_FILE_BYTES = 10_000_000;  // 10 MB. Each file is one D1 transaction: 256 MB was refused
                                    // outright and 48 MB reset the database's Durable Object
                                    // ({"D1_RESET_DO":true}), because deferred FK checks all land
                                    // at the commit. 10 MB keeps a commit small and a retry cheap.
const ROWS_PER_STATEMENT_BATCH = 500;
const ROOT = new URL("..", import.meta.url);

const args = parseArgs(Deno.args, { boolean: ["local"], string: ["only", "config"] });
const [indir, dbName] = args._.map(String);
if (!indir || !dbName) {
  console.error("usage: csv_to_d1.ts <indir> <d1 name> [--local] [--only <table>] [--config <wrangler.toml>]");
  Deno.exit(2);
}
const config = args.config ?? new URL("worker/wrangler.toml", ROOT).pathname;
const target = args.local ? "--local" : "--remote";
const sqlDir = `${indir}/sql`;

// ---------------------------------------------------------------- FK order

const readFkParents = async (): Promise<Map<string, Set<string>>> => {
  const parents = new Map<string, Set<string>>();
  const dir = new URL("supabase/migrations/", ROOT);
  const names = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
  for (const name of names) {
    const sql = (await Deno.readTextFile(new URL(name, dir))).replace(/--.*$/gm, "");
    for (const statement of sql.split(";")) {
      const owner = /(?:create table(?: if not exists)?|alter table(?: if exists)?(?: only)?)\s+([a-z_]+)/i
        .exec(statement)?.[1];
      if (!owner) continue;
      for (const [, parent] of statement.matchAll(/references\s+([a-z_]+)/gi)) {
        if (parent !== owner) parents.set(owner, (parents.get(owner) ?? new Set()).add(parent));
      }
    }
  }
  return parents;
};

const parentsFirst = (tables: readonly string[], parents: Map<string, Set<string>>): string[] => {
  const pending = new Set(tables);
  const ordered: string[] = [];
  while (pending.size > 0) {
    const ready = [...pending].filter((t) => [...(parents.get(t) ?? [])].every((p) => !pending.has(p)));
    if (ready.length === 0) throw new Error(`foreign-key cycle among: ${[...pending].join(", ")}`);
    for (const t of ready.sort()) {
      ordered.push(t);
      pending.delete(t);
    }
  }
  return ordered;
};

// ---------------------------------------------------------------- SQL files

class SqlFiles {
  readonly paths: string[] = [];
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #written = 0;
  readonly #encoder = new TextEncoder();
  constructor(private readonly table: string) {}

  async write(statement: string): Promise<void> {
    const chunk = this.#encoder.encode(`${statement}\n`);
    if (this.#writer !== null && this.#written + chunk.length > MAX_FILE_BYTES) await this.close();
    if (this.#writer === null) {
      const path = `${sqlDir}/${this.table}.${this.paths.length}.sql`;
      this.paths.push(path);
      const file = await Deno.open(path, { write: true, create: true, truncate: true });
      this.#writer = file.writable.getWriter();
      this.#written = 0;
    }
    await this.#writer.write(chunk);
    this.#written += chunk.length;
  }

  async close(): Promise<void> {
    await this.#writer?.close();
    this.#writer = null;
  }
}

const exists = (path: string): boolean => {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Columns D1 computes for itself. SQLite refuses an insert into a generated column, and the
 * Postgres export carries their values like any other (`wallets.evm_address_key`, 17 Sep), so
 * both the name and the value are dropped before the statement is built.
 */
const generatedColumns = (table: string): Set<string> => {
  const schema = Deno.readTextFileSync(`${ROOT}/worker/d1/migrations/0001_schema.sql`);
  const body = new RegExp(`create table(?: if not exists)? ${table} \\(([\\s\\S]*?)\\n\\);`, "i").exec(schema);
  const out = new Set<string>();
  for (const line of body?.[1].split("\n") ?? []) {
    const m = /^\s*([a-z_]+)\s+[^,]*generated always as/i.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
};

const generate = async (table: string): Promise<string[]> => {
  const all: Column[] = JSON.parse(await Deno.readTextFile(`${indir}/${table}.columns.json`));
  const skip = generatedColumns(table);
  const keep = all.map((c, i) => ({ c, i })).filter(({ c }) => !skip.has(c.name));
  const columns = keep.map(({ c }) => c);
  const names = columns.map((c) => c.name);
  if (skip.size) console.log(`${table}: D1 generates ${[...skip].join(", ")}, not imported`);
  for (const entry of Deno.readDirSync(sqlDir)) {
    if (new RegExp(`^${table}\\.\\d+\\.sql$`).test(entry.name)) Deno.removeSync(`${sqlDir}/${entry.name}`);
  }
  const files = new SqlFiles(table);
  const records = (await Deno.open(`${indir}/${table}.csv`)).readable
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new CsvParseStream());
  let header: string[] | null = null;
  let batch: (string | null)[][] = [];
  let count = 0;
  const flush = async (): Promise<void> => {
    for (const statement of insertStatements(table, names, batch.map((r) => convertRow(keep.map(({ i }) => r[i]), columns)))) {
      await files.write(statement);
    }
    count += batch.length;
    batch = [];
  };
  for await (const record of records) {
    if (header === null) {
      header = record;
      if (header.join(",") !== all.map((c) => c.name).join(",")) {
        throw new Error(`${table}.csv header [${header}] differs from columns.json [${all.map((c) => c.name)}]`);
      }
      continue;
    }
    // ponytail: std/csv cannot tell "" from an empty unquoted field, so both land as NULL.
    batch.push(record.map((field) => (field === "" ? null : field)));
    if (batch.length >= ROWS_PER_STATEMENT_BATCH) await flush();
  }
  await flush();
  await files.close();
  console.log(`${table}: ${count} rows -> ${files.paths.length} file(s)`);
  return files.paths;
};

// ---------------------------------------------------------------- wrangler

const wrangler = async (...extra: string[]): Promise<string> => {
  const cmd = ["wrangler", "d1", "execute", dbName, target, "--config", config, ...extra];
  const { code, stdout, stderr } = await new Deno.Command("npx", {
    args: cmd,
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(stdout);
  if (code !== 0) throw new Error(`npx ${cmd.join(" ")} failed (${code}):\n${new TextDecoder().decode(stderr)}\n${out}`);
  return out;
};

const importTable = async (table: string): Promise<void> => {
  if (exists(`${sqlDir}/${table}.done`)) {
    console.log(`${table}: done, skipping`);
    return;
  }
  for (const path of await generate(table)) {
    if (exists(`${path}.done`)) continue;
    // A 52-file table meets the odd transient from the import endpoint; one failure must not
    // abandon the run, and every file is idempotent only in the sense that it is retried whole
    // (a failed file is rolled back by D1, as its own warning says).
    for (let attempt = 1; ; attempt++) {
      try { await wrangler("--yes", `--file=${path}`); break; } catch (e) {
        if (attempt >= 5) throw e;
        const wait = attempt * 15_000;
        console.log(`${path}: attempt ${attempt} failed, retrying in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    await Deno.writeTextFile(`${path}.done`, "");
    console.log(`  imported ${path}`);
  }
  await Deno.writeTextFile(`${sqlDir}/${table}.done`, "");
};

interface CountRow {
  readonly t: string;
  readonly n: number;
}

const verify = async (tables: readonly string[], manifest: Record<string, number>): Promise<boolean> => {
  const query = tables.map((t) => `select '${t}' as t, count(*) as n from "${t}"`).join(" union all ");
  const parsed: unknown = JSON.parse(await wrangler("--json", "--command", query));
  const results = (parsed as { results: CountRow[] }[])[0]?.results ?? [];
  const actual = new Map(results.map((r) => [r.t, r.n]));
  let ok = true;
  console.log(`\n${"table".padEnd(24)} ${"expected".padStart(10)} ${"actual".padStart(10)}`);
  for (const t of tables) {
    const got = actual.get(t);
    const match = got === manifest[t];
    ok &&= match;
    console.log(`${t.padEnd(24)} ${String(manifest[t]).padStart(10)} ${String(got ?? "?").padStart(10)} ${match ? "ok" : "MISMATCH"}`);
  }
  return ok;
};

// ---------------------------------------------------------------- main

const manifest: Record<string, number> = JSON.parse(await Deno.readTextFile(`${indir}/manifest.json`));
const tables = parentsFirst(Object.keys(manifest), await readFkParents())
  .filter((t) => args.only === undefined || t === args.only);
if (tables.length === 0) throw new Error(`no table to import (--only ${args.only}?)`);
Deno.mkdirSync(sqlDir, { recursive: true });
for (const table of tables) await importTable(table);
Deno.exit((await verify(tables, manifest)) ? 0 : 1);
