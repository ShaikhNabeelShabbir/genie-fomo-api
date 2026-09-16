# genie-fomo-api — project analysis and review of the Cloudflare migration plan

## Context

The user asked for an analysis of the whole project and of `CLOUDFLARE_MIGRATION.md`, the plan
to move the service off Supabase Edge Functions onto Cloudflare Workers. This is an assessment,
not a code change. Part 1 is what the project is and where it is weak. Part 2 is the review of
the migration doc, with every measured claim re-checked against the tree and every Cloudflare
platform claim re-checked against current Cloudflare docs (2026-09-16). Part 3 lists optional
follow-up actions; nothing is done until approved.

---

## Part 1 — What the project is

### 1.1 One live system, one dead one, in the same repo

The repo carries **two complete generations** of the service.

| Generation | Where | Status |
|---|---|---|
| **Supabase Edge Functions + Postgres** | `supabase/functions/{api,aum-sample,helius-webhook}`, 31 migrations | **Live.** README: "Nothing else is deployed." Last touched 2026-09-16 |
| **Express/Node app** | `src/` (5,498 lines), `Dockerfile`, `fly.toml`, `render.yaml`, `scripts/smoke.sh`, `data/wallet.full.data.json` | **Dead as a deploy target** since ~2026-08-31; `src/` last touched 2026-09-04 |

The dead generation survives only because three nightly loaders import from its compiled
`dist/` (`scripts/backfill_transactions.mjs:18`, `load_token_supply.mjs:17`,
`resolve_trade_chains.mjs:21`), which is the sole reason `refresh.yml` runs `npm run build`.
Fourteen routes exist in both generations under the same path with **different code and
different data sources** (Express resolves live against fomoapi/Helius/Bitquery per request;
Deno answers from Postgres), so the same URL can return different numbers depending on which
one you hit. The migration doc does not mention `src/` at all.

### 1.2 The live architecture

- **`api`** (7,827-line `routes.ts` + 4 small files): 18 GET + 3 POST routes, all inline SQL
  via `postgres.js` from `deno.land/x`, hand-rolled specificity router, 15 s per-route timeout
  race, request ids, stable error codes, batch cost accounting. Rate limiter is
  **Postgres-backed** (`bump_rate_limit()` plpgsql, `errors.ts:135`) because an in-memory Map
  never bound across isolates. Only one outbound call in the whole read path: the `/aum`
  live read-through to the sampler (`routes.ts:5817`).
- **`aum-sample`** (486 lines): reads a slice of 10 traders' balances straight off chain
  (Helius + keyless public EVM RPCs via `_shared/chain_reads.ts`), prices them from tables
  already in Postgres, upserts `aum_samples` / `aum_chain_samples`. Fired every 5 min by
  `pg_cron` → `pg_net` → HTTP, with the URL and secret in Supabase Vault.
- **`helius-webhook`** (155 lines): push receiver, one batched upsert into `transactions`,
  ~290k rows/week, idempotent on a computed `transfer_key`.
- **Nightly loaders**: `refresh.yml` at 06:00 UTC runs 3 Python + ~12 Node scripts against
  Postgres directly. **This cron silently stopped for six days in September**
  (`20260916120000_aum_sample_schedule.sql:3-7`), which is why sampling moved into `pg_cron`.
- **Schema**: 20 tables, 4 plain views (`holdings_current` redefined 4 times, precedence
  flipped in the last one), 3 functions, 1 cron job, no triggers, no matviews.
  `transactions` is 1.7 GB of a 2 GB database.

### 1.3 Strengths worth preserving

- Unusually well-reasoned code comments: every non-obvious constant records the incident that
  set it (`prepare: false`, `max: 2`, the 15 s timeout, the $1bn position ceiling, the
  sequential `/health` queries). The migration doc's "what will bite you" section is drawn
  from these and is the best part of it.
- Strong data-integrity discipline: null-means-absent, coverage travels with every figure,
  refusals are machine words, `numeric` kept exact.
- Two written verification suites (50 acceptance tests, 150 field contracts) with measured
  results.

### 1.4 Weaknesses

**No automated tests at all.** Zero test files, no test runner, no `test` script. The
acceptance harness the docs cite (`collect.py`, `an_sc.py`, `an_aum.py`, `targeted.py`) is
**not in the repository** (`ACCEPTANCE_TEST_REPORT.md:485`: "in the session scratchpad").
`scripts/smoke.sh` targets the dead Express API on port 8787. The only live production
assertion is `staleness.yml` curling `/health`.

