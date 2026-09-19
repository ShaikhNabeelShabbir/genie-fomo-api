# Moving the Genie app to API v2 — guide for the app team (17 Sep 2026, corrected 19 Sep 2026)

This document is written to be handed to an engineer or a coding agent. It says what changed
between the API you integrate today (v1, Supabase) and v2 (Cloudflare), what to change in the
client, and how to verify. It describes the service as built on 19 Sep 2026 (vocabulary 14);
`GET /v2/fields` `version` and `GET /v2/health` say what is deployed. What the 19 Sep corrections
changed is marked **19 Sep** below.

## 1. What v2 is

| | v1 (today) | v2 (move to this) |
|---|---|---|
| Base URL | `https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api` | `https://genie-copy-trading-api.agent-73b.workers.dev` |
| Path prefix | `/v1/…` | `/v2/…` (the same route names; `/v1/…` on the v2 host answers 404 with a hint) |
| Code | frozen at the 16 Sep deploy | every fix from your 16 Sep report, the workflow routes, and the new history routes |
| Data | the Postgres it has always read; no longer written to since 17 Sep 2026 | Cloudflare D1, filled from that Postgres on 17 Sep 2026 and the only copy still written; every table is filled by the Worker's scheduled jobs, never by a request |
| Vocabulary (`/fields`) | version 2 | **version 14** |

v1 stays up unchanged until you have moved, serving data that stopped moving on 17 Sep 2026.
Nothing on v1 gains the new fields.

### The one-line client change

Replace the base URL and the prefix. Every existing path works under `/v2/` with the same
parameters and the same response keys; v2 only **adds** keys and words. Links inside responses
(`links.self`, `links.aum`, …) are already spelled `/v2/…` when you call v2.

## 2. Contract rules that did not change

- `null` means absent, zero means zero. Never coerce.
- Every enumerated value is a word published by `GET /v2/fields`. Your build should fail on a
  word it has not seen; the list below is what you need to add for version 14.
