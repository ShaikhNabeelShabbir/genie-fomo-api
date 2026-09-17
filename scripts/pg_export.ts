// Export every public table of the Postgres database to CSV for the D1 import.
//
//   deno run -A scripts/pg_export.ts <postgres url> <outdir>
//
// One table at a time, streamed with `copy … to stdout (format csv, header)`, never buffered;
// writes <outdir>/<table>.csv, <outdir>/<table>.columns.json ([{ name, type }]) and, at the end,
// <outdir>/manifest.json ({ table: rowCount }). Resumable: a table whose csv already exists with
// the manifest's count is skipped. `statement_timeout` is lifted on this session only, because
// `transactions` (~1.7 GB) takes minutes. Read-only: it never writes to the database.
import postgres from "npm:postgres@3.4.9";

interface Column { readonly name: string; readonly type: string }

const [url, outdir] = Deno.args;
if (!url || !outdir) { console.error("usage: pg_export.ts <postgres url> <outdir>"); Deno.exit(2); }
await Deno.mkdir(outdir, { recursive: true });

const sql = postgres(url, { ssl: "require", max: 1, prepare: false, connect_timeout: 60 });
const manifestPath = `${outdir}/manifest.json`;
const manifest: Record<string, number> = await Deno.readTextFile(manifestPath).then(JSON.parse).catch(() => ({}));

try {
  await sql.unsafe("set statement_timeout = 0");
  const tables = (await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`).map((r) => r.table_name);
  console.log(`${tables.length} tables`);
  for (const t of tables) {
    const [{ n }] = await sql<{ n: string }[]>`select count(*)::text as n from ${sql(t)}`;
    const count = Number(n);
    const csv = `${outdir}/${t}.csv`;
    const done = manifest[t] === count && await Deno.stat(csv).then(() => true).catch(() => false);
    if (done) { console.log(`skip ${t} (${count} rows, already exported)`); continue; }
    const columns: Column[] = (await sql<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
       where table_schema = 'public' and table_name = ${t} order by ordinal_position`)
      .map((r) => ({ name: r.column_name, type: r.data_type }));
    await Deno.writeTextFile(`${outdir}/${t}.columns.json`, JSON.stringify(columns, null, 2));
    const started = Date.now();
    const file = await Deno.open(csv, { write: true, create: true, truncate: true });
    const readable = await sql`copy (select * from ${sql(t)}) to stdout with (format csv, header)`.readable();
    let bytes = 0;
    for await (const chunk of readable) { bytes += chunk.length; await file.write(chunk); }
    file.close();
    manifest[t] = count;
    await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`${t}: ${count} rows, ${(bytes / 1e6).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
  console.log("manifest written:", manifestPath);
} finally {
  await sql.end({ timeout: 5 });
}
