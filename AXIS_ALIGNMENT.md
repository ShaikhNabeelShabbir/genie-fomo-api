# Axis spec ↔ our API — alignment report

**Generated: 2026-09-09** · measured against the live service, not read off the code.
**Updated 2026-09-09** with §6 — how to fix the three ⚠️ axes, after a second research pass.
**Step 1 shipped 2026-09-09** — all three §3 gaps surfaced. **Named inputs now 22/22.**
**Step 2 shipped 2026-09-09** — chain-read balances. **Axis 4 goes from 77 traders to 140.**

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

**Field availability is no longer the question.** What remains is one thing a field count
cannot express: a **granularity mismatch** on Axes 2 and 5, which produces plausible-looking
wrong numbers rather than missing ones, and the **coverage** behind Axis 5, which would still
render hollow for 92% of traders under the spec's own null rule. Both are addressed in §6.

Axis 4's coverage problem — it could not render for 67 of 144 traders — was closed on
2026-09-09 by reading balances from the chain instead of asking fomo for them.

---

## Status — what is fixed, what is not, and how

Update the boxes as work lands. ⬜ not started · 🔄 in progress · ✅ done and verified live.

### Per axis

| Axis | State today | What is wrong | The fix | Step |
| --- | --- | --- | --- | --- |
| **1** Cash-out | ✅ **works** | — | — | — |
| **2** Consistency | ⚠️ **computes, but returns the wrong statistic** | `meanToMedian` is across TOKENS, not across EXITS. It does not error — the output looks correct | EVM swap resolver → per-exit rows | **4** |
| **3** Edge | ✅ **works** | — | — | — |
| **4** Risk control | ✅ **renders for 140 of 144 traders** | — | ✅ balances read from chain, shipped 2026-09-09 | ~~2~~ |
| **5** Selectivity | ⚠️ **would render hollow for 92% of traders** | 7,280 of 13,184 positions have no entry price. Its two *other* inputs are now live | EVM swap resolver → entry price per buy | **4** |
| **6** Activity density | ✅ **works** | — | ✅ shipped 2026-09-09 | ~~1~~ |

### The work, in order

| # | Step | Effort | Confidence | Closes | Status |
| --- | --- | --- | --- | --- | --- |
| **1** | Surface the three §3 gaps — `creation_timestamp`, gini, sub-$1M winrate | ~3h | certain | Axis 6 | ✅ **done 2026-09-09** |
| **2** | Axis 4 — read wallet balances from chain | ~1 day | **high, demonstrated** | Axis 4 | ✅ **done 2026-09-09** |
| **3** | Robinhood spike — measure, ship nothing | ~half a day | — | decides step 4 | ✅ **done 2026-09-09** — see §6 |
| ~~**4a**~~ | EVM resolver — robinhood + ethereum | built | — | nothing — **the trades are not on-chain** | ⛔ **closed 2026-09-09** |
| ~~**4b**~~ | EVM resolver — bsc + base | ~1 day | bitquery works, but only ~41 swaps exist | negligible | ⛔ **not worth starting** |
| **5** | Finish the Solana resolver — 132,128 unresolved | **none, script exists** | **proven, 2.7% sampled** | Axes 2 and 5 | 🔄 **running** |

**Steps 1, 2 and 3 are done.** Step 3 was the decision gate, and it has answered: build the
resolver for robinhood + ethereum (49.7% of trades, discovery measured and keyless), and settle
the provider question for bsc + base before starting those. Full detail in §6.

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
3. **Axis 2 is the dangerous one.** It does not fail loudly — it returns a plausible number
   computed over the wrong population. Until step 4 lands, either label it as per-token on the
   front end or hold it back. Shipping it unlabelled is the only option that misleads.

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
| per-exit PnL: `cost_usd − buy_cost_usd` | `byToken[].realizedPnlUsd` | ⚠️ **per token, not per exit** — see §4 |

