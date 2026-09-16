Acceptance tests · for the genie-fomo engineer

&nbsp;

What v10 has to answer before a trader can be drawn or judged

Fifty tests, written from what the app actually reads off the service. Each one names what to run, what passing looks like, and what we measured that made it worth writing down.

&nbsp;

Target genie-fomo v10

Written 15 September 2026

Measured against the live service, 10–15 September

How to read this

Every test is something the app depends on today. Where the current service already passes, the test is a guard against losing it. Where it does not, the evidence line says what we measured and when.

&nbsp;

The service is really two deployments and the tests say which they belong to. The scorecard service answers /traders/:handle/scorecard, /portfolio and /pnl. The balance service answers /v1/traders/:id/aum?window=… and the batch route /v1/traders/aum. They are separate addresses with separate stores, and several faults below are the two disagreeing.

&nbsp;

Part D is the one to read first if time is short. More than a third of the directory holds three chains or more, and those tests only ever fail for them — which is why none of it surfaced in single-trader checks.

&nbsp;

fails today

unmeasured

passes today — keep it

Part A

Identity and reach

Before anything can be drawn or judged, the service has to agree with us about who a person is and admit what it holds for them. Three of the six faults we chased this week started here.

&nbsp;

A1

A trader can be asked for by a stable identifier, not only by display name

fails today

Run

Ask for the same trader twice — once by handle, once by the canonical id the directory lists them under. Both must return the same record.

Pass

Both forms return 200 with an identical id. Asking by an id the directory published never returns 404\.

Why

A display name is not a key. Two people can hold one, and people rename themselves. Every table on our side is keyed by id; the name is used only at the moment of asking, which means one rename silently orphans a trader's whole history.

Measured 14 Sep 15:16 — /traders/nachsol/scorecard answered 200 in 3.3 s, 67 KB. /traders/bd49e1f2-a1e6-4660-a354-1492cec1829c/scorecard answered 404, "no trader … in the directory". The service has no way in but the name.

A2

Every trader the directory lists has at least one wallet on record

fails today

Run

For every trader in the directory, read the wallets the service holds. Count those with none.

Pass

Zero. A trader with no wallet is either given one or dropped from the directory — being listed and unpriceable is the worst of both.

Why

The service cannot price what it has no address for, so these traders reach a person's screen with no balance, no chart and no way to tell whether that means "flat" or "we never looked".

Of 72 traders whose chart could not be drawn at all, 58 have no wallet in the service's record — and we hold a wallet for them. Worked example: gmgn\_0xb5e22de9 is 0xb5e22de958c504f91878ee342fd6027eb85e0787 in our store and absent from the service's. 70 of them were findable on GMGN.

A3

The service accepts a wallet for a trader it already lists

unmeasured

Run

Submit a known-good wallet for a listed trader who has none. Re-read them an hour later.

Pass

The wallet is on record and the next balance read prices it. A rejection states why in a machine-readable word.

Why

A2 is only fixable at the source if this route exists. If it does not, the 58 stay unpriceable no matter what either side builds.

A4

"We do not hold them" is a different answer from "we hold them and cannot price them"

passes today — keep it

Run

Ask about a trader who is not in the directory, then one who is but whose wallets answered nothing.

Pass

Two distinct machine words. 404 with a directory refusal for the first; a served record with an empty result and a stated reason for the second.

Why

These become two different sentences on a person's screen — "we have never watched this trader" against "we could not read him". Collapsing them makes one of the two a lie.

A5

A name held by two people is refused, never resolved to one of them

unmeasured

Run

Register two traders under one display name. Ask by that name.

Pass

A refusal naming the ambiguity. Never one of the two chosen silently.

Why

Serving one of two is how somebody's record ends up on somebody else's page. It is also the only safe behaviour while A1 is unfixed.

Part B

Freshness, and telling the truth about it

We spent two days making our own reads faster before discovering the staleness was never ours. No read rate on our side can make a record fresher than the service's own copy.

&nbsp;

B1

