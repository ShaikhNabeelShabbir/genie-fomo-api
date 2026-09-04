# Parameter → Route

One row per parameter: what it means in plain words, the exact call that returns it, and
the field to read. Every value shown below was pulled from the live service, not invented.

```bash
export B=https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api
```

No API key. **Zero external calls per request** — every route answers from Postgres, and
the provider keys belong to the scheduled loaders.

Supabase already serves this function under `/functions/v1/api`, so an extra `/v1` is
**optional** — `$B/traders/unipcs` and `$B/v1/traders/unipcs` both resolve. The short form
is used throughout below.

**The handle is a parameter, not the first segment**: it is `$B/traders/unipcs/wallets`,
never `$B/unipcs/wallets`.

**All 35 parameters are live.**

Every money figure carries an **`asOf`**. Every "not known" is **`null`, never `0`** — a
zero would read as "worth nothing", which is a different and much worse statement than
"we could not value it".

---

## 0a. Errors — telling apart "stop", "back off" and "retry"

Every error body carries a stable machine-readable `code` beside the human `detail`, because
status alone cannot separate "no such trader" from "no such route".

| Status | `error.code` | What to do |
| --- | --- | --- |
| 400 | `bad_request` | Fix the parameter. `error.detail` names it. |
| 401 | `unauthorized` | **Stop.** The key is missing or wrong; retrying will not help. |
| 404 | `not_found` | Wrong handle, token, or URL shape. The body lists valid routes. |
| 429 | `rate_limited` | **Back off.** `Retry-After` header and `error.retryAfterSeconds`. |
| 503 | `unavailable` | **Retry**, and keep showing your last good copy. |
| 500 | `internal_error` | A real bug. Report it. |

A 404 for an unknown route returns the 15 valid routes plus a hint, so a URL-shape mistake
is self-correcting rather than a guessing game.

```json
{ "error": { "code": "rate_limited", "detail": "too many requests — retry after the stated delay",
             "retryAfterSeconds": 57 } }
```

---

## 0. Routes that are not a single parameter

| Route | In plain words | Live value |
| --- | --- | --- |
| `GET $B/health` | "What's in the database, and when was it loaded?" | 100 traders · 2,038 holdings · 6,398 trades · 42,033 transfers |
| `GET $B/traders` | "Who are the top 100?" | each entry carries a stable `id` and its own `updatedAt` |
| `GET $B/traders/unipcs` | "Everything about one trader, and **what else I can ask**" | summary + `links` to all seven sub-routes |
| `GET $B/traders/unipcs/transactions?limit=5` | "What have their wallets actually done on-chain?" | `stored: 476` transfers for `unipcs` |

**`id` is stable, `handle` is not.** Every trader carries a UUID `id` that is ours and never
reissued; `handle` comes from fomo and is theirs to rename. Key your rows on `id`.

**`updatedAt` is per trader.** The board envelope's `capturedAt` covers the whole list, so it
cannot tell a trader refreshed a minute ago from one refreshed yesterday — each entry now
carries its own.

