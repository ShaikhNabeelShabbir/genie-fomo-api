# Trader parameters — what we show, and why

## Build status

| | Meaning |
| --- | --- |
| ✅ | built and tested |
| ⚠️ | built, but the source data is too sparse to trust — the route returns `null` and says why |
| 🎯 | next up |
| ⬜ | not started |

**Priority rule: build what has no external dependency first.** Anything computable from
`data/wallet.full.data.json` alone ships with no key, no rate limit and no staleness beyond
the file's own.

| Status | Parameter | Route | Depends on |
| --- | --- | --- | --- |
| ✅ | **T11** position count | `GET /v1/traders/:handle/portfolio` | file only |
| ✅ | **T13** concentration | same route (`concentration`, `partial`) | file only |
| ✅ | **T14** cash vs coins | same route (`cashShare`) | file only |
| ✅ | **T12** quantity & value per position | `GET /v1/traders/:handle/positions` | file only |
| ✅ | **K1** crowding / trending tokens | `GET /v1/tokens` | file only |
| ✅ | **K3** money parked in a token | same route (`totalValueUsd`) | file only |
| ✅ | **K4** who else holds it | same route (`holderHandles`) | file only |
| ✅ | **K9** which chain | same route (`chain`) | file only |
| ✅ | **K1/K3/K4** for one token | `GET /v1/tokens/:address` | file only |
| ✅ | **Trust flags** plausibility of reported numbers | `GET /v1/traders/:handle/trust` | postgres |
| ✅ | **C1** leaders per chain · **C2** value per chain · **C4** our coverage · **C5** verifiability | `GET /v1/chains` | file only |
| ✅ | **T1** banked vs on paper | `GET /v1/traders/:handle/pnl` | postgres · `trades` |
| ✅ | **T5–T9, T15, T16, T18, T19, T20** the scorecard | `GET /v1/traders/:handle/scorecard` | **same fetch as T1 — no extra call** |
| ✅ | **T2** money in/out · **T3** return % · **T17** entry/exit | same route | fomoapi carries these on **46.5% / 43.5%** of trades — see the correction below |
| ✅ | **T10** typical bet size | same route (`typicalBetUsd.method`) | falls back to `volume ÷ trades` |
| ✅ | **K5–K8** crowd entry, per-token win rate, ever-sold, flow | `GET /v1/tokens/:address/activity` | postgres · `trades` — no fan-out, no cap |
| ✅ | **K2** momentum | `GET /v1/tokens/momentum` | two generations of `holdings.captured_at` |
| ✅ | **C3** chain profitability | `GET /v1/chains` (`entries[].realized`) | postgres · `trades.network_id` |
| ✅ | **T4** time-framed profit | `GET /v1/traders/:handle/scorecard` (`windows`) | postgres · `trades.closed_at` |

**Thirty-five parameters across fifteen routes, every one served from Postgres with zero
external calls per request.**

### What the routes found

Running trust across the whole board is not a formality — it disqualifies most of it:

```
100 traders scored:   44 implausible    29 unverified    27 ok
Natan_benish reports profit 244x their entire lifetime volume
```

T1 and the scorecard on the rank-1 trader show why banked, on-paper and reported must
never be merged:

```
unipcs   leaderboard file says  : $7,366,512 profit
         actually banked        :  -$209,204   (net across 25 closed trades)
         still on paper         : $14.4M       (159 open positions)
         win rate               :  56%         (14 of 25) -- while down $209k
```

**That win rate is the point of the whole document.** 56% sounds like skill; it sits
alongside a net loss because one trade lost $118,667. Any figure that can invert its own
story this badly ships with the counterweight attached — the scorecard's `plain` never
states a win rate without the net beside it.

`/v1/chains` produced the sharpest constraint in the project:

```
solana      99 leaders   1,605 positions   $18,517,143   90% priced
robinhood   13 leaders     226 positions   no value       0% priced
bsc         11 leaders      95 positions   no value       0% priced
base        12 leaders      68 positions   no value       0% priced
ethereum    13 leaders      18 positions   no value       0% priced
```

**Outside Solana, not a single position in the snapshot carries a price.** Every
dollar figure this API reports is, in practice, a Solana figure. C2 is therefore answerable
on one chain out of five, and the route says so per row rather than summing to a total that
would imply otherwise.

---

## 1. Trader parameters

### 1A. Money

