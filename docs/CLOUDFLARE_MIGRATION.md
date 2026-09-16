# Migrating genie-fomo from Supabase to Cloudflare

> **Line references in this document predate the 17 Sep 2026 split of `routes.ts` into `supabase/functions/api/routes/*.ts` and `shared/*.ts`.** Use `CLAUDE.md` for the route-to-file map; the long comments cited here now live in `docs/DECISIONS.md`.

A complete plan for rebuilding this service on Cloudflare — Workers instead of Supabase Edge
Functions, Cron Triggers instead of `pg_cron`, Workers Secrets instead of Vault, and a decision
to make about the database.

Written 16 September 2026, measured against the running system. Every number here came from the
live database or the deployed code, not from memory.

Revised the same day after a second pass: the code counts in §1 and §5 were re-measured against
the tree, and every Cloudflare limit was re-checked against developers.cloudflare.com. The
driver guidance in §4.3 and the subrequest numbers in §7 changed as a result, and §2 gained a
cheaper first step (Option A′) that the first draft did not consider.

> **Verify the platform limits before you start.** Cloudflare's quotas (subrequests, CPU time,
> D1 size) change. Everything in this document about *our* system is measured; everything about
> *their* limits is as of writing and should be re-checked against current docs.

---

## Contents

1. [What exists today](#1-what-exists-today)
2. [The one decision that shapes everything](#2-the-one-decision-that-shapes-everything)
3. [Service-by-service mapping](#3-service-by-service-mapping)
4. [The database](#4-the-database)
5. [Rewriting the runtime: Deno → Workers](#5-rewriting-the-runtime-deno--workers)
6. [If you choose D1: the SQL rewrite](#6-if-you-choose-d1-the-sql-rewrite)
7. [Scheduling](#7-scheduling)
8. [Secrets](#8-secrets)
9. [The webhook](#9-the-webhook)
10. [The loaders](#10-the-loaders)
11. [Project layout and wrangler config](#11-project-layout-and-wrangler-config)
12. [Proving it works](#12-proving-it-works)
13. [Cutover and rollback](#13-cutover-and-rollback)
14. [Cost](#14-cost)
15. [A phased plan](#15-a-phased-plan)
16. [What will bite you](#16-what-will-bite-you)

---

## 1. What exists today

Measured 16 September 2026.

### Code

| Component | Lines | Runtime |
|---|---|---|
| `supabase/functions/api/routes.ts` | 7,827 | Deno |
| `supabase/functions/api/index.ts` | 189 | Deno |
| `supabase/functions/api/errors.ts` | 160 | Deno |
| `supabase/functions/api/router.ts` | 58 | Deno |
| `supabase/functions/aum-sample/index.ts` | 486 | Deno |
| `supabase/functions/helius-webhook/index.ts` | 155 | Deno |
| `supabase/functions/_shared/chain_reads.ts` | 192 | Deno |
| `supabase/functions/api/db.ts` | 63 | Deno |
| **Total** | **9,130** | |

Plus ~20 Node loader scripts in `scripts/` and 3 Python loaders, which run in GitHub Actions and
are **not affected by this migration** — they talk to Postgres over a normal connection and can
keep doing so.

Not in the table, and not part of this migration: the Express app under `src/` (5,498 lines).
It has not served production since the Edge Functions went live, and survives only because three
loaders import from its compiled `dist/` output. Whether to retire it is a separate decision.

### Database

```
whole database          2,002 MB
  transactions          1,719 MB   ~1,237,859 rows
  holdings                 80 MB   ~192,490 rows
  token_info               48 MB   ~13,450 rows
  trades                   39 MB   ~75,689 rows
  transaction_fees         35 MB   ~105,439 rows
  position_timing          19 MB   ~63,018 rows
  wallet_swaps             17 MB   ~25,900 rows
  tokens                   15 MB   ~50,465 rows
```

### Postgres features the code relies on

Counted in `routes.ts`:

| Feature | Uses | SQLite/D1 equivalent |
|---|---|---|
| `= any($1)` with an array parameter | **40** | none — needs `IN (?,?,…)` with dynamic placeholders |
| `filter (where …)` on aggregates | **59** | supported in modern SQLite |
| `coalesce(…)` | 42 | supported |
| `at time zone` | 5 | none — SQLite has no timezone type |
| `::bigint`, `::text[]` casts | 6 | different syntax; arrays have none |
| `lateral` joins | 3 | rewrite as correlated subqueries |
| `to_char(date, 'YYYY-MM')` | 2 | `strftime('%Y-%m', …)` |
| `interval '36 hours'` | 2 | `datetime('now','-36 hours')` |
| `distinct on (…)` | 1 | rewrite with a window function |
| `unnest(…)` | 1 | none |
| `on conflict … do update` | 1 | supported (UPSERT) |

### Extensions in use

`pg_cron` · `pg_net` · `supabase_vault` · `pgcrypto` · `uuid-ossp` · `pg_stat_statements` ·
`plpgsql`

**None of these exist on D1.** Each needs a Cloudflare replacement, listed in §3.

### Scheduled work

| | |
|---|---|
| `pg_cron` job `aum-sample-rotate` | `*/5 * * * *` → posts 10 traders to the sampler |
| GitHub Actions `refresh.yml` | `0 6 * * *` → the nightly loader chain |

---

## 2. The one decision that shapes everything

**Do you keep Postgres, or move to D1?**

Everything else in this migration is mechanical. This is not.

### Option A′ — Workers + Hyperdrive + the Postgres you already have  ✅ recommended first step

Keep the database exactly where it is, on Supabase. Stop deploying Edge Functions and drop the
`pg_cron` job; point Cloudflare **Hyperdrive** at Supabase's *direct* Postgres connection and
run the three functions as Workers. Cloudflare documents this combination specifically
(<https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/>).

**What changes:** the runtime only. No dump, no restore, no second database. Both the old
functions and the new Workers read and write the same rows throughout the cutover, so rollback
is "stop using the Worker" at every phase, and the acceptance diff is exact.

**What you give up:** Supabase still hosts storage, and you keep paying for it. If cost is the
motive, moving the host is a separate, later step (Option A below).

**One thing to test before anything else:** Supabase's direct host is IPv6-only unless the
project has the IPv4 add-on (see §4.2). `wrangler hyperdrive create` against it is the first
command of this migration, because its result decides whether the add-on is needed.

**Effort:** about a week for the port, plus the acceptance harness (§12).

### Option A — Workers + Hyperdrive + external Postgres

Same as A′, then move the database to another Postgres host (Neon, Crunchy, RDS, self-hosted).

**What changes:** the runtime, and one `DATABASE_URL` in the loaders. Every SQL query and every
migration keeps working unchanged.

**What it adds:** the dump/restore in §4.1, the data gap between dump and cutover (the webhook
writes ~290,000 rows a week into whichever database it is pointed at), and a new hosting bill.

**Effort:** A′ plus a day of transfer and a cutover window.

### Option B — Workers + D1

Move the data into D1, Cloudflare's SQLite.

**What changes:** the runtime *and* every query that uses a Postgres feature. That is at minimum
the 40 `= any()` calls, 3 lateral joins, the `distinct on`, the `unnest`, both `to_char` calls,
all 5 `at time zone` uses, and both `interval` expressions — spread across a 7,827-line file
where the SQL is inline template literals, not a separate layer.

**It also removes things the system depends on:**

- `pg_cron` and `pg_net` — replaced by Cron Triggers, which is fine and arguably better
- `supabase_vault` — replaced by Workers Secrets, fine
- `gen_random_uuid()` from pgcrypto — must be generated in JS
- **no `numeric` type.** SQLite has INTEGER, REAL and TEXT. Financial figures currently stored
  as `numeric` would become REAL (a float) or TEXT. This is the one that should worry you: the
  codebase goes to deliberate lengths to avoid float rounding — `fee_native` is stored exact and
  scaled as a decimal string precisely so nothing rounds through a float.

**Size:** 2,002 MB against D1's 10 GB per-database limit — it fits today, with `transactions` at
1,719 MB of it and growing. Worth checking the current limit and the growth rate before
committing.

**Effort:** four to eight weeks, and the acceptance suite is the only thing that will tell you
whether the rewrite preserved behaviour.

### Recommendation

**Take Option A′, then decide about A.** It gets you off Supabase's compute immediately with
nothing irreversible, and lets you evaluate moving the host, or D1, separately, with the API
already running on Workers and the full acceptance suite available to prove any later change.

Option B is a rewrite wearing a migration's clothes. Doing both at once means that when
something returns a wrong number you will not know whether it was the runtime or the SQL.

The rest of this document assumes **Option A′**. §4.1 covers the extra work if you later take
Option A, and §6 covers Option B.

---

## 3. Service-by-service mapping

| Today | On Cloudflare | Notes |
|---|---|---|
| Supabase Edge Function `api` | **one Worker** `genie-fomo`, `fetch` on `/v1/*` | §5, §11 |
| Supabase Edge Function `aum-sample` | the same Worker: `scheduled` handler plus `fetch` on `/sample` | §5, §7 |
| Supabase Edge Function `helius-webhook` | the same Worker: `fetch` on `/webhook` | §9 |
| Supabase Postgres | **unchanged**, reached through Hyperdrive (A′); external host later if wanted (A) | §4 |
| Supabase connection pooler (6543) | **Hyperdrive**, pointed at the direct port | §4 |
| `pg_cron` + `pg_net` | **Cron Triggers** (`scheduled` handler) | §7 |
| `supabase_vault` | **Workers Secrets** | §8 |
| `gen_random_uuid()` | `crypto.randomUUID()` in JS | |
| Supabase function URL | Worker route or `*.workers.dev` | §11 |
| `npx supabase functions deploy` | `npx wrangler deploy` | §11 |
| GitHub Actions loaders | **unchanged** | §10 |

---

## 4. The database

### 4.1 Moving Postgres off Supabase (Option A only — not part of the first cutover)

```bash
# 1. dump — schema and data separately, so a schema problem is visible before the data moves
pg_dump --no-owner --no-acl --schema-only "$SUPABASE_DB_URL" > schema.sql
pg_dump --no-owner --no-acl --data-only  "$SUPABASE_DB_URL" > data.sql

# 2. strip the Supabase-specific bits — these will not exist on a plain Postgres
#    supabase_vault, the cron.* schema, and any `supabase_admin` grants
grep -vE 'supabase_vault|cron\.|supabase_admin' schema.sql > schema.clean.sql

# 3. restore
psql "$NEW_DB_URL" -f schema.clean.sql
psql "$NEW_DB_URL" -f data.sql

# 4. verify row counts match — do not skip this
psql "$NEW_DB_URL" -c "
  select 'traders' t, count(*) from traders
  union all select 'trades', count(*) from trades
  union all select 'transactions', count(*) from transactions
  union all select 'holdings_current', count(*) from holdings_current
  union all select 'aum_samples', count(*) from aum_samples"
```

Expected, as of writing: 446 traders (450 rows including delisted), 75,689 trades, ~1,237,859
transactions, 46,205 holdings_current, ~14,000 aum_samples.

The 1.7 GB `transactions` table dominates the transfer. Budget an hour and do it during a window
where the nightly loader is not running.

**The copy is stale the moment it finishes.** The Helius webhook writes ~290,000 rows a week and
the sampler writes every five minutes, all into whichever database they are pointed at. The
first draft of this document said the two databases "diverge" only when the writers move; in
fact the new database is behind from the dump onward. Either move the writers in the same
window as the restore, or plan a second, incremental copy of `transactions`, `aum_samples` and
`aum_chain_samples` (keyed on `ingested_at` / `sampled_at`) immediately before the writers move.

### 4.2 Hyperdrive

Hyperdrive is Cloudflare's connection pooler. It sits between the Worker and Postgres and keeps
warm connections, which is what makes Postgres usable from an edge runtime at all.

```bash
npx wrangler hyperdrive create genie-fomo-db \
  --connection-string="postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres" \
  --caching-disabled
```

`--caching-disabled` is deliberate; see "Query caching" below.

That prints an ID. Put it in `wrangler.toml`:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<the id it printed>"
```

In the Worker, the connection string arrives as `env.HYPERDRIVE.connectionString`.

**Point Hyperdrive at the DIRECT Postgres port, not another pooler.** Today `DATABASE_URL`
points at Supabase's transaction pooler on 6543 because Edge Functions needed it. Hyperdrive *is*
that layer now; stacking two poolers causes prepared-statement failures that appear
intermittently under load rather than immediately — the worst kind. Cloudflare's Supabase guide
says the same: use the direct connection string, not the pooled ones.

**The direct host is IPv6-only** unless the project has Supabase's IPv4 add-on. `db.ts:16-19`
already records that it is unreachable from a laptop for this reason. Cloudflare's guide does
not say whether Hyperdrive reaches IPv6 origins, so test it first: if `wrangler hyperdrive
create` cannot connect, buy the IPv4 add-on (a few dollars a month) rather than falling back to
the pooler.

**Connection budget.** Hyperdrive keeps roughly 100 origin connections per configuration on the
paid plan and may briefly exceed that. Supabase's direct `max_connections` is 60 on Nano/Micro,
90 on Small, 120 on Medium, and the nightly loaders (`max: 3` each) share it. The failure mode is
`remaining connection slots are reserved`, which `classify()` maps to a 429. Check the compute
tier before cutover; upsizing for the cutover week is cheaper than debugging it.

**Query caching.** Hyperdrive caches the result of any read-only query that contains no
volatile function, for 60 seconds by default, and there is no per-query bypass. Two places here
care:

- `/traders/:handle/aum` reads `aum_samples` immediately after the sampler writes it. With
  caching on, that read can return the previous row for up to a minute, so `liveRead.state`
  would say `fetched` while `now` carried the old reading. Queries using `now()` are never
  cached, so this would differ route by route, silently.
- `select * from bump_rate_limit(...)` is uncached only because plpgsql functions default to
  VOLATILE. That is fine, but it is a property nobody will remember.

Create the configuration with `--caching-disabled` so the acceptance diff in §12 compares the
runtime and nothing else. A second, cached binding for the heavy read-only routes is a
follow-up once the port is proven.

**Query duration.** Hyperdrive caps a single query at 60 seconds. Nothing here comes near that
in normal operation, but the `/health` pathology recorded in the README (90 seconds when its
queries were parallelised) would now fail at Hyperdrive rather than at `ROUTE_TIMEOUT_MS`.

### 4.3 The driver

`postgres.js` is imported today from `deno.land/x` at 3.4.4. On Workers, use the npm package
(**3.4.5 or later** — Hyperdrive's documented minimum) with Node compatibility:

```toml
# wrangler.toml
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]
```

```ts
import postgres from "postgres";

export function db(env: Env) {
  return postgres(env.HYPERDRIVE.connectionString, {
    // Cloudflare's own example uses 5: Workers allow six simultaneous outbound connections,
    // and a route that does `Promise.all` over several queries wants more than one of them.
    // `max: 1` would serialise those. The old `max: 2` existed to protect Supabase's pooler
    // from horizontally-scaled instances; Hyperdrive owns that problem now.
    max: 5,
    // Leave `prepare` at its default (true). Hyperdrive over a DIRECT connection supports
    // named prepared statements and caches them; `prepare: false` costs a round-trip per
    // query. The first draft of this document said the opposite — that was true of the 6543
    // transaction pooler and is exactly why Hyperdrive must not be pointed at it (§4.2).
    fetch_types: false,
  });
}
```

**Create the client per request, and close it after the response.** In Deno the `sql` client
was a module-level singleton. In Workers, bindings only exist inside the handler, and an I/O
object created in one request and reused in another throws `Cannot perform I/O on behalf of a
different request`. Cloudflare's guidance is that creating a client per request is fast and is
the recommended pattern:

```ts
async fetch(req, env, ctx) {
  const sql = db(env);
  try {
    return await handle(req, { sql, env });
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}
```

A module-level client is the single most common migration bug: it compiles fine and throws at
runtime because `env` is not in scope. Today `errors.ts` imports that singleton for the rate
limiter (`errors.ts:13`), so `checkRate` must take `sql` as a parameter — it does not port
unchanged.

---

## 5. Rewriting the runtime: Deno → Workers

There are **29 `Deno.*` references** across the three functions: 9 in `routes.ts`, 5 in
`index.ts`, 2 in `db.ts`, 1 in `errors.ts`, 6 in `aum-sample`, 3 in `helius-webhook`
(`grep -ro 'Deno\.' supabase/functions | wc -l`). Every one has a direct equivalent.

### 5.1 The entry point

**Today (Deno):**

```ts
const KEY = (Deno.env.get("GENIE_API_KEY") ?? "").trim();
const port = Number(Deno.env.get("PORT") ?? 8000);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // …
});
```

**On Workers:**

```ts
export interface Env {
  HYPERDRIVE: Hyperdrive;
  GENIE_API_KEY?: string;
  AUM_SAMPLE_SECRET?: string;
  AUM_SAMPLE_URL?: string;
  AUM_LIVE_AFTER_MINUTES?: string;
  AUM_LIVE_WAIT_MS?: string;
  WALLET_SUBMIT_SECRET?: string;
  RATE_LIMIT_PER_MINUTE?: string;
  ROUTE_TIMEOUT_MS?: string;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    // …
  },
};
```

There is no port. Cloudflare routes to the Worker.

### 5.2 Environment variables

This is the largest mechanical change: **26 `Deno.env.get()` calls**, most at module scope.

```ts
// today — module scope, evaluated once at import
const SECRET = (Deno.env.get("AUM_SAMPLE_SECRET") ?? "").trim();

// on Workers — env only exists inside the handler
function secret(env: Env) {
  return (env.AUM_SAMPLE_SECRET ?? "").trim();
}
```

**Module-scope constants that read env must become functions of `env`, or be passed down.** In
`routes.ts` the affected ones are:

| Constant | Where |
|---|---|
| `LIVE_AFTER_MS`, `LIVE_WAIT_MS`, `SAMPLE_URL`, `SAMPLE_SECRET` | the `/aum` read-through |
| `WALLET_SUBMIT_SECRET` | the wallet submission route |
| `KEY`, `RATE_LIMIT`, `ROUTE_TIMEOUT_MS`, `BATCH_MAX_COST` | `index.ts` |
| `MAX_PER_WINDOW`, plus the imported `sql` singleton | `errors.ts` — the rate limiter |
| the `capabilities` block's key-presence checks (`Deno.env.get(c.key)`, a dynamic key — becomes `env[c.key]`) | `/health` |

~~The cleanest shape: a `Ctx` object built once per request and threaded through.~~ **Done
differently (17 Sep 2026).** `api/db.ts` no longer builds a client at import: it exports `sql` as
a Proxy over "the current client", resolved per call from an `AsyncLocalStorage<{ sql, env }>`
(`node:async_hooks`, available on Deno and on Workers under `nodejs_compat`) with a fallback set
once by `setDefaultSql()`. `api/config.ts` exports `cfg(name)`, which reads the same store's
`env` first and `Deno.env` second; every former `Deno.env.get` in `api/` goes through it, and
the module-scope constants became zero-arg functions or moved inside the handler. The handler
itself is `api/app.ts` `handle(req)`; `api/index.ts` (Deno) builds the client, registers it and
serves, while `worker/src/api.ts` does `runWith({ sql: db(env), env }, () => handle(req))` per
request and closes the client in `ctx.waitUntil`. Why: the same `routes/` and `shared/` modules
run on both runtimes with none of the 137 `sql\`…\`` call sites touched, and `checkRate` ports
unchanged after all. The `paths` entry in `worker/tsconfig.json` maps the deno.land type
import to the identical npm `.d.ts` so `tsc` can check the shared modules.

### 5.3 The router

`router.ts` is already platform-independent — it matches on `URL.pathname` segments and has no
Deno API in it. **It ports unchanged.**

One change: today it strips a leading `/api` because Supabase serves functions under
`/functions/v1/api`. On Workers the path is whatever you route, so decide the prefix and adjust
that one line.

### 5.4 Timeouts and the route guard

`index.ts` races every route against `ROUTE_TIMEOUT_MS` (15s). Keep this — it exists because
three routes once returned `timeout` on every call at a 5s bound, and because a 30-second wait
with no body is indistinguishable from a slow success.

Workers have their own CPU-time limit, which is **CPU time, not wall-clock**. Waiting on
Postgres or `fetch` is not CPU time, so a 12-second route that is mostly waiting is fine. The
`/traders/:handle` route currently measures ~12s — verify it against the Worker limits before
cutting over.

### 5.5 `fetch`, `crypto`, `URL`, `AbortSignal`

All standard and available on Workers unchanged. `chain_reads.ts` uses only `fetch`, `URL`,
`AbortSignal.timeout` and `BigInt` — **it ports with no edits at all.**

### 5.6 Background work after the response

Supabase Edge Functions do expose `EdgeRuntime.waitUntil()`, but the current code does not use
it and works around its absence instead. Workers gives you:

```ts
ctx.waitUntil(somePromise);
```

Use it for the AUM read-through: today, when a live sample outlasts the wait, the request
returns `still_running` and the fetch continues on a best-effort basis. On Workers,
`ctx.waitUntil(refreshNow(handle))` guarantees it completes. **This is a genuine improvement over
the current behaviour.**

---

## 6. If you choose D1: the SQL rewrite

Read this before deciding, not after.

### 6.1 Array parameters — 40 of them

The single biggest change. Postgres takes an array as one parameter:

```ts
const rows = await sql`select handle, id from traders where handle = any(${handles})`;
```

SQLite has no array type. Every one becomes:

```ts
const ph = handles.map(() => "?").join(",");
const rows = await env.DB.prepare(
  `select handle, id from traders where handle in (${ph})`
).bind(...handles).all();
```

This affects every batch route, every bulk include, and every set-based loader query — which is
most of the performance work in this codebase. D1 allows **100 bound parameters per statement**,
so a 50-id batch fits, but any query that binds two arrays of 50 does not.

### 6.2 `unnest` — the multi-array insert

```sql
insert into transaction_fees (network_id, tx_hash, fee_native, fee_native_symbol, source)
select $1, h, f::numeric, s, src
from unnest($2::text[], $3::text[], $4::text[], $5::text[]) as u(h, f, s, src)
```

No SQLite equivalent. Rewrite as a multi-row `VALUES` list built in JS, or batched single-row
inserts inside `env.DB.batch()`. With 5 columns and the 100-parameter cap, a `VALUES` list holds
at most 20 rows per statement, so the webhook's batched insert (11 columns, often hundreds of
rows) becomes many statements in one `batch()`.

### 6.3 `distinct on`

```sql
select distinct on (handle, month) handle, month, total_usd
from aum_samples order by handle, month, at asc
```

becomes

```sql
select handle, month, total_usd from (
  select handle, month, total_usd,
         row_number() over (partition by handle, month order by at asc) rn
  from aum_samples
) where rn = 1
```

### 6.4 Dates and timezones

SQLite has no timezone-aware type. Everything is TEXT or a Unix integer.

| Postgres | SQLite |
|---|---|
| `now()` | `datetime('now')` |
| `now() - interval '36 hours'` | `datetime('now','-36 hours')` |
| `to_char(d,'YYYY-MM')` | `strftime('%Y-%m', d)` |
| `date_trunc('month', at)` | `strftime('%Y-%m-01', at)` |
| `at at time zone 'utc'` | store UTC and drop the conversion |
| `extract(epoch from x)` | `strftime('%s', x)` |

**Decide the storage convention once** — ISO-8601 TEXT is the safer choice because it sorts
correctly and is readable — and apply it everywhere. Mixed conventions here will produce
timestamps that are wrong by hours in ways nothing catches.

### 6.5 `numeric` — read this twice

Postgres `numeric` is exact decimal. SQLite has no such type.

The codebase depends on this. `transaction_fees.fee_native` is stored exact and scaled as a
decimal string specifically so nothing rounds through a float, and the price ceilings exist
because one bad multiplication produced a $26.7 billion portfolio.

If you go to D1, store money as **TEXT** and parse deliberately, or as **integer minor units**.
Storing it as REAL will produce figures that look right and are wrong in the last places — and
nothing downstream will detect it.

### 6.6 What has no D1 equivalent at all

| | Replacement |
|---|---|
| `pg_cron` | Cron Triggers (§7) — genuinely better |
| `pg_net` | `fetch()` in the `scheduled` handler — simpler |
| `supabase_vault` | Workers Secrets (§8) |
| `gen_random_uuid()` | `crypto.randomUUID()` |
| `pg_stat_statements` | Workers Analytics / D1 Insights |
| server-side `statement_timeout` | enforce in the Worker |

---

## 7. Scheduling

`pg_cron` + `pg_net` currently fire every 5 minutes and POST a slice of traders to the sampler.
On Cloudflare this collapses into one Worker with a `scheduled` handler — **no database
extension, no Vault, no HTTP hop.**

```toml
# wrangler.toml — the one Worker (see §11)
[triggers]
crons = ["*/5 * * * *"]
```

```ts
export default {
  // the cron fires this
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // `await`, not `ctx.waitUntil`: a slice that throws should show up as a failed cron
    // invocation in the dashboard, not as a silently dropped promise.
    await sampleSlice(env, 10);
  },
  // and keep a POST path so it can still be driven by hand
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    if (url.pathname === "/sample") {
      if (req.method !== "POST") return json({ error: "POST only" }, 405);
      if ((req.headers.get("x-sample-secret") ?? "") !== env.AUM_SAMPLE_SECRET) {
        return json({ error: "unauthorized" }, 401);
      }
      const body = await req.json().catch(() => ({}));
      return json(await sampleSlice(env, Math.min(25, Number(body.limit ?? 10))));
    }
    // … /v1/* and /webhook
  },
};
```

**What this removes:** the `pg_cron` job, the `pg_net` extension, `run_aum_sample()`, both Vault
secrets, and the `AUM_SAMPLE_SECRET` round-trip for scheduled runs. Four moving parts become one.

Because the sampler is in the same Worker as the API, the `/aum` read-through calls
`sampleSlice()` **in-process** under `ctx.waitUntil` rather than over HTTP. `AUM_SAMPLE_SECRET`
and `AUM_SAMPLE_URL` survive only for the manual `/sample` path.

**Subrequest budget.** A 10-trader slice makes roughly 10 Helius calls plus ~30 batched EVM
`eth_call` requests. On the paid plan Workers allow **10,000 subrequests per invocation** by
default (raised in February 2026; configurable higher via `limits.subrequests`), so this is not
a constraint. On the free plan the cap is 50 external subrequests, which a 10-trader slice would
touch. What *does* bind is **six simultaneous outbound connections** per invocation, so the
batched `eth_call`s queue behind each other — latency, not failure.

**Cron overlap.** Cloudflare does not serialise cron invocations. A slice that runs past five
minutes (the budget is 100 s, but the chain reads have 45 s timeouts each) overlaps the next
tick. The oldest-first rotation makes a double-sample mostly harmless, but a cheap guard is to
`update traders set sample_claimed_at = now() where … returning handle` at the top of the slice
and skip rows claimed inside the last five minutes.

**Limits to know.** Cron Triggers are counted per account, not per Worker: 5 on the free plan,
250 on paid. A scheduled invocation may run for up to 15 minutes of wall time.

---

## 8. Secrets

### 8.0 Credentials

Nothing below runs without an API token and the account ID. Neither is in the repository.

**API token.** Cloudflare dashboard → My Profile → API Tokens → Create Token → template
*Edit Cloudflare Workers*. Add two permissions to it: *Account › Hyperdrive › Edit* and
*Account › Account Settings › Read*. Under Account Resources scope it to the one account.

**Account ID.** Workers & Pages → Overview; it is in the right-hand sidebar.

**Locally:**

```bash
export CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…
npx wrangler whoami            # must print the account, not "not authenticated"
```

**In GitHub** (`.github/workflows/cloudflare.yml` reads these):

```bash
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID
gh variable set CLOUDFLARE_DEPLOY --body true          # turns the deploy job on
gh variable set WORKER_URL --body https://genie-fomo.<subdomain>.workers.dev
```

**The first credentialed commands**, in order:

```bash
cd worker
npx wrangler hyperdrive create genie-fomo-db \
  --connection-string="postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres" \
  --caching-disabled
# paste the printed id over REPLACE_WITH_HYPERDRIVE_ID in worker/wrangler.toml
npx wrangler secret put HELIUS_WEBHOOK_SECRET
npx wrangler deploy
```

If `hyperdrive create` cannot connect, that is the IPv6 question from §4.2.

### 8.1 Secrets

```bash
npx wrangler secret put AUM_SAMPLE_SECRET
npx wrangler secret put WALLET_SUBMIT_SECRET
npx wrangler secret put HELIUS_SOLANA_KEY
npx wrangler secret put HELIUS_WEBHOOK_SECRET
npx wrangler secret put GENIE_API_KEY          # only if the API is to require X-API-Key
```

Non-secret config goes in `wrangler.toml` as plain vars:

```toml
[vars]
AUM_LIVE_AFTER_MINUTES = "5"
AUM_LIVE_WAIT_MS = "3000"
RATE_LIMIT_PER_MINUTE = "240"
ROUTE_TIMEOUT_MS = "15000"
```

**Secrets are per Worker**, which is one of the reasons §11 uses a single Worker. The first
draft had the API and the sampler as separate Workers, each needing `AUM_SAMPLE_SECRET` with the
same value; a mismatch showed up as 401s in one log and `liveRead.state: "still_running"`
forever in the other. With one Worker that failure cannot exist.

---

## 9. The webhook

`helius-webhook` is the easiest of the three. It is a single POST handler doing one batched
insert, with no Deno API beyond `Deno.env.get` and `Deno.serve`.

```ts
// inside the Worker's fetch, on pathname === "/webhook"
if (req.method !== "POST") return json({ detail: "POST only" }, 405);
if (env.HELIUS_WEBHOOK_SECRET &&
    req.headers.get("authorization") !== env.HELIUS_WEBHOOK_SECRET) {
  return json({ detail: "unauthorized" }, 401);
}
const payload = await req.json().catch(() => null);
if (payload === null) return json({ ok: true, skipped: "unparseable body" });
// Answer fast: a non-2xx makes Helius retry, so slow work here becomes duplicate
// deliveries. Acknowledge, then insert.
ctx.waitUntil(insert(env, payload).catch((e) => console.error("webhook insert:", e)));
return json({ ok: true });
```

`ctx.waitUntil` is a real improvement here — the current handler must finish its insert before
responding, which is exactly the pressure the "answer fast" rule was written against. Two things
it changes: the response can no longer carry `inserted`/`skipped` counts (nothing reads them
today), and a failed insert is now only visible in the log, so the `.catch` above is not
optional.

**After deploying, re-point Helius at the new URL:**

```bash
WEBHOOK_URL="https://genie-fomo.<subdomain>.workers.dev/webhook" \
  node scripts/register_webhook.mjs
```

The registration script already takes `WEBHOOK_URL` from the environment, so no code change.
Verify with `node scripts/register_webhook.mjs --list`.

---

## 10. The loaders

**They do not move.** The ~20 Node scripts and 4 Python loaders run in GitHub Actions against
Postgres directly. Once the database moves, change one secret — `DATABASE_URL` — and they keep
working.

Do **not** point them at Hyperdrive. Hyperdrive is for Workers; a long-running loader wants a
direct connection, and several of them deliberately manage their own pool size (`max: 3`) for
reasons recorded in their headers.

If you later want the loaders on Cloudflare too, that is a separate project: they run for tens
of minutes, which is not what Workers are for. Cloudflare Containers or an external runner would
be the shape.

---

## 11. Project layout and wrangler config

**One Worker, not three.** The first draft proposed separate `api`, `sampler` and `webhook`
Workers. Nothing in the code needs that isolation, and it costs three secret sets, three
Hyperdrive bindings, three deploys, an HTTP hop for the `/aum` read-through, and the
`AUM_SAMPLE_SECRET` mismatch failure in §8. Split into `api` + `jobs` with a service binding
later only if their deploy cadences diverge.

```
worker/
  src/
    index.ts          fetch: auth, rate limit, timeout race, then routes by path:
                        /v1/*     → routes.ts
                        /sample   → sampler.ts (POST, secret-checked)
                        /webhook  → webhook.ts
                      scheduled: sampler.ts sliceOf(10)
    router.ts         unchanged from today
    routes.ts         the 21 routes, taking a Ctx { sql, env } instead of module globals
    errors.ts         checkRate takes sql; MAX_PER_WINDOW read from env
    db.ts             postgres client from env.HYPERDRIVE, created per request
    sampler.ts        today's aum-sample/index.ts minus Deno.serve
    webhook.ts        today's helius-webhook/index.ts minus Deno.serve
    chain_reads.ts    unchanged from today
  wrangler.toml
```

```toml
# worker/wrangler.toml
name = "genie-fomo"
main = "src/index.ts"
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<id>"
# for `wrangler dev` without --remote: a direct connection string for local runs
localConnectionString = "postgresql://…"

[triggers]
crons = ["*/5 * * * *"]

[limits]
cpu_ms = 30000

[vars]
AUM_LIVE_AFTER_MINUTES = "5"
AUM_LIVE_WAIT_MS = "3000"
RATE_LIMIT_PER_MINUTE = "240"
ROUTE_TIMEOUT_MS = "15000"

[observability]
enabled = true
```

Deploy:

```bash
cd worker && npx wrangler deploy
```

**Local development.** The first draft said `wrangler dev` "runs the real thing". It does not by
default: `wrangler dev` runs locally and connects Hyperdrive bindings straight to
`localConnectionString` (or `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`), with
**no pooling and no caching**, so it will not reproduce pool or cache behaviour. `wrangler dev
--remote` runs on Cloudflare against the real binding, and every write it makes lands in the
production database. Use local for iteration and `--remote` only for the shadow run in §13.

---

## 12. Proving it works

**This is the part that makes the migration safe, and it already exists.**

The repository carries two independent suites that run against a deployed URL:

| | |
|---|---|
| **`Acceptance_Tests.md`** — 50 behavioural tests | currently **45 passing** |
| **`Field_Contracts.md`** — every field a consumer reads | currently **150 of 150 correct** |

**The harness that produced those numbers is not in the repository.** `ACCEPTANCE_TEST_REPORT.md`
§8 says so: `collect.py`, `an_sc.py`, `an_aum.py` and `targeted.py` lived in a session
scratchpad. What the repo has is `scripts/acceptance_capture.sh`, which fetches every route in
the suite for a fixed set of traders, strips the fields documented as live, and writes one
normalised JSON file per call so two runs can be diffed. It is the gate for this migration until
the field-contract harness is rebuilt and committed.

### The procedure

```bash
# 1. baseline against Supabase, before anything changes — run it twice and diff the two runs
#    first; the diff must be empty or the harness is not deterministic enough to trust
./scripts/acceptance_capture.sh https://<ref>.supabase.co/functions/v1/api captures/before
./scripts/acceptance_capture.sh https://<ref>.supabase.co/functions/v1/api captures/before2
diff -r captures/before captures/before2

# 2. same suite against the Worker
./scripts/acceptance_capture.sh https://genie-fomo.<subdomain>.workers.dev captures/after

# 3. the migration is correct when this is empty
diff -r captures/before captures/after
```

### Byte-level comparison

Stronger, and worth doing for the money routes. Fetch the same trader from both and diff, having
removed the fields documented as live (`from`, `to`, `asOf`, `*ageSeconds`, `liveRead`):

```bash
for h in unipcs ogle poopinyourhands 0xavast notanicecat69; do
  for r in scorecard pnl portfolio "aum?window=1m&live=false"; do
    curl -s "$SUPA/v1/traders/$h/$r" | jq -S 'del(.asOf,.liveRead)' > /tmp/a.json
    curl -s "$CF/v1/traders/$h/$r"   | jq -S 'del(.asOf,.liveRead)' > /tmp/b.json
    diff -q /tmp/a.json /tmp/b.json || echo "DIFFERS: $h $r"
  done
done
```

**Do this before cutting over, not after.** Both deployments can read the same database
simultaneously, so there is no reason to guess.

### What to check by hand

- `/v1/health` — its four queries are sequential *on purpose*; parallelising them once took the
  route to a 90-second timeout while every query ran in 150 ms by hand. If you "optimise" this
  during the port, test this route specifically.
- `/v1/fields` — the published vocabulary must be identical.
- `POST /v1/traders/aum` with 50 ids — the batch shape and `unreadableRows[]`.
- `/v1/traders/:handle/aum` with `?live=true` — the read-through actually reaching the sampler.
- A wallet submission with a colliding address — must still return `409 address_in_use`.

---

## 13. Cutover and rollback

Run both in parallel. There is no need for a hard switch.

Under Option A′ there is one database throughout, so every phase is reversible.

**Phase 1 — shadow.** Deploy the Worker with Hyperdrive pointed at Supabase's direct connection.
Run the acceptance capture against both URLs and diff. Nothing in production changes; the
Worker's `scheduled` handler stays **disabled** (no `[triggers]` yet) so only `pg_cron` samples.

**Phase 2 — move the writers.** Enable the Worker's cron and unschedule `aum-sample-rotate`
(`select cron.unschedule('aum-sample-rotate')`), then re-point Helius at `/webhook` and confirm
with `register_webhook.mjs --list`. Both write the same tables in the same database; if anything
looks wrong, reverse the two steps.

**Phase 3 — move readers.** Switch consumers to the Worker URL. Keep the Supabase functions
deployed and readable.

**Phase 4 — decommission.** After a week of clean running, delete the Supabase functions, the
`run_aum_sample()` function and the two Vault secrets.

**Rollback:** at every phase, "point it back". There is no point of no return.

**If you later take Option A (move the host):** insert the dump/restore from §4.1 after Phase 4,
and do the restore and the `DATABASE_URL` switch for the loaders, the webhook and Hyperdrive in
one window, because of the data gap described there. That step, and only that step, has a
window where rollback means losing rows.

---

## 14. Cost

Cloudflare's paid Workers plan ($5/month, 10M requests and 30M CPU-ms included, then $0.30 per
million requests and $0.02 per million CPU-ms as of writing) covers Workers, Cron Triggers and
Hyperdrive. The shape of our usage:

| | Volume |
|---|---|
| API requests | a consumer sync is ~160 calls; the acceptance suite ~180 |
| Sampler invocations | 288/day at `*/5`, each ~40 subrequests |
| Webhook invocations | ~290,000 rows/week, batched per payload |
| Hyperdrive | one origin, one pool; no separate charge |

At this volume the Workers bill is the $5 floor. Under Option A′ the Supabase bill is unchanged
apart from a possible IPv4 add-on (§4.2). Under Option A, **Postgres hosting** becomes a new line
item, which Supabase currently bundles; size it against `transactions` growing at roughly
300,000 rows a week.

---

## 15. A phased plan

| Phase | Work | Rough effort |
|---|---|---|
| **0** | Read this document. Decide A′ / A / B (§2) | — |
| **1** | `wrangler hyperdrive create` against Supabase's direct host, `--caching-disabled`. This settles the IPv6 question (§4.2) before any code is written | ½ day |
| **2** | Run `scripts/acceptance_capture.sh` twice against Supabase and diff; fix the harness until the diff is empty | ½–1 day |
| **3** | Port `helius-webhook` as `/webhook` — smallest, isolated, proves the toolchain | 1 day |
| **4** | Port `aum-sample` as `/sample` + `scheduled`. `chain_reads.ts` ports unchanged | 2 days |
| **5** | Port `api`: `index.ts`, `router.ts`, `errors.ts` (takes `sql`), `db.ts` (per request), then the `Ctx` plumbing through `routes.ts` | 3–5 days |
| **6** | Capture against the Worker and diff against Phase 2 | ½ day |
| **7** | Cutover per §13 | 1 week, mostly waiting |

**About a fortnight for Option A′**, most of it in Phase 5 and most of *that* being the
mechanical `Deno.env.get` → `env` change across 26 call sites plus threading `sql` through
`routes.ts`.

**Phase status (17 Sep 2026):** Phases 3 and 4 done — `worker/` builds, `/webhook` and
`/sample` + `scheduled` are ported (`worker/src/sampler.ts`, twin of `aum-sample/index.ts`;
`chain_reads.ts` and `value.ts` are imported from `supabase/functions`, not copied). Not
deployed: no credentials yet, Hyperdrive id is a placeholder, `[triggers]` stays commented out
until Phase 2 of §13. Phase 5 ported, not deployed: `/v1/*` runs the shared `api/` modules
through `worker/src/api.ts` (§5.2) and answers 503 `not_configured` until the Hyperdrive binding
exists; verified locally only against a dead binding (404 route list, rate limiter fails open,
`/v1/health` → 503 `unavailable`). Phases 1, 2 and 6 (the shadow diff) wait on Hyperdrive.

Option B adds four to eight weeks for the SQL rewrite, and should be scheduled as its own
project with the acceptance suite as the gate.

---

## 16. What will bite you

Ordered by how likely they are to cost you a day.

**1. A module-scope database client.** Compiles, deploys, throws at runtime because `env` does
not exist at module scope. The most common Workers migration bug by a distance.

**2. Two poolers stacked.** Hyperdrive in front of Supabase's transaction pooler, or in front of
PgBouncer, produces intermittent prepared-statement errors under load — not at deploy time.
Point Hyperdrive at the direct Postgres port.

**3. `prepare: false` kept.** The current config has it for a reason recorded in `db.ts`:
transaction-mode pooling cannot carry prepared statements. That reason goes away with #2 — over
a direct connection Hyperdrive caches prepared statements and `prepare: false` only adds a
round-trip per query. Carry it forward only if you ignored #2.

**4. Hyperdrive's query cache.** On by default, 60 seconds, no per-query bypass. It turns the
`/aum` read-through into "fetched, but showing you the previous reading" for up to a minute and
nothing downstream can tell. Create the config with `--caching-disabled` (§4.2).

**4a. Shared egress IPs.** Workers' outbound `fetch` leaves from Cloudflare's shared ranges. The
keyless public EVM RPCs the sampler uses rate-limit by IP, so throttling becomes a function of
what every other Worker on the same range is doing. `chain_reads.ts` already treats Robinhood's
403 as a 429; expect more of them, and put a key on every EVM endpoint that offers one.

**5. CPU time versus wall clock.** `/traders/:handle` takes ~12 s today, almost all of it waiting
on Postgres. That is fine under a CPU-time limit and alarming under a wall-clock one. Measure
before assuming.

**6. Forgetting to re-point Helius.** The webhook Worker deploys, everything looks healthy, and
the Solana transfer feed silently stops — the same failure mode as the GitHub Actions cron that
went unnoticed for six days. `register_webhook.mjs --list` after cutover.

**7. `/health` "optimised" during the port.** Its sequential awaits are deliberate. There is a
comment saying so. Believe it.

**8. Float money, if you take Option B.** SQLite REAL for financial figures will produce numbers
that look right and are wrong in the last places, and nothing downstream will detect it. The
codebase already goes to lengths to avoid this; do not undo them.

**9. Timestamps, if you take Option B.** SQLite has no timezone type. Mixed conventions produce
values wrong by hours, and `capturedAt` has already shipped in the wrong form once — it was an
epoch integer where every other `*At` was ISO-8601, and it took a field-by-field audit to catch.

**10. Assuming the acceptance suite passes because the deploy succeeded.** It did not, twice, on
this codebase: a `capabilities` block that read correctly on a laptop and reported every provider
degraded in production, and a published field silently deleted by an unrelated edit. Run the
suite.

---

## Appendix — files to read before starting

| File | Why |
|---|---|
| `supabase/functions/api/db.ts` | Every connection decision, with the reason it was made |
| `supabase/functions/api/index.ts` | Auth, rate limiting, the timeout race, cost accounting |
| `supabase/functions/api/router.ts` | Ports unchanged; read it to see why it scores specificity |
| `supabase/functions/api/errors.ts` | Does NOT port unchanged: `checkRate` uses the module-level `sql`, and `classify()` matches pg wire text, not Hyperdrive's error codes (2012 TLS, 2015 connect) — extend it or every Hyperdrive outage is a 500 instead of a 503 |
| `scripts/acceptance_capture.sh` | The diff gate in §12 |
| `supabase/functions/_shared/chain_reads.ts` | Ports unchanged; the batch sizes and throttles are measured, not guessed |
| `README.md` | What the service is and how the pieces fit |
| `PARAMETER_ROUTES.md` | Every route and parameter in detail |
| `Field_Contracts_Mapping.md` | All 150 consumer-read fields — the diff target |
| `ACCEPTANCE_TEST_PLAN.md` | What was fixed and why; §4.4 has the sampler deployment steps |
