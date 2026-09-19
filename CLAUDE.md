# genie-fomo-api — agent index

Read this before exploring. It answers what past sessions spent ~500k tokens rediscovering.

## What is live

One Cloudflare Worker (`genie-copy-trading-api`) and one Cloudflare D1 database (`genie-copy-trading`,
binding `DB`). **v2 is the product:** `https://genie-copy-trading-api.agent-73b.workers.dev/v2`.
Postgres, Supabase and Hyperdrive are GONE from the request path as of 17 Sep 2026: the data was
exported and imported into D1 (31 tables, 1.29M transactions), every statement is SQLite dialect,
and the Worker holds only the `DB` binding. v1 (Supabase: the edge functions, the Postgres and the GitHub nightly loaders) was SUNSET on
19 Sep 2026: its code, its 55 Postgres migrations and the one-off export tools were removed from the tree
(git history keeps them: last present at `6a08917`). The folder is still named `supabase/functions/` only
because 166 imports say so; nothing in it runs on Supabase.
Every loader is a Worker cron job (`worker/src/jobs/*`, table in `worker/src/index.ts`); GitHub Actions is CI/CD only.
Balance history is BUILT (`aum_history`, hourly) and the current value is live (`aum_live`), not sampled.
EVM data: Bitquery. Solana: Helius. Prices: DexScreener (+ Binance for quote assets). No free public RPC from the Worker.

| Path | What |
|---|---|
| `supabase/functions/api/` | the read API: `app.ts` (`handle`: auth, rate limit, 11 s whole-request ceiling), `router.ts`, `errors.ts`, `db.ts` (`sql` is a Proxy over the per-request `AsyncLocalStorage` store, falling back to `setDefaultSql`), `config.ts` (`cfg(name)`: store env, then `Deno.env` for the tests), `routes.ts` (barrel) |
| `supabase/functions/api/routes/*.ts` | one module per route family (below) |
| `supabase/functions/api/shared/*.ts` | helpers used by 2+ families; `vocabulary.ts` is the published word list; `aum-rules.ts` the pure /aum rules |
| `supabase/functions/aum-sample/value.ts` | the price ceilings and the suspect-price rules (`MAX_PRICE_PER_TOKEN`, `MAX_POSITION_USD`); the sampler it belonged to is gone |
| `worker/` | THE deployment (`npx wrangler deploy` from `worker/`; CI deploys on push when `CLOUDFLARE_DEPLOY=true`). `src/index.ts`: `JOBS` cron table (strings must match `wrangler.toml` [triggers]) and `POST /jobs/<name>` behind `JOB_SECRET`; `src/api.ts` runs the `supabase/functions/api` modules inside `runWith({ sql, env })`; `src/webhook.ts` Helius push (+ `aum_live_refresh`); `src/jobs/*.ts` one sliced, resumable loader per source with a `-core.ts` of pure helpers. |
| `supabase/functions/_shared/` | providers for the jobs: `bitquery.ts` (client + EVM balances), `transactions.ts` (transfers), `dexscreener.ts`, `pumpfun.ts`, `solana_pda.ts`, `settings.ts` (EVM_CHAINS); `chain_reads.ts` is LEGACY RPC for v1 only |
| `worker/d1/migrations/` | THE schema: `0001_schema.sql` (30 tables), `0002_views.sql` (12 views), then fixes. Apply with `npx wrangler d1 migrations apply genie-copy-trading --remote`. `worker/d1/SCHEMA_MAP.md` maps every Postgres object to its D1 form |
| `worker/src/d1.ts`, `worker/src/sql.ts` | the postgres.js-shaped shim over D1 (`jobSql(env)`); `docs/D1_MIGRATION.md` holds its rules and the SQLite dialect cheatsheet |
| `worker/src/jobs/valuation.ts` | `buildAumHistory` and `refreshAumLive` — the two Postgres SQL functions, now TypeScript |
| `scripts/` | Deno tools: `smoke.ts`, `acceptance_capture.ts`, `typecheck_gate.ts` (`deno task smoke|capture|check`) |
| `docs/` | design docs and runbooks; `openapi.yaml` is the API reference (lint: `npx @redocly/cli lint docs/openapi.yaml`); `API_VALIDATION_FLAGS_17_SEP.md` the open validation gaps; `REVIEW_EFFICIENCY_17_SEP.md` is the ranked optimisation list; `LAUNCH_METADATA.md`, `R4_ROBINHOOD_PRICES.md` record measured sources; `docs/DECISIONS.md` holds the long rationale comments moved out of the code (`See docs/DECISIONS.md#dNNN`) |
| `docs/consumer/` | acceptance suites, field contracts, the Genie app team's reports; `v2-handoff/` is what they receive |
| `tests/` | `deno task test` — pure-function tests, no database |

