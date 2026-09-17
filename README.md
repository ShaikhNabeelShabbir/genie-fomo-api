# genie copy-trading API

A read API over ~450 crypto traders: who they are, what they hold, what they have made, and
what their balance has done over time, across Robinhood Chain, Ethereum, BSC, Base and Solana.
The directory started from fomo's leaderboard and also carries GMGN traders; more sources are
added as loader jobs, never as request-path calls.

Every route answers from Postgres. Every table is filled by a scheduled job on Cloudflare, so
a thousand visitors cost what one does and a request never waits on a third party.

| Deployment | Base URL | Status |
|---|---|---|
| **v2** Cloudflare Worker `genie-copy-trading-api` | `https://genie-copy-trading-api.agent-73b.workers.dev/v2/…` | **the product**, live since 17 Sep 2026 |
| v1 Supabase Edge Function | `https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api` | frozen at the 16 Sep 2026 deploy; kept until consumers have moved |

The app team's migration bundle is [`docs/consumer/v2-handoff/`](docs/consumer/v2-handoff/):
a guide, the OpenAPI spec, the v1-to-v2 diff and the live vocabulary snapshot.

---

## Contents

- [How it is put together](#how-it-is-put-together)
- [Repository layout](#repository-layout)
- [Every route](#every-route)
- [API reference (OpenAPI 3.0)](#api-reference-openapi-30)
- [Errors, rate limits and versions](#errors-rate-limits-and-versions)
- [The rules every answer follows](#the-rules-every-answer-follows)
- [The published vocabulary](#the-published-vocabulary)
- [Balance history and the live value](#balance-history-and-the-live-value)
- [Price history](#price-history)
- [Submitting a wallet](#submitting-a-wallet)
- [The jobs that fill the tables](#the-jobs-that-fill-the-tables)
- [Data sources](#data-sources)
- [The database](#the-database)
- [Running it locally](#running-it-locally)
- [Verification](#verification)
- [Deploying](#deploying)
- [Configuration](#configuration)
- [The documents](#the-documents)
- [Operational notes](#operational-notes)

---

## How it is put together

One Cloudflare Worker and one Postgres database. The Worker serves the API, receives Solana
pushes, and runs every loader as a cron job. Postgres stays on Supabase, reached through a
Hyperdrive connection to the direct host with query caching off. GitHub Actions is CI/CD only.

```
                     ┌──────────────────────────────────────────────────────┐
  consumer ─/v2/*───▶│ genie-copy-trading-api  (Cloudflare Worker)          │
                     │  fetch:     /v2/*  ·  /webhook (Helius)  ·  /jobs/* │
  Helius ──/webhook─▶│  scheduled: 14 loader jobs on staggered crons        │
                     └───────────────────────────┬──────────────────────────┘
                                                 │ Hyperdrive (direct host, no cache)
                     ┌───────────────────────────▼──────────────────────────┐
                     │ Postgres (Supabase)  traders · wallets · trades       │
                     │   holdings · transactions · token_price_hourly        │
                     │   aum_history · aum_live · token_info · …            │
                     └──────────────────────────────────────────────────────┘
                                                 ▲
                     ┌───────────────────────────┴──────────────────────────┐
                     │ GitHub Actions: typecheck, tests, Worker build,       │
                     │ deploy on push when CLOUDFLARE_DEPLOY=true            │
                     └──────────────────────────────────────────────────────┘
```

| Piece | What it does |
|---|---|
| `worker/src/api.ts` | Routes `/v2/*` to the API modules under `supabase/functions/api/`, one Postgres client per request inside `runWith({ sql, env })` |
| `worker/src/webhook.ts` | Helius push receiver. Upserts the transfers, then refreshes the live value of every trader whose wallet moved |
| `worker/src/jobs/*.ts` | The loaders: one module per source, each a sliced, resumable job that stops inside its budget and reports a summary |
| `worker/src/index.ts` | The cron table (`JOBS`) and the on-demand trigger `POST /jobs/<name>` behind `JOB_SECRET` |
| `supabase/functions/api/` | The route modules and shared rules. Runtime-agnostic: `db.ts` exposes `sql` from a per-request store, `config.ts` reads configuration from the same store |
| `supabase/functions/{api,aum-sample,helius-webhook}` as Deno entries | The frozen v1 deployment. Nothing new lands there |

### Why traders are found this way

fomo publishes an `evmAddress` and a Solana `address` for every user, and **those wallets hold
none of the trader's positions**: they are provisioned per-user wallets. What fomo *does*
publish is the exact size of every position, and that is a fingerprint:

```
fomo says:   10,957,270.2148 of PONS on Robinhood Chain
chain says:  10,957,873.4194 held by 0x0a6EBEd0…119E      (0.0055% off)
fomo says:   20,400,532.9971 of a second Robinhood token
chain says:  20,402,959.6921 held by 0x0a6EBEd0…119E      (0.0119% off)

two independent tokens, one address  →  confirmed
```

Position sizes carry 12+ significant digits, so one match is nearly unique and two are
certain. Resolution happens in the directory job; `/wallets` says how (`resolvedBy`).

---

## Repository layout

TypeScript and SQL only. The JavaScript and Python loaders, the shell tools and the nightly
GitHub workflow were retired on 17 Sep 2026 when their ports landed in `worker/src/jobs/`.

| Path | What lives there |
|---|---|
| `worker/` | The Worker: `wrangler.toml` (bindings, vars, the cron list), `src/index.ts` (cron table, job trigger), `src/api.ts`, `src/webhook.ts`, `src/helius.ts`, `src/sampler.ts` (manual `/sample` read), `src/db.ts`, `src/env.ts`, `src/jobs/*` |
| `worker/src/jobs/` | `directory`, `gmgn`, `scorecards`, `tokens`, `launches`, `transfers`, `wallets`, `quote_prices`, `prices`, `balances`, `fees`, `swaps`, `timing`, `aum_history`; each with a `-core.ts` of pure, tested helpers |
| `supabase/functions/api/` | The read API: `app.ts` (auth, rate limit, 15 s timeout race, version rewrite), `router.ts`, `errors.ts`, `db.ts`, `config.ts`, `routes/*.ts` (one module per family), `shared/*.ts` (rules, `vocabulary.ts`, batch and cursor envelopes) |
| `supabase/functions/_shared/` | Providers and chain helpers used by the jobs: `bitquery.ts`, `transactions.ts`, `dexscreener.ts`, `pumpfun.ts`, `solana_pda.ts`, `settings.ts`, `chain_reads.ts` (legacy RPC readers, v1 only) |
| `supabase/migrations/` | 49 migrations, all applied. Check constraints are the only SQL-enforced vocabulary |
| `scripts/` | Deno tools: `smoke.ts`, `acceptance_capture.ts`, `typecheck_gate.ts`, `lib/normalise.ts` |
| `tests/` | 166 pure-function tests, no database (`deno task test`) |
| `docs/` | `openapi.yaml` (the reference), design docs, runbooks, `DECISIONS.md` (the long rationale the code points at) |
| `docs/consumer/` | Acceptance suites, field contracts, the Genie app team's reports, our replies, and `v2-handoff/` |
| `.github/workflows/cloudflare.yml` | The only workflow: verify on every push, deploy when `CLOUDFLARE_DEPLOY` is `true`, optional acceptance diff on dispatch |
| `CLAUDE.md` | The index an agent reads first |

---

## Every route

30 operations. All GET unless marked. `:handle` accepts the handle, the display name, a
leading `@`, the stable UUID, or `trd_<uuid>`. Paths are shown with `/v2/`; v1 serves the
26 that existed on 16 Sep under `/v1/`.

### Traders

| Route | What it answers |
|---|---|
| `GET /v2/traders` | The directory. `?q=`, `?limit=` `?offset=` `?cursor=`, `?orderBy=` `?direction=` and range filters, `?include=pnl,scorecard,wallets,trust`, `?updatedSince=`, `?includeDelisted=true` |
| `GET /v2/traders/:handle` | Profile: identity, source (`fomoapi.io` or `gmgn`), rank, on-chain activity, stored counts, links |
| `GET /v2/traders/:handle/trust` | Internal-consistency checks, each named |
| `GET /v2/traders/:handle/wallets` | Resolved addresses with `walletState`, `resolvedBy`, chains seen, linked wallets |
| `POST /v2/traders/:handle/wallets` | Submit a wallet for a listed trader who has none. The only write; see [Submitting a wallet](#submitting-a-wallet) |

### Money

| Route | What it answers |
|---|---|
| `GET /v2/traders/:handle/portfolio` | Holdings, concentration, cash share, per-chain split with the chain's own coin priced |
| `GET /v2/traders/:handle/positions` | Every open position, paged: mint or contract on every row, `priceSuspect`, sell flags, per-chain indexer coverage |
| `POST /v2/traders/positions` | The same for up to 50 traders |
| `GET /v2/traders/:handle/scorecard` | The record: win rate with denominator, best and worst trade, hold time, money in and out, fees, per-window and monthly P&L, `byToken[]` per coin with multiples and market caps, `recent` and `career` windows, `bleeding`, `exitTimingScore`, honeypot and cohort facts |
| `GET /v2/traders/:handle/pnl` | Banked versus on paper; `openPositionsHeld` is the count that matches `/positions`, `openPositions` counts trade records |
| `GET /v2/traders/:handle/trades` | Resolved on-chain swaps, both sides, valued from the money side |
| `GET /v2/traders/:handle/transactions` | Raw transfers. `?chain=` `?kind=swap` `?money=true`, keyset-paged |

### Balance history and live value

| Route | What it answers |
|---|---|
| `GET /v2/traders/:handle/aum/history` | **The chart source.** `?window=1d\|1w\|1m\|3m\|1y\|all`, `?step=1h\|1d\|1w\|1mo`, `?from=` `?to=`. Hourly points carry basis and reason; rolled-up points carry high, low and valued hours. Includes the `now` block |
| `POST /v2/traders/aum/history` | The same for up to 50 traders |
| `GET /v2/traders/:handle/aum/now` | The live value alone: `{ at, totalUsd, pricedPositions, totalPositions, reason, source, ageSeconds }` |
| `POST /v2/traders/aum/now` | The same for up to 50 traders |
| `GET /v2/traders/:handle/aum`, `POST /v2/traders/aum` | Legacy: the sampled readings taken until 17 Sep 2026. They still answer; they do not grow |
| `GET /v2/traders/:handle/flow?since=`, `POST /v2/traders/flow` | Solana net flow since a time, from the live holdings view |
| `GET /v2/events` | Keyset feed of transfers, swaps and readings across the directory |

### Tokens, prices, creators and the market

| Route | What it answers |
|---|---|
| `GET /v2/tokens` | Tokens the directory holds, holders and concentration; `?chain=`, `?excludeHoneypots=`, range filters |
| `GET /v2/tokens/:address` | One token: price block with source, launch block (pump.fun curve), security with `honeypotSince`, holders, cohort, creator ledger |
| `GET /v2/tokens/:address/activity` | Who moved in and out recently, sellers weighted by exit-timing score |
| `GET /v2/tokens/:address/prices` | **Price history.** Hourly with liquidity, or daily, weekly, monthly open, close, high, low; `latest` and running `ath` |
| `POST /v2/tokens/prices` | The same for up to 50 addresses |
| `GET /v2/tokens/momentum` | Tokens gaining or losing holders |
| `GET /v2/creators/:address` | A deployer's ledger across the coins they launched |
| `GET /v2/market/regime` | Cohort reading with a `regime` word and published thresholds, cached 60 s |

### Reference and health

| Route | What it answers |
|---|---|
| `GET /v2/chains` | The five chains, closed and versioned vocabulary |
| `GET /v2/fields` | Every enumerated field's value set, every unit, the constants the rules apply, live fill rates. Version 10. Heavy: call it at build time, not per request |
| `GET /v2/health` | Per-feed freshness with a verdict, per-trader and per-chain staleness, `dataState`, capabilities, row counts, `apiVersion` |

---

## API reference (OpenAPI 3.0)

**[`docs/openapi.yaml`](docs/openapi.yaml)** (OpenAPI 3.0.3) describes every operation with
its parameters, request schema, a response schema per status code, and an example request and
response. It is generated from the route handlers and `docs/consumer/Field_Contracts.md`, so
a field appears there only if the code emits it. The copy in `docs/consumer/v2-handoff/` is
the same file.

```bash
npx @redocly/cli preview-docs docs/openapi.yaml     # view
npx @redocly/cli lint docs/openapi.yaml             # must stay clean
```

Known validation gaps found while generating it are listed with `file:line` evidence in
[`docs/API_VALIDATION_FLAGS_17_SEP.md`](docs/API_VALIDATION_FLAGS_17_SEP.md).

---

## Errors, rate limits and versions

**Every non-2xx answer has one shape**, and driver or SQL text never reaches the caller:

```json
{ "error": { "code": "not_found", "detail": "no route for GET /v2/nope",
             "requestId": "req_2ec7c488bdf0413a", "hint": "routes: GET /v2/traders, …" } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | a parameter or body the route cannot use; a non-JSON body; a malformed `%` in a path segment |
| 400 | `invalid_address` | a submitted wallet that is not an address on the chain it claims |
| 400 | `duplicate_identifier` | the same id twice in a batch body |
| 401 | `unauthorized` | `GENIE_API_KEY` is set and `X-API-Key` is missing or wrong |
| 404 | `not_found` | no such route (the body lists what exists), trader or token |
| 409 | `address_in_use` | the submitted wallet already belongs to another trader, who is named |
| 409 | `already_on_record` | the trader already has that wallet |
| 429 | `rate_limited` | over 240 requests a minute; `Retry-After` says how long |
| 503 | `timeout` | the route outran its 15 s budget; the query is cancelled at 14 s |
| 503 | `unavailable` | Postgres is not answering; retry in a few seconds |
| 503 | `include_unavailable` | `?include=` blocks that could not be produced; `blocks[]` names them |
| 503 | `not_configured` | the Worker has no Hyperdrive binding |
| 500 | `internal_error` | anything else; the `requestId` finds it in the logs |

**Headers:** `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `RateLimit-Scope`
on every response; `x-cost-units` on 200s (a batch of 50 spends 50 units); `x-request-id` on
errors. The limiter is Postgres-backed, one counter across every isolate; `RateLimit-Scope:
unlimited` means it could not be reached and the request was allowed through, logged.

**Batch routes** take up to 50 ids and answer per id, `ok: false` for an unknown one, so one
bad handle never fails the other 49. **Cursor routes** return an opaque `nextCursor`, `null`
on the last page; a tampered cursor answers 400.

**Versions.** Handlers are registered once and answer both prefixes; only the links inside a
response are spelled for the requested version. The Worker refuses `/v1/*` with a 404 pointing
at `/v2`; `/health.apiVersion` says which deployment answered.

---

## The rules every answer follows

These are not style. Each one exists because its absence cost somebody a wrong number.

**`null` means absent. Zero means zero.** A zero worst-trade reads as a trader who has never
lost; a zero balance reads as a man who sold everything. A value that could not be computed
is `null` with a reason word; `0` only when the wallet was read and holds nothing.

**Coverage travels with the figure.** Any number that can be partial carries how much of the
record it was computed from.

**An absent list is not an empty list.** No `gaps` array means "we did not say".

**A partial answer says it is partial.** `partial: true` with a `partialReason` such as
`chains_missing` naming the chains, `unpriced_positions`, or `unsellable_positions`.

**Every refusal is a machine word**, published in `/v2/fields` rather than discovered.

**A unit never changes under a stable name.** Every `*At` is ISO-8601, every `*Share` is 0–1,
every `*Usd` is dollars.

**A figure the service will not stand behind is refused, not rounded.** A price whose implied
market cap exceeds $20B never enters a valuation; the row carries `priceSuspect: true` with the
failed check named. A balance priced from under a quarter of a wallet's positions is refused
unless the priced value alone clears $100, in which case it is served as partial.

---

## The published vocabulary

`supabase/functions/api/shared/vocabulary.ts` is the single list of every enumerated word the
API can emit, with a `version` (currently **10**). `GET /v2/fields` serves it. The consumer's
build fails on an unpublished word by design, so the order of work is a contract:

1. Add the word to `shared/vocabulary.ts` and bump `version`.
2. If the database stores it, extend the check constraint in a new migration.
3. Add the line to `docs/consumer/Field_Contracts.md`.
4. `deno task test`: `tests/vocabulary_test.ts` fails if SQL can store a word the API does not publish.

---

## Balance history and the live value

Until 17 Sep 2026 a trader's balance was **sampled**: a rotation read wallets off chain every
few hours and stored readings. That gave one reading per trader per ~4 h, and an hourly chart
had empty buckets. It is now **built**, and the readings that exist are folded in.

**`aum_history`**, one row per trader per UTC hour, built by the hourly job (`:25`) and read
by `/aum/history`. For each hour: if a sampled or archive reading exists in that hour it is
the row (`basis: reading`); otherwise the latest stored balance capture per chain before the
hour ends is valued at that hour's price (`basis: priced`) with the same ceilings and floors
the rest of the API applies. Prices come from the hourly price table, else the daily table,
else the current price for the current hour. Hours that cannot be valued are `null` with
`reason`: `no_holdings`, `no_prices`, or `too_little_priced`. Daily, weekly and monthly views
roll the hours up with close, high, low and the count of valued hours. The series reaches back
to 11 August 2026 today, as far as stored readings and captures exist; older history would
need archive-node balance reads, which are not built.

**`aum_live`**, one row per trader, is the current value, refreshed by whichever happens
first: a Helius push for a wallet that just transacted (`source: webhook`), a balance slice
that read the wallet (`balances`), an hourly price run (`prices`), or the history build for
anyone older than an hour (`build`). The same refresh rewrites the current hour of
`aum_history`, so the last point of the series is as fresh as the live value. Solana is
therefore real-time; EVM freshness is the balance-slice cadence, 25 wallets every 10 minutes,
because EVM chains have no push source.

---

## Price history

`token_price_hourly` holds an hourly price and liquidity per held token from 17 Sep 2026, with
a running all-time high in `token_price_stats`. Daily, weekly and monthly views carry open,
close, high, low and the number of hours in the bucket. `/tokens/:address/prices` serves them.
The hourly job prices the most-held tokens first, so the tokens most balances depend on are
priced every hour and the one-holder tail rotates.

---

## Submitting a wallet

`POST /v2/traders/:handle/wallets` is the only write in the service. It accepts a wallet as a
**claim, not a fact**:

```bash
curl -X POST "$BASE/v2/traders/somehandle/wallets" \
  -H 'Content-Type: application/json' \
  -d '{"secret":"…","evmAddress":"0x…","solanaAddress":"…"}'
```

- an address already on another trader is **refused, never moved**
- an address a trader already has is refused rather than silently overwritten
- what is stored carries `source: "submitted"`, `confidence: "reported"`, `verified_at` null

Refusals: `unauthorized`, `not_found`, `bad_request`, `invalid_address`, `address_in_use`
(naming who holds it), `already_on_record`.

---

## The jobs that fill the tables

Every job is `worker/src/jobs/<name>.ts`, `runX(env, budgetMs)`: it selects the stalest units
first, does as much as fits in `JOB_BUDGET_MS` (10 minutes), writes as it goes, reports a
summary with `remaining` and `stoppedEarly`, counts a failed unit rather than failing the run,
and throws only when nothing at all could be done, so a failed cron shows in the dashboard.
`worker/src/index.ts` maps each cron string to its job; the strings must match `wrangler.toml`.

| Cron (UTC) | Job | What it does |
|---|---|---|
| `17 * * * *` | `prices` | hourly price and liquidity per held token, most-held first; running ATH; then refreshes every live value |
| `25 * * * *` | `aum_history` | builds every trader-hour not yet built, always redoing the last two; refreshes live values older than an hour |
| `40 * * * *` | `transfers` | on-chain transfers per wallet, stalest first; syncs the Helius watch list |
| `45 * * * *` | `quote_prices` | prices quote-asset transfers; Robinhood-chain coins |
| `*/10 * * * *` | `balances` | a slice of the stalest wallets' balances on every chain, re-priced under the ceilings; closes trades the wallet no longer holds; refreshes their live value |
| `5 */2 * * *` | `tokens` | chain resolution, supply and decimals, fundamentals and honeypot flags |
| `10 */2 * * *` | `fees` | transaction fees per chain, then the per-trader rollup |
| `20 */3 * * *` | `swaps` | EVM swaps resolved into trades |
| `0 */6 * * *` | `scorecards` | reloads fomoapi trade records once a scorecard passes its own `staleAfterHours` |
| `0 1 * * *` | `directory` | fomo leaderboard, wallets, fomo-reported holdings, delisting |
| `15 2 * * *` | `gmgn` | GMGN traders and their trades |
| `35 3 * * *` | `launches` | pump.fun launch metadata, dev ledger |
| `50 4 * * *` | `wallets` | linked wallets |
| `55 5 * * *` | `timing` | position timing |

Any job runs on demand: `POST /jobs/<name>?budgetMs=` with the `x-job-secret` header. The
Helius webhook at `/webhook` is push, not a job; `/sample` is a manual balance read for one
trader, kept for debugging.

---

## Data sources

| Need | Source | Key |
|---|---|---|
| Trader directory, trade records | fomoapi, GMGN | `FOMOAPI_KEY`, `GMGN_API_KEY` |
| Solana: transfers, balances, launch accounts, swap fees | Helius (push webhook and RPC) | `HELIUS_SOLANA_KEY`, `HELIUS_WEBHOOK_SECRET` |
| EVM: balances, transfers, receipts, contract facts | Bitquery | `BITQUERY_KEY` |
| Token prices and liquidity, every chain | DexScreener | none |
| Quote-asset prices (SOL, ETH, BNB) | Binance | none |
| Token fundamentals and honeypot flags | GMGN | `GMGN_API_KEY` |

No free public JSON-RPC endpoint is called from the Worker; Cloudflare's shared egress was
throttled by them. DexScreener and Binance stay because nothing else prices the whole held set
across five chains at that cost.

---

## The database

49 migrations under `supabase/migrations/`, all applied to production; `supabase migration
list` shows local and remote in step. The history table was empty until 17 Sep 2026 and was
repaired to match the schema before the 17 and 17 Sep migrations were pushed.

Tables that matter most: `traders`, `wallets`, `linked_wallets`, `trades`, `trade_loads`,
`transactions` (the largest), `holdings` with the `holdings_current` and `holdings_live`
views, `aum_history` with its daily, weekly and monthly views, `aum_live`, `aum_samples` (the
legacy readings), `token_price_hourly` with its rollup views, `token_price_stats`,
`token_info`, `token_launch`, `creators`, `chain_coverage`, `rate_limits`.

Two SQL functions carry valuation logic: `aum_history_build(handle, from, to)` and
`aum_live_refresh(handles, source, older_than)`. Their ceilings and floors are literals that
cite `aum-sample/value.ts` and `shared/aum-rules.ts` as the source of truth.

Check constraints on the word columns are the only vocabulary the database enforces;
`tests/vocabulary_test.ts` keeps them a subset of what the API publishes, per table.

---

## Running it locally

The API under Deno against a database URL; with no database it still serves the route list,
404s and 503s:

```bash
DB_URL='postgres://…' PORT=8000 deno run --allow-net --allow-env supabase/functions/api/index.ts
curl -s localhost:8000/v1/fields | head -c 400
```

The Worker under `wrangler dev` (local by default; `--remote` talks to production):

```bash
cd worker && npx wrangler dev
curl -s localhost:8787/healthz
```

A job on the deployed Worker, on demand:

```bash
curl -X POST -H "x-job-secret: $JOB_SECRET" "$WORKER_URL/jobs/aum_history?budgetMs=600000"
```

Node 20+ (wrangler, TypeScript), Deno 2+.

---

## Verification

```bash
deno task check                      # typecheck gate: no NEW errors vs scripts/typecheck_baseline.txt (empty; keep it so)
deno task test                       # 166 pure-function tests, no database
npx tsc -p worker/tsconfig.json      # the Worker under the npm postgres types
cd worker && npx wrangler deploy --dry-run --outdir dist   # bundles it
deno task smoke [$BASE]              # 8 checks against a deployment; API_VERSION=v2 for the Worker
deno task capture $BASE captures/x   # 72-file normalised capture; diff two runs
npx @redocly/cli lint docs/openapi.yaml
```

`deno task smoke` against v2 reports `dataState: degraded` while any scorecard is stale; that
is the T2 rule from the app team's report, not a failure of the deployment.

---

## Deploying

Everything is in `.github/workflows/cloudflare.yml`: every push runs the gate, the tests and
the Worker build; when the repository variable `CLOUDFLARE_DEPLOY` is `true` it deploys with
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and smokes `WORKER_URL`. By hand:

```bash
cd worker && npx wrangler deploy
```

Database changes:

```bash
npx supabase db push --db-url "$SESSION_POOLER_URL"      # lists pending migrations, applies in order
```

Worker secrets (`wrangler secret put`): `HELIUS_WEBHOOK_SECRET`, `HELIUS_SOLANA_KEY`,
`BITQUERY_KEY`, `FOMOAPI_KEY`, `GMGN_API_KEY`, `JOB_SECRET`, plus `AUM_SAMPLE_SECRET` and
`WALLET_SUBMIT_SECRET` (wallet submission refuses until it is set). The Hyperdrive config
`genie-copy-trading-db` was created with `--caching-disabled` against the direct IPv6 host;
keep caching off: the live value is read seconds after it is written.

The v1 Supabase functions are not redeployed. Retiring them is a consumer decision.

---

## Configuration

| Variable | Where | Purpose |
|---|---|---|
| `HYPERDRIVE` (binding) | Worker | the Hyperdrive config over the direct host |
| `JOB_BUDGET_MS` | Worker var | wall-clock budget per job run, default 600000 |
| `BALANCE_SLICE` | Worker var | wallets per balances run, default 25 |
| `WEBHOOK_URL` | Worker var | where the transfers job points the Helius watch list |
| `AUM_SAMPLE_BUDGET_MS`, `AUM_LIVE_AFTER_MINUTES`, `AUM_LIVE_WAIT_MS` | Worker var | the manual `/sample` read and the legacy live-read timing |
| `RATE_LIMIT_PER_MINUTE` | Worker var | default 240 |
| `ROUTE_TIMEOUT_MS` | Worker var | default 15000; the query's `statement_timeout` is 14 s |
| `GENIE_API_KEY` | Worker secret, optional | set it to require `X-API-Key` |
| provider keys | Worker secrets | see [Data sources](#data-sources) |
| `DB_URL` / `SUPABASE_DB_URL` / `DATABASE_URL` | v1 functions, local runs | Postgres; the functions use the transaction pooler |
| `PORT` | local Deno run | default 8000 |

The Worker opens one postgres.js client per request with `max: 5`, prepared statements on,
`fetch_types` on (arrays break without it), and closes it in `ctx.waitUntil`.

---

## The documents

| | |
|---|---|
| **[openapi.yaml](docs/openapi.yaml)** | The API reference, OpenAPI 3.0.3 |
| **[consumer/v2-handoff/](docs/consumer/v2-handoff/)** | What the app team receives: guide, spec, v1-to-v2 diff, vocabulary snapshot |
| **[PARAMETER_ROUTES.md](docs/PARAMETER_ROUTES.md)** | Every route and parameter in prose with worked curl examples |
| **[consumer/Field_Contracts.md](docs/consumer/Field_Contracts.md)** | One line per field the consumer reads, dated by the wave that added it |
| **[CLOUDFLARE_MIGRATION.md](docs/CLOUDFLARE_MIGRATION.md)** · **[PROJECT_ANALYSIS.md](docs/PROJECT_ANALYSIS.md)** | The migration plan, its review, and the phase status |
| **[TO-DO-BEFORE-MIGRATION.md](docs/TO-DO-BEFORE-MIGRATION.md)** · **[consumer/genie-fomo-fix-request-v2-16-sep.md](docs/consumer/genie-fomo-fix-request-v2-16-sep.md)** | The app team's 16 Sep report and the plan built from it, all delivered |
| **[consumer/workflow-coverage-17-sep.md](docs/consumer/workflow-coverage-17-sep.md)** · **[consumer/composite-workflows-coverage-17-sep.md](docs/consumer/composite-workflows-coverage-17-sep.md)** | Their workflows checked against the API, and what was added |
| **[API_VALIDATION_FLAGS_17_SEP.md](docs/API_VALIDATION_FLAGS_17_SEP.md)** · **[REVIEW_EFFICIENCY_17_SEP.md](docs/REVIEW_EFFICIENCY_17_SEP.md)** | Open validation gaps with evidence; the efficiency review, applied |
| **[DECISIONS.md](docs/DECISIONS.md)** | The numbered rationale sections the code points at (`#dNNN`) |
| **[AUM_ROUTES.md](docs/AUM_ROUTES.md)** · **[AUM_PLAN.md](docs/AUM_PLAN.md)** · **[AUM_CHART_PRD.md](docs/AUM_CHART_PRD.md)** | The balance-history design, including the 17 Sep `aum_history` section |
| **[LAUNCH_METADATA.md](docs/LAUNCH_METADATA.md)** · **[R4_ROBINHOOD_PRICES.md](docs/R4_ROBINHOOD_PRICES.md)** | Measured sources for launch data and Robinhood-chain prices |
| `tasks/todo.md` · `tasks/lessons.md` | The running status tracker and the lessons recorded from corrections |

---

## Operational notes

**Read `coverage`, `partial` and `reason` before trusting an empty answer.** `count: 0` with
no error is "no activity"; `count: 0` with a reason is "we could not look".

**The connection budget is the database's, not the Worker's.** Hyperdrive holds at most 35
origin connections (`wrangler hyperdrive update … --origin-connection-limit`), each Worker
client opens at most 2, and nothing runs a whole-roster valuation per event: the Helius
receiver only marks traders in `aum_live_dirty`, a one-minute cron revalues them in one call.
On 17 Sep a per-push revaluation at 40 pushes a minute took the database to 26 s per query.

**A job's summary is its health.** `remaining` that never reaches zero across runs means the
budget or the provider quota is the ceiling; `stoppedEarly` on every run means the slice is
too big. Bitquery is metered in points; the balances job asks one query per EVM chain per
wallet.

**Every error carries a stable `code` and a `requestId`.** Quote the id and the exact request
can be found in `wrangler tail`.