The nightly rebuild actually happens on the cadence the service publishes

fails today

Run

Read /health daily for a week. Compare the stated next-load time against when the data behind it actually moved.

Pass

Every stated load happened within an hour of its promise, seven days running.

Why

Every consumer paces itself against the stated cadence. A promise that is not kept is worse than a longer promise that is — it makes everyone downstream retry at a rate that can never help.

Every "next load" the service reports is 06:00 UTC daily. Measured 15 Sep, its own /health said the trader data was rebuilt 14 Sep 10:37 UTC and that 368 of 448 scorecards were more than 72 hours old. The answers we held had been loaded 137 to 262 hours before we read them.

B2

No served record is older than the published cadence plus a stated grace

fails today

Run

Across the whole directory, take the age of every scorecard at the moment it is served. Report the oldest and the distribution, not the average.

Pass

The oldest is inside the published cadence plus grace. Anything past it is served with an explicit staleness marker, not quietly.

Why

A week-old win rate shown beside a live balance reads as one moment's truth. It isn't, and nothing on the wire says so.

One trader's record, SmokΞy, carried a service date of 7 Sep when read on 15 Sep — eight days old, served without qualification. 368 of 448 were past 72 hours.

B3

Every answer carries its own asOf, and asOf never moves unless the figures move

passes today — keep it

Run

Read one trader twice with no rebuild in between. Compare asOf and every figure.

Pass

Identical. A fetch is not a refresh, and the timestamp must describe the data, not the request.

Why

We had exactly this fault on our own side: a report row stamped with the moment it was fetched rather than the moment its figures were worked out, so a row could be dated 46 hours after the records behind it. If both ends do it, nobody can date anything.

B4

A slow answer is slow honestly, and a refusal carries a reason

fails today

Run

Hold a steady low call rate for six hours and record every response time and every non-200 body.

Pass

No empty-bodied 503\. Every refusal names a reason. Response times stay inside a published ceiling or the service sheds load deliberately and says so.

Why

An empty 503 is indistinguishable from a network failure, so every consumer retries it forever. That retry loop is what emptied our trader records for most of a day.

On 14 Sep from about 14:45 to 21:07 Pacific, reads took roughly two minutes each while we were sending at most 2 calls a minute. The service answered 503 with an empty body for much of that afternoon. One hourly pass saved 3 of 25 traders; the rest were retried the next hour and failed again.

Part C

The balance chart, across all four timeframes

The rule on our side is now settled and absolute: a trader's chart is the sum of his chains, for every trader and every window. Nothing else is drawn. That makes every test below load-bearing — a chart we cannot build is a chart the person does not get.

&nbsp;

C1

All four windows answer, and each states its own step

passes today — keep it

Run

GET /v1/traders/:id/aum?window=1d, then 1w, 1m, all.

Pass

Each returns points with an explicit step interval, and reach saying what was asked for against what is actually covered.

Why

A window that silently covers less than it was asked for draws a line the person reads as the whole period.

C2

A trader's chains are read at moments that line up

fails today

Run

For every trader with two or more chains, over 30 days: what fraction of days has a reading for every one of his chains? Report it split by chain count — one chain, two, three or more.

Pass

A trader with three chains can build a summed series on at least as many days as a trader with one. Chain count must not decide whether a chart exists.

Why

This is the single biggest cause of missing charts today, and it is invisible from any one response — it only shows when you compare chains of the same trader against each other.

Counted across our whole roster, 15 Sep. A month chart builds for 71 of 113 traders with one chain, 44 of 87 with two, and 19 of 157 with three or more. Month charts overall fell from 210 to 134 the moment we required every chain to be present. The readings exist; they do not share moments.

C3

One chain that cannot be rebuilt does not refuse the whole day

fails today

Run

Take a multi-chain trader. Ask for 30 days with no chain parameter, then ask the same 30 days chain by chain. Compare the refusal counts.

Pass

The whole-book answer holds at least what the per-chain answers hold. A chain that cannot be rebuilt is excluded and named, not made to refuse the others.

