# v1 → v2: route map, differences and additions (18 Sep 2026)

Companion to `README.md` (the guide) and `openapi.yaml` (the reference). v1 is the Supabase deployment frozen at the 16 Sep 2026 deploy; v2 is the Cloudflare Worker. Same database, same route names; v2 adds. Vocabulary: v1 answers `version: 2`, v2 answers `version: 10`.

## 1. Route map

| v1 (Supabase) | v2 (Cloudflare) | Status |
|---|---|---|
| `GET /v1/chains` | `GET /v2/chains` | unchanged |
| `GET /v1/fields` | `GET /v2/fields` | extended: version 10, constants block |
| `GET /v1/health` | `GET /v2/health` | extended: staleTraders per chain, historyState, dataState, apiVersion |
| `GET /v1/traders` | `GET /v2/traders` | extended: orderBy/direction/range filters, include=trust, source |
| `GET /v1/traders/:handle` | `GET /v2/traders/:handle` | extended: source, onChain per chain |
| `GET /v1/traders/:handle/trust` | `GET /v2/traders/:handle/trust` | unchanged |
| `GET /v1/traders/:handle/wallets` | `GET /v2/traders/:handle/wallets` | extended: resolvedBy, linked wallets |
| `POST /v1/traders/:handle/wallets` | `POST /v2/traders/:handle/wallets` | unchanged |
| `GET /v1/traders/:handle/portfolio` | `GET /v2/traders/:handle/portfolio` | extended: native coin priced, honeypot exclusion |
| `GET /v1/traders/:handle/positions` | `GET /v2/traders/:handle/positions` | extended: tokenAddress, priceSource, priceSuspect, native rows, coverage.chains, sell flags |
| `POST /v1/traders/positions` | `POST /v2/traders/positions` | extended: same as GET per row |
| `GET /v1/traders/:handle/scorecard` | `GET /v2/traders/:handle/scorecard` | extended: byToken economics, recent/career, bleeding, exitTimingScore, honeypot/cohort, staleness.fallback |
| `GET /v1/traders/:handle/pnl` | `GET /v2/traders/:handle/pnl` | changed: openPositions counts what /positions lists |
| `GET /v1/traders/:handle/trades` | `GET /v2/traders/:handle/trades` | extended: since/until/status filters |
| `GET /v1/traders/:handle/transactions` | `GET /v2/traders/:handle/transactions` | unchanged |
| `GET /v1/traders/:handle/aum` | `GET /v2/traders/:handle/aum` | LEGACY on v2: partial/chains_missing, null-not-zero, step from tracked span; readings stop at 18 Sep; live read never runs (`liveRead.state: skipped`) |
| `POST /v1/traders/aum` | `POST /v2/traders/aum` | legacy, as above |
| `GET /v1/tokens` | `GET /v2/tokens` | extended: range filters, excludeHoneypots |
| `GET /v1/tokens/:address` | `GET /v2/tokens/:address` | extended: price block, launch, security.honeypotSince, cohort, creator ledger, perHolder exitTimingScore |
| `GET /v1/tokens/:address/activity` | `GET /v2/tokens/:address/activity` | extended: sellers[].exitTimingScore |
| `GET /v1/tokens/momentum` | `GET /v2/tokens/momentum` | unchanged |
| `—` | `GET /v2/events` | NEW: keyset feed of transfers, swaps, readings |
| `—` | `GET /v2/traders/:handle/flow, POST /v2/traders/flow` | NEW: Solana net flow since a time |
| `—` | `GET /v2/creators/:address` | NEW: deployer ledger |
| `—` | `GET /v2/market/regime` | NEW: cohort regime |
| `—` | `GET /v2/traders/:handle/aum/history, POST /v2/traders/aum/history` | NEW: the chart source (hourly/daily/weekly/monthly, built, back to 11 Aug 2026), with the `now` block |
| `—` | `GET /v2/traders/:handle/aum/now, POST /v2/traders/aum/now` | NEW: the live value |
| `—` | `GET /v2/tokens/:address/prices, POST /v2/tokens/prices` | NEW: price history with rollups, latest, ath |

