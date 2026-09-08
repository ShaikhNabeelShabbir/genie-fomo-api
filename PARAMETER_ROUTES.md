# Parameter → Route

**Generated: 2026-09-08T06:41Z** · build `capturedAt 2026-09-07T11:38:55Z` · 8 generations

One row per parameter: what it means in plain words, the exact call that returns it, and
the field to read.

**Every figure below is a dated example, not current state.** They were pulled from the live
service at the timestamp above and the pipeline refreshes nightly, so they will have moved by
the time you read this. Treat them as "what this field looks like", never as today's value —
re-run the command for that.

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
| 401 | `unauthorized` | **Stop.** Only reachable when the deployment sets `GENIE_API_KEY`. The public deployment does not, so this status cannot occur there — see below. |
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

**On 401.** The service is keyless as deployed: `GENIE_API_KEY` is unset and the gate is
`if (KEY && ...)`, so every caller is anonymous and no request can 401. The row is kept
because a private deployment can set that variable and turn the check on. If you are calling
the public URL and see a 401, something in front of the API produced it, not the API.

### Rate limit headers

Every response — success and error alike, including the 429 itself — carries the current
budget, so you can pace without first provoking a rejection.

| Header | Meaning |
| --- | --- | 
| `RateLimit-Limit` | Requests allowed per 60s window (default 240; `RATE_LIMIT_PER_MINUTE`). |
| `RateLimit-Remaining` | Left in the current window, counting the response you are reading. |
| `RateLimit-Reset` | Seconds until the window resets. |
| `RateLimit-Scope` | `global` normally; `unlimited` if the limiter is failing open. |

The limit is **global**, not per instance: the counter is a single Postgres row bumped in one
atomic statement, so every instance sees the same number. Verified — 250 requests fired 12 at
a time on one key returned exactly 240 x 200 and 10 x 429, with `Remaining` decrementing
monotonically.

The counter is keyed on `x-api-key` when you send one, otherwise on the **leftmost** entry of
`x-forwarded-for` (the original client; the rest of the chain is intermediate hops). It is
checked before auth, so a flood of bad keys cannot be used to hammer the database.

**`RateLimit-Scope: unlimited` means the limiter is not counting.** It fails open: if the
database is unreachable the request is served rather than rejected, because a limiter that
turns a database blip into a site-wide outage costs more than the traffic it guards against.
In that state `Remaining` reads a full budget that is not being enforced — check `Scope`
before trusting a suspiciously fresh number.

`Retry-After` and the `RateLimit-*` headers are listed in `Access-Control-Expose-Headers`, so
browser clients can read them.

---

## 0. Routes that are not a single parameter

| Route | In plain words | Live value |
| --- | --- | --- |
| `GET $B/health` | "What's in the database, and when was it loaded?" | 137 traders · 3,356 holdings · 12,137 trades · 374,927 transfers |
| `GET $B/traders` | "Who are the top 137?" | each entry carries a stable `id` and its own `updatedAt` |
| `GET $B/traders/unipcs` | "Everything about one trader, and **what else I can ask**" | summary + `links` to all seven sub-routes |
| `GET $B/traders/unipcs/transactions?limit=5` | "What have their wallets actually done on-chain?" | `?kind=swap` filters to trades; each row carries `kind` and `protocol` |

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
| **T1** | "How much have they **actually cashed out**, versus what's only on paper?" | `GET $B/traders/unipcs/pnl` | `bankedUsd`, `onPaperUsd`, `realizedShare` | banked **−$131,120** · on paper **$17,491,476** |
| **T2** | "How much money went in, and how much came back out?" | `GET $B/traders/unipcs/scorecard` | `moneyIn`, `moneyOut` | $3,027,073 in — but **coverage 24/363 (6.6%)** |
| **T3** | "Turned $1,000 into what?" | same | `returnPct` | **−70.72%** on 3 of 43 closed trades (7% coverage) |
| **T4** | "How did they do this week / this month?" | same | `windows.{24h,7d,30d,all}` | 24h **$0** (0 closed) · 7d **−$131,120** (43 closed) |
| **T5** | "Which coins made or lost them money?" | same | `byToken[]` | 牛来 **+$168,977** over 1 closed trade |
| **T6** | "How often are they right?" | same | `winRate`, `wins`, `losses` | **44%** — 19 wins, 24 losses |
| **T7** | "Best and worst single trade" | same | `bestTradeUsd`, `worstTradeUsd` | best **+$168,977** · worst **−$118,667** |
| **T8** | "Is the profit **one lucky hit**?" | same | `topTradeShare` | **99.5%** of gains came from one trade |
| **T9** | "Fluke or consistent pattern?" | same | `meanToMedian`, `medianTradeUsd` | median trade **−$1.04**; ratio suppressed (see below) |
| **T10** | "How much do they usually risk per trade?" | same | `typicalBetUsd` | **$1,012** — via `volume_per_trade`, not entry prices |