Why

Today a caller has to know to ask chain by chain to get data the service already has. That is a workaround for a bug, and it costs one call per chain per trader.

Measured against the live service, night of 11 Sep. @ogle, 30 days, asked with no chain: 1 real point and 27 refusals, every one saying chains\_unrebuildable. The same 30 days asked chain by chain: robinhood 28 of 28, bsc 6, ethereum 5, solana 1, base 1\.

C4

Coverage travels with every single point, and a thin point is refused rather than served

fails today

Run

For every point in a 30-day answer, read coverage.pricedPositions, coverage.totalPositions and coverage.valueShare. Find any point whose value share is under a quarter.

Pass

Every point states its coverage. A point that priced under a stated floor of the trader's value is served as a refusal with a reason, never as a balance.

Why

Without this, two points hours apart and forty times different are both "his balance", and any percentage between them is arithmetic over two different things.

SmokΞy, 10 Sep: at 09:00 the service served $1,257,699 at 96% coverage; at 17:00 the same day it served $31,813 at 2% coverage. Eight hours apart, forty times different, both served plainly as his balance. We now refuse anything under 25% at our own door — the test is that the service should not send it.

C5

Every point says how it was arrived at, and how far it can be trusted

passes today — keep it

Run

Check that every point carries basis (sampled or rebuilt) and tier (verified or reported).

Pass

Both present on every point. Absent means unknown and must never be read as the good value.

Why

A percentage change measured between a verified reading and a reported one is not a percentage of anything. We now refuse to print one unless both ends are verified, which is only possible because these fields exist.

Across 25,465 readings on 15 Sep, sampled paired with verified and rebuilt with reported in every case. The pairing is consistent — the test is that it stays explicit rather than becoming inferable.

C6

Gaps and breaks are declared lists, not something the caller infers

passes today — keep it

Run

On an answer with a known hole, check gaps\[\] carries from, to and reason, and breaks\[\] carries the joins the service says cannot be compared.

Pass

Present and complete. An absent list means "we did not say", which the caller must treat as unknown — never as "there are none".

Why

A hole the caller works out from the cadence is a guess. A hole the service declares is a fact, and it is the difference between a chart that explains itself and one that just stops.

C7

The drawable flag agrees with the points actually sent

passes today — keep it

Run

For 200 answers across all four windows, compare drawing.drawable and drawing.usablePoints against the points in the body.

Pass

Never disagree. When drawable is false, drawing.reason is a stable machine word.

Why

A caller that trusts the flag and a caller that counts the points must reach the same screen. Ours do both, in different places.

C8

The whole-book figure and the sum of the chains reconcile, or the difference is named

unmeasured

Run

For every trader, at every moment where both exist, compare the account-wide figure against the sum of the per-chain figures.

Pass

Equal within a published tolerance, or the answer names what the account-wide figure includes that the chains do not.

Why

These have always been two different answers rather than one filtered — and neither always wins. Across the directory, 309 of 434 traders can draw from a single chain, 109 from the whole-book figure, and 24 only from the whole-book one. Nobody has ever established why they differ.

C9

The batch route answers about everyone it was asked about

passes today — keep it

Run

Ask /v1/traders/aum for the full 50, including two ids that will fail.

Pass

Every asked id appears either in traders\[\] or in unreadableRows\[\]. Nobody is silently absent. capped is true whenever the ask exceeded the limit.

Why

A silently dropped row is indistinguishable from a trader with no data, and it is the row nobody ever notices is missing.

Batch limit is 50 and a full-roster chain pass is 76 batch reads, about 2.5 seconds each — roughly 8 minutes for 3,442 chain answers across 357 traders. This route works well and the test exists to keep it that way.

C10

A trader with a long record can be asked for a long window

unmeasured

Run

For the ten traders with the longest records, ask window=all and compare reach.coveredDays against their stated track record.

Pass

Coverage reaches the start of the record, or progress says how much is still being filled and when it will be done.

Why

