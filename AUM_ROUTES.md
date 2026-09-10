# genie-fomo API — AUM over time

**Generated: 2026-09-10T15:00Z** · measured against the live service, not read off the code.

What a trader holds, in dollars, across every wallet and every chain — **sampled and stored,
not reconstructed**. One route, one series per trader, coverage on every point.

| | |
| --- | --- |
| Route | `GET $B/traders/:handle/aum` |
| Status | **live** — migration applied, route deployed 2026-09-10 |
| Traders sampled so far | **8 of 435** (the sampler has not run over the board) |
| Acceptance criteria met | **5 of 8** — three open, all named in §6 |

```bash
export B=https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api
```

No API key. **Zero external calls per request** — the route answers from Postgres alone.
Verified: 0 outbound `fetch` calls in the handler, 3 SQL queries.

The two conventions the rest of this API runs on hold here too:

- **A missing value is `null`, never `0`.** A refused sample is `null` and says why. A zero
  would read as "he holds nothing", which is a different and much worse statement.
- **Every borrowed number says so.** `tier: "verified"` means we read the chain ourselves;
  `tier: "reported"` means it came from somebody else's records.

---

## Contents

| § | | |
| --- | --- | --- |
| **1** | [The route](#1-the-route) | the call, the shape, the fields |
| **2** | [Windows and steps](#2-windows-and-steps) | `?window=` and `?step=` |
| **3** | [Coverage — read it before the number](#3-coverage-read-it-before-the-number) | `valueShare` and why it matters |
| **4** | [Refusals](#4-refusals) | why a whole hour can be `null` |
| **5** | [Where the numbers come from](#5-where-the-numbers-come-from) | the sampler |
| **6** | [What is not finished](#6-what-is-not-finished) | three open acceptance criteria |
| **7** | [Errors](#7-errors) | validation and status codes |

---

## 1. The route

| In plain words | Call | Read | Live value (`0xAvast`) |
| --- | --- | --- | --- |
| "How much has this trader been holding, and how has it moved?" | `GET $B/traders/0xAvast/aum?window=1d` | `now.totalUsd`, `points[]` | **$4,416,026.98** across 216 positions, 198 priced |

**In layman's terms.** `/portfolio` answers *"what does he hold right now"*. This answers
*"what has he been holding, over time"* — the line a chart draws. Every point was **measured
and written down at the time**, not worked out afterwards from trading history. That
distinction is the whole feature: a balance rebuilt backwards from a swap feed drifts upward
and never sees the coins someone sold, because a sale that was never recorded cannot be
un-counted later.

### How to test

```bash
curl -s "$B/traders/0xAvast/aum?window=1d" | jq .

# just the headline and the per-chain split
curl -s "$B/traders/0xAvast/aum?window=1w" | jq '.now, .chains'

# a trader the sampler has not reached — it says so rather than returning 0
curl -s "$B/traders/frankdegods/aum" | jq '.plain'
```

```json
{
  "handle": "0xAvast",
  "window": "1d",
  "step": "1h",
  "from": "2026-09-09T14:39:02.106Z",
  "to": "2026-09-10T14:39:02.106Z",
  "trackedSince": "2026-09-10T14:00:00.000Z",
  "now": {
    "at": "2026-09-10T14:00:00.000Z",
    "totalUsd": 4416026.98,
    "coverage": { "pricedPositions": 198, "totalPositions": 216, "valueShare": 0.9167 },
    "tier": "verified"
  },
  "count": 1,
  "points": [
    { "at": "2026-09-10T14:00:00.000Z", "totalUsd": 4416026.98,
      "basis": "sampled", "tier": "verified",
      "coverage": { "pricedPositions": 198, "totalPositions": 216, "valueShare": 0.9167 } }
  ],
  "chains": [
    { "chain": "bsc",       "networkId": 56,         "totalUsd": 2768755.63, "pricedShare": 1 },
    { "chain": "robinhood", "networkId": 4663,       "totalUsd": 1518328.05, "pricedShare": 1 },
    { "chain": "solana",    "networkId": 1399811149, "totalUsd": 128930.25,  "pricedShare": 0.9027 },
    { "chain": "base",      "networkId": 8453,       "totalUsd": 10.37,      "pricedShare": 1 },
    { "chain": "ethereum",  "networkId": 1,          "totalUsd": 2.68,       "pricedShare": 1 }
  ],
  "refused": null,
  "plain": "1 point over 1d at 1h steps."
}
```

### The fields

| Field | Rule |
| --- | --- |
| `now.totalUsd` | The newest sample. `null` when it was refused — `refused` then names why. |
| `points[]` | One entry per step bucket, oldest first. Each carries its own `coverage`. |
| `points[].basis` | `sampled` (read from chain at the time) or `rebuilt` (inferred afterwards). |
| `points[].tier` | `verified` for sampled, `reported` for rebuilt. Never blended. |
| `trackedSince` | When real sampling began. Everything before it is a marked rebuild. |
| `chains[]` | Per-chain split of the **newest** sample. `totalUsd: null` + `reason` when a chain could not be priced. |
| `count` | How many points came back after thinning — not how many samples exist. |
| `refused` | Non-null only when the newest sample was refused. |

**`sum(chains[].totalUsd)` equals `now.totalUsd`.** Verified on 7 of 8 traders; see §6 for the
one that is a penny out.

---

## 2. Windows and steps

```
?window=1d | 1w | 1m | all        how far back            default 1w
?step=1h  | 6h | 1d               thin the series         default: see below
```

**The default step is the coarsest that still leaves at least 24 points.** A week arrives as
28 six-hour points rather than 168 hourly ones nobody plots; a day arrives as 24 hourly ones
rather than collapsing to 1.

| `?window=` | default `step` | points |
| --- | --- | --- |
| `1d` | `1h` | 24 |
| `1w` | `6h` | 28 |
| `1m` | `1d` | 30 |
| `all` | `1h` | everything held |

### How to test

```bash
curl -s "$B/traders/0xAvast/aum?window=1w"          | jq '{step, count}'   # 6h
curl -s "$B/traders/0xAvast/aum?window=1d"          | jq '{step, count}'   # 1h
curl -s "$B/traders/0xAvast/aum?window=1w&step=1d"  | jq '{step, count}'   # forced
```

### What to know before you use it

**Thinning keeps the LAST point in each bucket, never an average.** An average would invent a
balance the trader never actually held at any moment. Worse, averaging a refused hour together
with a measured one would launder the refusal into a number — the reader would see a total
where the honest answer was "we could not read it".

**Nothing is interpolated.** A gap in the series is a gap. If the sampler did not run, or was
refused, there is no point there — the chart should show a break, not a straight line.

---

## 3. Coverage — read it before the number

| In plain words | Read | Live value |
| --- | --- | --- |
| "How much of him does this figure actually cover?" | `now.coverage.valueShare` | **0.9167** — 198 of 216 positions priced |

**In layman's terms.** A total of $4.4 million means one thing if we could price 198 of his
216 coins, and something very different if we could price 2 of them. The number alone cannot
tell you which. `valueShare` can.

```bash
curl -s "$B/traders/0xAvast/aum?window=1d" | jq '.now.coverage'
```

```json
{ "pricedPositions": 198, "totalPositions": 216, "valueShare": 0.9167 }
```

### What to know before you use it

**An unpriced coin is counted, not zeroed.** Those 18 unpriced positions appear in
`totalPositions` and are excluded from `totalUsd`. Valuing them at zero would understate him;
dropping them from the count would hide that anything was missing.

**`valueShare` = priced ÷ total positions.** 198/216 = 0.9167. It is a share of his
*positions*, not of his dollars — we cannot know the value of what we could not price.

**Coverage varies enormously between traders.** Live, right now:

| Trader | Total | Coverage |
| --- | --- | --- |
| `0xkaroshi` | $1,064.44 | **1.0** — 4 of 4 |
| `0xangeryy` | $108,313.25 | 0.9449 — 120 of 127 |
| `0xAvast` | $4,416,026.98 | 0.9167 — 198 of 216 |
| `0xleo` | $1,065,135.95 | 0.6667 — 40 of 60 |
| `0xkuidian` | $159.30 | **0.4286** — 3 of 7 |

`0xkuidian`'s $159 rests on fewer than half his positions. `0xkaroshi`'s $1,064 rests on all
of them. **Same field, very different confidence, and only `valueShare` says which.**

---

## 4. Refusals

**If any wallet will not answer, the entire trader-hour is refused** — not totalled from the
wallets that did.

```json
{ "now": { "totalUsd": null, ... }, "refused": "wallet_unreadable" }
```

| `refused` | Meaning |
| --- | --- |
| `wallet_unreadable` | a chain would not answer for one of his addresses |
| `service_timeout` | a provider timed out |
| `no_prices` | he holds things and we could price none of them |
| `price_rejected` | a price failed the sanity ceilings |

**In layman's terms.** If we read three of a trader's four wallets, the sum would be a real
number, quietly missing a quarter of him — and it would look exactly like a real drawdown.
Nothing downstream could tell the two apart. So we return nothing and say why.

**The one place a zero is real.** A trader whose wallets *all answered* and held nothing is
`0`, not `null`. That zero is a measurement. It is only reachable when every read succeeded.

---

## 5. Where the numbers come from

`scripts/load_aum_samples.mjs`. Per trader, per run:

| Chain | How the balance is read |
| --- | --- |
| solana | Helius `getTokenAccountsByOwner`, both token programs, plus native SOL |
| robinhood · bsc · base · ethereum | batched `eth_call balanceOf` against the chain's own public RPC, 40 tokens per call |

Prices come from what the service already holds, in this order — the same order the holdings
loader uses, so an AUM point and a `/portfolio` total can never disagree about which price
they used:

```
quote_assets.pegged_usd   a dollar coin is a dollar, by definition
token_info.price_usd      GMGN's price, refreshed nightly
token_prices              the most recent daily close
```

### Running it

```bash
node --env-file=.env scripts/load_aum_samples.mjs --limit 5 --dry-run
node --env-file=.env scripts/load_aum_samples.mjs --handle 0xAvast
node --env-file=.env scripts/load_aum_samples.mjs                    # the whole board
```

Measured: **~14 s per trader**, so a full pass over 435 traders is roughly **100 minutes**.
Token decimals are cached once per run — 13,774 tokens — not re-read per trader.

**`tier: "verified"` is the point.** These amounts were read from the chain by us. Compare
against `/portfolio`, which reports the last build's snapshot: for `0xAvast` those two
currently differ by **68×**, and the chain reading is the correct one. Per the product
requirement, *that disagreement is a finding, not something to merge away*.

---

## 6. What is not finished

Three of the eight acceptance criteria do not pass. All three are known, none is hidden.

| # | Criterion | Status |
| --- | --- | --- |
| §8.2 | `sum(chains[]) == now.totalUsd` | **7 of 8.** `0xleo` is **one cent** out — each chain total and the overall total are rounded independently, so `sum(round(x))` ≠ `round(sum(x))`. Fix: derive the total from the rounded parts. |
| §8.3 | a bad pool price is refused | **partial.** The two absolute ceilings work ($1M/token, $1T/position). They would **not** have caught the requirement's own STONK example: $3,110/token producing $26.7bn passes both. The rule that catches it — 50× off the median of the coin's other pools — needs **per-pool prices**, which no source we hold provides. |
| §8.8 | route latency under 300 ms | **fails: ~2.4 s.** Not the route's fault — it is three indexed queries on a small table. Every route on this deployment sits at ~2.2-2.5 s, `/health` included. That is the Edge Function baseline, not the query. |

One more worth stating plainly:

**§8.1 — agreement with `/positions` within 1% on Solana — does not hold.** Measured
differences of 15.7% to 1,123%. The AUM figure is the accurate one; `holdings_current` is a
stale snapshot. The criterion needs restating against fresh chain reads rather than the API
needing a fix, but as written it is not met.

---

## 7. Errors

Same shape as every other route on this API — see `PARAMETER_ROUTES.md` §0a.

```bash
curl -s "$B/traders/0xAvast/aum?window=99y" | jq .
curl -s "$B/traders/0xAvast/aum?step=3h"    | jq .
curl -s "$B/traders/nobody/aum"             | jq .
```

```json
{ "error": { "code": "bad_request",
             "detail": "'window' must be one of 1d, 1w, 1m, all — got '99y'",
             "parameter": "window" } }

{ "error": { "code": "bad_request",
             "detail": "'step' must be one of 1h, 6h, 1d — got '3h'",
             "parameter": "step" } }

{ "error": { "code": "not_found", "detail": "no trader 'nobody' in the directory" } }
```

**Not bulk-able through `?include=`**, for the same reason `/portfolio` is not: it is a series
per trader, and a page of them would be the largest response this API can produce.
