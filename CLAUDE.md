# genie-fomo-api — agent index

Read this before exploring. It answers what past sessions spent ~500k tokens rediscovering.

## What is live

One Cloudflare Worker (`genie-copy-trading-api`) and one Postgres on Supabase, reached through Hyperdrive
`genie-copy-trading-db` (direct IPv6 host, caching disabled). **v2 is the product:** `https://genie-copy-trading-api.agent-73b.workers.dev/v2`.
v1 (`https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api`) is the frozen 16 Sep 2026 Supabase deploy; nothing new lands there.
Every loader is a Worker cron job (`worker/src/jobs/*`, table in `worker/src/index.ts`); GitHub Actions is CI/CD only.
Balance history is BUILT (`aum_history`, hourly) and the current value is live (`aum_live`), not sampled.
EVM data: Bitquery. Solana: Helius. Prices: DexScreener (+ Binance for quote assets). No free public RPC from the Worker.

| Path | What |
|---|---|
| `supabase/functions/api/` | the read API: `app.ts` (`handle`: auth, rate limit, 15 s timeout race), `index.ts` (Deno entry: builds the client, serves), `router.ts`, `errors.ts`, `db.ts` (`sql` is a Proxy over the per-request `AsyncLocalStorage` store, falling back to `setDefaultSql`), `config.ts` (`cfg(name)`: store env, then `Deno.env` — the only place `Deno` is touched outside `index.ts`), `routes.ts` (barrel) |
| `supabase/functions/api/routes/*.ts` | one module per route family (below) |
| `supabase/functions/api/shared/*.ts` | helpers used by 2+ families; `vocabulary.ts` is the published word list; `aum-rules.ts` the pure /aum rules |
| `supabase/functions/aum-sample/` | v1's sampler (retired: pg_cron unscheduled 18 Sep); `value.ts` still holds the price ceilings the SQL functions cite |
| `supabase/functions/helius-webhook/` | Solana transfer push receiver |
| `worker/` | THE deployment (`npx wrangler deploy` from `worker/`; CI deploys on push when `CLOUDFLARE_DEPLOY=true`). `src/index.ts`: `JOBS` cron table (strings must match `wrangler.toml` [triggers]) and `POST /jobs/<name>` behind `JOB_SECRET`; `src/api.ts` runs the `supabase/functions/api` modules inside `runWith({ sql, env })`; `src/webhook.ts` Helius push (+ `aum_live_refresh`); `src/jobs/*.ts` one sliced, resumable loader per source with a `-core.ts` of pure helpers. Keep postgres.js `fetch_types` on: arrays break without it |
| `supabase/functions/_shared/` | providers for the jobs: `bitquery.ts` (client + EVM balances), `transactions.ts` (transfers), `dexscreener.ts`, `pumpfun.ts`, `solana_pda.ts`, `settings.ts` (EVM_CHAINS); `chain_reads.ts` is LEGACY RPC for v1 only |
| `supabase/migrations/` | schema, all applied; check constraints are the only SQL-enforced vocabulary. `aum_history_build` and `aum_live_refresh` hold valuation SQL |
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
| `ROUTE_TIMEOUT_MS = 15000`, `BATCH_MAX_COST = 50` | `api/app.ts` |
| rate limit 240/min, Postgres-backed `bump_rate_limit()` | `api/errors.ts`, migration `20260908090000_rate_limits.sql` |
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
API_VERSION=v2 deno task smoke $WORKER_URL         # 8 checks (dataState degraded is by design while scorecards are stale)
deno task capture $BASE captures/x                 # 72-file normalised capture; diff two runs
npx @redocly/cli lint docs/openapi.yaml
```

Deploy: `cd worker && npx wrangler deploy` (or push with `CLOUDFLARE_DEPLOY=true`). Migrations: `npx supabase db push --db-url <session pooler url>` (the user runs it). A job on demand: `POST $WORKER_URL/jobs/<name>` with `x-job-secret`. Do NOT redeploy the v1 Supabase functions.

## Working rules for this repo

- Grep before reading. Never read a whole route module; the largest is ~50 KB.
- Rationale lives in `docs/DECISIONS.md`; the code keeps one sentence and a pointer. Do not paste essays back into the code.
- `null` means absent, zero means zero. Never coerce a missing figure to 0.
- No tool can edit `.env.example` here; ask the user.
- Jobs never call a free public RPC; EVM goes through `_shared/bitquery.ts`, Solana through Helius. Job strings in `index.ts` and `wrangler.toml` must match character for character.
- Current state: v2 handed to the app team 18 Sep 2026 (`docs/consumer/v2-handoff/`). Open: rotate secrets, retire v1 when consumers have moved.
