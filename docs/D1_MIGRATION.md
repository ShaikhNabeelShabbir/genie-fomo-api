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
