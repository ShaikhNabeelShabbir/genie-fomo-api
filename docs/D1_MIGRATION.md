# D1 migration

Decision (17 Sep 2026): the database moves from Postgres on Supabase to Cloudflare D1 (SQLite),
permanently. Routes and jobs keep their call shape; rewritten SQL text is the only change.

## The `sql` shim

`worker/src/d1.ts` — `d1sql(env.DB)` returns a postgres.js-shaped `Sql`. Wiring:
`runWith({ sql: d1sql(env.DB), env }, () => handle(req))` in `worker/src/api.ts`; a job does
`const sql = d1sql(env.DB)`. One-line type change in `supabase/functions/api/db.ts`:
`type Sql = postgres.Sql;` → `import type { Sql } from "../../../worker/src/d1.ts";` (then the
`postgres` import goes). `D1Database` satisfies the shim's structural `D1Like`, so Deno tests
import it without workers-types.

### Call shapes

| Call | Behaviour |
|---|---|
| `` sql`text ${p} …` `` | `prepare(text).bind(...params).all()` → `results`, lazy until awaited; `.count` = rows returned, or `meta.changes` for a write |
| `${arr}` after `in (` or `= any(` | expands to `(?, ?, ?)`; `= any(` is rewritten to ` in (` so either spelling works; `[]` → `in ()` (valid SQLite, always false) |
| `${fragment}` where `fragment = sql\`…\`` | text and params splice in place; `` sql`` `` is the empty clause |
| `sql("name")` | bare identifier, `[a-z_][a-z0-9_]*` only, else throws |
| `sql.unsafe(text, params?)` | as given, params converted, no expansion |
| `sql.begin(fn)` | see below |
| `sql.end()` | no-op |

### Parameter conversion

