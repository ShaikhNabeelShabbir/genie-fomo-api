# Decisions

The reasoning behind the constants and shapes in `supabase/functions/`, moved out of the
source so a read of the code costs the code alone. Each section is numbered; the code
keeps the first sentence and a pointer `See docs/DECISIONS.md#dNNN`. Text is the original
comment, unchanged. Regenerate with the extractor rather than editing pointers by hand.

## D001

**`_shared/chain_reads.ts`** — Reading true balances off the five chains we carry — the Deno half.

Reading true balances off the five chains we carry — the Deno half.

A DELIBERATE PORT, NOT A REWRITE. `scripts/lib/chain_reads.mjs` is the Node original and
every line here matches it: the same token programs, the same 40-call batch, the same
per-host throttle, the same refusal to turn an unreadable balance into a zero. Two
implementations of this WILL drift the first time either is edited, and the two figures
disagreeing is precisely the bug the AUM feature exists to remove — a running total and a
balance are not the same number. If you change one, change both.

Nothing here touches Postgres. These are network reads and pure arithmetic; the caller
decides what to store.
 

## D002

**`_shared/chain_reads.ts`** — One in-flight request per host, with a floor on the gap between them.

One in-flight request per host, with a floor on the gap between them.

The public chain RPCs are a shared free resource and robinhood's answers 429 well before
anything else does. Serialising per host costs seconds and is the difference between a
complete snapshot and a partial one.

NOTE for the Edge Function: this map lives per instance. Edge Functions scale horizontally,
so N warm instances make N times these calls. That is why the caller caps how many traders
one invocation may sample rather than relying on this alone.
 

## D003

**`api/db.ts`** — One Postgres connection for the whole function instance.

One Postgres connection for the whole function instance.

Edge Functions are Deno, not Node, so none of `src/` runs here — this is a parallel
implementation whose job is to produce byte-identical output to the Express API. Every
route is diffed against it before it ships.

`prepare: false` is required, not optional: SUPABASE_DB_URL points at the transaction
pooler when port 6543 is used, and transaction-mode pooling does not support prepared
statements. With it left on, queries fail intermittently under load rather than
immediately, which is the worst way to find out.
 

## D004

**`api/db.ts`** — Deno verifies TLS against its own trust store and rejects the Supabase pooler's chain with

Deno verifies TLS against its own trust store and rejects the Supabase pooler's chain
with `UnknownIssuer`, where Node's `rejectUnauthorized: false` simply skipped the
check. `require` still encrypts; it just does not demand a chain Deno cannot build.

In a deployed Edge Function the database is reached inside Supabase's own network, so
this only matters when running the file locally to diff it against the Node service.
   

## D005

**`api/errors.ts`** — Typed errors, so a caller can tell apart the three cases that need different reactions: 40

Typed errors, so a caller can tell apart the three cases that need different reactions:

  401 unauthorized  — the key is missing or wrong. STOP; retrying will not help.
  429 rate_limited  — back off and retry. `Retry-After` says how long.
  503 unavailable   — we are briefly down. Retry, and keep showing your last good copy.

A single generic 500 forces a consumer to render "something went wrong" for all three,
which is exactly the complaint this exists to answer. Every error body carries a stable
machine-readable `code` alongside the human `detail`, because status alone cannot
distinguish "no such trader" from "no such route".
 

## D006

**`api/errors.ts`** — A sub-resource the caller explicitly asked for could not be produced.

A sub-resource the caller explicitly asked for could not be produced.

503 rather than 200-with-the-block-missing, and this is not a style choice. A consumer
asked `?include=wallets`, got 200 with 435 traders and no wallets on any of them, and
treated the silence as "these traders have no wallets" -- it nearly deleted their entire
watch list. A success-shaped empty answer is worse than an error, because nothing
downstream can tell it from the truth.
 

## D007

**`api/errors.ts`** — Map anything thrown to a stable, documented code -- and never hand the caller driver text.

Map anything thrown to a stable, documented code -- and never hand the caller driver text.

A consumer was once returned `bind message supplies 8 parameters, but prepared statement
requires 0`. That is a postgres wire-protocol detail: it names no route, suggests no
action, and leaks how the service is built. Internal faults now answer `internal_error`
with a fixed sentence and the detail goes to the log, where it belongs.

**19 Sep 2026 — the order of the tests is the rule.** `D1_ERROR` was matched before anything else,
so `D1_ERROR: no such column: ps.last_usd … SQLITE_ERROR` — a missing join of ours — was served as
503 "the database is not answering, retry shortly" for two days, and the consumer read an outage.
A busy database was served as 429 `rate_limited` beside `RateLimit-Remaining: 240`. Now: (1) what
SQLite rejects, what the shim refuses and a TypeError are OUR BUG, a loud 500 that no retry heals;
(2) overloaded, queued too long or reset is 503 `unavailable` with `Retry-After: 15`; (3) not
answering is 503 with `Retry-After: 5`. 429 means the caller's own window and nothing else.

## D008

**`api/errors.ts`** — The rate limiter.

The rate limiter.

This was a `Map` in module scope. That never worked: every Edge Function invocation gets
a fresh isolate, so the map arrived empty and was thrown away on exit. Measured: 132
consecutive calls each reported `remaining: 239`, and 400 calls never produced a 429. The
limit did not bind, and the header was a constant wearing a budget's clothing — worse
than no header, because a client would have paced against it.

The counter now lives in Postgres, the one thing every instance shares, and is bumped in
a single atomic statement so two instances cannot interleave a read-modify-write.
 

## D009

**`api/errors.ts`** — `global` when the shared counter answered, `unlimited` when it did not.

`global` when the shared counter answered, `unlimited` when it did not.

The limiter fails OPEN: if the database is unreachable the request is served rather
than rejected. A rate limiter that turns a database blip into a site-wide outage has
done more damage than the traffic it was guarding against. `scope` says which happened,
so a header reading 240/240 is never mistaken for a fresh window.
   

## D010

**`api/index.ts`** — No route may hang.

No route may hang. See the Promise.race below.

The requirement asks for 5s. This ships at 15s, deliberately and visibly, because at 5s
three routes -- /health, /traders/:handle and /tokens -- returned `timeout` on EVERY call:
measured 5.4s, 5.9s and 6.9s with nothing else running. A bound that turns a slow route
into a permanently dead one is worse than the hang it replaced.

15s still does the job the requirement actually wants: a 30-second wait with no body is
indistinguishable from a slow success, and this makes that impossible. Getting to 5s is
query work on those three routes, not a smaller number here.
 

## D011

**`api/index.ts`** — The bucket key for a caller.

The bucket key for a caller.

`x-forwarded-for` is a CHAIN — `client, proxy1, proxy2` — and only the leftmost entry is
the original caller. Using the whole header made the key move as intermediate hops
changed: eight anonymous calls in a row produced 239, 239, 239, 238, 237, 238, 239, 236,
because they were landing in several different buckets. The first entry is stable.

Note it is also client-supplied and therefore spoofable; this is a fair-use guard, not a
security control, and the leftmost-entry rule is what makes it work for honest clients.
 

## D012

**`api/index.ts`** — COST IS WHAT THE CALL ACTUALLY ASKED FOR, not a flat 1.

COST IS WHAT THE CALL ACTUALLY ASKED FOR, not a flat 1.

A batch of fifty traders does fifty traders' worth of work, and reporting it as one
unit -- the same as asking for a single trader -- gives a consumer no way to pace
itself or predict a budget. Batch responses carry `asked`, so that is the cost; every
other route costs one. GENIE_FOMO_V7_BATCH_AUM_TDR.md §7 requires the accounting to be
deterministic and documented, and a number that ignores the request size is neither.
     

## D013

**`api/router.ts`** — Match a path, preferring literal segments over parameters.

Match a path, preferring literal segments over parameters.

Declaration order is NOT the tiebreak, deliberately. `/v1/tokens/momentum` and
`/v1/tokens/:address` are the same shape, and with first-match-wins the literal route is
unreachable if it happens to be declared second — which is exactly the bug this hit:
`momentum` resolved as a token address and returned "no leader holds 'momentum'".
Scoring by specificity makes the outcome independent of the order things are written in.
 

## D014

**`api/routes/aum.ts`** — THE SAME WINDOW, SPELLED THE WAY PEOPLE SPELL IT.

THE SAME WINDOW, SPELLED THE WAY PEOPLE SPELL IT.

The four windows are `1d`, `1w`, `1m`, `all`, and everything else was a 400 -- including
`30d`, which is the natural request from a document that keeps saying "thirty days", and
`1D` / `30D` / `1M`, which is how chart buttons are usually labelled. A consumer whose pills
read 1D / 7D / 30D / All got a chart on three of them and an error on the fourth, which
reads as the service being down rather than as a spelling disagreement.

The canonical names are unchanged and are what `window` echoes back, so nothing that already
works changes its answer. These are only ways IN.
 

## D015

**`api/routes/aum.ts`** — A trader's balance over time — one sampled point per hour, in USD, across every wallet and

A trader's balance over time — one sampled point per hour, in USD, across every wallet
and chain.

`/portfolio` answers "now"; this answers "over time", and the two are deliberately not
merged. If the newest sample here disagrees with `/portfolio`, that is a finding worth
chasing, not something to average away.

NOT bulk-able through `?include=`, for the same reason `/portfolio` is not: it is a series
per trader, and a page of them would be the largest response this API can produce.
 

## D016

**`api/routes/aum.ts`** — A FIGURE BUILT FROM ALMOST NONE OF A WALLET IS NOT A BALANCE.

A FIGURE BUILT FROM ALMOST NONE OF A WALLET IS NOT A BALANCE.

Section 9 has always said `totalUsd` is null, never a smaller number, when a wallet could
not be read. That rule was applied to outright refusals and not to the case that actually
bites: a point that DID answer, for 1.7% of the wallet.

Measured over thirty days: the median REBUILT point prices 1.7% of its trader's value,
and 6,133 of 7,815 price under a tenth. The median SAMPLED point prices 66.7%. So the
rebuilt history is thinly priced by construction -- and drawing it as a balance line
produces exactly what the consumer reported: $40 to $389,797 between two neighbouring
points, with no method change and no chain change to explain it. 1,226 of 3,033 jumps of
half or more had no declared cause, and on those the lower side priced a median 1.2%.

No break marker fixes that, because both sides are thin: the ratio between 1.2% and 1.5%
is nothing, while the dollar figures differ by a thousandfold. The honest answer is the
one this document already gives everywhere else -- refuse the number and say why. The
point still exists, `gaps[]` still lists it, and a chart breaks its line there instead of
drawing through a figure that is wrong in a way no consumer could detect.

PRICED_FLOOR is the one number that decides this. It is deliberately a single constant,
and the trade at each setting was measured against the consumer's own metric -- jumps of
half or more on the month window that carry no declared cause:

    floor   traders who can draw     undeclared jumps
    none            432                    1,226
    0.10            416                      254
    0.20            408                      158   <- here
    0.30            393                      122

0.20 halves the residual for the cost of eight traders. Of the 158 that remain, 66 have
both sides pricing over half the wallet -- those are most likely real moves, and marking
them would be a false alarm rather than a fix.

RAISED TO 0.25 for the v10 acceptance tests, which ask for a quarter rather than a fifth.
Measured at 0.20: 341 points were served as a balance on a value share between 20.0% and
24.6%, and none below 20%. Those 341 are exactly what this move converts into refusals.

A MINIMUM PRICED-POSITION COUNT BELONGS HERE TOO, and cannot be added yet.

Measured on unipcs, 18 August: the whole book was refused at a 0.32% priced share, and so
were robinhood and solana on the same reading. `bsc` was SERVED, at a 50% share, because
bsc held two positions and one of them was priced -- so a consumer summing chains built a
$0.44 chart for a man the service itself refused to price. A share alone cannot catch
that; it needs the count behind the share.

`aum_chain_samples` does not carry one. The chain query below selects
`null::int as priced_positions` because the column does not exist, so a count-based guard
would silently never fire on exactly the path that needs it. Adding it is a migration
plus a rebuild, not a read-path change.
   

## D017

**`api/routes/aum.ts`** — THE REFUSED FIGURE IS KEPT, not discarded.

THE REFUSED FIGURE IS KEPT, not discarded.

Refusing a thin point is right: served as `totalUsd` it is a balance, and a balance built
from 3% of a wallet is wrong in a way no consumer can detect. But the number was computed
from real positions at a real moment, and throwing it away meant a month of history with
three drawable points out of twenty-seven -- the other twenty-four existed and said
nothing at all.

So the refusal stands and the arithmetic survives beside it. `partialUsd` is the figure as
computed, carrying the coverage it was computed at, and it is NEVER `totalUsd`: a caller
has to reach for it deliberately, and cannot mistake it for a balance the service stands
behind. Plot it as a faint line, a shaded band, a tooltip -- but not as his money.
   

## D018

**`api/routes/aum.ts`** — THE READING JUST BEFORE THE WINDOW IS KEPT, as an anchor.

THE READING JUST BEFORE THE WINDOW IS KEPT, as an anchor.

History steps once a day, so a 24-hour window contained at most one point and usually
none -- `window=1d` drew nothing for anybody. But a one-day chart wants exactly two
figures: what he was worth at the start of the day and what he is worth now. We hold
both; the older one simply sat one row outside the filter.

So the newest reading BEFORE the window joins the series, marked `outsideWindow` so it is
never mistaken for one inside it. `reach.coveredFrom` reports where the line really
starts. This also stops 7d and 30d beginning a day late for the same reason.
   

## D019

**`api/routes/aum.ts`** — Reach back far enough for a LINE, not just for one point.

Reach back far enough for a LINE, not just for one point.

One anchor is not always enough. History steps once a day and the newest step can be a
day and a half old, so the last 24 hours held nothing and the single preceding reading
gave one point -- still not a line. Taking preceding readings until the series holds two
turns `window=1d` into the two figures a one-day chart actually wants.

Nothing here is invented: every point is a real dated reading, the ones from before the
window carry `outsideWindow`, and `reach.coveredFrom`/`coveredTo` report the span the
line truly covers rather than the span that was asked for.
   

## D020

**`api/routes/aum.ts`** — BORROWED POINTS MUST SHARE THE NEWEST POINT'S BASIS.

BORROWED POINTS MUST SHARE THE NEWEST POINT'S BASIS.

Two numbers valued on different bases are not a line. unipcs held a sampled reading of
$15,665,318 and a rebuilt one of $5,101,125 eight hours apart -- a 67% fall that never
happened, because the two count different things. Borrowing across that seam would have
drawn exactly the cliff the whole basis/tier distinction exists to prevent.

So a borrowed reading has to be the same kind as the one it is being compared with.
   

## D021

**`api/routes/aum.ts`** — THE DEFAULT STEP IS THE COARSER OF WHAT THE WINDOW AFFORDS AND WHAT THE DATA HOLDS.

THE DEFAULT STEP IS THE COARSER OF WHAT THE WINDOW AFFORDS AND WHAT THE DATA HOLDS.

It used to be the first of those alone: the coarsest step leaving at least 24 points in
the requested span, so a week does not arrive as 168 points nobody plots and a day does
not collapse to 1. That is a sound rule about the WINDOW and says nothing about the
readings, so every one of the 435 weeks declared 6h steps over readings a day apart --
566 of the gaps between neighbouring readings measured 24 hours, against 156 at 8 and
258 at 16. The answer described itself wrongly, which is its own kind of untrue figure.

So the observed spacing sets a floor. A week over daily readings declares 1d, and starts
declaring 6h on its own the day the readings are actually six-hourly.
   

## D022

**`api/routes/aum.ts`** — WHAT IS DECLARED IS NOT WHAT IS BUCKETED, and conflating them costs real readings.

WHAT IS DECLARED IS NOT WHAT IS BUCKETED, and conflating them costs real readings.

`chosen` is the bucket the points are thinned into, and it must stay as fine as the
window affords: coarsening it to match the data merged both of one trader's 10 September
readings into one and returned five points where six exist. Thinning is for keeping a
chart plottable, not for making the label true.

`declared` is what the answer CALLS its step, and that has to match the readings. It is
the coarsest step that covers the observed spacing, so a week over daily readings says
1d and begins saying 6h by itself the day the readings are six-hourly.

A caller who names a step gets that step in both places: they asked, and the answer
should not argue. `observedStepMs` still reports what the data does either way.
   

## D023