## 2. Behaviour that changed on the same path

- `/aum` no longer performs a live chain read; `?live=true` is accepted and ignored, `liveRead.state` is always `skipped`. Its readings stop growing on 18 Sep 2026. Use `/aum/history` and `/aum/now`.
- `/aum` readings that priced nothing are `totalUsd: null` with a reason, never `0` (Z1); a reading that answered fewer chains than known is `partial: true, partialReason: chains_missing` naming them (Z2, R5).
- `/pnl.openPositions` counts what `/positions` lists (P1).
- `/positions` rows carry `amount` as null when unknown on the single route as on the batch route (the single route used to coerce to 0).
- `/health.dataState` is `degraded` while any scorecard is stale (T2); `/fields.version` gates your build.
- `error.code` publishes `unavailable`, `include_unavailable`, `internal_error` (v1 published the never-emitted `internal`).

## 3. Fields added since the 16 Sep contract, by route

Every line below is also in `Field_Contracts.md` with its full contract; the wave column says which fix or workflow added it.

### `/aum`

| Field | Wave | Contract (first line) |
|---|---|---|
| `aum.points[].refused`, `aum.gaps[].reason` | Added 17 Sep 2026 (vocabulary v3, pre-migration fixes) | + `price_suspect` (one coin dominates and its price fails the cap or concentration check), + `no_tokens_known` |
| `aum.chains[].reason` | Added 17 Sep 2026 (vocabulary v3, pre-migration fixes) | + `wallet_unreadable`, `service_timeout`, `no_tokens_known`, `price_suspect` |
| `aum.drawing.reason` | Added 17 Sep 2026 (vocabulary v3, pre-migration fixes) | + `rebuilt_only`: usable points exist but none is sampled |
| `aum.points[].reliability` | Added 17 Sep 2026 (vocabulary v3, pre-migration fixes) | `low` on every `basis: rebuilt` point; absent otherwise |
| `aum.stepChosenFrom` | Added 17 Sep 2026 (vocabulary v3, pre-migration fixes) | `window` \ |
| `aum.coverage.partialReason = unpriced_positions` | Added 17 Sep 2026 (vocabulary v3, pre-migration fixes) | may now carry `totalUsd` (served partial, figure >= `constants.partialServeFloorUsd`) |
| `aum.sampler.state = never_read` | Added 17 Sep 2026, second wave (vocabulary v4) | the sampler has never covered this trader (no reading row at all) |

### `/fields`

| Field | Wave | Contract (first line) |
|---|---|---|
| `constants` | Added 17 Sep 2026 (vocabulary v3, pre-migration fixes) | `{ pricedFloor: 0.25, partialServeFloorUsd: 100, drawableMinPoints: 2 }` |

### `POST /traders/aum`

| Field | Wave | Contract (first line) |
|---|---|---|
| `traders[].aum.liveRead` | Added 17 Sep 2026 (vocabulary v3, pre-migration fixes) | always `{ state: "skipped", note }`; the batch never reads live |

### `/positions, POST /traders/positions`

| Field | Wave | Contract (first line) |
|---|---|---|
| `positions[].isNative` | Added 17 Sep 2026 (vocabulary v3, pre-migration fixes) | true for the chain's own coin; EVM sentinel `0x0000000000000000000000000000000000000000`, Solana `111111111111 |
| `positions[].priceSuspect`, `priceSuspectReason` | Added 17 Sep 2026 (vocabulary v3, pre-migration fixes) | boolean; `implied_mcap_over_ceiling` \ |

### `/positions, /portfolio, POST /traders/positions`

| Field | Wave | Contract (first line) |
|---|---|---|
| `positions[].isHoneypot`, `canSell`, `unsellableUsd`, `partial`, `partialReason` | Added 17 Sep 2026 (vocabulary v3, pre-migration fixes) | flagged value is excluded from totals into `unsellableUsd`; `partialReason: unsellable_positions` |

