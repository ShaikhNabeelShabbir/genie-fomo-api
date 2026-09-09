# Axis spec ↔ our API — alignment report

**Generated: 2026-09-09** · measured against the live service, not read off the code.
**Complete as of 2026-09-09.** Every step in §6 is closed and every figure below was
re-measured against the live API after the last backfill finished.

- **Step 1** — the three §3 gaps surfaced. Named inputs **19/22 → 22/22**.
- **Step 2** — balances read from chain. Axis 4 **77 → 140 traders**, 76.9% of positions priced.
- **Step 3** — the robinhood spike, run early; it changed step 4 rather than approving it.
- **Step 4a/4b** — the EVM resolver was built and measured. There are no swaps on those chains
  to resolve, so both are closed rather than pending.
- **Step 5** — the Solana resolver finished: 696 swaps, which is what closed Axis 2.
- **Axes 2 and 5** — both now report their own granularity and coverage instead of implying it.

Assesses [axis-api-queries.md](axis-api-queries.md) — the frontend spec for six 0–100 axes —
against what `genie-fomo-api` returns today.

| | |
| --- | --- |
| Named inputs the spec uses | **22** |
| Available from our API today | **22 — 100%** ✅ |
| Gaps that are *missing data* | **0** |
| Gaps that are *unsurfaced data we already hold* | **0** — closed 2026-09-09 |
| Calls per cohort refresh: their plan vs ours | **~304 vs 1** |

**Every named input the spec asks for is now returned.** The last three were closed on
2026-09-09 — all three were data we already held and simply had not surfaced, so it took no
backfill and no external call.

**Field availability was never the last question.** The two things a field count cannot
express were a **granularity mismatch** on Axis 2, which produced plausible-looking wrong
numbers rather than missing ones, and **coverage** on Axes 4 and 5.

All three are now resolved as far as the available data allows:

- **Axis 4** could not render for 67 of 144 traders. Closed 2026-09-09 by reading balances from
  the chain instead of asking fomo for them — **140 of 144**, and 76.9% of positions priced.
- **Axis 2** returned a per-token statistic where the spec asks for per-exit, with nothing
  saying so. Closed 2026-09-09: `meanToMedianBasis` names the population and `scorecard.perExit`
  carries the exact figure wherever we have one.
- **Axis 5** returns all five inputs and now publishes its own coverage gate. Its ceiling is set
  by fomo's entry prices, not by us; raising it needs a paid provider (§5).

---

## Status — what is fixed, what is not, and how

✅ done and verified live · ⛔ closed after measurement, not abandoned. **Nothing is pending.**

### Per axis

| Axis | State today | What is wrong | The fix | Step |
| --- | --- | --- | --- | --- |
| **1** Cash-out | ✅ **works** | — | — | — |
| **2** Consistency | ✅ **labelled, and exact where we have it** | ~~returns the wrong statistic silently~~ — `meanToMedianBasis` names the population; `perExit` gives the true figure for 105 traders, 9 clearing the 20-exit bar | ✅ shipped 2026-09-09 | ~~4~~ |
| **3** Edge | ✅ **works** | — | — | — |
| **4** Risk control | ✅ **renders for 140 of 144 traders** | — | ✅ balances read from chain, shipped 2026-09-09 | ~~2~~ |
| **5** Selectivity | ✅ **all 5 inputs + the gate published** | nothing on our side — fomo prices 5,904 of 13,184 pairs, so **13 of 141** traders clear the spec's own bar and the rest render hollow **as the spec instructs** | ✅ `entryPriceCoverage.clearsSpecBar` shipped 2026-09-09; raising coverage needs a paid provider | — |
| **6** Activity density | ✅ **works** | — | ✅ shipped 2026-09-09 | ~~1~~ |

### The work, in order

| # | Step | Effort | Confidence | Closes | Status |
| --- | --- | --- | --- | --- | --- |
| **1** | Surface the three §3 gaps — `creation_timestamp`, gini, sub-$1M winrate | ~3h | certain | Axis 6 | ✅ **done 2026-09-09** |
| **2** | Axis 4 — read wallet balances from chain | ~1 day | **high, demonstrated** | Axis 4 | ✅ **done 2026-09-09** |
| **3** | Robinhood spike — measure, ship nothing | ~half a day | — | decides step 4 | ✅ **done 2026-09-09** — see §6 |
| ~~**4a**~~ | EVM resolver — robinhood + ethereum | built | — | nothing — **the trades are not on-chain** | ⛔ **closed 2026-09-09** |
| ~~**4b**~~ | EVM resolver — bsc + base | ~1 day | bitquery works, but only ~41 swaps exist | negligible | ⛔ **not worth starting** |
| **5** | Finish the Solana resolver — 132,128 unresolved | none, script existed | ran at 0.5%, not the 2.7% projected | Axes 2 and 5 | ✅ **done 2026-09-09** — 696 swaps |

**Every step is closed.** 1, 2, 3 and 5 shipped; 4a was built and returned zero because the
trades are not on-chain; 4b was measured and judged not worth starting. Full detail in §6.

### Three things to hold on to

1. **Axes 2 and 5 are one job — but the EVM resolver was never the answer.** It was built
   on 2026-09-09 and a complete on-chain scan returned zero swaps: robinhood's trading is
   matched off-chain and only settles on-chain, in Multicall3 batches. Solana yields swaps at
   fifteen times the rate of the best EVM chain. **The work is finishing Solana, not
   extending to EVM.**
2. **No new provider, no new key.** Every fix runs on `HELIUS_SOLANA_KEY`, `BITQUERY_KEY` or
   a chain's own public RPC, all already configured. The blockers were an API that refuses
   non-cohort handles, and a resolver built for 28% of the trading — neither was ever a
   missing data source.
