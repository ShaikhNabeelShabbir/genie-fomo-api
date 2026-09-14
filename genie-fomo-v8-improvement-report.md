# Version 8 — what landed, what is still wrong, and what the trader profile still needs

**From Genie to the genie-fomo team. One document that replaces our three earlier notes:**
`message-to-genie-fomo-2026-09-12-v8.md`, `follow-up-after-v8.md` and
`message-to-genie-fomo-2026-09-12-v8-additional-gaps.md`. Where those notes disagree, this one is
right, and Part 1 says which earlier statements we withdraw.

Two rounds of measurement, against the live service, with no key:

- **12 September 2026, 15:00–15:20 UTC.** 143 requests, the whole-directory readback of version 8.
- **14 September 2026, 03:05–03:15 UTC.** A re-check of every open item, the directory, all 435
  traders' weeks through the batch call, and every per-trader route for `@unipcs`.

```bash
export B=https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api
```

Thank you. Version 8 is a large change, and nine of our ten original asks are fixed. Everything
below is what is left, ranked by how much it changes what a person sees when they open a trader.

How this document is laid out:

| Part | What it covers |
| --- | --- |
| The short version | The asks, ranked |
| 1 | What we confirmed fixed |
| 2 | What is still wrong in what you already send |
| 3 | Every item on the trader profile, and the field behind it |
| 4 | Each ask in detail |
| 5 and 6 | What we will do, and what we are not asking you for |
| 7 | **Every route, parameter and field Genie depends on**, each marked sent, change or new |

---

## The short version

| # | What we are asking for | What it fixes for the person looking at a trader | Status |
| --- | --- | --- | --- |
| **A1** | **Restart the balance sampler, and say how old each answer is** | No reading anywhere is newer than 75 hours, yet 432 of 435 answers say `ready`. Every balance we show is three days old, and nothing in the answer tells us so. | Open, and worse than on 12 Sep (39 hours then) |
| **A2** | **Never make a one-chain, partial rebuild the trader's `now`** | `@unipcs` shows **$5.1M** because `now` covers 1 of his 5 chains and 11% of his money. Eight hours earlier the sampler read him at **$15.7M**, and `/portfolio` says $16.7M. | New |
| **A3** | **Stop the line jumping where rebuilt readings meet measured ones** | 412 jumps of half or more inside one week, across 356 traders. Our cards printed **"+155,855.5% in 7 days"** and **"−68.9% in 7D"** from moves that never happened. | Open since 12 Sep |
| **A4** | **Entry price, entry cost and coin size at purchase on every finished coin** | Of `@unipcs`'s 27 finished coins, only **3** carry an entry price. Six items on the profile depend on it, including "Gets in early", "Size of coin when he buys", "$365 a bet", "Total bought" and the profit bands. | New |
| **A5** | **Every buy and sell, on every chain, with entries paired to exits** | Trades are resolved on Solana only. The "$1,000 copied last week" replay, "2 in 100 still open when our copy landed" and "in and out under 5 seconds" cannot be measured on the other four chains. | Open (additional-gaps note, item 3) |
| **A6** | **Realised profit by month** | "Worst month" and the "Survives bad days" test have no source. | Open (additional-gaps note, item 6) |
| **A7** | **Fees, volume, and whether profit is after fees** | The profile says "made, after fees" and cannot prove it; "Fees paid" and "Volume" are empty. | Open (additional-gaps note, item 4) |
| **A8** | **A stable list of every chain a trader uses** | The chain tags under his name show the chains in one reading, not the chains he trades. | Open (additional-gaps note, item 1) |
| **A9** | **Say whether the scorecard covers the whole record, and refresh it** | `@unipcs`'s scorecard is built from 363 trades loaded on 5 September and dated 7 September. We cannot tell a complete record from a sample. | New |
| **A10** | **Declare the week's real spacing** | All 435 weeks declare six-hour steps and hold readings a day apart. | Open since our first note |
| **A11** | **A reason beside every empty field** | The profile cannot tell "not applicable" from "not calculated yet" from "source unavailable". | Open (additional-gaps note, item 7) |
| **A12** | **Cost basis on current positions** | "What he paid for what he holds" has no source. | Open (additional-gaps note, item 5) |
| **A13** | **Seven small items** | See Part 4. | Mixed |

If only three can be done, please do **A1, A2 and A3**. They decide whether the one number every
person reads first — his balance, and how it moved — is true.

---

## Part 1 · Confirmed fixed in version 8

We re-measured every claim in your Appendix A3, one at a time.

| Our original ask | What we measured | Verdict |
| --- | --- | --- |
| **1.** Don't refuse a whole day because one chain couldn't be rebuilt | `@ogle` over 30 days: 29 points, all 29 with a figure (it was 1 of 28). `@ethersole` all chains, one month: 29 of 29. Every point carries `chainsAnswered` / `chainsTotal` / `partial`. | **Fixed** |
| **2.** A close date on each closed trade | `realizedByDay` added. `firstClosedAt` / `lastClosedAt` present on 317 of 317 `byToken` rows for `@unipcs`. `/traders/<handle>/trades` answers. | **Fixed** |
| **3.** Backfill the balance history, Solana first | `@zakum` and `@cryptolyxe`: 29 of 29 real points on Solana, `drawable: true`. `@zakum`'s $1.05M used to be one point. | **Fixed** |
| **4.** What does `drawable` mean? | Your flag and our rule ("two points with a figure make a line") picked **the same 376 traders** out of 435 on the month. | **Fixed** |
| **5.** The directory's identifier refused by the balance address | `e398bde0-98f7-47c9-8a43-a8edf967161a` answers 200 on all ten per-trader routes. | **Fixed** |
| **6.** Let the batch call name a chain | `{"contractVersion":2,"ids":[…],"window":"1m","chain":"robinhood"}` is honoured and echoed. | **Fixed** |
| **8.** The one-day window answers nothing | 8 of 8 traders draw on `1d`. `now` and `trackedSince` are identical across all four windows. | **Fixed** |
| **9.** The batch call answers about identifiers it doesn't know | Under `contractVersion: 2`, an unknown id is `ok: false` with `not_found`. The older shape still echoes it back; that is fine, since we are migrating. | **Fixed** |
| **10.** One trader's handle 404s | `yeon__ (gmgn)`: all three spellings answer 200. | **Fixed** |