**`api/routes/aum.ts`** — THE FIGURE BEHIND A REFUSAL.

THE FIGURE BEHIND A REFUSAL. Present only when this point was refused for thin pricing,
null otherwise.

Not a balance, and deliberately not `totalUsd`. It is what the priced positions summed
to at this moment, and `coverage.valueShare` says how much of him that was. A month
window that draws three points out of twenty-seven has twenty-four of these: real
arithmetic over real positions, too thin to publish as his money, too informative to
throw away. Draw it faint, or on request, or not at all — but never as the line.
     

## D024

**`api/routes/aum.ts`** — `valueShare` IS NOT A SHARE OF VALUE, and the name has misled for long enough.

`valueShare` IS NOT A SHARE OF VALUE, and the name has misled for long enough.

It is `pricedPositions ÷ totalPositions` -- a COUNT. Measured on poopinyourhands:
18 priced of 20 positions, valueShare 0.9, and 18÷20 = 0.9 exactly. The consumer
caught this and is right: a trader whose one real holding is fully priced but who
carries sixteen dust positions reads as thin and gets refused by a floor built on
this number, when by value we have priced essentially everything he owns.

A TRUE share of value cannot be computed and never could: the unpriced positions are
unpriced, so their value is unknown by definition. Pretending otherwise would be a
worse answer than a badly named one.

So the field is named honestly alongside, and the old name keeps working. Read
`pricedPositionShare`; `valueShare` is the same number under a name that lies about
what it counts.
       

## D025

**`api/routes/aum.ts`** — HOW MUCH OF HIM THIS DAY IS, per point rather than per response.

HOW MUCH OF HIM THIS DAY IS, per point rather than per response.

A rebuilt day used to be refused outright unless every chain answered at it, which
refused 8,894 days across the directory while the per-chain figures for those days
existed all along. The day is now stated with the chains that answered -- and these
two numbers are the reason that is safe. `chainsAnswered` below `chainsTotal` means
the total is a real figure for PART of him, and a consumer can decide whether to
draw it. Null on a single-chain series, where the question does not apply.
       

## D026

**`api/routes/aum.ts`** — ===================== THE SEAM BETWEEN TWO KINDS OF POINT ===================== Section 9

===================== THE SEAM BETWEEN TWO KINDS OF POINT =====================

Section 9 already says a sampled figure and a rebuilt one count different things, and
refuses to borrow across that seam. The series itself was not held to the same rule: two
neighbouring points could be valued over different sets of chains, and the difference was
printed as a move in the balance. `fhn_gt` read $65,367.54, then $33.26, then $52,276.29,
and a card said "+155,855.5% in 7 days". He did not lose 99.9% of his money -- the second
point answered for robinhood alone, having dropped the ethereum leg the first one had.

The consumer asked for three things, best first. What each one costs, measured over the
last week across all 435 traders (1,418 consecutive valued steps, 865 of which move the
line by half or more):

  1. "Value both kinds the same way." NOT POSSIBLE from what is stored, and the reason is
     specific rather than a shrug. Per chain, a rebuilt point prices 39% of the positions
     on average and a sampled one 77-84%; the cliffs concentrate exactly on the steps that
     cross between them (60% of sampled-after-rebuilt steps, 74% of rebuilt-after-sampled,
     against 14% of sampled-after-sampled). Equalising that needs the per-token history the
     rebuild did not keep -- only the per-chain totals were stored. Valuing every point
     over the chains they all share was tried and measured: it removes the chain-set
     cliffs and leaves the coverage ones, 548 of 1,074 steps still moving by half or more.
     A column called "comparable" that is wrong half the time is the failure this API is
     organised against, so it is not published.

  2. "Mark every change of method." Done, and WIDENED, because as asked it would have
     missed a quarter of them: 542 of the 865 big moves change `basis`, but 226 more keep
     the same method and change the set of chains -- both of `fhn_gt`'s first two steps
     among them. Marking either catches 768 of 865.

  3. "Failing both, don't call it drawable." Not needed, and not done: `drawable` stays
     the service's answer about whether a line exists, which is a different question, and
     85% of rebuilt points are partial -- refusing all of them would delete the history
     rather than describe it.
   

## D027

**`api/routes/aum.ts`** — A THIRD REASON, AND IT IS THE COMMONEST ONE.

A THIRD REASON, AND IT IS THE COMMONEST ONE.

Method and chain set were the two I marked, and I tested a priced-share rule once, on the
WEEK window at a ten-point threshold, found it bought 21 catches for 25 extra marks, and
dropped it. That was the wrong window and the wrong threshold. On the MONTH window 1,261
of 2,768 jumps of half or more carry no break at all -- 46% -- and on those jumps the
lower point prices a median 1.5% of the trader's value. One measured example: a line went
$358,325 -> $1,132,934 drawn from 3 of 2,477 priced holdings, same chains, same method.

That is not a move in the balance, it is a move in how much of the wallet we could see.
So a material change in priced share is a break, on the same footing as the other two.

The threshold is a RATIO, not a difference in points: 63% against 60% is the same picture
twice, while 1.5% against 60% is two different pictures. A doubling either way is the
line at which the smaller reading is no longer measuring the same trader.
   

## D028

**`api/routes/aum.ts`** — `now` IS THE MOST COMPLETE RECENT READING, NOT SIMPLY THE NEWEST.

`now` IS THE MOST COMPLETE RECENT READING, NOT SIMPLY THE NEWEST.

It used to be the last row by time, and that published a number three times too small.
When the sampler fell behind, the newest row became a REBUILT point covering 1 of a
trader's 5 chains, and unipcs was reported at $5.1M -- eight hours after a measured
reading of $15.7M, against a portfolio route saying $15.8M. The figure people read first
was a fifth of him, presented as all of him.

So completeness wins over recency: the newest reading that answered for every chain he is
known to be on, falling back to the newest that answered for the most of them, and only
then to the newest row at all. Recency still breaks ties, so a fresh full reading always
beats a stale one.
   

## D029

**`api/routes/aum.ts`** — RECENT FIRST, THEN COMPLETE.

RECENT FIRST, THEN COMPLETE. Completeness alone is not enough -- ranking purely on it
picked a five-day-old rebuild covering 5 of 5 chains over a measured reading taken that
morning covering 4 of 5, which is a different way of publishing the wrong number.

So only readings close to the freshest one compete, using the same 36-hour allowance
the sampler is judged by. Among those: widest coverage wins, a measured reading beats an
inferred one at equal coverage, and recency settles the rest.
     

## D030

**`api/routes/aum.ts`** — ANCHOR POINTS ARE EXCLUDED FROM `coveredDays`, because they were not asked for.

ANCHOR POINTS ARE EXCLUDED FROM `coveredDays`, because they were not asked for.

A 1d window keeps one real reading from just BEFORE the window so a single-point chart
has something to compare against (see the anchor block above), and marks it
`outsideWindow: true`. Counting it made `coveredDays: 2` against `requestedDays: 1` on
431 of 448 one-day answers -- a consumer testing the documented
`coveredDays <= requestedDays` relation failed on 96% of them.

The anchor is still SERVED and still flagged; it is simply not counted as coverage of a
window it sits outside. `reach.anchorPoints` says how many were borrowed, so the
difference between what is drawn and what was requested stays visible.
   

## D031

**`api/routes/aum.ts`** — DOES THE DATA REACH BACK TO WHAT WAS ASKED FOR -- measured as a gap, not a day count.

DOES THE DATA REACH BACK TO WHAT WAS ASKED FOR -- measured as a gap, not a day count.

The first version compared coveredDays against requestedDays, which is off by one bucket
by construction: thirty daily points span twenty-nine days of difference, so a complete
month always reported 29 of 30 and `complete: false`. pointfarmcap had all thirty days
present and valued and still failed the PRD's own acceptance test.

What actually matters is whether the oldest point we hold sits at or before the start of
the requested window, allowing one step of slack -- a daily series cannot be expected to
land exactly on a boundary computed to the millisecond.
   

## D032

**`api/routes/aum.ts`** — The slack is the DATA's granularity, not the requested step.

The slack is the DATA's granularity, not the requested step. Rebuilt history is daily, so
a week asked for at six-hour steps would judge a complete daily series "short" purely
because its oldest point sits a day inside a boundary computed to the millisecond. That
is a category error, not a coverage gap -- pointfarmcap held all thirty days and was
reported short on the 1w window. So the tolerance is the larger of the requested step and
the median spacing of the points we actually hold.
   

## D033

**`api/routes/aum.ts`** — TWO DATED FIGURES ARE A LINE.

TWO DATED FIGURES ARE A LINE. One never is.

This threshold was three, taken from the compatibility rule in
GENIE_FOMO_V7_BATCH_AUM_AND_COVERAGE_PRD.md -- but that rule is what the CONSUMER applies
when we decline to say anything, not what we should demand of ourselves. Their own
measurement states the rule they actually draw by: "two or more real points, which is the
owner's rule (one point is never a line)". Holding out for a third made a real two-point
series undrawable and put our flag out of step with the figures we report.
   

## D034

**`api/routes/aum.ts`** — A ZERO THAT NOTHING ANSWERED FOR IS NOT A ZERO.

A ZERO THAT NOTHING ANSWERED FOR IS NOT A ZERO.

Section 9 says a trader whose wallets all answered and held nothing reads `0`, and that
zero is a measurement. The rule was right and the CHECK was missing: nothing verified
that a wallet had answered. 72 of 432 ready traders returned exactly $0 with no chain
count, no priced share and no positions, and 71 of them were still marked drawable -- so
a consumer following the flag drew a flat $0 line for a trader whose wallets are on known
chains and hold real coins.

An empty read is a refusal. It is told apart from a real zero by the coverage beside it:
a measured zero answered for at least one chain or looked at at least one position.
   

## D035

**`api/routes/aum.ts`** — TWO WAYS TO HAVE NOTHING, and both must stop `ready`.

TWO WAYS TO HAVE NOTHING, and both must stop `ready`.

  a zero nothing answered for  -- total 0, no chains, no positions   (72 traders)
  no figure at all             -- every reading refused               (seen live)

The second was reported as `ready` even after the first was fixed, because a refused row
is still a row and the fallback picked it up.
   

## D036

**`api/routes/aum.ts`** — EACH GAP CARRIES THE SPAN IT COVERS, not just the moment it sits at.

EACH GAP CARRIES THE SPAN IT COVERS, not just the moment it sits at.

`at` alone says where the hole is; `from`/`to` say how wide. A consumer drawing a broken
line needs the width -- it is the difference between a dot and a segment -- and the
consumer's own field contract asks for all three: "Each carries at, from, to, reason."

The span is the bucket this point occupies: from its own moment to the next point's, or
to the end of the window when it is the last. Consecutive refusals therefore describe a
continuous hole rather than a row of unconnected dots.
   

## D037

**`api/routes/aum.ts`** — A REFUSED ANCHOR IS NOT A GAP IN THIS WINDOW.

A REFUSED ANCHOR IS NOT A GAP IN THIS WINDOW.

The anchor is a reading borrowed from BEFORE the window so a short chart has a
baseline; it is served and flagged `outsideWindow`. When it happens to be refused it
was also landing in `gaps[]`, dated before `from` — and a consumer walking gaps to
draw holes inside the window got one outside it, which is both wrong and a violation
of the stated `every gap falls inside from..to`. Four answers did this.

The point itself still carries its `refused` word, so nothing is hidden; it simply is
not described as a hole in a window it was never part of.
       

## D038

**`api/routes/aum.ts`** — TOTAL CHAINS COMES FROM THE SAME UNION `knownChains` DOES, not from what is held today.

TOTAL CHAINS COMES FROM THE SAME UNION `knownChains` DOES, not from what is held today.

`presence` counts `holdings_current where human_amount > 0` -- chains the trader holds
something on RIGHT NOW. `answeredNets` below counts chains that produced a reading. A
trader who has sold out of a chain still has readings there, so answered exceeded total
for twelve traders: RunningClam reported 5 of 4, gundam 4 of 3, 0xkuidian 3 of 2. A
coverage ratio above 1 is not a coverage ratio.

`opts.knownChains` is already built from the union of wallet_chain_presence,
holdings_current and aum_chain_samples, and is already carried on this envelope, so this
costs no query. Falls back to the old count when it was not fetched.
   

## D039

**`api/routes/aum.ts`** — TOTAL WALLETS FROM THE SAME UNION AS THE CHAINS, for the reason `totalChains` above moved.

TOTAL WALLETS FROM THE SAME UNION AS THE CHAINS, for the reason `totalChains` above moved.

`presence` counts wallet families the trader holds something on RIGHT NOW. `answeredNets`
counts families that produced a reading, and a trader who has sold out of a family still
has readings there — so answered exceeded total for gmgn_0xc91063fd on all four windows,
which is a coverage ratio above 1 and therefore not a coverage ratio.

`knownChains` already unions presence, holdings and chain samples, so the families it
names are the honest denominator. Falls back to the old count when it was not fetched.
   

## D040

**`api/routes/aum.ts`** — IS THE NEWEST READING SHORT OF A CHAIN -- asked of the ENVELOPE when the reading cannot sa

IS THE NEWEST READING SHORT OF A CHAIN -- asked of the ENVELOPE when the reading cannot say.

`partial` used to be computed from the reading's own `chains_answered` / `chains_expected`
alone. Those are frequently null, and when they are, only the pricing share is left -- so
an answer missing a whole chain reported `partial: false`. 268 answers did exactly that.
ethersole: `coverage` said 3 chains of 4 and 1 wallet of 2, while `now.partial` said false
and `status` said ready. Two blocks of one answer disagreeing about whether it is complete.

The envelope's own counts are computed just above and know better, so they are the
fallback. The reading's own numbers still win when it has them -- they describe that
reading, where the envelope describes the trader.
   

## D041

**`api/routes/aum.ts`** — EITHER MEASURE SAYING "SHORT" MAKES IT SHORT, and it has to be an OR rather than a prefere

EITHER MEASURE SAYING "SHORT" MAKES IT SHORT, and it has to be an OR rather than a
preference for the reading's own numbers.

The two count different things. A reading's `chains_expected` is what that read went and
ASKED -- the sampler only reaches an EVM chain the trader has traded tokens on. The
envelope's `totalChains` is every chain he is KNOWN to use, from the wider union. For
`enci` those are 4 and 5: his reading answered everything it asked and still covered
four fifths of him, so trusting the reading alone published `partial: false` beside a
`coverage` block that plainly said 4 of 5. Four answers did exactly that.

Neither number is wrong; they answer different questions. The honest combination is the
pessimistic one -- complete means complete by both.
     

## D042

**`api/routes/aum.ts`** — SAMPLER STATE, NAMED RATHER THAN IMPLIED.

SAMPLER STATE, NAMED RATHER THAN IMPLIED.

The sampler runs daily, so a reading inside 36 hours is on schedule -- one run plus a
fully missed one, the same allowance the staleness check uses. Past that the readings are
still true, they are simply old, and the answer has to say so instead of reporting
`ready` over three-day-old figures.

`lastAttemptAt` is null on purpose: we record successes, not attempts, and inventing a
value would be worse than admitting the gap.
   

## D043

**`api/routes/aum.ts`** — THE STATE IS THIS TRADER'S, NOT THE PIPELINE'S.

THE STATE IS THIS TRADER'S, NOT THE PIPELINE'S.

This was computed from the newest successful run anywhere in the table -- so on a night
the sampler ran for most of the directory, a trader whose OWN newest reading was 6.8 days
old still answered `current`, and `status` still said `ready`. Fourteen traders were
measured in exactly that state, and a consumer trusting `status` drew a week-old figure
as today's.

A trader is asking about himself. The age that matters is the age of the reading he is
about to be shown, so that is what decides the verdict. The pipeline's own last run is
still reported, under a name that says what it is, because "my reading is old" and "the
job has stopped" are different problems with different fixes.
   

## D044

**`api/routes/aum.ts`** — The age of the FIGURE, not of the newest row.

The age of the FIGURE, not of the newest row.

When every reading a trader has is refused, `newest` falls back to the newest row so its
reason can be reported -- but that row carries no number. Ageing it said "this trader's
reading is 25 hours old" about a reading that does not exist, and `status` answered
`ready`. A reading with no figure has no age.
   

## D045

**`api/routes/aum.ts`** — TRUE WHEN `step` UNDERSTATES THE REAL SPACING, AND IT CANNOT SAY SO ANY OTHER WAY.