- Every error is `{ "error": { "code", "detail", "requestId", "hint"?, "retryAfterSeconds"? } }`
  with a stable `code`. **19 Sep:** every answer the API serves under `/v2`, 200s included, carries
  `x-request-id` (the Worker's own 404 for `/v1/*` and the CORS preflight do not), and the
  three failures mean three things. 500 `internal_error` is OUR fault and no retry heals it:
  report the `requestId`. 503 is worth retrying after `Retry-After`: `unavailable` with 5 (the
  database is unreachable), 15 (busy, or reset under load) or 60 (`/health` before the scheduler
  has written its first snapshot), `timeout` with 15 when the WHOLE
  request passed 11 s (it was 15 s for the route alone, above your 12 s deadline).
  429 `rate_limited` is your own window and nothing else; a busy database used to be served as 429.
- Rate limit 240 requests a minute, reported in `RateLimit-Limit`, `RateLimit-Remaining`,
  `RateLimit-Reset`, `RateLimit-Scope`. The window counts REQUESTS: a batch of 50 ids is charged
  1, like any other call. `x-cost-units` on the 200 reports the size of the work (50 for that
  batch) and is not what the limiter charges; we told you otherwise before 19 Sep.
- Batch routes take at most 50 ids and answer per id, `ok: false` for an unknown one.
- No API key is required today. If `X-API-Key` is switched on you will be told first.
- Cloudflare's bot protection in front of the Worker refuses requests whose `User-Agent` is a
  library default such as `python-requests/…` or `curl/…` without a product name. Send a
  `User-Agent` that names your app (for example `genie-app/1.0`); the app itself is unaffected.

## 3. Words to add before switching (vocabulary v14)

Add these to your allow-list, then point at v2. The complete list is `GET /v2/fields`.

| Field | Words |
|---|---|
| `error.code` | `unavailable`, `include_unavailable`, `internal_error` (replaces `internal`, which was never emitted) |
| `aumHistory.step`, `tokenPrices.step` | `1h`, `1d`, `1w`, `1mo` |
| `aumHistory.points[].basis` | `reading`, `priced` |
| `aumHistory.points[].reason` | `no_holdings`, `no_prices`, `too_little_priced` |
| `aumHistory.now.reason` | `no_holdings`, `no_prices`, `too_little_priced` (v10) |
| `aumHistory.now.source` | `webhook`, `balances`, `prices`, `build` (v10) |
| `aum.points[].refused` | adds `nothing_answered`, `price_suspect`, `no_tokens_known` |
| `aum.coverage.partialReason` | `chains_missing`, `unpriced_positions`, `unsellable_positions` |
| `positions[].priceSuspectReason` | `implied_mcap_over_ceiling`, `concentration_over_ceiling`, `no_market_over_ceiling` (v12) |
| `positions[].priceSource` | adds `token_price_stats` (v12), the hourly DexScreener price |
| `aumHistory.points[].reason` | adds `not_built` (v12): an hour the builder never wrote |
| `trades.coverage.byChain[].state` | `complete`, `truncated`, `unresolved` (v12, new field) |
| `health.staleFeeds[]` | adds `prices`, `scheduler` (v13) |
| `positions.liveBasis.evm` | adds `rolling_read` (v14), published ahead of the code: the route still answers `nightly_read` today |
| 18 word sets new in v14: `health.status`, `trades.incompleteReason`, `trades[].side`, `trades[].confidence`, `trust.verdict`, `trust.flags[].code`, `trust.flags[].severity`, `wallets.presence`, `positions[].costMethod`, `scorecard.typicalBet.method`, `scorecard.byToken[].entryPriceSource`, `scorecard.byToken[].entryMethod`, `scorecard.byToken[].exitMethod`, `tokens.*.tier`, `tokens.security.flags[]`, `tokens.security.verdict`, `tokens.activity.flow.verdict`, `tokenPrices.tokens[].error` | words the routes ALREADY emitted and `/fields` never listed; no response changed. Their words are in `fields-v14.json` |
| `positions.partialReason` | adds `indexer_coverage_low`, `unsellable_positions_and_indexer_coverage_low` |
| `health.dataState` | `current`, `degraded` |
| `market.regime` | `open`, `caution`, `closed` |
| `scorecard.staleness.fallback` | `on_chain` |
| `wallets.resolvedBy.*` | `fomoapi`, `gmgn`, `submitted` |

Versions 3 to 8 are the 17 Sep fix waves; their words are all included above or in `/v2/fields`.
The complete version 14 list is `fields-v14.json` next to this file.

## 4. Routes

### 4.1 Unchanged paths, new fields (26 operations)

All of these exist on v2 with the same parameters. The per-field additions are listed in
`docs/consumer/Field_Contracts.md` under the "Added 17 Sep 2026" headings; the ones that
answer your 16 Sep asks:

| Route | What v2 adds |
|---|---|
| `GET /v2/traders/:handle/positions`, `POST /v2/traders/positions` | `tokenAddress` and `priceSource` on every row; `priceSuspect` + `priceSuspectReason` (V1); the chain's own coin as a row (N1); `coverage.chains[]` with indexer coverage per chain (R6); `isHoneypot`/`canSell` per row and `partialReason: unsellable_positions` (V2) |
| `GET /v2/traders/:handle/portfolio` | native coin priced per chain (N1); honeypot-flagged value excluded and flagged (V2) |
| `GET /v2/traders/:handle/aum`, `POST /v2/traders/aum` | `partial`/`partialReason: chains_missing` naming the chains (Z2, R5); `totalUsd: null` with a reason instead of `0` (Z1); the priced floor published and partial readings served above $100 (R1, R2); step from the tracked span (S1); no more live read on v2 (the batch answers `liveRead.state: skipped`; the single route answers `unavailable` while no sampler is configured, `skipped` with `?live=false`) |
| `GET /v2/traders/:handle/scorecard` | `byToken[]` per-coin multiples, realised share, entry/exit/peak/current market cap, `entryHoursAfterLaunch`; `recent`/`career` windows; `bleeding`; `exitTimingScore`; `isHoneypotNow`/`honeypotSince`/`exitedBeforeFlag`; `coHolders`; `staleness.fallback` (T1–T3, composite badges) |
| `GET /v2/traders/:handle/pnl` | `openPositionsHeld`, the count that matches `/positions`; `openPositions` still counts trade records, with `openPositionsBasis` naming both (P1) |
| `GET /v2/traders/:handle/wallets` | `resolvedBy.{evm,solana}`, linked wallets (W1) |
| `GET /v2/health` | `staleTraders` per chain, `historyState` counts, `dataState: degraded` while any scorecard is stale, `apiVersion: "v2"` (A1, F2, F3). **19 Sep:** the request is a one-row database probe (`database.answering`, `latencyMs`; a database that does not answer within 2 s is a 503 `unavailable` with `error.database.answering: false`, not a 200); the body is computed by the scheduler every 10 minutes (`computedAt`, `computeMs`, `cacheAgeSeconds`; `cached` is always `true`) and never by a request: until the first snapshot exists the answer is a 503 `unavailable` with `Retry-After: 60` and `error.database.answering: true`, which is NOT a database outage; new feed `prices` (3 h), `tokenInfo` is 48 h and judged per held coin (`heldCoins*`), `positions` is 12 h; `staleFeeds` can carry `prices` and `scheduler` |
| `GET /v2/tokens/:address` | `price` block with source, `launch` block (pump.fun curve), `security.honeypotSince`, `creator` ledger, `perHolder[].exitTimingScore`, `logoUrl`. **19 Sep:** the GMGN blocks (`fundamentals`, `security`, `chainConcentration`, `walletTags`, `creator`) are NOT refreshed nightly for every coin, see §7 |
| `GET /v2/tokens/:address/activity` | `sellers[].exitTimingScore` |

### 4.2 Routes that exist only on v2

| Route | Purpose |
|---|---|
| `GET /v2/events?since=&cursor=&limit=&kind=&chain=&handle=` | keyset feed of transfers, swaps and readings across the directory (W-A) |
| `GET /v2/traders/:handle/flow?since=`, `POST /v2/traders/flow` | Solana net flow since a time, from the live holdings view (W-D) |
| `GET /v2/creators/:address` | a deployer's ledger across the coins they launched (W-J) |
| `GET /v2/market/regime` | cohort reading: `leadersGreenShare7d`, `launchSurvival7d`, `rotation7d`, `regime` (C4) |
| `GET /v2/traders/:handle/aum/history`, `POST /v2/traders/aum/history` | **balance history for charts**, see §5 |
| `GET /v2/tokens/:address/prices`, `POST /v2/tokens/prices` | **price history for charts**, see §6 |

### 4.3 Removed behaviour

- The `/aum` live read-through is gone on v2. `?live=true` is accepted and reads nothing;
  `liveRead.state` is `skipped` on the batch and `unavailable` on the single route while no
  sampler is configured. Readings are not sampled any more, and `sampler.nextExpectedAt` /
  `progress.nextRunAt` still name a next 06:00 UTC run that is not scheduled; see §5.
- Nothing else is removed. Fields you read today keep their names and units.

## 5. Balance history: use `/aum/history` for every chart

`/aum` served sampled chain readings. Sampling stopped on 17 Sep 2026 at about 03:52 UTC, when the rotation was unscheduled: its stored readings remain and
still answer, but they do not grow. The chart source is now a table, `aum_history`, built every
hour from stored balances and stored prices, so every past hour, day, week and month can be
read back, and a trader tracked for three days still has 72 hourly points.

```
GET /v2/traders/:handle/aum/history?window=1d            # 24 hourly points (step 1h)
GET /v2/traders/:handle/aum/history?window=1w            # hourly
GET /v2/traders/:handle/aum/history?window=1m            # daily
GET /v2/traders/:handle/aum/history?window=1y            # weekly
GET /v2/traders/:handle/aum/history?window=all           # monthly
GET /v2/traders/:handle/aum/history?step=1d&from=2026-09-01T00:00:00Z&to=2026-09-18T00:00:00Z
POST /v2/traders/aum/history  { "ids": ["397397", "trd_…"], "window": "1w" }
```

Response (GET):

```json
{
  "handle": "397397", "id": "260363d4-…",
  "step": "1h", "window": "1w", "from": "2026-09-11T04:00:00Z", "to": "2026-09-18T04:00:00Z",
  "points": [
    { "at": "2026-09-17T03:00:00Z", "totalUsd": 18375.20, "basis": "priced", "reason": null,
      "pricedPositions": 41, "totalPositions": 52 },
    { "at": "2026-09-17T04:00:00Z", "totalUsd": null, "basis": "priced", "reason": "no_prices",
      "pricedPositions": 0, "totalPositions": 52 }
  ],
  "count": 168, "valued": 161,
  "latest": { "at": "2026-09-17T03:00:00Z", "totalUsd": 18375.20 },
  "asOf": "2026-09-17T04:25:11Z",
  "links": { "self": "…", "aum": "/v2/traders/397397/aum" }
}
```

Rules: `step` defaults from `window` (`1d`,`1w` → `1h`; `1m`,`3m` → `1d`; `1y` → `1w`;
`all` → `1mo`) and can be forced. Hourly points carry `basis` (`reading` when a sampled
reading stood in that hour, `priced` when built) and `reason` when `totalUsd` is null. Rolled-up
points carry `highUsd`, `lowUsd`, `valuedHours` and `totalUsd` is the close. Points are
ascending, at most 2000, newest kept. Draw `null` as a gap, never as zero.

`asOf` is when the trader's history was last built. It is `null` for the first hour after
deploy while the table backfills (17 Sep 2026, from about 04:25 UTC); expect the past 14 days
to be present within a few hours and history to extend as far back as balance captures exist.

Every history answer (and each batch row) also carries `now`: the trader's live value,
`{ at, totalUsd, pricedPositions, totalPositions, reason, source, ageSeconds }` or `null` when
the trader has none yet. It is refreshed within about five minutes of a watched Solana wallet
transacting, and when the balance sweep reads the trader (about 9 h a lap). **19 Sep:** it is NOT
refreshed when prices land, and the hourly refresh of every trader (A2) was WITHDRAWN - it ran
231-625 s every five minutes and reset the database - so an unmoved trader's figure is hours old
by design. `ageSeconds` says how old the figure was when answered; judge each figure by it.
`/health.staleTraders.liveStale` in the hundreds and `oldestLiveHours` around 9 or more are
therefore normal, not the fault signal we told you they were. `source` is `webhook` on every
figure written today (`balances`, `prices`, `build` remain on older ones), and the hourly series'
last point is refreshed with it. `now.totalUsd` is `null` when not valued (`reason` uses the
same three words as `points[].reason`), never 0. For the figure alone, without the series, call
`GET /v2/traders/:handle/aum/now` or `POST /v2/traders/aum/now { "ids": [...] }` (up to 50,
one row per id, envelope `asOf` = the newest `now.at`).

## 6. Price history: `/tokens/:address/prices`

Hourly prices are stored for every token the directory holds (from 17 Sep 2026) with a running
all-time high. Daily, weekly and monthly rollups carry open, close, high, low.

```
GET /v2/tokens/:address/prices?chain=solana&window=1d      # hourly, liquidity per point
GET /v2/tokens/:address/prices?chain=solana&window=1m      # daily OHLC
POST /v2/tokens/prices { "addresses": ["…", "…"], "chain": "solana", "window": "1w" }
```

`chain` is required when the address exists on more than one chain (400 `ambiguous_chain`
names them). `latest` is the newest hourly sample, `ath` the running high since sampling
began. Nothing before 17 Sep is rebuilt.

## 7. How data stays fresh on v2

Every table is refreshed by a scheduled job on Cloudflare; `GET /v2/health` reports each
feed's age and a `dataState`. Cadence: prices hourly, balance history hourly, on-chain
transfers hourly, wallet balances 25 traders every half hour (about 9 h for the whole roster),
fees every 2 hours, scorecards every 6 hours (a record is reloaded once it is past 72 h),
directory and launches daily. A feed older than its threshold shows `stale` in `/health` before
it shows in a chart.

**GMGN coin details are the exception (19 Sep).** The job runs every 2 hours, but GMGN allows one
request a second, which buys at most roughly 1,100 coins a day against ~31,000 held. The queue is
most-held first, so at best a widely held coin stays about a day old and a coin one or two
traders hold can be weeks old; a coin GMGN has nothing for is parked for 7 days. The API
reference used to promise a nightly refresh of every coin; it was wrong. Each block's `fetchedAt`
is the truth - print it. For the same reason `/health.feeds.tokenInfo` reads `stale`, and
`dataState` `degraded`, by design today; `database.answering`, `staleFeeds` carrying `scheduler`,
and the feed you depend on are the signals to act on.

**The plain trader list outlives the database (19 Sep).** `GET /v2/traders` without `include` is
cached 60 s and, when the database fails, served expired instead of a 503 - per Worker isolate, so
a fresh isolate has nothing to serve: keep your own stored copy too. `capturedAt` is the daily
directory build's stamp (01:00 UTC), not the cache's. With `include`, a page is 100 by default and
at most 200; read `total` and follow `nextCursor`.

## 8. Verification checklist for the switch

1. `GET /v2/fields` answers `version: 14` and your allow-list build passes.
2. `GET /v2/chains` and `GET /v2/traders?limit=5` answer 200 with the same shapes as v1.
3. `GET /v2/traders/397397/aum/history?window=1w` answers 200; `count > 0` once `asOf` is set.
4. `GET /v2/traders/397397/positions` rows carry `tokenAddress` and `priceSuspect`.
5. `GET /v2/health` answers `apiVersion: "v2"` and `database.answering: true`; `database.latencyMs` is what the one-row probe took. A 503 whose `error.database.answering` is `true` (`Retry-After: 60`) means the first snapshot is not written yet: wait and ask again. Only `answering: false` is an outage.
6. `GET /v2/traders/nope` answers 404 `not_found` with `x-request-id`; `GET /v1/chains` on the v2
   host answers 404 with the `/v2` hint and, being the Worker's own refusal, no `x-request-id`.

The machine-readable reference for every operation, parameter, status code and example is
`openapi.yaml` next to this file (OpenAPI 3.0.3, the same file as `docs/openapi.yaml` in the API
repository - a test in that repository now fails when the two differ; between 17 and 19 Sep this
copy was two waves behind while this sentence said otherwise). `fields-v14.json` is the
`vocabulary` block of `GET /v2/fields` at version 14, generated from the service's vocabulary
module; it is not a live capture and carries no counts. `v1-to-v2-diff.md` maps every v1 route to
its v2 counterpart and lists every field and word added.
`reply-v3.md` and `STATUS_17_SEP_PM.md` are dated notes from 17 Sep, kept as sent; where they
disagree with this guide or the spec, this guide and the spec are current.
Import the spec into your client generator or hand the files to your agent together.