"All time" that quietly means "the last three weeks" is the kind of thing nobody catches until a person asks why a two-year trader has a short line.

Part D

Traders who hold more than one chain

More than a third of the directory holds three chains or more, and almost every fault we could not explain this week turned out to be one of them. A multi-chain trader is not a single-chain trader with extra rows: the chains have to agree about who he is, when he was read, and what counts as his money. These tests only fail for people with several chains, which is why none of them showed up in single-trader spot checks.

&nbsp;

D1

The batch answer names the same chains as the single answer

fails today

Run

Read one multi-chain trader through /v1/traders/:id/aum, then read the same trader in a batch through /v1/traders/aum. Compare the chains\[\] block.

Pass

Identical. The batch route returns the complete envelope by default — chains, reach, status, drawable decision — not a shortened row that has to be asked for by name.

Why

Every consumer's bulk pass uses the batch route. If the short shape is the default, the entire stored copy of the world says a trader has no chains, while anyone who spot-checks him one at a time sees five. Nothing reconciles the two, and the bulk answer is the one on people's screens.

Measured on a copy at 15:50 UTC, 12 Sep. Without contractVersion: 2, the batch route answers a handle, a count, a newest figure and the points and nothing else. All 435 traders our hourly pass had warmed were stored in that shape, so every chart read named no chains at all and the per-chain rule said "no chains named" for everybody — while the same trader's single read carried five chains, a reach, a status and the service's own drawable decision.

D2

A trader's chain list is complete, and does not change between two calls

fails today

Run

Read the same trader's chain list five times over an hour with no rebuild in between. Compare the lists.

Pass

The same chains every time. A list that is still being filled says so through status or progress, rather than growing silently.

Why

The chain list decides what gets summed. A list that grows between two reads means the same trader's chart is a sum of three chains at one moment and five at another, and the two are not comparable — but nothing on the wire marks the join.

Captured 14 Sep: the chain count beside one trader's name changed between two captures of the same build against the same service — showing a chain, then "+3", then nothing — filling in as reads arrived, with no field saying the list was incomplete.

D3

Every chain named is either priced or says why it was not

passes today — keep it

Run

For every entry in chains\[\], check it carries chain, networkId, totalUsd, pricedShare and, when totalUsd is null, a reason.

Pass

No chain is listed with a null figure and no reason. A chain the service names but can never price is a standing state and says so, not a transient.

Why

A chain with no figure and no reason is the difference between "he holds nothing there" and "we could not look", which are opposite facts about the same man.

D4

The answer says how many chains and wallets it actually reached

passes today — keep it

Run

Read coverage.answeredChains against totalChains, and answeredWallets against totalWallets, on an answer where one chain is known to be failing.

Pass

The shortfall is visible in the response. A trader whose Base wallet answered and whose Solana wallet did not never looks like a trader who was read completely.

Why

This is the only field that distinguishes a man who has genuinely moved his money from one who has three chains and we only read one. Without it, a partial read is drawn as a collapse in his balance.

D5

A per-chain answer echoes back the chain it was asked about

passes today — keep it

Run

Ask ?chain=base and check the answer's own chain field. Then ask for a chain the trader does not hold.

Pass

The echo always matches the ask, or the answer is a refusal. Never the whole portfolio returned under a chain's name.

Why

One chain's dollars stored as the whole trader's is a line about the wrong money, and it is invisible afterwards — the figure is real, it just belongs to something else. We refuse any answer whose echo does not match, and the test is that we should never have to.

D6

A chain joining or leaving is declared, with the chains named

passes today — keep it

Run

Over 30 days for a trader who gained a chain, check breaks\[\] carries reason (chains\_changed, method\_changed or method\_and\_chains\_changed) with chainsAdded and chainsRemoved, and that each point's comparableWithPrevious agrees with that list.

Pass

They agree, on every trader. A join the service will not vouch for is marked on both.

Why

Two readings either side of a chain arriving count different things. Joining them draws a jump the trader never made — and it is the single most consequential thing in this document that the service already gets right.