`Date` → ISO-8601 UTC (`2026-09-17T10:00:00.000Z`, the same shape `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
produces, so text comparison orders correctly); `boolean` → 0/1; `null`/`undefined` → null;
`bigint` → number when safe, else decimal string; any other object or array (not an IN list) → JSON text.
More than 100 bound parameters throws naming the statement: chunk ids (batch routes already cap at 50).

### `begin` is `db.batch`

D1 has no interactive transaction. Inside `begin(fn)` every statement is queued as issued and the
queue runs as ONE `db.batch` (atomic) at the next `await` inside `fn`, or when `fn` returns. So:

- statements issued between two awaits are atomic together; each `await` is a batch boundary;
- `const r = await tx\`insert … returning …\`` gives real rows and `r.count`;
- a read inside `fn` sees the state after the previous flush, not statements queued after it;
- a batch that fails rejects the awaited statement and `begin` itself, even for statements nobody awaited.

`set local statement_timeout` has no SQLite equivalent: delete those lines.

### SQLite dialect cheatsheet (rewrite the text)

| Postgres | SQLite |
|---|---|
| `now()` | `strftime('%Y-%m-%dT%H:%M:%fZ','now')` |
| `t > now() - interval '72 hours'` | `t > strftime('%Y-%m-%dT%H:%M:%fZ','now','-72 hours')`; on a column: `datetime(x, '-72 hours')` |
| `date_trunc('hour', t)` | `strftime('%Y-%m-%dT%H:00:00.000Z', t)` |
| `extract(epoch from a - b)` / interval math | `(julianday(a) - julianday(b)) * 86400` |
| `count(*) filter (where c)` | `sum(case when c then 1 else 0 end)` |
| `distinct on (k) … order by k, x desc` | `row_number() over (partition by k order by x desc) = 1` in a subquery |
| `lateral` | correlated subquery or join |
| `unnest(${arr})` | `json_each(${arr})` (the array binds as JSON text; `value` is the column) |
| `array_agg(x)` | `json_group_array(x)` |
| `x::numeric`, `x::int` | `cast(x as real)`, `cast(x as integer)` |
| `greatest(a, b)` / `least(a, b)` | `max(a, b)` / `min(a, b)` (scalar form) |
| `coalesce`, `nullif` | unchanged |
| `on conflict (k) do update set c = excluded.c` | unchanged |
| `returning` | unchanged |
| `true` / `false` | `1` / `0` |
| `numeric` columns | REAL: ~15 significant digits; token amounts above 2^53 raw units lose precision, store them scaled or as text |
| `${x}::timestamptz`, `${arr}::text[]` | drop the cast; times are ISO text, arrays expand or bind as JSON |
# Postgres -> D1 migration

## Import

Loads the Postgres CSV export (one `<table>.csv` + `<table>.columns.json` per table, plus
`manifest.json` = `{ "<table>": <row count> }`, produced by `copy … to stdout with (format csv, header)`)
into the D1 database. Code: `scripts/csv_to_d1.ts` (streaming, resumable) over the pure
`scripts/lib/d1_rows.ts` (type map, SQL literals, statement chunking; `tests/d1_rows_test.ts`).

Method follows Cloudflare's guide, <https://developers.cloudflare.com/d1/best-practices/import-export-data/>:
a multi-statement SQL file of literal-value inserts, uploaded with
`wrangler d1 execute <db> --remote --file=<sql>`. Per <https://developers.cloudflare.com/d1/platform/limits/>
a statement is capped at 100 KB (we chunk at 90 KB) and an imported file at 5 GB; we cut files at
256 MB because wrangler reads the whole file into one JS string. The guide says import files must
carry no `BEGIN`/`COMMIT`, so each file is plain inserts, one statement per line.

### Order

1. Schema first: `cd worker && npx wrangler d1 migrations apply genie-copy-trading --remote`.
   `worker/wrangler.toml` needs the `[[d1_databases]]` block (binding `DB`, database
   `genie-copy-trading`, id `fa5a33dc-ed4d-48a9-8a91-ae76be85456d`), or pass `--config`.
2. Data:

   ```bash
   deno run -A scripts/csv_to_d1.ts <indir> genie-copy-trading            # remote
   deno run -A scripts/csv_to_d1.ts <indir> genie-copy-trading --local    # wrangler's local sqlite
   deno run -A scripts/csv_to_d1.ts <indir> genie-copy-trading --only traders --config path/to/wrangler.toml
   ```

   Tables load foreign-key parents first (`chains`, `traders`, `tokens`, `aum_samples` before their
   children); the graph is read from `references` in `supabase/migrations/*.sql`. Each table is
   streamed into `<indir>/sql/<table>.<n>.sql` and each file is imported in turn.

### Type map

| Postgres | D1 | CSV -> literal |
|---|---|---|
| `timestamp with time zone` | TEXT | `2026-09-17 04:25:11.123+00`, `…+05:30`, with or without fraction -> `2026-09-17T04:25:11.123Z` (UTC, ms) |
| `date` | TEXT | `YYYY-MM-DD` unchanged |
| `numeric`, `double precision`, `real` | REAL | number text as-is; `NaN`/`Infinity` refused |
| `bigint`, `integer` | INTEGER | as-is; refused above 2^53 (precision) |
| `boolean` | INTEGER | `t`/`f` -> `1`/`0` |
| `jsonb`, `json`, `uuid`, `text` | TEXT | unchanged, `'` doubled |
| `ARRAY` / `text[]` | TEXT | `{a,"b c",NULL}` -> `["a","b c",null]` |
| NULL | NULL | empty CSV field |

Known limit: the CSV parser cannot tell `""` (empty string) from an empty field, so both import as
NULL. A NOT NULL column fails loudly; a nullable text column loses the distinction.

### Resume

Every imported file gets `<file>.done`, every finished table `<table>.done` (both under
`<indir>/sql/`). Rerunning the same command skips done tables, regenerates the SQL of an unfinished
one (deterministic, so the files match those already imported) and continues from its first file
without a marker. To redo a table: delete its rows in D1, delete `sql/<table>.*`, rerun.
A failed `wrangler` call stops the run with wrangler's stderr; nothing is retried automatically.

### Verification

The run ends with one `select count(*)` per table (`--json`, a single `union all` query) against
`manifest.json` and exits 1 on any mismatch:

```
table                      expected     actual
chains                            3          3 ok
traders                           3          3 ok
```

`--only <table>` verifies that table alone.
