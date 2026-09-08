# GMGN parity — what to build, in what order, and what not to build

Companion to [GMGN_GAP_ANALYSIS.md](GMGN_GAP_ANALYSIS.md), which lists the gaps. This file
decides **which of them are worth closing, in what order, and what each actually costs.**

**Created 2026-09-08.** Every figure below was measured against the live database on that
date, not estimated. Where a number decides a design, the query that produced it is named.

---

## 0. How to use this file

Each item carries a status box. Update it in place as work lands, the way `DEBUGGING_PLAN.md`
was used for the bug report.

| Box | Meaning |
| --- | --- |
| ⬜ | not started |
| 🔄 | in progress |
| ✅ | done and verified live |
| ❌ | deliberately not doing — reason recorded |

---

## 1. The filter every item is judged against

The project's governing constraint, stated when the Supabase migration began:

> *"We need to minimize the external API calls and try to compute the data as much as
> possible through our own DB."*

That splits GMGN's surface into four groups, and the split is not about difficulty — it is
about **whether the answer exists in our data at all**:

| Tier | Meaning | External calls at request time |
| --- | --- | --- |
| **T1** | Computable from rows we already hold | none | — ✅ 5 of 5 done |
| **T2** | Computable after a one-off backfill, then free forever | none | — 1 done, 1 blocked |
| **T3** | Inherently external — describes the whole chain or a contract, not our traders | cached proxy |
| **T4** | Does not fit what this product is | n/a |

**The T3 line is the important one.** `holder_count`, `is_honeypot`, `buy_tax` and
`top_10_holder_rate` are facts about a token across all of its holders. We observe 137
traders. No amount of our own data produces them, and computing them from our slice and
publishing them under GMGN's names would be the worst thing we could do — a number that looks
authoritative and is silently scoped to 0.1% of the chain. If we serve these at all, we proxy
and label them.

---

## 2. Already closed — do not re-plan these

The gap analysis was written before the bug-report work. Three of its rows are already done,
and the corrections are recorded in the analysis itself.

| Gap as listed | Status |
| --- | --- |
| Batch queries, 1–100 wallets | ✅ **ISSUE-8** — `?include=pnl,scorecard,wallets,trust`, 137 traders in one 5.2s call. GMGN's equivalent is P&L-only and caps at 100. |
| Rate-limit headers | ✅ **ISSUE-7** — all four on every response including the 429, CORS-exposed. GMGN publishes theirs on 429 only. |
| `avg_cost` / `avg_sold` | ✅ **ISSUE-4** — `avgEntryPrice`/`avgExitPrice` as genuine quantity-weighted averages, plus `entryMethod` naming which computation ran. |

---

## 3. What we hold today

Measured 2026-09-08. This is the raw material every T1/T2 item draws on.

```
transactions   383,825      of which tx_type='SWAP'   114,566
holdings        25,327      (dated generations, 8 builds)
trades          12,137
tokens           3,112      symbol, total_supply, decimals, supply_source
trader_stats       800
traders            137
wallets            134
```

`transactions` climbs continuously — the Helius webhook ingests live, and this count rose by
166 rows during the hour this file was written. Treat it as a snapshot; the *ratios* below are
what the decisions rest on, and those are stable.

**Three findings that shape everything below.**

**Finding 1 — we stored the quote leg, not the memecoin leg.**

```
swap rows whose token is a known quote asset   106,226   (92.7%)  across just 3 distinct tokens
swap rows for any other token                    8,381   ( 7.3%)  across 516 tokens
```

So for a typical swap we know *"this wallet moved 1.5 SOL"* and not *"…and received 12M
PEPE"*. That is enough to value the trade in dollars and not enough to derive a per-token
price.

**Finding 2 — both legs are present for only 3.4% of swap events.**

```
swap events (network, tx_hash, address)   96,599
  with 2+ token legs stored                3,265   (3.4%)
```

Counter-leg valuation — deriving a memecoin's price from the stable side of the same swap —
therefore works on 3.4% of events, not the majority. This is the single fact that most
changes what is buildable, and it is why §5 exists rather than a line saying "price the
swaps".

**Finding 3 — `raw` is empty.**

```
transactions   383,825      with raw JSON   0
```

No fee data was retained, so `gas_usd` is not derivable from what we have. It needs
re-ingestion, which is why it sits in T4 rather than T2.