The `meanToMedian` guard is convergent design: both sides independently concluded the ratio is
meaningless across a sign change.

**Cohort coverage:** 127 of 144 traders (88%) clear the ≥20-exit bar.

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

### ⚠️ Axis 5 — Selectivity  ·  *all inputs present, coverage-limited*

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

## 5. Coverage warning — Axis 5 would render hollow for 92% of traders

The spec's own null rule is *"supply missing for > 30% of buys → hollow"*. Measured against our
data:

```
13,184 trader-token pairs
 5,692 (43.2%) can produce an entryMcap
 7,280 missing avg_entry_price      <- the binding constraint
 1,764 missing total supply
```

Applying their rule per trader:

```
141 traders with any trades
 11 clear the 70%-present bar
130 would render Axis 5 HOLLOW  (92%)
```

**The constraint is `avg_entry_price`, not supply** — 7,280 pairs lack the price against 1,764
lacking supply. Adding GMGN supply moves coverage from 5,632 to 5,692 pairs, which is nothing.
Fixing this means better entry prices from fomo, or deriving entries from chain, and neither is
a small change.

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
the spec's 70% bar would go **14 → 141**.

**It needs a historical price provider we do not have.** Birdeye, Codex, Moralis, Dexscreener
— all new providers, and historical series is the tier they charge for. Under the standing
constraint of "no paid APIs, no new keys", **Axis 5 cannot be closed.**

**So the decision is a product one, not an engineering one:**

- **Ship it hollow, per the spec.** All five inputs are returned with `coverage` attached; the
  front end renders Axis 5 for the 14 traders who clear the bar and hollow for the other 127.
  This is the spec behaving as written, not a defect.
- **Or renegotiate the threshold.** The 70% bar is the spec's choice. We already return
  `pricedShare`, so the front end can lower the bar and show what it rests on. That is a
  conversation with the consuming team, and costs nothing to have.

---

## 6. How to fix the three ⚠️ axes

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

⚠️ **Step 2 found one entry in that table to be wrong, and it is the biggest chain.**
`robinhoodchain.blockscout.com` is behind Cloudflare and answers 403 to any client without a
browser, so blockscout is not a route to robinhood for us. Step 2 went to the chain's own RPC
(`chains.rpc`) instead, which is keyless and worked for all four EVM chains. Whether that also
serves step 4 is a different question — a balance is one `eth_call`, while a resolver needs
receipts and logs — but **step 3's spike should budget for the RPC path, not blockscout.**

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

**Result: 77 of 144 traders → 140.** 135 of them have a priced position and can render the
axis today. Four remain out: 2 have no wallet address at all, and 2 have wallets that hold
nothing — a true zero, not a gap.

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

### Fix 2 — Axes 5 and 2 · an EVM swap resolver · ~2-3 days · **medium confidence**

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

### Build order

**The single most important thing here: Axes 2 and 5 are ONE job, not two.** Both want
per-trade detail, both are short for the same reason, and both are unblocked by the same
resolver. Planning them as separate workstreams would build the same thing twice.

```
Axis 2 needs   per-exit rows (one per sell)   wallet_swaps already gives this — Solana only
Axis 5 needs   entry price per buy            wallet_swaps already gives this — Solana only
both blocked by                               no EVM resolver · 71% of trades are non-Solana
```

---

#### Step 1 — Surface the three §3 gaps · ~3h · certain

Nothing to research; the data is in the database.

- `creation_timestamp` onto `byToken[]` — from `token_info.raw`, 90.8% coverage
- `evenness` (or a daily trade histogram) — from `transactions.block_time`
- sub-$1M winrate — already client-computable, just document it

**Done when:** Axis 6 has all five inputs and named inputs go 19/22 → 22/22.
**Closes:** Axis 6 completely.

---

#### ✅ Step 2 — Axis 4, chain balances · **done 2026-09-09**

