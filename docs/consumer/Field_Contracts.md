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

## Added 17 Sep 2026, live holdings

| Field | Route | Contract |
|---|---|---|
| `entries[].amountLive` | /positions | Solana: `amount` + signed transfers (`in` +, `out` −) with `block_time > balanceAt`, from the webhook feed. EVM: `null`. Not a chain read; only as complete as the webhook's coverage. `amount` and `valueUsd` stay the read values |
| `entries[].deltaSinceRead` | /positions | the signed sum itself. `0` = nothing moved since the read (Solana); `null` = not rolled forward (EVM) |
| `entries[].lastTransferAt` | /positions | newest transfer since the read, else `null` |
| `entries[].tier` | /positions | new value `rolled_forward`: a position opened since the read, with `amount: 0`, `balanceAt: null`, no price. Only once the mint is in `tokens`; otherwise on `/flow` only |
| `liveBasis` | /positions | `{ solana: "rolled_forward_from_transfers", evm: "nightly_read" }` — what `amountLive` is on each chain |
| `rows[]` | /traders/:handle/flow?since=, POST /traders/flow { ids, since } | `{ chain, tokenAddress, tokenKey, in, out, net, transfers, firstAt, lastAt }` per token moved since `since` (required, ISO-8601). Solana only, from `transactions`. `tokenAddress` `null` when the mint is not in the directory; `tokenKey` always. Envelope: `since`, `basis: "transactions"`, `chains: ["solana"]`. Batch: §11 rules, one `traders[]` entry per id. No category taxonomy: group by `tokenKey` yourself |

