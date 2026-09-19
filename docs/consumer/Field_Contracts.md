Field contract · for the genie-fomo engineer

&nbsp;

Every field Genie reads, and what breaks when it changes

Read out of the readers themselves, not from memory, and cross-checked against live v10 answers for poopinyourhands and notanicecat69 on 15 September. If a field here changes name, type or meaning, something on a person's screen changes with it.

&nbsp;

Service genie-fomo v10

Read 15 September 2026

Source plugins/nmo/server/traderReportSources.ts · fomoscan.ts · traderChainAum.ts

How to read this

Every row is a field our code actually touches. The consequence column says what happens on a screen if it goes missing or changes meaning — that is the thing worth testing, not the field's presence.

&nbsp;

Three levels of dependence:

&nbsp;

load-bearing

degrades

optional

Load-bearing means a screen goes blank, a figure disappears, or a whole population of traders becomes unusable. Degrades means one row or sentence is lost and the rest survives. Optional means we read it and can do without it.

&nbsp;

§0

What we call, and how often

Six routes. The cadence matters as much as the fields: we now follow the service's own load time rather than a clock of our own, so anything that changes asOf or nextLoadAt semantics changes how often every other route is called.

&nbsp;

GET /traders?limit=500                      the directory — every hour, 1 call

GET /traders?include=scorecard\&limit=100    freshness index — 5 pages, only while a load is due

GET /v1/traders/:handle/scorecard           one trader, full record — only when his load moved

GET /v1/traders/:id/aum?window=1d|1w|1m|all balance history — hourly, per trader per window

GET /v1/traders/aum   (POST, batch of 50\)   balance history in bulk, contractVersion 2

GET /v1/traders/:handle/pnl                 banked vs on paper

GET /v1/traders/:handle/portfolio           holdings and concentration

GET /v1/traders/:handle/transactions        on-chain swaps

A full sync measured end to end on 15 Sep: 5 board calls in 34.5 s to learn who moved, then 155 single reads in 151 s. 158 calls, 185 seconds, against a stated allowance of 240 a minute. Before this, it was one call per trader whether or not anything had changed.

§1

The directory row

Every trader in the app starts as one of these. A row with no handle is dropped — not an error, just unusable — and one row being dropped never refuses the list.

&nbsp;

field	level	consequence if it changes or goes

entries\[\]	load-bearing	The whole board is refused. Everything downstream falls back to a stored copy with nothing saying it is old.

capturedAt	load-bearing	Same — a board with no captured moment is refused outright.

handle	load-bearing	That trader vanishes. It is what a link opens, what our tables are keyed on, and what the screen prints. An empty string counts as absent — the service's own loader once let "" through and 163 traders ended up named nothing.

id	degrades	Carried when given, required never — but it is the only stable key. Without it a rename orphans a trader's whole history.

updatedAt	load-bearing	Per-trader freshness. Null is common and normal (291 of 435 carry one) and means "we cannot say when" — never "nothing changed".

pnl	load-bearing	Every profit figure on the Traders tab becomes a dash. We read pnl and pnlUsd in one place because the two spellings once cost exactly that.

volume	degrades	Same shape, same two spellings.

rank	optional	291 of 435 have no rank deliberately. A row without one is still a row.

label · avatarUrl · followers · numTrades · source	optional	Cosmetic or informational; the row survives without them.

§2

The balance chart

Four windows per trader. Our rule is now absolute: a chart is the sum of a trader's chains, and two or more priced readings draw a line whatever sits between them. Only a break the service itself declares can still split one.

&nbsp;

The answer envelope

field	level	consequence

points\[\]	load-bearing	No array, no answer — the whole response is refused as malformed.

handle	load-bearing	Checked against what we asked. A mismatch refuses the answer, because one trader's dollars stored under another's is undetectable afterwards.

window	load-bearing	Echo check. A window that is not the one asked for refuses the answer.

chain	load-bearing	Echo check on per-chain reads. One chain's figure stored as the whole trader's is a line about the wrong money.

chains\[\]	load-bearing	The per-chain split is the chart. Without it there is nothing to sum. Each entry needs chain, networkId, totalUsd, pricedShare, and reason when unpriced.

knownChains\[\]	load-bearing	Which chains exist for him at all, with wallets, hasPositions, historyState. Decides what we ask for per chain.

stepMs · step	load-bearing	Sets where readings fall. Without it we cannot tell a gap from a cadence.

gaps\[\]	load-bearing	Each carries at, from, to, reason. An absent list means "we did not say" and must never be read as "there are none". These reasons become the sentence a person reads.

breaks\[\]	load-bearing	reason, chainsAdded, chainsRemoved, previousAt. This is now the only thing that splits a line. Lose it and we join readings the service has told us not to compare — it was 1,507 month-window jumps before we started reading it.

comparability	load-bearing	equalised, reason, detail. Agrees with breaks\[\] and with each point's flag.

now	load-bearing	The headline balance, with its own at, totalUsd, coverage, tier, partial, partialReason.

coverage	load-bearing	answeredWallets/totalWallets, answeredChains/totalChains. The only field distinguishing a man who moved his money from one we only half read.

drawing	degrades	drawable, usablePoints, reason. Must agree with the points actually sent.

reach	degrades	requestedFrom/coveredFrom/coveredTo, requestedDays/coveredDays, complete. Stops "all time" quietly meaning three weeks.

trackedSince	degrades	Everything before it is rebuilt rather than measured. Without it we cannot say which is which.

status · progress · refused · plain · count	optional	Read; the chart survives without them.

Each point

field	level	consequence

at	load-bearing	A point that cannot be placed is dropped.

totalUsd	load-bearing	Null is legitimate — a refused moment. But a value present and unreadable (a string where a number belongs) refuses the entire answer, deliberately: a reading silently turned into "no figure" is indistinguishable from one never taken.

coverage	load-bearing	pricedPositions, totalPositions, valueShare. Our floor refuses readings below a quarter. See the warning below — this field is mislabelled.

basis	load-bearing	sampled or rebuilt. Absent means unknown, never the good value.

tier	load-bearing	verified or reported. A percentage is printed only between two verified ends — this field is what enforces it.

refused	load-bearing	The service's own word for why this moment has no figure. Becomes a sentence on a card. Discarding it is what made our app invent causes.

comparableWithPrevious	load-bearing	Agrees with breaks\[\]. Null on the first reading, or when unsaid.

outsideWindow	degrades	Borrowed readings a short window holds none of its own.

The one field we cannot trust by its name. coverage.valueShare is not a share of value. Measured on poopinyourhands: pricedPositions 4, totalPositions 18, valueShare 0.2222 — and 4 ÷ 18 \= 0.2222 exactly. The portfolio route does the same (3 priced of 17 → pricedShare 0.1765). On rebuilt readings it is sometimes a different count again: the lowest chain's share. It is never a share of value, and a consumer cannot tell which count it is being given.