3. ~~**Axis 2 is the dangerous one.**~~ **Closed 2026-09-09.** It used to return a plausible
   number over the wrong population with nothing in the output saying so. `meanToMedianBasis`
   now names the population and `perExit` carries the true per-exit statistic wherever we have
   one. Shipping it unlabelled is no longer possible, which was the only thing that misled.

---

## 1. What the spec does

Six axes, each scored as a **percentile rank within the cohort** — not an absolute. A score of
73 means "73rd of 100 on this dimension", so every axis is only as meaningful as the cohort is
comparable.

Two rules in it are worth keeping:

- **Null input renders the axis hollow, never zero.** The same distinction this API is built
  on — a missing value is not a bad value.
- **Raw numbers only.** GMGN's own tags and labels never enter the maths.

It fetches from GMGN directly: `profits` (batched), `stats`, `holdings`, `activity` (the last
two paginated per wallet), and derives everything client-side.

---

## 2. Field-by-field alignment

### ✅ Axis 1 — Cash-out

| Spec input | Ours | Match |
| --- | --- | --- |
| `total_realized_profit / total_profit` | `pnl.realizedShare` | exact |
| flow: Σ `history_sold_income` vs Σ `history_bought_cost` | `scorecard.moneyIn.usd` / `moneyOut.usd` | equivalent, with coverage attached |
| null rule: `total_profit = 0` → hollow | `realizedShare` is already `null` unless both sides are positive | exact — and stricter |

Our `realizedShare` refuses to emit a ratio when realized and unrealized disagree in sign,
which the spec does not ask for but wants: without it, −$8,000 realized against −$2,000
unrealized renders as "80% banked" for a trader who lost $10,000.

### ✅ Axis 2 — Consistency

| Spec input | Ours | Match |
| --- | --- | --- |
| `topTradeShare` | `scorecard.topTradeShare` | exact |
| `meanToMedian`, suppressed unless both > 0 | `scorecard.meanToMedian` | **exact, same guard** |
| null rule: < 20 sell rows → hollow | `wins` + `losses`, `sample` | exact |
| per-exit PnL: `cost_usd − buy_cost_usd` | `scorecard.perExit` (exact) · `byToken[].realizedPnlUsd` (per token, labelled) | ✅ **shipped 2026-09-09** — both granularities, each named |

The `meanToMedian` guard is convergent design: both sides independently concluded the ratio is
meaningless across a sign change.

**Cohort coverage, both ways.** 127 of 141 traders clear the ≥20 bar counting **closed
positions**, which is what `meanToMedian` runs on. Counting **real exits**, which is what the
spec means, 105 traders have at least one and **9** clear the bar. Both numbers are returned —
that gap is the honest measure of what we know, and it is why `perExit` exists.

### ✅ Axis 3 — Edge

| Spec input | Ours | Match |
| --- | --- | --- |
| `winrate` | `scorecard.winRate` | exact |
| `sell_count` for shrinkage | `pnl.closedTrades`, `wins`, `losses` | exact |

Shrinkage — `0.5 + (winrate − 0.5) × n/(n+30)` — is client-side maths over two fields we
already return. Nothing needed.

**Cohort coverage:** 140 of 144 (97%).

### ✅ Axis 4 — Risk control

| Spec input | Ours | Match |
| --- | --- | --- |
| `worstExit` | `scorecard.worstTradeUsd` | exact |
| `typicalBet = total_cost / buy_count` | `scorecard.typicalBetUsd.value` | same intent, **different method** |
| `cashShare` over STABLE_MINTS | `portfolio.cashShare` | exact — and we maintain `quote_assets`, so no mint list to keep |
| `concentration = max / Σ usd_value` | `portfolio.concentration` | exact |

`typicalBetUsd` carries a `method` field (`entry_price` or `volume_per_trade`) because the two
give different answers and the response says which was used. The spec assumes one; ours tells
you which you got.

**Cohort coverage was the constraint here and is no longer.** It was 77 of 144 traders with
any holdings row at all; reading balances from the chain took it to **140 of 144**, of which
135 have a priced position and can render the axis today.

The four still out are out honestly: two have no wallet address on record, and two have
wallets that hold nothing on any chain they have traded. Neither is a gap we can close by
asking harder — the first is missing input, the second is a true zero.

### ✅ Axis 5 — Selectivity  ·  *all inputs present; coverage limited by the source*

| Spec input | Ours | Match |
| --- | --- | --- |
| `entryMcap = price_usd × token.total_supply` | `byToken[].avgEntryMarketCapUsd` | **identical formula** |
| `median(entryMcap)` | derivable from `byToken[]` | client-side |
| supply missing > 30% → hollow | `totalSupply`, `supplySource`, `supplyReadAt` returned | exact |
| winrate restricted to sub-$1M entries | `scorecard.smallCapWinRate` | ✅ **shipped 2026-09-09** — per token, states so in `basis` |
| Δt = `timestamp − token.creation_timestamp` | `byToken[].tokenCreatedAt` + `.tokenAgeAtEntryDays` | ✅ **shipped 2026-09-09** — delta computed, not just the raw stamp |

We publish the supply and the timestamp we multiplied by, not just the product, so a consumer
can recompute and disagree with us in a checkable way. Supply on these tokens drifts — one was
measured moving 12.45% in a day.

**All five inputs are now returned.** What limits this axis is coverage, not fields — see §5.

### ✅ Axis 6 — Activity density

| Spec input | Ours | Match |
| --- | --- | --- |
| `activeDays` = distinct days with ≥ 1 trade | `onChain.activeDays` (G2) | exact |
| `tradeCount` | `onChain.swaps` / `.transactions` | exact |
| recency = now − max(`timestamp`) | `onChain.lastActiveAt`, `scorecard.lastTradeAt` | exact |
| cross-check `last_active_timestamp` | `positions[].lastActiveAt` (G1) | exact |
| evenness = 1 − gini(trades per day) | `onChain.evenness` (+ `?dailyTrades=true` for the series) | ✅ **shipped 2026-09-09** |

