# GMGN-parity features → Route

**Generated: 2026-09-08T13:10Z** · 6 of 12 planned features live

Companion to [PARAMETER_ROUTES.md](PARAMETER_ROUTES.md), same shape: one row per feature —
what it means in plain words, the exact call that returns it, the field to read. This file
covers only the features built to close gaps against
[GMGN](https://github.com/GMGNAI/gmgn-skills/wiki), tracked in
[GMGN_PARITY_PLAN.md](GMGN_PARITY_PLAN.md).

Each entry also names **GMGN's equivalent field** and says where ours differs from theirs —
which matters most for **G3**, where our number and GMGN's same-sounding one have completely
different denominators.

**Every figure below is a dated example, not current state.** The pipeline refreshes nightly
and the Helius webhook ingests continuously, so these will have moved by the time you read
them. Treat them as "what this field looks like" and re-run the command for today's value.

```bash
export B=https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api
```

No API key. **Zero external calls per request.** Every feature here is answered from our own
Postgres (G6's prices are fetched nightly and stored, never at request time) — none of them proxies GMGN at request time, which is the whole point of the
[parity plan's](GMGN_PARITY_PLAN.md) T1 tier.

---

## Summary

| # | Feature | GMGN's equivalent | Route | Status |
| --- | --- | --- | --- | --- |
| **G1** | Position timing | `start_holding_at`, `end_holding_at`, `last_active_timestamp` | `/traders/:handle/positions` | ✅ live |
| **G2** | On-chain activity counters | `buys_{window}`, `sells_{window}`, `swaps_{window}` | `/traders/:handle` | ✅ live |
| **G3** | Leader concentration | `top_10_holder_rate` — **different denominator** | `/tokens/:address` | ✅ live |
| **G4** | Cursor pagination | `cursor` + `next` | `/traders`, `/tokens`, `/traders/:handle/transactions` | ✅ live |
| **G5** | Sorting + range filters | `--order-by`, `--direction`, `--min-*` / `--max-*` | `/traders`, `/tokens` | ✅ live |
| **G6** | USD value per transfer | `cost_usd`, `history_bought_cost`, `history_sold_income` | `/traders/:handle/transactions` | ✅ live |

---

## G1 · Position timing

| In plain words | Call | Read | Live value (`unipcs`) |
| --- | --- | --- | --- |
| "When did they get into this coin, and when did they get out?" | `GET $B/traders/unipcs/positions` | `entries[].startHoldingAt`, `.endHoldingAt`, `.lastActiveAt` | started **2026-07-25T20:11Z**, exited **2026-09-07T06:03Z** |

**In layman's terms.** For every coin a trader holds, this says when we first saw it arrive in
their wallet, when we last saw any of it leave, and when that wallet last did anything at all
with it. It answers *"are they a long-term holder or did they flip this in a day?"* — and it
comes from the blockchain itself, not from what anyone reported.

### How to test

```bash
# one trader's positions, newest activity first
curl -s "$B/traders/unipcs/positions?limit=5" | jq '.entries[] | {chain, startHoldingAt, endHoldingAt, lastActiveAt}'

# the honesty envelope — read this before trusting a date
curl -s "$B/traders/unipcs/positions" | jq '.chainHistory'
```

```json
{
  "chain": "solana",
  "startHoldingAt": "2026-07-25T20:11:12.000Z",
  "endHoldingAt":   "2026-09-07T06:03:18.000Z",
  "lastActiveAt":   "2026-09-07T14:23:22.000Z"
}
```

### What to know before you use it

**These are floors, not first events.** We began ingesting transactions part-way through
every trader's history. A position opened before then shows the first movement *we saw*, not
the first that happened. `chainHistory.observedFrom` is the earliest record we hold for that
trader — a `startHoldingAt` at or near it probably means "this is when we started looking".

**`null` means no on-chain record, not "nothing happened".** For `unipcs`, 63 of 107 positions
carry timing and 44 do not. The 44 are real holdings whose movements predate ingestion or
never appeared as transfers we captured. Reporting a date there would be an invention.

**`endHoldingAt` is frequently `null`, and that is a data limitation not a bug.** It needs an
outbound transfer, and our ingestion is skewed **86% inbound / 14% outbound** overall — for
`unipcs` specifically it is 32,660 in against 619 out, so only 16 of 107 positions have an
exit date. Treat a missing `endHoldingAt` as "no exit observed", never as "still holding".

**Versus GMGN.** They publish `start_holding_at` / `end_holding_at` per position and
`last_active_timestamp` per wallet, across all of chain history. Ours is scoped to what we
have ingested, and says so in the response. Theirs is more complete; ours is checkable.

---

## G2 · On-chain activity counters

| In plain words | Call | Read | Live value (`unipcs`) |
| --- | --- | --- | --- |
| "What has this wallet actually *done*, as opposed to what the leaderboard says?" | `GET $B/traders/unipcs` | `onChain.*` | **32,775 transactions**, 13,864 swaps, 719 tokens, 58 active days |

**In layman's terms.** Every other trading figure on this API comes from fomo — it is their
number and we pass it on. This block is ours: we watched the wallet on-chain and counted what
we saw. If the two disagree, that disagreement is information, and this is the first place you
can see both side by side.

### How to test

```bash
curl -s "$B/traders/unipcs" | jq '.onChain'

# put ours next to fomo's reported figures
curl -s "$B/traders/unipcs" | jq '{fomo: .reported, ours: .onChain}'
```

```json
{
  "transactions": 32775,  "transfers": 33279,
  "inbound": 32660,       "outbound": 619,
  "swaps": 13864,         "tokensTouched": 719,
  "activeDays": 58,
  "firstSeenAt": "2026-07-27T22:07:35.000Z",
  "lastActiveAt": "2026-09-08T10:20:25.000Z",
  "tier": "verified",
  "source": "postgres · transactions (helius webhook)"
}
```

### What to know before you use it

**`tier: "verified"` is the point of this block.** Everywhere else in the API, a trading
number carries `tier: "reported"` — meaning fomo said so. These are counted from transfers we
ingested ourselves, so they are the one set of trading figures we can stand behind directly.

**`activeDays` counts distinct days, not a span.** 58 active days means movement on 58
separate calendar days. A wallet that traded twice a year apart has 2 active days, not 365 —
the two readings support very different conclusions about whether someone is actually trading,
and this is deliberately the stricter one.

**`transfers` exceeds `transactions` because one transaction can move several tokens.** 33,279
transfers across 32,775 transactions. Neither is wrong; they count different things.

**These are floors too.** Same ingestion boundary as G1 — `firstSeenAt` is when we started
watching this wallet, not when it was created.

**Versus GMGN.** Their `buys_{window}` / `sells_{window}` / `swaps_{window}` are per token
over fixed windows. Ours is per wallet over all history we hold. Theirs slices finer; ours
exists to be compared against a reported figure, which theirs has no counterpart for.

---

## G3 · Leader concentration

| In plain words | Call | Read | Live value (USDC on Solana) |
| --- | --- | --- | --- |
| "Is this coin spread across the leaders we track, or is one whale holding most of it?" | `GET $B/tokens/:address` | `entries[].leaderConcentration` | top 1 holds **16.1%**, top 10 hold **82.1%** of 60 leaders' value |

**In layman's terms.** When 60 tracked traders hold the same coin, that sounds like broad
agreement. This checks whether it really is: if one of them holds most of the value, "72
leaders hold this" is a much weaker signal than it appears. It measures crowding among the
people we watch — not the coin's whole holder base.

### How to test

```bash
curl -s "$B/tokens/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" \
  | jq '.entries[0] | {holders, holderShare, totalValueUsd, leaderConcentration}'
```

```json
{
  "holders": 60,
  "holderShare": 0.4167,
  "totalValueUsd": 4225539.66,
  "leaderConcentration": {
    "top1": 0.1609, "top3": 0.4079, "top10": 0.8206,
    "leaders": 60,
    "coverage": { "of": 60, "total": 60, "share": 1 }
  }
}
```

### ⚠ This is NOT GMGN's `top_10_holder_rate`

**The most important thing on this page.** The two fields look alike, land in the same
numeric range, and mean completely different things:

| | Field | Denominator | Our #1 token reads |
| --- | --- | --- | --- |
| **GMGN** | `top_10_holder_rate` | supply held by the top 10 wallets, **out of every holder on chain** | `0.1974` |
| **Ours** | `leaderConcentration.top10` | value held by the top 10, **out of the leaders we track** | `0.4234` |

Both are plausible numbers. Neither substitutes for the other. A coin can be evenly spread
across our leaders and still be 90% owned by one wallet we do not track — GMGN would see that
and we would not. This is why our field is named `leaderConcentration` and carries a `basis`
string naming theirs, and why it must never be renamed to match.

### What else to know

**Value is summed per leader before ranking.** A trader holding the same token in two wallets
is one leader. Counting their rows separately would understate concentration.

**`top3` and `top10` are `null` when there are fewer holders than that.** "The top 10 of 4
holders" is the whole set, and reporting `1.0` would read as extreme concentration rather than
"too few holders to say". `top1` is always present when anything is priced.

**`null` for the whole block means nothing is priced.** Concentration is a share of USD value,
so a token where no holding carries a price gets `null` — never `0`.

**Read it with `holderShare`.** `holderShare: 0.4167` means 41.7% of tracked traders hold
this; `leaderConcentration.top10: 0.8206` means 10 of them hold 82.1% of the value. Wide
ownership, concentrated value — the two together say more than either alone.

---

## G4 · Cursor pagination

| In plain words | Call | Read | Live value |
| --- | --- | --- | --- |
| "Give me the next page, and don't lose or repeat rows if the list moved." | `GET $B/traders?limit=20&cursor=…` | `nextCursor` | 137 traders over 7 pages, **0 duplicates** |

**In layman's terms.** Asking for "rows 20–40" only works if nothing changed since you asked
for rows 0–20. Our lists do change — the board re-ranks nightly and new transactions arrive
every minute. When that happens, page 2 quietly repeats rows you already had or skips ones you
never saw, and nothing in the response tells you. A cursor says *"carry on from this exact
row"* instead of *"start 20 in"*, so it stays correct when the list moves underneath you.

### How to test

```bash
# first page
curl -s "$B/traders?limit=20" | jq '{count, nextCursor, first: .entries[0].handle}'

# feed nextCursor back in for the next page
curl -s "$B/traders?limit=20&cursor=CURSOR_FROM_ABOVE" | jq '{count, nextCursor}'

# walk to the end — nextCursor is null on the last page
curl -s "$B/tokens?limit=100" | jq '.nextCursor'
curl -s "$B/traders/unipcs/transactions?limit=200" | jq '.nextCursor'
```

```json
{ "count": 20, "nextCursor": "CURSOR", "first": "unipcs" }
```

### What to know before you use it

**`nextCursor: null` means that was the last page.** On `/traders/:handle/transactions` a full
page is only a hint that more exist — if the feed holds exactly `limit` rows remaining, the
next call returns empty. That is correct and costs nothing; proving otherwise would mean a
second count query on every request.

**Cursors are opaque. Do not build or edit one.** It is base64url, not encrypted and not
signed, but a modified cursor gets a **400** rather than a wrong page. A cursor from one route
will not work on another.

**A stale cursor is an error, not a silent restart.** If the row it names has since left the
list, you get `400` telling you to restart. Quietly starting from the top would hand back rows
you already have, and they would look like duplicates in your data.

**`?offset=` still works** and is unchanged. Nothing breaks if you ignore cursors — but a sync
that spans a nightly refresh should use them. During testing the refresh re-ranked the board
mid-run and `pointfarmcap` moved from 6th to 3rd; an offset-based walk across that moment
would have both skipped and duplicated rows with no way to notice.

**`rank` on `/tokens` is the position on the whole board**, not within your page — so page 2
starts at 101, not 1.

**Versus GMGN.** They expose `--cursor` with a `next` field on portfolio routes. Same idea;
ours additionally covers the token board and validates cursors strictly rather than degrading
to a fresh page.

---

## G5 · Sorting and range filters

| In plain words | Call | Read | Live value |
| --- | --- | --- | --- |
| "Show me only the traders who cleared $1M, best first." | `GET $B/traders?orderBy=pnl&minPnl=1000000` | `entries[]`, `filters` | **62 of 144** traders qualify |

**In layman's terms.** Until now you got the whole board in one fixed order and had to sift it
yourself. Now you can ask the database to do it: order by profit, volume, follower count or
trade count, and cut the list to a range before it is sent. Fewer bytes, and no client-side
filtering that quietly disagrees with ours.

### How to test

```bash
# traders: sort
curl -s "$B/traders?orderBy=pnl&limit=5"        | jq '.entries[] | {handle, pnl}'
curl -s "$B/traders?orderBy=volume&direction=asc&limit=5" | jq '.entries[].handle'

# traders: range filters
curl -s "$B/traders?minPnl=1000000&limit=500"   | jq '{count, filters}'
curl -s "$B/traders?minFollowers=10000&minTrades=500&limit=500" | jq '.count'

# tokens
curl -s "$B/tokens?orderBy=value&limit=5"       | jq '.entries[] | {holders, totalValueUsd}'
curl -s "$B/tokens?minValue=1000000&limit=500"  | jq '.count'
```

| Route | `orderBy` | Range filters |
| --- | --- | --- |
| `/traders` | `rank` · `pnl` · `volume` · `trades` · `followers` · `updated` | `minPnl` `maxPnl` `minVolume` `maxVolume` `minTrades` `minFollowers` |
| `/tokens` | `holders` · `value` · `priced` | `minValue` `maxValue` (plus the existing `minHolders`) |

`direction=asc|desc` applies to whichever column you picked.

### What to know before you use it

**`rank` ascends by default, everything else descends.** Rank 1 is the *best* trader, so
defaulting rank to descending would hand you the worst of the board first. Every other metric
is a quantity where the largest is the interesting end.

**⚠ A range filter silently excludes rows whose value is unknown.** 44 of 144 traders have no
stats row, so `minPnl` at *negative infinity* still returns only 100. The response says so
whenever a filter is active:

```json
"filters": {
  "applied": { "minPnl": 1000000 },
  "excludedForMissingValue": 44,
  "note": "44 trader(s) have no stats row, so no range filter can evaluate them and they
           are absent from this result — that is not the same as failing the filter"
}
```

A short result means *"few qualified **and** 44 could not be tested"*, never just the first.

**Unpriced tokens filter as zero.** `minValue`/`maxValue` treat an unpriced token as 0, which
is why `maxValue=100` returns 500 tokens. That is a filtering convenience only —
`totalValueUsd` stays `null` on those rows and never claims they are worth nothing.

**Sorting and cursors compose.** A non-default sort keeps its stable tiebreak, so `?cursor=`
still walks every row exactly once. Verified: `orderBy=value` over `/tokens` paged 1,095 rows
across 8 pages with zero duplicates and the same order as a single call.

**Unknown values are rejected, not ignored.** `?orderBy=bogus` returns **400** listing the
valid keys. An ignored filter would return *more* rows than you asked for and look like data
rather than an error.

**Versus GMGN.** Their `trending` board exposes ~19 range filters and 15 sort keys; `trenches`
~28. Ours is 8 filters and 9 sort keys across two boards — the subset we can answer from
columns we actually hold. Theirs covers metrics we have no source for at all
(`bundler_rate`, `insider_rate`, `top70_sniper_hold_rate`). **This is not parity and is not
claimed as such.**

---

## G6 · USD value per transfer

| In plain words | Call | Read | Live value |
| --- | --- | --- | --- |
| "How much money has this wallet actually put in and taken out?" | `GET $B/traders/unipcs/transactions` | `transfers[].costUsd`, `money.*` | `Quanterty`: **spent $953,947 · received $613,281 · net −$340,667** |

**In layman's terms.** Until now a transfer told you *"1.5 SOL moved"* and left you to work out
what that was worth. Now each one carries its dollar size, and the wallet carries running
totals for money in and money out. It answers *"how much have they actually staked here"* —
in dollars, from the blockchain.

### How to test

```bash
# per-transfer dollar size
curl -s "$B/traders/unipcs/transactions?kind=swap&limit=10" | jq '.transfers[] | {side, token, amount, costUsd}'

# whole-wallet totals
curl -s "$B/traders/unipcs/transactions?limit=1" | jq '.money'

# a wallet with real two-way flow
curl -s "$B/traders/Quanterty/transactions?limit=1" | jq '.money'
```

```json
{
  "spentUsd": 953947.42,
  "receivedUsd": 613280.51,
  "netUsd": -340666.91,
  "basis": "quote-asset legs only — the stablecoin or SOL side of each swap, valued at its daily close.",
  "coverage": { "of": 12083, "total": 13272, "share": 0.9105 }
}
```

### What to know before you use it

**This is how much money MOVED, not the price paid per token.** We stored the quote side of a
swap — the SOL or USDC — far more often than the memecoin side, which is exactly what makes
the dollar size answerable without a price feed for 3,112 tokens. Deriving a per-token entry
price needs *both* legs, and we hold those for only 3.4% of swaps. Different question,
different answer.

**`costUsd` is a magnitude, like `amount`.** Direction is in `side`, not in the sign — every
row's `amount` is positive in both directions, so signing the dollar figure would make the two
columns disagree.

**`null` means the leg is the memecoin side.** About 9,000 of 118,900 swap legs. It is never
`0` — a swap we could not value is not a swap worth nothing. `money.coverage` says how much of
the record the totals rest on; 91% for `Quanterty`.

**94.9% of the value needs no price feed at all.** USDC and USDT are dollar-pegged, so their
dollar value is their amount. Only SOL floats, priced from Binance daily closes — the same
source the Express path already used, so the two cannot disagree. **A peg is an assumption,
not a measurement**: stablecoins do break (USDC traded at $0.87 in March 2023), and a figure
derived through one is marked as such in `quote_assets.pegged_usd`.

**Prices are daily closes, not per-minute.** The dollar size of a trade to the nearest day
answers "how much did they put in". Per-minute would mean one API call per transaction rather
than one per asset.

**`money` is present on the first page and omitted while paging.** It is a whole-wallet total,
identical on every page, and it is the expensive part of the route — recomputing it across a
12-page walk would return the same number twelve times. Add `?money=true` to force it, or
read `moneyOmitted` for the reason.

**Native SOL legs now appear in this feed** (as of 2026-09-08). The webhook previously read
only Helius's `tokenTransfers` and ignored `nativeTransfers`, while the Express path read both
— so native lamport movements were never stored. That inconsistency is fixed and those legs
are priced like any other quote asset. In practice they are small: 68% are under 0.005 SOL,
because these traders swap through **wSOL** (an SPL token, already captured) and the native
movements are mostly account rent and signature fees. Expect more rows, not materially more
value.

**Versus GMGN.** They publish `cost_usd` per transaction plus `history_bought_cost` /
`history_sold_income` per wallet, across every token. Ours covers the quote-asset legs — 92.5%
of swap legs — and states its coverage. Theirs is broader; ours says what it does not know.

---

## What is not here yet

Six of the twelve planned parity features are unbuilt — and **every one of them requires a
migration or an external call**, since the pure-code tier is complete, including everything requiring an
external call — token security (`is_honeypot`, `buy_tax`), fundamentals (`price`, `liquidity`,
`market_cap`), true chain-wide holder counts, wallet tags and creator signals. See
[GMGN_PARITY_PLAN.md](GMGN_PARITY_PLAN.md) for the full list, what each costs, and the eight
GMGN capabilities we have deliberately declined.

**There is still no risk signal anywhere in this API.** We rank tokens by how many tracked
leaders hold them and say nothing about whether the contract lets you sell. That gap is
[GMGN_PARITY_PLAN.md](GMGN_PARITY_PLAN.md) §6 and is the one place where our silence is
actively dangerous.