Why that matters: his portfolio is one real holding ($209.93 of a BSC token, fully priced) plus sixteen positions of which thirteen hold roughly one billionth of a token each. By value we have priced essentially all of what he owns; the field reports 22%, and your own one-fifth floor refuses his ethereum chain on that same polluted count. Fixing the count at source fixes your refusal and ours at once.

Batch route: every asked id must appear either in traders\[\] or in unreadableRows\[\]. A silently dropped row is indistinguishable from a trader with no data. contractVersion: 2 is required — without it the batch answers a short row with no chains block at all, which made all 435 warmed traders read as chainless while a single read of the same man returned five chains.

§3

The scorecard — the deep dive's whole foundation

One call per trader, only when his load has moved. Everything on the trader profile below the chart comes from here.

&nbsp;

field	level	what it feeds

asOf · loadedAt · nextLoadAt	load-bearing	Decides whether we re-read at all. A record is due when your load time is newer than the asOf we hold — not on nextLoadAt alone. Trusting the stated next load served a man's $7,761 while you had $12,425.

winRate · wins · losses	load-bearing	The "picks winners" axis, and a hard floor in the verdict. Must state its denominator.

topTradeShare	load-bearing	The "real record" test — one trade making most of the profit fails it.

worstTradeUsd · bestTradeUsd	load-bearing	The "avoids big losses" axis, and the risk block.

typicalBetUsd	load-bearing	Same axis — the worst loss is judged against it.

medianTradeUsd · meanTradeUsd	degrades	In 173 of 439 traders the median loses while the mean makes money. That is a fact about a man nothing else states.

holdingTime	load-bearing	The "holds coins" axis. Never derived by us — you hold every position's open and close and we hold neither.

tradesPerDay · trackRecordDays · lastTradeAt	load-bearing	The "trades often" axis and the copyable test.

moneyIn · moneyOut · returnPct	load-bearing	Money in and out, each with coverage.

realizedByMonth\[\]	load-bearing	Each month's realizedUsd, closedTrades, coverage, complete. 439 of 441 carry it; 282 have a worst finished month; 211 of those lost money. See the gap below.

realizedByMonthBasis	load-bearing	The window covered plus beforeWindowUsd, so months reconcile against the lifetime figure without guessing.

realizedByDay\[\]	degrades	The 30-day grid of green and red days.

fees	degrades	paidUsd, byWindowUsd, paidNative, transactions, coverage, and critically includedInRealized — a fee shown beside a profit that already excludes fees means something different.

volume	degrades	reportedLifetimeUsd plus per-window with coverage.

windows	degrades	24h / 7d / 30d / all, each with realised, closed trades, volume and their coverage.

byToken\[\]	load-bearing	Per coin: avgEntryMarketCapUsd, avgEntryPrice, avgExitPrice, firstEntryPrice, realizedPnlUsd, closed, trades, entryMethod, exitMethod. Feeds entry sizes, small-cap results, the two habits, and profit by coin. The paged bulk route omits this, which is why a moved trader still needs his own call.

entryPriceCoverage	load-bearing	How much of the record carries an entry price at all.

fieldReasons	load-bearing	A reason beside every empty field. An empty field with a reason is not a missing one, and we must never turn the first into "not provided".

sample · complete · tradesKnown · tradesUsed	degrades	Whether this is the whole record.

meanToMedian · smallCapWinRate · perExit	optional	Read; withheld where it would mislead, and null not zero is correct.

The single most valuable field you could add. Every month arrives in dollars with startCapitalUsd and returnPct empty and your own reason historical\_input\_missing — measured across eleven traders read directly. Our fourth verdict test asks whether a trader survives a bad month, written as a percentage. With no starting balance there is no denominator, so the percentage is present for 0 of 439 and the top verdict — "follow" — is unreachable for every trader in the directory. One field stands between you and a whole product state nobody can currently reach.

§4

The six axes, and exactly what each needs

The profile places a trader against everyone else on six axes. Each is drawn hollow with a stated reason when its input is missing — so what you withhold is visible, and what is wrong is not. A corner needs twenty traders in the cohort before anyone can be placed on it.

&nbsp;

cashOut           bankedUsd · onPaperUsd · realizedShare        (from /pnl)

consistency       closedTrades · topTradeShare · meanToMedian · medianTradeUsd

edge              winRate · wins · losses

riskControl       worstTradeUsd · typicalBetUsd · cashShare · concentration

holdTime          holdingTime.medianDays  (+ its coverage)

activityDensity   tradesPerDay · activeDays · trackRecordDays · lastTradeAt

A seventh axis is switched off waiting on you, and may now be ready. "How early he gets in" was retired on 8 September because avgEntryMarketCapUsd could be priced for only 11 of 144 traders — below the twenty a ranking needs. Measured again on 15 September against v10: 426 of 445 traders have at least one coin priced at entry under $1M, and 308 have twenty or more. The arithmetic is still in our code, still proven by its own checks. If that coverage holds, the axis comes back.

§5

The four verdict tests

What the app finally tells a person. Every threshold is absolute and unsettable — a threshold anyone could move is a different feature.

&nbsp;

test	passes when	fields

Real record	Top trade under 25% of profit, and at least 30 coins	topTradeShare · coinsTotal

Gets in early	At least 60% of buys under $100K market cap	byToken\[\].avgEntryMarketCapUsd

Copyable	Under 50 trades a day, hold time at least 10× our delay, flips under 1 in 20	tradesPerDay · holdingTime · (our own copy replay)

Survives bad days	Worst month lost less than a fifth	realizedByMonth\[\] \+ startCapitalUsd

The fourth is unmeasured for all 441 traders, for the reason in §3. Three of four passing is "watch him before you follow"; nobody reaches "follow".

§6

Words we turn into sentences

These are not machine-only. Each becomes a sentence a person reads, in two languages. A word we have no sentence for is a blank on somebody's screen — so a new value here is a release note, not a detail. We have had to discover every one of them by observation.

&nbsp;

point.refused        chains\_unrebuildable · too\_little\_priced

gaps\[\].reason        same vocabulary

breaks\[\].reason      chains\_changed · method\_changed · method\_and\_chains\_changed

drawing.reason       too\_few\_points

now.partialReason    chains\_missing\_and\_unpriced\_positions

chains\[\].reason      free text today — should be a closed set

fieldReasons.\*       historical\_input\_missing · and others

sampler.state        current · (others unknown)

status               ready · warming

Please publish these sets. Every one of them arrived as an unexplained blank on somebody's screen before we learned what it meant.

§7

Rules that hold across every route

rule	why it matters here

null, never zero	Zero is a claim. A zero worst-trade reads as a trader who has never lost; a zero balance reads as a man who sold everything.

Empty string is absent	Your own loader once used ?? and 163 traders were named "".