| # | Parameter | Layman phrasing | Computed from | Tier |
| --- | --- | --- | --- | --- |
| ✅ T1 | **Banked vs on paper** | "Cashed out **$6,171** · **$2.1M still on paper**" | `realized / (realized + unrealized)` | Reported |
| ✅ T2 | Money in / money out | "Put in **$86,400** · took out **$102,100**" | `amount × avgEntry` / `amount × avgExit` | Reported |
| ✅ T3 | Return % | "Turned **$1,000 into $1,420**" | `realized ÷ cost basis` | Reported |
| ✅ T4 | Time-framed profit | "This week: **+$215**" | `sum(realized_pnl_usd)` by `closed_at` window | Reported |
| ✅ T5 | Per-token P&L | "**+$2,100 on PONS**, −$340 on BONK" | `realizedPnlUsd` by `token.symbol` | Reported |
| ✅ T6 | **Win rate** | "Made money on **3 of every 4** coins" | `count(pnl>0) ÷ closed` | Reported |
| ✅ T7 | Best / worst trade | "Best **+$198** · worst **−$118,667**" | max/min `realizedPnlUsd` | Reported |
| ✅ T8 | **One-trade dependence** | "**45% of the gains are one trade**" | `best ÷ gross gains` | Reported |
| ✅ T9 | **Fluke or pattern** | "One lucky hit" vs "consistent" | `mean ÷ median` trade | Reported |
| ✅ T10 | Typical bet size | "Usually risks **$918 a trade**" | median entry size, else `volume ÷ trades` | Reported |

**Correction — T2, T3 and T17 were downgraded on a sample of one, and that sample was the
outlier.** The 11%/8% figures below came from `unipcs` alone. Measured across all 6,398
trades now in the database:

| | `unipcs` | the other 99 traders |
| --- | --- | --- |
| trades | 191 | 6,207 |
| entry price present | **11.0%** | **47.6%** |
| closed trades with both prices | **8.0%** | **63.5%** |

Per-trader, 51 have usable entry coverage (≥50%), 35 partial, 12 thin, and 2 none. So T3 is
genuinely computable for most of the board, and the routes were already doing the right
thing: every price-derived figure ships with its own coverage denominator and returns `null`
when it is too thin, so `unipcs` correctly gets nulls while the other 99 get numbers. It was
the documentation that was wrong, not the code.

Two sign rules are load-bearing, because breaking either produces a plausible lie:

- **T8 divides by gross gains, never the net.** A net total can be zero or negative, which
  is how a "share of profit" ends up reading 2000%.
- **T9 is emitted only when mean and median are both positive.** Measured: a mean of
  −$8,368 over a median of $0.15 yields "−56,822×", which is arithmetically true and
  informationally worthless. Both dollar figures are always returned regardless.

### 1B. Positions

| # | Parameter | Layman phrasing | Computed from | Tier |
| --- | --- | --- | --- | --- |
| ✅ T11 | Number of tokens | "Holds **95 different coins**" | `holdings.length` | Reported |
| ✅ T12 | Quantity & value | "**10,957,270 PONS**, worth **$2.2M**" | `humanAmount`, `value` | Reported · *verifiable* |
| ✅ T13 | **Concentration** | "**97% of their money is in one coin**" | `max(value) ÷ sum(value)` | Reported |
| ✅ T14 | Cash vs coins | "**40% sitting in dollars**" | stablecoin share of value | Reported |
| ✅ T15 | Open vs closed | "**159 open, 243 closed**" | `activeCount`, `closedCount` | Reported |

**T15 does not reconcile and the route says so.** fomo reports 159 open + 243 closed = 402
for `unipcs`, then returns 184 rows at `limit=500`. Every array-derived figure in the
scorecard therefore describes the returned sample, not the lifetime, and `sample.reconciles`
carries that as a boolean rather than a footnote.

### 1C. Time

| # | Parameter | Layman phrasing | Computed from | Tier |
| --- | --- | --- | --- | --- |
| ✅ T16 | **Holding time** | "Usually holds about **1.1 days**" | median `closedAt − createdAt` | Reported |
| ✅ T17 | Entry / exit | "Bought at **$0.013**, sold at **$0.036**" | `avgEntryPrice`/`avgExitPrice` | Reported · *verifiable via Bitquery* |
| ✅ T18 | Still active | "Last trade **4 hours ago**" | most recent timestamp | Reported |
| ✅ T19 | **Track record length** | "Trading for **105 days**" | span of `createdAt` | Reported |
| ✅ T20 | Trading pace | "About **1.75 trades a day**" | `trades ÷ days` | Reported |

