# Field contract mapping · genie-fomo v10

Every field `Field_Contracts.md` names, mapped to the route and JSON path that serves it.

**Generated from live responses**, 16 September 2026, against `gxnonqlmujmtgczvhvzp`. Sample values are
real, taken from `unipcs` unless the field only appears elsewhere.

## 150 of 150 correct · 0 defective

| | |
|---|---|
| 🔴 load-bearing | 104 fields · **0 defective** |
| 🟠 degrades | 32 fields · **0 defective** |
| ⚪ optional | 14 fields · **0 defective** |

### What was fixed · 16 September

Nine defects were found by reconciling this contract against the live service.
All nine are fixed, deployed and verified. Nothing was removed or retyped in place —
every change either adds a field or corrects one that contradicted its own name.

| Field | Was | Now |
|---|---|---|
| `capturedAt` | epoch integer, contradicting our own published unit table | ISO-8601; `capturedAtEpoch` keeps the old value so nothing breaks |
| `gaps[].from` / `.to` | absent — only `at` and `reason` | the span each gap covers |
| `coinsTotal` | absent at the top level, so their verdict test read `undefined` | served alongside `tokensTotal` |
| `unreadableRows[]` | absent — failures appeared only as `ok:false` rows | served; the same rows also stay in `traders[]` |
| `byToken[]` (bulk) | **empty array** beside `tokensTotal: 390` — read as 'no coins' | omitted entirely, which is what an absent list means |
| `valueShare` | named as a share of value; is a count ratio | `pricedPositionShare` added with the honest name; old name kept |
| `chains[].pricedShare` | same fault | `pricedPositionShare` added alongside |
| `startCapitalUsd` | null for every trader — their 4th verdict test unanswerable | populated for **366 traders** from the month-start AUM reading |
| `returnPct` (monthly) | null, having no denominator | computed where a start balance exists |

Two faults were found *while* fixing these and also corrected: a refused anchor point
was appearing in `gaps[]` dated outside the window, and `coverage.totalWallets` could
read below `answeredWallets` for a trader who had sold out of a wallet family.

---

## The full mapping

`—` in **Ours** means the field is not served at that path.


### §1 The directory row

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `entries[]` | 🔴 load-bearing | `GET /v1/traders` | `entries` | `list(3)` |   |
| `capturedAt` | 🔴 load-bearing | `GET /v1/traders` | `capturedAt` | `2026-09-16T10:33:19.000Z` |  now ISO-8601; `capturedAtEpoch` keeps the old integer for existing parsers |
| `handle` | 🔴 load-bearing | `GET /v1/traders` | `entries[].handle` | `unipcs` |   |
| `id` | 🟠 degrades | `GET /v1/traders` | `entries[].id` | `a06e3ef7-425a-48e9-a131-22…` |   |
| `updatedAt` | 🔴 load-bearing | `GET /v1/traders` | `entries[].updatedAt` | `2026-09-16T10:33:19.000Z` |   |
| `pnl` | 🔴 load-bearing | `GET /v1/traders` | `entries[].pnl` | `10378007` |   |
| `volume` | 🟠 degrades | `GET /v1/traders` | `entries[].volume` | `4216304` |   |
| `rank` | ⚪ optional | `GET /v1/traders` | `entries[].rank` | `1` |   |
| `label` | ⚪ optional | `GET /v1/traders` | `entries[].label` | `Unipcs` |   |
| `avatarUrl` | ⚪ optional | `GET /v1/traders` | `entries[].avatarUrl` | `https://prod-fomo-profile-…` |   |
| `followers` | ⚪ optional | `GET /v1/traders` | `entries[].followers` | `655556` |   |
| `numTrades` | ⚪ optional | `GET /v1/traders` | `entries[].numTrades` | `5299` |   |
| `source` | ⚪ optional | `GET /v1/traders` | `entries[].source` | `fomoapi.io` |   |

