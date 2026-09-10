# Supabase → Cloudflare — migration runbook

**Written 2026-09-10.** Nothing here has been executed. Follow it top to bottom.

| | |
| --- | --- |
| Why | egress **24.356 / 5 GB (487%)**, database **0.92 / 0.5 GB (184%)**, grace ends **12 Sep 2026** |
| What moves | **the API compute** — Supabase Edge Functions → Cloudflare Workers |
| What does not move | **Postgres.** Cloudflare has no Postgres; the database host is a separate decision (§7) |
| Porting surface | **~10 call sites in 4 small files.** `routes.ts` (3,417 lines) needs no change |
| Data risk | **none in phases 0-3** — the database is never written to, only read from by a different client |
| Backup | **local** (§2a), ~350 MB to keep, ~2 GB free to verify, ~650 MB of egress (§2b) |

---

## 0. Read this first

**Cloudflare cannot host your database.** D1 is SQLite; this schema uses generated columns,
lateral joins, `filter (where …)`, `unnest`, jsonb operators, and partial and INCLUDE indexes.
D1 also caps writes at **100,000 rows/day** and the nightly refresh writes **117,049** in one
run. It is not a candidate and no amount of effort makes it one.

So this is **move the compute, keep Postgres**. Hyperdrive — free on Workers, 100,000
queries/day — is what lets a Worker reach Postgres over TCP, with query caching included.

**Do not move compute and database in the same change.** If something breaks you will not be
able to tell which move broke it. Phases 0-3 keep the database exactly where it is.

---

## 1. Inventory — everything you need before starting

### 1a. From Supabase

| What | Value / where to get it |
| --- | --- |
| Project ref | `gxnonqlmujmtgczvhvzp` |
| API function URL | `https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api` |
| Webhook function URL | `https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/helius-webhook` |
| **Session-mode** connection string (port **5432**) | Dashboard → Project Settings → Database → Connection string → **Session**. Needed for `pg_dump` and the Python loaders. |
| **Transaction-mode** pooler string (port **6543**) | same page → **Transaction**. What the edge function and the `.mjs` loaders use. |
| Database password | same page (reset it if unknown — note this rotates it everywhere) |

Both pooler strings are IPv4. The *direct* connection Supabase injects as `SUPABASE_DB_URL`
inside an Edge Function resolves **IPv6-only**, which is fine from inside Supabase and
unreachable from anywhere else — including Cloudflare. **Hyperdrive must be given a pooler
string, not the direct one.**

### 1b. Environment variables the code actually reads

Measured from source, not assumed:

| Variable | Used by | Default | Needed on Cloudflare? |
| --- | --- | --- | --- |
| `DB_URL` | `api/db.ts`, `helius-webhook` | — | **replaced by the Hyperdrive binding** |
| `SUPABASE_DB_URL` | both, as fallback | — | no |
| `DATABASE_URL` | `api/db.ts`, as last fallback | — | no |
| `GENIE_API_KEY` | `api/index.ts` | `""` (auth off) | yes, if you use it — as a **secret** |
| `RATE_LIMIT_PER_MINUTE` | `api/index.ts`, `api/errors.ts` | `240` | yes — plain var |
| `PORT` | `api/index.ts` | `8000` | **no** — Workers has no port |
| `HELIUS_WEBHOOK_SECRET` | `helius-webhook` | `""` | only if you port the webhook |

### 1c. From Cloudflare

| What | How |
| --- | --- |
| Account | free plan is enough to start (§8 covers when it is not) |
| `wrangler` CLI | `npm i -D wrangler` then `npx wrangler login` |
| Account ID | `npx wrangler whoami`, or Dashboard → right sidebar |
| A Hyperdrive config | created in Phase 2 by CLI, not the dashboard |
| A zone (custom domain) | **only for Phase 3.** `*.workers.dev` needs no domain and is fine for Phases 1-2 |

### 1d. Locally

`node` ≥ 18, `npx wrangler`, `psql` + `pg_dump` matching the server's major version, `jq`
(for the diff harness).

---

## 2. Phase 0 — back up · **do this today, before anything else**

**After 12 Sep the project returns 402 and you may not be able to export at all.**

### 2a. Yes — this is a local backup, on your machine

`pg_dump` and `supabase db dump` both **stream the data down to a file on your laptop.**
Nothing is stored on Supabase, nothing is stored on Cloudflare unless you upload it in 2f.
If your laptop dies, the backup dies with it — which is why 2f exists.