Unlike the price fields, **timestamps are populated on 100% of trades** — which is why the
whole of §1C ships green while §1A does not. T17 is the exception: it is a price, and it is
surfaced per token in `byToken` where present, `null` where not. A returned `avgEntryPrice`
of `0` is treated as absent, not as a price, because fomo uses `0` for "unknown" and a
$0 entry implies someone got in for nothing.

---

## 2. Token parameters

Subject is the **coin**, not the person. K1/K3/K4/K9 cost **zero API calls**, by inverting
`holdings[]` into a `tokenAddress → traders` index. K5–K8 cost one call per sampled holder.

| # | Parameter | Layman phrasing | Computed from | Tier |
| --- | --- | --- | --- | --- |
| ✅ K1 | **Crowding** | "**25 of the top 100** traders own this" | count holders of `tokenAddress` | Reported |
| ✅ K2 | Momentum | "**+8 new holders today**" | diff two snapshots | Reported |
| ✅ K3 | Money parked in it | "Leaders hold **$1.76M** of this" | sum `value` | Reported · *verifiable* |
| ✅ K4 | Who else holds it | "Also held by unipcs, theveeman" | reverse index | Reported |
| ✅ K5 | Crowd's average entry | "Leaders bought around **$0.053**" | mean `avgEntryPrice` | Reported |
| ✅ K6 | **Per-token win rate** | "**0 of 1** holders made money on this" | `realizedPnlUsd` by token | Reported |
| ✅ K7 | **Has anyone ever sold it?** | "⚠️ **No proven exit** — every holder still holding" | any `status: closed` | Reported |
| ✅ K8 | Accumulating or distributing | "Leaders are **buying**" | open vs closed balance | Reported |
| ✅ K9 | Which chain | "Lives on **BSC**" | `networkId` from the file | Reported |

**K7 returns `null`, never `false`, when no sampled holder has a trade record.** "Nobody
has ever sold this" and "we have no evidence either way" are different claims, and only one
of them is a honeypot signal.

Measured on CATE (`Ai66LHZ…q5ppump`), 10 holders sampled of 21:

```
leaders hold          $1,761,741
holders with a record          5   (the other 5 are unknown, not clean)
have ever sold                 2
came out ahead                 0   -- both lost; -$5,580 and -$0.30
crowd entry / exit      $0.04898 -> $0.0344
```

Every one of those denominators is in the response. A "0% win rate" on 2 holders out of 21
is not a verdict on the token, and `sampled` says so on the same line.

**The 25-holder cap is gone.** It existed because the Express route made one live fomoapi
call per holder against a 10,000/month tier. Reading `trades` from Postgres removed both the
cost and the cap: every trader with a record for the token is included, in about a second.

---

## 3. Chain parameters

Subject is the **blockchain**. This section exists because **what we can see differs by
chain**, which constrains every parameter above.

### Activity distribution (measured, current file — `GET /v1/chains`)

| Chain | `networkId` | Leaders | Positions | Tokens | Value | Priced |
| --- | --- | --- | --- | --- | --- | --- |
| Solana | 1399811149 | 99 | **1,605** | 682 | **$18,517,143** | 90% |
| Robinhood | 4663 | 13 | 226 | 122 | — | **0%** |
| BSC | 56 | 11 | 95 | 56 | — | **0%** |
| Base | 8453 | 12 | 68 | 39 | — | **0%** |
| Ethereum | 1 | 13 | 18 | 4 | — | **0%** |

Plain-language: *"these traders are overwhelmingly Solana memecoin traders"* — and more
sharply, **every dollar figure in this API is a Solana figure**, because no other chain has
a single priced position.

### Chain-level parameters

| # | Parameter | Layman phrasing | Tier |
| --- | --- | --- | --- |
| ✅ C1 | Leaders active here | "**99 of 100** leaders trade Solana" | Reported |
| ✅ C2 | Value on this chain | "**$18.5M** of leader money sits on Solana" | Reported |
| ✅ C3 | Chain profitability | "Leaders made most of their money on **Robinhood**" | Reported — `sum(realized_pnl_usd)` by `trades.network_id` |
| ✅ C4 | **Coverage warning** | "⚠️ **BSC history needs Bitquery**" | ✅ Verified (our own credentials) |
| ✅ C5 | `balanceOf` verifiability | "Position **✓ checkable on-chain**" | ✅ Verified — free on all 5 chains |

**C5 is worth stating plainly: `balanceOf` works on every chain, free and keyless** — even
BSC and Base, which have no free *history*. So position sizes are always checkable even
when transaction history is not.

---

## 4. Snapshots — the substrate K2 runs on

Every other parameter is a function of the current file. **K2 is not**: "what changed" is
not a property of one snapshot, and no cleverness recovers it from a single file.