### §2 The answer envelope

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `points[]` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `points` | `list(27)` |   |
| `handle` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `handle` | `unipcs` |   |
| `window` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `window` | `1m` |   |
| `chain` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `chain` | `null` |  null unless `?chain=` was asked |
| `chains[]` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `chains` | `list(3)` |   |
| `knownChains[]` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `knownChains` | `list(5)` |   |
| `stepMs` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `stepMs` | `86400000` |   |
| `step` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `step` | `1d` |   |
| `gaps[]` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `gaps` | `list(24)` |   |
| `breaks[]` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `breaks` | `list(2)` |   |
| `comparability` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `comparability` | `dict(3)` |   |
| `now` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `now` | `dict(11)` |   |
| `coverage` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `coverage` | `dict(4)` |   |
| `drawing` | 🟠 degrades | `GET /v1/traders/:h/aum` | `drawing` | `dict(4)` |   |
| `reach` | 🟠 degrades | `GET /v1/traders/:h/aum` | `reach` | `dict(7)` |   |
| `trackedSince` | 🟠 degrades | `GET /v1/traders/:h/aum` | `trackedSince` | `2026-09-10T16:00:00.000Z` |   |
| `status` | ⚪ optional | `GET /v1/traders/:h/aum` | `status` | `ready` |   |
| `progress` | ⚪ optional | `GET /v1/traders/:h/aum` | `progress` | `dict(6)` |   |
| `refused` | ⚪ optional | `GET /v1/traders/:h/aum` | `refused` | `null` |   |
| `plain` | ⚪ optional | `GET /v1/traders/:h/aum` | `plain` | `27 points over 1m at 1d st…` |   |
| `count` | ⚪ optional | `GET /v1/traders/:h/aum` | `count` | `27` |   |

### §2 chains[] entry

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `chain` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `chains[].chain` | `robinhood` |   |
| `networkId` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `chains[].networkId` | `4663` |   |
| `totalUsd` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `chains[].totalUsd` | `10806556.29` |   |
| `pricedShare` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `chains[].pricedShare` | `0.924` |  a COUNT ratio; `chains[].pricedPositionShare` is the honest name, this kept for compatibility |
| `reason` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `chains[].reason` | `—` |  present on every null figure; absent when priced |

### §2 knownChains[] entry

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `wallets` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `knownChains[].wallets` | `1` |   |
| `hasPositions` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `knownChains[].hasPositions` | `True` |   |
| `historyState` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `knownChains[].historyState` | `ready` |   |

### §2 gaps[] entry

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `at` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `gaps[].at` | `2026-08-18T00:00:00.000Z` |   |
| `from` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `gaps[].from` | `2026-08-18T00:00:00.000Z` |  now served |
| `to` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `gaps[].to` | `2026-08-19T00:00:00.000Z` |  now served |
| `reason` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `gaps[].reason` | `too_little_priced` |   |

### §2 breaks[] entry

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `reason` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `breaks[].reason` | `chains_changed` |   |
| `chainsAdded` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `breaks[].chainsAdded` | `list(1)` |   |
| `chainsRemoved` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `breaks[].chainsRemoved` | `list(0)` |   |
| `previousAt` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `breaks[].previousAt` | `2026-09-10T16:00:00.000Z` |   |

### §2 comparability

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `equalised` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `comparability.equalised` | `False` |   |
| `reason` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `comparability.reason` | `coverage_differs_by_method` |   |
| `detail` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `comparability.detail` | `a rebuilt point prices abo…` |   |

### §2 now

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `at` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `now.at` | `2026-09-16T11:00:00.000Z` |   |
| `totalUsd` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `now.totalUsd` | `16456606.5` |   |
| `coverage` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `now.coverage` | `dict(6)` |   |
| `tier` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `now.tier` | `verified` |   |
| `partial` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `now.partial` | `True` |   |
| `partialReason` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `now.partialReason` | `chains_missing_and_unprice…` |   |

### §2 coverage

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `answeredWallets` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `coverage.answeredWallets` | `2` |   |
| `totalWallets` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `coverage.totalWallets` | `2` |   |
| `answeredChains` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `coverage.answeredChains` | `3` |   |
| `totalChains` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `coverage.totalChains` | `5` |   |

### §2 drawing

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `drawable` | 🟠 degrades | `GET /v1/traders/:h/aum` | `drawing.drawable` | `True` |   |
| `usablePoints` | 🟠 degrades | `GET /v1/traders/:h/aum` | `drawing.usablePoints` | `3` |   |
| `reason` | 🟠 degrades | `GET /v1/traders/:h/aum` | `drawing.reason` | `null` |   |