### 2b. No — it does not need 0.92 GB of local disk

The **0.92 GB** on the usage page is `pg_total_relation_size`: heap **plus indexes plus
TOAST**. A dump contains **data only** — indexes travel as a one-line `CREATE INDEX`
statement and are rebuilt on restore. On this database that is a large saving: the four
indexes on `transactions` alone are roughly 250 MB of the 920 MB.

| | Approx. disk | Note |
| --- | --- | --- |
| `.dump` file (`-Fc`, compressed) | **~150-350 MB** | what you actually keep |
| Plain SQL (`--data-only`, uncompressed) | ~600 MB - 1 GB | the Supabase CLI route |
| **Egress this costs you** | **~650 MB** | the wire transfer is uncompressed; compression happens on your machine |
| Verifying by restoring locally (2f) | **~1 GB**, plus ~1 GB headroom for WAL | only while you verify; drop it after |

**So: ~350 MB to keep, ~2 GB free space to verify properly.** Those are estimates from row
counts and index sizes, not measurements — the real numbers land the moment the dump finishes.

### 2c. Step 1 — unpause the project

Dashboard → the paused banner → **Restore**. A paused project refuses every connection,
including the dashboard's own SQL editor. That is why your size query timed out.

### 2d. Step 2 — stop the bleeding *before* you restore

Restoring puts you straight back into the traffic that caused the overage:

- **Helius dashboard** → delete the webhook pointing at `…/functions/v1/helius-webhook`.
  It fires on every trade across 435 traders' wallets, with no schedule and no natural stop.
  **Note:** `refresh.yml` re-registers it, so disable the workflow too or it comes back.
- **GitHub** → Actions → `nightly refresh` → ⋯ → **Disable workflow**. Repeat for
  `staleness check`. `refresh.yml` runs at 06:00 UTC and is the single biggest egress event.

### 2e. Step 3 — take the dump

Get the **Session mode** string (port **5432**) from Dashboard → Project Settings → Database →
Connection string. **Not** the transaction pooler: `pg_dump` needs a real session and will
fail against 6543.

```bash
export PGURL='postgresql://postgres.gxnonqlmujmtgczvhvzp:PASSWORD@aws-0-<region>.pooler.supabase.com:5432/postgres'
```

**Method A — `pg_dump` custom format. Recommended here.** One compressed, restorable archive;
`pg_restore` can filter it per-table later, which matters if you ever want to restore
`transactions` alone.

```bash
pg_dump "$PGURL" -Fc -f genie-fomo-$(date +%F).dump         # everything, compressed
pg_dump "$PGURL" -s  -f genie-fomo-schema-$(date +%F).sql   # schema alone, for diffing
ls -lh genie-fomo-*.dump                                    # the real size, at last
```

**Method B — the Supabase CLI, their documented path.** Splits roles, schema and data into
three files. Use this if you are restoring **into another Supabase project**, because it
handles roles, which `pg_dump` alone does not:

```bash
supabase db dump --db-url "$PGURL" -f roles.sql  --role-only
supabase db dump --db-url "$PGURL" -f schema.sql
supabase db dump --db-url "$PGURL" -f data.sql   --use-copy --data-only \
  -x "storage.buckets_vectors" -x "storage.vector_indexes"
```

Restore (their documented order — roles, then schema, then data):

```bash
psql --single-transaction --variable ON_ERROR_STOP=1 \
  --file roles.sql --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file data.sql --dbname "$TARGET_URL"
```

`session_replication_role = replica` disables triggers during the load. Requires Docker for
the CLI. **Doing both A and B costs one extra transfer and gives you two independent
formats — worth it for the only backup you have.**

### 2f. Step 4 — verify it. Do not assume it

A dump you have not restored is a hope, not a backup.

```bash
createdb genie_verify
pg_restore -d genie_verify --no-owner --no-privileges genie-fomo-$(date +%F).dump

psql genie_verify -c "select count(*) from traders;"       # expect 435
psql genie_verify -c "select count(*) from trades;"        # expect ~51,581
psql genie_verify -c "select count(*) from transactions;"  # expect ~663,000
psql genie_verify -c "select count(*) from holdings;"      # expect ~66,097
psql genie_verify -c "select count(*) from token_info;"    # expect ~3,400
psql genie_verify -c "select count(*) from holdings_current;"   # the view must exist too

dropdb genie_verify        # reclaim the ~1 GB once the counts check out
```