TRUE WHEN `step` UNDERSTATES THE REAL SPACING, AND IT CANNOT SAY SO ANY OTHER WAY.

`step` is an enum of `1h`, `6h`, `1d` — a consumer switches on it, so it stays an enum.
But a one-day window over readings three and a half days apart has no honest value in
that set: `1d` is the coarsest name available and it still overstates how close the
points are. Rather than quietly return the wrong one, the answer says the label is a
floor and `observedStepMs` carries the truth.
     

## D046

**`api/routes/aum.ts`** — ON `now` ITSELF, not only inside `coverage`.

ON `now` ITSELF, not only inside `coverage`.

The contract names `now.chainsAnswered` and `now.chainsTotal`, and a consumer
reading the balance reads `now` -- asking it to descend into `coverage` to find out
whether the figure it just printed covers the whole trader is how a partial total
gets published as a whole one. Both spellings carry the same value.
         

## D047

**`api/routes/aum.ts`** — EVERY CHAIN THIS TRADER USES, and it does not change with the window.

EVERY CHAIN THIS TRADER USES, and it does not change with the window.

`chains` below is the split of the newest reading; this is the trader. They answer
different questions and both are needed: draw the chain switches from this one, and
read `chains` for what the latest reading actually covered. `coverage` and each point's
`chainsAnswered` / `chainsTotal` are untouched.
     

## D048

**`api/routes/aum.ts`** — HOW MUCH OF THE ASKED-FOR WINDOW IS ACTUALLY BEHIND THIS ANSWER, always.

HOW MUCH OF THE ASKED-FOR WINDOW IS ACTUALLY BEHIND THIS ANSWER, always.

This used to be populated only while `warming`, so every settled answer served null --
and `window=all` therefore said nothing at all about what "all" meant. Measured: the ten
longest records run 1,131 to 1,685 days and `window=all` covers 35 or 36 of them, which
is the full extent of the stored readings rather than any statement about the trader.

It is not a backfill that is missing. Balance history is rebuilt from stored
transactions, and for those ten traders the earliest transaction held is 5-11 September
-- there is nothing behind that date to rebuild from. So the honest answer is not a
promise that more is coming; it is to say what bounds the series and stop implying the
window covers a career.

`boundedBy` is the load-bearing field: `window` means the answer covers what was asked,
`history` means the stored readings ran out first.
     

## D049

**`api/routes/aum.ts`** — WHY TWO NEIGHBOURING FIGURES MAY NOT BE SUBTRACTABLE, stated once for the series.

WHY TWO NEIGHBOURING FIGURES MAY NOT BE SUBTRACTABLE, stated once for the series.

`equalised: false` is the honest answer to "value both kinds the same way": a rebuilt
point and a sampled one price different fractions of the same wallet, and the per-token
history that would let us equalise them was never stored -- only per-chain totals were.
So the seam is MARKED rather than removed, and `breaks` below is where it is marked.
     

## D050

**`api/routes/aum.ts`** — EVERY SEAM, shaped like `gaps` because that is the list a chart already breaks on.

EVERY SEAM, shaped like `gaps` because that is the list a chart already breaks on.

A step appears here when the two figures do not count the same thing: the method
changed (`method_changed`), the set of answered chains changed (`chains_changed`), or
both. `chainsAdded` / `chainsRemoved` name which chains moved, so the step is
explicable rather than mysterious.

`chains_changed` is the one a method marker alone would miss, and it is not rare:
measured over the last week across the whole directory, 226 of the 865 steps that move
a line by half or more keep the same method and change only the chain set.
     

## D051

**`api/routes/aum.ts`** — AUM envelopes for MANY traders in a fixed number of queries.

AUM envelopes for MANY traders in a fixed number of queries.

WHY SET-BASED AND NOT A LOOP. The individual route answers in about 3.1 seconds, so fifty
of them in sequence is roughly 158 -- an order of magnitude past the 15-second route
budget. That is the reason the batch route used to return a five-field summary instead of
the real envelope, and why Genie could not read the service's own drawing verdict. Four
queries answer fifty traders as readily as one.

The per-trader arithmetic stays in buildAum(), which does no I/O, so the batch row and the
individual response are the same object built by the same code rather than two shapes kept
in sync by hand.
 

## D052

**`api/routes/aum.ts`** — THE CHAIN SPLIT OF EVERY POINT, not only the newest -- because the seam that breaks a char

THE CHAIN SPLIT OF EVERY POINT, not only the newest -- because the seam that breaks a
chart is a change in WHICH CHAINS a point could answer for, and nothing above can see it.

unipcs measured 15.1M (5 chains, rebuilt), then 5.4M (4 chains, rebuilt, robinhood
missing), then 15.7M (3 chains, sampled). The middle step is a 64% fall that never
happened: the same trader, one chain short. Both points are rebuilt, so marking changes
of METHOD -- which is what the consumer asked for -- would not have caught it. Measured
over the last week across all 435 traders: 865 steps move the line by half or more, 542
change method, and 226 change only the chain set. A method marker alone misses a quarter
of them.

Costed before adding: 5,979 rows for fifty traders in 188 ms against a table of 37,062.
Cheap enough to fetch outright rather than approximate.
   

## D053

**`api/routes/aum.ts`** — READ-THROUGH REFRESH: when the stored reading is old, go and get a new one.

READ-THROUGH REFRESH: when the stored reading is old, go and get a new one.

Until now this route served whatever the sampler last wrote and nothing else, so a trader
nobody had sampled for a day answered with yesterday's money however many times you asked.
The `aum-sample` function can read his wallets in about eight seconds; the only reason not
to do it on every request is cost -- a popular trader viewed a hundred times would be a
hundred chain sweeps for one number.

So it is a FLOOR, not a cache bypass. Older than `AUM_LIVE_AFTER_MINUTES` and the request
pays for a fresh read; newer and it serves what is already there. At five minutes that is
live for anyone watching and roughly free for everyone else, because the hundred viewers in
that window share one fetch.

WHAT THIS COSTS, said plainly: this route can now make an external call, which no route
here could before. `/health` reports it under `externalCallsPerRequest` rather than leaving
the old claim standing -- that field was true of every route and must not quietly stop being
true of this one.

Bounded three ways, because a slow chain must never become a slow API:
  - only the single-trader route, never the batch. Fifty traders is fifty sweeps.
  - `AUM_LIVE_WAIT_MS` caps the wait. Past it the request serves the stored reading and
    lets the sample finish in the background, so the NEXT caller gets it.
  - one in-flight fetch per trader per instance; concurrent callers wait on the same one.

`?live=false` opts out entirely and `?live=true` forces a read regardless of age.
 

## D054

**`api/routes/aum.ts`** — SHORT ON PURPOSE.

SHORT ON PURPOSE. The route's own budget is 15s and its query work is 4-6s, so a nine
second wait measured 14.0s end to end -- inside the limit and far too close to it. A big
trader takes about eight seconds to sample and was never going to finish inside the wait
anyway; a small one finishes in one or two. So the wait is sized for the traders it can
actually catch, and everyone else is served the stored reading with `still_running` and
gets the fresh one on their next call a moment later.
 

## D055

**`api/routes/aum.ts`** — AGE IS MEASURED FROM `sampled_at`, NOT `at`, and the difference is the whole feature.

AGE IS MEASURED FROM `sampled_at`, NOT `at`, and the difference is the whole feature.

`at` is the HOUR the reading describes -- truncated, so a sample taken at 06:44 is
stamped 06:00 and reads as forty-four minutes old the moment it is written. Checking
that against a five minute floor meant every request re-fetched a reading taken
seconds earlier, which is not a freshness floor at all, just a slow route. Measured
exactly that way before this line was fixed: `ageSeconds 2651` on a sample a minute old.

`sampled_at` is when we actually read the chain, which is the only thing "how fresh is
this" can honestly mean.
     

## D056

**`api/routes/aum.ts`** — WHAT THIS REQUEST DID ABOUT FRESHNESS, so `now.ageSeconds` can be read in context.

WHAT THIS REQUEST DID ABOUT FRESHNESS, so `now.ageSeconds` can be read in context.

`fetched` — a live read finished and `now` is from it.
`still_running` — one was started and outlasted our wait; this answer is the previous
  reading and the next request will have the new one.
`not_needed` — the stored reading is inside the freshness floor.
`skipped` — the caller passed `live=false`.
`unavailable` — no live read is configured on this deployment.
     

## D057

**`api/routes/aum.ts`** — AUM for many traders in one call.

AUM for many traders in one call.

TWO CONTRACTS, CHOSEN BY THE CALLER. `contractVersion: 2` returns the identity-safe
envelope: one row per requested id, carrying the value submitted, the canonical id, and
the COMPLETE AUM object -- byte-identical to what `GET /v1/traders/:id/aum` returns for
the same trader and window, because both are built by the same function from the same
rows. Without that field the older projection is returned unchanged, so a consumer already
reading it keeps working until it migrates.

The older shape identifies rows by display handle alone, which cannot survive a rename or
a folded-handle collision, and it drops the service's own `drawing` verdict -- leaving a
consumer to guess whether a short series is a warming backfill or a real refusal. That is
why version 2 exists; see GENIE_FOMO_V7_BATCH_AUM_AND_COVERAGE_PRD.md.
 

## D058

**`api/routes/aum.ts`** — THE FULL ENVELOPE IS THE DEFAULT here too, for the reason above and one measurement: witho

THE FULL ENVELOPE IS THE DEFAULT here too, for the reason above and one measurement:
without it this route answers a handle, a count, a newest figure and the points, and
nothing else -- no chains, no reach, no status, no drawable decision. Every consumer's
bulk pass uses this route, so that shape became the stored copy of the world.

`contractVersion: 1` still returns the old projection, unchanged, for anyone parsing it.
   

## D059

**`api/routes/aum.ts`** — THE IDS WE COULD NOT ANSWER FOR, gathered under the name the consumer looks for.

THE IDS WE COULD NOT ANSWER FOR, gathered under the name the consumer looks for.

Every asked id has always appeared in `traders[]` -- a failure as an `ok: false` row
carrying its own error, which is what stops a dropped row looking like a trader with
no data. But their contract reads `unreadableRows[]`, and a consumer checking that key
found nothing and concluded every id had answered.

Same rows, listed twice on purpose: `traders[]` keeps one entry per requested id in
the order asked, and this is the subset that failed. Empty is the healthy state.
       

## D060

**`api/routes/chains.ts`** — C3 — realized profit per chain.

C3 — realized profit per chain.

Previously marked unavailable because the source gives one `pnl` per trader and
splitting it would mean inventing an attribution. That is still true of the LEADERBOARD
figure — but per-trade records carry their own chain, so this attributes nothing: it
sums realized P&L over trades that already know where they happened.

`unattributed` is published rather than folded in. 26 closed trades still have no chain,
and a breakdown that silently absorbed them would misstate every row.
   

## D061

**`api/routes/chains.ts`** — THE CHAIN VOCABULARY IS CLOSED, AND SAYS SO.

THE CHAIN VOCABULARY IS CLOSED, AND SAYS SO.

Chain words are this service's own -- a consumer takes them off this block and asks
with them verbatim, because a word they invented is a read spent on nothing. That only
works if the set is known to be complete: today there are five words, each with exactly
one network id and no collisions, but nothing said whether a sixth was a new chain or a
typo. `closed: true` means this list is the whole set; `vocabularyVersion` changes when
a word is added or retired, so a diff is a release note rather than a surprise.

A word is never renamed in place. A rename is a retirement and an addition.
     

## D062

**`api/routes/fields.ts`** — WHAT EVERY FIELD MEANS, WHAT IT CAN SAY, AND HOW OFTEN IT SAYS ANYTHING.

WHAT EVERY FIELD MEANS, WHAT IT CAN SAY, AND HOW OFTEN IT SAYS ANYTHING.

Three questions a consumer has had to answer by observation, one refusal and one empty
screen at a time:

  1. Which words can this field hold?  Every enumerated value was discovered the hard way --
     `chains_unrebuildable`, `too_little_priced`, `no_chains_answered` each arrived as an
     unexplained blank on somebody's screen first. Four more break reasons appeared between
     one report and the next. A word nobody published is a word with no sentence behind it.
  2. What unit is this in?  A unit change under a stable name is undetectable and
     catastrophic: every figure stays plausible and every one is wrong by a thousand.
  3. Is this field actually populated?  Every screen built on a field that turned out to be
     mostly empty was built because a spot check of two or three traders showed it filled.
     An entry-size figure good enough to rank on existed for 11 of 144 traders, and that was
     discovered after shipping.

The fill rates are counted live over the whole directory, not sampled -- 227ms measured, so
it costs about what /health does.
 

## D063

**`api/routes/health.ts`** — Exact counts everywhere except `transactions`, which is an estimate and says so.

Exact counts everywhere except `transactions`, which is an estimate and says so.

count(*) over transactions is a sequential scan. At 666,895 rows it measured 23.8s and
hit the 2min statement timeout once -- on the endpoint whose entire job is to answer
quickly whether the service is alive. The planner's own row estimate answers the same
question in microseconds.

It is reported under `transactions` as before so no consumer breaks, and listed in
`estimatedRows` so nobody mistakes it for a counted figure. An approximate number that
admits it is approximate is honest; one that does not is the failure this API is
organised against.
   

## D064

**`api/routes/health.ts`** — FOUR SEQUENTIAL AWAITS, DELIBERATELY.

FOUR SEQUENTIAL AWAITS, DELIBERATELY.

Each is a round trip and the queries themselves measure about 150 ms, so running them
together looked like free latency. It was not: batched into one Promise.all against a
pool of 2, this endpoint stopped answering entirely -- 90 seconds, the route timeout,
with every underlying query still returning in 150 ms when run by hand.

The cause was not worth chasing on a liveness endpoint. Sequential is 2.4 seconds and
works. If this is made concurrent again, test /health specifically after deploying:
every other route kept working while this one hung, so a smoke test that skips it passes.
   

## D065

**`api/routes/health.ts`** — Freshness per feed, so "the service is degraded" is distinguishable from "there is nothing

Freshness per feed, so "the service is degraded" is distinguishable from "there is
nothing". A consumer comparing a stale figure against a fresh one has no way to know
which feed lagged unless the service says so.

Each row is the newest measurement time for that feed and how many rows stand behind
it. `null` means the feed has never run, which is a different statement from zero.
   

## D066

**`api/routes/health.ts`** — HOW MANY TRADERS ARE THEMSELVES STALE.

HOW MANY TRADERS ARE THEMSELVES STALE.

Every feed above can read `current` while individual traders carry week-old figures: a
feed's clock is the job's last write, and a job that runs without reaching a trader
leaves that trader behind without moving any feed. Fourteen traders were sitting on
readings four to seven days old while every feed said `current`, and the only way to find
them was to check traders one at a time.

So the count is published. It is the number either team would look at to notice the
reload has stopped landing, and it measures 168 ms.
   

## D067

**`api/routes/health.ts`** — EVERY FEED SAYS WHETHER IT IS STILL ARRIVING, NOT ONLY WHEN IT LAST DID.

EVERY FEED SAYS WHETHER IT IS STILL ARRIVING, NOT ONLY WHEN IT LAST DID.

`lastRefreshAt` was already here and a consumer could in principle subtract it from the
clock -- but nobody did, and the balance readings sat 75 hours old while every answer
said `ready`. A date is not a verdict. Each feed now carries its own allowance and the
verdict that follows from it, so one call to /health shows which feed stopped.

The allowances are the schedules themselves plus one missed run: the daily jobs get 36
hours, the trade loader 72 because it is the expensive one and skips runs by design.
`state` is `current`, `stale`, or `never` -- and `never` is not `stale`, because a feed
that has not run once has a different cause and a different fix.
   

## D068

**`api/routes/health.ts`** — Per-feed freshness AND a verdict on it.

Per-feed freshness AND a verdict on it. A stale feed is visible here before it misleads
a screen.

`traders` is the directory build, which is what the directory's own `capturedAt`
reports. It used to be filled from the trade loader's clock -- two different jobs under
one name, so a five-day-old trade load read as a five-day-old directory and the loader
itself had no entry at all. `trades` is now its own feed.

`aum.lastRefreshAt` is the newest reading's own timestamp; `lastSuccessAt` is when the
sampler last wrote one. They differ, and the second is the one that says the job ran.
     