**Read T6 and T1 together.** A 44% win rate sits alongside a net of **−$131,120**, because
one loss was −$118,667. The route never states the rate without the net beside it:

```bash
curl -s "$B/traders/unipcs/scorecard" | jq -r '.plain'
# Closed 43 trades and made money on 19 of them (44%), for a net of -$131,120.
```

**T9 returns null here on purpose.** The median trade is −$1.04, so the ratio would divide
across a sign change and describe nothing. It is emitted only when mean and median are both
positive; both dollar figures are always returned regardless.

---

## 2. Trader — positions

| # | In plain words | Call | Read | Live value |
| --- | --- | --- | --- | --- |
| **T11** | "How many different coins do they hold?" | `GET $B/traders/unipcs/portfolio` | `positions` | **97** |
| **T12** | "What exactly do they hold, and what is it worth?" | `GET $B/traders/unipcs/positions?limit=5` | `entries[]` | 15,874,700 BONK @ $0.2430 = **$3,858,279** |
| **T13** | "**How much is in just one coin?**" | `GET $B/traders/unipcs/portfolio` | `concentration` | **98.7%** in a single position |
| **T14** | "How much is parked in dollars?" | same | `cashShare` | **0%** — nothing is in stablecoins |
| **T15** | "How many open, how many closed?" | `GET $B/traders/unipcs/pnl` | `openPositions`, `closedTrades` | **320 open, 43 closed** |

T11 and T13 ship together by rule. "Holds 97 coins" reads as diversified until you see that
98.7% of the money is in one of them.

---

## 3. Trader — time

| # | In plain words | Call | Read | Live value |
| --- | --- | --- | --- | --- |
| **T16** | "How long do they usually hold?" | `GET $B/traders/unipcs/scorecard` | `holdingTime` | **1.06 days** (25.4h), coverage 43/43 |
| **T17** | "What did they pay to get in — **as a market cap**?" | same | `byToken[].avgEntryMarketCapUsd` + `totalSupply` | `frankdegods` · Stonks **$2,398,439 MC** from supply 1,000,000,000, `entryMethod: weighted` over 2 positions |
| **T18** | "Are they still active?" | same | `lastTradeAt` | **2026-09-07T11:22Z** |
| **T19** | "How long have they been trading?" | same | `trackRecordDays` | **108.4 days** |
| **T20** | "How busy are they?" | same | `tradesPerDay` | **3.35 trades/day** |

Unlike the price fields, **timestamps are populated on 100% of trades** — which is why all
of §3 is solid while §1 carries coverage caveats.

### Average entry is a market cap, and the supply travels with it

Entry reads on screen as "$717K MC", not as a per-token price, so `byToken[]` carries both:

```json
{ "symbol": "Stonks", "avgEntryPrice": 0.00239843884807,
  "avgEntryMarketCapUsd": 2398438.848,
  "entryMethod": "weighted", "entryPositions": 2, "entryPositionsWeighted": 2,
  "firstEntryPrice": 0.00160551,
  "totalSupply": 1000000000, "supplySource": "rpc", "supplyReadAt": "…" }
```

This example is itself one of the 319 corrected positions: `frankdegods` holds two positions
in Stonks, so the field used to return the first of them and now returns both, weighted.