`--no-owner --no-privileges` because your local Postgres has no `supabase_admin` role and
would otherwise error on every ownership line.

### 2g. Step 5 — get it off your laptop

R2 charges nothing to read it back, which is the whole point of putting it there:

```bash
npx wrangler r2 bucket create genie-fomo-backups
npx wrangler r2 object put genie-fomo-backups/$(date +%F).dump \
  --file genie-fomo-$(date +%F).dump
```

### 2h. What a database dump does **not** contain

Easy to assume "I have a backup" and be wrong:

| Not in the dump | Where it actually lives | Action |
| --- | --- | --- |
| Edge function code | git, this repo | already safe |
| Function secrets / env vars | Supabase dashboard only | **write them down now** |
| The Helius webhook registration | Helius dashboard | note the URL and secret |
| GitHub Actions secrets | GitHub | already elsewhere |
| Storage objects | Supabase Storage | you have **0 GB** — nothing to lose |
| Auth users | `auth` schema | 1 MAU — check if it matters |

**Done when:** the restore verified with the row counts above and the dump is in R2.
Everything after this is reversible.

---

## 3. Phase 1 — the caching proxy · **~1 hour · biggest win, no port**

Ship this before any porting. It attacks the egress directly, needs no code migration, and is
worth keeping whichever host you end up on.

**Why it will work:** the API sends **no cache headers at all**, board responses are
**996 KB**, the data changes **once a day** (06:00 UTC), and there were **215,028
invocations** last cycle. Large, near-identical, day-stale responses served fresh out of
Postgres every single time.

### 3a. Add cache headers to the API (local change)

In `supabase/functions/api/index.ts`, the `headers()` helper gains:

```ts
"Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
```

- `s-maxage` targets **shared caches only** — browsers still revalidate, so a person hitting
  refresh is never stuck with an old number.
- `stale-while-revalidate` means a Supabase outage serves slightly stale data instead of
  failing outright.
- **Do not** set this on `4xx`/`5xx` responses — caching an error is how a blip becomes an
  hour-long outage.

Deploy it: `npx supabase functions deploy api`.

### 3b. Create the Worker

```bash
npm create cloudflare@latest genie-cache -- --type=hello-world --ts --no-git --no-deploy
cd genie-cache
```

`wrangler.toml`:

```toml
name = "genie-cache"
main = "src/index.ts"
compatibility_date = "2026-09-10"

[vars]
ORIGIN = "https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api"
```

`src/index.ts`:

```ts
export default {
  async fetch(req: Request, env: { ORIGIN: string }, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const target = env.ORIGIN + url.pathname + url.search;

    // Only GETs are cacheable. Anything else goes straight through, untouched.
    if (req.method !== "GET") return fetch(target, req);

    const cache = caches.default;
    // Key on the ORIGIN URL, not the incoming one, so the worker hostname changing
    // does not silently invalidate every entry.
    const key = new Request(target, { method: "GET" });

    const hit = await cache.match(key);
    if (hit) return hit;                       // never touches Supabase

    const res = await fetch(target);
    const out = new Response(res.body, res);
    out.headers.set("Access-Control-Allow-Origin", "*");

    // Only cache successes. A cached 500 turns a blip into an hour of outage.
    if (res.status === 200) {
      out.headers.set("Cache-Control", "public, s-maxage=3600");
      // Respond first, write to cache after — the visitor never waits for the put.
      ctx.waitUntil(cache.put(key, out.clone()));
    } else {
      out.headers.set("Cache-Control", "no-store");
    }
    return out;
  },
};
```

```bash
npx wrangler deploy      # → https://genie-cache.<subdomain>.workers.dev
```

### 3c. Verify it caches

```bash
W=https://genie-cache.<subdomain>.workers.dev
curl -sI "$W/v1/traders?limit=3" | grep -i cf-cache-status    # MISS
curl -sI "$W/v1/traders?limit=3" | grep -i cf-cache-status    # HIT  ← the win
```

Then watch Supabase → Usage. Egress should flatten within a day.

### 3d. Point consumers at the Worker

Change the base URL in the genie app from the Supabase function to the Worker. Everything
else stays the same — same paths, same responses.

### 3e. Freshness after the nightly refresh

With a 1-hour TTL, new data appears at most an hour after the 06:00 UTC load. **If that is
acceptable, do nothing** — this is the simplest correct answer.