## D069

**`api/routes/health.ts`** — HOW MANY EXTERNAL CALLS A REQUEST CAN COST — no longer flatly zero.

HOW MANY EXTERNAL CALLS A REQUEST CAN COST — no longer flatly zero.

It was 0, and the claim was load-bearing: every route answered from Postgres, so a
thousand visitors cost what one does. `/traders/:handle/aum` now breaks that on purpose
— when its stored reading is past the freshness floor it fetches a live one, which is
one call to the sampler and, behind that, a sweep of the trader's wallets.

Reported as a range rather than left at 0. A field that quietly stops being true is the
exact failure this service is organised against, and it is worth recording that this
very field was accidentally DELETED from this response earlier today by the edit that
rewrote `capabilities` below — removed from a live deployment with nothing announcing
it, which is the fault F9 exists to catch.
     

## D070

**`api/routes/health.ts`** — WHICH CAPABILITIES ARE STILL DELIVERING, by name, judged on evidence.

WHICH CAPABILITIES ARE STILL DELIVERING, by name, judged on evidence.

A consumer checks health once and routes thousands of times, so a capability that only
reveals itself on the thousandth call is one every consumer discovers the expensive way.

THE FIRST VERSION OF THIS BLOCK WAS WRONG, and deploying it is what showed that. It
reported whether each provider's KEY was set in this process, which read correctly on a
laptop -- where .env is loaded -- and reported all five providers degraded on the
deployed function, where none of those keys exists. They are not supposed to: the keys
belong to the scheduled loaders, which run in GitHub Actions and never inside this
function. `externalCallsPerRequest` is 0 precisely because of that. So key presence here
is evidence of nothing, and publishing it as `degraded` was a permanent false alarm on
exactly the field a consumer would page on.

What CAN be answered from here is the question that actually matters: is this
capability's data still arriving? Every provider is judged by the feeds it fills.
A capability whose feeds have all gone stale is degraded whatever its key says, and one
whose feeds are current is working whatever this process can see.
     

## D071

**`api/routes/positions.ts`** — The same dollars said in the chain's own coin, which is how a wallet says them.

The same dollars said in the chain's own coin, which is how a wallet says them.

`nativeAmount` is `valueUsd / nativeUsd` and nothing more, so the two always agree;
`nativeUsd` and `nativePriceSource` travel with it so the division can be rechecked
and so a consumer can see WHERE the rate came from.

Null, never 0, when we hold no market price for that coin — see `whyNoNative`. A
portfolio converted at a price nobody can stand behind is a worse answer than none.
       

## D072

**`api/routes/positions.ts`** — T1.1.

T1.1. When a wallet first received a token, last sent it, and last did anything.

READ, NOT COMPUTED. This used to aggregate the wallet's whole transaction history on every
request. For our busiest wallet that is 66,773 rows and about 9 seconds of CPU -- per view
-- which put GET /traders/:id/positions past its 15-second budget and returned 503 to the
traders people most want to look at. A covering index cut the disk reads a hundredfold and
left the CPU cost untouched, because the work was the wrong shape rather than merely slow.

These values change only when new transactions arrive, so the nightly loader derives them
once into position_timing and the route reads them by index. See
scripts/refresh_position_timing.mjs.

Both of a trader's wallets go in one `any()` rather than a query each, so a trader costs
one round-trip regardless of how many chains they use.
 

## D073

**`api/routes/positions.ts`** — The floor under every timestamp on this page, derived in memory from `timing`.

The floor under every timestamp on this page, derived in memory from `timing`.

This was `select min(block_time) from transactions`. `block_time` leads no index, so that
planned as a Parallel Seq Scan over 384k rows — 7.9s measured — on every request, to
produce one constant. The earliest row we hold for THIS trader answers the same question
for this response and costs nothing, since the rows are already here.
   

## D074

**`api/routes/positions.ts`** — PAGED, AND HONEST ABOUT IT.

PAGED, AND HONEST ABOUT IT. This route used to return the first `limit` rows with nothing
saying more existed -- so 50 of unipcs' 521 positions looked exactly like his whole
portfolio, and a `cursor` parameter was accepted and silently ignored. The PRD forbids
precisely that: "Paged or capped assets are visibly incomplete and never presented as the
entire portfolio."

The cursor names the last row returned, not an offset, so inserting or removing a
position between pages cannot skip or repeat one. Identity is (chain, token address) --
never the symbol, which is display metadata two different coins can share.
   

## D075

**`api/routes/positions.ts`** — T1.1.

T1.1. The boundary every `startHoldingAt` on this page has to be read against.

We began ingesting transactions on this date; trades on record predate it. A position
whose `startHoldingAt` equals this timestamp was very likely opened EARLIER and simply
first observed here — which is a different statement from "opened here", and only the
caller can tell which matters to them.
     

## D076

**`api/routes/positions.ts`** — Positions for many traders in one call.

Positions for many traders in one call.

POST rather than GET because fifty ids do not belong in a query string: a 2 KB URL breaks
proxies and fills logs. Nothing here mutates -- it is a read that needs a body.

TWO CONTRACTS, CHOSEN BY THE CALLER, for the same reason as batch AUM. `contractVersion: 2`
names every row by the value submitted and the canonical id, states explicitly whether each
one succeeded, and reports the counts and completeness
GENIE_FOMO_V7_BATCH_AUM_TDR.md §3 asks for. Without that field the older shape is returned
unchanged.

DELIBERATELY NOT INCLUDED: the holding/activity times the individual route returns. Those
come from an aggregate over `transactions` that costs 12.5 seconds for our busiest trader,
measured; running it fifty times would take the call far past any sane budget. A consumer
that needs them reads the individual route for the trader it is showing, which is the one
place the cost is worth paying.
 

## D077

**`api/routes/positions.ts`** — THE FULL ENVELOPE IS THE DEFAULT.

THE FULL ENVELOPE IS THE DEFAULT. `contractVersion: 1` opts back into the short shape.

The short projection omits the per-row `ok` / `requested` / `id` and the explicit
not-found refusal, so an id that could not be resolved is indistinguishable from a trader
with no data. A consumer's bulk pass is the one place that shape does the most damage --
measured on the sibling route, 435 of 435 warmed traders were stored chainless, while the
same trader spot-checked one at a time carried five chains. Defaulting to the complete
answer means a caller has to ASK for the lossy one rather than discover it.
   

## D078

**`api/routes/scorecard.ts`** — T2.2.

T2.2. Profit derived from the chain, independent of fomo.

Every other money figure on this API is fomo's, which is exactly what `/trust` exists to
test. This one is ours: both sides of each swap resolved from Helius RPC pre/post balances,
so a buy and its matching sell reconcile on quantity.

It is deliberately narrow. `transactions.tx_type` is the TRANSACTION's type, not the
wallet's action — measured on 60 random rows tagged SWAP, the wallet was not even among the
transaction's accounts in 57. Only the two-sided remainder is a trade the wallet made, and
only those are counted here. Coverage says how few that is rather than hiding it.
 

## D079

**`api/routes/scorecard.ts`** — Positions the wallet opened AND fully closed on chain — where the token quantity nets to a

Positions the wallet opened AND fully closed on chain — where the token quantity nets to
approximately zero, so the dollars in and out are a complete round trip.

This is the only subset where "realised profit" is literally true. A position still open
has spent dollars and no proceeds; counting it would report every holder as loss-making.
The 1e-6 tolerance absorbs the rounding in a UI-unit balance, not a real residual.
 

## D080

**`api/routes/tokens.ts`** — T1.5.

T1.5. Board sorting and value filters.

`value` uses the same coalesce-to-0 the ordering already used, so an unpriced token sorts
and filters as 0 here rather than dropping out. That is a filtering convenience and NOT a
claim it is worth nothing — `totalValueUsd` in the response stays `null` for those rows,
which is the figure a consumer actually reads.
   

## D081

**`api/routes/tokens.ts`** — T3a.

T3a. `?excludeHoneypots=true` drops tokens GMGN flags as unsellable.

Opt-in rather than the default: silently removing rows would misstate the board — a
consumer counting the tokens their leaders hold would get a different number with no
indication why. It also only removes tokens PROVEN unsellable; a Solana token, where the
check does not run, is never dropped for failing a test that was never applied.
   

## D082

**`api/routes/tokens.ts`** — T3d.

T3d. Chain-wide facts about the token, from GMGN — NOT computed by us.

They describe every holder and every pool; we observe 137 traders and could not
derive any of this from our own rows. It therefore arrives wearing `tier` and
`source`, like every other borrowed figure in this API, so it stays
distinguishable from the numbers we stand behind. That separation is the one thing
we have that GMGN does not, and quietly blending the two would spend it.

`null` when the token has not been fetched yet — the loader covers held tokens and
a newly-held one waits for the next nightly pass.
         

## D083

**`api/routes/tokens.ts`** — What the leaders' holdings would be worth at GMGN's price.

What the leaders' holdings would be worth at GMGN's price.

Separate from `totalValueUsd`, never a replacement for it: that figure is what we
stored, this one is arithmetic on someone else's price. 64.7% of holdings carry no
price of our own, so without this the honest answer for two thirds of the board is
`null` — but a borrowed answer must not be able to pass as our own.
         

## D084

**`api/routes/tokens.ts`** — T3a.

T3a. Can you actually sell it, and who controls the contract?

This closes the one place where our silence was dangerous: the API ranks tokens by
how many tracked leaders hold them and, until now, said nothing about whether the
contract permits selling. A crowd of leaders in a honeypot looked identical to a
crowd in a good token. 14 of the tokens on this board are confirmed honeypots.

**Every field is three-valued and `null` never means safe.** `isHoneypot: null` is
"not assessed on this chain" — always so on Solana, where GMGN does not evaluate it
— and reading that as `false` is exactly the mistake this shape prevents.
`applicableChecks` names what could be judged here, so an absent field is visibly
out of scope rather than silently missing.
         

## D085

**`api/routes/tokens.ts`** — T3b.

T3b. Concentration across EVERY holder on chain, from GMGN.

The counterpart to `leaderConcentration` above, and the reason that one was never
allowed to be called `top_10_holder_rate`: ours is the share among the leaders we
track, this is the share of supply across the whole holder base. On a typical
token they read 0.592 and 0.197. Both are useful; neither substitutes for the
other, and the pair is more informative than either alone.
         

## D086

**`api/routes/tokens.ts`** — T3e.

T3e. How GMGN classifies the token's holders.

Every count is CAPPED AT 1000 and the cap is invisible in the raw figure. Measured
over 1,095 tokens: the distribution runs 0, 1, 2, 3 … then piles up at exactly 1000
— 450 tokens on `fresh`, 271 on `bundler`, 29 on `whale` — with not one token above
it on any tag. A smooth distribution ending in a hard spike at a round number with
nothing beyond is a truncation, not a count, so a tag reading 1000 means "at least
1000" and the response says which tags are in that state rather than leaving a
reader to infer a precise-looking number that is not one.
         

## D087

**`api/routes/tokens.ts`** — The creator's best previous launch — null when there is not one.

The creator's best previous launch — null when there is not one.

GMGN returns the object PRESENT BUT EMPTY for creators with no prior token:
blank symbol, blank address, ath_mc of 0. Passing that through published
`peakMarketCapUsd: 0`, which reads as "their best token peaked at nothing"
rather than "they have no previous token". Emitted only when there is a real
one, and the cap follows the same rule — never 0 for unknown.
             

## D088

**`api/routes/tokens.ts`** — T1.3.

T1.3. Concentration among the leaders WE TRACK — deliberately not named
`top_10_holder_rate`.

GMGN's field of that name is supply across every holder on chain. This one is the
share of value among the handful of tracked traders holding this token. For our
top-ranked token those two read 0.1974 and 0.4234 — same shape, same plausible
magnitude, completely different denominators. Giving ours GMGN's name would make
the two silently interchangeable, and the day both appear in one response the
mistake becomes permanent.

Value is summed PER HANDLE first: a trader holding the same token in two wallets
is one leader, and counting their rows separately would understate concentration.
         

## D089

**`api/routes/tokens.ts`** — Computed from AMOUNTS, not values — and that is not a shortcut, it is exact.

Computed from AMOUNTS, not values — and that is not a shortcut, it is exact.

Every holder here holds the same token at the same price, so in
`sum(top N amount x price) / sum(all amount x price)` the price cancels out
entirely. The ratio is identical either way.

It used to be computed from `value`, which needed a price and therefore returned
`null` for 63% of the board — 689 of 1,095 tokens — for no arithmetic reason at
all. Amounts are on every holding, so this now answers for every token, and it
stays a figure about OUR leaders with nothing borrowed in it.
           

## D090

**`api/routes/tokens.ts`** — ISSUE-4, the K5 half.

ISSUE-4, the K5 half. `entry` was `min(avg_entry_price)` — not the average the field
name promised, and not even the "first value" the doc claimed: the CHEAPEST entry the
trader ever got. The scorecard took the first and this took the minimum, so the two
routes disagreed with each other as well as with their documentation.

Now a quantity-weighted average per trader, using the same `trade_qty()` rule as the
scorecard's `legQty`. Falls back to the earliest value only when no leg carries a
recoverable quantity, and reports how many legs were weighted so the fallback is
visible rather than inferred.
   

## D091

**`api/routes/tokens.ts`** — Two different populations, kept apart on purpose.

Two different populations, kept apart on purpose.

`holdersNow` is who holds it in the current snapshot. `withTradeRecord` is everyone
who has ever traded it — which can be LARGER, because traders who sold out entirely
no longer hold it but very much have a record. The Express route conflated them
under one "sampled" count, which read as nonsense (30 of 12).

`capped` and `failed` are gone: there is no sample and no fan-out to fail.
     

## D092

**`api/routes/tokens.ts`** — One trader, one vote — deliberately NOT weighted by position size.

One trader, one vote — deliberately NOT weighted by position size.

This answers "what did a typical leader pay", which is the question the board is
read for. Weighting by size would answer "what did the crowd's money pay" and be
set almost entirely by the largest holder. ISSUE-4 was that the INPUTS were
first-entries rather than averages; that is what changed here, not the way holders
are combined.
       

## D093

**`api/routes/traders.ts`** — DELISTED TRADERS ARE NOT LISTED, and are still answerable by name.

DELISTED TRADERS ARE NOT LISTED, and are still answerable by name.

Four traders have no wallet and never will: fomoapi has dropped them from every
leaderboard window, and 377 GMGN KOL and smart-money entries matched none of them. A2 is
explicit about them -- "either given one or dropped from the directory; being listed and
unpriceable is the worst of both" -- because a trader on the board with no balance and no
chart is a blank a person cannot interpret.

They are flagged, not deleted. `cmbarce` alone carries 103 holdings and 144 trades, and
the condition reverses the moment the source lists him again. So the board stops showing
them, `/traders/:handle` still answers for them, and `?includeDelisted=true` puts them
back in the listing for anyone reconciling against an older copy.
   

## D094

**`api/routes/traders.ts`** — T1.5.

T1.5. Sorting and range filters.

Every option here is a column we already hold. GMGN exposes ~19 range filters on its
trending board over metrics we do not have at all (`bundler_rate`, `insider_rate`,
`top70_sniper_hold_rate`); this is deliberately the subset we can answer honestly rather
than a claim of parity.
   

## D095

**`api/routes/traders.ts`** — A range filter over a nullable column drops rows where the value is UNKNOWN, not just rows

A range filter over a nullable column drops rows where the value is UNKNOWN, not just
rows that fail the test — 44 of 144 traders have no stats row, so even `minPnl` at
negative infinity returns 100. That is correct SQL and completely invisible to a caller,
who reasonably reads a short list as "few traders qualify" rather than "a third of the
board could not be tested".

So when a filter is active we say how many rows it could not evaluate. Costs one cheap
count, and only when it is relevant.
   

## D096

**`api/routes/traders.ts`** — Applied before paging, so `offset` walks the filtered set rather than the full board.

Applied before paging, so `offset` walks the filtered set rather than the full board.

A trader with NO `captured_at` is included, not excluded. 37 of 137 have no stats row, so
filtering them out would make them permanently invisible to every incremental sync —
a consumer would never learn they exist and would never be told anything was missing.
Unknown freshness cannot prove absence of change, so the safe answer is to send them and
let the consumer over-write identical data.
   

## D097

**`api/routes/traders.ts`** — A requested include that produced NOTHING is a failure, not an empty truth.