Our `activeDays` counts distinct calendar days, exactly as specified — a wallet that traded
twice a year apart has 2 active days, not 365.

**Cohort coverage:** 140 of 144 (97%).

---

## 3. The three gaps — all unsurfaced, none missing

### ✅ Closed 2026-09-09 — all three shipped

| Gap | Axis | Now returned as | Verified |
| --- | --- | --- | --- |
| `token.creation_timestamp` | 5 | `byToken[].tokenCreatedAt` + `tokenAgeAtEntryDays` | 170 of 325 tokens for `frankdegods`; entries as young as **0.05 days** |
| gini of trades-per-day | 6 | `onChain.evenness`, `tradesPerActiveDay`, and the series behind `?dailyTrades=true` | `unipcs` evenness **0.0812** over 59 active days |
| winrate for sub-$1M entries | 5 | `scorecard.smallCapWinRate` | **0.4146** — 17 wins of 41 tokens, coverage 135/325 |

**Named inputs: 19/22 → 22/22.** No backfill, no external call — all three read from tables we
already held.

Three decisions worth recording:

- **`tokenAgeAtEntryDays` is computed for you**, not just the raw timestamp. The spec asks for
  `timestamp − creation_timestamp`; buying something four hours old is a different act from
  buying it four months old, and the derived figure says so directly. A creation time of `0`
  is stored as `null` rather than published as 1970.
- **`smallCapWinRate` is per TOKEN, and says so in its own `basis` field.** It cannot be
  per-trade until step 4 lands, and its coverage denominator counts only tokens we could
  *price* — a token with no entry market cap was never judged small or large, so counting it
  either way would be a guess.
- **`evenness` excludes silent days.** The spec defines `activeDays` as days with at least one
  trade, so including zero days would measure how long we have been watching rather than how
  evenly they trade. It is `null` below two active days, where a gini of 0 would read as
  "perfectly concentrated" instead of "nothing to compare".

The series is behind `?dailyTrades=true`: it grows with a wallet's lifetime while nearly every
caller wants only the coefficient. `dailyTradesAvailable` reports its length either way.

---

## 3b. What shipped on 2026-09-09 to close the axis work

Every route was brought up to what the spec asks for, given the data that exists. Two axes
changed shape rather than gaining a field, and both changes are about **not being wrong
quietly** — which is the only failure mode left once every named input is present.

### Axis 2 — it can no longer mislead

The doc has said since the first pass that Axis 2 is "the dangerous one": it does not fail
loudly, it returns a plausible number computed over the wrong population, and *"shipping it
unlabelled is the only option that misleads."* Step 4a established that the EVM resolver which
was meant to fix it cannot be built. So the fix is to make shipping it unlabelled impossible:

| Field | What it does |
| --- | --- |
| `scorecard.meanToMedianBasis` | literally `"per_token"`. The number above it is one point per TOKEN; the spec's formula assumes one per EXIT. The response now says so. |
| `scorecard.perExit` | the **same statistic over real exits** — `meanToMedian`, `exits`, `wins`, `losses`, `meanExitUsd`, `medianExitUsd`, plus `clearsSpecBar` for the spec's own "< 20 sell rows → hollow" rule |

Each `perExit` point is one resolved on-chain sell: proceeds minus what that quantity cost at
the wallet's own average entry, both sides from `wallet_swaps`. Only positions whose buys
**and** sells we resolved contribute — selling something we never saw bought has no cost
basis, and inventing one would be this whole problem in miniature.

**825 true exits across 105 traders; 9 clear the 20-exit bar.** Two counts were taken here and
the smaller one is the one that ships: 1,316 exits across 114 traders have a dollar value, but
only 825 also have a *resolved cost basis on the same token*, and without that the figure is
proceeds rather than P&L. `perExit` uses the strict count. That 9 is far below the 127 the
per-token figure appears to cover, and that gap is the honest measure of what we actually
know. The front end can now use the exact statistic where it exists and a labelled
approximation where it does not, instead of one unlabelled number that silently changes
meaning between traders.

### Axis 5 — the gate is published, not assumed

| Field | What it does |
| --- | --- |
| `scorecard.entryPriceCoverage` | `tokensPriced`, `pricedShare`, `withMarketCap`, `marketCapShare`, `derivedFromChain`, and `clearsSpecBar` |
| `byToken[].entryPriceSource` | `reported` (fomo's) or `chain` (derived from the wallet's own resolved buys) |

`marketCapShare` is the one that matters: an `entryMcap` needs price **and** supply, so it is
always the smaller number and it is the share the axis actually runs on. Publishing it with
`clearsSpecBar` lets the front end apply the spec's 30% rule without recomputing it — and
argue for a different rule with the evidence in hand.

**The chain-derived entry price is wired, correct, and currently adds nothing.** Measured:
**zero** tokens exist where every fomo row lacks an entry price *and* we hold a chain price.
`wallet_swaps` covers almost exactly the tokens fomo already prices. The fallback is a
mechanism that grows as resolution grows, not a win today, and reporting it as a win would be
the kind of number this document exists to prevent.

### Axis 5 — supply now falls back to GMGN's

Found while re-verifying this document. `avgEntryMarketCapUsd` needs price **and** supply, and
it was reading supply only from `tokens.total_supply`, which `load_token_supply.mjs` fills.
That column is null on 5,623 of 13,184 trade pairs — but the T3d crawl leaves a supply in
`token_info` for **5,000 of them**, which the scorecard was simply not looking at.

`scorecardRows` now reads `coalesce(nullif(tokens.total_supply, 0), nullif(token_info.total_supply, 0))`,
and **`supplySource` says which one it used** — an entryMcap built on GMGN's supply is a
different claim from one built on a supply we read ourselves.

