# Migrating genie-fomo from Supabase to Cloudflare

A complete plan for rebuilding this service on Cloudflare — Workers instead of Supabase Edge
Functions, Cron Triggers instead of `pg_cron`, Workers Secrets instead of Vault, and a decision
to make about the database.

Written 16 September 2026, measured against the running system. Every number here came from the
live database or the deployed code, not from memory.

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
| `supabase/functions/aum-sample/index.ts` | 449 | Deno |
| `supabase/functions/helius-webhook/index.ts` | 155 | Deno |
| `supabase/functions/_shared/chain_reads.ts` | 192 | Deno |
| **Total** | **9,093** | |

Plus ~20 Node loader scripts in `scripts/` and 4 Python loaders, which run in GitHub Actions and
are **not affected by this migration** — they talk to Postgres over a normal connection and can
keep doing so.

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

### Option A — Workers + Hyperdrive + external Postgres  ✅ recommended

Keep the database exactly as it is. Move it off Supabase to any Postgres host (Neon, Crunchy,
RDS, self-hosted). Put Cloudflare **Hyperdrive** in front for connection pooling, and point
Workers at it.

**What changes:** the runtime only. Every SQL query, every migration, every loader script keeps
working unchanged.

**What you give up:** Postgres is not hosted by Cloudflare, so "everything on Cloudflare" is
true of compute and false of storage.

**Effort:** roughly a week. §5 is the whole job.

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

**Take Option A.** Take it even if the goal is "all Cloudflare", because it gets you off
Supabase's compute immediately and lets you evaluate D1 separately, with the API already
running on Workers and the full acceptance suite available to prove any query rewrite.

Option B is a rewrite wearing a migration's clothes. Doing both at once means that when
something returns a wrong number you will not know whether it was the runtime or the SQL.

The rest of this document assumes **Option A**, and §6 covers what changes if you later take
Option B.

---

## 3. Service-by-service mapping

| Today | On Cloudflare | Notes |
|---|---|---|
| Supabase Edge Function `api` | **Worker** `genie-fomo-api` | §5 |
| Supabase Edge Function `aum-sample` | **Worker** `genie-fomo-sampler` | §5, §7 |
| Supabase Edge Function `helius-webhook` | **Worker** `genie-fomo-webhook` | §9 |
| Supabase Postgres | **external Postgres + Hyperdrive** | §4 |
| Supabase connection pooler (6543) | **Hyperdrive** | §4 |
| `pg_cron` + `pg_net` | **Cron Triggers** (`scheduled` handler) | §7 |
| `supabase_vault` | **Workers Secrets** | §8 |
| `gen_random_uuid()` | `crypto.randomUUID()` in JS | |
| Supabase function URL | Worker route or `*.workers.dev` | §11 |
| `npx supabase functions deploy` | `npx wrangler deploy` | §11 |
| GitHub Actions loaders | **unchanged** | §10 |

---

## 4. The database

### 4.1 Moving Postgres off Supabase

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

### 4.2 Hyperdrive

Hyperdrive is Cloudflare's connection pooler. It sits between the Worker and Postgres and keeps
warm connections, which is what makes Postgres usable from an edge runtime at all.

```bash
npx wrangler hyperdrive create genie-fomo-db \
  --connection-string="postgresql://user:pass@host:5432/dbname"
```

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
intermittently under load rather than immediately — the worst kind.

### 4.3 The driver

`postgres.js` is imported today from `deno.land/x`. On Workers, use the npm package with Node
compatibility:

```toml
# wrangler.toml
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]
```

```ts
import postgres from "postgres";

export function db(env: Env) {
  return postgres(env.HYPERDRIVE.connectionString, {
    // Hyperdrive pools for you. One connection per isolate is correct here — the old `max: 2`
    // existed to stop Edge Function instances exhausting Supabase's pooler, and that problem
    // moves to Hyperdrive.
    max: 1,
    // Still required: Hyperdrive multiplexes, and transaction-mode pooling cannot carry
    // prepared statements between statements.
    prepare: false,
    fetch_types: false,
  });
}
```

**A connection cannot be shared across requests.** In Deno the `sql` client was a module-level
singleton. In Workers, bindings only exist inside the handler, so the client must be created per
request (or per isolate, lazily, keyed off `env`). This is the single most common migration bug:
a module-level client compiles fine and throws at runtime because `env` is not in scope.

---

## 5. Rewriting the runtime: Deno → Workers

There are **47 `Deno.*` references** across the three functions. Every one has a direct
equivalent.

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

This is the largest mechanical change: **43 `Deno.env.get()` calls**, many at module scope.

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
| the `capabilities` block's key-presence checks | `/health` |

The cleanest shape: a `Ctx` object built once per request and threaded through, carrying `sql`
and the config. It is a mechanical edit across ~7,800 lines but a shallow one.

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