### §2 reach

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `requestedFrom` | 🟠 degrades | `GET /v1/traders/:h/aum` | `reach.requestedFrom` | `2026-08-17T11:49:58.586Z` |   |
| `coveredFrom` | 🟠 degrades | `GET /v1/traders/:h/aum` | `reach.coveredFrom` | `2026-08-18T00:00:00.000Z` |   |
| `coveredTo` | 🟠 degrades | `GET /v1/traders/:h/aum` | `reach.coveredTo` | `2026-09-16T11:00:00.000Z` |   |
| `requestedDays` | 🟠 degrades | `GET /v1/traders/:h/aum` | `reach.requestedDays` | `30` |   |
| `coveredDays` | 🟠 degrades | `GET /v1/traders/:h/aum` | `reach.coveredDays` | `29` |   |
| `complete` | 🟠 degrades | `GET /v1/traders/:h/aum` | `reach.complete` | `True` |   |

### §2 Each point

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `at` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `points[].at` | `2026-08-18T00:00:00.000Z` |   |
| `totalUsd` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `points[].totalUsd` | `null` |  null on a refused moment, never a string |
| `coverage` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `points[].coverage` | `dict(8)` |   |
| `basis` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `points[].basis` | `rebuilt` |   |
| `tier` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `points[].tier` | `reported` |   |
| `refused` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `points[].refused` | `too_little_priced` |  on refused points only |
| `comparableWithPrevious` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `points[].comparableWithPrevious` | `null` |   |
| `outsideWindow` | 🟠 degrades | `GET /v1/traders/:h/aum?window=1d` | `points[].outsideWindow` | `—` |  on borrowed anchors only — 258 of 441 1d answers |

### §2 point.coverage

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `pricedPositions` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `points[].coverage.pricedPositions` | `16` |   |
| `totalPositions` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `points[].coverage.totalPositions` | `3170` |   |
| `valueShare` | 🔴 load-bearing | `GET /v1/traders/:h/aum` | `points[].coverage.valueShare` | `0.0032` |  a COUNT ratio; `points[].coverage.pricedPositionShare` is the honest name, this kept for compatibility |

### §2 Batch route

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `unreadableRows[]` | 🔴 load-bearing | `POST /v1/traders/aum` | `unreadableRows` | `list(1)` |  now served; the same rows also stay in `traders[]` in the order asked |
| `contractVersion` | 🔴 load-bearing | `POST /v1/traders/aum` | `contractVersion` | `2` |  now the **default**; `contractVersion: 1` returns the old short shape |

### §3 The scorecard

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `asOf` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `asOf` | `2026-09-15T08:44:34.000Z` |   |
| `loadedAt` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `loadedAt` | `2026-09-15T08:44:34.000Z` |   |
| `nextLoadAt` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `nextLoadAt` | `2026-09-17T06:00:00.000Z` |   |
| `winRate` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `winRate` | `0.4419` |   |
| `wins` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `wins` | `19` |   |
| `losses` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `losses` | `24` |   |
| `topTradeShare` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `topTradeShare` | `0.9954` |   |
| `worstTradeUsd` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `worstTradeUsd` | `-118666.88` |   |
| `bestTradeUsd` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `bestTradeUsd` | `168976.7` |   |
| `typicalBetUsd` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `typicalBetUsd` | `dict(3)` |   |
| `medianTradeUsd` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `medianTradeUsd` | `-1.04` |   |
| `meanTradeUsd` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `meanTradeUsd` | `-3049.3` |   |
| `holdingTime` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `holdingTime` | `dict(3)` |   |
| `tradesPerDay` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `tradesPerDay` | `3.85` |   |
| `trackRecordDays` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `trackRecordDays` | `116.3` |   |
| `lastTradeAt` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `lastTradeAt` | `2026-09-15T08:35:26.000Z` |   |
| `moneyIn` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `moneyIn` | `dict(2)` |   |
| `moneyOut` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `moneyOut` | `dict(2)` |   |
| `returnPct` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `returnPct` | `dict(2)` |   |
| `realizedByMonth` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `realizedByMonth` | `list(1)` |   |
| `realizedByMonthBasis` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `realizedByMonthBasis` | `dict(6)` |   |
| `realizedByDay` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `realizedByDay` | `list(3)` |   |
| `fees` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `fees` | `dict(11)` |   |
| `volume` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `volume` | `dict(4)` |   |
| `windows` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `windows` | `dict(5)` |   |
| `byToken` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `byToken` | `list(390)` |  full in the single route; OMITTED (not emptied) in the bulk shape, with `tokensTotal` giving the count |
| `entryPriceCoverage` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `entryPriceCoverage` | `dict(7)` |   |
| `fieldReasons` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `fieldReasons` | `dict(2)` |   |
| `sample` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `sample` | `dict(11)` |   |
| `complete` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `complete` | `True` |   |
| `tradesKnown` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `tradesKnown` | `448` |   |
| `tradesUsed` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `tradesUsed` | `448` |   |
| `meanToMedian` | ⚪ optional | `GET /v1/traders/:h/scorecard` | `meanToMedian` | `null` |   |
| `smallCapWinRate` | ⚪ optional | `GET /v1/traders/:h/scorecard` | `smallCapWinRate` | `dict(5)` |   |
| `perExit` | ⚪ optional | `GET /v1/traders/:h/scorecard` | `perExit` | `dict(8)` |   |