A requested include that produced NOTHING is a failure, not an empty truth.

These queries can resolve to zero rows without throwing -- a degraded pool, a statement
that timed out and came back empty -- and the response would still be 200 with the block
silently absent on every row. That is what cost a consumer their watch list: they asked
for wallets, got 435 traders and no wallets, and believed it.

432 of 435 traders have a wallet and every trader has trades, so on a non-empty page a
requested include yielding zero rows is a fault every time. Fail loudly instead.
   

## D098

**`api/routes/traders.ts`** — Sub-resources are nested under `included`, NOT spread onto the entry.

Sub-resources are nested under `included`, NOT spread onto the entry.

`entry.pnl` already exists and is fomo's REPORTED figure; the `pnl` sub-resource is the
one we compute from stored trades. Spreading would have silently replaced one with the
other under the same key — the exact reported-versus-verified conflation this API keeps
apart everywhere else. Nesting also means a future include can never collide with a
board field.
   

## D099

**`api/routes/traders.ts`** — ISO-8601, not the epoch integer this used to be.

ISO-8601, not the epoch integer this used to be.

Every other moment this service publishes is an ISO string with an explicit Z, and
`/v1/fields` says so in as many words: "*At / *From / *To / *Since: ISO-8601 with an
explicit Z. Never epoch seconds." This one field contradicted that, on the most-called
route, for a field the consumer's contract marks load-bearing -- "a board with no
captured moment is refused outright".

`capturedAtEpoch` carries the old integer so nothing that already parses it breaks. It
is the shape that changed, not the meaning, and a consumer gets a version ahead.
     

## D100

**`api/routes/traders.ts`** — WHERE THIS TRADER CAME FROM.

WHERE THIS TRADER CAME FROM.

The two sources fail in opposite directions and always have: entry prices are thin on
the fomo side and rich on the GMGN side, resolved trades exist on the fomo side and
barely at all on the GMGN side. A profile built to one contract therefore looks rich
on some traders and threadbare on others, and until now nothing in the answer
explained why -- the only tell was that `rank` and `followers` came back null, which
is an inference, not a field.
       

## D101

**`api/routes/traders.ts`** — IS THIS TRADER STILL ON THE BOARD, and if not, why.

IS THIS TRADER STILL ON THE BOARD, and if not, why.

`listed: false` means the source stopped carrying them, so the directory no longer shows
them — but this route still answers, because a link that used to work should not start
404ing over a condition upstream of us. Nothing is deleted: their holdings, trades and
history are intact and the flag reverses if the source lists them again.
     

## D102

**`api/routes/traders.ts`** — T1.2.

T1.2. On-chain activity counters for a set of wallets.

GMGN publishes `buys_{window}` / `sells_{window}` / `swaps_{window}` per token; this is the
per-WALLET equivalent, which is what our routes are organised around. Same source and same
index as T1.1, so it costs one round-trip and no new table.

`activeDays` counts distinct UTC days with any movement — not the span between first and
last. A wallet that traded twice a year apart has 2 active days, not 365, and the two
readings support very different conclusions about whether someone is actually trading.
 

## D103

**`api/routes/traders.ts`** — Axis 6's evenness input: how many trades on each active day.

Axis 6's evenness input: how many trades on each active day.

Returned as a series rather than a single number so a consumer can compute gini, burstiness
or anything else from the same rows — one histogram answers several questions, and a lone
coefficient answers exactly one. `evenness` is also computed server-side below for callers
who just want the figure.
 

## D104

**`api/routes/traders.ts`** — Gini over trades-per-day, expressed as evenness (1 − gini).

Gini over trades-per-day, expressed as evenness (1 − gini).

1.0 means every active day carried the same number of trades; 0 approaches all activity in
a single day. Days with NO trades are deliberately excluded — the spec defines `activeDays`
as days with at least one trade, so including silent days would measure how long we have
been watching rather than how evenly they trade.

`null` below two active days: a gini over one point is 0, which would read as "perfectly
concentrated" when it actually means "nothing to compare".
 

## D105

**`api/routes/traders.ts`** — Wallets, each with its FAMILY and the chains it has actually been seen on.

Wallets, each with its FAMILY and the chains it has actually been seen on.

PRD §2. `family` is `solana` or `evm` and never a chain, because one Ethereum-style
address is the same wallet on Ethereum, Base, BNB Chain and Robinhood Chain at once --
140 of our 260 EVM-only traders trade on four of them. A consumer that assumes one chain
per address files a third of them as quiet while they trade daily.

`chains` is what we have OBSERVED, never inferred from the address format. A chain we have
never seen the wallet on is absent, not `tradesSeen: 0` -- those are different claims.
 

## D106

**`api/routes/traders.ts`** — A3 — accept a wallet for a trader we already list.

A3 — accept a wallet for a trader we already list.

WHY THIS EXISTS AND WHY IT IS NARROW. Seven traders are published with no address, so they
reach a screen with no balance and no chart. We resolve wallets ourselves and will keep
doing so; this is the route that lets whoever already holds one hand it over rather than
watching a trader stay unpriceable.

IT IS THE ONLY WRITE IN THIS SERVICE, and that is the whole risk. Every other address here
came from a resolver we control, carrying its own source and confidence. An address that
arrives from outside has neither, and the failure it invites is the worst one available to
this API: attribute the wrong wallet to a trader and we price a stranger's money and
publish it under his name, plausibly, with nothing downstream able to tell.

So the submission is treated as a CLAIM, not a fact:
  - the shape is checked, per family, before anything is stored;
  - an address already on another trader is REFUSED, never moved -- that single check is
    what stops one person's money appearing on another's page;
  - an address a trader already has is refused rather than silently overwritten;
  - what is stored carries `source: "submitted"` and `confidence: "reported"`, never
    `verified`, so every figure derived from it inherits the weaker tier.

Every refusal is a machine word, because a caller has to be able to tell "you sent a typo"
from "that wallet belongs to somebody else" without reading English.
 

## D107

**`api/routes/traders.ts`** — IS THIS ADDRESS ALREADY SOMEBODY ELSE'S?

IS THIS ADDRESS ALREADY SOMEBODY ELSE'S? The one check that matters most here.

Two traders sharing an address means one of them is shown the other's money, and it is
invisible afterwards because the figure is real -- it just belongs to a different person.
Refused outright rather than reassigned, and the refusal names the trader who holds it so
the sender can see the collision rather than guess at it.
   

## D108

**`api/routes/traders.ts`** — The stable key.

The stable key. `handle` above is a display name and may change; this does not.

ONE SPELLING, and it is the directory's. This route used to prefix the uuid with
`trd_` while `GET /traders` returned it bare, so the same trader had two ids depending
on which route you asked -- a consumer storing one and looking up the other found
nothing. The directory is what a consumer reads first, so the directory's form wins.
Both spellings are still ACCEPTED as input, forever; only the output is now consistent.
     

## D109

**`api/routes/transactions.ts`** — ?kind=swap returns only rows a provider classified as a swap.

?kind=swap returns only rows a provider classified as a swap.

The review's sharpest point was that an inbound transfer is not a purchase — it is just
as likely a self-transfer between the trader's own wallets. `tx_type` now carries the
provider's own classification, so "show me actual trades" is finally answerable rather
than being left to the caller to guess at.

Rows ingested before that column existed have tx_type NULL and are EXCLUDED from a
?kind filter — absent, not assumed. Unfiltered requests still return everything.
   

## D110

**`api/routes/transactions.ts`** — True keyset pagination, not an offset.

True keyset pagination, not an offset.

This feed is append-only and the webhook writes to it continuously, so rows arrive at the
FRONT of a `block_time desc` ordering. Under `?offset=` every insertion between two calls
pushes the whole list down and page two repeats rows page one already returned. A keyset
asks for "everything ordered after this exact row", which newly-arrived rows cannot
disturb — they sort ahead of the cursor and are simply not in the caller's backward walk.

`block_time` is NULL on 0 of 386,544 rows, so the ordering needs no NULL branch; the
remaining four columns are the primary key and all ascend, which lets the tail be one
row-value comparison rather than a nested OR chain.
   

## D111

**`api/routes/transactions.ts`** — T2.1.

T2.1. The cost-basis figures GMGN publishes as `history_bought_cost` /
`history_sold_income`, derived from the quote leg of each swap.

We overwhelmingly stored the quote side rather than the memecoin side, which is what
makes this answerable: we know a wallet spent 1.5 SOL even though we never recorded what
came back. So this is how much money MOVED, not what price they paid per token — the
second question needs both legs and we hold those for a small minority of swaps.

Coverage travels with it because a third of a wallet's swap legs can be unpriceable, and
a spend total drawn from two thirds of the record must not read as the whole of it.
   

## D112

**`api/routes/transactions.ts`** — The money block is a WHOLE-WALLET total, identical on every page — so it is computed when

The money block is a WHOLE-WALLET total, identical on every page — so it is computed when
you start reading a wallet and not again while you page through it.

It is the expensive part of this route: 386ms as an index-only scan over 30,907 rows for
a large wallet, which took the route from 2.5s to 3.6s against a 2.7s control. Recomputing
it on all 12 pages of a walk would spend that twelve times over to return the same number
twelve times. Present by default, absent once you are following a cursor, and `?money=true`
forces it either way.
   

## D113

**`api/routes/transactions.ts`** — What this feed is, said plainly, because it is easy to mistake for something else.

What this feed is, said plainly, because it is easy to mistake for something else.

These are TRANSFERS, not trades. An incoming transfer is not a purchase — it is
just as likely someone moving coins between their own wallets, and most rows come
back `side: "in"` for exactly that reason. There is no USD value or price on a row
because the providers do not give one and we will not invent it.

For buy/sell with P&L and entry/exit prices, use /traders/:handle/scorecard, which
reads fomo's trade records rather than raw chain movement.
     

## D114

**`api/routes/transactions.ts`** — `txHash` is the name every other route uses -- /trades has always spelled it that way.

`txHash` is the name every other route uses -- /trades has always spelled it that
way. This route emitted `tx_hash` alone, the one snake_case key in an otherwise
camelCase API, which is an oversight rather than a convention.

Both are returned: the old spelling stays so nothing reading it breaks, and new
consumers get the name that matches the rest of the API. `tx_hash` is deprecated.
       

## D115

**`api/routes/transactions.ts`** — T2.1.

T2.1. USD size of this leg — a MAGNITUDE, like `amount`, with the direction in
`side`. `amount` is positive on every row in both directions (measured: 0 of 117,524
swap legs are negative), so signing this column would have made the two disagree.

`null` is the honest answer for a leg whose token is not a quote asset: ~8,700 of
117,500 swap legs are the memecoin side, and we did not store what it was worth. It
is never 0 — a swap we could not value is not a swap worth nothing.
       

## D116

**`api/routes/transactions.ts`** — The trader's own swaps, both sides, valued from the money side.

The trader's own swaps, both sides, valued from the money side.

PRD §4 asks for every swap on every chain. This serves what we have RESOLVED, which is
Solana only, and states that in `coverage` rather than implying the rest were quiet.

Why only Solana: a swap is the wallet's own two-sided trade, and finding those on EVM was
measured and failed. A complete eth_getLogs scan of robinhood -- 2,000,000 blocks, every
wallet in the topic array -- produced 30,384 candidate (tx, wallet) groups and ZERO
two-sided swaps, because that chain matches off-chain and only settles on-chain in
Multicall3 batches. Across all four EVM chains our stored transactions hold 81
swap-shaped groups against Solana's 4,696.

`valueUsd` comes from the MONEY side -- what was actually paid or received in a coin whose
dollar value we know -- not from multiplying the memecoin by a guessed price. That is why
it can be trusted where a price cannot.
 

## D117

**`api/routes/transactions.ts`** — FIFO PAIRING: each sell consumes the oldest buy still holding quantity.

FIFO PAIRING: each sell consumes the oldest buy still holding quantity.

This is what turns a list of swaps into round trips -- "in and out under five seconds",
"still open when our copy landed", and a holding time per trade rather than per coin.
FIFO because it is the convention a reader assumes and the only one we can defend
without knowing the trader's own accounting.

A lot is identified by the tx that opened it, so a round-trip id is stable and points at
something a consumer can look up on a block explorer.
   

## D118

**`api/routes/transactions.ts`** — `pageRaw` is the page as the database returned it; `page` is what survives `?status=`.

`pageRaw` is the page as the database returned it; `page` is what survives `?status=`.

The cursor is taken from `pageRaw` and never from `page`. Filtering happens after paging
-- the pairing that decides open-versus-closed is not a stored column, so the database
cannot do it -- and a page whose rows are all filtered out would otherwise produce a null
cursor and stop the caller dead while rows remained. A sparse page is fine; a lost tail
is not.
   

## D119

**`api/routes/transactions.ts`** — THE ROUND TRIP THIS SWAP BELONGS TO, from FIFO over the trader's whole record.

THE ROUND TRIP THIS SWAP BELONGS TO, from FIFO over the trader's whole record.

`positionId` is the transaction that OPENED the lot, so it is stable and points at
something a consumer can look up. On a buy, `status` is `open` until a later sell
finishes consuming it. On a sell, `openedAt` is when the quantity it sold was
bought, which is what "in and out under five seconds" measures.

Null on a sell with nothing left to match -- a wallet whose earlier buys predate
what we hold. That is a gap in our record, not a trade from nowhere.
         

## D120

**`api/routes/transactions.ts`** — WHAT THIS TRADE COST TO MAKE.

WHAT THIS TRADE COST TO MAKE.

`feeNative` is the measurement and is exact -- gas_used x effective_gas_price from
the receipt on the EVM chains, meta.fee on Solana. `feeUsd` values it at the
CURRENT native price, because we hold no historical one; it is an approximation and
`feeUsdBasis` says so. Null, never 0: a trade is never free, so a missing fee is a
gap in our reading, not a costless trade.
         

## D121

**`api/routes/transactions.ts`** — PER CHAIN, so "he made no trades there" and "we have not read that chain" stop looking ide

PER CHAIN, so "he made no trades there" and "we have not read that chain" stop
looking identical.

`unresolved` means we hold no swaps for that chain at all though the trader is known
to trade on it -- the honest state for the four EVM chains today. `complete` means we
hold swaps and `from`/`to` say which span they cover, so a caller asking for last
week can tell whether last week was even read.
       

## D122

**`api/shared/asof.ts`** — When THIS trader's trade records were measured — not the board's.

When THIS trader's trade records were measured — not the board's.