Measured across all 448 traders: the declared break list agrees exactly with each reading's comparable flag. Before we started reading these two fields, our own chart joined 1,507 month-window jumps the service had explicitly told us not to join. The information was on the wire the whole time.

D7

Nothing is counted twice across two chains

unmeasured

Run

For traders holding a bridged asset on two chains, compare the sum of the per-chain figures against an independently computed holding.

Pass

The same money appears once. Where an asset legitimately exists on two chains, the response says so rather than leaving the caller to add both.

Why

Our rule is now that a chart is the sum of the chains. That makes any double count on the service's side a doubled balance on a person's screen, with nothing on our side able to detect it.

D8

The chain vocabulary is closed, stable and matches the network ids

unmeasured

Run

Collect every distinct chain word and its networkId across the whole directory.

Pass

A closed published set. One word per network, one network per word, never renamed in place.

Why

Chain words are the service's own and are never invented by a caller — we take them off the chains block and ask with them verbatim, because a word we made up is a read spent on nothing. A word that changes spelling silently retires a chain from every trader who holds it.

The words in use today are solana, ethereum, base, bsc and robinhood. Nothing publishes that list, so nobody can tell a new chain from a typo.

Part E

The scorecard, and the six sides of the profile

The deep-dive profile places a trader on six axes against everyone else, and answers four questions about whether he is worth copying. All of it is arithmetic over one scorecard. When a figure is missing, the axis is drawn hollow with a stated reason — so what the service withholds is visible, and what it gets wrong is not.

&nbsp;

E1

All six axes' inputs are present, or each absence names itself

fails today

Run

For every trader, check the inputs behind the six axes we draw and count how many are absent with no stated reason.

Pass

Zero silent absences. Every missing figure carries a machine word for why.

Why

A hollow axis is honest. A hollow axis with no reason is a hole a person reads as a judgement about the trader.

cashOut          bankedUsd, onPaperUsd, realizedShare

consistency      closedTrades, topTradeShare, meanToMedian, medianTradeUsd

edge             winRate, wins, losses

riskControl      worstTradeUsd, typicalBetUsd, cashShare, concentration

holdTime         holdTimeDays  (+ holdTimeCoverage)

activityDensity  tradesPerDay, activeDays, trackRecordDays, lastTradeAtMs

Of 1,079 empty axis corners across the roster, 970 were "the report held none of his figures". None came from our own ranking rules.

E2

Two figures counted over the same events agree with each other

fails today

Run

For every trader, check that wins \+ losses reconciles with closedTrades, and that any per-coin win count reconciles with the per-trade one.

Pass

They reconcile, or each states explicitly which set of events it counts over.

Why

Two numerators over two denominators produce two win rates from one record, and whichever a screen picks, the other one is also on the page somewhere.

Aurelius, as served: wins: 40, losses: 87, trades: 127, coinsTotal: 44, coinsWon: 40\. The same numerator over two denominators gives 91% and 32%. Both appeared on one screen. Separately, a trader shown at 53% was assessed by hand at 35%.

E3

Win rate states its denominator

fails today

Run

Read winRate and check the response says what it is a rate of — closed trades, coins, or positions — and over what period.

Pass

The denominator is named in the response, not in documentation.

Why

Win rate is now a hard floor in our verdict: below 30% we tell a person not to copy. A rate whose denominator we have to guess is not something to hang that on.

E4

Every figure states how much of the record it covers

fails today

Run

Check that each of the six axes' figures carries a coverage block — how many events it was computed from, out of how many exist.

Pass

Present on all six. Today only hold time and typical bet carry one.

Why

A figure over four trades and a figure over four hundred are drawn the same size on a six-sided chart, and a person has no way to tell them apart.

Of 441 traders, 395 draw at least one green "no warning signs" mark; for 170 of them that mark rests on fewer than 10 observed buys. One trader shows three clean marks drawn from four observations.

E5

Hold time is published, never left to the caller to derive

passes today — keep it