**Duplication across three axes.** Express ↔ Deno routes (14 paths); `scripts/lib/chain_reads.mjs`
↔ `supabase/functions/_shared/chain_reads.ts` and `scripts/load_aum_samples.mjs` ↔
`aum-sample/index.ts` (both documented as line-for-line ports that must be edited together);
the `transfer_key` md5 expression written out three times.

**Single-file API.** `routes.ts` is 7,827 lines of inline SQL template literals with no data
layer, which is exactly what makes any SQL-dialect change (D1) a rewrite.

**Operational drift and hygiene** (all low severity individually):
- `supabase/.temp/*` is git-tracked (project ref, pooler host/user; no password).
- `.env.example:32-38` lists seven variables with no `=`, so it is not a valid dotenv.
- `scripts/solana_backfill_daemon.sh:22` hard-codes another developer's home directory.
- `data/snapshots/*.json` referenced by nothing; `build_directory.py`, `resolve_evm_swaps.mjs`
  superseded; `wrangler` is an orphan devDependency (commit 8d01092, no `wrangler.toml`).
- `index.ts:120-138` 404 hint list omits `/aum`, `/trades`, `/fields`, POST wallets.
- RLS enabled with zero policies on the first 10 tables; the 9 tables created after
  2026-09-08 have no RLS at all. Harmless while nothing uses the anon key, but inconsistent.
- Express app: 48 `any`, 15 bare `catch {}`, GraphQL built by string interpolation of
  user-supplied addresses (`resolvers.ts:116`, `transactions.ts:268`, `pumpfun.ts:202`),
  auth and CORS open by default. Moot if `src/` is retired.

---

## Part 2 — Review of CLOUDFLARE_MIGRATION.md

### 2.1 Verdict in one paragraph

The doc's shape is right: keep Postgres, port the three functions to Workers, use Cron
Triggers, prove it with the acceptance suite, run both in parallel before cutting over. Its
core recommendation (Option A over D1) is correct and well argued. But it is **not** "measured
against the running system" as it claims: several counts are wrong, two of its
driver-configuration instructions are the opposite of Cloudflare's guidance, the verification
step depends on a harness that is not in the repo, and it never asks the cheapest question,
which is whether the database needs to move at all.

### 2.2 Measured claims vs. the tree

| Claim | Actual | Verdict |
|---|---|---|
| 47 `Deno.*` references | 29 | wrong |
| 43 `Deno.env.get()` calls | 26 | wrong |
| `aum-sample/index.ts` 449 lines; total 9,093 | 486; 9,130 | stale |
| `= any(` ×40, `filter (where` ×59, `at time zone` ×5, `lateral` ×3, `to_char` ×2, `interval` ×2, `distinct on` ×1 | match | correct |
| `unnest` ×1 in `routes.ts` | 1 (plus one in `aum-sample`) | correct |
| code relies on `gen_random_uuid()` | 0 uses in functions; only a column default in a migration | overstated |
| `errors.ts` "unchanged" | imports the module-level `sql` singleton and reads env at load (`errors.ts:13,109`) | wrong |
| `router.ts`, `chain_reads.ts` port unchanged | true | correct |
| "harness scripts that take a base URL" exist | not in repo; `run_acceptance.sh` does not exist | wrong, blocks §12 |
| the 3 Worker layout lists `chain_reads.ts` under both `sampler/src` and `shared/` | inconsistent | minor |

### 2.3 Cloudflare platform claims vs. current docs

Checked by a subagent against developers.cloudflare.com on 2026-09-16.

**Wrong or outdated**
1. **`prepare: false` is "still required"** (§4.3, §16.3). The opposite: Hyperdrive over a
   direct connection supports named prepared statements and Cloudflare's postgres.js example
   uses the default `prepare: true`; `prepare: false` costs extra round-trips. It is only needed
   if Hyperdrive is (wrongly) pointed at the 6543 transaction pooler.
2. **`max: 1` "is correct here"** (§4.3). Cloudflare's example uses `max: 5` (Workers allow 6
   concurrent outbound connections). `max: 1` serialises every `Promise.all` of queries in a
   route. And the doc's "or per isolate, lazily" option triggers "Cannot perform I/O on behalf
   of a different request"; Cloudflare says create the client per request.