---

## 4. T1 — computable now, no external calls

Cheap, aligned with the principle, and each is a real GMGN field we currently lack.

### T1.1 ✅ Position timing — `start_holding_at`, `end_holding_at`, `last_active_timestamp`

**Why it is free:** `transactions` has `block_time` and `direction` per wallet per token.
First `in` is when they started holding; last `out` is when they stopped; the max `block_time`
per wallet is their last activity.

**Where:** new fields on `/traders/:handle/positions` and `/tokens/:address/activity`.

**Watch for:** our transaction history starts 2026-01-02 while trades go back to 2025-09-24.
A "first buy" derived from chain is a *floor*, not the truth, for the 0.6% of trades that
predate ingestion. It must be labelled — `startHoldingAtBasis: "chain history from 2026-01-02"`
— or it is a confident wrong answer.

**Effort:** ~3h.

### T1.2 ✅ Wallet activity counters — trade frequency, active days, buy/sell split

**Why it is free:** counts and date-groupings over `transactions`.

**Maps to:** GMGN's `buys_{window}` / `sells_{window}` / `swaps_{window}` shape, scoped to
our traders.

**Effort:** ~3h.

### T1.3 ✅ Our-universe holder concentration — **must not be named `top_10_holder_rate`**

**Why it is free:** `holdings_current` grouped by token gives the distribution across the
traders we track.

**The naming is the whole point.** GMGN's `top_10_holder_rate` is supply across *all* chain
holders. Ours would be across *137 leaders*. Same word, different denominator, and the
difference is enormous. Publish as `leaderConcentration` with an explicit
`basis: "137 tracked traders, not all chain holders"`.

**Effort:** ~2h. **Blocks:** nothing. **Blocked by:** agreeing the name.

### ✅ T1.1–T1.3 shipped — 2026-09-08

All three landed as pure code: no migration, no backfill, no external calls, no new tables.
Verified live, 16/16 routes still 200.

| Item | Where | Live result |
| --- | --- | --- |
| **T1.1** | `/traders/:handle/positions` | `startHoldingAt`, `endHoldingAt`, `lastActiveAt` per position, plus a `chainHistory` envelope. unipcs: 45 positions with timing, 52 without. |
| **T1.2** | `/traders/:handle` | `onChain` block — 29,757 transactions, 13,053 swaps, 480 tokens touched, 17 active days, `tier: "verified"`. |
| **T1.3** | `/tokens/:address` | `leaderConcentration` — top1 `0.1718`, top3 `0.3783`, top10 `0.7156` across 72 leaders, coverage 72/72. |

**The naming decision was made as proposed:** `leaderConcentration`, never `top_10_holder_rate`.
For our top-ranked token GMGN's chain-wide figure is `0.1974` and our tracked-leader share is
`0.4234` — same shape, same plausible magnitude, different denominators. The `basis` string
says so in the response and points at GMGN's field by name.

**A performance bug I introduced and then removed.** The first cut fetched the history floor
with `select min(block_time) from transactions`. `block_time` leads no index, so it planned as
a **Parallel Seq Scan over 384k rows — 7.9s measured** — on every request, to produce one
constant. `/positions` went from ~2.8s to 4.1s before I caught it. The floor is now derived in
memory from rows the route already holds, and `/positions` is back to 2.8s, matching the
unchanged `/portfolio` control at 2.8–3.2s.

**Consequence worth recording:** because that query is gone, `chainHistory.observedFrom` is now
scoped to *the trader in the response*, not the global ingestion start. A `block_time` index
would let us publish the true global floor cheaply — a candidate for whenever a migration is
acceptable, not urgent.

**Known limitation on `endHoldingAt`.** It needs an `out` transfer, and ingestion is skewed
86% inbound / 14% outbound overall (99.4/0.6 for unipcs). So `endHoldingAt` is frequently
`null` — correct, but thin. Worth revisiting if exits become important.

---

### T1.4 ✅ Cursor pagination

**Why now:** the only pagination gap left after ISSUE-8, and the bulk route makes it matter —
`offset` over a moving board can skip or repeat rows between pages, which a sync will not
notice until its data is wrong.

**Where:** `/traders`, `/tokens`, `/traders/:handle/transactions`.

**Effort:** ~4h.

### ✅ T1.4 shipped — 2026-09-08