If you need it instant: a `*.workers.dev` URL has **no zone**, so Cloudflare's purge API does
not apply. Use a version in the cache key instead — a Workers KV value the nightly job bumps,
read by the Worker and appended to `key`. KV free is 100,000 reads/day against your ~7,200.

**Done when:** repeated requests return `cf-cache-status: HIT` and Supabase egress flattens.

**This alone may end the egress problem.** Phases 2-3 then become optional and unhurried.

---

## 4. Phase 2 — port the API to Workers · **~1 day · run both, diff, then decide**

**Do not cut over.** Run the Worker alongside the live function, both against the same
database, and diff every route. This is already the house method — `db.ts` records that the
Express→Edge port was *"a parallel implementation whose job is to produce byte-identical
output … Every route is diffed against it before it ships."* Third time, same technique.

### 4a. Scaffold

```bash
npm create cloudflare@latest genie-api -- --type=hello-world --ts --no-git --no-deploy
cd genie-api
npm i postgres
```

### 4b. Create the Hyperdrive config

Point it at the **transaction pooler (6543)**, not the direct connection — the direct one is
IPv6-only and Cloudflare cannot reach it:

```bash
npx wrangler hyperdrive create genie-db \
  --connection-string="postgresql://postgres.gxnonqlmujmtgczvhvzp:PASSWORD@aws-0-<region>.pooler.supabase.com:6543/postgres"
```

It prints an **id** — put that in `wrangler.toml`.

### 4c. `wrangler.toml`

```toml
name = "genie-api"
main = "src/index.ts"
compatibility_date = "2026-09-10"
compatibility_flags = ["nodejs_compat"]     # required for the postgres driver

[vars]
RATE_LIMIT_PER_MINUTE = "240"

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<the id wrangler printed>"
```

`GENIE_API_KEY` is a credential, so it goes in as a secret rather than a var:

```bash
npx wrangler secret put GENIE_API_KEY
```

### 4d. The code changes, file by file

| File | Change |
| --- | --- |
| `routes.ts` (3,417 lines) | **copy unchanged** |
| `router.ts` (46) | **copy unchanged** |
| `errors.ts` (123) | one `Deno.env.get("RATE_LIMIT_PER_MINUTE")` → read from `env` |
| `db.ts` (63) | import from `"postgres"` instead of the deno.land URL; take the connection string from `env.HYPERDRIVE.connectionString`; **keep `prepare: false`** |
| `index.ts` (126) | `Deno.serve(handler)` → `export default { fetch }`; drop `PORT`; thread `env` through |

The one structural wrinkle: `Deno.env` is read at **module scope** today, but Workers only
hands you `env` inside `fetch`. So `db.ts` and `errors.ts` need their client created lazily on
first request instead of at import. A single memoised `getSql(env)` covers both.

**`prepare: false` is not optional.** The transaction pooler does not support prepared
statements, and with it left on, queries fail *intermittently under load* rather than
immediately — the worst way to find out.

### 4e. Deploy to a temporary URL and diff

```bash
npx wrangler deploy        # → https://genie-api.<subdomain>.workers.dev — nothing public changes

S=https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1
W=https://genie-api.<subdomain>.workers.dev/v1

for r in health chains "tokens?limit=3" "traders?limit=3" \
         "traders?include=pnl,scorecard,wallets,trust&limit=2" \
         traders/frankdegods traders/frankdegods/pnl traders/frankdegods/portfolio \
         "traders/frankdegods/scorecard?tokens=3" traders/frankdegods/trust \
         "traders/frankdegods/positions?limit=3" "traders/frankdegods/transactions?limit=3" \
         traders/frankdegods/wallets; do
  if diff -q <(curl -s "$S/$r" | jq -S 'del(.asOf,.now)') \
             <(curl -s "$W/$r" | jq -S 'del(.asOf,.now)') >/dev/null; then
    echo "OK   $r"
  else
    echo "DIFF $r"
  fi
done
```

`asOf` and timestamps are stripped because they move between the two calls; everything else
must match exactly. **Same database, so any remaining difference is the port's fault and
nothing else's.**

### 4f. Measure CPU before trusting it

Workers **Free allows 10 ms CPU per request**, and your board routes serialise ~1 MB of JSON.
CPU time excludes waiting on the database but **not** serialisation.

```bash
npx wrangler tail genie-api --format=pretty     # watch for CPU-exceeded errors
```