Run

Confirm holdTimeDays is served directly with its coverage.

Pass

Present. The caller never computes it from open and close dates.

Why

The service holds the open and close of every position and we hold neither. Any sum of ours would be over a different set of events and would silently disagree with the service's own.

E6

Entry market caps are priced for enough of a record to rank on

fails today

Run

Count traders for whom a market cap at the moment of entry exists on at least 20 closed trades.

Pass

Enough of the directory to rank a cohort — at minimum, most traders rather than a handful.

Why

"How early he gets in" was one of the six axes and had to be retired: a corner nobody can be placed on is worse than one that isn't drawn. It is still computed and still exported, waiting for this test to pass.

Measured 8 Sep: the service could price entry size on enough of a record to stand behind for 11 of 144 traders on the board — under the 20 a ranking needs.

E7

A month of results exists for a trader with a year of record

fails today

Run

Ask for monthly profit and loss for any trader with a long record. Count how many of the directory have at least three months.

Pass

Available for most traders with a record long enough to have them.

Why

This is the one that blocks a product decision outright. Our verdict asks four questions, and the fourth is whether a trader survives a bad month. Nothing published anywhere measures it — so the fourth question is permanently unanswered, and not one trader out of 441 can reach the top verdict. The whole "follow" state is unreachable for want of this field.

E8

Scorecards can be asked for in a batch

fails today

Run

Ask for 50 scorecards in one call.

Pass

Answered, the way the balance route already answers 50 at a time.

Why

One trader per call makes a full refresh 441 calls instead of 9\. That is the difference between the record being minutes behind and being hours behind, and it is the reason our own read pass has to pace itself so carefully.

Measured 15 Sep: a scorecard is one trader per call. Timed over 45 live reads — 4.0 s one at a time, 4.1 s five at a time, 4.8 s ten at a time. A full-roster refresh is about 30 minutes serial, or 8 minutes four at a time. The balance service already takes a list of 50\.

E9

A withheld figure is withheld, not zeroed

passes today — keep it

Run

Find figures the service deliberately withholds where they would mislead — the mean-to-median ratio is one — and check what arrives.

Pass

null, never 0\.

Why

Zero is a claim. Null is an absence. A zero worst-trade reads as a trader who has never lost.

Part F

Every field: empty, wrong, or quietly absent

The tests above ask whether the figures are right. These ask whether they are figures at all. Everything here is a sweep across the whole directory rather than one trader — a field that is null for four traders is a curiosity, and one that is null for four hundred is the product. None of it can be caught by reading a single response, which is why it has never been caught.

&nbsp;

F1

Every field's real fill rate is published, per field, across the directory

fails today

Run

For every field of every answer, count how many of the directory's traders have it populated. Produce one table: field, fill rate, and the commonest reason for absence.

Pass

The table exists and ships with the release. A field below a stated fill rate is either fixed or marked as not yet generally available, so nobody builds a screen on it.

Why

Every screen we have built on a field that turned out to be mostly empty was built because a spot check of two or three traders showed it populated. One table, produced once per release, would have prevented all of them.

Of 1,079 empty axis corners across our roster, 970 were simply "no figure held for him". An entry-size figure good enough to rank on existed for 11 of 144 traders — which is why that axis had to be retired after being built. Both were discovered after shipping.

F2

Null means absent, zero means zero, and there are no sentinels

passes today — keep it

Run

Sweep every field for 0, "", "-", "N/A", "null", "unknown" and epoch zero. For each, establish whether it means the value or the absence of it.

Pass

Absence is always null. No string stands in for a missing number and no number stands in for a missing fact.

Why

Zero is a claim and null is an absence. A zero worst-trade reads as a trader who has never lost; a zero balance reads as a man who has sold everything. Both are sentences we would print about a real person.

F3

A number is a number, and is inside the range its meaning allows

passes today — keep it

Run

Sweep every numeric field for a string-typed number, NaN, infinity, a negative count, a share outside 0–1, and a priced count above its total.

Pass