Three details worth recording:

- **A stored `0` is nulled before the fallback.** A token cannot have zero supply, so `0` means
  "not read", and multiplying a price by it would publish an entry market cap of **$0** — a
  trader appearing to have got in for nothing.
- **The two sources agree.** Where both exist, they are within 1% on 1,089 of 1,128 tokens and
  within 10% on 1,117. This is the same quantity from a second source, not a different quantity.
- **The gain is small and that is the point.** Pairs that can produce an entryMcap go 5,632 →
  5,711, and traders clearing the coverage bar go **11 → 13**. Supply was never the binding
  constraint — `avg_entry_price` is — so filling it completely still leaves Axis 5 where §5
  says it is. It was worth doing because it was free and correct, not because it moved the axis.

Live: `supplySource` on `frankdegods` now reads `rpc` 112, `helius` 58, `gmgn_token_info` 132,
null 23.

### What remains open, and why it is not an engineering problem

| Axis | Open item | Blocker | Can we fix it? |
| --- | --- | --- | --- |
| **2** | only 9 of 141 traders have ≥20 true exits | needs more resolved swaps; the EVM chains have none to resolve (§6, step 4a) | **no** — not on these chains |
| **5** | `marketCapShare` sits near 0.42; 13 of 141 traders clear the coverage bar | needs a historical price for 1,020 tokens at known timestamps | **no** — needs a paid provider |

Both are now **visible in the response** rather than implied by a number that looks fine.
That is the whole of what was available to fix.

---

## 4. The real risk: granularity, not fields

**This will not announce itself, and it is the thing most likely to cause a wrong number.**

The spec's formulas assume **per-transaction rows** — GMGN's `activity` feed, one record per
buy and per sell, each with `cost_usd` and `buy_cost_usd`. We serve **per-position
aggregates**: one row per (trader, token), because that is the shape fomo gives us.

Two consequences:

- **Axis 2.** `meanToMedian` over our data is a statistic across **tokens**, not across
  **exits**. A trader with 200 exits in 40 tokens produces 40 data points from us and 200 from
  GMGN. Both compute cleanly. They are different numbers, and the difference is invisible in
  the output.
- **Axis 5.** `entryMcap` per buy versus our per-position *average* entry. A position built
  across five buys at rising prices has five entry market caps in their model and one weighted
  average in ours.

Neither is wrong; they answer slightly different questions. But an axis computed from our data
and labelled as if it came from theirs would be a confident wrong answer — the failure mode
this codebase is organised against.

**If per-exit granularity is required, say so early.** It is a different ingestion shape, not a
field to add.

---

## 5. Axis 5's coverage ceiling — 130 of 141 traders render hollow, and why

The spec's own null rule is *"supply missing for > 30% of buys → hollow"*. Measured against our
data:

```
13,184 trader-token pairs
 5,632 (42.7%) can produce an entryMcap   <- needs price AND supply
 7,280 missing avg_entry_price            <- the binding constraint
 5,623 missing total supply
```

Applying their rule per trader:

```
141 traders with any trades
 11 clear the 70%-present bar
130 would render Axis 5 HOLLOW  (92%)
```

Re-measured 2026-09-09 after every backfill completed. Adding GMGN's supply as a fallback
(§3b) moves the first line to **5,711** and traders clearing the bar from 11 to 13. Nothing
else moved, which is the point of §5: the ceiling is fomo's entry-price coverage, and none of
the four routes tried below changed it.

**The constraint is `avg_entry_price`.** Deriving entries from chain was tried and closed
below; better entry prices would have to come from fomo itself.

~~Axis 4 has a milder version of the same problem.~~ **Closed 2026-09-09.** It was 77 of 144;
chain-read balances took it to 140. See §6 Fix 1.

**Recommendation superseded twice, and the second time settles it.**

The first pass said the cause was an unfinished resolver covering only Solana. Step 4a
disproved that: the EVM chains have no on-chain swaps to resolve.

**2026-09-09 — four routes to an entry price were tested and all four are closed.** Every one
was measured, not estimated:

| Route | Result | Verdict |
| --- | --- | --- |
| `wallet_swaps` — derive entry from resolved swaps | fills **7 of 7,280** | the tokens it covers are the ones fomo already prices |
| Algebra — `entry = exit − pnl/qty` | tested against 449 trades whose entry we KNOW: **0 within 10%** | the identity does not hold; `amount` is not the qty relating pnl to the price gap |
| `transactions.value_usd` | would compute over rows that are mostly inbound transfers | this is precisely the T2.2 error that produced 84% disagreement with fomo |
| GMGN historical price | `/v1/token/kline`, `/candles`, `/price`, `/price/history` all **404** | our plan exposes `/v1/token/info` and `/v1/token/security`, nothing else |

The algebra one is worth dwelling on: it looked like a free win, and a naive implementation
would have produced **7,280 plausible entry prices that are all wrong**. It was rejected
because it was checked against entries we already had, not because it looked suspect.

**What the fix would actually take.** The gap is well-shaped — every one of the 7,280 rows
carries an `opened_at`, and they span only **1,020 distinct tokens**, so this is a bounded
job of ~1,020 historical price lookups, not 7,280. If those prices existed, traders clearing
the spec's 70% bar would go **11 → 141**.

**It needs a historical price provider we do not have.** Birdeye, Codex, Moralis, Dexscreener
— all new providers, and historical series is the tier they charge for. Under the standing
constraint of "no paid APIs, no new keys", **Axis 5 cannot be closed.**

**So the decision is a product one, not an engineering one:**

- **Ship it hollow, per the spec.** All five inputs are returned with `entryPriceCoverage`
  attached; the front end renders Axis 5 for the **11** traders who clear the bar and hollow for
  the other **130**. This is the spec behaving as written, not a defect.