### `avgEntryPrice` is a real average, and `entryMethod` says which kind

A fomo "trade" is a **position**, not a fill — one row can open in April and close in August
carrying a single `avgEntryPrice` that fomo has already averaged across the fills inside it.
So on the 96.9% of trader-token pairs with exactly one position, the value already *is* an
average. Where a trader holds **several** positions in one token, they are now combined into
a quantity-weighted average rather than the first one being returned.

`entryMethod` names the computation, because otherwise three different things arrive under
one field:

| `entryMethod` | Meaning | Rows |
| --- | --- | --- |
| `single_position` | One position; fomo averaged inside it | 3,699 |
| `weighted` | Averaged across positions, every leg weighted | 305 |
| `weighted_partial` | Some legs had no recoverable quantity and are excluded | 14 |
| `first_only` | No leg had a weight; earliest value returned | 0 |
| `null` | No entry price on record | 3,216 |

**The weight is status-dependent, and that matters.** On an *open* position `amount` is the
position, so it is the weight. On a *closed* position `amount` is what **remains** — nothing,
it was sold — so quantity is recovered from `pnl / (exit − entry)` instead. Weighting a
closed leg by `amount` is the same mistake that made BUG-1 wrong by ~10^17.

`firstEntryPrice` carries the pre-fix value so a consumer can reconcile against what this
field used to return. On `sadcrissy`'s CTO position (7 positions) the two differ by 9.8x:
`avgEntryPrice 0.00296464623767` against `firstEntryPrice 0.000302014`. All 319 affected
positions were recomputed in SQL and compared field-for-field against the live API: 319
matched, 0 mismatched. Single-position rows are bit-identical to what they returned before.

**Sells do not reduce it.** `sellsReduceIt: false`: this answers what they paid to get in
across their whole record, including positions they have since exited — not what their
remaining position cost.

**The supply is published because supply moves.** One coin was measured drifting 12.45% in
a day, so sending only a price would make a consumer's conversion and ours disagree with no
way to tell which was right. Sending the multiplier we used makes the two reconcilable.

`entryBasis` states what the average is over — `scope`, `sellsReduceIt`, `weighting`, and how
the cap is derived — because two reasonable definitions give different numbers and the figure
has to be labelled correctly on screen.

A token whose supply we could not resolve returns `null` for the market cap, never `0` — and
`unipcs`'s largest holdings are in that state, which is why the example above uses a different
trader.

---

## 4. Trust

| # | In plain words | Call | Read | Live value (`ogle`) |
| --- | --- | --- | --- | --- |
| **TRUST** | "**Do their own numbers even add up?**" | `GET $B/traders/ogle/trust` | `verdict`, `flags[]`, `pnlToVolume`, `basis` | **self_contradictory** — fomo reports **13.37×** more profit than volume |

```bash
curl -s "$B/traders/ogle/trust" | jq -r '.verdict, .plain'
# self_contradictory
# fomo's own profit and volume figures for this trader do not reconcile with each other.
```

**The verdict describes the numbers, not the trader.** `self_contradictory` means two figures
fomo published cannot both be right — profit of $5,320,901 on $398,122 of lifetime volume.
Both sides are fomo's own, so our coverage has no bearing on it.

Four verdicts, and the difference between them matters:

| verdict | means |
| --- | --- |
| `self_contradictory` | fomo's own profit and volume disagree |
| `unverified` | profit far exceeds a portfolio we CAN see |
| `unverifiable` | too little of the portfolio is priced to say anything |
| `ok` | nothing contradicts |

A `basis` object names each denominator, so a verdict can be weighed rather than taken:

```json
"pnlToVolume":   { "denominator": "fomo reported volume", "bothReported": true }
"pnlToHoldings": { "denominator": "our sum of priced positions",
                   "pricedPositions": 6, "totalPositions": 48, "pricedShare": 0.125 }
```

`pnl_exceeds_holdings` is withheld below 0.5 coverage and replaced by
`holdings_coverage_too_low` — a ratio against one eighth of a portfolio cannot support a
claim about the whole.

