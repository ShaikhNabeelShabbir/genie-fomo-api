# Trader parameters — what we show, and why

## Build status

| | Meaning |
| --- | --- |
| ✅ | built and tested |
| 🎯 | next up |
| ⬜ | not started |
| 🔒 | blocked — needs something we do not have |

**Priority rule: build what has no external dependency first.** Anything computable from
`data/wallet.full.data.json` alone ships with no key, no rate limit and no staleness beyond
the file's own.

| Status | Parameter | Route | Depends on |
| --- | --- | --- | --- |
| ✅ | **T11** position count | `GET /v1/traders/:handle/portfolio` | file only |
| ✅ | **T13** concentration | same route | file only |
| ✅ | **T14** cash vs coins | same route (`cashShare`) | file only |
| ✅ | **K1** crowding / trending tokens | `GET /v1/tokens` | file only |
| ✅ | **K4** who else holds it | same route (`holderHandles`) | file only |
| ✅ | **T1** banked vs on paper | `GET /v1/traders/:handle/pnl` | fomoapi `/trades` — key OK, **endpoint degraded** |
| ⬜ | everything else | — | see per-parameter tables |

---

## 1. Trader parameters

### 1A. Money

| # | Parameter | Layman phrasing | Computed from | Tier |
| --- | --- | --- | --- | --- |
| ✅ T1 | **Banked vs on paper** | "Cashed out **$6,171** · **$2.1M still on paper**" | `realized / (realized + unrealized)` | Reported |
| T2 | Money in / money out | "Put in **$86,400** · took out **$102,100**" | `bought_cost`, `sold_income` | Reported |
| T3 | Return % | "Turned **$1,000 into $1,420**" | `realizedPnlUsd ÷ (amount × avgEntryPrice)` | Reported |
| T4 | Time-framed profit | "This week: **+12.6%**" | `pnl.{24h,7d,30d,all}` | Reported |
| T5 | Per-token P&L | "**+$2,100 on PONS**, −$340 on BONK" | `realizedPnlUsd` by `token.symbol` | Reported |
| T6 | **Win rate** | "Made money on **3 of every 4** coins" | `count(pnl>0) ÷ closed` | Reported |
| T7 | Best / worst trade | "Best **+$2,100** · worst **−$340**" | max/min `realizedPnlUsd` | Reported |
| T8 | **One-trade dependence** | "**98% of this profit is one token**" | `best_trade ÷ realized_total` | Reported |
| T9 | **Fluke or pattern** | "One lucky hit" vs "consistent" | `mean ÷ median` trade | Reported |
| T10 | Typical bet size | "Usually risks **$200 a trade**" | median `amount × avgEntryPrice` | Reported |


### 1B. Positions

| # | Parameter | Layman phrasing | Computed from | Tier |
| --- | --- | --- | --- | --- |
| ✅ T11 | Number of tokens | "Holds **95 different coins**" | `holdings.length` | Reported |
| T12 | Quantity & value | "**10,957,270 PONS**, worth **$2.2M**" | `humanAmount`, `value` | **Verifiable** via `balanceOf` |
| ✅ T13 | **Concentration** | "**97% of their money is in one coin**" | `max(value) ÷ sum(value)` | Reported |
| ✅ T14 | Cash vs coins | "**40% sitting in dollars**" | stablecoin share of value | Reported |
| T15 | Open vs closed | "**39 open, 688 closed**" | `activeCount`, `closedCount` | Reported |


### 1C. Time

| # | Parameter | Layman phrasing | Computed from | Tier |
| --- | --- | --- | --- | --- |
| T16 | **Holding time** | "Usually holds about **2 days**" | median `closedAt − createdAt` | Reported |
| T17 | Entry / exit | "Bought at **$0.013**, sold at **$0.036**" | `avgEntryPrice`/`avgExitPrice` | Verifiable via Bitquery |
| T18 | Still active | "Last trade **4 hours ago**" | most recent timestamp | Reported |
| T19 | **Track record length** | "Trading for **8 months**" | span of `createdAt` | Reported |
| T20 | Trading pace | "About **6 trades a day**" | `trades ÷ days` | Reported |

---

## 2. Token parameters

Subject is the **coin**, not the person. Mostly computed from the snapshot at **zero API
cost**, by inverting `holdings[]` into a `tokenAddress → traders` index.

| # | Parameter | Layman phrasing | Computed from | Tier |
| --- | --- | --- | --- | --- |
| ✅ K1 | **Crowding** | "**25 of the top 100** traders own this" | count holders of `tokenAddress` | Reported |
| K2 | Momentum | "**+8 new holders today**" | diff two snapshots | Reported |
| K3 | Money parked in it | "Leaders hold **$4.2M** of this" | sum `value` | Verifiable via `balanceOf` |
| ✅ K4 | Who else holds it | "Also held by unipcs, theveeman" | reverse index | Reported |
| K5 | Crowd's average entry | "Leaders bought around **$0.004**, now **$0.011**" | mean `avgEntryPrice` | Reported |
| K6 | **Per-token win rate** | "**7 of 9** holders made money on this" | `realizedPnlUsd` by token | Reported |
| K7 | **Has anyone ever sold it?** | "⚠️ **No proven exit** — every holder still holding" | any `status: closed` | Reported |
| K8 | Accumulating or distributing | "Leaders are **buying**" | buy/sell balance | Reported |
| K9 | Which chain | "Lives on **BSC**" | `networkId` | ✅ **Verified** via `eth_getCode` |
| K10 | **Is the price real?** | "⚠️ **Price not independently verified**" | mark vs pool price | Verifiable via Bitquery |


## 3. Chain parameters

Subject is the **blockchain**. This section exists because **what we can see differs by
chain**, which constrains every parameter above.

### Activity distribution (measured, current file)

| Chain | `networkId` | Positions |
| --- | --- | --- |
| Solana | 1399811149 | **1,605** |
| Robinhood | 4663 | 226 |
| BSC | 56 | 95 |
| Base | 8453 | 68 |
| Ethereum | 1 | 18 |

Plain-language: *"these traders are overwhelmingly Solana memecoin traders."*

### Chain-level parameters

| # | Parameter | Layman phrasing | Tier |
| --- | --- | --- | --- |
| C1 | Leaders active here | "**63 of 100** leaders trade Solana" | Reported |
| C2 | Value on this chain | "**$8.4M** of leader money sits on Solana" | Verifiable |
| C3 | Chain profitability | "Leaders made most of their money on **Robinhood**" | Reported |
| C4 | **Coverage warning** | "⚠️ **BSC history unavailable** — Bitquery quota spent" | ✅ Verified (our own state) |
| C5 | `balanceOf` verifiability | "Position **✓ verified on-chain**" | ✅ Verified — free on all 5 chains |

**C5 is worth stating plainly: `balanceOf` works on every chain, free and keyless** — even
BSC and Base, which have no free *history*. So position sizes are always verifiable even
when transaction history is not.

---