- **Or renegotiate the threshold.** The 70% bar is the spec's choice. We already return
  `pricedShare`, so the front end can lower the bar and show what it rests on. That is a
  conversation with the consuming team, and costs nothing to have.

---

## 6. What was tried on each short axis, and what came back

Added 2026-09-09 after digging into *why* each is short. **All three are fixable, none needs a
new provider, and every key required is already configured.** They differ sharply in cost and
in how confident I am, so they are ranked by that rather than by axis number.

### The finding that reframed Axes 2 and 5

Both looked like "the data does not exist". It does — **we only built the resolver for one
chain**:

```
fomo's trades by chain            our on-chain swap resolver
  robinhood   6,301  (47.8%)        ✗ not built
  solana      3,726  (28.3%)        ✓ 2,917 swaps resolved
  bsc         2,354  (17.9%)        ✗ not built
  base          465   (3.5%)        ✗ not built
  ethereum      257   (1.9%)        ✗ not built
```

**72% of trading happens on chains T2.2 never touches.** Not because those chains hide it —
because the resolver uses Helius `pre/postTokenBalances`, a Solana mechanism with no EVM
counterpart in that code path. On Solana the approach works: 2,917 resolved swaps against
3,726 fomo positions, agreeing with fomo **100% on direction and 94% on magnitude**.

Every other chain already has a provider configured and a key on hand:

| Chain | Provider | Key |
| --- | --- | --- |
| robinhood, ethereum | blockscout | none needed |
| bsc, base | bitquery | `BITQUERY_KEY` ✓ |
| solana | helius | `HELIUS_SOLANA_KEY` ✓ — **done** |

**Correction, from step 2.** One entry in that table is wrong, and it is the biggest chain.
`robinhoodchain.blockscout.com` is behind Cloudflare and answers 403 to any client without a
browser, so blockscout is not a route to robinhood for us. Step 2 went to the chain's own RPC
(`chains.rpc`) instead, which is keyless and worked for all four EVM chains — and step 4a later
used the same RPC for `eth_getLogs`. The table above is kept as it was written so the
correction is legible; **the RPC is the route, not blockscout.**

---

### ✅ Fix 1 — Axis 4 · read balances from the chain · **shipped 2026-09-09**

**Blocker.** 67 of 144 traders have no holdings. `build_directory_fomoapi.py` documents why:
*"`/v2/users/{handle}` returns 'trader not found' for anyone outside the top 100 — this cannot
serve arbitrary handles."* 44 of the 67 are outside that cohort and fomo will never serve them;
the other 23 are inside it and returned nothing.

**We were only ever asking fomo.** The chain answers immediately. Demonstrated on `0xangeryy`,
who has zero holdings in our database:

```
getTokenAccountsByOwner  ->  120 token accounts · 81 with a non-zero balance
    43uGwcykUgmtQYrgsSDk   1,220,969.03
    8utEsphosdoGDaPT4KLz           9.48
```

**Why it is the cheap one:** Axis 4 needs a *snapshot* — what they hold now. Axes 2 and 5 need
*history* — every buy and sell, reconstructed and matched. A snapshot is one query per wallet.

| Step | How | Cost |
| --- | --- | --- |
| Solana balances | Helius `getTokenAccountsByOwner` — 61 wallets | one call each, seconds |
| EVM balances | blockscout + bitquery — 63 wallets | ~half a day of plumbing |
| Price any new tokens | the T3d loader, unchanged | 1 req/s over whatever is new |
| Feed `cashShare` / `concentration` | existing portfolio route | none |

**Result: 77 of 144 traders → 140**, of which 135 have a priced position and can render the
axis. After the T3d crawl finished (2,741 tokens, all priced, 0 failures) the positions we can
value went from **29.5% to 76.9%**; that re-pricing pass is now part of the loader rather than
a step someone has to remember.

Four traders remain out, honestly: two have no wallet address on record, and two have wallets
that hold nothing on any chain they have traded — missing input and a true zero respectively.

**What actually shipped**, in `scripts/load_chain_balances.mjs` and
`20260909100000_holdings_chain_source.sql`:

| | |
| --- | --- |
| Chain positions written | **5,419** across 63 traders |
| Transport, solana | Helius `getTokenAccountsByOwner`, both token programs, plus native SOL |
| Transport, all four EVM chains | batched `eth_call balanceOf` against the public RPC already in `chains.rpc` |
| New providers | **none** · **no new key** · nothing paid |

Three things worth recording, because each was a wrong assumption caught by measurement:

- **Robinhood does not go through blockscout**, which is what `chains.history_provider`
  names and what the plan above assumed. `robinhoodchain.blockscout.com` sits behind
  Cloudflare and answers 403 to any client without a browser. The chain's own RPC answers
  the same question for free, so all four EVM chains now share one code path instead of
  three. Its RPC also answers **403 rather than 429** when it wants us to slow down; backing
  off on both is what took robinhood from a lost leg to 1,052 positions.
- **Stablecoins had no price in any table.** Neither `token_info` nor `token_prices` carries
  a row for USDC or USDT, so pricing chain rows through them left every stablecoin balance
  unpriced — and `cashShare` is the one figure that measures exactly those. `quote_assets`
  already had `pegged_usd = 1` for all six; the loader now reads that first.
- **`asOfHoldings()` was a global `max(captured_at)`.** Fomo rows are stamped with one
  nightly build time and chain rows when we read them, so shipping this unchanged would have
  put today's timestamp on a trader whose numbers came from yesterday's fomo build. That is
  the exact complaint the consuming team raised against `/v1/traders`, already fixed once for
  trades and about to be reintroduced for holdings. It is now per trader.

**Nothing moved for the 77 traders fomo already covers.** `holdings_current` resolves per
(trader, network): chain rows fill networks fomo did not cover and never override one it did,
so the two sources are never summed into the same ratio. Verified live — `frankdegods` returns
the same 147 positions, the same 0.6758 concentration and still reports fomo's build time.