Coverage travels with the figure	A fee covering 1 of 2 chains is a different claim from one covering both. Every figure that can be partial needs its own coverage block.

A unit never changes under a stable name	Undetectable and catastrophic: every figure stays plausible and every one is wrong by a factor.

Absent list ≠ empty list	No gaps array means "we did not say", which we must treat as unknown — never as "there are none".

A partial answer says it is partial	A partial answer that looks complete gets stored. An error would have been retried.

Errors carry a stable code	An empty-bodied 503 is indistinguishable from a network failure, so every consumer retries it forever. 546 WORKER\_RESOURCE\_LIMIT is not a rate limit and must never be retried as one.

Field lists read out of traderReportSources.ts, fomoscan.ts and traderChainAum.ts on 15 September 2026, and cross-checked against live v10 answers for poopinyourhands and notanicecat69. Counts across the roster are from our own store of 441 tracked traders and from the service's directory of 445\. Where a figure was not measured, it is not stated.

&nbsp;

## Added 17 Sep 2026 (vocabulary v3, pre-migration fixes)

| Field | Route | Contract |
|---|---|---|
| `aum.points[].refused`, `aum.gaps[].reason` | /aum | + `price_suspect` (one coin dominates and its price fails the cap or concentration check), + `no_tokens_known` (a chain the sampler had nothing to read on) |
| `aum.chains[].reason` | /aum | + `wallet_unreadable`, `service_timeout`, `no_tokens_known`, `price_suspect` |
| `aum.drawing.reason` | /aum | + `rebuilt_only`: usable points exist but none is sampled |
| `aum.points[].reliability` | /aum | `low` on every `basis: rebuilt` point; absent otherwise |
| `aum.stepChosenFrom` | /aum | `window` \| `tracked_span` \| `fallback`; null when the caller passed `step` |
| `aum.coverage.partialReason = unpriced_positions` | /aum | may now carry `totalUsd` (served partial, figure >= `constants.partialServeFloorUsd`) |
| `constants` | /fields | `{ pricedFloor: 0.25, partialServeFloorUsd: 100, drawableMinPoints: 2 }` |
| `traders[].aum.liveRead` | POST /traders/aum | always `{ state: "skipped", note }`; the batch never reads live |
| `positions[].isNative` | /positions, POST /traders/positions | true for the chain's own coin; EVM sentinel `0x0000000000000000000000000000000000000000`, Solana `11111111111111111111111111111111` |
| `positions[].priceSuspect`, `priceSuspectReason` | /positions, POST /traders/positions | boolean; `implied_mcap_over_ceiling` \| `concentration_over_ceiling` \| null |
| `positions[].isHoneypot`, `canSell`, `unsellableUsd`, `partial`, `partialReason` | /positions, /portfolio, POST /traders/positions | flagged value is excluded from totals into `unsellableUsd`; `partialReason: unsellable_positions` |
| `wallets.resolvedBy.{evm,solana}`, `wallets.fingerprintMatches` | /wallets | `fomoapi` \| `gmgn` \| `submitted`; `fingerprintMatches` is always null (no count is stored) |
| `onChain.chainsCovered` | /traders/:handle | chains present in the stored transaction feed; all-zero counts outside this list mean "not covered" |
| `health.staleFeeds[]` | /health | + `scorecards` when any scorecard is past its own `staleAfterHours`; `dataState` is then `degraded` |
| `health.staleFeeds[]` | /health | vocabulary 13 (19 Sep 2026): + `prices` (no hourly price written for 3 h) and + `scheduler` (the /health snapshot is older than 30 min, i.e. our cron jobs are not running) |
| `health.database` | /health | `{ answering: true, latencyMs }` from the one-row probe. When the database does not answer within 2 s the route answers 503 `unavailable` with `error.database.answering: false` instead of a 200 |
| `health.computedAt`, `computeMs` | /health | when the scheduler computed the body (every 10 min) and how long it took; `cacheAgeSeconds` is its age |
| `health.feeds.tokenInfo` | /health | `staleAfterHours: 48` (was 336). Also `stale` when `heldCoinsStaleShare` > 0.1. `heldCoins`, `heldCoinsStale`, `heldCoinsNeverRead` are counts over coins traders hold now; never-read coins are counted, not judged (GMGN does not cover every chain) |
| `health.feeds.aum.chains.{chain}` | /health | `{ accepted36h, failed24h, newestAcceptedAt }` per chain |


## Added 17 Sep 2026, second wave (vocabulary v4)

| Field | Route | Contract |
|---|---|---|
| `pnl.openPositionsHeld`, `pnl.openPositionsBasis` | /pnl, /traders?include=pnl | open trade records whose token the wallet still holds on chain; basis words `trade_records`, `trade_records_still_held_on_chain` |
| `trades.status = closed_by_balance` | stored; affects /pnl, /scorecard, /tokens | a trade fomo calls open for a token a chain read no longer holds; never counted as open, never as a realised close |
| `scorecard.loadAttemptedAt`, `loadOutcome`, `nextLoadBasis` | /scorecard | last fomoapi fetch attempt and its outcome (`loaded` \| `unavailable` \| `degraded` \| `not_found` \| `error`, null = never attempted); `nextLoadBasis: nightly_slot` |
| `health.staleTraders.scorecardLoadFailed` | /health | traders past 72 h whose latest load attempt was not `loaded` |
| `health.feeds.aum.historyState`, `health.feeds.aum.chains.{chain}.historyState` | /health | `{ ready, warming, none }` counts of trader-chains, same definition as `wallets.knownChains[].historyState` |
| `health.feeds.aum.state`, `samplerLastRunAt` | /health | the feed clock is the newest ACCEPTED reading; the sampler's own clock moved to `samplerLastRunAt` |
| `health.staleTraders.noReading` | /health | now counts every listed trader with no accepted reading (refused readings do not count) |
| `aum.sampler.state = never_read` | /aum | the sampler has never covered this trader (no reading row at all) |
| `positions.coverage.chains.{chain}` | /positions, POST /traders/positions v2 | `{ chainTxCount, rowsHeld, share, readAt }` from one `eth_getTransactionCount` per sampled EVM chain; `partialReason: indexer_coverage_low` when any share < 0.5, composed with `unsellable_positions` as `unsellable_positions_and_indexer_coverage_low` |
| Robinhood-chain prices | /positions, /aum | coins GMGN misses are priced nightly from DexScreener into `token_prices`; they surface as the existing `priceSource: token_prices_daily` (`docs/R4_ROBINHOOD_PRICES.md`) |

## Added 17 Sep 2026, T3 (bounded)