Also checked, because we depend on them:

- `sum(chains[].totalUsd)` equals `now.totalUsd` (six traders).
- A batch row is identical to the single answer apart from `from`, `to` and `reach.requestedFrom` (three traders, three windows).
- 51 ids is a `400` naming the cap; a duplicate id is a `400` with `duplicate_identifier`.

The whole-directory effect, 11–12 Sep against 12 Sep 15:16 UTC:

| | Before | After |
| --- | --- | --- |
| Can draw from the all-chains answer | 109 of 434 | **376 of 435** |
| Can draw only if asked chain by chain | 200 | **0** |
| Days with a figure | 1,855 | 8,787 |
| Days refused | 8,894 | 2,317 |

**Earlier statements we withdraw:**

- *"The one-day answer contradicts itself"* (`follow-up-after-v8.md`, section 2). It does not. `from` echoes our request, `reach.coveredFrom` / `coveredTo` are the evidence, and every borrowed point carries `outsideWindow`. Our reader was bounding points against `from`. That was our fault, and it is fixed on our side.
- *"The batch call answers about people you have never heard of — still open"* (`follow-up-after-v8.md`, section 4). Fixed under `contractVersion: 2`, as above.
- *"Is `realizedByDay` every day or only the recent ones?"* Answered by the data: it lists every day with a close in the latest 30 days. `@unipcs`'s three rows (2, 4 and 5 September) sum to −$131,120.08 over 43 closed trades, which matches `windows["30d"]` to the cent.

---

## Part 2 · What is still wrong in what version 8 already sends

### A1 · The sampler has not written a reading since 11 September, and every answer says `ready`

Measured 14 Sep 03:10 UTC, all 435 traders, `window=1w`, through the batch call:

| | Count |
| --- | --- |
| `status: "ready"` | 432 |
| `status: "warming"` | 3 |
| Newest `now.at` anywhere | **2026-09-11T00:00Z — 75 hours old** |
| `now.at` = 2026-09-10T16:00Z | 263 traders |
| `now.at` = 2026-09-11T00:00Z | 169 traders |
| `now.tier: "reported"` (a rebuild, not a reading) | 169 |

On 12 September the newest reading was 39 hours old. **Nothing has been added since.** The other
stores behind `@unipcs` are older still:

| Route | Its newest date |
| --- | --- |
| Directory (`/traders`) | `capturedAt` 8 Sep 10:38 UTC |
| `/scorecard` | `asOf` 7 Sep 11:40 UTC; trades loaded (`sample.storedAt`) 5 Sep 04:30 UTC |
| `/positions`, `/portfolio`, `/trust` | `asOf` 10 Sep 15:40 UTC |
| `/transactions` | newest transfer 11 Sep 10:11 UTC |
| `/wallets` | Solana `lastActiveAt` 5 Sep 04:30 UTC |

**Why it matters.** The profile prints the balance as what he holds now, with "Today" at the right
edge of the chart. Today the true statement would be "as of Thursday". We can print that, but only
if the answer tells us, and `ready` says the opposite.

**What we are asking for:**

1. **Restart the sampler.** If it is stopped on purpose, tell us, and we will say so on every card.
2. **Make freshness part of the answer**, so no caller has to work it out from dates:

   ```json
   {
     "now": { "at": "…", "totalUsd": 123, "basis": "sampled", "ageSeconds": 900 },
     "sampler": {
       "state": "current",
       "lastAttemptAt": "…",
       "lastSuccessAt": "…",
       "nextExpectedAt": "…",
       "reason": null
     }
   }
   ```

   Suggested states are `current`, `stale`, `warming`, `stopped` and `failed`, with the age limit
   for each written down. `ready` should never describe a two-day-old answer without naming its age.
3. **The same `asOf` on every route**, including the scorecard's trade load, so the profile can say
   how old each card is.

### A2 · `now` is a partial, one-chain rebuild when a fuller reading exists

`@unipcs`, `window=1w`, read 14 Sep 03:12 UTC:

| `at` (UTC) | `totalUsd` | `basis` | chains answered | share of his money priced |
| --- | --- | --- | --- | --- |
| 8 Sep 00:00 | $15,141,456 | rebuilt | 5 of 5 | 3.7% |
| 9 Sep 00:00 | $16,307,858 | rebuilt | 5 of 5 | 3.7% |
| 10 Sep 00:00 | $5,418,264 | rebuilt | 4 of 5, `partial` | 75% |
| **10 Sep 16:00** | **$15,665,319** | **sampled** | *not stated* | 65% |
| **11 Sep 00:00** | **$5,101,126** | **rebuilt** | **1 of 5, `partial`** | **11%** |

