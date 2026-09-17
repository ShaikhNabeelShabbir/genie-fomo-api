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