| Field | Route | Contract |
|---|---|---|
| `scorecard.onChain` | /scorecard | `{ basis: wallet_swaps, swaps, buys, sells, volumeUsd, realizedPnlUsd, winRate, wins, losses, coverage: { of: swapsResolved, total: swapsSeen, share }, asOf }` — the same figures as the top of the scorecard, from the wallet's own resolved swaps instead of fomoapi. `swaps` is a real count (0 allowed); every other figure is `null` when there are no resolved swaps, never 0. P&L pairs each sell against the token's average buy cost (the `perExit` pairing). `null` under `?include=scorecard`, with `onChainNote` saying so |
| `scorecard.staleness.fallback` | /scorecard, /traders?include=scorecard | `on_chain` when `staleness.state` is `stale` or `never` AND `onChain.swaps > 0`: draw `onChain` instead of the fomo figures. Otherwise `null`. Always `null` on the embedded scorecard, where `onChain` is not computed |


## Added 17 Sep 2026, events feed

| Field | Route | Contract |
|---|---|---|
| `events[]`, `nextCursor`, `count`, `asOf`, `since`, `filters`, `note` | GET /events | keyset feed over `transactions`, `wallet_swaps` and `aum_samples` (`basis: sampled`), ordered `(at, kind, txHash \| handle)` ascending, newest last; `since` defaults to now − 24 h; `limit` ≤ 500 (default 100). Every event carries `kind` (`transfer` \| `swap` \| `reading`), `at`, `handle`, `traderSource` (`traders.source`). `transfer`: `chain`, `tokenAddress`, `txHash`, `direction` (`in` \| `out`), `amount`, `counterparty`, `source` (`tx_source`), `txType`. `swap`: `chain`, `tokenAddress`, `txHash`, `tokenDelta`, `quoteDelta`, `quoteUsd`. `reading`: `totalUsd` (null = refused, never 0), `refusedReason`. `transfer` and `swap` carry `gates: { isHoneypot, canSell, priceSuspect: null }` from `token_info`, or `gates: null` when no row exists. Solana rows are real-time (webhook), EVM transfers nightly: poll with the cursor, not with `since` |

## Added 17 Sep 2026, live holdings

| Field | Route | Contract |
|---|---|---|
| `entries[].amountLive` | /positions | Solana: `amount` + signed transfers (`in` +, `out` −) with `block_time > balanceAt`, from the webhook feed. EVM: `null`. Not a chain read; only as complete as the webhook's coverage. `amount` and `valueUsd` stay the read values |
| `entries[].deltaSinceRead` | /positions | the signed sum itself. `0` = nothing moved since the read (Solana); `null` = not rolled forward (EVM) |
| `entries[].lastTransferAt` | /positions | newest transfer since the read, else `null` |
| `entries[].tier` | /positions | new value `rolled_forward`: a position opened since the read, with `amount: 0`, `balanceAt: null`, no price. Only once the mint is in `tokens`; otherwise on `/flow` only |
| `liveBasis` | /positions | `{ solana: "rolled_forward_from_transfers", evm: "nightly_read" }` — what `amountLive` is on each chain |
| `rows[]` | /traders/:handle/flow?since=, POST /traders/flow { ids, since } | `{ chain, tokenAddress, tokenKey, in, out, net, transfers, firstAt, lastAt }` per token moved since `since` (required, ISO-8601). Solana only, from `transactions`. `tokenAddress` `null` when the mint is not in the directory; `tokenKey` always. Envelope: `since`, `basis: "transactions"`, `chains: ["solana"]`. Batch: §11 rules, one `traders[]` entry per id. No category taxonomy: group by `tokenKey` yourself |

## Added 17 Sep 2026, creators and linked wallets

| Field | Route | Contract |
|---|---|---|
| `entries[].creator.ledger` | /tokens/:address | `{ launches, bestPeakMcapUsd, bestToken, stillHoldingCount, soldCount, honeypotCount, lastLaunchAt }` for this token's creator across every token we hold GMGN info for; rebuilt nightly (`creators`). `null` until the ledger has a row — the rest of `creator` is unaffected. `launches` is a real count; `bestPeakMcapUsd`, `bestToken` (an address key) and `lastLaunchAt` are `null` when unknown. `lastLaunchAt` is when we first saw the token, not its mint time |
| `GET /creators/:address` | new route | `{ creator, asOf, ledger, tokens: [{ chain, tokenAddress, symbol, status, isHoneypot, marketCapUsd }], tier: third_party, source: gmgn }`. `?chain=` optional; without it an EVM address sums across chains. `tokens[].status` is GMGN's own word, `creator_hold` or `creator_close`, `null` when GMGN was silent. 404 `not_found` for an address the ledger has never seen; 503 `unavailable` when the database is down |
| `linked[]` | /wallets | `[{ chain, address, linkedFrom, kind, firstSeenAt, evidenceTx, watch }]`, wallets the trader funded from his known Solana wallet (`linked_wallets`, nightly). `kind` is `funded_by`; `submitted` is reserved and not yet written. `address` is the case-preserved spelling when resolved, otherwise the lowercased key. `watch: true` means the Helius webhook is registered for it, so its transfers appear under this trader's `/transactions`. `[]` when none, never absent |

## Added 17 Sep 2026, market regime

| Field | Route | Contract |
|---|---|---|
| `regime` | GET /market/regime | `open` \| `caution` \| `closed` \| `null`. `closed` when `leaders.greenShare7d < 0.25`, `caution` when `< 0.5`, else `open`; `launches.survival7d < 0.1` moves it one step down. `null` when no tracked leader closed a trade in the window. A cohort reading, not advice |
| `rule` | GET /market/regime | `{ closedBelow: 0.25, cautionBelow: 0.5, survivalDowngradeBelow: 0.1, basis }`, the thresholds above, published |
| `leaders` | GET /market/regime | `{ total, green7d, greenShare7d, basis }`: traders with ≥ 1 `closed_at` in the last 7 days; green = `sum(realized_pnl_usd) > 0` over those closes. `greenShare7d` `null` when `total = 0` |
| `launches` | GET /market/regime | `{ seen7d, graduated7d, survival7d, chains: ["solana"], basis }`: `tokens.created_at` in the last 7 days, `graduated = true`. `survival7d` `null` when `seen7d = 0`. Nightly, Solana only |
| `rotation` | GET /market/regime | `{ tokensMoved7d, topShare7d, basis }` from `transactions` in the last 7 days across tracked wallets: distinct tokens, and the share of transfers in the 10 most-moved tokens. `topShare7d` `null` when nothing moved |
| `asOf`, `window`, `cachedForSeconds` | GET /market/regime | `window` is always `7d`; the body is identical for every caller and served from a 60 s per-instance cache, so `asOf` is the compute time |

## Added 17 Sep 2026, honeypot-since and cohort