Deno has no equivalent of this and the current code works around it. Workers gives you:

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
most of the performance work in this codebase. Note that a 50-id batch becomes a statement with
50 placeholders, and D1 has a bound-parameter limit worth checking.

### 6.2 `unnest` — the multi-array insert

```sql
insert into transaction_fees (network_id, tx_hash, fee_native, fee_native_symbol, source)
select $1, h, f::numeric, s, src
from unnest($2::text[], $3::text[], $4::text[], $5::text[]) as u(h, f, s, src)
```

No SQLite equivalent. Rewrite as a multi-row `VALUES` list built in JS, or batched single-row
inserts inside `env.DB.batch()`.

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
# wrangler.toml — the sampler Worker
name = "genie-fomo-sampler"
main = "src/index.ts"
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]

[triggers]
crons = ["*/5 * * * *"]

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<hyperdrive id>"
```

```ts
export default {
  // the cron fires this
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sampleSlice(env, 10));
  },
  // and keep fetch so it can still be driven by hand
  async fetch(req: Request, env: Env) {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    if ((req.headers.get("x-sample-secret") ?? "") !== env.AUM_SAMPLE_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }
    const body = await req.json().catch(() => ({}));
    return json(await sampleSlice(env, Math.min(25, Number(body.limit ?? 10))));
  },
};
```

**What this removes:** the `pg_cron` job, the `pg_net` extension, `run_aum_sample()`, both Vault
secrets, and the `AUM_SAMPLE_SECRET` round-trip for scheduled runs. Four moving parts become one.

The secret is still needed for the `fetch` path — the `/aum` read-through calls the sampler over
HTTP — but the schedule no longer authenticates over the network to itself.

**Subrequest budget.** A 10-trader slice makes roughly 10 Helius calls plus ~30 batched EVM
`eth_call` requests. Workers cap subrequests per invocation (50 on the free plan, higher on paid
— check current values). If you hit the cap, reduce the slice and increase the cron frequency;
the rotation logic is already oldest-sampled-first and does not care about slice size.

---

## 8. Secrets

```bash
npx wrangler secret put AUM_SAMPLE_SECRET     --name genie-fomo-api
npx wrangler secret put AUM_SAMPLE_SECRET     --name genie-fomo-sampler
npx wrangler secret put WALLET_SUBMIT_SECRET  --name genie-fomo-api
npx wrangler secret put HELIUS_SOLANA_KEY     --name genie-fomo-sampler
npx wrangler secret put HELIUS_WEBHOOK_SECRET --name genie-fomo-webhook
```

Non-secret config goes in `wrangler.toml` as plain vars:

```toml
[vars]
AUM_LIVE_AFTER_MINUTES = "5"
AUM_LIVE_WAIT_MS = "3000"
RATE_LIMIT_PER_MINUTE = "240"
ROUTE_TIMEOUT_MS = "15000"
AUM_SAMPLE_URL = "https://genie-fomo-sampler.<subdomain>.workers.dev"
```

**Secrets are per Worker.** `AUM_SAMPLE_SECRET` must be set on both the API (which calls the
sampler) and the sampler (which checks it), with the same value. A mismatch shows up as 401s in
the sampler's logs and `liveRead.state: "still_running"` forever on the API — a quiet failure
worth a deployment check.

---

## 9. The webhook

`helius-webhook` is the easiest of the three. It is a single POST handler doing one batched
insert, with no Deno API beyond `Deno.env.get` and `Deno.serve`.

```ts
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    if (req.method !== "POST") return json({ detail: "POST only" }, 405);
    if (env.HELIUS_WEBHOOK_SECRET &&
        req.headers.get("authorization") !== env.HELIUS_WEBHOOK_SECRET) {
      return json({ detail: "unauthorized" }, 401);
    }
    const payload = await req.json();
    // Answer fast: a non-2xx makes Helius retry, so slow work here becomes duplicate
    // deliveries. Acknowledge, then insert.
    ctx.waitUntil(insert(env, payload));
    return json({ ok: true });
  },
};
```

`ctx.waitUntil` is a real improvement here — the current handler must finish its insert before
responding, which is exactly the pressure the "answer fast" rule was written against.

**After deploying, re-point Helius at the new URL:**

```bash
WEBHOOK_URL="https://genie-fomo-webhook.<subdomain>.workers.dev" \
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

```
workers/
  api/
    src/
      index.ts          fetch handler, auth, rate limit, timeout race
      router.ts         unchanged from today
      routes.ts         the 21 routes
      errors.ts         unchanged
      db.ts             postgres client from env.HYPERDRIVE
    wrangler.toml
  sampler/
    src/
      index.ts          scheduled + fetch
      chain_reads.ts    unchanged from today
    wrangler.toml
  webhook/
    src/index.ts
    wrangler.toml
shared/
  chain_reads.ts        one copy, imported by sampler
```