Pure code, no migration. On `/traders`, `/tokens` and `/traders/:handle/transactions`.

**Two latent bugs had to be fixed first, and both were worse than expected.** A cursor cannot
resume through a non-total order — it skips and repeats silently — and two of the three sorts
were not total:

```
/traders       order by score, rank nulls last
               -> 37 of 137 traders have NO stats row, so rank is NULL for all of
                  them and they tied as one undifferentiated block

/transactions  order by block_time desc, tx_hash
               -> 23,916 (block_time, tx_hash) pairs carry more than one row, one
                  carries 49, because a transaction moves several tokens and each
                  transfer is its own row
```

`?offset=` was already able to skip or repeat rows across those ties. Both now sort on their
full key.

**A third bug found while wiring it.** `/tokens` computed `rank: i + 1` from the *page* index.
That was correct only while the board could not be paged past the first slice — page two would
have restarted the ranking at 1 and reported the 51st token as first. Now `start + i + 1`.

**Two paging strategies, chosen per route rather than uniformly:**

- **`/traders`, `/tokens`** fetch the whole ordered list and slice it, so the cursor names the
  anchor ROW and resumes after it. Exact, and it cannot disagree with the SQL ordering the way
  a re-implemented JS comparator could.
- **`/transactions`** is SQL-limited and append-only, so it uses true keyset paging —
  `block_time < c OR (block_time = c AND (tx_hash, network_id, address_key, transfer_key) > …)`.
  `block_time` is NULL on 0 of 386,544 rows, so no NULL branch is needed and the tail is one
  row-value comparison.

**Verified live — every row exactly once, no skips, no duplicates:**

```
/traders        7 pages x 20   137 rows   0 dupes   order identical to a single call
/tokens        13 pages x 100  1,257 rows 0 dupes   ranks continuous 1..1257
/transactions  12 pages x 200  2,400 rows 0 dupes

malformed cursor / non-array JSON / wrong-route cursor  -> 400, never a wrong page
stale cursor (row gone)                                 -> 400 naming the cause
?offset= still works; omitting ?cursor= changes nothing but adding nextCursor
```

**The problem demonstrated itself mid-test.** Between two runs the nightly refresh re-ranked
the board and `pointfarmcap` moved from 6th to 3rd. Under `?offset=` a sync spanning that
refresh would have skipped and duplicated rows with nothing to indicate it. That is the whole
reason this item existed.

**Deliberate limit:** a stale cursor returns 400 rather than silently restarting. Handing back
rows the caller already has would surface as duplicates in their data, which is worse than an
error they can act on.

---

### T1.5 ✅ Server-side sorting and range filters

**Why it is free:** these are `ORDER BY` and `WHERE` over columns we hold.

**Scope honestly:** GMGN exposes ~19 range filters on `trending` and ~28 on `trenches`, over
metrics we do not have (`bundler_rate`, `insider_rate`, `top70_sniper_hold_rate`). We can
filter on what we hold — value, P&L, holder count, trade count, dates — which is perhaps 8 of
theirs. Do not claim parity.

**Effort:** ~1d.

---

### ✅ T1.5 shipped — 2026-09-08

Pure code, no migration. **T1 is complete — 5 of 5.**

`/traders` sorts on `rank | pnl | volume | trades | followers | updated` and filters on
`minPnl`, `maxPnl`, `minVolume`, `maxVolume`, `minTrades`, `minFollowers`. `/tokens` sorts on
`holders | value | priced` and filters on `minValue`, `maxValue` alongside the existing
`minHolders`. Both take `direction=asc|desc`.

**Scoped honestly, as the plan required.** GMGN exposes ~19 range filters on `trending` and
~28 on `trenches`, over metrics we do not hold at all — `bundler_rate`, `insider_rate`,
`top70_sniper_hold_rate`. This is 8 filters and 9 sort keys across the two boards: the subset
we can answer from our own columns. It is not parity and the docs do not claim it is.

**The constraint that shaped the implementation.** T1.4 had just established total orders so
cursors could resume through them. A new sort without a tiebreak would have re-broken exactly
that, so the stable tiebreak stays on the end of **every** ordering, unreversed —
`t.handle` for traders, `lower(address), network_id` for tokens. Verified rather than assumed:

```
/traders orderBy=pnl                    8 pages  144 rows  0 dupes  order == single call
/traders orderBy=volume&direction=asc   8 pages  144 rows  0 dupes  order == single call
/tokens  orderBy=value                  8 pages 1095 rows  0 dupes  order == single call
```

**`rank` had to declare its own default direction.** Every other metric descends by default
because "most" is the interesting end — but rank 1 is the BEST trader, so descending rank
would put the worst of the board first. `sortParam` takes an explicit `ascByDefault` list
rather than inferring it; the first version encoded this as a nested ternary that was correct
and unreadable, and would not have survived its next edit.

**A silent exclusion, made visible.** A range filter over a nullable column drops rows whose
value is UNKNOWN, not just rows that fail the test. 44 of 144 traders have no stats row, so
even `minPnl` at negative infinity returns 100 — correct SQL, and invisible to a caller who
reasonably reads a short list as "few qualify" rather than "a third of the board could not be
tested". When any filter is active the response now carries:

```json
"filters": {
  "applied": { "minPnl": 1000000 },
  "excludedForMissingValue": 44,
  "note": "44 trader(s) have no stats row, so no range filter can evaluate them and they
           are absent from this result — that is not the same as failing the filter"
}
```

**Unpriced tokens filter as 0, and that is a filtering convenience only.** `minValue`/
`maxValue` reuse the ordering's existing coalesce-to-0, so `maxValue=100` returns 500 tokens
including unpriced ones. `totalValueUsd` in the response stays `null` for those rows — the
figure a consumer actually reads never claims they are worth nothing.

**Verified live:** 18/18 routes 200, rate-limit headers 4/4, bad `orderBy`/`direction`/numeric
params all 400 naming the valid set, latency unchanged (filtered calls within noise of
unfiltered).

**A mistake worth recording.** My edit to add the token sort block matched the first
occurrence of its anchor and landed inside `/v1/chains` instead of `/v1/tokens`. `deno check`
caught it — but `supabase functions deploy` does not type-check, so a broken build reached
production for about a minute before I fixed it. `/chains` is verified intact. The fix now
asserts the block lands between the correct route boundaries rather than trusting a string
match.

---

## 5. T2 — one backfill, then free forever

### T2.1 ✅ USD value per swap — **the highest-leverage item in this file**

**What it unlocks:** `cost_usd` per transaction, and then `history_bought_cost`,
`history_sold_income`, `total_cost` and `accu_cost` — five GMGN cost-basis fields from one
piece of work.

**Why it is cheap:** 92.7% of swap rows are a quote asset, and those rows span **only 3
distinct tokens**. Valuing them needs 3 daily price series, not a price feed for 3,112 tokens.
A wallet that spent 1.5 SOL spent a knowable number of dollars; the memecoin's own price is
not required to say so.

```
value_usd = amount x quote_price_on(block_time)
```

**What it does NOT unlock, and why:** a per-token entry price still needs both legs of the
swap, which we hold for 3.4% of events (Finding 2). So this gives *how much money moved*, not
*what price they paid per token*. Those are different questions and only the first is
answerable from what we stored.

**Steps:**
1. `token_prices (network_id, token_key, day, usd)` — daily close for the 3 quote assets.
2. Backfill from any free daily-OHLC source; ~3 series × ~250 days ≈ 750 rows.
3. `UPDATE transactions SET value_usd = …` for the 106,226 quote-asset rows.
4. Extend the nightly job to price new rows.
5. Surface `costUsd` on `/traders/:handle/transactions`, with coverage.

**Effort:** ~1d. **Blocked by:** picking a price source. **Blocks:** T2.2.

**Note the column already exists** — `transactions.value_usd` is present and NULL on every
row (verified: `count(value_usd) = 0`). Whoever designed the table expected this; it was
never filled.

### ✅ T2.1 shipped — 2026-09-08

**The estimate in this file was wrong, and the data made it cheaper.** It assumed three real
price series. Measured, the 108,499 priceable swap rows split:

```
USDC  102,547  (94.5%)   dollar-pegged   -> no price feed needed
wSOL    5,511  ( 5.1%)   floating        -> ONE Binance series, 179 days, one API call
USDT      448  ( 0.4%)   dollar-pegged   -> no price feed needed
```

So 94.9% needed no feed at all. A day's estimate became a few hours, and the external
dependency is a single keyless call to an endpoint `src/prices.ts` already uses — so the
Express path and this one cannot disagree about what SOL was worth.

