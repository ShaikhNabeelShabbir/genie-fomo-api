# genie copy-trading API

A read API over ~450 crypto traders: who they are, what they hold, what they have made, and
what their balance has done over time, across Robinhood Chain, Ethereum, BSC, Base and Solana.
The directory started from fomo's leaderboard and now also carries GMGN traders; further
sources are added as loaders, never as request-path calls.

Every route answers from Postgres. The keys that cost money belong to scheduled loaders, so a
thousand visitors cost what one does.

| Deployment | Base URL | Status |
|---|---|---|
| **v1** Supabase Edge Function | `https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api` | live |
| **v2** Cloudflare Worker `genie-copy-trading-api` | `https://genie-copy-trading-api.<subdomain>.workers.dev/v2/…` | ported on this branch, not yet deployed |

Both serve the same handlers. v2 exists so the Worker can be proven against v1 with a byte
diff before consumers move; see [Deploying](#deploying) and `docs/CLOUDFLARE_MIGRATION.md`.

---

## Contents

- [How it is put together](#how-it-is-put-together)
- [Repository layout](#repository-layout)
- [Every route](#every-route)
- [API reference (OpenAPI 3.0)](#api-reference-openapi-30)
- [Errors, rate limits and versions](#errors-rate-limits-and-versions)
- [The rules every answer follows](#the-rules-every-answer-follows)
- [The published vocabulary](#the-published-vocabulary)
- [Balance history, and how it is kept fresh](#balance-history-and-how-it-is-kept-fresh)
- [Submitting a wallet](#submitting-a-wallet)
- [What loads the data](#what-loads-the-data)
- [The database](#the-database)
- [Running it locally](#running-it-locally)
- [Verification](#verification)
- [Deploying](#deploying)
- [Configuration](#configuration)
- [The documents](#the-documents)
- [Operational notes](#operational-notes)

---

## How it is put together

Three Supabase Edge Functions and one Postgres database are live. One Cloudflare Worker,
serving the same code, is ported and waits on a Hyperdrive binding.

```
                          ┌──────────────────────────────────────────────┐
  a consumer ──/v1/*─────▶│  api  (Supabase Edge Function, Deno)          │
                          │  23 GET + 3 POST routes, answers from Postgres│
             ──/v2/*─────▶│  genie-copy-trading-api  (Cloudflare Worker) │
                          │  the SAME route modules, via Hyperdrive       │
                          └────────────────────┬─────────────────────────┘
                                               │
                          ┌────────────────────▼─────────────────────────┐
                          │  Postgres   traders · wallets · trades        │
                          │             holdings · transactions           │
                          │             aum_samples · token_info · …      │
                          └────────▲──────────────────▲──────────────────┘
                                   │                  │
        ┌──────────────────────────┴───┐   ┌──────────┴─────────────────────┐
        │ aum-sample                   │   │ helius-webhook                 │
        │ reads balances off-chain     │   │ Helius pushes every watched    │
        │ every 5 min via pg_cron      │   │ Solana wallet's transactions   │
        │ (Worker twin: /sample)       │   │ (Worker twin: /webhook)        │
        └──────────────────────────────┘   └────────────────────────────────┘
                                   ▲
                          ┌────────┴─────────────────────────────────────┐
                          │ GitHub Actions                               │
                          │ nightly 06:00 UTC · hourly prices            │
                          │ 6-hourly scorecards · 09:00 staleness check  │
                          └──────────────────────────────────────────────┘
```

| Component | What it does |
|---|---|
| **`api`** | Every read route. Makes no external call except one: the `/aum` live read-through to the sampler |
| **`aum-sample`** | Reads a slice of traders' balances off-chain, prices them from tables already in Postgres, records a reading per trader and per chain. Fired every 5 minutes by `pg_cron` → `pg_net` |
| **`helius-webhook`** | Receives Helius pushes when a watched Solana wallet transacts. Push, not polling: ~290k rows a week, idempotent on a computed transfer key |
| **`worker/`** | The Cloudflare port. `fetch` routes `/v2/*` to the api modules, `/webhook` to the receiver, `/sample` to the sampler; `scheduled` is the sampler's cron. Everything answers 503 `not_configured` until Hyperdrive is bound |

The api modules are runtime-agnostic: `db.ts` exposes `sql` as a Proxy over a per-request
`AsyncLocalStorage` store, and `config.ts` reads configuration from the same store before it
falls back to the process environment. `index.ts` (Deno) and `worker/src/api.ts` (Workers)
are the only files that know which runtime they are on.

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
certain. Resolution happens in the loaders and the result is stored; the API serves it and
says how it was resolved (`resolvedBy` on `/wallets`).

---

## Repository layout

| Path | What lives there |
|---|---|
| `supabase/functions/api/` | The read API. `app.ts` (auth, rate limit, 15 s timeout race, version rewrite), `router.ts`, `errors.ts`, `db.ts`, `config.ts`, `index.ts` (Deno entry) |
| `supabase/functions/api/routes/` | One module per route family: `traders`, `positions`, `scorecard`, `transactions`, `aum`, `tokens`, `events`, `flow`, `market`, `chains`, `fields`, `health` |
| `supabase/functions/api/shared/` | Helpers used by two or more families. `vocabulary.ts` is the published word list; `aum-rules.ts`, `positions-core.ts`, `scorecard-core.ts`, `pnl-core.ts` hold the pure rules; `batch.ts`, `cursor.ts` the envelopes |
| `supabase/functions/aum-sample/` | The balance sampler; `value.ts` holds the price ceilings |
| `supabase/functions/helius-webhook/` | Solana transfer push receiver |
| `supabase/functions/_shared/chain_reads.ts` | Balance reads with a per-host throttle. **Twin of `scripts/lib/chain_reads.mjs`: edit both** |
| `supabase/migrations/` | 44 migrations. Check constraints are the only SQL-enforced vocabulary |
| `worker/` | The Cloudflare Worker: `wrangler.toml`, `src/{index,api,db,env,webhook,helius,sampler}.ts`. `sampler.ts` is the twin of `aum-sample/index.ts` |
| `scripts/*.mjs`, `loaders/*.py` | The loaders GitHub Actions runs; `scripts/lib/` holds their shared modules |
| `scripts/*.sh` | `typecheck_gate.sh`, `smoke.sh`, `acceptance_capture.sh` |
| `tests/` | 53 pure-function tests, no database (`deno task test`) |
| `docs/` | Design docs and runbooks; `docs/openapi.yaml` is the API reference; `docs/DECISIONS.md` holds the long rationale moved out of the code (`See docs/DECISIONS.md#dNNN`) |
| `docs/consumer/` | Acceptance suites, field contracts, the Genie app team's reports and our replies |
| `.github/workflows/` | `refresh.yml` nightly, `prices.yml` hourly, `scorecards.yml` 6-hourly, `staleness.yml` daily check, `cloudflare.yml` verify + gated deploy |
| `CLAUDE.md` | The index an agent reads first: route → file map, constants, verify commands |

---

## Every route

26 routes: 23 GET and 3 POST. All GET unless marked. `:handle` accepts the handle, the display
name, a leading `@`, the stable UUID, or `trd_<uuid>`. Every path also resolves under `/v2/`.

### Traders

| Route | What it answers |
|---|---|
| `GET /v1/traders` | The directory. `?q=` search, `?limit=` `?offset=` `?cursor=`, `?sort=` and range filters, `?include=pnl,scorecard,wallets,trust`, `?updatedSince=` for incremental sync, `?includeDelisted=true` |
| `GET /v1/traders/:handle` | One trader's profile: identity, source (`fomoapi.io` or `gmgn`), rank, on-chain activity, stored counts, links to every other route |
| `GET /v1/traders/:handle/trust` | Internal-consistency checks, each one named |
| `GET /v1/traders/:handle/wallets` | The resolved EVM and Solana addresses with `walletState`, `resolvedBy`, every chain they have been seen on, and linked wallets |
| `POST /v1/traders/:handle/wallets` | Submit a wallet for a listed trader who has none. The only write in the service; see [Submitting a wallet](#submitting-a-wallet) |

### Money

| Route | What it answers |
|---|---|
| `GET /v1/traders/:handle/portfolio` | Current holdings, concentration, cash share, per-chain split with the chain's own coin priced |
| `GET /v1/traders/:handle/positions` | Every open position, paged, with `priceSuspect`, the mint or contract on every row, sell flags and per-chain indexer coverage |
| `POST /v1/traders/positions` | The same for up to 50 traders at once |
| `GET /v1/traders/:handle/scorecard` | The full record: win rate with its denominator, best and worst trade, hold time, money in and out, fees, per-window realised P&L, monthly results, `byToken[]` per coin with entry, exit, peak and current multiples, `recent` and `career` windows, `bleeding`, `exitTimingScore`, honeypot and cohort facts |
| `GET /v1/traders/:handle/pnl` | Banked versus on paper, with `openPositions` counting what `/positions` lists |
| `GET /v1/traders/:handle/trades` | Resolved on-chain swaps, both sides, valued from the money side |
| `GET /v1/traders/:handle/transactions` | Raw transfers. `?chain=` `?kind=swap` `?money=true` `?since=` `?until=`, keyset-paged |

### Balance history

| Route | What it answers |
|---|---|
| `GET /v1/traders/:handle/aum` | Balance over time. `?window=1d\|1w\|1m\|all`, `?chain=`, `?step=`, `?live=true\|false`. Every point carries its basis, tier, coverage, and a refusal word when it is refused |
| `POST /v1/traders/aum` | The same for up to 50 traders at once, `live` defaulting to false |
| `GET /v1/traders/:handle/flow` | Solana net flow since a time (`?since=`), from the live holdings view |
| `POST /v1/traders/flow` | Flow for up to 50 traders at once |
| `GET /v1/events` | Keyset feed of transfers, swaps and readings across the directory, for consumers that sync rather than poll |

### Tokens, creators and the market

| Route | What it answers |
|---|---|
| `GET /v1/tokens` | Tokens the directory holds, with holders and concentration; `?chain=`, `?excludeHoneypots=` |
| `GET /v1/tokens/:address` | One token: price block with source, launch block (pump.fun curve), security flags with `honeypotSince`, who holds it and how much, cohort, creator ledger |
| `GET /v1/tokens/:address/activity` | Who moved in and out of it recently, sellers weighted by their exit-timing score |
| `GET /v1/tokens/momentum` | Tokens gaining or losing holders |
| `GET /v1/creators/:address` | A token deployer's ledger across the coins they launched |
| `GET /v1/market/regime` | A cohort reading: leaders' green share, launch survival, rotation, and a `regime` word (`open`, `caution`, `closed`) with published thresholds. Cached 60 s |

### Reference and health

| Route | What it answers |
|---|---|
| `GET /v1/chains` | The five chains, with a **closed, versioned** chain vocabulary |
| `GET /v1/fields` | Every enumerated field's complete value set, every quantity's unit, the constants the rules apply (the priced floor, the price ceilings), and live per-field fill rates |
| `GET /v1/health` | Per-feed freshness with a verdict, per-trader staleness, per-chain accepted and failed readings, `historyState` counts, capability status, row counts, `apiVersion` |

`/v1/fields` exists because a consumer should never have to discover a field's vocabulary by
watching an unexplained blank appear on a screen.

---

## API reference (OpenAPI 3.0)

The complete machine-readable reference is **[`docs/openapi.yaml`](docs/openapi.yaml)**
(OpenAPI 3.0.3): every operation with its parameters, request schema, a response schema per
status code, and an example request and response. It was generated from the route handlers
and `docs/consumer/Field_Contracts.md`, so a field appears there only if the code emits it.

View it:

```bash
# any of these; none is a dependency of the service
npx @redocly/cli preview-docs docs/openapi.yaml
npx @scalar/cli document serve docs/openapi.yaml
docker run -p 8080:8080 -e SWAGGER_JSON=/spec/openapi.yaml -v "$PWD/docs:/spec" swaggerapi/swagger-ui
```

Lint it after a change:

```bash
npx @redocly/cli lint docs/openapi.yaml
```

Operation ids follow `getTrader`, `getTraderAum`, `batchTraderAum`, `getToken`,
`getMarketRegime`, and so on; the `tags` group them as the tables above do.

### Validation and error-handling flags

Generating the spec meant reading every handler's inputs and throws. The full list, with
`file:line` evidence, is **[`docs/API_VALIDATION_FLAGS_17_SEP.md`](docs/API_VALIDATION_FLAGS_17_SEP.md)**
(64 items: 2 high, 20 medium of which four restate the vocabulary drift fixed today, the rest low). The ones that change an answer or lose data:

| Severity | Where | Gap |
|---|---|---|
| high | `worker/src/webhook.ts`, `helius-webhook/index.ts` | The receiver answers `{ok:true}` before the insert runs and puts no cap on the events in one delivery. A delivery large enough to exceed Postgres's bind-parameter limit throws inside a fire-and-forget promise: logged, never retried, the whole batch of transfers silently dropped. Fix: chunk the multi-row insert (500 rows) and answer after it commits |
| high | `GET /traders/:handle/trades` | `since` and `until` are cast in SQL without parsing; `?since=yesterday` is a Postgres cast error and answers 500 `internal_error` instead of 400. Every sibling route uses the shared ISO parser |
| medium | `POST /traders/aum` | `window` and `chain` in the body are `.trim()`ed without a type check; a number or object answers 500 instead of 400 |
| medium | `GET /traders`, `GET /tokens`, `GET /tokens/momentum` | `limit` has no maximum and no default: the whole directory or board ships, with every `include=` block, inside the 15 s budget. `intParam` applies `max` only when the caller remembers to pass one |
| medium | `GET /events`, `GET /traders/:handle/flow`, `POST /traders/flow` | `since` has no lower bound and flow has no `limit`; `since=1970-01-01` walks the whole table, times 50 on the batch route |
| medium | `GET /traders/:handle/trades` | `cursor` shape is not checked and `chain` is not validated against the chains table, so `?chain=sol` answers a confident empty `complete: true` |
| medium | batch routes | `x-cost-units` reports the batch cost but the rate window is bumped once per request, so a 50-id batch costs one unit of the 240/min |
| medium | `POST /traders/positions`, `POST /traders/aum` with `contractVersion: 1` | The legacy projection cannot tell an unknown id from a trader with nothing: both come back as an empty row |
| medium | `GET /traders/:handle/positions` vs `POST /traders/positions` | The single route coerces a missing `amount` to `0`, the batch row keeps `null`. Same column, two answers |
| medium | `POST /traders/:handle/wallets` | The address-clash check is a select-then-insert with no unique index behind it, so two concurrent submissions of one address can both succeed. The secret compare is not constant-time |
| medium | `shared/batch.ts` | `ids[]` entries are stringified, not type-checked: `[1, null, {}]` becomes three unknown handles instead of a 400 |
| medium | `app.ts`, `errors.ts` | `ROUTE_TIMEOUT_MS` and `RATE_LIMIT_PER_MINUTE` are `Number()`-parsed and never validated; a typo yields `NaN`, which makes every request lose the timeout race, or silently disables the limiter |
| medium | `router.ts` | The version rewrite is a global replace of the text `/v1/` over the whole JSON body, so a handle or token name containing `/v1/` would be rewritten too |
| medium | `GET /fields` | Fixed today: the published `error.code` list did not match the codes the service emits (vocabulary v8) |

What the pipeline does guarantee, verified in the same pass: a malformed cursor is always a
400, never a 500; driver and SQL text never reach the caller; the timeout race clears its
timer on every path and the 14 s `statement_timeout` frees the connection; the limiter fails
open and says so; batch bodies are refused, not truncated, before any query runs; the webhook
upsert is idempotent on redelivery.

---

## Errors, rate limits and versions

**Every non-2xx answer has one shape**, and driver or SQL text never reaches the caller:

```json
{ "error": { "code": "not_found", "detail": "no route for GET /v1/nope",
             "requestId": "req_2ec7c488bdf0413a", "hint": "routes: GET /v1/traders, …" } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | a parameter or body the route cannot use; a non-JSON body; a malformed `%` in a path segment |
| 400 | `invalid_address` | a submitted wallet that is not an address on the chain it claims |
| 400 | `duplicate_identifier` | the same id twice in a batch body |
| 401 | `unauthorized` | `GENIE_API_KEY` is set and `X-API-Key` is missing or wrong |
| 404 | `not_found` | no such route (the body lists what exists) or no such trader or token |
| 409 | `address_in_use` | the submitted wallet already belongs to another trader, who is named |
| 409 | `already_on_record` | the trader already has that wallet |
| 429 | `rate_limited` | over 240 requests a minute; `Retry-After` says how long |
| 503 | `timeout` | the route outran its 15 s budget; the query is cancelled at 14 s |
| 503 | `unavailable` | Postgres is not answering; retry in a few seconds |
| 503 | `include_unavailable` | `?include=` asked for blocks that could not be produced; `blocks[]` names them. Retry rather than reading "there is none" |
| 503 | `not_configured` | the Worker has no Hyperdrive binding yet |
| 500 | `internal_error` | anything else; the `requestId` finds it in the logs |

**Headers on every response:** `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`,
`RateLimit-Scope`; `x-cost-units` on 200s; `x-request-id` on errors, matching `error.requestId`. The limiter is Postgres-backed so it is one counter
across every isolate; `RateLimit-Scope: unlimited` means the counter could not be reached and
the request was allowed through (logged server-side, never silent).

**Batch routes** (`POST /v1/traders/aum|positions|flow`) take up to 50 ids in one body and
answer per id inside an envelope, so one unknown handle does not fail the other 49. The
envelope's `asked` count becomes the `x-cost-units` header: a batch of 50 spends 50 units of
the rate limit, not one.

**Cursor routes** (`/traders`, `/transactions`, `/events`, `/tokens`) return an opaque
`nextCursor`, `null` on the last page. A tampered cursor answers 400.

**Versions.** Handlers are registered once under `v1` and answer `v2` as well; only the links
inside a response are rewritten for the requested version. The Worker refuses `/v1/*` with a
404 pointing at `/v2`, and `/health.apiVersion` says which deployment answered.

---

## The rules every answer follows

These are not style. Each one exists because its absence cost somebody a wrong number.

**`null` means absent. Zero means zero.** A zero worst-trade reads as a trader who has never
lost; a zero balance reads as a man who sold everything. No string ever stands in for a missing
number. A reading that priced nothing, or listed nothing because the read failed, is `null`
with a reason word; `0` only when the wallet was read and holds nothing.

**Coverage travels with the figure.** Any number that can be partial carries how much of the
record it was computed from. A figure over four trades and one over four hundred are drawn the
same size otherwise.

**An absent list is not an empty list.** No `gaps` array means "we did not say", which must be
read as unknown, never as "there are none".

**A partial answer says it is partial.** `partial: true` with a `partialReason` such as
`chains_missing` naming the chains, `unpriced_positions`, or `unsellable_positions`.

**Every refusal is a machine word.** `too_little_priced`, `nothing_answered`,
`chains_unrebuildable`, `address_in_use`: each becomes a sentence a person reads, so each is
published in `/v1/fields` rather than discovered.

**A unit never changes under a stable name.** Every `*At` is ISO-8601, every `*Share` is 0–1,
every `*Usd` is dollars. Published, and the data is checked against it.

**A figure the service will not stand behind is refused, not rounded.** A balance priced from
under a quarter of a wallet's positions is refused with its reason and the arithmetic kept
beside it as `partialUsd`, unless the priced value alone clears the partial-serve floor, in
which case it is served as `partial`. A price whose implied market cap exceeds $20B never enters
a reading; the row carries `priceSuspect: true` with the failed check named.

---

## The published vocabulary

`supabase/functions/api/shared/vocabulary.ts` is the single list of every enumerated word the
API can emit, with a `version` (currently **7**). `GET /v1/fields` serves it. The consumer's
build fails on an unpublished word by design, so the order of work is a contract:

1. Add the word to `shared/vocabulary.ts` and bump `version`.
2. If the database stores it, extend the check constraint in a new migration.
3. Add the line to `docs/consumer/Field_Contracts.md`.
4. `deno task test`: `tests/vocabulary_test.ts` fails if SQL can store a word the API does not publish.

Tell the consumer before deploying a new version. The current draft of that note is
`docs/consumer/reply-to-genie-17-sep.md`.

---

## Balance history, and how it is kept fresh

A trader's balance is **sampled**, not reconstructed. The swap stream is roughly 86% buys to
14% sells, so a balance rolled backwards from transactions drifts upward and never sees an exit;
and a coin already sold never appears in a holdings list at all. Nobody records the balance when
it happens; `aum-sample` does.

Each point says how it was arrived at:

| | |
|---|---|
| `basis: sampled` · `tier: verified` | the chain was read at that moment |
| `basis: rebuilt` · `tier: reported` | inferred afterwards from archive state and transactions; drawn dimmer by the consumer, and never the sole support of `drawing.drawable` |

A reading is per trader and per chain. Every chain of a wallet is read in the same slice, the
reads run in parallel behind a per-host throttle, and one chain's failure no longer discards
the others: the reading names the chains that answered and marks the rest `chains_missing`.
The chain's own coin (ETH, BNB, SOL) is read and priced from the wrapped coin.

### Kept fresh two ways

**A rotation.** `pg_cron` fires every 5 minutes and `pg_net` posts a slice of traders,
oldest-sampled first, to the `aum-sample` function. The whole roster comes round in a few
hours, with no queue table to get out of step.

<a name="live-on-demand"></a>
**Live on demand.** When `/aum` finds the stored reading older than five minutes it fetches a
new one, writes it, and serves it. `liveRead.state` says which happened:

```
still_running   a fetch was started and outlasted the wait; this answer is the previous
                reading and the next request has the new one
fetched         a live read finished and `now` is from it
not_needed      the stored reading is inside the freshness floor
skipped         the caller passed ?live=false (the batch route's default)
```

This is the one place the API makes an external call, and `/v1/health` says so in
`externalCallsPerRequest`.

### What "all" means

`window=all` covers the stored readings, not the trader's career, and `trackedSince` marks where
measurement begins. The step is chosen from the tracked span as well as the window, so a trader
tracked for three days still draws more than one point on `window=1m`. It cannot simply be
extended backwards: most of the tokens a trader holds have no transaction record, transactions
begin months after a trader's first trade, and dated prices exist for very few tokens. See
`docs/consumer/ACCEPTANCE_TEST_PLAN.md` §2.3 and `docs/consumer/balance-history-summary.md`.

---

## Submitting a wallet

`POST /v1/traders/:handle/wallets` is the only write in the service. It accepts a wallet as a
**claim, not a fact**:

```bash
curl -X POST "$BASE/v1/traders/somehandle/wallets" \
  -H 'Content-Type: application/json' \
  -d '{"secret":"…","evmAddress":"0x…","solanaAddress":"…"}'
```

- an address already on another trader is **refused, never moved**; that single check is what
  stops one person's money appearing on another's page
- an address a trader already has is refused rather than silently overwritten
- what is stored carries `source: "submitted"`, `confidence: "reported"`, `verified_at` null, so
  every figure derived from it inherits the weaker tier

Refusals: `unauthorized`, `not_found`, `bad_request`, `invalid_address`, `address_in_use`
(naming who holds it), `already_on_record`.

---

## What loads the data

Nothing in the request path calls fomoapi, Helius, Bitquery, Etherscan, GMGN or DexScreener.
These do.

### Nightly · 06:00 UTC · `.github/workflows/refresh.yml`

| Step | Script |
|---|---|
| Build the directory from fomoapi | `loaders/build_directory_fomoapi.py --top 100` |
| Load it into Postgres | `loaders/load_to_db.py` |
| Refresh trades | `loaders/load_trades.py --converge --all --stale-hours 20` |
| Resolve chains for newly traded tokens | `scripts/resolve_trade_chains.mjs` |
| Refresh on-chain transfers | `scripts/backfill_transactions.mjs` |
| Link funded wallets | `scripts/link_wallets.mjs` |
| Price quote-asset transfers | `scripts/load_quote_prices.mjs` |
| Price Robinhood-chain coins (DexScreener, keyless) | `scripts/load_robinhood_prices.mjs` |
| Refresh token fundamentals | `scripts/load_token_info.mjs` (sets `honeypot_since` on the first flip) |
| Refresh token launch metadata (pump.fun curve) | `scripts/load_token_launch.mjs` |
| Refresh the dev ledger | `scripts/refresh_creators.mjs` |
| Sync the Helius watch list | `scripts/register_webhook.mjs` |
| Read chain balances, then re-price under the ceilings | `scripts/load_chain_balances.mjs` |
| Resolve supply for new tokens | `scripts/load_token_supply.mjs` |
| Close trades the wallet no longer holds | `scripts/close_stale_trades.mjs` |
| Sample AUM (the sampler's Node twin) | `scripts/load_aum_samples.mjs` |
| Position timing | `scripts/refresh_position_timing.mjs` |
| Transaction fees per chain, then the per-trader rollup | `scripts/load_transaction_fees.mjs`, `scripts/refresh_trader_fees.mjs` |
| Resolve EVM swaps from receipts | `scripts/resolve_evm_swaps_from_receipts.mjs` |

### On other schedules

| Workflow | When | What |
|---|---|---|
| `prices.yml` | hourly at :17 | `scripts/load_token_prices.mjs`: hourly price history and the running ATH per token |
| `scorecards.yml` | every 6 hours | `loaders/load_trades.py --converge --stale-hours 72`: reloads a scorecard once it passes its own `staleAfterHours` instead of waiting for the nightly slot |
| `staleness.yml` | 09:00 UTC | curls `/v1/health` and fails the run on a stale feed |
| `cloudflare.yml` | every push, and on dispatch | typecheck, tests, Worker build; deploy only when the `CLOUDFLARE_DEPLOY` variable is `true`; optional acceptance diff between the two deployments |

### Continuously

| | |
|---|---|
| `aum-sample` Edge Function | every 5 minutes via `pg_cron`, a slice of traders, every chain of each |
| `helius-webhook` | whenever a watched Solana wallet transacts; feeds `holdings_live` and `/flow` |

### On demand

`rebuild_aum_archive.mjs`, `rebuild_aum_robinhood.mjs`, `rebuild_aum_solana.mjs` and
`aggregate_aum_rebuilt.mjs` rebuild historical balance points. `load_gmgn_traders.mjs` and
`load_gmgn_trades.mjs` bring in traders outside fomo's top 100.

---

## The database

44 migrations under `supabase/migrations/`. The last 14, dated `20260917`, are on this branch
and **not yet applied** to production; they add `price_suspect`, native EVM positions, partial
sampler readings, balance-closed trades, trade-load bookkeeping, per-chain indexer coverage,
hourly price history, launch metadata, the `holdings_live` view, `creators`, `linked_wallets`,
the `trader_chain_history` view, `honeypot_since`, and the performance indexes the health and
AUM routes assume. Apply them before deploying the api from this branch.

Tables that matter most: `traders`, `wallets`, `trades` (fomoapi and GMGN), `transactions`
(Helius pushes, the largest table), `holdings` and the `holdings_current` / `holdings_live`
views, `aum_samples` and `aum_chain_samples`, `token_info`, `token_price_hourly`,
`token_price_stats`, `rate_limits`. The sampler's schedule and Vault secrets are in
`20260916120000_aum_sample_schedule.sql`.

Check constraints on `refused_reason`, `partial_reason` and the other word columns are the only
vocabulary the database enforces; `tests/vocabulary_test.ts` keeps them a subset of what the
API publishes.

---

## Running it locally

The Edge Function runs under Deno against a database URL; with no database it still serves the
route list, 404s and 503s, which is enough to smoke the pipeline:

```bash
DB_URL='postgres://…' PORT=8000 deno run --allow-net --allow-env supabase/functions/api/index.ts
curl -s localhost:8000/v1/fields | head -c 400
```

Add `--unsafely-ignore-certificate-errors` if Deno rejects the pooler's TLS chain from your
machine.

The Worker runs under `wrangler dev` (local by default; `--remote` talks to production):

```bash
cd worker && npx wrangler dev
curl -s localhost:8787/healthz
```

The loaders are Node:

```bash
npm install
node scripts/load_chain_balances.mjs --help
```

Node 20+, Deno 2+.

---

## Verification

```bash
deno task check                      # typecheck gate: no NEW errors vs scripts/typecheck_baseline.txt (baseline is empty; keep it so)
deno task test                       # 53 pure-function tests, no database
npx tsc -p worker/tsconfig.json      # the Worker under the npm postgres types
cd worker && npx wrangler deploy --dry-run --outdir dist   # bundles it (~408 KB)
./scripts/smoke.sh [$BASE]           # 8 checks against a deployment; API_VERSION=v2 for the Worker
./scripts/acceptance_capture.sh $BASE captures/x           # 72-file normalised capture; diff two runs
npm run build                        # scripts/lib/ts → scripts/lib/dist for three loaders
```

The acceptance capture strips the fields that legitimately differ between runs (request ids,
`asOf`, live-read timing) and folds `/v2/` links back to `/v1/`, so a capture of the Supabase
deployment and one of the Worker diff to nothing when the port is right. `cloudflare.yml` runs
that diff on dispatch when both base URLs are given.

Two consumer-written suites are also run against the deployed service and reported in
`docs/consumer/`: 50 acceptance tests (`Acceptance_Tests.md`, 45 passing as of 16 Sep 2026)
and 150 field contracts (`Field_Contracts.md`, all correct as of 16 Sep 2026, mapped in
`Field_Contracts_Mapping.md`).

---

## Deploying

### Supabase (v1)

```bash
npx supabase db push --project-ref <ref>                       # the 14 pending migrations, in order
npx supabase functions deploy api        --project-ref <ref> --no-verify-jwt
npx supabase functions deploy aum-sample --project-ref <ref> --no-verify-jwt
npx supabase functions deploy helius-webhook --project-ref <ref> --no-verify-jwt
./scripts/smoke.sh
```

Secrets live on the function, never in the repo:

```bash
npx supabase secrets set \
  AUM_SAMPLE_SECRET=… WALLET_SUBMIT_SECRET=… HELIUS_SOLANA_KEY=… \
  AUM_SAMPLE_URL=https://<ref>.supabase.co/functions/v1/aum-sample \
  --project-ref <ref>
```

**Test `/v1/health` specifically after any deploy.** It is the one route that has failed while
every other kept working; its queries are sequential on purpose.

### Cloudflare (v2)

Everything is in `.github/workflows/cloudflare.yml`; the runbook is
`docs/CLOUDFLARE_MIGRATION.md` §8 and §13.

1. Repository secrets `CLOUDFLARE_API_TOKEN` (needs *Account › Workers Scripts › Edit*) and
   `CLOUDFLARE_ACCOUNT_ID`. Set the variable `CLOUDFLARE_DEPLOY=true` and dispatch the workflow;
   the first deploy proves the pipeline and answers `/healthz` plus 503 on everything else.
2. With the database password: `npx wrangler hyperdrive create genie-copy-trading-db
   --connection-string=… --caching-disabled` against the **direct** host (not the 6543 pooler),
   paste the id into the `[[hyperdrive]]` block of `worker/wrangler.toml`, and
   `wrangler secret put` `HELIUS_WEBHOOK_SECRET`, `AUM_SAMPLE_SECRET`, `HELIUS_SOLANA_KEY`,
   `WALLET_SUBMIT_SECRET`. Redeploy; set the `WORKER_URL` variable so the post-deploy smoke runs.
3. Shadow phase: both deployments read and write the one database; run the acceptance diff.
4. Cutover: uncomment `[triggers]` in `wrangler.toml` and disable the `pg_cron` job in the same
   window, so exactly one sampler runs; point the Helius webhook at `/webhook`; move consumers
   to `/v2/`.

Caching stays disabled on Hyperdrive until the acceptance diff is clean; `/aum?live=true` reads
a row the sampler wrote seconds earlier and a 60 s cache would serve the previous reading.

---

## Configuration

| Variable | Used by | Purpose |
|---|---|---|
| `DB_URL` / `SUPABASE_DB_URL` / `DATABASE_URL` | Supabase functions, loaders | Postgres. The functions point at the **transaction** pooler (6543) |
| `HYPERDRIVE` (binding) | Worker | the Hyperdrive config over the direct host |
| `GENIE_API_KEY` | api | optional; set it to require `X-API-Key` |
| `RATE_LIMIT_PER_MINUTE` | api | default 240 |
| `ROUTE_TIMEOUT_MS` | api | default 15000; the query's `statement_timeout` is 14 s |
| `AUM_SAMPLE_SECRET` | api, aum-sample, Worker | authorises the sampler; without it the function refuses to run rather than defaulting open |
| `AUM_SAMPLE_URL` | api | where live AUM reads are sent |
| `AUM_LIVE_AFTER_MINUTES` | api, Worker | freshness floor, default 5 |
| `AUM_LIVE_WAIT_MS` | api, Worker | how long a request waits for a live read, default 3000 |
| `AUM_SAMPLE_BUDGET_MS` | Worker | wall-clock budget for one sampler slice, default 100000 |
| `WALLET_SUBMIT_SECRET` | api, Worker | authorises wallet submission |
| `HELIUS_SOLANA_KEY` | aum-sample, Worker, loaders | Solana balances and history |
| `HELIUS_WEBHOOK_SECRET` | helius-webhook, Worker | verifies the push |
| `ETHERSCAN_KEY` · `BITQUERY_KEY` · `FOMOAPI_KEY` · `GMGN_API_KEY` | loaders only | never read in the request path |
| `PORT` | local Deno run | default 8000 |

Connection pooling matters more than it looks: Edge Functions scale horizontally, so every warm
instance holds its own pool and `max` multiplies by instance count. The read API uses `max: 2`
with `prepare: false` on the transaction pooler; the Worker uses `max: 5` per request over
Hyperdrive with prepared statements on, and closes the client in `ctx.waitUntil`. Loaders once
exhausted the pooler and took the API to 503.

`.env.example` lists every variable for the loaders.

---

## The documents

| | |
|---|---|
| **[openapi.yaml](docs/openapi.yaml)** | The API reference, OpenAPI 3.0.3 |
| **[PARAMETER_ROUTES.md](docs/PARAMETER_ROUTES.md)** | Every route and parameter in prose, with worked curl examples and the reasoning |
| **[Field_Contracts.md](docs/consumer/Field_Contracts.md)** · **[Field_Contracts_Mapping.md](docs/consumer/Field_Contracts_Mapping.md)** | One line per field the consumer reads, and where each comes from |
| **[Acceptance_Tests.md](docs/consumer/Acceptance_Tests.md)** · **[ACCEPTANCE_TEST_REPORT.md](docs/consumer/ACCEPTANCE_TEST_REPORT.md)** · **[ACCEPTANCE_TEST_PLAN.md](docs/consumer/ACCEPTANCE_TEST_PLAN.md)** | The consumer's 50 tests, measured, and what was fixed |
| **[genie-fomo-fix-request-v2-16-sep.md](docs/consumer/genie-fomo-fix-request-v2-16-sep.md)** · **[TO-DO-BEFORE-MIGRATION.md](docs/TO-DO-BEFORE-MIGRATION.md)** · **[reply-to-genie-17-sep.md](docs/consumer/reply-to-genie-17-sep.md)** | The app team's 16 Sep report, the 15-item plan built from it (all on this branch), and the reply draft |
| **[workflow-coverage-17-sep.md](docs/consumer/workflow-coverage-17-sep.md)** · **[composite-workflows-coverage-17-sep.md](docs/consumer/composite-workflows-coverage-17-sep.md)** | The app team's automated and composite workflows, checked against the API, and the routes added to cover them |
| **[CLOUDFLARE_MIGRATION.md](docs/CLOUDFLARE_MIGRATION.md)** · **[PROJECT_ANALYSIS.md](docs/PROJECT_ANALYSIS.md)** | The migration plan and runbook; the project analysis that reviewed it |
| **[REVIEW_EFFICIENCY_17_SEP.md](docs/REVIEW_EFFICIENCY_17_SEP.md)** | The ranked efficiency review of the refactor, all items applied |
| **[DECISIONS.md](docs/DECISIONS.md)** | 197 numbered rationale sections the code points at (`#dNNN`) |
| **[AUM_CHART_PRD.md](docs/AUM_CHART_PRD.md)** · **[AUM_PLAN.md](docs/AUM_PLAN.md)** · **[AUM_ROUTES.md](docs/AUM_ROUTES.md)** | The balance-history design |
| **[LAUNCH_METADATA.md](docs/LAUNCH_METADATA.md)** · **[R4_ROBINHOOD_PRICES.md](docs/R4_ROBINHOOD_PRICES.md)** | Measured sources for launch data and Robinhood-chain prices |
| **[PARAMETERS.md](docs/PARAMETERS.md)** | What each published figure means |
| **[PROD-STEPS.md](docs/PROD-STEPS.md)** · **[STEPS.md](docs/STEPS.md)** | Deployment and directory-build runbooks |
| **[GMGN_FEATURES.md](docs/GMGN_FEATURES.md)** · **[GMGN_GAP_ANALYSIS.md](docs/GMGN_GAP_ANALYSIS.md)** · **[GMGN_PARITY_PLAN.md](docs/GMGN_PARITY_PLAN.md)** | The GMGN source: what it offers, what is missing, the plan |
| `tasks/todo.md` · `tasks/lessons.md` | The running status tracker and the lessons recorded from corrections |

---

## Operational notes

**Read `chains[]`, `coverage` and `partial` before trusting an empty answer.** `count: 0` with
no error is "no activity"; `count: 0` with a reason is "we could not look". Collapsing those is
the fastest way to ship a wrong number.

**Twins must be edited together.** `_shared/chain_reads.ts` ↔ `scripts/lib/chain_reads.mjs`;
`aum-sample/index.ts` ↔ `scripts/load_aum_samples.mjs` ↔ `worker/src/sampler.ts`;
`aum-sample/value.ts` ↔ `scripts/lib/value.mjs`. A ceiling changed in one and not the other is
how a $101B reading got served.

**Every error carries a stable `code` and a `requestId`.** Quote the id and the exact request
can be found; an empty-bodied 503 is indistinguishable from a network failure and gets retried
forever, so it never happens here.

**`statement_timeout` is sent as a connection parameter.** Supavisor's transaction pooler and
Hyperdrive may refuse startup parameters; run `scripts/smoke.sh` right after each deploy and,
if it fails on that, move the timeout to a `set local` per query.
