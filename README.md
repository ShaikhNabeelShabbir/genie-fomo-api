# genie-fomo API

A read API over 450 crypto traders: who they are, what they hold, what they have made, and
what their balance has done over time — across Robinhood Chain, Ethereum, BSC, Base and
Solana.

Every route answers from Postgres. The keys that cost money belong to scheduled loaders, so a
thousand visitors cost what one does.

**Live** `https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api`

---

## Contents

- [How it is put together](#how-it-is-put-together)
- [Every route](#every-route)
- [The rules every answer follows](#the-rules-every-answer-follows)
- [Balance history, and how it is kept fresh](#balance-history-and-how-it-is-kept-fresh)
- [What loads the data](#what-loads-the-data)
- [Running it locally](#running-it-locally)
- [Deploying](#deploying)
- [Configuration](#configuration)
- [Verification](#verification)
- [The documents](#the-documents)

---

## How it is put together

Three Supabase Edge Functions and one Postgres database. Nothing else is deployed.

```
                      ┌──────────────────────────────────────────┐
  a consumer  ───────▶│  api            18 GET + 3 POST routes        │
                      │                 answers from Postgres    │
                      └────────────────────┬─────────────────────┘
                                           │
                      ┌────────────────────▼─────────────────────┐
                      │  Postgres  traders · wallets · trades    │
                      │            holdings · transactions       │
                      │            aum_samples · token_info …    │
                      └────────▲──────────────────▲──────────────┘
                               │                  │
        ┌──────────────────────┴───┐   ┌──────────┴────────────────────┐
        │ aum-sample               │   │ helius-webhook                │
        │ reads balances off-chain │   │ Helius pushes every watched   │
        │ every 5 min via pg_cron  │   │ Solana wallet's transactions  │
        └──────────────────────────┘   └───────────────────────────────┘
                               ▲
                      ┌────────┴──────────────────────────────────┐
                      │ GitHub Actions · nightly 06:00 UTC        │
                      │ directory, trades, token info, fees …     │
                      └───────────────────────────────────────────┘
```

| Function | What it does |
|---|---|
| **`api`** | Every read route. Makes no external calls except one case — see [live AUM](#live-on-demand) |
| **`aum-sample`** | Reads a slice of traders' balances off-chain and records them. Driven by `pg_cron` every 5 minutes |
| **`helius-webhook`** | Receives Helius pushes when a watched Solana wallet transacts. Push, not polling — ~290k rows a week |

### Why traders are found this way

fomo publishes an `evmAddress` and a Solana `address` for every user, and **those wallets hold
none of the trader's positions** — they are provisioned per-user wallets. What fomo *does*
publish is the exact size of every position, and that is a fingerprint:

```
fomo says:   10,957,270.2148 of PONS on Robinhood Chain
chain says:  10,957,873.4194 held by 0x0a6EBEd0…119E      (0.0055% off)
fomo says:   20,400,532.9971 of a second Robinhood token
chain says:  20,402,959.6921 held by 0x0a6EBEd0…119E      (0.0119% off)

two independent tokens, one address  →  confirmed
```

Position sizes carry 12+ significant digits, so one match is nearly unique and two are
certain. Resolution now happens in the loaders and the result is stored; the API serves it.

---

## Every route

21 routes — 18 GET and 3 POST. All GET unless marked.

### Traders

| Route | What it answers |
|---|---|
| `GET /v1/traders` | The directory. `?q=` search, `?limit=` `?offset=` `?cursor=`, `?include=pnl,scorecard,wallets,trust`, `?updatedSince=` for incremental sync, `?includeDelisted=true` |
| `GET /v1/traders/:handle` | One trader's profile — identity, rank, on-chain activity, stored counts, links to every other route |
| `GET /v1/traders/:handle/wallets` | The resolved EVM and Solana addresses, with `walletState` and every chain they have been seen on |
| `POST /v1/traders/:handle/wallets` | Submit a wallet for a listed trader who has none. The only write in the service — see [submitting a wallet](#submitting-a-wallet) |

`:handle` accepts the handle, the display name, a leading `@`, the stable UUID, or `trd_<uuid>`.

### Money

| Route | What it answers |
|---|---|
| `GET /v1/traders/:handle/scorecard` | The full record: win rate with its denominator, best/worst trade, hold time, money in and out, fees, per-window realised P&L, monthly results, and `byToken[]` per coin |
| `GET /v1/traders/:handle/pnl` | Banked versus on paper |
| `GET /v1/traders/:handle/portfolio` | Current holdings, concentration, cash share, per-chain split |
| `GET /v1/traders/:handle/positions` | Every open position, paged |
| `POST /v1/traders/positions` | The same for up to 50 traders at once |
| `GET /v1/traders/:handle/trades` | Resolved on-chain swaps, both sides, valued from the money side |
| `GET /v1/traders/:handle/transactions` | Raw transfers, `?chain=` `?kind=swap` `?money=true`, keyset-paged |
| `GET /v1/traders/:handle/trust` | Internal-consistency checks, each one named |

### Balance history

| Route | What it answers |
|---|---|
| `GET /v1/traders/:handle/aum` | Balance over time. `?window=1d\|1w\|1m\|all`, `?chain=`, `?step=`, `?live=true\|false` |
| `POST /v1/traders/aum` | The same for up to 50 traders at once |

### Tokens and reference

| Route | What it answers |
|---|---|
| `GET /v1/tokens` | Tokens the directory holds, with holders and concentration |
| `GET /v1/tokens/:address` | One token: who holds it, how much, security flags |
| `GET /v1/tokens/:address/activity` | Who moved in and out of it recently |
| `GET /v1/tokens/momentum` | Tokens gaining or losing holders |
| `GET /v1/chains` | The five chains, with a **closed, versioned** chain vocabulary |
| `GET /v1/fields` | Every enumerated field's complete value set, every quantity's unit, and live per-field fill rates across the whole directory |
| `GET /v1/health` | Per-feed freshness with a verdict, per-trader staleness, capability status, row counts |

`/v1/fields` exists because a consumer should never have to discover a field's vocabulary by
watching an unexplained blank appear on a screen.

---

## The rules every answer follows

These are not style. Each one exists because its absence cost somebody a wrong number.

**`null` means absent. Zero means zero.** A zero worst-trade reads as a trader who has never
lost; a zero balance reads as a man who sold everything. No string ever stands in for a missing
number — swept across every field, zero sentinels.

**Coverage travels with the figure.** Any number that can be partial carries how much of the
record it was computed from. A figure over four trades and one over four hundred are drawn the
same size otherwise.

**An absent list is not an empty list.** No `gaps` array means "we did not say", which must be
read as unknown — never as "there are none".

**A partial answer says it is partial.** A partial answer that looks complete gets stored; an
error would have been retried.

**Every refusal is a machine word.** `too_little_priced`, `chains_unrebuildable`,
`address_in_use` — each becomes a sentence a person reads, so each is published in `/v1/fields`
rather than discovered.

**A unit never changes under a stable name.** Every `*At` is ISO-8601, every `*Share` is 0–1,
every `*Usd` is dollars. Published, and the data is checked against it.

**A figure the service will not stand behind is refused, not rounded.** A balance priced from
under a quarter of a wallet is served as a refusal carrying its reason, with the arithmetic kept
beside it as `partialUsd` — informative, and never mistaken for his money.

---

## Balance history, and how it is kept fresh

A trader's balance is **sampled**, not reconstructed. The swap stream is roughly 86% buys to
14% sells, so a balance rolled backwards from transactions drifts upward and never sees an exit;
and a coin already sold never appears in a holdings list at all. Nobody records the balance when
it happens — `aum-sample` does.

Each point says how it was arrived at:

| | |
|---|---|
| `basis: sampled` · `tier: verified` | the chain was read at that moment |
| `basis: rebuilt` · `tier: reported` | inferred afterwards from archive state and transactions |

### Kept fresh two ways

**A rotation.** `pg_cron` fires every 5 minutes and `pg_net` posts a slice of 10 traders,
oldest-sampled first, to the `aum-sample` function. The whole roster comes round in under four
hours, with no queue table to get out of step.

<a name="live-on-demand"></a>
**Live on demand.** When `/aum` finds the stored reading older than five minutes it fetches a
new one, writes it, and serves it. `liveRead.state` says which happened:

```
still_running   a fetch was started and outlasted the wait; this answer is the previous
                reading and the next request has the new one
fetched         a live read finished and `now` is from it
not_needed      the stored reading is inside the freshness floor
skipped         the caller passed ?live=false
```

This is the one place the API makes an external call, and `/v1/health` says so in
`externalCallsPerRequest` rather than leaving the old claim of zero standing.

### What "all" means

`window=all` covers the stored readings, not the trader's career — about 36 days today, growing
by a day every day. `progress.boundedBy` says `history` when the readings ran out before the
window did, and `trackedSince` marks where measurement begins.

It cannot simply be extended backwards: 57–76% of the tokens a trader holds have no transaction
record at all, transactions begin on average 120 days after a trader's first trade, and the
database holds dated prices for 2 tokens out of 26,196. A longer rebuild would produce mostly
unpriceable points. See [ACCEPTANCE_TEST_PLAN.md](ACCEPTANCE_TEST_PLAN.md) §2.3.

---

## Submitting a wallet

`POST /v1/traders/:handle/wallets` is the only write in the service. It accepts a wallet as a
**claim, not a fact**:

```bash
curl -X POST "$BASE/v1/traders/somehandle/wallets" \
  -H 'Content-Type: application/json' \
  -d '{"secret":"…","evmAddress":"0x…","solanaAddress":"…"}'
```

- an address already on another trader is **refused, never moved** — that single check is what
  stops one person's money appearing on another's page
- an address a trader already has is refused rather than silently overwritten
- what is stored carries `source: "submitted"`, `confidence: "reported"`, `verified_at` null, so
  every figure derived from it inherits the weaker tier

Refusals: `unauthorized`, `not_found`, `bad_request`, `invalid_address`, `address_in_use`
(naming who holds it), `already_on_record`.

---

## What loads the data

Nothing in the request path calls fomoapi, Helius, Bitquery, Etherscan or GMGN. These do.

### Nightly · GitHub Actions, 06:00 UTC · `.github/workflows/refresh.yml`

| Step | Script |
|---|---|
| Build the directory from fomoapi | `build_directory_fomoapi.py` |
| Load it into Postgres | `load_to_db.py` |
| Refresh trades | `load_trades.py --converge --all` |
| Resolve chains and supply for new tokens | `resolve_trade_chains.mjs`, `load_token_supply.mjs` |
| Refresh on-chain transfers | `backfill_transactions.mjs` |
| Price quote-asset transfers | `load_quote_prices.mjs` |
| Refresh token fundamentals | `load_token_info.mjs` |
| Sync the Helius watch list | `register_webhook.mjs` |
| Read chain balances | `load_chain_balances.mjs` |
| Position timing | `refresh_position_timing.mjs` |
| Transaction fees, then per-trader rollup | `load_transaction_fees.mjs`, `refresh_trader_fees.mjs` |
| Resolve EVM swaps from receipts | `resolve_evm_swaps_from_receipts.mjs` |

### Continuously

| | |
|---|---|
| `aum-sample` Edge Function | every 5 minutes via `pg_cron`, 10 traders a slice |
| `helius-webhook` | whenever a watched Solana wallet transacts |

### On demand

`rebuild_aum_archive.mjs`, `rebuild_aum_robinhood.mjs`, `rebuild_aum_solana.mjs` and
`aggregate_aum_rebuilt.mjs` rebuild historical balance points. `load_gmgn_traders.mjs` and
`load_gmgn_trades.mjs` bring in traders outside fomo's top 100.

---

## Running it locally

The Edge Function runs under Deno against the real database:

```bash
deno run --allow-net --allow-env supabase/functions/api/index.ts
# http://localhost:8000
```

Add `--unsafely-ignore-certificate-errors` if Deno rejects the pooler's TLS chain from your
machine — it verifies against its own trust store and will not build that chain locally.

The loaders are Node:

```bash
npm install
node scripts/load_chain_balances.mjs --help
```

Typecheck before deploying — the whole service is one file and `deno check` catches what a
smoke test will not:

```bash
deno check supabase/functions/api/routes.ts
```

Node 20+, Deno 2+.

---

## Deploying

```bash
npx supabase functions deploy api        --project-ref <ref> --no-verify-jwt
npx supabase functions deploy aum-sample --project-ref <ref> --no-verify-jwt
```

Secrets are set once and live on the function, never in the repo:

```bash
npx supabase secrets set \
  AUM_SAMPLE_SECRET=… WALLET_SUBMIT_SECRET=… HELIUS_SOLANA_KEY=… \
  AUM_SAMPLE_URL=https://<ref>.supabase.co/functions/v1/aum-sample \
  --project-ref <ref>
```

The sampler's schedule lives in a migration
(`20260916120000_aum_sample_schedule.sql`) and needs `pg_cron` and `pg_net` enabled, plus two
Vault secrets. Full steps in [ACCEPTANCE_TEST_PLAN.md](ACCEPTANCE_TEST_PLAN.md) §4.4.

**Test `/v1/health` specifically after any deploy.** It is the one route that has failed while
every other kept working — parallelising its four queries once took it to a 90-second timeout
while each query ran in 150ms by hand.

---

## Configuration

| Variable | Used by | Purpose |
|---|---|---|
| `DB_URL` / `SUPABASE_DB_URL` / `DATABASE_URL` | all | Postgres. Point at the **transaction** pooler (6543) |
| `AUM_SAMPLE_SECRET` | `api`, `aum-sample` | authorises the sampler; without it the function refuses to run rather than defaulting open |
| `AUM_SAMPLE_URL` | `api` | where live AUM reads are sent |
| `AUM_LIVE_AFTER_MINUTES` | `api` | freshness floor, default 5 |
| `AUM_LIVE_WAIT_MS` | `api` | how long a request waits for a live read, default 3000 |
| `WALLET_SUBMIT_SECRET` | `api` | authorises wallet submission |
| `HELIUS_SOLANA_KEY` | `aum-sample`, loaders | Solana balances and history |
| `HELIUS_WEBHOOK_SECRET` | `helius-webhook` | verifies the push |
| `ETHERSCAN_KEY` · `BITQUERY_KEY` · `FOMOAPI_KEY` · `GMGN_API_KEY` | loaders only | never read in the request path |
| `GENIE_API_KEY` | `api` | optional; set it to require `X-API-Key` |
| `RATE_LIMIT_PER_MINUTE` | `api` | default 240 |
| `ROUTE_TIMEOUT_MS` | `api` | default 15000 |

Connection pooling matters more than it looks: Edge Functions scale horizontally, so every warm
instance holds its own pool and `max` multiplies by instance count. The read API uses `max: 2`,
the webhook and sampler `max: 1`. Loaders once exhausted the pooler and took the API to 503.

---

## Verification

Two independent suites, both run against the deployed service.

| | |
|---|---|
| **[Acceptance_Tests.md](Acceptance_Tests.md)** | 50 behavioural tests written by the consumer. **45 passing**, 3 closed by decision, 1 self-resolving, 1 waiting upstream |
| **[Field_Contracts.md](Field_Contracts.md)** | Every field the consumer reads. **150 of 150 correct**, mapped in [Field_Contracts_Mapping.md](Field_Contracts_Mapping.md) |

Results and the reasoning behind every fix are in
[ACCEPTANCE_TEST_REPORT.md](ACCEPTANCE_TEST_REPORT.md) and
[ACCEPTANCE_TEST_PLAN.md](ACCEPTANCE_TEST_PLAN.md).

Current shape of the data:

```
446 listed traders (4 delisted, still answerable by name) · 443 with a wallet
75,689 trades · 46,205 open positions · 50,622 tokens · 1.2M transfers
```

---

## The documents

| | |
|---|---|
| **[PARAMETER_ROUTES.md](PARAMETER_ROUTES.md)** | Every route and parameter in detail, with worked examples. The reference |
| **[Field_Contracts_Mapping.md](Field_Contracts_Mapping.md)** | All 150 consumer-read fields → route, JSON path, live value |
| **[ACCEPTANCE_TEST_REPORT.md](ACCEPTANCE_TEST_REPORT.md)** | The 50 tests, measured |
| **[ACCEPTANCE_TEST_PLAN.md](ACCEPTANCE_TEST_PLAN.md)** | What was fixed, why, and what remains |
| **[AUM_CHART_PRD.md](AUM_CHART_PRD.md)** · **[AUM_PLAN.md](AUM_PLAN.md)** · **[AUM_ROUTES.md](AUM_ROUTES.md)** | The balance-history design |
| **[PARAMETERS.md](PARAMETERS.md)** | What each published figure means |
| **[PROD-STEPS.md](PROD-STEPS.md)** · **[STEPS.md](STEPS.md)** | Deployment and directory-build runbooks |

---

## Operational notes

**Read `chains[]` and `coverage` before trusting an empty answer.** `count: 0` with no error is
"no activity"; `count: 0` with a reason is "we could not look". Collapsing those is the fastest
way to ship a wrong number.

**Rate limiting** is 240 requests a minute, reported on every response in `RateLimit-*` headers
with a `scope` saying whether the counter is global or per instance.

**Every error carries a stable `code` and a `requestId`.** Quote the id and the exact request
can be found; an empty-bodied 503 is indistinguishable from a network failure and gets retried
forever, so it never happens here.