| Field | Route | Contract |
|---|---|---|
| `entries[].security.honeypotSince` | /tokens/:address | ISO time of the first nightly security read where `isHoneypot` or sell-blocked became true (`token_info.honeypot_since`); never cleared, even if a later read says otherwise. `null` when never flagged, or flagged before the column existed (backfills from the first refresh after 17 Sep 2026) |
| `entries[].cohort` | /tokens/:address | `{ holders, independent, linkedGroups }`, per chain. `holders`: distinct tracked traders with any `trades` row in the coin — by trades, so it can differ from the holdings-snapshot `holders` beside it. `independent`: `holders` minus traders whose wallet is another trader's `linked_wallets` address. `linkedGroups = holders − independent`. Real zeros, never null |
| `byToken[].isHoneypotNow` | /scorecard, `?include=scorecard` | latest GMGN read: `true` when honeypot or sell-blocked, `false` when checked and neither, `null` when the chain is not assessed (Solana) or the token was never checked |
| `byToken[].honeypotSince` | same | as `security.honeypotSince` above, on the coin the trader traded |
| `byToken[].exitedBeforeFlag` | same | `true` when `honeypotSince` is set and the trader's `lastClosedAt` is before it; `false` when set and he closed after it or still holds; `null` when the coin was never flagged (Rug Dodger) |
| `byToken[].coHolders` | same | distinct OTHER tracked traders with a `trades` row in the same coin on the same chain; `0` when he is alone, `null` only when the row could not be counted (Cabal Trader; linked-wallet collapsing is on `/tokens/:address.cohort`, not here) |

## Added 17 Sep 2026, composite badges