### `/wallets`

| Field | Wave | Contract (first line) |
|---|---|---|
| `wallets.resolvedBy.{evm,solana}`, `wallets.fingerprintMatches` | Added 17 Sep 2026 (vocabulary v3, pre-migration fixes) | `fomoapi` \ |
| `linked[]` | Added 17 Sep 2026, creators and linked wallets | `[{ chain, address, linkedFrom, kind, firstSeenAt, evidenceTx, watch }]`, wallets the trader funded from his k |

### `/traders/:handle`

| Field | Wave | Contract (first line) |
|---|---|---|
| `onChain.chainsCovered` | Added 17 Sep 2026 (vocabulary v3, pre-migration fixes) | chains present in the stored transaction feed; all-zero counts outside this list mean "not covered" |

### `/health`

| Field | Wave | Contract (first line) |
|---|---|---|
| `health.staleFeeds[]` | Added 17 Sep 2026 (vocabulary v3, pre-migration fixes) | + `scorecards` when any scorecard is past its own `staleAfterHours`; `dataState` is then `degraded` |
| `health.feeds.aum.chains.{chain}` | Added 17 Sep 2026 (vocabulary v3, pre-migration fixes) | `{ accepted36h, failed24h, newestAcceptedAt }` per chain |
| `health.staleTraders.scorecardLoadFailed` | Added 17 Sep 2026, second wave (vocabulary v4) | traders past 72 h whose latest load attempt was not `loaded` |
| `health.feeds.aum.historyState`, `health.feeds.aum.chains.{chain}.historyState` | Added 17 Sep 2026, second wave (vocabulary v4) | `{ ready, warming, none }` counts of trader-chains, same definition as `wallets.knownChains[].historyState` |
| `health.feeds.aum.state`, `samplerLastRunAt` | Added 17 Sep 2026, second wave (vocabulary v4) | the feed clock is the newest ACCEPTED reading; the sampler's own clock moved to `samplerLastRunAt` |
| `health.staleTraders.noReading` | Added 17 Sep 2026, second wave (vocabulary v4) | now counts every listed trader with no accepted reading (refused readings do not count) |

### `/pnl, /traders?include=pnl`