```toml
# workers/api/wrangler.toml
name = "genie-fomo-api"
main = "src/index.ts"
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<id>"

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
cd workers/api && npx wrangler deploy
cd ../sampler && npx wrangler deploy
cd ../webhook && npx wrangler deploy
```

Local development runs the real thing, not a simulator:

```bash
npx wrangler dev --remote      # uses the real Hyperdrive binding
```

---

## 12. Proving it works

**This is the part that makes the migration safe, and it already exists.**

The repository carries two independent suites that run against a deployed URL:

| | |
|---|---|
| **`Acceptance_Tests.md`** — 50 behavioural tests | currently **45 passing** |
| **`Field_Contracts.md`** — every field a consumer reads | currently **150 of 150 correct** |

Both are driven by harness scripts that take a base URL. Point them at the Worker and you get a
direct, field-by-field comparison against the Supabase deployment.

### The procedure

```bash
# 1. baseline against Supabase, before anything changes
BASE=https://<ref>.supabase.co/functions/v1/api  ./run_acceptance.sh > before.txt

# 2. same suite against the Worker
BASE=https://genie-fomo-api.<subdomain>.workers.dev  ./run_acceptance.sh > after.txt

# 3. the migration is correct when this is empty
diff before.txt after.txt
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

**Phase 1 — shadow.** Deploy the Workers pointed at the *same* Supabase Postgres, before moving
the database. Run the acceptance suite against both. Nothing in production changes.

**Phase 2 — move the database.** Restore to the new Postgres, point Hyperdrive at it, and run
the suite against the Workers again. Supabase keeps serving from the old database.

**Phase 3 — move the writers.** Point the GitHub Actions loaders at the new `DATABASE_URL`, and
re-point the Helius webhook at the new Worker. **From here the two databases diverge** — this is
the point of no easy return, so verify Phase 2 thoroughly first.

**Phase 4 — move readers.** Switch consumers to the Worker URL. Keep Supabase deployed and
readable.

**Phase 5 — decommission.** After a week of clean running, remove the Supabase functions and
the cron job.

**Rollback:** trivial in Phases 1–2 (just stop using the Worker). After Phase 3, rollback means
pointing the loaders back and accepting the gap in the old database — so the window between
Phase 3 and confidence should be short.

---

## 14. Cost

Cloudflare's paid Workers plan covers Workers, Cron Triggers and Hyperdrive. Check current
pricing; the shape of our usage:

| | Volume |
|---|---|
| API requests | a consumer sync is ~160 calls; the acceptance suite ~180 |
| Sampler invocations | 288/day at `*/5`, each ~40 subrequests |
| Webhook invocations | ~290,000 rows/week, batched per payload |
| Hyperdrive | one origin, one pool |
| Postgres hosting | a new line item — Neon or similar, sized for 2 GB and growing |

The likely surprise is **Postgres hosting**, which Supabase currently bundles. Size it against
`transactions` growing at roughly 300,000 rows a week.

---

## 15. A phased plan

| Phase | Work | Rough effort |
|---|---|---|
| **0** | Read this document. Decide Option A or B (§2) | — |
| **1** | Port `helius-webhook` — smallest, isolated, proves the toolchain | 1 day |
| **2** | Port `aum-sample`, including `scheduled`. `chain_reads.ts` ports unchanged | 2 days |
| **3** | Port `api`: `index.ts`, `router.ts`, `errors.ts`, then the env plumbing through `routes.ts` | 3–5 days |
| **4** | Stand up the new Postgres, dump/restore, create Hyperdrive | 1 day |
| **5** | Run both suites against both deployments and diff | 1 day |
| **6** | Cutover per §13 | 1 week, mostly waiting |

**About a fortnight for Option A**, most of it in Phase 3 and most of *that* being the
mechanical `Deno.env.get` → `env` change across 43 call sites.

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

**3. `prepare: false` dropped.** It is in the current config for a reason recorded in `db.ts`:
transaction-mode pooling cannot carry prepared statements between statements, and with it left
on, queries fail *intermittently* under load rather than immediately.

**4. Subrequest limits on the sampler.** A 10-trader slice is ~40 subrequests. The limit is per
invocation and the failure mode is a partial slice, which looks like a trader being skipped
rather than an error.

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
| `supabase/functions/_shared/chain_reads.ts` | Ports unchanged; the batch sizes and throttles are measured, not guessed |
| `README.md` | What the service is and how the pieces fit |
| `PARAMETER_ROUTES.md` | Every route and parameter in detail |
| `Field_Contracts_Mapping.md` | All 150 consumer-read fields — the diff target |
| `ACCEPTANCE_TEST_PLAN.md` | What was fixed and why; §4.4 has the sampler deployment steps |