| Field | Route | Contract |
|---|---|---|
| `byToken[].exitMcapUsd`, `byToken[].betUsd` | /scorecard | the same values as `avgExitMarketCapUsd` and `costUsd`, under the badge note's names: one value, two names |
| `byToken[].currentPriceUsd`, `byToken[].currentMcapUsd` | /scorecard | `token_info.price_usd` / `market_cap_usd` at the last token-info load; null when no row |
| `byToken[].peakMcapSinceEntryUsd` | /scorecard | `token_price_stats.ath_usd × totalSupply`, only when `ath_at >= firstOpenedAt`. Null before hourly sampling reached the coin, or when the sampled high pre-dates his entry (someone else's run) |
| `byToken[].multipleRealized`, `multipleCurrent`, `multiplePeak` | /scorecard | weighted exit / current price / sampled ATH, each divided by `avgEntryPrice` (4 dp). Null, never 0, when either leg is missing; `multiplePeak` follows the `peakMcapSinceEntryUsd` gate |
| `byToken[].realizedShare` | /scorecard | exit quantity ÷ entry quantity, clamped to 0..1; null when no entry quantity is recoverable (`costQuantity` null). 0 = nothing sold |
| `byToken[].closedMonth` | /scorecard | `YYYY-MM` of `lastClosedAt`; null when never closed |
| `byToken[].entryHoursAfterLaunch` | /scorecard | hours from launch to `firstOpenedAt`; launch = `tokens.created_at` (chain read) when set, else GMGN's `tokenCreatedAt`; null when neither |
| `typicalBetUsd.perCoinUsd` | /scorecard | median of `byToken[].betUsd`; the composite floor. `typicalBetUsd.value` and `.method` are unchanged (per-position median or volume-per-trade) |
| `medianWinUsd`, `medianLossUsd` | /scorecard | median realised P&L over closed positions with a figure, winners and losers separately; `medianLossUsd` is negative; null when the side is empty |
| `bigWinMonths` | /scorecard | distinct `closedMonth` with a coin at `multipleRealized >= 10`; null when no coin carries a multiple, 0 when some do and none reached 10x |
| `recent` | /scorecard | `{ lastBigWinAt (last close of a coin at >= 5x), closes4w, green4w (closes in the last 28 days, and those with realised > 0), last20: { avgRealizedUsd, redShare }, entryMcapMedianUsd, holdHoursMedian, tradesPerDay, basis }`; `last20`, the medians and the pace are over the 20 most recent closes |
| `career` | /scorecard | `{ avgRealizedUsd, entryMcapMedianUsd, holdHoursMedian, tradesPerDay, basis }` over every closed position with a close time. `tradesPerDay` here is closes per day over the closes' own span (floored at one day), not the top-level positions-per-day figure |
| `bleeding`, `bleedingBasis` | /scorecard | true only when `career.avgRealizedUsd − recent.last20.avgRealizedUsd > typicalBetUsd.perCoinUsd` OR `recent.last20.redShare >= 0.6`; false otherwise; null with no dated close. `bleedingBasis: { floorUsd, redShareFloor: 0.6, plain }` publishes the floor |
| `exitTimingScore` | /scorecard | share of closed coins whose `currentPriceUsd` is below `avgExitPrice`, in 0..1; null under 5 closed coins carrying both prices |
| `perHolder[].exitTimingScore` | /tokens/:address/activity | the same score for that trader across every coin he has closed, not this coin alone; same null rule |

## Added 17 Sep 2026 — error codes (vocabulary v8)

| Field | Route | Contract |
|---|---|---|
| `error.code` | every route | One of `not_found`, `bad_request`, `duplicate_identifier`, `rate_limited`, `timeout`, `unavailable`, `include_unavailable`, `internal_error`, `not_configured`, `unauthorized`, `invalid_address`, `address_in_use`, `already_on_record`. v8 corrects the list: `internal` was published but the service emits `internal_error`; `unavailable` (503, Postgres not answering) and `include_unavailable` (503, `blocks[]` names the `?include=` blocks not produced) were emitted but unpublished. |

## Added 17 Sep 2026 — aum history
## v3 fixes — positions

Fix request v3 (17 Sep 2026), V1 / V1b / V1c / R6. Additive; no version bump on its own.

| Field | Route | Contract |
|---|---|---|
| `suspectUsd` | /positions, POST /traders/positions v2 | Priced value in rows with `priceSuspect: true`, kept OUT of `totalValueUsd`, `coverage.pricedPositions` (`pricedPositionCount`) and every `share`. The rows keep `priceUsd` and `valueUsd` so what was excluded is visible. `totalValueUsd` is null when the only priced rows are suspect. |
| `coverage.suspectPositions`, `suspectPositionCount` | same | How many rows are suspect. `unpricedPositions` stays "rows with `valueUsd` null". |
| `partialReason` | same | New words: `price_suspect`, `price_suspect_and_unsellable_positions`, `price_suspect_and_indexer_coverage_low`, `price_suspect_and_unsellable_positions_and_indexer_coverage_low`. The suspect word leads. |
| `positions[].priceSuspectReason` | same | Unchanged words, stronger rules: with no supply to check, one position over $1B is `concentration_over_ceiling` whatever its share; the concentration base is the sellable, not-yet-suspect remainder, judged largest row first, so two absurd prices in one wallet are both flagged. Supply is `tokens.total_supply` or, failing that, GMGN's. |
| `positions[].priceSource` | same | Now written: `pegged` (quote_assets.pegged_usd), `token_info` (GMGN), `token_prices` (newest daily row), `fomo_reported_entry` (the directory build's reported price); null when unpriced. `pricedAt` is the write time of that price (the capture time for `fomo_reported_entry`). A GMGN price of 0 is no price. |
| `positions[].priceSuspectReason` = `no_market_over_ceiling` | same | V1d (17 Sep, after the v3 deploy): a position worth more than 10x the DexScreener liquidity of its best pair (latest `token_price_hourly` row, else GMGN's), or over $1M when no pair is known anywhere, has no market behind its price. Checked on every row after the other rules, whatever its share; the value goes to `suspectUsd`. Catches the coin that is under 90 % of the base and under the $20B cap but cannot be sold. |
| `coverage.chains.{chain}` | same | Written again, by the balances job after each EVM wallet read. `chainTxCount` is Bitquery's realtime-window count of transactions the wallet SENT: a lower bound on the nonce, so `share` is an upper bound and may exceed 1; `basis: bitquery_realtime` says so. `indexer_coverage_low` still fires below 0.5. |

## Added 18 Sep 2026 — aum history

Vocabulary v9. `GET /traders/:handle/aum/history` and `POST /traders/aum/history { ids, step?, window?, from?, to? }`: balance history BUILT from stored holdings and prices (table `aum_history`, hourly grain; daily / weekly / monthly rollup views), distinct from the sampled series on `/aum`.

| Field | Route | Contract |
|---|---|---|
| `step` | /aum/history | One of `1h`, `1d`, `1w`, `1mo`. Defaults from `window`: 1d, 1w → `1h`; 1m, 3m → `1d`; 1y → `1w`; all → `1mo`. Any other word is 400 with `parameter: "step"` |
| `window` | /aum/history | One of `1d`, `1w` (default), `1m`, `3m`, `1y`, `all`; the range ends now. `from` / `to` (ISO-8601) override either bound; `from` at or after `to` is 400 |
| `from`, `to` | /aum/history | The bounds applied, ISO-8601 UTC; `from` is null for `all` with no `from` |
| `points[]` | /aum/history | Ascending, newest last; at most `limit` (≤ 2000, default 2000) NEWEST points. No cursor: the range is bounded |
| `points[].at` | /aum/history | Bucket start, UTC |
| `points[].totalUsd` | /aum/history | Value held in USD; null when the bucket was not valued, never 0. On rolled-up steps it is the close (last valued hour in the bucket) |
| `points[].basis` | /aum/history | `1h` only. `reading` when a sampled reading stood in that hour; `priced` when built from holdings and prices |
| `points[].reason` | /aum/history | `1h` only. Why `totalUsd` is null: `no_holdings`, `no_prices`, `too_little_priced`; null when valued |
| `points[].pricedPositions`, `points[].totalPositions` | /aum/history | `1h` only. Positions priced and held in that hour |
| `points[].highUsd`, `points[].lowUsd` | /aum/history | `1d` / `1w` / `1mo` only. Highest and lowest valued hour in the bucket; null when none |
| `points[].valuedHours` | /aum/history | `1d` / `1w` / `1mo` only. Hours in the bucket that carried a value |
| `count`, `valued` | /aum/history | Points returned, and those with a non-null `totalUsd` |
| `latest` | /aum/history | `{ at, totalUsd }` of the newest valued point in range; null when none |
| `asOf` | /aum/history | When this trader's history was last built (`max(computed_at)`); null when never. The batch envelope's `asOf` is the newest across the traders answered |
| `traders[]` | POST /traders/aum/history | One entry per requested id in the order sent; `ok: false` with a `not_found` error for an unknown id; `ok: true` entries carry the GET shape minus `links` |

## Added 17 Sep 2026 — live value

Vocabulary v10. A `now` block on `/aum/history` (GET and POST rows), and on its own at `GET /traders/:handle/aum/now` and `POST /traders/aum/now { ids }`: the trader's current value from `aum_live`, refreshed when a watched wallet transacts (Solana push), when a balance slice reads the wallet, and when prices land. The hourly series' last point is refreshed with it.

| Field | Route | Contract |
|---|---|---|
| `now` | /aum/history, /aum/now | The live figure; `null` when the trader has none yet (never an empty object, never 0) |
| `now.at` | same | When the figure was last refreshed, ISO-8601 UTC |
| `now.totalUsd` | same | Value held in USD; `null` when not valued, never 0 |
| `now.pricedPositions`, `now.totalPositions` | same | Positions priced and held at `at` |
| `now.reason` | same | Why `totalUsd` is null: `no_holdings`, `no_prices`, `too_little_priced` (`aumHistory.now.reason`, the same words as `aumHistory.points[].reason`); `null` when valued |
| `now.source` | same | What last refreshed the figure: `webhook`, `balances`, `prices`, `build` (`aumHistory.now.source`) |
| `now.ageSeconds` | same | Whole seconds between `at` and the answer; never negative |
| `asOf` | POST /traders/aum/now | The newest `now.at` across the traders answered; `null` when none has a live figure |
| `traders[]` | POST /traders/aum/now | One entry per requested id in the order sent; `ok: false` with a `not_found` error for an unknown id; `ok: true` entries carry `handle`, `id`, `now` |
| `links.now` | /aum/history | The trader's `/aum/now` |

## Added 17 Sep 2026 — token prices

| Field | Route | Contract |
|---|---|---|
| `step` | /tokens/:address/prices, POST /tokens/prices | One of `1h`, `1d`, `1w`, `1mo` (`tokenPrices.step`, vocabulary v9). Defaults from `window`: `1d`/`1w` → `1h`, `1m`/`3m` → `1d`, `1y` → `1w`, `all` → `1mo`. Any other word is 400 with `parameter: "step"` and `valid`. |
| `window` | same | One of `1d`, `1w`, `1m`, `3m`, `1y`, `all`; default `1w`. `from`/`to` (ISO-8601) override it; `from` after `to` is 400 with `parameter: "from"`. |
| `from`, `to` | same | The bounds actually read, UTC ISO; `from` is `null` only for `all` with no explicit start. |
| `points[].at` | same | Start of the bucket (the sampled hour for `1h`; UTC day, ISO week (Monday) or calendar month otherwise). Ascending. |
| `points[].usd` | same | The hour's sample for `1h`; the bucket's close (last sampled hour) otherwise. Never 0 for "unknown": an hour with no sample is absent, not zero. Nothing before 17 Sep 2026 is rebuilt from the daily `token_prices`. |
| `points[].openUsd`, `highUsd`, `lowUsd`, `hours` | same, step ≠ `1h` | First sampled hour, max, min, and how many hourly samples the bucket holds (a partial bucket has fewer than 24 / 168 / ~720). Absent on `1h`. |
| `points[].liquidityUsd` | same, step `1h` | DexScreener liquidity at that hour; `null` when the source gave none. Absent on other steps. |
| `count`, `limit`, `truncated` | GET | Points returned; the cap (`?limit=`, at most 2000, default 2000); `truncated: true` when the span held more than `limit` and the OLDEST were dropped. |
| `latest` | both | `{ at, usd }` from `token_price_stats`, the newest hourly sample; `null` before the first sample. |
| `ath` | GET | `{ usd, at }`, the running max since sampling began (not the token's lifetime high); `null` before the first sample. |
| `asOf` | both | `latest.at` (batch: the newest across the answered tokens); `null` when none is sampled. |
| `tokens[].ok`, `error` | POST | `ok: false` with `error: "not_found"` (address not in `tokens`, on that chain when `chain` was sent) or `error: "ambiguous_chain"` (address on several chains and no `chain`; `chains[]` names them). `ok: true` rows carry `address`, `chain`, `symbol`, `points`, `count`, `latest`. At most 50 addresses; a duplicate is 400 `duplicate_identifier`. |



## v3 fixes — valuation

Migration `20260918060000_valuation_v3.sql` (17 Sep 2026, fix request v3 V1 / N1 / Z1b). No new vocabulary version: `price_suspect` is added to two existing lists; two nullable fields are added. The rules are the ones `/positions` applies (`aum-sample/value.ts`), now run in SQL for `/aum/now` and every hourly `/aum/history` point.

| Field | Route | Contract |
|---|---|---|
| `now.suspectUsd`, `points[].suspectUsd` | /aum/now, /aum/history (`1h` only; also the batch rows) | Gross value of positions whose price failed the suspect rule (implied market cap over $20B; one position over 90 % of the wallet's sellable gross with an unknown cap or a gross over $1B; a position over $1B with an unknown cap). Kept OUT of `totalUsd`. `null` when no position was suspect, never 0. Absent on rolled-up steps and null on `basis: reading` |
| `now.unsellableUsd`, `points[].unsellableUsd` | same | Gross value of honeypot / cannot-sell positions (`token_info.is_honeypot` or `can_not_sell`). Kept OUT of `totalUsd`. `null` when none, never 0 |
| `now.reason`, `points[].reason` | same | Gains `price_suspect`: nothing counted and at least one position was suspect. `no_prices` remains "nothing priced at all". A price `<= 0` is unpriced at every rung (a $0 token never counts as priced, so `1 of 1 priced` with `totalUsd: 0` cannot occur) |
| `now.totalUsd`, `points[].totalUsd` | same | Stored unrounded, rounded to 2 dp at the route: a sub-cent real value reads `0` only after rounding, and `null` still means not valued. `latest` is the newest point with a non-null `totalUsd` |
| `now.pricedPositions`, `points[].pricedPositions` | same | Counts positions with a value `> 0` that are neither suspect nor unsellable |
## v3 fixes — token logo

| Field | Route | Contract |
|---|---|---|
| `logoUrl` | /tokens rows, /tokens/:address entries, /tokens/momentum rows | Token image URL (`string`), GMGN's `logo` first, DexScreener's pair `info.imageUrl` when GMGN has none. `null` when neither source has one, never `""`. Filled by the nightly tokens job and the hourly prices job, so a newly seen token is `null` for up to an hour. Not on positions rows. |
## v3 fixes — scorecards

| Field | Route | Contract |
|---|---|---|
| `scorecard.loadOutcome` | /scorecard, /traders?include=scorecard | Adds `unchanged`: fomo answered but the newest snapshot (`loadedAt` = `trades.captured_at`) did not advance (re-served or empty document). The loader targets `loadedAt` older than 72 h and retries a trader at most once per 6 h, whatever the last outcome; every attempt writes a row, so `loadAttemptedAt`/`loadOutcome` stop being null after the first six-hourly run. |
| `scorecard.nextLoadAt`, `nextLoadBasis` | same | `nextLoadAt` is the next 00/06/12/18 UTC tick of the Worker cron; `nextLoadBasis: six_hourly_slot`. `nightly_slot` stays published for one version and is no longer emitted. |
| `scorecard.staleness.fallback` | /scorecard | `on_chain` only when the record is `stale` or `never` AND `onChain.coverage.share >= 0.5` (the swap store holds at least half the profile's swap-shaped transactions). Otherwise `null`. |
| `scorecard.staleness.fallbackReason` | /scorecard | `swap_store_incomplete` when the record is `stale` or `never` and `fallback` is null because coverage is under 0.5 (or `onChain.swaps` is 0). `null` when current, when `fallback` is set, and always on the embedded scorecard. |
| `health.staleTraders.scorecardStale` | /health | Now counts `source = fomoapi.io` traders only (the set the loader owns); `scorecardStaleGmgn` counts the rest, refreshed by the nightly gmgn job. |
| `health.staleTraders.scorecardLoadFailed` | /health | Of the stale, the last attempt's outcome is anything but `loaded`; a never-attempted trader now counts. `scorecardNeverAttempted` is the subset with no `trade_loads` row at all. |
| `fields.cachedForSeconds` | /fields | The body is memoised per isolate for 300 s (fill rates move hourly at most); `asOf` is when it was counted. |
## v3 fixes — swaps

| Field | Route | Contract |
|---|---|---|
| `trades[].valueSource` | /trades | Which arm priced the money leg (`trades[].valueSource`): `money_side_pegged` (the quote asset's peg), `money_side_daily_close` (the Binance daily close of the block day, up to 7 days back), `money_side_market` (the portfolio's current price for the quote asset). `null` exactly when `valueUsd` is `null`. Replaces the single word `money_side`. |
| `trades[]` (rows) | /trades, /events?kind=swap | Solana swaps are resolved again (Helius `getTransaction` pre/post balances, the wallet's own two-sided trade only) and EVM swaps from Bitquery, newest first every 15 minutes; rows written unpriced are re-valued for 30 days once the quote asset's daily close is loaded. `valueUsd` on BNB/ETH/SOL-paid swaps comes from that close. |
| `health.feeds.swaps` | /health | `max(wallet_swaps.block_time)`, the newest resolved swap on any chain; `staleAfterHours: 6`. Stale or never puts `swaps` in `staleFeeds[]` (`health.staleFeeds[]` gains the word). Carries `description`. |
| `health.feeds.trades.description` | /health | `"fomoapi trade records, load time"`: this clock is fomoapi's scorecard load (`trades.captured_at`), not the on-chain swaps. |


## v5 fixes — one price ladder, coverage on every figure, honest completeness

Fix request v5 (17 Sep 2026): V1d/A1, A2, A3, A4, N1, R7, W2, C1, H2, X3, G2, L2.
**Vocabulary bumps to 12.** Three fields are RENAMED (`share`, `rowsHeld`, `onChain.swaps`);
everything else is additive.

### One price ladder (A1, N1, R7)

| Field | Route | Contract |
|---|---|---|
| `positions[].priceUsd`, `priceSource`, `pricedAt`, `valueUsd` | /positions, POST /traders/positions, /portfolio | Priced AT REQUEST TIME from one ladder, in order: `pegged` (quote_assets) → `token_price_stats` (the hourly DexScreener price) → `token_prices` (newest daily close **inside 7 days**) → `token_info` (GMGN). `fomo_reported_entry` survives as a fallback when no rung carries a price, because the ladder cannot reproduce it. Until now these served the price frozen into `holdings` at the last balance read — a sweep that takes about nine hours — so a coin priced an hour ago still read `null`, and the same token showed three different prices on three traders' lists. |
| `positions[].priceSource` = `token_price_stats` | same | **New word** (vocabulary 12). The hourly DexScreener price, the freshest figure we hold. This is what fills the Robinhood-chain rows (R7) and re-prices anything the nightly read missed. |
| `positions[].priceSource` = `token_info` | same | **Demoted to the last rung.** It used to outrank the daily close; it carries no staleness stamp we trust, so it is now the fallback rather than the default. |
| `positions[].valueUsd` | /positions, /portfolio | Now `(amountLive ?? amount) × priceUsd` with the same ceilings, i.e. the same quantity the live valuation uses, so `/positions.totalValueUsd` and `/aum/now.totalUsd` are built from one priced coin list. |
| native rows (`isNative: true`) | /positions | Priced by the same ladder, with no re-read needed: ETH, BNB and SOL carry daily closes in `token_prices`. **N1 needs no sweep** — every trader's native row prices on the next request. |
| `positions[].priceSuspect` on quote assets | /positions, /aum/now, /aum/history | A `quote_assets` row — a dollar coin or a chain's own coin — is exempt from the concentration and no-market rules, and from nothing else (the implied-market-cap ceiling still applies, and the row stays in the concentration base). Both rules mean "we cannot check this price"; for ETH, BNB, SOL and USDC we can. Without this a wallet holding only 1.17 ETH was `concentration_over_ceiling` — the native sentinel carries no `total_supply`, so the cap test was unknowable and the position was 100% of its own total — and the trader's whole balance moved into `suspectUsd`. Affects single-asset wallets only. |
| `/portfolio.totalValueUsd` | /portfolio | Now applies the suspect rule, which it never did. A broken price that `/positions` excluded could previously land in the portfolio total. |

### How much of a wallet a figure is built from (A4, V1d)

| Field | Route | Contract |
|---|---|---|
| `points[].pricedShare`, `now.pricedShare` | /aum/history, /aum/now | `pricedPositions / totalPositions`. Null when nothing is held. |
| `points[].partial`, `now.partial` | same | True when `pricedShare` is under 0.25. The figure is real and drawable; it is not a balance. Label it. |
| `points[].partialUsd`, `now.partialUsd` | same | Under `pricedShare` 0.05 the figure is WITHHELD: `totalUsd` null, `reason: too_little_priced`, and `partialUsd` keeps what it would have been. Never treat `partialUsd` as a balance. |
| `coverage.pricedShare` | /positions | The same figure for the list, so the three routes are comparable at a glance. |

The rule is applied at READ TIME, on the counts every stored row already carries, so the whole
stored series is judged by it immediately with nothing rebuilt. Measured on 17 Sep 2026:
25,492 of 32,866 valued hours (78%) were built from under a quarter of the wallet.

### Gaps and staleness (A3, A2, X3)

| Field | Route | Contract |
|---|---|---|
| `points[].reason` = `not_built` | /aum/history, `step=1h` | **New word** (vocabulary 12). An hour inside the window the builder never wrote. Such hours used to be ABSENT from `points[]`; they are now null points with this reason, so a gap is distinguishable from the end of the data. Only hours BETWEEN the first and last point we hold are filled — nothing is invented before a trader was tracked. |
| `health.staleTraders.liveStale`, `liveStaleAfterHours`, `liveNever`, `oldestLiveHours` | /health | How many traders' `/aum/now` is older than an hour. The catch-up that refreshes them now runs FIRST in its hourly job with a quarter of the budget reserved, instead of on whatever the history backfill left over. |
| `health.feeds.aum` | /health | Now watches `aum_history` (`newestReadingAt`, `lastBuiltAt`) and `aum_live` (`newestLiveAt`), which are what write the hours. The retired hourly sampler's own clocks move to `feeds.aum.sampler` with `retired: true` and `retiredAt`. This is why the feed said 06:00 while the data went on past it. |

### Completeness and the trade counts (W2)

| Field | Route | Contract |
|---|---|---|
| `complete` | /trades | True only when the page was not capped AND every chain the trader trades on is `complete` in `coverage.byChain`. It used to be `!capped` alone. |
| `incompleteReason` | /trades | Which of the three made it false: `page_capped`, `chains_unresolved`, `chains_truncated`, joined with `_and_`. Null when `complete`. |
| `coverage.byChain[].state` = `truncated` | /trades | **New word** (vocabulary 12). We hold trades for the chain, but our record starts at `horizonAt` and the loader is still walking backwards past it. |
| `coverage.byChain[].horizonAt` | /trades | The oldest transaction we hold for this wallet on this chain. The record starts here; the trader may not have. |
| `onChain.swapsAppearedIn` | /traders/{handle} | **RENAMED from `onChain.swaps`, and recounted.** Distinct transactions typed SWAP that touched this wallet at all — an upper bound on his trading. The old field counted transfer LEGS, so one trade counted several times, and it counted trades other people made whenever this wallet received tokens inside them (5 in 6 of them, measured). |
| `onChain.ownSwaps` | /traders/{handle} | **New.** The wallet's own resolved trades, the same store `/trades` serves. This is the honest trade count. |

The Solana transfer loader now keeps a cursor and walks backwards one page a run until the
wallet's history is in. It previously re-read the newest 500 signatures on every run and never
reached past them, which on an airdrop-spammed wallet is a few weeks.

### Renames and flags (C1, H2, G2)

| Field | Route | Contract |
|---|---|---|
| `coverage.chains.{chain}.transferRowsHeld` | /positions | **RENAMED from `rowsHeld`.** Transfer LEGS we store for the address on that chain. |
| `coverage.chains.{chain}.rowsPerSentTx` | /positions | **REPLACES `share`**, which was never a share: its numerator counts transfer legs and its denominator counts sent transactions, so it legitimately read 2.2989 and 8.5. Same arithmetic, honest name. Still an upper bound (`chainTxCount` is a lower bound), and still makes the list partial below 0.5. |
| `positions[].canSell` | /positions, /events | **False whenever `isHoneypot` is true.** It used to negate `can_not_sell` alone, so every honeypot row read `isHoneypot: true, canSell: true` — two fields contradicting each other on the same coin. Still null when no security source has judged the coin. |
| `logoUrl` | openapi only | Marked NOT YET PUBLISHED in all three schemas and removed from their `required` lists, so a generated client no longer depends on a key no route serves. |