**The file-based snapshot archive is gone**, and so are `/v1/snapshots` and `snapshots.ts`.
`captured_at` is part of the primary key on `holdings`, so history is the table and momentum
is a self-join over its two most recent generations. With fewer than two the route returns
`available: false` and explains itself, rather than an empty board — "nothing moved" and "we
have no baseline" must never render identically.

**Deployment caveat:** the archive lives on the instance filesystem. On an ephemeral host
(Render's free tier included) it resets on redeploy, so for momentum to accumulate the
archive has to be committed by the same pipeline that refreshes the directory file, or
moved to durable storage.

---

## 5. On the Tier column

- **Reported** — fomo's or the file's word for it. We pass it through and label it.
- **Verified** — we read it ourselves and can prove it.
- ***verifiable*** (italic) — a free on-chain check exists, **but the route does not
  currently perform it**. It marks work that is possible, not work that is done. T12, K3
  and T17 are in this state.

The distinction matters because "verifiable" quietly reads as "verified", and 44 of 100
traders on this board report a profit larger than their entire lifetime volume.

---

## 6. Live routes — Supabase Edge Functions

**All 35 parameters are served by 15 routes. Zero external API calls per request.**

```bash
export B=https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api
```

No key required. Every route answers from Postgres — fomoapi, Helius, Bitquery and
Etherscan are used only by the scheduled loaders, so a thousand visitors cost what one does.

| Route | Params | In plain words |
| --- | --- | --- |
| `GET /v1/health` | — | "What's in the database, and when was it loaded?" |
| `GET /v1/traders` | the board | "Who are the top 100 traders?" |
| `GET /v1/traders/:handle/pnl` | T1, T15 | "**How much have they actually cashed out**, versus what's still on paper?" |
| `GET /v1/traders/:handle/scorecard` | T2, T3, T5–T10, T16–T20 | "How often do they win, how big, how long do they hold, how long have they been at it?" |
| `GET /v1/traders/:handle/portfolio` | T11, T13, T14 | "How many coins, **how much is in just one**, how much is sitting in dollars?" |
| `GET /v1/traders/:handle/positions` | T12 | "What exactly do they hold, and what is it worth?" |
| `GET /v1/traders/:handle/trust` | trust flags | "**Do their own numbers add up?**" |
| `GET /v1/traders/:handle/wallets` | — | "Which wallets do they trade from?" |
| `GET /v1/traders/:handle/transactions` | — | "What have those wallets actually done on-chain?" |
| `GET /v1/tokens` | K1, K3, K4, K9 | "**What are the leaders crowding into?**" |
| `GET /v1/tokens/:address` | K1, K3, K4 | "Who holds this one coin, and how much?" |
| `GET /v1/tokens/:address/activity` | K5–K8 | "**Has anyone who holds this ever actually sold it?**" |
| `GET /v1/tokens/momentum` | K2 | "What did they move into or out of since last time?" |
| `GET /v1/chains` | C1, C2, C4, C5 | "Which blockchains do they trade, and what can we even see there?" |

### Not migrated, deliberately

`/v1/traders/:handle/trades` and `/performance` stay on the Node service. They run the
chain-derived P&L replay in `pnl.ts`, which carries three confirmed bugs (`top_position_share`
unbounded, `worst_trade_usd` can report a gain as a loss, `realized_share` ignores sign).
They overlap heavily with `/scorecard`, which serves fourteen parameters from the same data
and is correct. The hyperliquid, pump.fun and gmgn boards are on hold.

---

## 7. Test calls

Local, with the key in the environment:

```bash
FOMOAPI_KEY=fapi_... PORT=8787 node dist/server.js
export B=localhost:8787          # or B=https://genie-fomo-api.onrender.com
```

### 6A. Newly built — file only, no key, instant

```bash
# C1 + C2 + C4 + C5 — where the leaderboard actually trades
curl -s "$B/v1/chains" | jq

# ...the finding in one line: only Solana has priced positions
curl -s "$B/v1/chains" | jq -r '.entries[] | "\(.chain)\t\(.traders) leaders\t\(.positions) pos\t$\(.totalValueUsd // "—")\tpriced \(.coverage.pricedShare)"'

# C4 alone — which chains we can pull history for, and with what
curl -s "$B/v1/chains" | jq '.entries[] | {chain, historyCoverage}'

# K2 — what leaders moved into / out of since the previous snapshot
curl -s "$B/v1/tokens/momentum?limit=10" | jq
curl -s "$B/v1/tokens/momentum?direction=in&limit=5" | jq    # gainers only
curl -s "$B/v1/tokens/momentum?direction=out&limit=5" | jq   # losers only

# K2's substrate — how many snapshots exist, and whether a diff is possible yet
```

With one snapshot, momentum returns `available: false` and says so. That is correct, not a
failure — see §4.

### 6B. Newly built — the scorecard (no extra API call beyond T1's)

```bash
# T2, T3, T5-T10, T15-T20 in one response
curl -s "$B/v1/traders/unipcs/scorecard" | jq

# the honest headline: win rate WITH the net attached
curl -s "$B/v1/traders/unipcs/scorecard" | jq -r '.plain, (.caveats[] | "  - " + .)'

# T6/T7/T8/T9 — win rate, best/worst, one-trade dependence, skew
curl -s "$B/v1/traders/unipcs/scorecard" \
  | jq '{winRate, wins, losses, bestTradeUsd, worstTradeUsd, topTradeShare, meanToMedian, medianTradeUsd}'

# T16/T18/T19/T20 — the timestamp block, populated on 100% of trades
curl -s "$B/v1/traders/unipcs/scorecard" \
  | jq '{holdingTime, lastTradeAgoHours, trackRecordDays, tradesPerDay}'

# T2/T3/T10 — read `coverage` BEFORE the number
curl -s "$B/v1/traders/unipcs/scorecard" | jq '{moneyIn, moneyOut, returnPct, typicalBetUsd}'

# T15 — the counts that do not reconcile
curl -s "$B/v1/traders/unipcs/scorecard" | jq '.sample'

# T5 + T17 — per-token P&L, biggest winner first
curl -s "$B/v1/traders/unipcs/scorecard?tokens=5" | jq '.byToken'
```

### 6C. Newly built — token activity (K5–K8, costs 1 call per sampled holder)

```bash
# CATE: 21 leaders hold $1.76M of it
export T=Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump

# K7 first — has anyone ever actually got out?
curl -s "$B/v1/tokens/$T/activity?chain=solana&holders=10" \
  | jq '{everSold, holdersWhoSold, holdersStillHolding, sampled, plain}'

# K5 + K6 + K8 — crowd entry, per-token win rate, direction of travel
curl -s "$B/v1/tokens/$T/activity?chain=solana&holders=10" \
  | jq '{crowdAvgEntryPrice, winRate, winners, losers, flow}'

# who did what, biggest realised first
curl -s "$B/v1/tokens/$T/activity?chain=solana&holders=10" | jq '.perHolder'

# cheaper sample (fewer fomoapi calls)
curl -s "$B/v1/tokens/$T/activity?chain=solana&holders=3" | jq '.sampled, .plain'
```

No cap and no `holders` parameter any more — the route reads `trades` from Postgres and
returns every trader with a record for the token in about a second. The old version made one
live fomoapi call per holder and took ~45s for a sample of 25.

### 6D. Previously built — regression set

```bash
curl -s "$B/v1/health" | jq
curl -s "$B/v1/traders?limit=2" | jq
curl -s "$B/v1/traders/unipcs/portfolio" | jq          # T11, T13, T14
curl -s "$B/v1/traders/unipcs/positions?limit=5" | jq  # T12
curl -s "$B/v1/traders/unipcs/trust" | jq              # trust flags
curl -s "$B/v1/traders/unipcs/pnl" | jq                # T1
curl -s "$B/v1/tokens?limit=5" | jq                    # K1, K3, K4, K9
curl -s "$B/v1/tokens/$T?chain=solana" | jq            # K1/K3/K4 for one token
curl -s "$B/v1/hyperliquid/traders?limit=2" | jq
curl -s "$B/v1/pumpfun/traders?limit=2" | jq
curl -s "$B/v1/gmgn/traders?limit=2" | jq
```

### 6E. Error paths worth checking

```bash
curl -s "$B/v1/traders/nosuchtrader/scorecard" | jq     # 404, names the handle
curl -s "$B/v1/tokens/0xdeadbeef/activity" | jq         # 404, no leader holds it
curl -s "$B/v1/tokens/momentum?direction=sideways" | jq # 400, lists valid values
curl -s "$B/v1/chains?bogus=1" | jq '.count'            # unknown params ignored
```

A token address that exists on more than one chain returns **400 with the chain list**
rather than silently picking one — pass `?chain=` to disambiguate.

### 6F. Known transient

fomoapi serves trades live and occasionally returns `{available:false, trades:[]}`,
typically on the first call after a cold start. The client now retries once after 1.5s,
which clears it in practice. If a scorecard still comes back with `available: false`, that
is fomo, not us — call it again.