`now` is the last row: $5,101,125.87, `tier: "reported"`, Solana only (`coverage.answeredChains: 1`
of 5). The sampled reading eight hours earlier is three times larger. `/portfolio`, read at the
same time, puts him at **$16,657,897.89 across 5 chains**.

**Why it matters.** Genie prints `now` as his balance. It showed **$5.1M, down 68.9% in a week**,
for a trader the service itself values at $16.7M.

**What we are asking for:**

- Choose `now` from the most complete recent reading, not simply the newest. A rebuild from 1 of 5
  chains should never replace a sampled reading of all of them.
- Put `partial`, `chainsAnswered` and `chainsTotal` on `now` itself, not only on the points.
- Fill `chainsAnswered` / `chainsTotal` on sampled points too; today they are `null` there.
- Notice that rebuilt points now appear **after** `trackedSince` as well (11 Sep 00:00 comes after
  10 Sep 16:00). The seam in A3 therefore happens on both sides of it.

### A3 · Measured and rebuilt readings sit side by side, and the line falls off a cliff between them

Your section 9 already names the fault: "a sampled figure and a rebuilt one count different things …
borrowing across that seam would have drawn a 67% fall that never happened". That rule is applied
to borrowing, but not to the series itself.

| Measured | Traders with both kinds in one series | Places the kinds meet | Of those, moving the line by half or more |
| --- | --- | --- | --- |
| 12 Sep, one month, all 435 | 366 | 522 | 354 |
| **14 Sep, one week, all 435** | **356** | **512** | **412** |

Two examples from 14 Sep:

- `@fhn_gt`: $33.26 (9 Sep, rebuilt) → $0 (10 Sep 00:00, rebuilt) → **$52,276.29** (10 Sep 16:00, sampled). Our card printed "+155,855.5% in 7 days".
- `@unipcs`: $5.42M (rebuilt) → $15.67M (sampled) → $5.10M (rebuilt), **two cliffs in 16 hours**.

The step reflects how much of the wallet each method could price (`pricedShare` differs on the two
sides), not anything the trader did. Nothing in the answer lets a chart tell it from a real loss.

**What we are asking for, best first:**

1. **Value both kinds the same way**, so neighbouring figures can be compared. That removes the
   cliff instead of labelling it.
2. Failing that, **mark every change of method**: a field on the first point after a change of
   `basis`, in either direction, saying the step is a change of method, not of balance. We will
   break the line there and never measure a percentage across it.
3. Failing both, **don't call the series `drawable`**, and name the reason in `drawing.reason`.

### A10 · The week declares six-hour steps and holds readings a day apart

All 435 weeks on 14 Sep declare `step: "6h"`. The spacing between neighbouring readings:

| Hours between readings | 8 | 16 | 24 | 40 | 48 | 64 |
| --- | --- | --- | --- | --- | --- | --- |
| Times seen | 156 | 258 | **566** | 82 | 4 | 16 |

The `1m` answers declare `1d` and line up exactly. **Please declare `1d` on the week** until it
really holds six-hourly readings. We now break lines only on your explicit `gaps` list, so this no
longer hurts us. But the answer describes itself wrongly, and the next caller will trip on it.

---

## Part 3 · What the trader profile needs, item by item

The approved profile has four screens: the top with "Is he good?", then "Should I copy?", "How does
he trade?" and "What would I make?". For every item below:

- **what it tells a person** — the question the item answers;
- **field** — what version 8 provides for it;
- **today** — what we found for `@unipcs` on 14 Sep;
- **ask** — the request in Part 4 that would complete it.

Items marked **Genie** are ours to compute and appear only so you can see the whole screen. The
states are:

- **sent** — provided and usable
- **thin** — provided, but covering a small share of the record
- **missing** — not provided at all

### Top of the profile, and "Is he good?"

| Item on screen | What it tells a person | Field | Today | Ask |
| --- | --- | --- | --- | --- |
| Name and picture | Who this is | `/wallets` `name`, `profilePicture` | sent | — |
| Chain tags under the name ("BSC", "SOL") | Where he trades | `aum.chains` lists only the chains in the newest reading. `/portfolio.byChain` lists 5 for `@unipcs`, but the two routes disagree. | thin | A8 |
| "trading 540 days" | How long his record is | `scorecard.trackRecordDays` (108.4) | sent | A9 |
| Balance, e.g. "$83.6K" | What he holds now | `aum.now.totalUsd` | sent, but 75 hours old and partial | A1, A2 |
| Change, e.g. "+12.8% in 30 days" | How his money moved | `aum.points` | sent, but crosses the method seam | A3 |
| The chart, 1D / 7D / 30D / All | His balance over time | `aum` per window | sent | A1, A3, A10 |
| "113 people copy him · 9 joined this week" | Whether others trust him | — | **Genie** | — |
| Verdict sentence | The answer in one line | — | **Genie**, from the tests below | — |
| "+$3.3M made, after fees" | Did he make money | `scorecard.windows.all.realizedUsd` (−$131,120.08) | sent; "after fees" unproven | A7, A9 |
| "7 in 10 coins made money" | Is it many wins or one | `byToken[].realizedPnlUsd` over coins with `closed > 0` (12 of 27) | sent | A9 |
| "64,913 trades in 540 days" | How active he is | sum of `byToken[].trades` / `closed` (363 / 43) | sent, but from a 363-trade load | A9 |
| "Compared with 518 traders", six "better than" ranks | Where he stands | — | **Genie**, ranked from `winRate`, `holdingTime`, `tradesPerDay`, `topTradeShare` and others | A4, A9 improve the inputs |
| "Last 30 days +$359K" | His recent month | `windows["30d"].realizedUsd` | sent | — |
| 30-day calendar, "27 green, 3 red, worst day −$50.9K" | Steady or lucky | `realizedByDay` | **sent in version 8** (Genie still has to read it) | — |
| "Of the 2,000 coins he traded — 78% won", and five bands from "more than 5× his money" to "lost more than half" | How big his wins and losses are | Needs cost and proceeds per coin. `avgEntryPrice` is null on **24 of 27** finished coins; `avgExitPrice` is present on 27. | **thin: 3 coins of 27** | A4 |