---

## 5. Token

| # | In plain words | Call | Read | Live value |
| --- | --- | --- | --- | --- |
| **K1** | "**What are the leaders crowding into?**" | `GET $B/tokens?limit=5` | `entries[].holders` | top token held by **58 of 137** |
| **K2** | "What did they move into or out of since last time?" | `GET $B/tokens/momentum` | `entries[].change` | **1,171 tokens moved** across a 25.3h span |
| **K3** | "How much leader money is in it?" | `GET $B/tokens?limit=5` | `entries[].totalValueUsd` | null when no holder has a price |
| **K4** | "Who else holds it?" | same | `entries[].holderHandles` | DumbCrayonEater, frogmanhaha, ogle… |
| **K5** | "What did the crowd pay to get in?" | `GET $B/tokens/Ai66LHZ…q5ppump/activity?chain=solana` | `crowdAvgEntryPrice` | **null** — no holder of this token has a recorded entry price |
| **K5a** | "…and is that a typical leader, or the biggest one?" | same | `crowdAvgEntryPrice.method` | **one trader, one vote** — an unweighted mean over each holder's own weighted entry |
| **K6** | "Of those who sold, how many won?" | same | `winRate`, `winners`, `losers` | **100%** — 17 winners, 0 losers |
| **K7** | "**Has anyone who holds this ever actually sold it?**" | same | `everSold`, `holdersWhoSold` | **true** — 17 have sold |
| **K8** | "Are they buying or getting out?" | same | `flow.verdict` | **accumulating** (114 opened, 17 closed) |
| **K9** | "Which chain does it live on?" | `GET $B/tokens?limit=5` | `entries[].chain` | ethereum / solana / bsc / base / robinhood |

**K7 is the sharpest signal here.** A token every leader holds and nobody has ever exited is
the shape of a honeypot. It returns `null`, never `false`, when no holder has a trade
record — "nobody has ever sold" and "we have no evidence" are different claims.

`coverage` on that route separates two populations that are easy to conflate:

```json
{ "holdersNow": 58, "withTradeRecord": 121, "holdersNowWithNoRecord": 0 }
```

121 traders have a record for a token 58 people currently hold — **63 traded it and got out
entirely.** That is exit information a holder count alone cannot show.

---

## 6. Chain

| # | In plain words | Call | Read | Live value |
| --- | --- | --- | --- | --- |
| **C1** | "How many leaders trade this chain?" | `GET $B/chains` | `entries[].traders` | Solana **92 of 137** |
| **C2** | "How much of their money sits there?" | same | `entries[].totalValueUsd` | Solana **$35,989,769** |
| **C3** | "Which chain did they make their money on?" | same | `entries[].realized` | robinhood **+$1,679,429** · solana **−$1,103,437** |
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
robinhood   2925 closed   $1,679,429    pricedShare 0
bsc         1057 closed   $6,211,462    pricedShare 0
solana      1113 closed  -$1,103,437    pricedShare 0.78
base         112 closed     $697,136    pricedShare 0
ethereum      77 closed    -$266,586    pricedShare 0
unattributed  48 closed    -$151,084   ← published, never absorbed
```

Each `realized` block now carries `tier: "reported"` and `source: "fomoapi trade records"`,
so a chain showing `pricedShare: 0` beside a dollar profit is no longer a puzzle — the profit
comes from trade records and the pricing from the holdings snapshot.

This is **realized** profit from fomo's own trade records — the same Reported tier as
everything else on this board. It is not independently verified.

---

## 8. Read the coverage before the number

Several parameters ship a `coverage` object. It is not decoration — it is the difference
between a fact and a confident-looking guess:

```json
"returnPct": { "value": -70.72, "coverage": { "of": 3, "total": 43, "share": 0.0698 } }
```

A return computed from 3 of 43 closed trades is thin, and the coverage object says so rather
than the value being withheld — the reader decides. `unipcs` is the worst case on the board.

The same rule governs `holdings.value`: most positions have no price at all, and a missing
price is excluded from every aggregate rather than counted as zero.