None found. A number that arrives unreadable refuses its whole answer rather than being coerced.

Why

A count of trades cannot be negative and a share cannot be 1.4, so letting one through means every figure derived from it is wrong in a way nothing downstream can detect.

Our parser already refuses an entire answer when a totalUsd is present but unreadable, rather than treating it as null — because a reading silently turned into "no figure" is indistinguishable from a moment we were never read. The test is that it should never fire.

F4

Units are stated, and never change under a field that keeps its name

unmeasured

Run

For every quantity, confirm its unit is published: dollars or cents, a share as 0–1 or a percentage, days or milliseconds, an ISO string or epoch seconds.

Pass

Published and stable. A unit change gets a new field name, never a new meaning under the old one.

Why

A unit change under a stable name is undetectable and catastrophic: every figure stays plausible and every one is wrong by a hundred or a thousand. Nothing in a test suite catches it and nothing on a screen looks broken.

Already a live inconsistency between the two deployments: the balance service sends moments as ISO strings, and elsewhere the same concept arrives as seconds. Both parse; only one is right per field.

F5

Every word field comes from a closed, published set

fails today

Run

Collect every distinct value of every enumerated field across the whole directory: basis, tier, status, refused, drawing.reason, gaps\[\].reason, breaks\[\].reason, chains\[\].reason, contractMode.

Pass

Each set is published and closed. A new word is a release note, not a surprise.

Why

These words are not read by machines alone — each one becomes a sentence a person reads, in two languages. A word nobody has published is a word with no sentence behind it, and the screen either prints the raw machine word or says nothing at all.

We have had to discover these by observation, one refusal at a time: chains\_unrebuildable, too\_little\_priced, no\_chains\_answered, no\_chains\_named, too\_few\_points, chains\_changed, method\_changed, method\_and\_chains\_changed. Each arrived as an unexplained blank on somebody's screen first.

F6

A figure derived from others agrees with them

fails today

Run

Across the directory, check the internal arithmetic of every answer:

Pass

Every relation below holds for every trader, or the answer says which figures are counted over different sets of events.

Why

A response that contradicts itself puts the contradiction on a screen, and whichever figure we choose to show, the other one is also on the page somewhere.

wins \+ losses          reconciles with  closedTrades

coverage.priced        ≤                coverage.total

answeredChains         ≤                totalChains

answeredWallets        ≤                totalWallets

count                  \==               points.length

reach.coveredFrom      ≤                reach.coveredTo

reach.coveredDays      ≤                reach.requestedDays

drawing.usablePoints   ≤                count