### §3 realizedByMonth[] entry

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `realizedUsd` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `realizedByMonth[].realizedUsd` | `-131120.08` |   |
| `closedTrades` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `realizedByMonth[].closedTrades` | `43` |   |
| `coverage` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `realizedByMonth[].coverage` | `dict(3)` |   |
| `complete` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `realizedByMonth[].complete` | `False` |   |
| `startCapitalUsd` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `realizedByMonth[].startCapitalUsd` | `9163556.7` |  populated from the month-start AUM reading — 366 traders; `returnPct` computed from it |

### §3 realizedByMonthBasis

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `beforeWindowUsd` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `realizedByMonthBasis.beforeWindowUsd` | `0` |   |

### §3 fees

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `paidUsd` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `fees.paidUsd` | `9.210128` |   |
| `byWindowUsd` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `fees.byWindowUsd` | `dict(4)` |   |
| `paidNative` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `fees.paidNative` | `list(3)` |   |
| `transactions` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `fees.transactions` | `1797` |   |
| `coverage` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `fees.coverage` | `dict(3)` |   |
| `includedInRealized` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `fees.includedInRealized` | `False` |   |

### §3 volume

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `reportedLifetimeUsd` | 🟠 degrades | `GET /v1/traders/:h/scorecard` | `volume.reportedLifetimeUsd` | `4216304` |   |

### §3 byToken[] entry

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `avgEntryMarketCapUsd` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `byToken[].avgEntryMarketCapUsd` | `null` |   |
| `avgEntryPrice` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `byToken[].avgEntryPrice` | `null` |   |
| `avgExitPrice` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `byToken[].avgExitPrice` | `0.0832834` |   |
| `firstEntryPrice` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `byToken[].firstEntryPrice` | `null` |   |
| `realizedPnlUsd` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `byToken[].realizedPnlUsd` | `168976.7` |   |
| `closed` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `byToken[].closed` | `1` |   |
| `trades` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `byToken[].trades` | `2` |   |
| `entryMethod` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `byToken[].entryMethod` | `null` |   |
| `exitMethod` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `byToken[].exitMethod` | `single_position` |   |

### §4 cashOut axis

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `bankedUsd` | 🔴 load-bearing | `GET /v1/traders/:h/pnl` | `bankedUsd` | `-131120.08` |   |
| `onPaperUsd` | 🔴 load-bearing | `GET /v1/traders/:h/pnl` | `onPaperUsd` | `9776817.3` |   |
| `realizedShare` | 🔴 load-bearing | `GET /v1/traders/:h/pnl` | `realizedShare` | `null` |   |

### §4 riskControl axis

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `cashShare` | 🔴 load-bearing | `GET /v1/traders/:h/portfolio` | `cashShare` | `0.0001` |   |
| `concentration` | 🔴 load-bearing | `GET /v1/traders/:h/portfolio` | `concentration` | `0.5105` |   |

### §4 activityDensity axis

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `activeDays` | 🔴 load-bearing | `GET /v1/traders/:h` | `onChain.activeDays` | `66` |   |

### §4 holdTime axis

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `holdingTime.medianDays` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `holdingTime.medianDays` | `1.06` |   |

### §5 Verdict tests

| Their field | Level | Our route | Our path | Live value | |
|---|---|---|---|---|---|
| `coinsTotal` | 🔴 load-bearing | `GET /v1/traders/:h/scorecard` | `coinsTotal` | `390` |  now served at the top level, alongside `tokensTotal` |