---

### ⛔ Fix 2 — Axes 5 and 2 · an EVM swap resolver · **superseded, see step 4a**

*Kept as written. Step 4a built it and measured zero swaps; the reasoning below was sound and the premise was wrong.*

These are one project, not two: both want per-trade detail, and both are short for the same
reason. Extending the resolver to EVM addresses the missing 72% — robinhood alone is nearly
half of all trades.

**The method is proven; the yield on EVM is not.** On Solana only 2.8% of scanned events turned
out to be the trader's own two-sided swap — the rest were inbound transfers arriving in their
token account. EVM has no token-account indirection, so the rate could be better, or worse. **I
have no measurement and will not estimate one.**

| | |
| --- | --- |
| Build EVM resolver — net `Transfer` logs per wallet per receipt | ~2-3 days |
| Backfill across 4 chains | hours; keys already held |
| Plausible effect on Axis 5 entry-price coverage | 43% → 70%+ |
| Plausible effect on Axis 2 sell rows | ~3.5x |

**Do the spike first.** Half a day on robinhood alone — 48% of trades, one provider — resolving
a few hundred transactions and measuring two numbers: what fraction are the trader's own
two-sided swaps, and how many entry prices that yields. That decides whether the remaining
2-3 days produces working axes or two rings that are still hollow.

This is the same discipline that saved days on T2.2: scoped in twenty minutes, found 0%, did
not build — then re-scoped against the right API and shipped it.

---

### Build order — as planned, and as it turned out

The plan's central claim was that Axes 2 and 5 are ONE job unblocked by one EVM resolver:

```
Axis 2 needs   per-exit rows (one per sell)   wallet_swaps already gives this — Solana only
Axis 5 needs   entry price per buy            wallet_swaps already gives this — Solana only
both blocked by                               no EVM resolver · 71% of trades are non-Solana
```

**The first half held; the second did not.** They are one job, and the resolver was built —
but there was nothing on those chains for it to resolve. Axis 2 was closed by labelling and
`perExit` instead, and Axis 5's ceiling turned out to be fomo's entry prices rather than our
resolver. The steps below are kept in the order they were run.

---

#### ✅ Step 1 — Surface the three §3 gaps · **done 2026-09-09**

Nothing to research; the data is in the database.

- `creation_timestamp` onto `byToken[]` — from `token_info.raw`, 90.8% coverage
- `evenness` (or a daily trade histogram) — from `transactions.block_time`
- sub-$1M winrate — already client-computable, just document it

**Done when:** Axis 6 has all five inputs and named inputs go 19/22 → 22/22. **Met.**
**Closes:** Axis 6 completely. ✅

---

#### ✅ Step 2 — Axis 4, chain balances · **done 2026-09-09**

The only step already demonstrated end to end before it began: `0xangeryy` has zero holdings
in our database and 81 non-zero balances readable in one call.

- Solana — Helius `getTokenAccountsByOwner`, 61 wallets, one call each ✅ as planned
- EVM — ~~blockscout + bitquery~~ **batched `eth_call balanceOf` on each chain's own public
  RPC**, 63 wallets. blockscout is Cloudflare-blocked for robinhood, and the RPC route needs
  no key at all, so all four EVM chains share one code path
- Price anything new through the existing T3d loader ✅ — plus a re-pricing pass, because the
  loader runs *after* the chain read discovers the tokens
- Feed the existing `portfolio` route; `cashShare` and `concentration` need no change ✅

**Done when:** traders with holdings goes 77 → ~142 (only the 2 with no wallet address remain
out). **Met: 140**, plus 2 wallets that genuinely hold nothing.
**Closes:** Axis 4. ✅

Amounts were checked against an independent source rather than eyeballed: fomo's own reported
trade quantities, which our chain reads match to the decimal on 7 of 8 sampled positions. The
eighth differs because the trader added to it since — which is the point of reading the chain.

---

#### ✅ Step 3 — Robinhood spike · **run 2026-09-09** · it moved the target

Ran early and cheaply, off the back of step 2. It did not produce the two numbers it set out
to produce, because it found the question was wrong.

**Finding 1 — the EVM transactions we already store are not the trades.** We hold 50,530
robinhood rows, 14,546 bsc, 7,059 base, 3,498 ethereum, each with `direction`, `token_key`
and `amount` already populated. That looked like a resolver's raw material sitting in the
database. It is not:

```
two-sided within one tx_hash   robinhood 23 of 49,248   bsc 86 of 14,401   base 17   eth 10
sampled receipts read FROM CHAIN     0 of 50 two-sided · avg 1.0 transfer legs per tx
our trader's wallet was the tx SENDER in            0 of 50
```

They are overwhelmingly inbound transfers — airdrops and distributions, not trades. **Step 4
cannot be built by reprocessing what we hold.** That is the finding, and it is worth more
than the two numbers the spike was scoped to produce.

**Finding 2 — the blocker is DISCOVERY, not decoding.** We do not have the trading
transactions at all. What it takes to find them differs sharply per chain, and two entries
in the provider table above are wrong:

| Chain | Share of trades | Discovery route | Status |
| --- | --- | --- | --- |
| solana | 28.3% | Helius | ✅ done (T2.2) |
| **robinhood** | **47.8%** | its own RPC, `eth_getLogs` by Transfer topic | ✅ **measured working, keyless** |
| ethereum | 1.9% | Etherscan V2, `ETHERSCAN_KEY` | ✅ free tier serves chainid 1 |
| bsc + base | 21.4% | Etherscan V2 refuses these on the free tier | ⛔ **decided** — bitquery works, but only ~41 swaps exist to find (step 4b) |