**Pegs are declared once, not fabricated 570 times.** `quote_assets.pegged_usd` says a
stablecoin is worth a dollar; `token_prices` holds measured daily closes for floating assets
only. Writing 285 days × 2 assets of "1.00" into `token_prices` would have claimed we observed
USDC at a dollar on days we did not look. A peg is an assumption — stablecoins do break — and
it is now stated in one place with a comment saying so.

**Result:** 108,672 of 117,433 swap legs priced (**92.5%**, matching the 92.7% predicted),
$24.5M of gross flow. Every remaining unpriced leg is the memecoin side of a swap, whose value
we never stored. Zero quote-asset legs are unpriced.

**Three bugs found and fixed while building it:**

1. **The single-statement backfill hit `statement_timeout = 2min` and rolled back everything.**
   It reported as "0 rows priced", not as a timeout — the worst way to find out. Now batched at
   20k rows, idempotent and resumable, which is also what lets the nightly job price whatever
   the webhook ingested since.
2. **`value_usd` was signed by a sign that does not exist.** I documented it as "signed to
   match `amount`" — but `amount` is positive on all 117,524 swap legs in *both* directions,
   with direction living only in the `direction` column. So `spentUsd` was permanently 0 and
   all flow was reported as received. The aggregate now reads `direction`; `value_usd` is a
   magnitude like `amount`.
3. **The money aggregate was 200x slower than the one beside it.** `count/min/max` is an
   index-only scan at 21ms; mine needed `value_usd`, `direction` and `tx_type`, none of them
   indexed, so it was a bitmap heap scan at **4,398ms** and took the route from 2.5s to 3.9s
   against a 2.7s control. Fixed with a covering index
   (`20260908140000_transactions_money_index.sql`) — index-only scan, **386ms**, built in 14s.

**And a design fix the numbers forced.** Even at 386ms, the money block is a whole-wallet total
that is identical on every page — recomputing it across a 12-page walk would spend that twelve
times to return the same number twelve times. It is now present when you start reading a wallet
and omitted once you are following a cursor, with `?money=true` to force it. Page 1 costs
3.63s; page 2 is **2.59s**, back under the 2.78s control.

**Verified live:**

```
money.spentUsd / receivedUsd match SQL exactly  (unipcs 1.90 / 20,363.87)
Quanterty: spent $953,947 · received $613,281 · net -$340,667 · coverage 91%
19/19 routes 200 · cursor walk 8 pages, 1,600 rows, 0 duplicates
nightly step added to refresh.yml, after transfers so it prices what was just ingested
```

**What this does NOT give.** How much money moved, not the price paid per token. That needs
both legs of a swap and we hold those for 3.4% of events — the limit recorded in §3, unchanged.

---

### T2.2 ⛔ Realised/unrealised P&L from chain — BLOCKED, do not build yet

**Why it matters:** every P&L figure we publish today is fomo's, which is exactly what
`/trust` exists to test. Deriving our own from chain would turn `tier: "reported"` into
`tier: "verified"` — the strongest claim this API could make, and something GMGN does not
offer because it has no second source to check against.

**Blocked by:** T2.1, and by the same both-legs limit. Achievable for the 3.4% of events with
both legs plus any position whose entry and exit are both quote-asset-denominated. **Scope
this properly before committing** — it may cover far less than it appears to.

**Effort:** ~2d, and the first half day should be establishing what fraction is actually
reachable before building anything.

### ⛔ Scoped 2026-09-08 — not viable yet, and the reason is fixable

This item said *"scope this properly before committing — it may cover far less than it appears
to"*. Scoped in about twenty minutes, before writing any feature code. It does, and worse: the
part it covers does not agree with the source it was meant to check.

**Coverage.** Attributing a dollar spend to a specific token needs a quote leg and a token leg
in the SAME swap event. We have that for **3,420 of 99,147 events (3.45%)**, which yields:

```
1,258  positions with any chain-derived basis      (vs 10,918 positions from fomo)
  663  with BOTH a buy and a sell                  6.07% of what we report
  313  also having a closed fomo trade to compare against
```

**Agreement, on those 313.** This is the part that settles it:

```
206 / 313   (66%)   agree on DIRECTION — profit vs loss
 48 / 313   (15%)   within 25% of fomo's figure
avg chain P&L  -$5,435      avg fomo P&L  +$459     — they disagree even in aggregate sign
```