## Route → file

| Route | Module |
|---|---|
| `GET /v1/chains` | `routes/chains.ts` |
| `GET /v1/traders`, `/:handle`, `/:handle/trust`, `GET+POST /:handle/wallets` | `routes/traders.ts` |
| `/:handle/portfolio`, `/:handle/positions`, `POST /traders/positions` | `routes/positions.ts` |
| `/:handle/scorecard`, `/:handle/pnl` | `routes/scorecard.ts` (bodies in `shared/scorecard-core.ts`, `shared/pnl-core.ts`) |
| `/:handle/transactions`, `/:handle/trades` | `routes/transactions.ts` |
| `/v1/tokens`, `/:address`, `/:address/activity`, `/momentum` | `routes/tokens.ts` |
| `/:address/prices`, `POST /tokens/prices` | `routes/token-prices.ts` (step/window rules in `shared/series-rules.ts`; candle views in migration `20260918020000`) |
| `/:handle/aum`, `POST /traders/aum` | `routes/aum.ts` (rules in `shared/aum-rules.ts`) |
| `/:handle/aum/history`, `POST /traders/aum/history` | `routes/aum-history.ts` (built series over `aum_history` + rollup views; step/window rules in `shared/aum-history-rules.ts`) |
| `/:handle/aum/now`, `POST /traders/aum/now` | `routes/aum-history.ts` (the `now` block alone, from `aum_live`; the same block rides on every `/aum/history` answer) |
| `GET /v1/fields` | `routes/fields.ts` (data in `shared/vocabulary.ts`) |
| `GET /v1/health` | `routes/health.ts` |
| `GET /v1/events` | `routes/events.ts` (keyset feed over transfers, swaps, readings) |
| `/:handle/flow`, `POST /traders/flow` | `routes/flow.ts` (Solana net flow since a time; `holdings_live` view) |
| `GET /v1/creators/:address` | `routes/tokens.ts` (dev ledger from `creators`) |
| `GET /v1/market/regime` | `routes/market.ts` (cohort reading, 60 s cache) |

Router scores by literal-segment specificity, so registration order never matters.

**Versions:** routes are registered under `v1`; the router also matches `v2` (`router.ts`
`requestVersion`/`rewriteVersion`), and every response's `/v1/` links are rewritten to the
requested version at serialisation in `app.ts`. v1 = Supabase, v2 = the Cloudflare Worker,
which refuses `/v1/*` with a 404 pointing at `/v2`. `/health.apiVersion` says which answered.
Scripts take `API_VERSION=v2` (`smoke.sh`, `acceptance_capture.sh`, which folds v2 links back
to v1 so the two deployments diff).

## Constants that matter

| Constant | Where |
|---|---|
| `PRICED_FLOOR = 0.25` (count share, applied at read time only) | `shared/aum-rules.ts` |
| `MAX_PRICE_PER_TOKEN`, `MAX_POSITION_USD` | `aum-sample/value.ts` (twin in `scripts/load_aum_samples.mjs`) |
| `ROUTE_TIMEOUT_MS = 11000` (the WHOLE request, rate check included; the app gives up at 12 s), `BATCH_MAX_COST = 50` | `api/app.ts` |
| rate limit 240/min, one atomic upsert into `rate_limits` on D1, 2 s deadline, fails open | `api/errors.ts` (`checkRateWithin`) |
| `AUM_SAMPLE_*`, `WALLET_SUBMIT_SECRET`, live-read timing | `routes/aum.ts`, `routes/traders.ts` |