every gap / break \`at\` falls inside from…to

Aurelius, as served: wins 40, losses 87, trades 127 — which reconciles — alongside coinsTotal 44, coinsWon 40, which gives a second win rate from the same record. 91% and 32%, both true, both on one screen.

F7

Every row carries an identity that can be filed

fails today

Run

Sweep every row of every table for one whose identifier and address are both empty. Count the figures attached to them.

Pass

Zero. A figure that cannot be filed under a person should not be served, because there is nowhere for it to go.

Why

Figures with no owner are not harmless dead weight — they look like data. They inflate every count, they cannot be corrected, and nothing downstream can tell them from a real trader's record.

On the owner's own data: 15 traders we hold nothing for but a name, carrying 803 rows of figures across five tables, with the service identifier and the address both empty. None appears in the directory, the public trader list, the person table or the deck. Nine of them hold a current scorecard — written for traders who were never in the directory at all.

F8

A partial answer never arrives looking complete

fails today

Run

Force one upstream to fail mid-answer. Read what comes back.

Pass

The response is marked partial and names what is missing. It never arrives as a whole answer with the failed part rendered as null or zero.

Why

A partial answer that looks complete is worse than an error, because it is stored. The error would have been retried; the stored half-answer is served to people for as long as it is considered fresh.

This is the general form of two faults already in this document — the batch route serving a chainless row that looks like a trader with no chains, and a balance priced at 2% of a portfolio served as plainly as one priced at 96%.

F9

A field is never removed or retyped in place

unmeasured

Run

Diff the full field set of v10 against v9 across the same traders. List every field added, removed, retyped or changed in nullability.

Pass

The list ships with the release. A removal is announced a version ahead; a retype gets a new name.

Why

A consumer's parser fails loudly on a retype and silently on a removal — the field simply becomes null everywhere, which looks exactly like a trader with no data, for every trader at once.

F10

The same trader read twice gives the same answer

unmeasured

Run

Read fifty traders twice, a minute apart, with no rebuild between. Diff every field.

Pass

Identical, apart from anything explicitly documented as live.

Why

An answer that moves between two reads means something is being computed at request time rather than served from the rebuild — and whatever that is, it is the thing that will differ between what a person sees and what we stored about them.

Part G

Behaviour under load

We hold an allowance of 240 calls a minute, shared by every caller. The tests here are about whether that number means anything.

&nbsp;

G1

The published allowance is the real one

unmeasured

Run

Ramp to the stated 240 a minute and hold for ten minutes.

Pass

No refusals below the stated rate, and response times do not degrade several-fold on the way up.

Why

We have never reached a tenth of it. Our own peak was 123 calls in an hour, and the service was already two minutes per read at 2 calls a minute — so the real ceiling is unknown and the published one has never been tested.

G2

Rate-limit headers are truthful and usable for pacing

passes today — keep it

Run

Read limit, remaining, resetSeconds and scope off successive answers while varying the call rate.

Pass

remaining falls as calls are made and resets when it says it will. Where the counter is not counting, scope says unlimited so the figure is not mistaken for a budget.

Why

A consumer that paces against a wrong remaining figure either throttles itself to nothing or walks into a refusal it was told would not come.

G3

A failing read is distinguishable from a permanently impossible one

fails today

Run

Ask for something the service can never answer — a chain it does not index, a trader with no wallet — and compare the response with a genuine transient failure.

Pass

Two different machine words. A standing impossibility is cacheable; only a transient invites a retry.

Why

Where the two look alike, every consumer retries the impossible ones forever. We are fixing exactly this fault on our own side this week, on a route that retried the same unfetchable image on every screen paint.

G4

A deployment that cannot serve says so at /health, not at every route

fails today

Run

With an upstream key unset, read /health and then a scorecard.

Pass

/health reports the degraded capability by name. Individual routes do not have to be probed to discover it.

Why

A consumer checks health once and routes thousands of times. A capability that only reveals itself on the thousandth call is one every consumer discovers the expensive way.

On 11 Sep the other deployment answered 503, "FOMOAPI\_KEY is not set — the scorecard needs fomoapi /trades" to every ask, with nothing at /health saying so. Separately, the address in our own deployment config currently answers "suspended"; we run against the built-in address instead.

If only four of these are done

These are the four that change what a person actually sees, rather than what we can measure about it. Two of them are about traders holding several chains, which is where nearly every unexplained fault this week ended up.

&nbsp;

C2 — line the chains up. Only 19 of 157 traders with three or more chains can draw a month chart, and the readings already exist — they simply never fall on the same day. This is the single largest cause of blank charts, and it costs nothing to serve but a scheduling change.

E7 — publish a month of results. Without it, the fourth of our four questions can never be answered, and the top verdict is unreachable for every trader in the directory. No amount of work on our side moves it.

D1 — make the full answer the default. A bulk read that omits the chain block makes every trader in a stored copy of the world look chainless, while a spot check of the same man shows five chains. It measured 435 of 435 for us. Every consumer will hit this, and most will not notice.

B1 — keep the nightly rebuild. Everything downstream paces itself against a promise of 06:00 UTC daily. While 368 of 448 records sit past 72 hours, every consumer is polling for a freshness that is not coming.

Written from measurements taken against the live service between 10 and 15 September 2026\. Every figure quoted is one we recorded; where something was not measured, the test says so rather than estimating. Field names are as they appear on the wire today.

&nbsp;