### "Should I copy?"

| Item on screen | What it tells a person | Field | Today | Ask |
| --- | --- | --- | --- | --- |
| Test: Real record — "no single lucky trade behind it" | Is the profit spread out | `scorecard.topTradeShare` (0.9954) | sent | — |
| Test: Gets in early — "95% of buys under $100K" | Does he buy before the crowd | `byToken[].avgEntryMarketCapUsd` is null on **24 of 27** finished coins and 293 of 317 coins. It is also one figure per coin, not per buy. | **thin** | A4 |
| Test: Copyable — "too fast: 1,493 trades a day" | Can a copy keep up | `scorecard.tradesPerDay`, `holdingTime` | sent; our delay is **Genie** | A9 |
| Test: Survives bad days — "worst month −1.5%" | How bad it gets | none | **missing** | A6 |
| Advice, "If you copy anyway, keep it small: $50 a trade" | What to do | — | **Genie** | — |
| Warning signs, "from the 24 wallets we watch" | Red flags | — | **Genie**, from what we watched | A5 would let us count his whole record |
| "On a blacklist: No" | Is he a known bad actor | `/trust.flags` exists (empty, `verdict: ok`), but it does not say whether any blacklist was checked | **missing** | A13 |
| "Sells coins he never bought", "Sold more than he bought", "In and out under 5 seconds" | Is this a promoter's wallet | — | **Genie** | A5 |

### "How does he trade?"

| Item on screen | What it tells a person | Field | Today | Ask |
| --- | --- | --- | --- | --- |
| "Many small, fast bets" | His style in four words | — | **Genie** | — |
| How often, "1,493 a day" | Pace | `scorecard.tradesPerDay` (3.35, from 43 of 363 trades) | sent | A9 |
| How much, "$365 a bet" | Typical stake | `scorecard.typicalBetUsd.value` is **null** (coverage 24 of 363) | **missing for him** | A4 |
| How long, "3 days" | Holding time | `scorecard.holdingTime.medianDays` (1.06, coverage 43 of 43). `measurements.holdTimeDays` gives the same median with coverage 3 of 43. | sent, but the two disagree | A13 |
| "Size of coin when he buys — 95% tiny", three bands | Early or late buyer | `byToken[].avgEntryMarketCapUsd` | **thin: 3 coins of 27** | A4 |
| "Trades: 64,913 of 71,985 closed" | How much of his record is finished | sums of `byToken[].closed` / `trades` | sent | A9 |
| "Balance now: 114.09 BNB · $83.6K" | His holding in the chain's own coin | dollars sent; the native amount is not | **missing** | A13 |
| "Typical hold: 3 days" | — | as "How long" above | sent | A13 |
| "Total bought: $23.7M" | How much money went in | `scorecard.moneyIn.usd` (coverage **24 of 363**) | **thin** | A4 |
| "Average buy / sell" | Size of a buy and of a sell | `moneyIn` / `moneyOut` (24 and 56 of 363, only 9 of them the same trades) | **thin** | A4 |
| "Average profit per trade: +$45.23" | Edge per trade | `scorecard.meanTradeUsd` (−$3,049.30) | sent | — |
| "Fees paid" | What trading costs him | none | **missing** | A7 |
| "Volume" | How much he trades in dollars | `/trust.volumeUsd` is null for him; the directory's `volume` is null for 144 of 435 | **missing** | A7 |
| "Copied by · noted by" | — | — | **Genie** | — |

### "What would I make?"

| Item on screen | What it tells a person | Field | Today | Ask |
| --- | --- | --- | --- | --- |
| "$1,000 → $1,301", Him and You bars | What a copy would have made last week | Needs his individual buys and sells, with time, price and chain | **thin: Solana only**, 49 swaps for him | A5 |
| "Only 2 in 100 of his trades were still open when our copy landed, 2 seconds later" | Whether copying is even possible | Needs each trade's entry and exit time, paired | **thin: Solana only, no pairing** | A5 |
| "One lucky trade? No · 4%" | Does one trade carry the record | `scorecard.topTradeShare` | sent | — |
| "Worst month −1.5%" | The worst stretch | none | **missing** | A6 |
| "In and out under 5 seconds: 1 in 25" | Bot-like flipping | Needs paired entries and exits with timestamps | **thin: Solana only** | A5 |

---

## Part 4 · The asks in detail

### A4 · Entry price, entry cost and coin size at purchase on every finished coin

**What it is for.** These three numbers answer "did he get in early, and how big are his wins". They
feed six items: "Gets in early", "Size of coin when he buys", "How much a bet", "Total bought",
"Average buy / sell", and the five profit bands. They also feed our comparison ranks.