Hit `/v1/traders?include=pnl,scorecard,wallets,trust&limit=50` while tailing. If it exceeds,
Workers Paid is **$5/month** and raises it to 30 s — still cheaper than Supabase Pro.

**Done when:** every route diffs clean and no route exceeds CPU.

---

## 5. Phase 3 — cut over · **~1 hour**

1. **Add your domain to Cloudflare** (Dashboard → Add a site → update nameservers at your
   registrar). Only needed now, not for Phases 1-2.
2. **Route the Worker at it** — `wrangler.toml`:
   ```toml
   [[routes]]
   pattern = "api.yourdomain.com/*"
   custom_domain = true
   ```
   then `npx wrangler deploy`.
3. **Point the genie app** at the new hostname.
4. **Re-point the Helius webhook** — either at a ported `helius-webhook` Worker (155 lines,
   3 `Deno.*`, identical substitutions) or leave it on Supabase, which is fine: it is a *write*
   path and contributes little egress.
5. **GitHub Actions secrets** — if Postgres has not moved, **nothing changes here at all**.
   The loaders connect straight to the database and never went through the function.
6. **Leave the Supabase function deployed and idle for a week.**

**Rollback is one DNS change** for as long as that function exists. Do not delete it early.

---

## 6. What is still on Supabase after all this

Worth being explicit, because "migrated to Cloudflare" will otherwise be misread:

| Still Supabase | Now Cloudflare |
| --- | --- |
| **Postgres** — every table, view, migration | the API, at the edge |
| `helius-webhook` (unless ported) | response caching |
| The nightly GitHub Actions loaders' target | backups in R2 |

Phases 0-3 change **who talks to the database**, not the database. That is the entire reason
the data is not at risk.

---

## 7. Phase 4 — where Postgres lives · **a separate decision**

Caching does not shrink anything, so the **0.92 / 0.5 GB size overage survives all of the
above.** Decide this on its own, once Phases 0-3 are stable.

| Option | Fits 0.92 GB | Egress | Cost | Note |
| --- | --- | --- | --- | --- |
| **Supabase Pro** | 8 GB ✅ | ~250 GB ✅ | $25/mo | zero migration; daily backups included |
| **Supabase Free** | ❌ 184% over | ✅ once cached | free | needs ~420 MB pruned — costs Axis 6 history |
| **Oracle Cloud Always Free** | ✅ ~200 GB | ✅ ~10 TB | free | strongest free option; ARM capacity often unavailable |
| **VPS** (Hetzner et al) | ✅ 40 GB | ✅ ~20 TB | ~€4/mo | cheaper than Pro; you run backups and updates |
| **Neon** | ✅ paid | — | ~$19/mo | free tier ~0.5 GB, so it does **not** fit free |

If it does move: `pg_restore` the Phase 0 dump, update the Hyperdrive connection string and
the two GitHub secrets, and **run the Phase 4e diff harness again** before pointing anything
at it.

---

## 8. Risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| **10 ms CPU on Workers Free** | board routes serialise ~1 MB of JSON | measure in 4f. Workers Paid $5/mo if exceeded |
| **Hyperdrive free cap: 100k queries/day** | the rate limiter adds a `bump_rate_limit()` call per request, so ~2 queries per request | ~14.4k/day against 100k — fine, but it scales with traffic |
| `postgres.js` under `nodejs_compat` | driver behaviour differs from Deno | the 4e diff catches it before anyone sees it |
| **Caching an error** | a 500 cached for an hour | only `status === 200` is cached (§3b) |
| **Stale data after refresh** | up to 1 hour | accept it, or version the cache key (§3e) |
| **Size overage unfixed** | caching changes nothing | §7 — a real, separate decision |

---

## 9. Order, and what each buys

| # | Step | Effort | Buys |
| --- | --- | --- | --- |
| **0** | Back up · verify · kill webhook · disable crons (§2) | ~45 min | **everything after is reversible** |
| **1** | Worker cache in front of Supabase | ~1 hour | most of the egress, immediately, no port |
| **2** | Port to Workers + Hyperdrive, diff | ~1 day | independence from Supabase compute |
| **3** | Cut over, keep the old one warm | ~1 hour | one-DNS-change rollback |
| **4** | Decide the database host | varies | fixes the 184% size overage |

**Phase 0 is urgent. Phase 1 is the one that pays.** If the cache solves egress on its own,
stopping after Phase 1 is a perfectly good outcome — the only thing still outstanding would be
the size decision in §7.