3. **postgres.js 3.4.4** (current pin) is below Hyperdrive's documented minimum of 3.4.5.
4. **Subrequest cap "50 free, higher on paid"** (§7, §16.4). Paid is 10,000 by default since
   2026-02-11, so the 40-subrequest slice is a non-issue.
5. **"Local development runs the real thing"** (§11). Default `wrangler dev` is local with no
   pooling and no caching; `--remote` writes to production.
6. **`ctx.waitUntil(sampleSlice())` in `scheduled`** (§7). Prefer `await`, so a failed slice
   shows as a failed invocation. Cron Triggers are limited per account (5 free / 250 paid).
7. **D1 bound-parameter limit "worth checking"** (§6.1): it is 100 per statement, so a 5-column
   multi-row VALUES insert caps at 20 rows.
8. Minor: "Deno has no equivalent of waitUntil" — Supabase exposes `EdgeRuntime.waitUntil()`.

**Correct**: direct port not pooler; CPU-time not wall-clock (30 s default, up to 300 s);
Cron Triggers 15 min wall; 128 MB; D1 10 GB paid; Hyperdrive bundled in the Workers plan;
`nodejs_compat` + npm `postgres`; secrets per Worker; `crypto.randomUUID`, `fetch`,
`AbortSignal.timeout` all portable.

### 2.4 Risks the doc does not mention

1. **Hyperdrive query caching is on by default** (60 s max-age, 15 s stale-while-revalidate)
   for any SELECT without a volatile function. Two concrete effects here:
   - `/aum?live=true` reads `aum_samples` right after the sampler writes it and can get the
     60-second-old row, so `liveRead: fetched` would carry the *previous* reading. Queries
     using `now()` are uncached, so this differs route by route, silently.
   - `bump_rate_limit()` is uncached only because plpgsql defaults to VOLATILE.
   Recommendation: create the Hyperdrive config with `--caching-disabled` for the cutover so
   the acceptance diff is apples-to-apples; add a cached binding for hot read-only routes later.
2. **Origin connection budget.** Hyperdrive opens up to ~100 connections per config. Supabase
   direct `max_connections` is 60 on Micro, 90 Small, 120 Medium, shared with the nightly
   loaders (`max: 3` each). The failure mode is `remaining connection slots`, which
   `classify()` maps to 429.
3. **Supabase direct host is IPv6-only** without the IPv4 add-on (`db.ts:16-19` already
   records this). Test `wrangler hyperdrive create` against it before anything else.
4. **`errors.ts` needs `sql` and env threaded in**, and `classify()`'s regexes match pg wire
   text; Hyperdrive's own error codes (2012 TLS, 2015 connect) would classify as 500 not 503.
5. **Hyperdrive max query duration is 60 s**; the once-seen 90 s `/health` pathology would now
   fail at Hyperdrive rather than the route timeout.
6. **Cron overlap.** No mutual exclusion between ticks; a slice over 5 min overlaps the next.
   Oldest-first rotation makes it mostly harmless, but a `sampled_at` claim in Postgres is
   cheap insurance.
7. **Shared egress IPs.** Workers `fetch` to keyless public EVM RPCs leaves from Cloudflare's
   shared ranges; IP-based throttling becomes unpredictable. `chain_reads.ts:64` already
   treats Robinhood's 403 as a 429.
8. **The Workers Rate Limiting binding is not a drop-in** (per-colo, eventually consistent,
   returns only success/fail). Keep the Postgres counter; it already produces the
   `limit/remaining/reset/scope` headers consumers are promised.
9. **Cutover Phase 2 to 3 gap.** The doc says the databases "diverge" at Phase 3, but the new
   database is stale from the moment of the dump: the webhook writes ~290k rows/week into the
   old one. Either do Phases 2 and 3 in one window or plan a second incremental copy of
   `transactions` and `aum_samples` at cutover.
10. **Per-isolate state** (`nativeCache`, `inFlight`, `hostQueue`) already misbehaves on Edge
    Functions; Workers isolates are no better. Not a regression, but not fixed by the move.

### 2.5 The strategic question it skips