## Adding a vocabulary word (do this first, ship second)

1. Add it to `shared/vocabulary.ts` and bump `version`.
2. If the database stores it, extend the check constraint in a new migration.
3. Add the line to `docs/consumer/Field_Contracts.md`.
4. `deno task test` — `tests/vocabulary_test.ts` fails if SQL can store a word the API does not publish.

The consumer's build fails on an unpublished word, so this order is a contract.

## Verify

```bash
deno task check                                    # typecheck gate: no NEW errors (baseline empty: keep it so)
deno task test                                     # pure-function tests
npx tsc -p worker/tsconfig.json                    # the Worker; `cd worker && npx wrangler deploy --dry-run --outdir dist` bundles it
API_VERSION=v2 deno task smoke $WORKER_URL         # 10 checks, incl. the app's roster page at limit=100 (dataState degraded is by design while scorecards are stale)
deno task capture $BASE captures/x                 # 74-file normalised capture; diff two runs
npx @redocly/cli lint docs/openapi.yaml
```

Deploy: `cd worker && npx wrangler deploy` (or push with `CLOUDFLARE_DEPLOY=true`). Migrations: `cd worker && npx wrangler d1 migrations apply genie-copy-trading --remote` BEFORE the code that needs them (CI does not apply them). A job on demand: `POST $WORKER_URL/jobs/<name>` with `x-job-secret`.

## Working rules for this repo

- Grep before reading. Never read a whole route module; the largest is ~50 KB.
- Rationale lives in `docs/DECISIONS.md`; the code keeps one sentence and a pointer. Do not paste essays back into the code.
- `null` means absent, zero means zero. Never coerce a missing figure to 0.
- No tool can edit `.env.example` here; ask the user.
- Jobs never call a free public RPC; EVM goes through `_shared/bitquery.ts`, Solana through Helius. Job strings in `index.ts` and `wrangler.toml` must match character for character.
- Provider traps, all three diagnosed 17 Sep 2026 and all three silent until then:
  **Bitquery** reports a GraphQL error as `{"data": null, "errors": […]}` with HTTP 200 — the reply
  guard must accept a null `data` or every message is lost; its cubes differ, so `Currency { Native }`
  exists on Balances and NOT on DEXTrades; and its plan limits requests per minute, so
  `bitquery()` paces at ~50/min and waits out a rate-limit reply.
  **Binance answers 403 to this Worker** (it refuses Cloudflare egress), so `quote_prices` falls back
  to Bybit, whose candle rows carry the open at index 0 and the close at index 4 exactly as a kline does.
- A job that counts "errored" must count "unresolved" apart from it: a source answering "nothing here"
  is not a failure, and lumping the two tripped the all-failed guard and hid a real bug (`tokens`, 17 Sep).
- SQLite dialect only: no `::` casts, `filter (where`, `distinct on`, `lateral`, `unnest`, `array_agg`, `= any(`, `interval`, `now()`, `date_trunc`, `numeric`, `ctid`. Timestamps are ISO-8601 UTC TEXT, booleans 0/1, JSON is TEXT. 100 bound parameters and 30 s per statement; D1 runs one statement at a time, so small and many beats large and few.
- D1 charges CPU per query and has no planner hints: a view that aggregates the whole table before the caller's filter will exceed the limit (`holdings_current`, 17 Sep). Write correlated maxima that an index can seek.
- **Id lists (`in (${ids})`) are bound by the shim, `compileToFit` in `worker/src/d1.ts`:** one `?` per id while the
  statement fits D1's 100, ONE `json_each` parameter when it would not. Both halves are incidents of 19 Sep: always-N
  took the trader list down at the app's page size of 100; always-`json_each` (live 10:33 UTC until the hybrid) stopped SQLite
  pushing the filter into aggregate views, so every sampler chunk scanned all of `trades`. Never filter an AGGREGATE
  VIEW by a list or a subquery — ask per key with correlated seeks (`knownChainsFor` in `shared/chains.ts`).