**Start at `$B/traders/<handle>`.** It returns a `links` object naming every sub-route for
that trader, so the next URL never has to be guessed. It also separates `reported`
(the leaderboard's own figures) from `stored` (what we actually hold), which is the same
Reported-vs-Verified split that runs through the rest of this document.

---

## 1. Trader — money

| # | In plain words | Call | Read | Live value (`unipcs`) |
| --- | --- | --- | --- | --- |
| **T1** | "How much have they **actually cashed out**, versus what's only on paper?" | `GET $B/traders/unipcs/pnl` | `bankedUsd`, `onPaperUsd`, `realizedShare` | banked **−$209,204** · on paper **$13,848,582** |
| **T2** | "How much money went in, and how much came back out?" | `GET $B/traders/unipcs/scorecard` | `moneyIn`, `moneyOut` | $2,559,114 in — but **coverage 21/191 (11%)** |
| **T3** | "Turned $1,000 into what?" | same | `returnPct` | **null** — only 2 of 25 closed trades have both prices |
| **T4** | "How did they do this week / this month?" | same | `windows.{24h,7d,30d,all}` | 24h **+$215** (7 closed) · 7d **−$209,204** (25) |
| **T5** | "Which coins made or lost them money?" | same | `byToken[]` | SPCXB **+$184.15** over 3 closed trades |
| **T6** | "How often are they right?" | same | `winRate`, `wins`, `losses` | **56%** — 14 wins of 25 |
| **T7** | "Best and worst single trade" | same | `bestTradeUsd`, `worstTradeUsd` | best **+$198** · worst **−$118,667** |
| **T8** | "Is the profit **one lucky hit**?" | same | `topTradeShare` | **45%** of gains came from one trade |
| **T9** | "Fluke or consistent pattern?" | same | `meanToMedian`, `medianTradeUsd` | median trade **$0.15**; ratio suppressed (see below) |
| **T10** | "How much do they usually risk per trade?" | same | `typicalBetUsd` | **$910** — via `volume_per_trade`, not entry prices |

**Read T6 and T1 together.** A 56% win rate sits alongside a net of **−$209,204**, because
one loss was −$118,667. The route never states the rate without the net beside it:

```bash
curl -s "$B/traders/unipcs/scorecard" | jq -r '.plain'
# Closed 25 trades and made money on 14 of them (56%), for a net of -$209,204.
```

**T9 returns null here on purpose.** A mean of −$8,368 over a median of $0.15 is
"−56,822×" — arithmetically true, informationally worthless. The ratio is emitted only when
mean and median are both positive; both dollar figures are always returned.

---

## 2. Trader — positions

| # | In plain words | Call | Read | Live value |
| --- | --- | --- | --- | --- |
| **T11** | "How many different coins do they hold?" | `GET $B/traders/unipcs/portfolio` | `positions` | **118** |
| **T12** | "What exactly do they hold, and what is it worth?" | `GET $B/traders/unipcs/positions?limit=5` | `entries[]` | 15,905,133 BONK @ $0.2249 = **$3,576,491** |
| **T13** | "**How much is in just one coin?**" | `GET $B/traders/unipcs/portfolio` | `concentration` | **98.5%** in a single position |
| **T14** | "How much is parked in dollars?" | same | `cashShare` | **0.04%** — almost nothing is safe |
| **T15** | "How many open, how many closed?" | `GET $B/traders/unipcs/pnl` | `openPositions`, `closedTrades` | **166 open, 25 closed** |

T11 and T13 ship together by rule. "Holds 118 coins" reads as diversified until you see
that 98.5% of the money is in one of them.

---

## 3. Trader — time

| # | In plain words | Call | Read | Live value |
| --- | --- | --- | --- | --- |
| **T16** | "How long do they usually hold?" | `GET $B/traders/unipcs/scorecard` | `holdingTime` | **1.12 days** (26.8h), coverage 25/25 |
| **T17** | "What did they pay to get in — **as a market cap**?" | same | `byToken[].avgEntryMarketCapUsd` + `totalSupply` | LEGS **$2,867,200 MC** from supply 1,000,000,000 |
| **T18** | "Are they still active?" | same | `lastTradeAt` | **2026-09-04T07:41Z** |
| **T19** | "How long have they been trading?" | same | `trackRecordDays` | **105.2 days** |
| **T20** | "How busy are they?" | same | `tradesPerDay` | **1.81 trades/day** |

Unlike the price fields, **timestamps are populated on 100% of trades** — which is why all
of §3 is solid while §1 carries coverage caveats.

### Average entry is a market cap, and the supply travels with it

Entry reads on screen as "$717K MC", not as a per-token price, so `byToken[]` carries both:

```json
{ "symbol": "LEGS", "avgEntryPrice": 0.0028672,
  "avgEntryMarketCapUsd": 2867200,
  "totalSupply": 1000000000, "supplySource": "rpc", "supplyReadAt": "…" }
```

**The supply is published because supply moves.** One coin was measured drifting 12.45% in
a day, so sending only a price would make a consumer's conversion and ours disagree with no
way to tell which was right. Sending the multiplier we used makes the two reconcilable.

`entryBasis` states what the average is over — `scope`, `sellsReduceIt: false`, and how the
cap is derived — because two reasonable definitions give different numbers and the figure
has to be labelled correctly on screen.

Coverage: **1,394 tokens have a supply (94% of trades with an entry price)**. 102 tokens
resolve a chain but no supply, and 16 have no chain at all. Both return `null`, never `0`.

---

## 4. Trust

| # | In plain words | Call | Read | Live value (`Natan_benish`) |
| --- | --- | --- | --- | --- |
| **TRUST** | "**Do their own numbers even add up?**" | `GET $B/traders/Natan_benish/trust` | `verdict`, `flags[]`, `pnlToVolume` | **implausible** — profit is **374×** their lifetime volume |

```bash
curl -s "$B/traders/Natan_benish/trust" | jq -r '.verdict, .plain'
```

This is a plausibility check, not a fraud finding: it means the number cannot be
corroborated from the data we hold.

---

## 5. Token

| # | In plain words | Call | Read | Live value |
| --- | --- | --- | --- | --- |
| **K1** | "**What are the leaders crowding into?**" | `GET $B/tokens?limit=5` | `entries[].holders` | top token held by **33 of 100** |
| **K2** | "What did they move into or out of since last time?" | `GET $B/tokens/momentum` | `entries[].change` | needs 2 loader runs; says so when it has 1 |
| **K3** | "How much leader money is in it?" | `GET $B/tokens?limit=5` | `entries[].totalValueUsd` | null when no holder has a price |
| **K4** | "Who else holds it?" | same | `entries[].holderHandles` | DumbCrayonEater, frogmanhaha, ogle… |
| **K5** | "What did the crowd pay to get in?" | `GET $B/tokens/Ai66LHZ…q5ppump/activity?chain=solana` | `crowdAvgEntryPrice` | **$0.0338**, coverage 12/30 |
| **K6** | "Of those who sold, how many won?" | same | `winRate`, `winners`, `losers` | **45%** — 5 of 11 |
| **K7** | "**Has anyone who holds this ever actually sold it?**" | same | `everSold`, `holdersWhoSold` | **true** — 11 have sold |
| **K8** | "Are they buying or getting out?" | same | `flow.verdict` | **mixed** (22 opened, 15 closed) |
| **K9** | "Which chain does it live on?" | `GET $B/tokens?limit=5` | `entries[].chain` | ethereum / solana / bsc / base / robinhood |

**K7 is the sharpest signal here.** A token every leader holds and nobody has ever exited is
the shape of a honeypot. It returns `null`, never `false`, when no holder has a trade
record — "nobody has ever sold" and "we have no evidence" are different claims.

`coverage` on that route separates two populations that are easy to conflate:

```json
{ "holdersNow": 12, "withTradeRecord": 30, "holdersNowWithNoRecord": 0 }
```

30 traders have a record for a token 12 people currently hold — **18 traded it and got out
entirely.** That is exit information a holder count alone cannot show.

---

## 6. Chain

| # | In plain words | Call | Read | Live value |
| --- | --- | --- | --- | --- |
| **C1** | "How many leaders trade this chain?" | `GET $B/chains` | `entries[].traders` | Solana **57 of 100** |
| **C2** | "How much of their money sits there?" | same | `entries[].totalValueUsd` | Solana **$10,544,636** |
| **C3** | "Which chain did they make their money on?" | same | `entries[].realized` | robinhood **+$1,850,549** · solana **−$1,503,966** |
| **C4** | "**What can we even see on this chain?**" | same | `entries[].historyCoverage` | solana → helius · robinhood → blockscout (keyless) |
| **C5** | "Can a position size be checked on-chain?" | same | `entries[].balanceVerifiable` | **true on all five chains** |

The finding that shapes everything else:

```bash
curl -s "$B/chains" | jq -r '.entries[] | "\(.chain)\t\(.positions) pos\t$\(.totalValueUsd // "—")\tpriced \(.coverage.pricedShare)"'
```

**Only Solana carries prices — every other chain is 0% priced.** So every dollar figure in
this API is, in practice, a Solana figure.

---

## 7. Two parameters that used to be listed as impossible

**T4 and C3 were both once listed as impossible, and are now live.** Both were blocked only while the
leaderboard file was the sole source: it gives one lifetime `pnl` per trader with nothing to
slice by time or chain. Storing per-trade history removed both obstacles — every closed
trade carries its own `closed_at` and `network_id`, so neither figure invents an
attribution, it sums records that already know when and where they happened.

C3 needed one extra step. 39% of trades had no chain (tokens traded but no longer held match
nothing in `tokens`), and that bucket held **−$2.46M of realized P&L** — far too large to
publish a breakdown around. Resolving those by address shape and `eth_getCode` cut it to
**26 closed trades and −$137K**, which is now published as `unattributedRealized` rather
than folded into a chain row.

---

## 7b. Chain profitability, and what it does not say

```bash
curl -s "$B/chains" | jq -r '.entries[] | "\(.chain)\t\(.realized.closedTrades) closed\t$\(.realized.pnlUsd)"'
```

```
robinhood   1396 closed   $1,850,549
solana       413 closed  -$1,503,966
bsc          365 closed   $1,834,528
base          62 closed     $699,745
ethereum      40 closed    -$221,218
unattributed  26 closed    -$137,427   ← published, never absorbed
```

This is **realized** profit from fomo's own trade records — the same Reported tier as
everything else on this board. It is not independently verified.

---

## 8. Read the coverage before the number

Several parameters ship a `coverage` object. It is not decoration — it is the difference
between a fact and a confident-looking guess:

```json
"returnPct": { "value": null, "coverage": { "of": 2, "total": 25, "share": 0.08 } }
```

A return % computed from 2 of 25 closed trades is not a return %, so the route returns
`null` and shows you the denominator. `unipcs` is the worst case on the board — across the
other 99 traders entry-price coverage is **47%**, and most get real numbers.

The same rule governs `holdings.value`: **1,688 of 2,038 positions have no price at all**,
and a missing price is excluded from every aggregate rather than counted as zero.
