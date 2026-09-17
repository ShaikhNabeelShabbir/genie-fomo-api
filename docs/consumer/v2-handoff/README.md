# Moving the Genie app to API v2 — guide for the app team (17 Sep 2026)

This document is written to be handed to an engineer or a coding agent. It says what changed
between the API you integrate today (v1, Supabase) and v2 (Cloudflare), what to change in the
client, and how to verify. Everything in it is live now.

## 1. What v2 is

| | v1 (today) | v2 (move to this) |
|---|---|---|
| Base URL | `https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api` | `https://genie-copy-trading-api.agent-73b.workers.dev` |
| Path prefix | `/v1/…` | `/v2/…` (the same route names; `/v1/…` on the v2 host answers 404 with a hint) |
| Code | frozen at the 16 Sep deploy | every fix from your 16 Sep report, the workflow routes, and the new history routes |
| Data | the same Postgres, read live | the same Postgres, read live; every table is filled by scheduled jobs, never by a request |
| Vocabulary (`/fields`) | version 2 | **version 10** |

v1 stays up unchanged until you have moved. Nothing on v1 gains the new fields.

### The one-line client change

Replace the base URL and the prefix. Every existing path works under `/v2/` with the same
parameters and the same response keys; v2 only **adds** keys and words. Links inside responses
(`links.self`, `links.aum`, …) are already spelled `/v2/…` when you call v2.

## 2. Contract rules that did not change

- `null` means absent, zero means zero. Never coerce.
- Every enumerated value is a word published by `GET /v2/fields`. Your build should fail on a
  word it has not seen; the list below is what you need to add for version 10.
- Every error is `{ "error": { "code", "detail", "requestId", "hint"? } }` with a stable `code`.
- Rate limit 240 requests a minute, reported in `RateLimit-Limit`, `RateLimit-Remaining`,
  `RateLimit-Reset`, `RateLimit-Scope`. A batch of 50 ids costs 50 units, shown in the
  `x-cost-units` header on the 200.
- Batch routes take at most 50 ids and answer per id, `ok: false` for an unknown one.
- No API key is required today. If `X-API-Key` is switched on you will be told first.

## 3. Words to add before switching (vocabulary v10)

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
| `positions[].priceSuspectReason` | `implied_mcap_over_ceiling`, `concentration_over_ceiling` |
| `positions.partialReason` | adds `indexer_coverage_low`, `unsellable_positions_and_indexer_coverage_low` |
| `health.dataState` | `current`, `degraded` |
| `market.regime` | `open`, `caution`, `closed` |
| `scorecard.staleness.fallback` | `on_chain` |
| `wallets.resolvedBy.*` | `fomoapi`, `gmgn`, `submitted` |

Versions 3 to 8 are the 17 Sep fix waves; their words are all included above or in `/v2/fields`.

## 4. Routes

### 4.1 Unchanged paths, new fields (26 operations)

All of these exist on v2 with the same parameters. The per-field additions are listed in
`docs/consumer/Field_Contracts.md` under the "Added 17 Sep 2026" headings; the ones that
answer your 16 Sep asks:

| Route | What v2 adds |
|---|---|
| `GET /v2/traders/:handle/positions`, `POST /v2/traders/positions` | `tokenAddress` and `priceSource` on every row; `priceSuspect` + `priceSuspectReason` (V1); the chain's own coin as a row (N1); `coverage.chains[]` with indexer coverage per chain (R6); `isHoneypot`/`canSell` per row and `partialReason: unsellable_positions` (V2) |
| `GET /v2/traders/:handle/portfolio` | native coin priced per chain (N1); honeypot-flagged value excluded and flagged (V2) |
| `GET /v2/traders/:handle/aum`, `POST /v2/traders/aum` | `partial`/`partialReason: chains_missing` naming the chains (Z2, R5); `totalUsd: null` with a reason instead of `0` (Z1); the priced floor published and partial readings served above $100 (R1, R2); step from the tracked span (S1); no more live read on v2 (`liveRead.state` is always `skipped`) |
| `GET /v2/traders/:handle/scorecard` | `byToken[]` per-coin multiples, realised share, entry/exit/peak/current market cap, `entryHoursAfterLaunch`; `recent`/`career` windows; `bleeding`; `exitTimingScore`; `isHoneypotNow`/`honeypotSince`/`exitedBeforeFlag`; `coHolders`; `staleness.fallback` (T1–T3, composite badges) |
| `GET /v2/traders/:handle/pnl` | `openPositionsHeld`, the count that matches `/positions`; `openPositions` still counts trade records, with `openPositionsBasis` naming both (P1) |
| `GET /v2/traders/:handle/wallets` | `resolvedBy.{evm,solana}`, linked wallets (W1) |
| `GET /v2/health` | `staleTraders` per chain, `historyState` counts, `dataState: degraded` while any scorecard is stale, `apiVersion: "v2"` (A1, F2, F3) |
| `GET /v2/tokens/:address` | `price` block with source, `launch` block (pump.fun curve), `security.honeypotSince`, `creator` ledger, `perHolder[].exitTimingScore` |
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

- The `/aum` live read-through is gone on v2. `?live=true` is accepted and ignored;
  `liveRead.state` is `skipped`. Readings are not sampled any more; see §5.
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
the trader has none yet. It is refreshed when a watched wallet transacts (Solana push), when a
balance slice reads the wallet, and when prices land; `source` (`webhook`, `balances`, `prices`,
`build`) says which, `ageSeconds` how old the figure was when answered, and the hourly series'
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
transfers hourly, wallet balances every 10 minutes in slices, token fundamentals every 2 hours,
fees every 2 hours, scorecards every 6 hours, directory and launches daily. A feed older than
its threshold shows `stale` in `/health` before it shows in a chart.

## 8. Verification checklist for the switch

1. `GET /v2/fields` answers `version: 10` and your allow-list build passes.
2. `GET /v2/chains` and `GET /v2/traders?limit=5` answer 200 with the same shapes as v1.
3. `GET /v2/traders/397397/aum/history?window=1w` answers 200; `count > 0` once `asOf` is set.
4. `GET /v2/traders/397397/positions` rows carry `tokenAddress` and `priceSuspect`.
5. `GET /v2/health` answers `apiVersion: "v2"`.
6. `GET /v2/traders/nope` answers 404 `not_found`; `GET /v1/chains` on the v2 host answers 404
   with the `/v2` hint.

The machine-readable reference for every operation, parameter, status code and example is
`openapi.yaml` next to this file (OpenAPI 3.0.3, the same file as `docs/openapi.yaml` in the API
repository); `fields-v10.json` is the live `GET /v2/fields` answer at the time of writing. `v1-to-v2-diff.md` maps every v1 route to its v2 counterpart and lists every field and word added.
Import the spec into your client generator or hand all four files to your agent together.