A "verified" P&L that gets the direction wrong a third of the time, on 3% of positions, is
worse than not having one. It would carry more authority than the reported figure it
contradicts, and be wrong more often than right.

**The obvious excuse does not hold.** Partial history was the natural explanation — we start
watching part-way through a wallet's life, so early buys are missing. Tested by splitting on
whether the position opened after we began watching:

```
opened AFTER we started watching   294 positions   196 same direction (67%)   47 within 25% (16%)
opened BEFORE (partial history)     19 positions    10 same direction (53%)    1 within 25%
```

Identical. The disagreement is structural, not a coverage artifact.

### The root cause, and it is a small fix

**The Helius webhook ingests `tokenTransfers` and ignores `nativeTransfers`.**
`supabase/functions/helius-webhook/index.ts` iterates only the former;
`src/transactions.ts:364` — the Express path — handles both. So on Solana, where the quote leg
of a swap is very often native SOL, we store the token side and drop the money side.

The data agrees exactly:

```
solana swap events   99,187
  with ONE leg only  95,740   (96.5%)
```

That is why only 3.45% of events can be attributed, and it is a gap in ingestion rather than a
limit of the approach.

**Recommended sequence instead:**

1. Add `nativeTransfers` to the webhook receiver, mirroring what `src/transactions.ts` already
   does. Small and well-defined.
2. Re-backfill Solana transfers so historical events gain their missing leg.
3. Re-run this scoping query. If attributable events rise from 3.45% toward the 40-60% a
   two-legged feed should give, T2.2 becomes buildable and worth the two days.

Until step 3 says otherwise, **do not build T2.2.** Nothing about it is wrong except that the
data underneath it is half-missing, and building on that would produce a confident wrong
number — the one failure mode this codebase is organised to avoid.

### ⚠ Steps 1-2 done 2026-09-08 — and the hypothesis was WRONG

The `nativeTransfers` fix shipped: the webhook now ingests native lamport movements, and
`scripts/backfill_transactions.mjs` passes `includeNative: true`. Both write SOL under its
`quote_assets` address rather than the literal `"native"` that `src/transactions.ts` emits, so
the legs are priceable instead of joining to nothing.

**It did not unblock T2.2.** Measured after a 20-page deep backfill of the heaviest Solana
trader:

```
unipcs native rows gained                        124
unipcs swap events in the same window         12,921
attributable events in that window               0.4%     (baseline across all wallets: 3.45%)

native SOL amounts, all wallets:
  <0.005 SOL (rent / fees)   97 of 142   (68%)
  >0.05  SOL (trade-sized)   18 of 142   (13%)
  total USD value of every native row      $66.67
```

**Why the hypothesis failed.** These wallets trade through **wSOL**, which is an SPL token and
was already arriving in `tokenTransfers` — 5,511 rows of it. The native lamport movements are
account rent and signature fees, not swap value. So the missing money leg was never native
SOL, and single-legged events have some other cause still to be found.

**What was nonetheless worth doing.** Two ingestion paths disagreed: `src/transactions.ts:364`
read `nativeTransfers`, the webhook did not. That inconsistency is now closed, native movements
are captured and priced, and the finding is recorded so nobody re-runs this experiment.

**T2.2 stays blocked.** The next investigation is *why* a Jupiter swap yields one stored leg
when both sides involve the watched wallet — likely how Helius reports transfers through
intermediate token accounts. That is a research task, not a build task, and it should produce
a measurement before any code.

---

## 6. T3 — inherently external, proxy and cache

We hold a `GMGN_API_KEY` and `src/gmgn.ts` already calls 4 endpoints, so the plumbing exists.
Everything here is a fact about a token or contract across the whole chain. **The rule: cache
in our DB with `fetched_at`, serve from cache, label `tier: "third_party"` and
`source: "gmgn"`.** A cached third-party fact is still one external call, not one per request.