Robinhood — the chain that matters most — is the one that came back cleanest. Its RPC accepts
**2,000,000-block ranges** and **topic arrays**, so one query covers sixty wallets at once:
60 wallets over 500k blocks returned 2,777 logs. Whole-chain discovery for all 139 wallets is
on the order of **180 requests**, not the 162,000 a naive per-wallet scan would need.

**Finding 3 — attribution must not use `tx.from`.** The wallet was the sender in 0 of 50.
These traders trade through relayers, exactly as T2.2 found on Solana, where assuming
`feePayer` was the trader was the second of two wrong diagnoses. Net balance change per
(wallet, token) is the method that survived there and it is the method to use here.

**Done when:** ~~those two numbers exist~~ — superseded. The gate has answered: **build it for
robinhood + ethereum, decide separately on bsc + base.**

---

#### ⛔ Step 4a — EVM resolver, robinhood + ethereum · **BUILT AND MEASURED 2026-09-09 · the trades are not on-chain**

`scripts/resolve_evm_swaps.mjs` is written, working and committed. It found **zero swaps**,
and the reason is not a bug in it — it is that the trades it was built to resolve do not
exist on those chains.

**What was run.** A complete `eth_getLogs` scan of robinhood direct from the chain — not a
sample, not our stored ingest — over 2,000,000 blocks, every wallet OR'd into the topic array:

```
robinhood   30,384 (tx, wallet) candidates  ->      0 two-sided swaps
ethereum     3,565 candidates via Etherscan ->      0 two-sided swaps
```

**Why.** Grouping every Transfer log by (transaction, wallet) and netting it:

```
one token leg     5,277 of 5,297     <- a transfer, not a trade
two token legs           13          <- and those are token<->token, no quote side
groups touching a quote asset       179, nearly all single-leg deposits
```

The transactions our wallets appear in are addressed to **Multicall3**
(`0xca11bde05977b3631167028862bE2a173976CA11`) and carry 50-100 Transfer logs each. They are
**batch distributions**, and our wallet is one recipient among a hundred. Robinhood Chain
carries tokenised equities — NVDA, GME, AMC, COST, GLD — and the matching happens in
Robinhood's own order book. Only settlement reaches the chain. There is no swap to resolve.

Confirmed against every stored EVM transaction we hold, and against Solana as a control:

| Chain | (tx, wallet) groups | 2+ token legs | 1 quote + 1 token = a swap | rate |
| --- | --- | --- | --- | --- |
| **solana** | 391,934 | 9,260 | **4,696** | **1.20%** |
| robinhood | 49,248 | 570 | 40 | 0.08% |
| bsc | 14,401 | 132 | 25 | 0.17% |
| base | 6,675 | 124 | 16 | 0.24% |
| ethereum | 3,443 | 1 | 0 | 0.00% |

Solana yields swaps at **fifteen times** the rate of the best EVM chain, and the EVM total
across all four chains is **81 swap-shaped groups**. The resolver is not the constraint.

**One thing the build did produce, and it matters.** robinhood had **zero** `quote_assets`
rows, so no resolver could ever have worked there. Adding them meant identifying the quote
currency, and the obvious candidate — symbol `USDC` at
`0x3ae0689f64b8a7683d06a9e358d7346dc5e71e18` — reports `name()` = **"Unstable Coin"** with 18
decimals. It is a memecoin wearing USDC's ticker. Adding it would have valued every holding
of it at $1 and counted it as cash in Axis 4's `cashShare`: a wrong number that would have
looked entirely reasonable. The real quote assets are **USDG** (Paxos Global Dollar, 6
decimals, the most-transferred token on the chain) and **WETH**, and those are what shipped.
**A token's `symbol` is attacker-controlled; only `name()` caught this.**

---

#### ⛔ Step 4b — bsc + base · **not worth starting**

`BITQUERY_KEY` was tested and **works** — a live BSC query returned 200 with real data, so the
provider question has an answer. It is the wrong question. bsc and base carry **25 and 16**
swap-shaped groups between them. A perfect bitquery integration would resolve roughly forty
swaps across 124 traders. **Do not spend the day.**

---

#### ✅ What replaces step 4 — finish the Solana resolver

The measurement that reframed everything: `wallet_swaps` held **2,917** Solana swaps, and
**132,128 SWAP-tagged transactions had never been resolved**. T2.2 was run once with a limit
and never completed.

**Run to completion 2026-09-09: 696 new swaps, 0.5%, zero RPC failures.**

**The estimate was wrong and it is worth saying why.** A 600-row sample returned 2.7%,
matching T2.2's documented 2.8%, and that projected ~3,500. The sample was drawn
`order by block_time desc` — the newest transactions — and the yield on the older 130,000 is
roughly a fifth of that. **A sample taken in the resolver's own default order is not a random
sample**, and the projection inherited its bias. The right number was always going to come
from running it, which cost 45 unattended minutes.

| | |
| --- | --- |
| Effort | **none — the script exists and is proven** (`resolve_wallet_swaps.mjs`) |
| Runtime | ~45 min |
| External APIs | Helius, `HELIUS_SOLANA_KEY`, already held |
| Backfill | yes, but idempotent and resumable — it only takes rows not already resolved |
| Bought | 696 swaps · `wallet_swaps` now 3,629 rows, all priced, across 122 wallets · 825 exits carry a real cost basis, which is what Axis 2's `perExit` runs on |

Solana is where the swaps actually are, it is 28.3% of trades, and it is the one chain where
this method is measured to work — 100% direction agreement and 94% on magnitude against fomo.

---

#### ~~Step 4 — EVM resolver~~ · the original plan, kept for the record

*Superseded by steps 4a and 4b above. Kept so the reasoning that led there stays legible.*

The EVM equivalent of Solana's pre/post balances: decode `Transfer` logs and net them per
wallet. Same idea as `resolve_wallet_swaps.mjs`, different plumbing per chain. Step 3 split
this into two jobs that should be scheduled separately:

**4a — robinhood + ethereum · ~1-1.5 days · high confidence · 49.7% of trades.** Discovery is
measured and keyless. Two phases: scan `eth_getLogs` by Transfer topic with all wallets OR'd
into the topic array, then net each transaction per (wallet, token) and keep the two-sided
ones. Attribution by net balance change, never by `tx.from`.

**4b — bsc + base · ~1 day · 21.4% of trades · needs a decision first.** Etherscan V2's free
tier refuses both chains. `BITQUERY_KEY` is held and already sourced our existing bsc/base
rows, so that is the likely route, but its free-tier limits have not been measured against a
full backfill. **Worth confirming before starting, not during.**

- write into the existing `wallet_swaps` table — the shape already fits
- backfill is real this time: discovery writes new `transactions` rows, resolution writes
  `wallet_swaps`, then pricing. Hours of runtime, keys already held for 4a

**Done when:** Axis 5's entry-price coverage clears its own 70% bar and Axis 2 has ≥20 sell
rows for most traders. **If the spike says that is not reachable, do not start** — renegotiate
the thresholds instead.
**Closes:** Axes 2 and 5 together.

---

### Summary of the order

| # | Step | Effort | Confidence | Closes |
| --- | --- | --- | --- | --- |
| 1 | Surface the three §3 gaps | ~3h | certain | Axis 6 ✅ **done** |
| 2 | Axis 4 chain balances | ~1 day | **high — demonstrated** | Axis 4 ✅ **done** |
| 3 | Robinhood spike | ~half a day | — | decides step 4 ✅ **done** |
| ~~4a~~ | EVM resolver — robinhood + ethereum | built | ⛔ the trades are not on-chain | nothing |
| ~~4b~~ | EVM resolver — bsc + base | ~1 day | ⛔ only ~41 swaps exist | negligible |
| 5 | Finish the Solana resolver | none — script exists | **proven** | Axes 2 and 5 |

**Steps 1, 2 and 3 are done.** Step 3 was run early off the back of step 2 and cost far less
than the half day budgeted, because the decisive measurements turned out to be SQL over data we
already had plus fifty receipts read from chain. It changed step 4 rather than merely approving
it — see §6.

### ✅ A note on Axis 2 being "broken" — resolved 2026-09-09

It never errored or returned nothing. It **computed cleanly and returned a different
statistic** — a `meanToMedian` across tokens rather than across exits — which is the dangerous
kind of broken, because the output looks correct.

The instruction here used to read *"until step 4 lands, either label it or hold it back."* Step
4 cannot land. So the labelling became the fix rather than the stopgap: `meanToMedianBasis`
names the population on every response, and `perExit` carries the exact per-exit statistic for
the traders who have one. **Shipping it unlabelled is no longer possible**, which was the only
thing that misled.

---

## 7. The architectural case for pointing at us

| | Their plan (direct to GMGN) | Ours |
| --- | --- | --- |
| Calls per cohort refresh | `profits` 4 + `stats` 100 + `holdings` 100+ + `activity` 100+ ≈ **304+** | **1** |
| Wall time | ≥ 5 min at GMGN's 1 req/s, more with paging | **5.8s** (144 traders, 996 KB) |
| Rate-limit handling | needed, per the spec's own step 6 | not needed |
| Key management | GMGN key in the frontend | none — our API is keyless |

```bash
curl -s "$B/traders?include=pnl,scorecard,wallets,trust"
```

Beyond speed, three things come free that the spec has no way to produce:

- **Coverage on every derived figure.** The spec has no mechanism to know a `meanToMedian`
  rests on 6% of the record. Ours states it.
- **Provenance.** `tier: reported | verified | third_party` on every number — fomo's, ours from
  chain, or GMGN's. The axis maths is meant to use raw numbers only; `tier` is how you enforce
  that.
- **The GMGN token data we already cache** (G7–G12): honeypot flags, chain-wide concentration,
  wallet tags, creator signals. 67 of the tokens in this cohort are confirmed honeypots.

---

## 8. Two smaller notes

**Cohort size.** The spec assumes 100 traders; we now carry **144**. Percentile ranks shift
with cohort size, so any scores computed against the old assumption are not comparable.

**The demo key.** `gmgn_solbscbaseethmonadtron` is in the spec as a public demo key. Our own
GMGN key is already configured server-side for G7–G12 — the frontend should not need one at
all if it reads from us.

---

## 9. Summary

| Axis | Alignment | Blocker | Fix (§6) | Confidence |
| --- | --- | --- | --- | --- |
| 1 Cash-out | ✅ full | — | — | — |
| 2 Consistency | ✅ **full** — labelled + `perExit` | 9 of 141 have ≥20 true exits | ✅ shipped 2026-09-09 | — |
| 3 Edge | ✅ full | — | — | — |
| 4 Risk control | ✅ **full** — 4 of 4 inputs | — | ✅ chain balances, shipped | — |
| 5 Selectivity | ✅ 5 of 5 inputs + published gate | needs historical prices | ⛔ paid provider only | — |
| 6 Activity density | ✅ **full** — 5 of 5 inputs | — | ✅ shipped 2026-09-09 | — |

**100% of named inputs, and every axis either complete or reporting its own limit.** All six
return what the spec names. Four are complete. Axis 2 returns both granularities, each labelled,
so the exact figure is used where it exists and the approximation is never mistaken for it.
Axis 5 returns all five inputs and publishes the coverage gate, so it hollows exactly where the
spec says it should.

**Nothing shipped here needed a new provider or a new key.** The one thing that would move Axis
5 further — historical prices for 1,020 tokens — is the only item on this page that does, and it
is a product decision rather than an engineering one (§5).

**No open engineering work remains against this spec.**