**What we measured.** `@unipcs` has 317 coins, of which 27 have a close.

- `avgEntryPrice`, `entryMethod` and `avgEntryMarketCapUsd` are null on 293 of the 317, and on **24 of the 27** finished ones.
- `entryPriceCoverage.pricedShare` is 0.0757.
- Your own caveat says so: "Entry prices are present on only 24 of 363 trades, so money-in, return % and typical bet size are computed from a minority of the record."
- `typicalBetUsd.value` is null, and `returnPct` covers 3 of 43 closed trades.

**What we are asking for.** For each `byToken` row, and ideally each position:

- `costUsd`: dollars spent getting in; and `proceedsUsd`: dollars received getting out.
- `avgEntryPrice` and `avgEntryMarketCapUsd` **per buy**, not one per coin, or the per-buy list,
  so "95% of buys under $100K" counts buys.
- The source and method of each, such as the quote-asset leg of the swap or a price at the block.
- `null` plus a reason when a leg is a transfer, never zero.

Your `/transactions` route already values the quote-asset side of 13,614 of 28,032 legs. If the same
valuation can fill entry cost on the scorecard, most of this gap closes.

### A5 · Every buy and sell, on every chain, with each entry paired to its exit

**What it is for.** Our copy replay ("$1,000 → $1,301"), the "2 in 100 still open when our copy
landed" figure, "in and out under 5 seconds", and the trade counts all need individual trades. Each
must carry a time and a price, and each exit must be paired with its entry.

**What we measured.**

- `/traders/unipcs/trades` returns 49 Solana swaps. Its `coverage.chainsTradedButUnresolved` names Robinhood, BNB Chain, Base and Ethereum, "visible as positions on /positions but not as individual swaps here".
- `/trades` has no pagination beyond `limit`.
- There is no identifier that ties a sell to the buy it closes.

**What we are asking for.** A complete, pageable finished-trade record with:

- chain, network id, transaction id and timestamp
- buy or sell
- token quantity and money quantity
- execution price and dollar value
- **a position or round-trip identifier pairing entries with exits**
- open or closed status, and the close timestamp
- source and confidence
- **a completeness block per chain**

An empty list must mean the chain was fully read and held no trades. An unresolved chain must stay
named as unresolved; it must never look like zero trades.

### A6 · Realised profit by month

**What it is for.** "Worst month" and the "Survives bad days" test. A balance drawdown is not a
substitute: deposits and withdrawals move a wallet without any trading loss.

**What we measured.** `realizedByDay` covers only the latest 30 days. There is no monthly field.

**What we are asking for.** `realizedByMonth` for at least the last twelve completed calendar
months. Each month needs realised dollars, closed-trade count, coverage, and either the capital at
the start of the month or a directly measured return percentage. Daily rows over the same period,
with coverage, would also work.

### A7 · Fees, volume, and whether profit is after fees

**What it is for.** The profile's headline says "made, after fees", and "All the numbers" has rows
for "Fees paid" and "Volume".

**What we measured.**

- No realised figure states whether fees are included.
- `/trust` returns `reportedPnlUsd: null` and `volumeUsd: null` for `@unipcs`.
- The directory's `pnl`, `volume` and `numTrades` are null for **144 of 435** traders, `@unipcs` among them.

**What we are asking for.**

- `includesFees: true | false` on every realised figure, with the fee source documented.
- Fees in dollars per trade and per scorecard window.
- Volume in dollars per trade and per window.
- The chains, trades and period each figure covers.
- `null` plus a reason when a figure cannot be measured.

### A8 · A stable list of every chain a trader uses

**What it is for.** The chain tags under his name, and the per-chain switches on the chart.

**What we measured.** `aum.chains` lists the chains in the newest reading only: Solana alone for
`@unipcs`. `/portfolio.byChain` lists five. Over the directory, on 12 Sep, 128 of 435 traders would
be offered fewer chain switches than the service says they use.

**What we are asking for.** A block that does not change with the window, on the aum answer and the
trader answer alike:

```json
{
  "knownChains": [
    {
      "chain": "solana",
      "networkId": 1399811149,
      "wallets": 1,
      "hasPositions": true,
      "historyState": "ready"
    }
  ]
}
```

Keep `chainsAnswered` / `chainsTotal` / `partial` on each point. They answer a different question.

### A9 · Say whether the scorecard covers the whole record, and refresh it

**What it is for.** Every scorecard figure on the profile: trades, closed trades, win rate, pace and
the track record.

**What we measured.** For `@unipcs`:

- `sample: { "returned": 363, "storedAt": "2026-09-05T04:30:29Z" }`
- `asOf` is 7 Sep; `firstTradeAt` is 22 May; `trackRecordDays` is 108.4.
- `/positions.chainHistory.observedFrom` is 3 July, with the note "ingestion began part-way through this trader's history".

The word "sample" and a round-looking load date leave us unable to tell whether 363 is his whole
record or a slice.

**What we are asking for.**

- `complete: true | false` on the scorecard.
- The total number of trades the service knows of beside the number used.
- When the trade load last ran, and when it will run next. This is the scorecard's part of A1.

### A11 · A reason beside every empty field

Several version 8 fields can be null on individual coins, for example `tokenAgeAtEntryDays` (143 of
317 for `@unipcs`), `avgExitPrice` and `totalSupply`. Please add a per-field reason, or a summary per
answer, that tells these apart:

- `not_applicable`
- `not_yet_calculated`
- `source_unavailable`
- `historical_input_missing`

This asks for an explanation around existing fields, not for zeros in place of nulls.

### A12 · Cost basis on current positions

`/positions` gives quantity, price, value and approximate holding dates, but no acquisition cost.
For each position, please add:

- the quantity whose cost is known
- the average acquisition price and total cost in dollars
- realised and unrealised profit against that same quantity
- the method, source, time priced and coverage
- a reason when transfers or missing legs make the cost unknowable

Never infer a zero cost from a transfer in.

### A13 · Seven small items

1. **Two holding times disagree.** `holdingTime` and `measurements.holdTimeDays` give the same median (about 1.06 days) with coverage 43 of 43 and 3 of 43. Which coverage is right?
2. **Directory figures missing for 144 of 435.** `pnl`, `volume`, `numTrades` and `updatedAt` are null, `@unipcs` among them.
3. **Balance in the chain's own coin.** The profile shows "114.09 BNB · $83.6K". Please add the native amount per chain to `now` or to `/portfolio.byChain`.
4. **Blacklist.** Please document whether `/trust.flags` includes any blacklist or known-scam check, which lists, and how "not checked" differs from "checked, not listed".
5. **Chains answered on sampled points.** They are `null`; see A2.
6. **The older host.** `genie-fomo-api.onrender.com` still answers `/v1/health` (435 traders). It returns 404 on `/v1/traders/<id>/aum` and on the batch call, and 503 "FOMOAPI_KEY is not set" on the scorecard. One of our environments was still pointed at it. If it is retired, please take it down or have it say so.
7. **The one-day window's step** says `1h` over readings a day apart, like A10.

---

## Part 5 · Corrections to what we said we would do

- **We will not warm every chain for every window every hour.** The all-chains answer made 376 of
  435 months drawable. Asking chain by chain added nobody, so warming everything would only add
  traffic. We will keep the chain switches and ask per chain when someone actually selects one.
- **`drawing.drawable` is evidence, not our only drawing rule.** We keep your decision and reason.
  Our screen still applies one rule to the exact history it shows: two usable points draw, one does
  not, and only an explicitly declared gap splits a line. The balance, the percentage and the line
  all come from that same history.
- **What we are doing, as promised:**
  - storing and sending your id, one call per read;
  - using the batch call with `chain` where a chain is selected;
  - drawing the all-chains line by default.

---

## Part 6 · What Genie owns, and is not asking you for

- Who follows or copies a trader, their faces, and who joined this week.
- Follow state, follow budget and exit rules.
- Our measured copy delay, slippage, and the "$1,000 copied last week" replay. The replay needs A5's trades as input.
- Warning signs from the trades and transfers we watched ourselves.
- The comparison ranks across the roster.
- The four tests, the verdict, the wording, and how an unavailable figure is shown.
- Reading the version 8 fields we do not use yet. `realizedByDay` for the 30-day calendar is ours to wire, not yours to change.

Across every route, the stable trader id and the wallet are the identity; a display handle is never
the key. Null means unknown, never zero.

---

## Part 7 · The contract Genie needs, route by route

This is the full list of what Genie calls, what it sends, and what it reads, including what already
works, so you can see which fields we depend on and must not change without telling us.

**State** column:
- **sent** — works today; please keep it as it is
- **change** — exists but needs to behave differently
- **new** — does not exist yet

**Ask** column: the request in Part 4 it belongs to.

### 7.1 · The directory — `GET /v1/traders`

| Parameter or field | What Genie uses it for | State | Ask |
| --- | --- | --- | --- |
| `limit`, `nextCursor` | Reading all 435 traders in one pass | sent | — |
| `entries[].id` | The trader's identity everywhere in Genie | sent | — |
| `entries[].handle`, `label`, `avatarUrl`, `rank` | The traders list and search | sent | — |
| `entries[].pnl`, `volume`, `numTrades` | Traders list figures, and the profile's "Volume" | **change**: null for 144 of 435 | A7, A13.2 |
| `entries[].updatedAt`, `capturedAt` | How old the list is | **change**: `updatedAt` null for 144; `capturedAt` is 8 Sep | A1 |

### 7.2 · Who the trader is — `GET /v1/traders/:id/wallets`

| Parameter or field | What Genie uses it for | State | Ask |
| --- | --- | --- | --- |
| `id`, `handle`, `name`, `profilePicture`, `handleChangedAt` | Name, picture, and keeping follows attached when a handle changes | sent | — |
| `wallets[].address`, `family` | The address under his name; matching trades we watch | sent | — |
| `wallets[].chains[].chain`, `networkId`, `tradesSeen`, `lastActiveAt` | Which chains each wallet is active on | sent | A1 (`lastActiveAt` is 5 Sep) |
| `knownChains[]`: `chain`, `networkId`, `wallets`, `hasPositions`, `historyState` | The chain tags under his name and the per-chain switches | **new** | A8 |

### 7.3 · Balance history — `GET /v1/traders/:id/aum` and `POST /v1/traders/aum`

