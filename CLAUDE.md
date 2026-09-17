# genie-fomo-api — agent index

Read this before exploring. It answers what past sessions spent ~500k tokens rediscovering.

## What is live

Three Supabase Edge Functions, one Postgres, and (since 17 Sep 2026) one Cloudflare Worker in shadow.
v1: `https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api`. v2: `https://genie-copy-trading-api.agent-73b.workers.dev/v2` (same database via Hyperdrive `genie-copy-trading-db`, caching disabled).

| Path | What |
|---|---|
| `supabase/functions/api/` | the read API: `app.ts` (`handle`: auth, rate limit, 15 s timeout race), `index.ts` (Deno entry: builds the client, serves), `router.ts`, `errors.ts`, `db.ts` (`sql` is a Proxy over the per-request `AsyncLocalStorage` store, falling back to `setDefaultSql`), `config.ts` (`cfg(name)`: store env, then `Deno.env` — the only place `Deno` is touched outside `index.ts`), `routes.ts` (barrel) |
| `supabase/functions/api/routes/*.ts` | one module per route family (below) |
| `supabase/functions/api/shared/*.ts` | helpers used by 2+ families; `vocabulary.ts` is the published word list; `aum-rules.ts` the pure /aum rules |
| `supabase/functions/aum-sample/` | the balance sampler; `value.ts` holds the price ceilings. Fired every 5 min by `pg_cron` (`supabase/migrations/20260916120000_aum_sample_schedule.sql`) |
| `supabase/functions/helius-webhook/` | Solana transfer push receiver |
| `worker/` | the Cloudflare port (`docs/CLOUDFLARE_MIGRATION.md`): **deployed in shadow** (`npx wrangler deploy` from `worker/`; CI deploys on push when `CLOUDFLARE_DEPLOY=true`). `/webhook` and `/sample` + `scheduled` (`sampler.ts` is the twin of `aum-sample/index.ts`: edit both); `/v2/*` via `api.ts`, which runs the SAME `supabase/functions/api` modules inside `runWith({ sql, env })`. Keep postgres.js `fetch_types` on: arrays break without it |
| `supabase/functions/_shared/chain_reads.ts` | balance reads. **Twin of `scripts/lib/chain_reads.mjs`: edit both.** |
| `supabase/migrations/` | schema; check constraints are the only SQL-enforced vocabulary |
| `scripts/*.mjs` | Node loaders run by `.github/workflows/refresh.yml` nightly 06:00 UTC |
| `scripts/lib/ts/` | `transactions.ts`, `settings.ts`: compiled by `npm run build` to `scripts/lib/dist/` for three loaders. Not the API |
| `loaders/*.py` | directory build, DB load, trades (fomoapi) |
| `docs/` | design docs and runbooks; `openapi.yaml` is the API reference (lint: `npx @redocly/cli lint docs/openapi.yaml`); `API_VALIDATION_FLAGS_17_SEP.md` the open validation gaps; `REVIEW_EFFICIENCY_17_SEP.md` is the ranked optimisation list; `LAUNCH_METADATA.md`, `R4_ROBINHOOD_PRICES.md` record measured sources; `docs/DECISIONS.md` holds the long rationale comments moved out of the code (`See docs/DECISIONS.md#dNNN`) |
| `docs/consumer/` | acceptance suites, field contracts, the Genie app team's reports |
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
| `/:handle/aum`, `POST /traders/aum` | `routes/aum.ts` (rules in `shared/aum-rules.ts`) |
| `/:handle/aum/history`, `POST /traders/aum/history` | `routes/aum-history.ts` (built series over `aum_history` + rollup views; step/window rules in `shared/aum-history-rules.ts`) |
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
deno task check      # typecheck gate: no NEW errors vs scripts/typecheck_baseline.txt (baseline is empty: keep it so)
deno task test       # pure-function tests
npx tsc -p worker/tsconfig.json                    # the Worker; `cd worker && npx wrangler deploy --dry-run --outdir dist` bundles it
./scripts/smoke.sh   # 8 checks against production
./scripts/acceptance_capture.sh $BASE captures/x   # 72-file normalised capture; diff two runs
npm run build        # scripts/lib/ts -> scripts/lib/dist for the loaders
```

Deploy: `npx supabase functions deploy api --project-ref <ref> --no-verify-jwt` (same for `aum-sample`, `helius-webhook`). After any deploy, run smoke and test `/v1/health` specifically; its four queries are sequential on purpose.

## Working rules for this repo

- Grep before reading. Never read a whole route module; the largest is ~50 KB.
- Rationale lives in `docs/DECISIONS.md`; the code keeps one sentence and a pointer. Do not paste essays back into the code.
- `null` means absent, zero means zero. Never coerce a missing figure to 0.
- No tool can edit `.env.example` here; ask the user.
- Current work: `docs/TO-DO-BEFORE-MIGRATION.md` (consumer asks, P0 first) then `docs/CLOUDFLARE_MIGRATION.md`.