The unscoped version reported `max(captured_at)` across all 114 traders, so a trader last
refreshed two days ago still showed today's timestamp on their own page. That is exactly
the failure the consuming team reported against /v1/traders ("we cannot tell a trader
refreshed a minute ago from one refreshed a day ago"), which was fixed there with a
per-trader `updatedAt` and then quietly reintroduced here.

Passing no handle keeps the board-wide value, which is the right answer only for
board-wide questions.
 

## D123

**`api/shared/batch.ts`** — OVER THE CAP IS A REFUSAL, NOT A TRIM.

OVER THE CAP IS A REFUSAL, NOT A TRIM.

This used to read the first fifty and set `capped: true`. That is a correct description
of what happened and still the wrong behaviour: the caller asked about sixty traders and
got a 200, so the ten it never heard about look exactly like ten traders with no data.
GENIE_FOMO_V7_BATCH_AUM_TDR.md §6 asks for the refusal instead, and a 400 naming the cap
is a bug the caller fixes once rather than a silent under-count it never notices.
   

## D124

**`api/shared/batch.ts`** — RESOLVE ALL FIFTY IN ONE QUERY, not one query each.

RESOLVE ALL FIFTY IN ONE QUERY, not one query each.

resolveTrader() looks an id up in the database, so mapping it over the list issued fifty
round trips through the pooler -- about nine seconds of a call whose actual data costs
1.2. Measured on a 50-id batch: 9.9s for a window returning 65KB, which is the giveaway
that the payload was never the problem. One `any()` answers the whole list.
   

## D125

**`api/shared/batch.ts`** — THE `display_handle` FALLBACK, which the single routes have had and this one did not.

THE `display_handle` FALLBACK, which the single routes have had and this one did not.

resolveTrader() tries the stored handle, then `display_handle`, because for one trader
they differ: `yeon__ (gmgn)` is published under that name and stored as `gmgn_yeon__`.
Lowercasing the published name therefore matched nothing here, so the SAME trader
answered 200 with a full envelope on /traders/:handle/aum and `not_found` in the batch.
One trader of 448, resolvable by id, and the only one whose two routes disagreed about
whether he exists -- which is precisely the failure the batch contract forbids.

Only the handles that missed are looked up, so the ordinary batch pays nothing: the
query runs at all only when a name did not match a stored handle.
   

## D126

**`api/shared/batch.ts`** — `requested` is what the caller actually sent, kept beside the resolved handle.

`requested` is what the caller actually sent, kept beside the resolved handle.

Without it a response is ambiguous the moment a handle changes: the caller asked about
an id, the row comes back under a handle, and nothing in between says they are the same
trader. GENIE_FOMO_V7_BATCH_AUM_TDR.md §5 asks for the submitted value to be echoed for
exactly this reason, so a row can be joined back without guessing.
   

## D127

**`api/shared/chains.ts`** — PARAMETERS.md routes, served from Postgres.

PARAMETERS.md routes, served from Postgres.

Two rules carry over from the Express implementation and are the reason several of these
queries look more careful than they need to:

  A MISSING PRICE IS NOT ZERO.  `value` is nullable and 1,688 of 2,038 rows have none.
  SQL's `sum()` skips nulls, which is what we want — but `count(*)` does not, so every
  ratio here names the column it counts rather than counting rows.

  A RATIO SHIPS WITH ITS DENOMINATOR.  A concentration of 97% computed over 44% of a
  portfolio is not a fact about the portfolio, so `coverage` travels with every figure.
 

## D128

**`api/shared/chains.ts`** — EVERY CHAIN A TRADER USES, independent of any window or any single reading.

EVERY CHAIN A TRADER USES, independent of any window or any single reading.

`aum.chains` lists the chains in the NEWEST reading, which is a fact about that reading and
not about the trader -- it showed Solana alone for a trader whose portfolio spans five. A
consumer drawing chain switches from it offered 128 of 435 traders fewer switches than the
service itself says they use.

So the list is built from every place a chain can be evidenced, unioned:
  - a chain his wallets have been SEEN trading on (wallet_chain_presence)
  - a chain he currently HOLDS something on (holdings_current)
  - a chain we hold BALANCE HISTORY for (aum_chain_samples)

Set-based over every handle at once, so the batch routes pay one query rather than fifty:
measured 116 ms for fifty traders.
 

## D129

**`api/shared/cursor.ts`** — ISSUE-8.

ISSUE-8. Sub-resources that `/v1/traders?include=` can inline.

The reported problem: a consumer mirroring the directory needed 137 traders x 7 sub-routes,
~960 calls, ~30 minutes sequentially. Per-call latency was the symptom; the call COUNT was
the cause, and no amount of shaving 2s down divides 960 into something comfortable.

Each include is served by ONE set-based query for the whole page, never a loop — measured,
137 traders aggregate in 614ms against 152ms for a single trader, because Postgres does it
in one pass. A bulk route that loops would have moved the N+1 server-side and made things
worse.
 

## D130

**`api/shared/cursor.ts`** — T1.4.

T1.4. Cursor pagination.

`?offset=` addresses rows by POSITION, which is only correct if the list does not move
between calls. Ours moves: the board refreshes nightly and the Helius webhook appends
transactions continuously. A row inserted before your offset shifts everything down, so
page 2 repeats a row page 1 already gave you; a row removed shifts up and page 2 skips one.
Neither is visible to the caller — the sync just ends up wrong.

A cursor names WHERE YOU WERE instead of HOW FAR IN. `offset` is kept working, because
removing a published parameter to fix a bug nobody reported would break consumers who are
fine today; new syncs should use the cursor.

The payload is not secret and not signed — it is the sort key, base64url so it survives a
query string and so nobody is tempted to hand-assemble one. Tampering yields a 400, never
a wrong page.
 

## D131

**`api/shared/cursor.ts`** — Resume a JS-paged list after the row a cursor names.

Resume a JS-paged list after the row a cursor names.

The board routes fetch the whole ordered list and slice it, so the cursor identifies the
anchor ROW rather than encoding a comparable key: resuming at "the row after this one" is
exact, and it cannot disagree with the SQL ordering the way a re-implemented comparator
could.

If the anchor is gone — the nightly refresh dropped that trader or token — we say so
instead of guessing. Silently restarting from the top would hand back rows the caller
already has and look like duplicates in their data.
 

## D132

**`api/shared/params.ts`** — Read an integer query parameter, or reject it.

Read an integer query parameter, or reject it.

The old pattern was `Number(url.searchParams.get("limit"))` guarded by `isFinite`, which
silently treated anything unparseable as "not supplied" — so `?limit=abc` returned 200 and
the whole list, and `?offset=abc` was ignored. A typo produced a full table scan and a
confidently wrong page rather than an error naming the mistake.

Absent still means the default: `?limit=` omitted returns everything, which is documented.
PRESENT-but-invalid is what now fails, because that is a caller error and silence hides it.
 

## D133

**`api/shared/params.ts`** — T1.5.

T1.5. A decimal bound, for range filters over money columns.

Separate from `intParam` because P&L and volume are `numeric` and a caller filtering on
`minPnl=1000.50` should not be told it must be a whole number. Same strictness otherwise:
BUG-3 established that a parameter we cannot parse is a 400, never a silent default, since
an ignored filter returns MORE rows than asked for and looks like data rather than an error.
 

## D134

**`api/shared/params.ts`** — Resolve `?orderBy=` against a whitelist.

Resolve `?orderBy=` against a whitelist.

The value never reaches SQL. It selects a pre-written fragment, so an unknown key is a 400
naming the valid set rather than anything that could reach the planner.

Ordering direction applies ONLY to the chosen column. Every sort keeps its existing
tiebreak, unreversed, because T1.4's cursors resume through a total order — a sort that
ties would make pagination skip and repeat rows again, which is the bug that item existed
to fix.
 

## D135

**`api/shared/pnl-core.ts`** — WHY `realizedShare` IS NULL, as a machine word rather than only in `plain`.

WHY `realizedShare` IS NULL, as a machine word rather than only in `plain`.

It is withheld on purpose and the sign discipline above explains why: a trader who lost
$10,000 would otherwise render as "80% banked". That reasoning was sound and completely
invisible to a machine -- 391 of 448 traders serve a null here, and not one carried a
stated reason, which made this field alone 386 of the 425 silent absences across the
six axes. A hollow axis is honest; a hollow axis with no reason is a hole a person reads
as a judgement about the trader.
     

## D136

**`api/shared/positions-core.ts`** — WHAT A TRADER PAID FOR WHAT HE STILL HOLDS.

WHAT A TRADER PAID FOR WHAT HE STILL HOLDS.

`/positions` gave quantity, price and value with no acquisition cost, so "up 3x on this
coin" could not be said at all. Every open position we store carries an entry price and an
amount, and that is a cost basis.

Two rules shape this:

  A holding with no stored position gets `null`, never `0`. Coins arrive by transfer as
  well as by purchase, and a transfer in is not a free acquisition -- reading it as one
  would turn every airdrop into infinite profit. `costReason` names which case it is.

  `unrealizedUsd` is measured against the quantity whose cost we know, not against the
  whole holding. Those differ whenever some positions carry an entry price and others do
  not, and multiplying a partial cost by a full quantity invents a number.

Keyed by handle then "networkId:tokenKey". One query for the batch: 0.6 ms for a trader
through trades_handle_idx.
 

## D137

**`api/shared/prices.ts`** — Each chain's own coin, and what one of them costs — so a chain's dollars can also be said

Each chain's own coin, and what one of them costs — so a chain's dollars can also be said
the way a wallet says them, "114.09 BNB" beside "$83.6K".

The price has to be a MARKET price or it is worse than nothing. Most of what we hold for a
wrapped native is `fomo_reported_entry` — the price a trader reported paying, not what the
coin is worth now — and some rows carry a price with no source at all, which cannot be
stood behind either. Both are excluded, so three of five chains answer `null` today rather
than converting a portfolio at a number nobody can defend.

Five rows, cached for the process: chains do not change and the price moves slowly enough
that a per-request query would be pure cost.
 

## D138

**`api/shared/scorecard-core.ts`** — Dollars for a FEE, which is often a fraction of a cent.

Dollars for a FEE, which is often a fraction of a cent.

`round()` keeps two decimals, and a Solana fee of 0.0000292 SOL is $0.003 -- which came
back as `0`. Zero states that the trade cost nothing to make, and no trade on any chain
does. Six decimals keep the smallest fee we have measured visible while a large one still
prints as money: 0.003 and 676.9, not 0 and 676.9.
 

## D139

**`api/shared/scorecard-core.ts`** — Fees a trader paid, per window, in dollars.

Fees a trader paid, per window, in dollars.

Read from `trader_fees_daily`, which is built off the request path: summing this from
`transactions` at request time measured 24.5 seconds for our busiest trader, because that
table holds one row per transfer leg and the honest sum has to take DISTINCT transactions
out of it. Against the daily buckets the same answer takes 0.78 ms.

Dollars are computed here rather than stored, from the same native price the portfolio
uses, so a fee and a balance can never be converted at two different rates.

THE CONVERSION IS AN APPROXIMATION AND THE RESPONSE SAYS SO. We hold no historical native
price, so a fee paid in July is valued at today's rate. The native figure beside it is
exact and is the one to trust.
 

## D140

**`api/shared/scorecard-core.ts`** — INDIVIDUAL BUYS, so a question about buys can be counted in buys.

INDIVIDUAL BUYS, so a question about buys can be counted in buys.

The scorecard's `avgEntryPrice` is an average fomoapi hands us already averaged across the
fills inside a position, and an average cannot be un-averaged: five buys at five prices
arrive as one number. "95% of his buys were under $100K" counts buys, so it needs them
individually, and the only place they exist is `wallet_swaps` -- Solana from the start, and
the four EVM chains since the receipts were read.

Keyed by handle then "networkId:tokenKey", so a per-coin row can carry its own buys and the
batch path pays one query for the page.
 

## D141

**`api/shared/scorecard-core.ts`** — EVERY RESOLVED SWAP FOR THESE TRADERS, IN ONE QUERY.

EVERY RESOLVED SWAP FOR THESE TRADERS, IN ONE QUERY.

Three separate queries used to scan `wallet_swaps` over the same join for the same trader:
the chain entry price, the chain exit P&L, and the individual buys. Each one measures about
160 ms, which sounds harmless -- but each also holds its own connection, and a pool exhausts
on connections held, not on milliseconds burned. That is what took the service down under a
448-trader sweep.

So the rows are fetched once and the three answers are derived from them in memory. Same
numbers, one third of the connections.
 

## D142

**`api/shared/scorecard-core.ts`** — Everything the scorecard computes, over rows already fetched.

Everything the scorecard computes, over rows already fetched.

Split out for ISSUE-8 so `/traders?include=scorecard` runs THIS function rather than a
second implementation of it. A bulk route that re-derives its own summary drifts from the
single-trader route the first time either is edited; sharing the code path makes the two
identical by construction rather than by test.
 

## D143

**`api/shared/scorecard-core.ts`** — THE BALANCE A TRADER STARTED EACH MONTH WITH — the denominator a monthly return needs.

THE BALANCE A TRADER STARTED EACH MONTH WITH — the denominator a monthly return needs.

Every month has arrived in dollars with `startCapitalUsd` empty, and the consumer's fourth
verdict test is written as a percentage: did he survive a bad month, losing less than a
fifth. With no starting balance there is no denominator, so that test was unanswerable for
every trader in the directory and the top verdict was unreachable for all of them.

It is answerable now because the sampler runs. `aum_samples` holds a priced reading per
trader per hour, so the balance entering a month is simply the first one the month has.

ONLY WHEN THE READING IS ACTUALLY NEAR THE START. A reading taken on the 20th is not what
he began the month with, and dividing by it would produce a percentage that looks measured
and is not. Seven days is the bound; past that the month keeps a null and says why, which
is the same discipline every other figure here follows.
 

## D144

**`api/shared/scorecard-core.ts`** — WHEN THIS TRADER'S RECORD WAS LAST LOADED — the NEWEST row, not the first one.

WHEN THIS TRADER'S RECORD WAS LAST LOADED — the NEWEST row, not the first one.

`rows[0].captured_at` is whatever row the query happened to return first, and a trader
whose record is refreshed keeps his older rows: unipcs spans 4 September to 15 September,
so the scorecard reported a load stamp ten days old on a record refreshed that morning.
That is the exact shape of the staleness complaint this field exists to answer, produced
by the field itself. `asOf` next to it was already taking the maximum and disagreeing.
   

## D145

**`api/shared/scorecard-core.ts`** — T3 — return on cost basis, and the derivation matters.

T3 — return on cost basis, and the derivation matters.

This previously computed basis as `amount x avgEntryPrice` over closed trades and was
wrong by ~10^17. `amount` on a CLOSED trade is what REMAINS in the position — nothing,
because it was sold. Measured: 2,378 of 3,220 closed trades have amount exactly 0, and
2,866 have a basis under $1 against a realized P&L over $100. Dividing real dollars by
dust produced numbers like 877,995,983,169,868,200.

fomo never reports the quantity originally bought, so the basis cannot be read directly.
It can be DERIVED, because for a position closed at avgExitPrice:

    pnl   = qty x (exit - entry)          ->   qty   = pnl / (exit - entry)
    basis = qty x entry                   ->   basis = pnl x entry / (exit - entry)

The quantity cancels, so no position size is needed. Summing basis and pnl across trades
then gives a MONEY-WEIGHTED return — a $1M trade counts more than a $10 one, which an
average of per-trade percentages would not.

Trades where the derivation cannot hold are dropped rather than approximated: exit equal
to entry (a zero divisor), and the 29 of 3,176 whose implied basis is negative — that
means pnl and the price move disagree in sign, so the trade is not a simple long and the
formula does not describe it.
   

## D146

**`api/shared/scorecard-core.ts`** — ISSUE-4.

ISSUE-4. `avgEntryPrice` used to be the FIRST entry price seen for a token, never
re-averaged across a trader's several positions in it — while the field name, the T17
doc row and K5's `crowdAvgEntryPrice` all said "average".

A fomo "trade" is a POSITION, not a fill (one row opened 2026-04-24 and closed
2026-08-31 carrying a single `avgEntryPrice`), so fomo has already averaged within it.
That is why the field is not simply renamed `firstEntryPrice`: on 9,886 of 10,205
trader-token pairs there is exactly one position and the value already IS an average.
Renaming would mislabel 96.9% of rows to fix 3.1%. The defect is only the failure to
combine ACROSS positions — where it bites, it bites hard: median 38.5% off the weighted
figure, 71% of them off by more than 10%.
   

## D147

**`api/shared/scorecard-core.ts`** — Resolve a leg accumulator to one price plus the method that produced it.

Resolve a leg accumulator to one price plus the method that produced it.

The method travels with the number because three different computations hide behind one
field, and a consumer cannot otherwise tell a genuine weighted average from a single
position's value from a fallback. `weighted_partial` is the honest name for an average
over the legs that had a weight when some did not — 14 of 319 positions.
   

## D148

**`api/shared/scorecard-core.ts`** — Axis 5.

Axis 5. fomo prices only 45% of trader-token pairs, and the unpriced ones are what
keeps the axis below its own coverage bar. Where we resolved the wallet's own buys
on chain, the entry price is arithmetic on them.

A FALLBACK, never an override — `e.value` wins whenever it exists, so this cannot
move a number that already had a source. `entryPriceSource` says which you got,
because a price we derived and a price fomo reported are different kinds of claim
and a consumer weighing them needs to know which is which.
       

## D149

**`api/shared/scorecard-core.ts`** — Which of three computations produced the price above, and over how many positions.

Which of three computations produced the price above, and over how many positions.

Without this a consumer cannot tell a genuine weighted average from a lone
position's value from a fallback, and all three used to arrive under one name.
  single_position  - one position in this token; fomo already averaged inside it
  weighted         - averaged across positions, every leg weighted
  weighted_partial - some legs had no recoverable quantity and are excluded
  first_only       - no leg had a weight; the earliest value is returned
       

## D150

**`api/shared/scorecard-core.ts`** — When the token itself was created, and how old it was when this trader first opened a posi

When the token itself was created, and how old it was when this trader first opened a
position in it. Buying something four hours old is a different act from buying it four
months old, and only the second number expresses that.

`null` on either when GMGN has no creation time for the token (about 9% of them) or
when we hold no open date — never 0, which would read as "created at the epoch".
       

## D151

**`api/shared/scorecard-core.ts`** — When this coin was closed, first and last.

When this coin was closed, first and last.

The realised figure on this row was always summed by close date, and the row carried
no date to go with it -- the only dates here were about the coin, not the trading.
Null while nothing in this coin has closed yet, which is a different state from
closed at the epoch.
       

## D152

**`api/shared/scorecard-core.ts`** — Entry expressed as a MARKET CAP, which is how it is read on screen.

Entry expressed as a MARKET CAP, which is how it is read on screen.

null — never 0 — when either the price or the supply is unknown. A trader whose
entry we cannot establish must not appear to have got in for nothing.

`supply` and `supplyReadAt` travel with it deliberately: supply on these tokens
moves (one was measured drifting 12.45% in a day), so publishing only the cap would
make our number and a consumer's recomputation disagree with no way to tell which
was right. Sending the multiplier we used makes them reconcilable.
       

## D153

**`api/shared/scorecard-core.ts`** — DOLLARS IN AND DOLLARS OUT on this coin, which is what "how much a bet" and the profit ban

DOLLARS IN AND DOLLARS OUT on this coin, which is what "how much a bet" and the
profit bands are actually asking for. An average price cannot answer it: two traders
with the same average entry can have staked a hundred dollars or a hundred thousand.

Both are the quantity-weighted sums that already produced the averages above -- the
price of each position times the quantity recovered for it -- so they reconcile with
`avgEntryPrice` exactly, and are not a second estimate of the same thing.

Null, never 0, when no position in this coin carried a recoverable quantity. A coin
whose cost we cannot establish must not appear to have been free.
       

## D154

**`api/shared/scorecard-core.ts`** — A REASON BESIDE EVERY NULL ON THIS ROW, from a fixed vocabulary.

A REASON BESIDE EVERY NULL ON THIS ROW, from a fixed vocabulary.

A null says a figure is absent and nothing about why, and the four causes want
different responses from a screen: `not_applicable` should not be shown at all,
`not_yet_calculated` is worth returning for, `source_unavailable` and
`historical_input_missing` are permanent for this coin and should be labelled.

Only keys that ARE null appear, so a fully populated row carries an empty object
rather than a wall of nulls-about-nulls. This explains existing fields; it does not
replace any null with a zero.
       

## D155

**`api/shared/scorecard-core.ts`** — THE BUYS THEMSELVES, where we hold them.

THE BUYS THEMSELVES, where we hold them.

`avgEntryPrice` above is one number for the coin; these are the fills it averages.
A question about buys -- "95% of buys under $100K", the size bands, "how much a bet"
-- has to count buys, and an average cannot be taken apart into them.

`marketCapUsd` is that buy's price times the supply we hold, so a buy can be placed
in a size band. It is null wherever either input is, never 0.

Capped at 100 per coin with `buysTotal` stating the real count, so one heavily traded
coin cannot dominate a response. Absent chains contribute nothing: `buysTotal` of 0
means we hold no individual buys for this coin, NOT that none were made -- read
`buysCoverage` on the answer before counting anything.
       

## D156

**`api/shared/scorecard-core.ts`** — Compare the SETS, not their sizes.

Compare the SETS, not their sizes.

This previously fired only when the two counts differed, which missed the case that
actually misleads: `ether_monk` has 42 entry prices and 42 exit prices — equal counts,
different trades, because 22 of the entry-priced ones are still open and so cannot have
an exit. A reader saw "$3.19M in, $0.4M out" and reasonably concluded a large loss; that
trader's closed trades are in fact +$916,699. Equal cardinality is not overlap.
   

## D157

**`api/shared/scorecard-core.ts`** — T4 — profit by window.

T4 — profit by window.

Previously marked unavailable because the leaderboard gives one lifetime `pnl` per
trader with nothing to slice it by. Storing per-trade history changed that: every
closed trade carries `closed_at`, so a window is a WHERE clause.

This is REALIZED profit only — money actually taken off the table in that period.
Including unrealised movement would need historical prices we do not store, and given
T1 exists precisely to separate banked from on-paper, realized-only is the more
truthful reading anyway. `basis` says so in the response rather than leaving it implied.
   

## D158

**`api/shared/scorecard-core.ts`** — Computed from `rows`, not from a second query.

Computed from `rows`, not from a second query.

This used to be its own round-trip per trader. Every input it needs — status, closed_at,
realized_pnl_usd — is already in `rows`, so the query was fetching data we were holding.
Dropping it takes the single-trader route from 3 database trips to 1, and it is what
lets `/traders?include=scorecard` serve 137 traders without 137 extra queries.

The SQL used `now()` (database clock) and this uses the function's; both are UTC and the
boundary is a moving 24h/7d/30d window, so a few milliseconds of skew cannot change a
bucket that any consumer could observe.
   

## D159

**`api/shared/scorecard-core.ts`** — VOLUME THIS WINDOW, MEASURED RATHER THAN REPORTED.

VOLUME THIS WINDOW, MEASURED RATHER THAN REPORTED.

The leaderboard gives one lifetime volume per trader and nothing to slice it by, so
"volume in the last 7 days" had no answer at all. Every closed position here carries
an entry price, an exit price and a recoverable quantity, and dollars in plus dollars
out is what volume means -- both legs, because a round trip trades twice.

Counted only over the positions that carry all three, with `coverage` saying how many
that was. A volume summed over half a window and presented as the whole is the same
failure as a partial balance total.
     

## D160

**`api/shared/scorecard-core.ts`** — THE SAME SUM, BROKEN OUT BY DAY.

THE SAME SUM, BROKEN OUT BY DAY.

The four windows above already group realised profit by closed_at, so a consumer could
see that a trader made money over 30 days and had nothing that could say what he made on
a Tuesday -- a thirty-day calendar drew thirty empty squares. The dates were here the
whole time; only the grouping was missing.

Days with no closed trade are ABSENT rather than zero: a day he closed nothing is not a
day he earned nothing, and a calendar should show those differently.
   

## D161

**`api/shared/scorecard-core.ts`** — THE SAME GROUPING, BY CALENDAR MONTH, for "worst month" and the bad-days test.

THE SAME GROUPING, BY CALENDAR MONTH, for "worst month" and the bad-days test.

A balance drawdown does not answer this: money moving in or out of a wallet is not a
trading loss, and the two are indistinguishable on a balance line. Realised profit summed
by close date is, and the close dates have been on every row all along.

Thirteen buckets: the twelve completed calendar months plus the one in progress, which
carries `complete: false` so a partial month is never read as a bad one.

`coverage` is the closed trades in the month that carry a realised figure against all of
them, because a month whose trades mostly lack a P&L is a thin month, not a flat one.

A month with no closed trade is ABSENT rather than zero, the same rule `realizedByDay`
follows: a month he closed nothing is not a month he earned nothing.
   

## D162

**`api/shared/scorecard-core.ts`** — The month's realised profit as a share of what he began it with.

The month's realised profit as a share of what he began it with.

This is the figure the consumer's fourth verdict test reads -- "worst month lost less
than a fifth" -- and it has been null for every trader because the denominator was.
Null still, wherever the balance is: a percentage against a capital figure we did not
measure would be a guess wearing a number.
       

## D163

**`api/shared/scorecard-core.ts`** — WHY THESE MONTHS DO NOT SUM TO THE LIFETIME FIGURE.

WHY THESE MONTHS DO NOT SUM TO THE LIFETIME FIGURE.

A trader with a longer record has closes before this window -- one measured 20 closes
worth $5,005.73 sitting before the twelve months, so his months summed to $59,422.09
against an `all` of $64,427.81. Both numbers are right and the difference is not an
error, but a consumer adding up a calendar and comparing it with the headline has no way
to know that unless we say it. So the difference is stated rather than left to be
discovered.
   

## D164

**`api/shared/scorecard-core.ts`** — WHERE THESE ROWS CAME FROM — and it is not the same answer for every trader.

WHERE THESE ROWS CAME FROM — and it is not the same answer for every trader.

This said "loaded from fomoapi" for everyone, including the 291 traders whose trades
are built from GMGN's activity feed. A consumer reading it to decide how far to trust a
figure was being told the wrong provider for two thirds of the directory, and the two
behave differently: entry prices are thin on one side and rich on the other.
     

## D165

**`api/shared/scorecard-core.ts`** — WHAT THIS SCORECARD WAS COMPUTED OVER, and whether that is the whole record.

WHAT THIS SCORECARD WAS COMPUTED OVER, and whether that is the whole record.

It used to say `sample`, with a count and a load date, and a consumer could not tell
whether 363 was a trader's whole history or a slice of it. `complete` answers exactly
that one question and no more: every position stored for this trader was used, with no
cap and no sampling. Whether the STORE is behind the chain is a different question, and
`storedAt` with `nextLoadAt` is what answers it -- as does the `trades` feed on
/health, which states its own age and allowance.

`unit` matters more than it looks. We hold POSITIONS, already averaged across the fills
inside them; the leaderboard counts FILLS. 363 against 4,745 is not a coverage gap, it
is two different things counted, and `reportedTrades` is carried so the difference is
visible instead of alarming.
     

## D166

**`api/shared/scorecard-core.ts`** — A VERDICT ON THIS RECORD'S AGE, not just the date it was loaded.

A VERDICT ON THIS RECORD'S AGE, not just the date it was loaded.

`loadedAt` and `nextLoadAt` were both already here and a consumer could in principle
subtract one from the clock. Nobody did. Measured across the directory: the oldest
scorecard was 208 hours old and sixteen were past 72, every one of them served without
qualification beside a live balance -- which reads as one moment's truth and is not.

The allowance matches the one /health judges scorecards by, so the two cannot disagree
about which traders are stale. `never` is not `stale`: a record that has never loaded
has a different cause and a different fix.
     

## D167

**`api/shared/scorecard-core.ts`** — FEES, ANSWERED HONESTLY RATHER THAN ASSUMED EITHER WAY.

FEES, ANSWERED HONESTLY RATHER THAN ASSUMED EITHER WAY.

The profile's headline says "made, after fees". Nothing here is after fees, and saying
so is the only correct answer available: no fee or gas column exists on any trade or
transfer we store, so a fee figure would have to be invented. `includesFees: false`
travels on every realised window so the claim cannot be lost.
     

## D168

**`api/shared/scorecard-core.ts`** — WHAT `winRate` IS A RATE OF — named, not left to be inferred.

WHAT `winRate` IS A RATE OF — named, not left to be inferred.

The denominator is NOT `closedTrades`. It is the closed positions that carry a
realized figure, and for 61 traders those are different numbers: 702 closed positions
across the directory have a null `realized_pnl_usd`. They are counted by
`windows[].closedTrades` and excluded from `wins`, `losses` and from this rate.

That gap is not small where it exists. One trader serves 0.6222 here and 0.4308 over
his closed trades; thirteen traders sit on opposite sides of a 30% copy floor
depending on which denominator is used. Both figures are defensible and only one of
them is on the page, so the page has to be able to say which.

`winRateCoverage.of` is this rate's denominator; `.total` is `closedTrades`. Equal for
the 387 traders whose record is complete, and visibly unequal for the 61 where it is not.
     

## D169

**`api/shared/scorecard-core.ts`** — Axis 2 — WHICH POPULATION `meanToMedian` above was computed over.

Axis 2 — WHICH POPULATION `meanToMedian` above was computed over.

It is one data point per TOKEN. The spec's formula assumes one per EXIT: a trader with
200 exits across 40 tokens gives 40 points here and 200 there. Both compute cleanly,
they are different numbers, and until this field existed nothing in the response said
which you had. That is the failure mode this API is organised against — not a value
that is missing, but one that is quietly answering a different question.
     

## D170

**`api/shared/scorecard-core.ts`** — The same statistic over real EXITS, which is what the spec actually asks for.

The same statistic over real EXITS, which is what the spec actually asks for.

Each point is one resolved on-chain sell: proceeds minus what that quantity cost at
the wallet's own average entry, both sides from `wallet_swaps`. Only positions whose
buys AND sells we resolved contribute — selling something we never saw bought has no
cost basis, and inventing one would be the whole problem in miniature.

`null` where we have fewer than two exits, and `clearsSpecBar` reports the spec's own
"< 20 sell rows -> hollow" rule so the front end can apply it without recounting.
Coverage is deliberately visible: this is exact where it exists and absent where it
does not, which is the honest shape for a number this axis will be scored on.
     

## D171

**`api/shared/scorecard-core.ts`** — THE SAME VOCABULARY, SUMMARISED FOR THE WHOLE ANSWER.

THE SAME VOCABULARY, SUMMARISED FOR THE WHOLE ANSWER.

`byToken[].fieldReasons` explains a null on one coin; this explains a null on a figure
that stands for the trader. Only keys that are actually null appear.

  not_applicable            the question does not arise — nothing has closed yet
  not_yet_calculated        a job has not produced it; it may appear later
  source_unavailable        no source we hold carries it
  historical_input_missing  the inputs existed once and were not recorded
     

## D172

**`api/shared/scorecard-core.ts`** — THE SPREAD FIGURES, which go null for two different reasons and said neither.

THE SPREAD FIGURES, which go null for two different reasons and said neither.

`worstTradeUsd` and `medianTradeUsd` are null when no closed position carries a
realized figure -- the same population `winRateBasis` names. `topTradeShare` has its
own cause: it is the best trade over GROSS GAINS, so a trader whose every closed trade
lost money has no denominator and the share is not a number. Serving 0 there would
read as "none of his profit came from one trade" about a man with no profit.

Eight absences across the directory carried no reason before this. Small, and exactly
the class of hole the six axes are drawn from.
       

## D173

**`api/shared/scorecard-core.ts`** — PRD §5 — rhythm, on ONE definition, for every trader whatever source they came from.

PRD §5 — rhythm, on ONE definition, for every trader whatever source they came from.

These figures already existed as `tradesPerDay`, `holdingTime` and `lastTradeAt`; what
was missing was a block by an agreed name carrying `basis`, `window`, `coverage` and
`asOf` on each one. A consumer that needs a trader's rhythm was refusing every row
because it could not find the block, not because the numbers were absent.

Unmeasurable is `null` with a `why`, never omitted -- an absent field and a measured
"we cannot say" are different answers and only one of them is honest.
     

## D174

**`api/shared/scorecard-core.ts`** — THE SAME COVERAGE THE FIGURE WAS ACTUALLY COMPUTED OVER.

THE SAME COVERAGE THE FIGURE WAS ACTUALLY COMPUTED OVER.

This used to report `closedPriced` -- positions carrying an entry AND an exit
PRICE, which is the denominator the return figures need and has nothing to do
with a duration. So one median appeared twice under two coverages, 43 of 43 here
and 3 of 43 there, and a consumer had no way to tell which was true. A duration
needs two timestamps, so the denominator is the positions that carry them, which
is exactly `holds` -- the array this median was taken from.
           

## D175

**`api/shared/scorecard-core.ts`** — Axis 5's "winrate on hard entries".

Axis 5's "winrate on hard entries". Restricted to tokens the trader entered below a
$1M market cap — buying something small is a different skill from buying something
established, and a blended win rate hides which one they are good at.

Per TOKEN, not per trade, because that is the granularity we hold. Coverage travels
with it: entry market cap needs both an entry price and a supply, and we have both on
well under half the record — so this is often computed over a handful of tokens and
must not be read as a headline.
     

## D176

**`api/shared/scorecard-core.ts`** — Axis 5's gate, reported rather than assumed.

Axis 5's gate, reported rather than assumed.

The spec hollows the axis when supply or price is missing for more than 30% of buys.
Publishing the share — and how much of it we had to derive ourselves — lets the front
end apply that rule without recomputing it, and lets it argue for a different rule
with the evidence in front of it.
     

## D177

**`api/shared/scorecard-core.ts`** — HOW MUCH OF THIS TRADER'S BUYING WE HOLD BUY BY BUY.

HOW MUCH OF THIS TRADER'S BUYING WE HOLD BUY BY BUY.

Read this before counting anything in `byToken[].buys`. A percentile over the buys we
happen to hold, printed as a fact about the trader, is the failure this API is built
against -- and the buys we hold are not a random sample of his. They are the ones on
chains whose swaps we could resolve.

`positions` is what the scorecard is built from, and it is the honest denominator: each
one folds an unknown number of fills into a single average.
     

## D178

**`api/shared/scorecard-core.ts`** — The same count under the name the consumer's verdict test actually reads.

The same count under the name the consumer's verdict test actually reads.

Their "real record" test is `topTradeShare` plus at least 30 coins, and it reads
`coinsTotal`. We published it only as `tokensTotal` and inside `buysCoverage`, so the
test looked at the top level, found nothing, and evaluated a threshold against
undefined. One coin, one token, one name on each side.
     

## D179

**`api/shared/scorecard-core.ts`** — OMITTED, NOT EMPTIED, when the caller asked for no coins.

OMITTED, NOT EMPTIED, when the caller asked for no coins.

The bulk route passes `tokenLimit: 0` because a page of fifty traders carrying every
coin each is a payload nobody asked for. `slice(0, 0)` made that an EMPTY ARRAY, which
is a different statement: `byToken: []` beside `tokensTotal: 390` reads as "this trader
has no coins", and the consumer's own rule says an absent list means "we did not say"
and an empty one means "there are none". We were asserting the wrong one.

So at zero the key does not appear at all, and `tokensTotal` still says how many exist.
     

## D180

**`api/shared/traders.ts`** — Resolve a path segment that may be a handle OR a stable id.

Resolve a path segment that may be a handle OR a stable id.

`handle` is a display name and people change them; `id` is the uuid that never moves. Both
are accepted on EVERY per-trader route so a consumer can key on the stable one without
losing the readable one.

This existed before and was wired into two routes out of ten. The other eight looked the
path segment up as a handle directly, so the id printed by the directory answered 404 on
the route the directory exists to point at -- exactly the failure
GENIE_FOMO_V7_BATCH_AUM_AND_COVERAGE_PRD.md reports as its first blocker. A resolver that
only some routes call is not a resolver, so it is now the single way in.

Both spellings of the id are accepted, with and without the `trd_` prefix, because both
have been published and a consumer holding either must keep working.
 

## D181

**`api/shared/traders.ts`** — THE DIRECTORY'S OWN HANDLE HAS TO WORK, and for one trader it did not.

THE DIRECTORY'S OWN HANDLE HAS TO WORK, and for one trader it did not.

`display_handle` is what every listing shows, and it is usually identical to `handle`.
It is not for `yeon__ (gmgn)`: two traders arrived sharing one folded handle, so a
migration appended the source to the display name to tell them apart. The directory then
published a name that this resolver could not resolve -- the only trader of 435 who
could not be charted at all, and the failure was ours, not the caller's.

Tried only after the plain handle misses, so the ordinary case still costs no query.
   

## D182

**`api/shared/traders.ts`** — A LEADING `@` IS HOW PEOPLE WRITE A HANDLE, and it 404s today.

A LEADING `@` IS HOW PEOPLE WRITE A HANDLE, and it 404s today.

We store handles bare. The consumer's own report names every trader `@unipcs` in its
prose and `unipcs` in its curl lines -- the same trader, one spelling of which does not
resolve. Tried last, after the bare handle and the display handle, so a handle that
genuinely begins with `@` still wins on its own terms.
   

## D183

**`api/shared/trust-core.ts`** — `asOf` is the board-wide fallback, used only for a trader with no holdings row at all — `t

`asOf` is the board-wide fallback, used only for a trader with no holdings row at all —
`trustHoldings` carries each trader's own `as_of` and that is what wins.

It stopped being safe to share one value the moment chain-read balances landed. Every
fomo row is stamped with one nightly build time, but a chain snapshot is stamped when we
read it, so a single global max would put today's timestamp on a trader whose numbers
came from yesterday's fomo build — the exact complaint the consuming team raised against
/v1/traders, fixed there with a per-trader `updatedAt`.
 

## D184

**`api/shared/trust-core.ts`** — The two "exceeds" flags look alike and are not.

The two "exceeds" flags look alike and are not.

pnl_exceeds_volume divides fomo's REPORTED profit by fomo's REPORTED volume. Both sides
are their own figures, stored verbatim, so a ratio above 1 is a contradiction inside
their data and nothing to do with our coverage. It stays.

pnl_exceeds_holdings divides that same reported profit by OUR sum of priced positions —
and for `ogle` that is 6 of 48 positions. "2,364x everything they hold" was 2,364x an
eighth of what they hold. A denominator we know is partial cannot support a claim about
the whole, so the flag is withheld below the same 0.5 floor the rest of the API uses,
and a note explains why instead.

The wording changed too. "That cannot come from trading alone" is a conclusion; the
response now states the arithmetic and leaves the conclusion to the reader.
   

## D185

**`api/shared/trust-core.ts`** — WHAT WAS CHECKED, so an absent flag cannot be read as a clean bill of health.

WHAT WAS CHECKED, so an absent flag cannot be read as a clean bill of health.

Every flag this route raises is an internal-consistency check on figures we already
hold: two numbers that cannot both be true, or too little evidence to judge. NOTHING
here consults an external reputation service, a blacklist, or a known-scam list.

That distinction is the whole point of publishing this block. "We checked a blacklist
and this trader is not on it" and "we never looked" are opposite statements, and until
now an absent blacklist flag was indistinguishable from the first while meaning the
second. `blacklist.checked: false` says which one it is.
     

## D186

**`api/shared/wallets-core.ts`** — WHY THIS TRADER HAS NO ADDRESS — the difference between "we never looked" and "the source

WHY THIS TRADER HAS NO ADDRESS — the difference between "we never looked" and
"the source is still working on it".

Seven traders are published with no wallet, and until now the answer said nothing about
why. Asked of fomoapi directly on 16 September, they are not one problem but two:
three (`zeri_term`, `bamblewood8`, `qwerty888`) come back `status: "resolving"` — the
upstream has not finished resolving them and there is no address to fetch. The other
four have dropped off every fomoapi window entirely and are stale directory entries.

Those are opposite facts about the same blank screen. One will fix itself; the other
never will.

Both report `unresolved_upstream` today, which is as far as the stored data can
separate them: all seven have no `wallets` row at all, and fomoapi's own
`wallets.status` is not something we keep. Telling `resolving` from `delisted` means
storing that status on the directory load — worth doing, and a change to the loader
rather than to this route.
     

## D187

**`api/shared/wallets-core.ts`** — EVERY CHAIN THIS TRADER USES, window-independent and stable.

EVERY CHAIN THIS TRADER USES, window-independent and stable.

`wallets[].chains` says where each ADDRESS has been seen; this says where the TRADER
is, which is the list chain tags and per-chain switches are drawn from. They differ:
a chain can carry positions or balance history without a trade we observed.

Null rather than [] when the caller did not ask for it to be resolved, so an absent
list is never read as a trader on no chains.
     

## D188

**`aum-sample/index.ts`** — AUM sampler, as a Supabase Edge Function.

AUM sampler, as a Supabase Edge Function.

WHY THIS EXISTS RATHER THAN THE GITHUB ACTION. The same job runs in
`scripts/load_aum_samples.mjs`, driven by `refresh.yml` at 06:00 UTC daily. That schedule
stopped firing on 14 September and nobody noticed for six days: every balance reading in
the database falls on one of three moments, against a published daily promise. Meanwhile
the sibling Edge Function `helius-webhook` delivered 292,970 rows over the same week and
has never missed. The half of the system that stayed up is the half that lives here.

WHAT IT DOES. Reads a slice of traders' balances straight off the chain, prices them from
what Postgres already holds, and writes one `aum_samples` row per trader plus one
`aum_chain_samples` row per chain. Identical arithmetic to the Node job -- same price
order, same refusal rules, same hour truncation -- so the two cannot produce different
numbers for the same moment.

A SLICE, NEVER THE ROSTER. Measured: ~2.1s per trader plus fixed startup. The full 441
would be about fifteen minutes, far past any single invocation's budget. So a call takes a
handful of traders, oldest-sampled first, and returns what it did and what is left. Run it
on a short schedule and the roster comes round on its own; nothing has to fit in one call.

WHAT IT DOES NOT DO. It does not fetch history, backfill anything, or call a price API.
Prices come from `quote_assets`, `token_info` and `token_prices` -- rows another job
already wrote. The only outbound calls are balance reads: Helius for Solana, and the
keyless public RPCs in `chains.rpc` for the four EVM chains.

  POST { "limit": 10 }                  the 10 least-recently-sampled traders
  POST { "handle": "unipcs" }           one trader, now
  POST { "handles": ["a","b"] }         a named slice
  POST { "limit": 10, "dryRun": true }  read and price, write nothing
 

## D189

**`aum-sample/index.ts`** — MAX_POSITION_USD WAS $1 TRILLION, WHICH CAUGHT NOTHING.

MAX_POSITION_USD WAS $1 TRILLION, WHICH CAUGHT NOTHING.

Measured 16 September: four readings over $1bn had been written, topping out at
cupseyy $473,460,243,525. The cause is not a price over the per-token ceiling -- the
offending tokens price at $28,159 and $8,923, which is plausible beside BTC at $79,035 and
sails through. It is 10.4 MILLION units of an unnamed token multiplied by that price.

Seventeen held positions price at $1bn or more and every one is a token we cannot even
name. The real ones stop far below: 78 positions between $1m and $10m, 21 between $10m and
$100m, and the largest genuine PORTFOLIO in the directory is unipcs at $16.5m.

$1bn therefore leaves a position sixty times larger than the biggest real portfolio and
still refuses every broken one. A number that large is not a rich trader, it is a broken
price, and it must never reach a chart.
 

## D190

**`aum-sample/index.ts`** — Value one position, or refuse it.

Value one position, or refuse it.

`{usd}` when it can be valued, `{rejected:true}` when a price exists but is not believable,
`{}` when we simply have no price. Three different states: an unpriced coin is a coverage
gap, a rejected one is a finding. One Orca pool once quoted a token at $3,110 against 29
pools at $0.187 and turned into a $26.7bn portfolio -- that is what the ceilings stop.
 

## D191

**`aum-sample/index.ts`** — Prices for a set of (network, token) pairs, from what this service already holds.

Prices for a set of (network, token) pairs, from what this service already holds.

Order is deliberate and matches the holdings loader AND the Node sampler, so an AUM point
and a /portfolio total cannot disagree about which price they used:
  quote_assets.pegged_usd   a dollar coin is a dollar, by definition
  token_info.price_usd      GMGN's live price, refreshed by its own loader
  token_prices              the most recent daily close
 

## D192

**`aum-sample/index.ts`** — Read every wallet this trader has, on every chain, from the chain itself.

Read every wallet this trader has, on every chain, from the chain itself.

Throws on the first unreadable wallet. That is the point: the caller turns the throw into a
refusal for the WHOLE trader-hour rather than a total missing one wallet's worth. A partial
total reads low, looks exactly like a real drawdown, and nothing downstream can tell the
two apart.
 

## D193

**`aum-sample/index.ts`** — WHO TO SAMPLE: least-recently-sampled first.

WHO TO SAMPLE: least-recently-sampled first.

This is the whole scheduling strategy and it needs no queue table. A trader never
sampled sorts first (nulls first), so a new trader is picked up on the next call; after
that everyone rotates by age. Run this on a short cron and the roster comes round by
itself, with no state to get out of step.
     

## D194

**`aum-sample/index.ts`** — SEED EVERY CHAIN THIS READ ASKED, before counting what came back.

SEED EVERY CHAIN THIS READ ASKED, before counting what came back.

`perChain` used to be built only from positions FOUND, so a chain that answered
and held nothing never got an entry, never got an `aum_chain_samples` row, and
became byte-identical to a chain nobody read. Downstream that reads as
`historyState: "none"`, `answeredChains: 0 of 1` and `partialReason:
"chains_missing"` — three statements that a wallet was not looked at, about a
wallet that was.

Measured on gmgn_0xf80d7961: his Ethereum wallet is read every pass and holds none
of the 33 tokens he traded. A live eth_call against all 33 returns zero balances.
The chain works; the wallet is empty; the service said it had never been read.

An empty chain is a real answer — his balance there is zero — so it gets a row
saying so. A chain that could NOT be read never reaches here: it throws, and the
whole trader-hour is refused above.
         

## D195

**`aum-sample/index.ts`** — HOW MANY OF HIS CHAINS THIS READING COVERED, written onto the parent row.

HOW MANY OF HIS CHAINS THIS READING COVERED, written onto the parent row.

Not cosmetic: C2 in the acceptance tests asks what share of days have a reading for
EVERY chain a trader holds, and it reads exactly these two columns. Leaving them null
-- which the first version of this function did -- means a perfectly aligned reading
is indistinguishable from one that missed half of him, and the test can never pass no
matter how well the sampler runs.

`expected` is the chains this read went and asked. `answered` is those that came back
with something we could price. A chain asked and found genuinely empty counts as
answered, because it was.
       

## D196

**`helius-webhook/index.ts`** — Helius webhook receiver — the live half of the transaction feed.

Helius webhook receiver — the live half of the transaction feed.

Helius POSTs here whenever any watched wallet transacts, so there is no polling. That
distinction is the whole reason this exists: polling ~200 wallets every minute is 288,000
calls a day against a ~100,000/month tier, roughly 86x over. Push costs nothing per event.

Three rules shape the handler, and all three come from how Helius retries:

  ANSWER FAST.  A non-2xx makes Helius retry, so slow work here turns into duplicate
                deliveries. The insert is a single batched statement, nothing else.

  BE IDEMPOTENT.  Retries and overlapping deliveries are normal. Rows key on
                (network_id, tx_hash, address_key, transfer_key) with the same
                deterministic digest the backfill uses, so replaying a payload is a no-op.

  NEVER 500 ON BAD INPUT.  A malformed payload that returns 500 gets retried forever.
                Anything unparseable is counted, skipped, and acknowledged.
 

## D197

**`helius-webhook/index.ts`** — The native SOL side of a swap.

The native SOL side of a swap.

This loop did not exist, and its absence was the reason chain-derived P&L could not be
built: on Solana the money side of a swap is very often native SOL, which Helius reports
in `nativeTransfers` rather than `tokenTransfers`. Storing only the latter kept the token
and dropped the dollars — 95,740 of 99,187 Solana swap events (96.5%) held a single leg,
so only 3.45% could have a spend attributed to a token. `src/transactions.ts:364` has
always handled both; this receiver did not, and the two quietly disagreed.

`token_key` is SOL's `quote_assets` address, NOT the string "native" the Express path
uses. It has to join to `quote_assets` or T2.1 cannot price the leg, which would leave
the row present and valueless — no better than not having it.
     

## Added 17 Sep 2026 — aum_history

Balance history is built, not sampled. The sampler (`aum-sample`, then the Worker `/sample`
cron) read every wallet from chain each pass, so a point existed only for the hours the cron
ran and survived, and a missed run was a hole that nothing could fill afterwards. Everything
a point needs is already stored: `holdings` keeps every chain capture (append-only), and
prices exist per hour (`token_price_hourly`), per day (`token_prices`), or by peg. So a
trader-hour is a deterministic function of stored rows and can be rebuilt for any past hour,
re-run when a late price lands, and backfilled on a fresh install without touching a chain.
Real measurements are not thrown away: where an `aum_samples` reading exists in the hour it
wins (`basis='reading'`), and the rebuilt figure only fills the hours between readings
(`basis='priced'`). The function lives in SQL (`aum_history_build`) so the same rules run
identically from the Worker cron and from a psql backfill; the ceilings and floors are
literals there, with `value.ts` and `aum-rules.ts` named as the source of truth, because a
function cannot import TypeScript and a table of constants for five numbers is more to keep
in step than one comment.

## D198

**`api/routes/health.ts`** — /health reads one row; the scheduler computes the body.

The body counts 1.29 M transactions and aggregates five tables. Computed per request (per isolate,
every 30 s) it took 8.6 s, put that load on the database it was reporting on, and answered
`status: ok` through an outage in which every other read failed (19 Sep 2026). The Worker now runs
`health_snapshot` every 10 minutes and stores the JSON in `health_snapshot` (one row). A request
reads that row under a 2 s deadline — the read is the probe (`database.answering`, `latencyMs`);
no answer is a 503 that says so. A snapshot older than 30 minutes means the scheduler itself has
stopped, which puts `scheduler` in `staleFeeds`. While the table is empty (once, after the
migration) a request computes the body inline. Feed clocks are therefore up to 10 minutes old,
against thresholds measured in hours.