| Parameter or field | What Genie uses it for | State | Ask |
| --- | --- | --- | --- |
| `window` = `1d`, `1w`, `1m`, `all` | The four chart buttons | sent | — |
| `chain` | A single-chain line when someone picks a chain | sent | — |
| Batch body `contractVersion: 2`, `ids` (up to 50), `window`, `chain` | Refreshing many traders in a few calls | sent | — |
| `ok: false` with `not_found` on unknown ids | Telling a wrong id from a trader with no readings | sent | — |
| `now.at`, `now.totalUsd`, `now.tier`, `now.coverage` | The balance figure | **change**: can be a one-chain partial rebuild | A2 |
| `now.basis`, `now.partial`, `now.chainsAnswered`, `now.chainsTotal` | Saying on the card when the balance is partial | **new** | A2 |
| `now.ageSeconds` | "as of Thursday" beside the balance | **new** | A1 |
| `sampler`: `state`, `lastAttemptAt`, `lastSuccessAt`, `nextExpectedAt`, `reason` | Knowing whether an old figure is expected or broken | **new** | A1 |
| `status` | `warming` versus a usable answer | **change**: says `ready` on 75-hour-old data | A1 |
| `points[].at`, `totalUsd`, `basis`, `tier`, `refused`, `outsideWindow` | The line | sent | — |
| `points[].coverage`: `pricedPositions`, `totalPositions`, `valueShare`, `chainsAnswered`, `chainsTotal`, `partial` | Saying how much of his money a point counts | **change**: chain fields null on sampled points | A2 |
| A method-change marker on the first point after `basis` changes, or both kinds valued alike | Breaking the line and never measuring a percentage across it | **new** | A3 |
| `step`, `stepMs` | Spacing of readings | **change**: the week says `6h`, holds `1d` | A10 |
| `gaps[]` | The only place Genie breaks a line | sent | — |
| `from`, `to`, `reach`: `requestedFrom`, `coveredFrom`, `coveredTo`, `complete` | What span the answer really covers | sent | — |
| `drawing`: `drawable`, `usablePoints`, `reason` | Evidence beside our own drawing rule | sent | A3 (`reason` for seams) |
| `trackedSince` | Where measured readings begin | sent | — |
| `chains[]`: `chain`, `networkId`, `totalUsd`, `pricedShare` | Per-chain balance and the summed line | sent | — |
| `chains[].nativeAmount`, `nativeSymbol` | "114.09 BNB" in "All the numbers" | **new** | A13.3 |

### 7.4 · What he holds — `GET /v1/traders/:id/portfolio` and `/positions`

| Parameter or field | What Genie uses it for | State | Ask |
| --- | --- | --- | --- |
| `asOf` | How old the holdings are | sent | A1 (10 Sep) |
| `totalValueUsd`, `byChain[]`: `chain`, `positions`, `priced`, `valueUsd` | Holdings total, and a cross-check on `now` | sent | — |
| `limit`, `nextCursor`, `complete` | Reading every position | sent | — |
| `entries[]`: `tokenAddress`, `chain`, `networkId`, `amount`, `priceUsd`, `priceSource`, `pricedAt`, `valueUsd`, `whyNoPrice`, `share`, `startHoldingAt`, `lastActiveAt` | His holdings list and coin sheets | sent | — |
| `entries[]`: `costKnownAmount`, `avgCostPrice`, `costUsd`, `realizedUsd`, `unrealizedUsd`, `costMethod`, `costSource`, `costCoverage`, `costReason` | "What he paid for what he holds" | **new** | A12 |

### 7.5 · The scorecard — `GET /v1/traders/:id/scorecard`

| Parameter or field | What Genie uses it for | State | Ask |
| --- | --- | --- | --- |
| `tokens=0` | A small answer when coin rows are not needed | sent | — |
| `asOf`, `sample.returned`, `sample.storedAt` | How old the scorecard is | **change**: 7 Sep and 5 Sep | A1, A9 |
| `complete`, `tradesKnown`, `tradesUsed`, `loadedAt`, `nextLoadAt` | Telling a whole record from a slice | **new** | A9 |
| `windows["24h" / "7d" / "30d" / "all"].realizedUsd`, `.closedTrades` | "+$3.3M made" and "Last 30 days +$359K" | sent | — |
| `realizedByDay[]`: `day`, `realizedUsd`, `closedTrades` | The 30-day calendar and worst day | sent | — |
| `realizedByMonth[]`: `month`, `realizedUsd`, `closedTrades`, `startCapitalUsd` or `returnPct`, `coverage` | "Worst month" and the "Survives bad days" test | **new** | A6 |
| `includesFees` on every realised figure; `feesUsd` and `volumeUsd` per window, each with coverage | "made, after fees", "Fees paid", "Volume" | **new** | A7 |
| `wins`, `losses`, `winRate`, `bestTradeUsd`, `worstTradeUsd`, `meanTradeUsd`, `medianTradeUsd`, `meanToMedian` | Win share, average profit per trade, comparison ranks | sent | — |
| `topTradeShare` | "Real record" and "One lucky trade?" | sent | — |
| `tradesPerDay`, `trackRecordDays`, `firstTradeAt`, `lastTradeAt` | "How often", "trading 540 days" | sent | A9 |
| `holdingTime`: `medianHours`, `medianDays`, `coverage` | "How long" and "Typical hold" | **change**: coverage disagrees with `measurements.holdTimeDays` | A13.1 |
| `typicalBetUsd`: `value`, `coverage` | "How much, $365 a bet" | **change**: null for most traders | A4 |
| `moneyIn`, `moneyOut`: `usd`, `coverage` | "Total bought", "Average buy / sell" | **change**: 24 and 56 of 363 trades | A4 |
| `returnPct`: `value`, `coverage` | His return on money in | **change**: 3 of 43 | A4 |
| `entryPriceCoverage.pricedShare` | How far to trust the figures above | sent | — |
| `byToken[]`: `address`, `symbol`, `trades`, `closed`, `realizedPnlUsd`, `firstClosedAt`, `lastClosedAt` | "7 in 10 coins made money", trade counts | sent | — |
| `byToken[]`: `avgEntryPrice`, `avgExitPrice`, `entryMethod`, `exitMethod`, `avgEntryMarketCapUsd` | The profit bands and "Size of coin when he buys" | **change**: null on 24 of 27 finished coins | A4 |
| `byToken[]`: `costUsd`, `proceedsUsd` | Each coin's result as a multiple of the money put in | **new** | A4 |
| `byToken[].buys[]`: `at`, `costUsd`, `marketCapUsd`, or per-buy entry counts by size | "95% of buys under $100K", counted per buy | **new** | A4 |
| A reason beside every null, e.g. `fieldReasons: { avgEntryPrice: "historical_input_missing" }` | Saying why a figure is missing | **new** | A11 |