The doc assumes Option A means "move Postgres off Supabase to Neon/Crunchy/RDS". It never
considers **Option A′: keep Postgres on Supabase, point Hyperdrive at it, and simply stop
deploying Edge Functions and the pg_cron job**. Cloudflare has an official Supabase guide for
exactly this. A′ deletes §4.1 (dump/restore), §13 Phases 2–3 (the "point of no easy return"),
the new hosting line item in §14, and risk 9 above. Rollback stays trivial for the entire
cutover because both runtimes read and write one database. The only new cost is possibly the
Supabase IPv4 add-on. The tradeoffs (Supabase Pro pricing vs Neon's cheaper tiers, tighter
connection budget on small compute) are real but second-order for a 2 GB read-mostly database.
**A′ should be the first step; moving hosts can be a separate, later decision.**

### 2.6 Project shape

Three Workers is more config surface than the code needs. **One Worker** exporting `fetch` and
`scheduled`, routing `/v1/*`, `/webhook`, `/sample` by path, means one secret set (removing
the `AUM_SAMPLE_SECRET` mismatch failure the doc itself warns about in §8), and lets the
`/aum` read-through call the sampler in-process via `ctx.waitUntil` with no HTTP hop. Split
into `api` + `jobs` with a service binding only if deploy cadence diverges.

### 2.7 Effort estimate

The doc's "about a fortnight" is reasonable for the port itself, but the real gate is §12
and the harness does not exist in the repo. **Rebuilding a runnable acceptance harness
(committed, taking a base URL) is a prerequisite, not a footnote**, and is probably 2–3 days
on its own. Without it the byte-level diff in §12 is a curl loop, which is fine for the five
traders listed but is not "150 of 150 fields".

---

## Part 3 — Recommended actions (optional, in priority order)

None of these are started. Approve any subset.

1. **Correct `CLOUDFLARE_MIGRATION.md`** — fix the counts in §1/§5, reverse the `prepare`/`max`
   guidance and pin postgres.js ≥3.4.5 in §4.3, update subrequest limits in §7/§16, fix §11
   local-dev claim, add sections on Hyperdrive caching, connection budget, IPv6, the Phase 2–3
   data gap, and add Option A′ to §2 as the recommended first step. Note `errors.ts` is not
   unchanged. Collapse §11 to one Worker or justify three.
2. **Commit a runnable acceptance harness** before any porting: a script under `scripts/`
   that takes `BASE` and emits a normalised JSON capture for the routes and traders in §12,
   so `diff before after` is real. Reuse the trader list and `del(.asOf,.liveRead)` rule
   already in §12.
3. **Repo hygiene**: add `supabase/.temp/` to `.gitignore` and untrack it; fix `.env.example`;
   delete `data/snapshots/`, `build_directory.py`, `resolve_evm_swaps.mjs`,
   `solana_backfill_daemon.sh` or fix its path; update the 404 hint list in `index.ts`;
   update `scripts/smoke.sh` to target the Supabase URL or delete it.
4. **Decide the fate of `src/`.** Either retire it (move the three `dist/` imports the loaders
   need into `scripts/lib/`, drop `Dockerfile`/`fly.toml`/`render.yaml`) or document that it
   is loader-support code only. Its 11 provider-scoped routes (hyperliquid/pumpfun/gmgn) are
   the only functionality not in the Deno API; confirm nobody uses them.
5. **Only then** start the port, in this order: `wrangler hyperdrive create` against the
   Supabase direct host (proves IPv6/IPv4 reachability, the one unknown that could change the
   plan) → webhook → sampler with `scheduled` → api with a per-request `Ctx` carrying `sql`
   and config → shadow run against the same database → acceptance diff → flip consumers.

## Verification (for whichever actions are approved)

- Action 1: re-run the count commands used here (`grep -ro 'Deno\.' supabase/functions | wc -l`
  etc.) and confirm every number in the doc matches; have a second reader check each
  Cloudflare claim against the cited URL.
- Action 2: run the harness against the live Supabase URL twice; the diff of two runs (after
  stripping the documented live fields) must be empty before it is trusted against a Worker.
- Action 3: `git status` clean, `.env.example` parses with a dotenv loader, `npm run smoke`
  passes against the live URL.
- Action 4: `refresh.yml` still runs green after the `dist/` imports move.
- Action 5: the §12 procedure, plus the by-hand checks it lists (`/health` sequential,
  `/fields` identical, 50-id batch, `?live=true` reaching the sampler, `409 address_in_use`).