- **The plan audit** (`tests/routes_sql_test.ts`, part of `deno task test`) EXPLAINs every statement every route issues
  and fails on a whole-table read that is not in `tests/accepted_whole_reads.ts`. Shrink that list, never grow it blind.
  D1 has no statistics, so local SQLite plans match; a unary `+col` keeps the planner off a low-cardinality index.
- Slow (>= 1 s) and failed statements are logged with their SQL by the shim (`d1 slow:` / `d1 failed`): tail for those first.
- **A statement that needs EVERY current holding reads `currentHoldings(sql)`** (`supabase/functions/_shared/current_holdings.ts`),
  never the `holdings_current` view: the view is written for ONE trader, and read whole it tests every chain row ever
  captured (~950,000) to keep ~40,000 — 6 s a statement in three jobs, behind which every API statement queued. The
  helper asks per (trader, chain) pair and cannot be flattened into its caller (`limit -1`). A statement naming one
  trader keeps the view. Its rows come in another order than the view's: order by a total key.
- **A scan is bounded by the rows it may EXAMINE** (a rowid range, a fixed page), never by a property of the data: the
  swaps job's "newest unchecked" and then "last 14 days" both read ~1.25 M rows because nearly every transfer is recent.
- **Local SQLite and D1 do not always pick the same plan**, and the plan audit cannot see it. Where a join order matters,
  state it: `cross join`, a unary `+`, the driving table first. D1's `sqlite_version()` is not recorded anywhere yet.
- A cron's wallTime must stay well under its period, and its cost is measured end to end (not one step) and
  against API p90, not only its own gauge: the 5-minute live top-up ran 231–625 s and reset D1's isolate.
- ONE price ladder, `shared/price-ladder.ts`, read at REQUEST time: pegged -> `token_price_stats`
  -> `token_prices` (<= 7 days) -> `token_info`. `/positions` used to serve the price frozen into
  `holdings` at the last balance read (a ~9 h sweep), which is why one coin showed three prices on
  three traders' lists. Do not reintroduce a second ladder; `refreshAumLive` uses the same order.
- A figure carries the coverage it was built from. `confidence()` in `shared/aum-history-rules.ts`
  runs at READ time on `pricedPositions`/`totalPositions`: >= 0.25 a figure, 0.05-0.25 `partial`,
  below 0.05 withheld with `partialUsd`. Read time is the point — the stored series is judged
  without a rebuild. 78% of stored valued hours are under 0.25.
- Current state (19 Sep 2026, evening): the 100-bind outage is fixed in code and the deck's roster read answers, but
  production ran a regression of mine from 10:33 UTC (always-`json_each`) until the hybrid deploy; check `npx wrangler
  deployments list` against `git log` before believing anything is live — a push to `main` that touches `worker/**`,
  `supabase/functions/**`, `tests/**` or `scripts/**` IS a production deploy (the migration branch was merged and
  deleted on 19 Sep; work on a feature branch and merge), and CI does NOT apply D1 migrations (apply them first: 0007, 0011-0015 are new today).
  What changed today is in `tasks/todo.md` (review section) and `docs/consumer/reply-to-trader-service-v1.md`.
  A2 (every trader's live figure hourly) stays WITHDRAWN: `oldestLiveHours` rises by design. GMGN capacity is ~1,100
  coins a day against ~31,000 held, so per-coin `fetchedAt` is the truth, not "nightly". Owner-only and still open:
  Helius credits (dashboard), disable `main`'s v1 nightly refresh (`gh workflow disable refresh.yml` — it spends the
  same provider keys), rotate secrets, make the repo private, set a `JOB_SECRET`, two small indexes for `/market/regime`.