### 7.6 · Individual trades — `GET /v1/traders/:id/trades`

| Parameter or field | What Genie uses it for | State | Ask |
| --- | --- | --- | --- |
| `limit` | Page size | sent | — |
| `cursor` in the request, `nextCursor` in the answer | Reading his whole record, not the first 100 | **new** | A5 |
| `chain`, `since`, `until`, `status` = `open` / `closed` filters | Last week's trades for the copy replay, one chain at a time | **new** | A5 |
| `trades[]`: `chain`, `networkId`, `txHash`, `at`, `side`, `token`, `money`, `valueUsd`, `priceUsd`, `tier` | The replay, the flip count, the warning signs | sent, Solana only | A5 |
| `trades[].positionId` or round-trip id; `status`; `closedAt` | Pairing each sell with its buy: "in and out under 5 seconds", "still open when our copy landed" | **new** | A5 |
| `trades[].feeUsd`, `source`, `confidence` | Fees per trade, and how far to trust each row | **new** | A5, A7 |
| `coverage.byChain[]`: `chain`, `state` = `complete` / `partial` / `unresolved`, `from`, `to` | Telling "no trades" from "not read" | **change**: only `chainsResolved` / `chainsTradedButUnresolved` today | A5 |

### 7.7 · Trust checks — `GET /v1/traders/:id/trust`

| Parameter or field | What Genie uses it for | State | Ask |
| --- | --- | --- | --- |
| `verdict`, `flags[]` | Red flags on "Should I copy?" | sent; the flag names are not documented | A13.4 |
| `reportedPnlUsd`, `volumeUsd` | Cross-check and "Volume" | **change**: null for `@unipcs` | A7 |
| `blacklist`: `checked`, `lists[]`, `listed`, `checkedAt` | "On a blacklist: No" | **new** | A13.4 |

### 7.8 · Service state — `GET /v1/health`

| Parameter or field | What Genie uses it for | State | Ask |
| --- | --- | --- | --- |
| `status`, `build.capturedAt` | Whether the service is up | sent | — |
| Sampler and trade-loader state, with last success times | One place to see that data has stopped arriving | **new** | A1 |

---

## Appendix · The commands behind every figure

```bash
export B=https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api

# A1, A3, A10 — all 435 weeks, fifty ids at a time (ids from the directory)
curl -s "$B/v1/traders?limit=500" | jq '[.entries[].id]'
curl -s -X POST "$B/v1/traders/aum" -H 'content-type: application/json' \
  -d '{"contractVersion":2,"ids":[…50 ids…],"window":"1w"}'

# A2, A3 — @unipcs's week, point by point
curl -s "$B/v1/traders/unipcs/aum?window=1w" \
  | jq '.points[] | {at, totalUsd, basis, coverage}, .now, .coverage'
curl -s "$B/v1/traders/unipcs/portfolio" | jq '{asOf, totalValueUsd, byChain}'

# A3 — @fhn_gt's week
curl -s "$B/v1/traders/fhn_gt/aum?window=1w" | jq '[.points[] | {at, totalUsd, basis}]'

# A4, A9, A11, A13.1 — @unipcs's scorecard
curl -s "$B/v1/traders/unipcs/scorecard" | jq '{sample, asOf, firstTradeAt, trackRecordDays,
  entryPriceCoverage, typicalBetUsd, returnPct, moneyIn, moneyOut, holdingTime,
  holdTime: .measurements.holdTimeDays, caveats}'
curl -s "$B/v1/traders/unipcs/scorecard" | jq '[.byToken[] | select(.closed > 0)
  | {symbol, closed, avgEntryPrice, avgExitPrice, avgEntryMarketCapUsd}]'

# A5 — trades and their coverage
curl -s "$B/v1/traders/unipcs/trades" | jq '{count, coverage}'

# A7, A13.2, A13.4
curl -s "$B/v1/traders/unipcs/trust"
curl -s "$B/v1/traders?limit=500" | jq '[.entries[] | select(.volume == null)] | length'

# A13.6 — the older host
curl -s "https://genie-fomo-api.onrender.com/v1/health"
curl -s "https://genie-fomo-api.onrender.com/v1/traders/e398bde0-98f7-47c9-8a43-a8edf967161a/aum?window=1m"
```

We are happy to re-run any of this on request. The whole directory takes about four minutes now
that the batch call names ids.