| Field | Wave | Contract (first line) |
|---|---|---|
| `pnl.openPositionsHeld`, `pnl.openPositionsBasis` | Added 17 Sep 2026, second wave (vocabulary v4) | open trade records whose token the wallet still holds on chain; basis words `trade_records`, `trade_records_st |

### `stored; affects /pnl, /scorecard, /tokens`

| Field | Wave | Contract (first line) |
|---|---|---|
| `trades.status = closed_by_balance` | Added 17 Sep 2026, second wave (vocabulary v4) | a trade fomo calls open for a token a chain read no longer holds; never counted as open, never as a realised c |

### `/scorecard`

| Field | Wave | Contract (first line) |
|---|---|---|
| `scorecard.loadAttemptedAt`, `loadOutcome`, `nextLoadBasis` | Added 17 Sep 2026, second wave (vocabulary v4) | last fomoapi fetch attempt and its outcome (`loaded` \ |
| `scorecard.onChain` | Added 17 Sep 2026, T3 (bounded) | `{ basis: wallet_swaps, swaps, buys, sells, volumeUsd, realizedPnlUsd, winRate, wins, losses, coverage: { of:  |
| `byToken[].exitMcapUsd`, `byToken[].betUsd` | Added 17 Sep 2026, composite badges | the same values as `avgExitMarketCapUsd` and `costUsd`, under the badge note's names: one value, two names |
| `byToken[].currentPriceUsd`, `byToken[].currentMcapUsd` | Added 17 Sep 2026, composite badges | `token_info.price_usd` / `market_cap_usd` at the last token-info load; null when no row |
| `byToken[].peakMcapSinceEntryUsd` | Added 17 Sep 2026, composite badges | `token_price_stats.ath_usd × totalSupply`, only when `ath_at >= firstOpenedAt`. Null before hourly sampling re |
| `byToken[].multipleRealized`, `multipleCurrent`, `multiplePeak` | Added 17 Sep 2026, composite badges | weighted exit / current price / sampled ATH, each divided by `avgEntryPrice` (4 dp). Null, never 0, when eithe |
| `byToken[].realizedShare` | Added 17 Sep 2026, composite badges | exit quantity ÷ entry quantity, clamped to 0..1; null when no entry quantity is recoverable (`costQuantity` nu |
| `byToken[].closedMonth` | Added 17 Sep 2026, composite badges | `YYYY-MM` of `lastClosedAt`; null when never closed |
| `byToken[].entryHoursAfterLaunch` | Added 17 Sep 2026, composite badges | hours from launch to `firstOpenedAt`; launch = `tokens.created_at` (chain read) when set, else GMGN's `tokenCr |
| `typicalBetUsd.perCoinUsd` | Added 17 Sep 2026, composite badges | median of `byToken[].betUsd`; the composite floor. `typicalBetUsd.value` and `.method` are unchanged (per-posi |
| `medianWinUsd`, `medianLossUsd` | Added 17 Sep 2026, composite badges | median realised P&L over closed positions with a figure, winners and losers separately; `medianLossUsd` is neg |
| `bigWinMonths` | Added 17 Sep 2026, composite badges | distinct `closedMonth` with a coin at `multipleRealized >= 10`; null when no coin carries a multiple, 0 when s |
| `recent` | Added 17 Sep 2026, composite badges | `{ lastBigWinAt (last close of a coin at >= 5x), closes4w, green4w (closes in the last 28 days, and those with |
| `career` | Added 17 Sep 2026, composite badges | `{ avgRealizedUsd, entryMcapMedianUsd, holdHoursMedian, tradesPerDay, basis }` over every closed position with |
| `bleeding`, `bleedingBasis` | Added 17 Sep 2026, composite badges | true only when `career.avgRealizedUsd − recent.last20.avgRealizedUsd > typicalBetUsd.perCoinUsd` OR `recent.la |
| `exitTimingScore` | Added 17 Sep 2026, composite badges | share of closed coins whose `currentPriceUsd` is below `avgExitPrice`, in 0..1; null under 5 closed coins carr |

### `/positions, POST /traders/positions v2`

| Field | Wave | Contract (first line) |
|---|---|---|
| `positions.coverage.chains.{chain}` | Added 17 Sep 2026, second wave (vocabulary v4) | `{ chainTxCount, rowsHeld, share, readAt }` from one `eth_getTransactionCount` per sampled EVM chain; `partial |

### `/positions, /aum`

| Field | Wave | Contract (first line) |
|---|---|---|
| Robinhood-chain prices | Added 17 Sep 2026, second wave (vocabulary v4) | coins GMGN misses are priced nightly from DexScreener into `token_prices`; they surface as the existing `price |

### `/scorecard, /traders?include=scorecard`

| Field | Wave | Contract (first line) |
|---|---|---|
| `scorecard.staleness.fallback` | Added 17 Sep 2026, T3 (bounded) | `on_chain` when `staleness.state` is `stale` or `never` AND `onChain.swaps > 0`: draw `onChain` instead of the |

### `GET /events`

| Field | Wave | Contract (first line) |
|---|---|---|
| `events[]`, `nextCursor`, `count`, `asOf`, `since`, `filters`, `note` | Added 17 Sep 2026, events feed | keyset feed over `transactions`, `wallet_swaps` and `aum_samples` (`basis: sampled`), ordered `(at, kind, txHa |

### `/positions`

| Field | Wave | Contract (first line) |
|---|---|---|
| `entries[].amountLive` | Added 17 Sep 2026, live holdings | Solana: `amount` + signed transfers (`in` +, `out` −) with `block_time > balanceAt`, from the webhook feed. EV |
| `entries[].deltaSinceRead` | Added 17 Sep 2026, live holdings | the signed sum itself. `0` = nothing moved since the read (Solana); `null` = not rolled forward (EVM) |
| `entries[].lastTransferAt` | Added 17 Sep 2026, live holdings | newest transfer since the read, else `null` |
| `entries[].tier` | Added 17 Sep 2026, live holdings | new value `rolled_forward`: a position opened since the read, with `amount: 0`, `balanceAt: null`, no price. O |
| `liveBasis` | Added 17 Sep 2026, live holdings | `{ solana: "rolled_forward_from_transfers", evm: "nightly_read" }` — what `amountLive` is on each chain |

### `/traders/:handle/flow?since=, POST /traders/flow { ids, since }`

| Field | Wave | Contract (first line) |
|---|---|---|
| `rows[]` | Added 17 Sep 2026, live holdings | `{ chain, tokenAddress, tokenKey, in, out, net, transfers, firstAt, lastAt }` per token moved since `since` (r |

### `/tokens/:address`

| Field | Wave | Contract (first line) |
|---|---|---|
| `entries[].creator.ledger` | Added 17 Sep 2026, creators and linked wallets | `{ launches, bestPeakMcapUsd, bestToken, stillHoldingCount, soldCount, honeypotCount, lastLaunchAt }` for this |
| `entries[].security.honeypotSince` | Added 17 Sep 2026, honeypot-since and cohort | ISO time of the first nightly security read where `isHoneypot` or sell-blocked became true (`token_info.honeyp |
| `entries[].cohort` | Added 17 Sep 2026, honeypot-since and cohort | `{ holders, independent, linkedGroups }`, per chain. `holders`: distinct tracked traders with any `trades` row |

### `new route`

| Field | Wave | Contract (first line) |
|---|---|---|
| `GET /creators/:address` | Added 17 Sep 2026, creators and linked wallets | `{ creator, asOf, ledger, tokens: [{ chain, tokenAddress, symbol, status, isHoneypot, marketCapUsd }], tier: t |

### `GET /market/regime`

| Field | Wave | Contract (first line) |
|---|---|---|
| `regime` | Added 17 Sep 2026, market regime | `open` \ |
| `rule` | Added 17 Sep 2026, market regime | `{ closedBelow: 0.25, cautionBelow: 0.5, survivalDowngradeBelow: 0.1, basis }`, the thresholds above, publishe |
| `leaders` | Added 17 Sep 2026, market regime | `{ total, green7d, greenShare7d, basis }`: traders with ≥ 1 `closed_at` in the last 7 days; green = `sum(reali |
| `launches` | Added 17 Sep 2026, market regime | `{ seen7d, graduated7d, survival7d, chains: ["solana"], basis }`: `tokens.created_at` in the last 7 days, `gra |
| `rotation` | Added 17 Sep 2026, market regime | `{ tokensMoved7d, topShare7d, basis }` from `transactions` in the last 7 days across tracked wallets: distinct |
| `asOf`, `window`, `cachedForSeconds` | Added 17 Sep 2026, market regime | `window` is always `7d`; the body is identical for every caller and served from a 60 s per-instance cache, so  |

### `/scorecard, `?include=scorecard``

| Field | Wave | Contract (first line) |
|---|---|---|
| `byToken[].isHoneypotNow` | Added 17 Sep 2026, honeypot-since and cohort | latest GMGN read: `true` when honeypot or sell-blocked, `false` when checked and neither, `null` when the chai |

### `same`

| Field | Wave | Contract (first line) |
|---|---|---|
| `byToken[].honeypotSince` | Added 17 Sep 2026, honeypot-since and cohort | as `security.honeypotSince` above, on the coin the trader traded |
| `byToken[].exitedBeforeFlag` | Added 17 Sep 2026, honeypot-since and cohort | `true` when `honeypotSince` is set and the trader's `lastClosedAt` is before it; `false` when set and he close |
| `byToken[].coHolders` | Added 17 Sep 2026, honeypot-since and cohort | distinct OTHER tracked traders with a `trades` row in the same coin on the same chain; `0` when he is alone, ` |
| `now.at` | Added 18 Sep 2026 — live value | When the figure was last refreshed, ISO-8601 UTC |
| `now.totalUsd` | Added 18 Sep 2026 — live value | Value held in USD; `null` when not valued, never 0 |
| `now.pricedPositions`, `now.totalPositions` | Added 18 Sep 2026 — live value | Positions priced and held at `at` |
| `now.reason` | Added 18 Sep 2026 — live value | Why `totalUsd` is null: `no_holdings`, `no_prices`, `too_little_priced` (`aumHistory.now.reason`, the same wor |
| `now.source` | Added 18 Sep 2026 — live value | What last refreshed the figure: `webhook`, `balances`, `prices`, `build` (`aumHistory.now.source`) |
| `now.ageSeconds` | Added 18 Sep 2026 — live value | Whole seconds between `at` and the answer; never negative |
| `window` | Added 18 Sep 2026 — token prices | One of `1d`, `1w`, `1m`, `3m`, `1y`, `all`; default `1w`. `from`/`to` (ISO-8601) override it; `from` after `to |
| `from`, `to` | Added 18 Sep 2026 — token prices | The bounds actually read, UTC ISO; `from` is `null` only for `all` with no explicit start. |
| `points[].at` | Added 18 Sep 2026 — token prices | Start of the bucket (the sampled hour for `1h`; UTC day, ISO week (Monday) or calendar month otherwise). Ascen |
| `points[].usd` | Added 18 Sep 2026 — token prices | The hour's sample for `1h`; the bucket's close (last sampled hour) otherwise. Never 0 for "unknown": an hour w |

### `/tokens/:address/activity`

| Field | Wave | Contract (first line) |
|---|---|---|
| `perHolder[].exitTimingScore` | Added 17 Sep 2026, composite badges | the same score for that trader across every coin he has closed, not this coin alone; same null rule |

### `every route`

| Field | Wave | Contract (first line) |
|---|---|---|
| `error.code` | Added 17 Sep 2026 — error codes (vocabulary v8) | One of `not_found`, `bad_request`, `duplicate_identifier`, `rate_limited`, `timeout`, `unavailable`, `include_ |

### `/aum/history`

| Field | Wave | Contract (first line) |
|---|---|---|
| `step` | Added 18 Sep 2026 — aum history | One of `1h`, `1d`, `1w`, `1mo`. Defaults from `window`: 1d, 1w → `1h`; 1m, 3m → `1d`; 1y → `1w`; all → `1mo`.  |
| `window` | Added 18 Sep 2026 — aum history | One of `1d`, `1w` (default), `1m`, `3m`, `1y`, `all`; the range ends now. `from` / `to` (ISO-8601) override ei |
| `from`, `to` | Added 18 Sep 2026 — aum history | The bounds applied, ISO-8601 UTC; `from` is null for `all` with no `from` |
| `points[]` | Added 18 Sep 2026 — aum history | Ascending, newest last; at most `limit` (≤ 2000, default 2000) NEWEST points. No cursor: the range is bounded |
| `points[].at` | Added 18 Sep 2026 — aum history | Bucket start, UTC |
| `points[].totalUsd` | Added 18 Sep 2026 — aum history | Value held in USD; null when the bucket was not valued, never 0. On rolled-up steps it is the close (last valu |
| `points[].basis` | Added 18 Sep 2026 — aum history | `1h` only. `reading` when a sampled reading stood in that hour; `priced` when built from holdings and prices |
| `points[].reason` | Added 18 Sep 2026 — aum history | `1h` only. Why `totalUsd` is null: `no_holdings`, `no_prices`, `too_little_priced`; null when valued |
| `points[].pricedPositions`, `points[].totalPositions` | Added 18 Sep 2026 — aum history | `1h` only. Positions priced and held in that hour |
| `points[].highUsd`, `points[].lowUsd` | Added 18 Sep 2026 — aum history | `1d` / `1w` / `1mo` only. Highest and lowest valued hour in the bucket; null when none |
| `points[].valuedHours` | Added 18 Sep 2026 — aum history | `1d` / `1w` / `1mo` only. Hours in the bucket that carried a value |
| `count`, `valued` | Added 18 Sep 2026 — aum history | Points returned, and those with a non-null `totalUsd` |
| `latest` | Added 18 Sep 2026 — aum history | `{ at, totalUsd }` of the newest valued point in range; null when none |
| `asOf` | Added 18 Sep 2026 — aum history | When this trader's history was last built (`max(computed_at)`); null when never. The batch envelope's `asOf` i |
| `links.now` | Added 18 Sep 2026 — live value | The trader's `/aum/now` |

### `POST /traders/aum/history`

| Field | Wave | Contract (first line) |
|---|---|---|
| `traders[]` | Added 18 Sep 2026 — aum history | One entry per requested id in the order sent; `ok: false` with a `not_found` error for an unknown id; `ok: tru |

### `/aum/history, /aum/now`

| Field | Wave | Contract (first line) |
|---|---|---|
| `now` | Added 18 Sep 2026 — live value | The live figure; `null` when the trader has none yet (never an empty object, never 0) |

### `POST /traders/aum/now`

| Field | Wave | Contract (first line) |
|---|---|---|
| `asOf` | Added 18 Sep 2026 — live value | The newest `now.at` across the traders answered; `null` when none has a live figure |
| `traders[]` | Added 18 Sep 2026 — live value | One entry per requested id in the order sent; `ok: false` with a `not_found` error for an unknown id; `ok: tru |

### `/tokens/:address/prices, POST /tokens/prices`

| Field | Wave | Contract (first line) |
|---|---|---|
| `step` | Added 18 Sep 2026 — token prices | One of `1h`, `1d`, `1w`, `1mo` (`tokenPrices.step`, vocabulary v9). Defaults from `window`: `1d`/`1w` → `1h`,  |

### `same, step ≠ `1h``

| Field | Wave | Contract (first line) |
|---|---|---|
| `points[].openUsd`, `highUsd`, `lowUsd`, `hours` | Added 18 Sep 2026 — token prices | First sampled hour, max, min, and how many hourly samples the bucket holds (a partial bucket has fewer than 24 |

### `same, step `1h``

| Field | Wave | Contract (first line) |
|---|---|---|
| `points[].liquidityUsd` | Added 18 Sep 2026 — token prices | DexScreener liquidity at that hour; `null` when the source gave none. Absent on other steps. |

### `GET`

| Field | Wave | Contract (first line) |
|---|---|---|
| `count`, `limit`, `truncated` | Added 18 Sep 2026 — token prices | Points returned; the cap (`?limit=`, at most 2000, default 2000); `truncated: true` when the span held more th |
| `ath` | Added 18 Sep 2026 — token prices | `{ usd, at }`, the running max since sampling began (not the token's lifetime high); `null` before the first s |

### `both`

| Field | Wave | Contract (first line) |
|---|---|---|
| `latest` | Added 18 Sep 2026 — token prices | `{ at, usd }` from `token_price_stats`, the newest hourly sample; `null` before the first sample. |
| `asOf` | Added 18 Sep 2026 — token prices | `latest.at` (batch: the newest across the answered tokens); `null` when none is sampled. |

### `POST`

| Field | Wave | Contract (first line) |
|---|---|---|
| `tokens[].ok`, `error` | Added 18 Sep 2026 — token prices | `ok: false` with `error: "not_found"` (address not in `tokens`, on that chain when `chain` was sent) or `error |

## 4. Words added to the vocabulary (v2 → v10)

`GET /v2/fields` is the source; `fields-v10.json` in this folder is the snapshot at handover. Add every word your allow-list lacks before pointing at v2; the guide's §3 lists the ones that matter most.

## 5. Removed

Nothing you read on v1 is removed on v2. Fields keep their names and units. The only route family that stops evolving is `/aum`; it is served for compatibility and will be retired with v1.