The only step already demonstrated end to end before it began: `0xangeryy` has zero holdings
in our database and 81 non-zero balances readable in one call.

- Solana — Helius `getTokenAccountsByOwner`, 61 wallets, one call each
- EVM — blockscout (robinhood, ethereum) + bitquery (bsc, base), 63 wallets
- Price anything new through the existing T3d loader
- Feed the existing `portfolio` route; `cashShare` and `concentration` need no change

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
| **bsc + base** | **21.4%** | Etherscan V2 **refuses these on the free tier** | ⚠️ needs bitquery, or a decision |

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

The measurement that reframed everything: `wallet_swaps` holds **2,917** Solana swaps, and
**132,128 SWAP-tagged transactions have never been resolved**. T2.2 was run once with a limit
and never completed. A 600-row sample returned **2.7%** — matching T2.2's documented 2.8% —
so finishing it is worth roughly **3,500 more swaps**.

| | |
| --- | --- |
| Effort | **none — the script exists and is proven** (`resolve_wallet_swaps.mjs`) |
| Runtime | ~45 min |
| External APIs | Helius, `HELIUS_SOLANA_KEY`, already held |
| Backfill | yes, but idempotent and resumable — it only takes rows not already resolved |
| Buys | Solana's entry-price coverage, today **38.7%** with 2,283 pairs missing |

Solana is where the swaps actually are, it is 28.3% of trades, and it is the one chain where
this method is measured to work — 100% direction agreement and 94% on magnitude against fomo.

---

#### ~~Step 4 — EVM resolver~~ · superseded by the two entries above

#### Original step 4 plan, kept for the record


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
| 1 | Surface the three §3 gaps | ~3h | certain | Axis 6 |
| 2 | Axis 4 chain balances | ~1 day | **high — demonstrated** | Axis 4 ✅ **done** |
| 3 | Robinhood spike | ~half a day | — | decides step 4 ✅ **done** |
| ~~4a~~ | EVM resolver — robinhood + ethereum | built | ⛔ the trades are not on-chain | nothing |
| ~~4b~~ | EVM resolver — bsc + base | ~1 day | ⛔ only ~41 swaps exist | negligible |
| 5 | Finish the Solana resolver | none — script exists | **proven** | Axes 2 and 5 |

**Steps 1, 2 and 3 are done.** Step 3 was run early off the back of step 2 and cost far less
than the half day budgeted, because the decisive measurements turned out to be SQL over data we
already had plus fifty receipts read from chain. It changed step 4 rather than merely approving
it — see §6.

### A note on Axis 2 being "broken"

It is worth being precise: Axis 2 does not error or return nothing. It **computes cleanly and
returns a different statistic** — a `meanToMedian` across tokens rather than across exits. That
is the dangerous kind of broken, because the output looks correct. Until step 4 lands, either
label the axis as per-token on the front end, or hold it back. Shipping it unlabelled is the
one option that misleads.

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
| 2 Consistency | ✅ fields, ⚠️ granularity | per-token vs per-exit | EVM resolver, ~2-3d | medium |
| 3 Edge | ✅ full | — | — | — |
| 4 Risk control | ✅ **full** — 4 of 4 inputs | — | ✅ chain balances, shipped | — |
| 5 Selectivity | ✅ 5 of 5 inputs | 92% would render hollow | EVM resolver, ~2-3d | medium |
| 6 Activity density | ✅ **full** — 5 of 5 inputs | — | ✅ shipped 2026-09-09 | — |

**100% of named inputs as of 2026-09-09** — the three §3 gaps are closed. The remaining ⚠️ axes
are all fixable (§6) — Axis 4 in a day with high confidence, Axes 2 and 5 together in 2-3 days
behind a half-day spike that decides whether to start.

**Nothing here needs a new provider or a new key.** The blockers were an API that refuses
non-cohort handles, and a resolver we built for 28% of the trading.