| Item | GMGN endpoint | Why we cannot compute it | Effort |
| --- | --- | --- | --- |
| ⬜ Token security — `is_honeypot`, `buy_tax`, `sell_tax`, `owner_renounced`, `rug_ratio` | `GET /v1/token/security` | Contract-level facts. Not in any table we own. | ~4h |
| ⬜ Token fundamentals — `price`, `liquidity`, `market_cap`, `circulating_supply` | `GET /v1/token/info` | We hold `total_supply` only; no price feed. | ~4h |
| ⬜ True holder counts — `holder_count`, `top_10_holder_rate` | `GET /v1/token/info` | All chain holders; we see 137 traders. Pairs with T1.3 — ours and theirs side by side is genuinely better than either alone. | ~3h |
| ⬜ Wallet tags — `smart_degen`, `renowned`, `sniper`, `bundler`, `dev` | `GET /v1/market/token_top_holders` | GMGN's own classification of wallets we do not track. | ~4h |
| ⬜ Creator/dev signals — `creator_token_status`, `cto_flag`, `creator_ath_info` | `GET /v1/token/security` | Requires creator history across all their launches. | ~3h |

**Sequencing note:** do **T3 security first**. It is the one set of fields where absence is
actively dangerous — we currently rank tokens by leader interest with no honeypot signal
anywhere in the response.

---

## 7. T4 — deliberately not building

Recording the reason matters as much as the decision; without it these get re-proposed every
few months.

| Item | ❌ Reason |
| --- | --- |
| Order execution — market, limit, trailing TP/SL | We are an analytics API. Taking custody or routing orders is a different product with a different risk and compliance surface. |
| `POST /v1/trenches` — new launches | Our universe is defined by fomo's leaderboard. A token nobody we track has touched has nothing for us to say about it. |
| `POST /v1/market/token_signal` — 21 realtime event types | Needs a streaming subscriber and a push channel we do not have. Revisit only if a consumer asks. |
| `POST /v1/market/hot_searches`, `visiting_count` | Derived from GMGN's own site traffic. Unobtainable by anyone but GMGN. |
| `/v1/user/follow_*` | Per-user follow state belongs to GMGN accounts. We have no user accounts. |
| `gas_usd` | `raw` is NULL on every row (Finding 3), so it needs full re-ingestion for a field nobody has asked for. |
| Chains `arc`, `stable` | Add when a tracked trader actually holds something there. Right now it would be two empty rows. |
| `market kline` / OHLCV | A price-history product. Large storage, and we have no price feed to build it from. |

---

## 8. Suggested order

Sequenced by leverage, not by tier number.

| # | Item | Why here | Effort |
| --- | --- | --- | --- |
| 1 | **T3 security** | The only gap where silence is dangerous. Ship first. | ~4h |
| 2 | **T2.1 USD per swap** | Unlocks five cost-basis fields at once; only 3 price series. | ~1d |
| 3 | **T1.1 position timing** | Free, and pairs naturally with T2.1 on the same route. | ~3h |
| 4 | **T1.4 cursor pagination** | Correctness issue for the sync ISSUE-8 just enabled. | ~4h |
| 5 | **T3 fundamentals + holders** | Completes the token page; T1.3 lands beside it. | ~7h |
| 6 | **T1.5 sort/filter** | Broad, no dependencies, do when there is a spare day. | ~1d |
| 7 | **T2.2 chain-derived P&L** | Highest value, least certain. Scope before building. | ~2d |

**Total for 1–6: about 4 days.** Item 7 is open-ended by design.

---

## 9. What we would still have that GMGN does not

Worth stating, so parity work does not quietly erode it. These are in
[GMGN_GAP_ANALYSIS.md](GMGN_GAP_ANALYSIS.md) §B and none of the above touches them:

- **A missing value is `null`, never `0`** — 1,688 of 2,038 holdings carry no price, and this
  is the rule the whole codebase is built around.
- **Coverage on every derived figure** — `of`, `total`, `share`, so a number always says how
  much of the record it rests on.
- **Reported vs verified tiers** — `tier`, `source`, and `/trust` testing fomo's own figures
  against themselves. GMGN has no second source to check against.
- **Freshness per figure** — `asOf` scoped per trader and per token, not one global timestamp.
- **`plain` and `caveats[]`** — a sentence per figure and named limitations per response.
- **Snapshot diffs** — dated `captured_at` generations, which is what `/tokens/momentum`
  is built on.

**Every T3 item must arrive wearing this clothing** — `tier: "third_party"`, `source: "gmgn"`,
`fetchedAt`, and a `plain` sentence. Proxying a third-party number bare, indistinguishable
from something we computed and stand behind, would trade away the one thing this API has that
GMGN does not.
