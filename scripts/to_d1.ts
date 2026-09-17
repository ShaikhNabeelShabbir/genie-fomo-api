// Switch the Worker from Postgres (Hyperdrive) to D1, mechanically.
//
//   deno run -A scripts/to_d1.ts [--check]
//
// Every module that talks to the database declares its own `type Sql = postgres.Sql` and imports
// the driver's types. The D1 shim (`worker/src/d1.ts`) exports a structurally compatible `Sql`,
// so the switch is: point each declaration at the shim, drop the driver import, and make
// `worker/src/db.ts` hand back `d1sql(env.DB)`. `--check` reports what would change and exits 1
// when anything is left, so CI can assert the cutover is complete.
const check = Deno.args.includes("--check");
const root = new URL("../", import.meta.url).pathname;

/** Files that talk to the database, with the relative path each needs for the shim. */
async function targets(): Promise<string[]> {
  const out: string[] = [];
  for (const dir of ["worker/src", "worker/src/jobs", "supabase/functions/api", "supabase/functions/api/routes", "supabase/functions/api/shared"]) {
    for await (const e of Deno.readDir(`${root}${dir}`)) {
      if (e.isFile && e.name.endsWith(".ts")) out.push(`${dir}/${e.name}`);
    }
  }
  return out.sort();
}

const shimPath = (file: string): string => {
  const depth = file.split("/").length - 1;
  const up = "../".repeat(depth - 1);
  return file.startsWith("worker/src") ? `${up}${"../".repeat(0)}d1`.replace("worker/src/", "") : `${up}../worker/src/d1`;
};

const DRIVER = /^import type postgres from "[^"]*postgres[^"]*";\n/m;
const DECL = /^type Sql = postgres\.Sql;$/m;
const TXN = /postgres\.TransactionSql/g;

let changed = 0, left = 0;
for (const file of await targets()) {
  const path = `${root}${file}`;
  const before = await Deno.readTextFile(path);
  if (!DECL.test(before)) continue;
  const rel = file.startsWith("worker/src/jobs/")
    ? "../d1"
    : file.startsWith("worker/src/")
    ? "./d1"
    : `${"../".repeat(file.split("/").length - 3)}../../worker/src/d1`;
  const after = before
    .replace(DRIVER, "")
    .replace(DECL, `import type { Sql } from "${rel}";`)
    .replace(TXN, "Sql");
  if (after === before) { left += 1; continue; }
  if (check) { console.log(`would rewrite ${file}`); left += 1; continue; }
  await Deno.writeTextFile(path, after);
  console.log(`rewrote ${file}`);
  changed += 1;
}

console.log(check ? `${left} file(s) still on the Postgres types` : `${changed} file(s) switched to the D1 shim`);
if (check && left > 0) Deno.exit(1);
