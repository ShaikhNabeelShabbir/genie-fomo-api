# GMGN-parity features → Route

**Generated: 2026-09-09T09:15Z** · **12 of 12 planned features live**

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
| **G7** | Token fundamentals | `price`, `liquidity`, `market_cap`, `holder_count`, `top_10_holder_rate` | `/tokens`, `/tokens/:address` | ✅ live |
| **G8** | Chain-wide concentration | `top_10_holder_rate`, `dev_team_hold_rate`, `holder_count` | `/tokens/:address` | ✅ live |
| **G9** | Wallet tags | `wallet_tags_stat` — `smart_wallets`, `renowned_wallets`, … | `/tokens`, `/tokens/:address` | ✅ live |
| **G10** | Creator / dev signals | `creator_token_status`, `cto_flag`, `creator_ath_info` | `/tokens/:address` | ✅ live |
| **G11** | Chain-verified P&L | *none — GMGN has no second source to check against* | `/traders/:handle/pnl` | ✅ live |
| **G12** | Token security | `is_honeypot`, `buy_tax`, `sell_tax`, `owner_renounced`, `rug_ratio` | `/tokens`, `/tokens/:address` | ✅ live |

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
`unipcs` specifically it is 33,244 in against 619 out, so only 16 of 107 positions have an
exit date. Treat a missing `endHoldingAt` as "no exit observed", never as "still holding".

**Versus GMGN.** They publish `start_holding_at` / `end_holding_at` per position and
`last_active_timestamp` per wallet, across all of chain history. Ours is scoped to what we
have ingested, and says so in the response. Theirs is more complete; ours is checkable.

---

## G2 · On-chain activity counters

| In plain words | Call | Read | Live value (`unipcs`) |
| --- | --- | --- | --- |
| "What has this wallet actually *done*, as opposed to what the leaderboard says?" | `GET $B/traders/unipcs` | `onChain.*` | **33,359 transactions**, 14,138 swaps, 726 tokens, 58 active days |

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
  "transactions": 33359,  "transfers": 33863,
  "inbound": 33244,       "outbound": 619,
  "swaps": 14138,         "tokensTouched": 726,
  "activeDays": 58,
  "firstSeenAt": "2026-07-03T02:51:23.000Z",
  "lastActiveAt": "2026-09-08T13:50:02.000Z",
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

**`transfers` exceeds `transactions` because one transaction can move several tokens.** 33,863
transfers across 33,359 transactions. Neither is wrong; they count different things.

**These are floors too.** Same ingestion boundary as G1 — `firstSeenAt` is when we started
watching this wallet, not when it was created.

**These numbers move faster than any other figure in this file.** The Helius webhook ingests
continuously, so the counts climb by the minute — they rose by ~600 transactions during the
hour this page was last regenerated. Match the shape, not the digits.

**Versus GMGN.** Their `buys_{window}` / `sells_{window}` / `swaps_{window}` are per token
over fixed windows. Ours is per wallet over all history we hold. Theirs slices finer; ours
exists to be compared against a reported figure, which theirs has no counterpart for.

---

## G3 · Leader concentration

| In plain words | Call | Read | Live value |
| --- | --- | --- | --- |
| "Is this coin spread across the leaders we track, or is one of them holding most of it?" | `GET $B/tokens/:address` | `entries[].leaderConcentration` | top 1 holds **9.2%**, top 10 hold **59.2%** of what 44 leaders hold |

**In layman's terms.** When 44 tracked traders hold the same coin, that sounds like broad
agreement. This checks whether it really is: if one of them holds most of it, "44 leaders hold
this" is a far weaker signal than it looks. It measures crowding among the people we watch —
not the coin's whole holder base, which is **G8**.

### How to test

```bash
curl -s "$B/tokens/0xfd0bb211d479710dfa01d3d98751767f51edb2d9" \
  | jq '.entries[0] | {holders, holderShare, leaderConcentration}'

# the pair that matters — ours beside GMGN's
curl -s "$B/tokens/0xfd0bb211d479710dfa01d3d98751767f51edb2d9" \
  | jq '.entries[0] | {ours: .leaderConcentration.top10, gmgn: .chainConcentration.top10HolderRate}'
```

```json
{
  "holders": 44,
  "holderShare": 0.3056,
  "leaderConcentration": {
    "top1": 0.092, "top3": 0.2644, "top10": 0.592,
    "leaders": 44,
    "coverage": { "of": 44, "total": 44, "share": 1 }
  }
}
```

### ⚠ This is NOT GMGN's `top_10_holder_rate`

**The most important thing on this page.** The two look alike, land in the same numeric range,
and answer completely different questions. On this very token:

| | Field | Denominator | Reads |
| --- | --- | --- | --- |
| **Ours** | `leaderConcentration.top10` | the **44 leaders we track** | **0.592** |
| **GMGN** | `chainConcentration.top10HolderRate` (**G8**) | all **2,644 holders on chain** | **0.1974** |

A coin can be evenly spread across our leaders and still be 90% owned by one wallet we do not
track — GMGN would see that and we would not. Both are now returned on the same response so
they can be read together; they must never share a name.

### What else to know

**It is computed from AMOUNTS, and that is exact rather than approximate.** Every holder of a
token holds it at the same price, so in `sum(top N x price) / sum(all x price)` the price
cancels out entirely — the ratio is identical either way. This used to be computed from `value`
and therefore returned `null` for 63% of the board for no arithmetic reason. It now answers for
**every** token, with nothing borrowed in it.

**Amounts are summed per leader before ranking.** A trader holding the same token in two
wallets is one leader; counting their rows separately would understate concentration.

**`top3` and `top10` are `null` when there are fewer holders than that.** "The top 10 of 4
holders" is the whole set, and reporting `1.0` would read as extreme concentration rather than
"too few holders to say".

**Read it with `holderShare`.** `holderShare: 0.3056` means 30.6% of tracked traders hold
this; `leaderConcentration.top10: 0.592` means 10 of them hold 59.2% of the position. Wide
ownership, concentrated holding — the two together say more than either alone.

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

## G7 · Token fundamentals

| In plain words | Call | Read | Live value |
| --- | --- | --- | --- |
| "What is this coin actually worth, and how many people hold it?" | `GET $B/tokens/:address` | `entries[].fundamentals` | price **$0.7611131**, mcap **$6,088,904,800**, **258,728** holders |

**In layman's terms.** Until now we could tell you *which* leaders hold a coin but often not
what it was worth — 63% of the board came back with no value at all, because we only knew a
price when fomo happened to give us one. This adds the coin's own numbers: price, liquidity,
market cap, total supply, and how many people hold it across the whole chain. **Every token on
the board can now be valued**, up from 37%.

### How to test

```bash
# the full block on one token
curl -s "$B/tokens/0x000ae314e2a2172a039b26378814c252734f556a" | jq '.entries[0].fundamentals'

# on the board, flat
curl -s "$B/tokens?limit=5&orderBy=marketCap" | jq '.entries[] | {rank, holders, priceUsd, marketCapUsd, chainHolderCount}'

# new sorts and filters
curl -s "$B/tokens?orderBy=liquidity&limit=5"      | jq '.entries[].liquidityUsd'
curl -s "$B/tokens?orderBy=chainHolders&limit=5"   | jq '.entries[].chainHolderCount'
curl -s "$B/tokens?minMarketCap=1000000&limit=500" | jq '{count, filters, filtersNote}'
```

```json
{
  "priceUsd": 0.7611131,
  "liquidityUsd": 1409568.71,
  "marketCapUsd": 6088904800,
  "totalSupply": 8000000000,
  "circulatingSupply": 8000000000,
  "holderCount": 258728,
  "top10HolderRate": 0.9142,
  "tier": "third_party",
  "source": "gmgn",
  "fetchedAt": "2026-09-08T12:48:56.000Z"
}
```

### What to know before you use it

**These are GMGN's numbers, not ours, and they say so.** `tier: "third_party"` and `source`
are on every block. Everything else in this API is either computed by us or clearly marked as
fomo's; this is a third category and it is labelled rather than blended in.

**`totalValueUsd` is untouched.** It still reports only what we stored, so it is still `null`
for most tokens. The GMGN-derived figure is a separate field, `estimatedValueUsd`, carrying
its own `estimatedValueBasis` — because a borrowed answer must not be able to pass as our own.

**⚠ `fundamentals.top10HolderRate` is NOT `leaderConcentration`.** They measure different
populations and the gap is large:

```
ours  leaderConcentration.top10    0.592     over    44 tracked leaders
GMGN  fundamentals.top10HolderRate 0.1974    over 2,644 chain holders
```

Ours asks "is this crowded among the traders we follow"; theirs asks "is the supply
concentrated on chain". Both are useful; neither substitutes for the other.

**Market cap is computed, not reported.** GMGN returned `market_cap` on **0 of 1,095** tokens,
so it is always `price x circulating_supply`. Values above $10 trillion are published as
`null`: one token mints 10^76 units, which makes the arithmetic correct and the answer
meaningless. The price and supply behind it are always returned so you can judge for yourself.

**Refreshed nightly, not per request.** A token first held today shows `fundamentals: null`
until the next run. `fetchedAt` tells you how old the figures are — there is **no external
call at request time**.

**Versus GMGN.** Same endpoint, same numbers. The difference is that ours arrive beside our
own figures with the provenance attached, so you can see where each came from.

---

## G8 · Chain-wide concentration

| In plain words | Call | Read | Live value |
| --- | --- | --- | --- |
| "Is this coin's supply held by a few big wallets?" | `GET $B/tokens/:address` | `entries[].chainConcentration` | top 10 hold **0.9142** of supply across **258,728** holders |

**In layman's terms.** A coin can look widely held and still be controlled by a handful of
wallets. This is the share of the total supply sitting in the biggest ten, plus how much the
dev team and the creator kept, and what proportion of holders are brand-new wallets — the
things that decide whether a price can be moved by one person.

### How to test

```bash
curl -s "$B/tokens/0x000ae314e2a2172a039b26378814c252734f556a" | jq '.entries[0].chainConcentration'

# read it against OUR figure — different denominators
curl -s "$B/tokens/0x000ae314e2a2172a039b26378814c252734f556a" \
  | jq '.entries[0] | {ours: .leaderConcentration.top10, gmgn: .chainConcentration.top10HolderRate}'
```

```json
{
  "holderCount": 258728,
  "top10HolderRate": 0.9142,
  "devTeamHoldRate": 0,
  "creatorHoldRate": 0,
  "freshWalletRate": 0.0001,
  "sniperHoldRate": 0,
  "botDegenRate": 0.0005,
  "tier": "third_party",
  "source": "gmgn"
}
```

### What to know

**These are GMGN's numbers, not ours.** Every field carries `tier: "third_party"` and
`source`. We observe 44–2,644 wallets depending on the token; a figure about *every*
holder on chain is not something our data can produce, so it is borrowed and labelled rather
than derived and claimed.

**⚠ This is not `leaderConcentration` (G3).** Ours is the share among the leaders we track;
this is the share across every holder on chain. On a token where both are present:

```
ours  leaderConcentration.top10          0.592    over      44 tracked leaders
GMGN  chainConcentration.top10HolderRate 0.1974   over   2,644 chain holders
```

Different questions, different denominators — that is why they have different names and why
neither may be renamed to the other.

**All rates are 0–1**, not percentages. `0.1974` means 19.74%.

**`null` for the whole block means the token has not been fetched yet.** Quote assets
(USDC, USDT, SOL) are deliberately never fetched, so they carry no `chainConcentration` — the
question is meaningless for a stablecoin.

**Versus GMGN.** Same numbers, same endpoint. The difference is that ours arrive next to our
own tracked-leader figure with the provenance attached, so the two can be read together
instead of one standing in for the other.

---

## G9 · Wallet tags

| In plain words | Call | Read | Live value |
| --- | --- | --- | --- |
| "Who is holding this — smart money, snipers, or fresh wallets?" | `GET $B/tokens/:address` | `entries[].walletTags` | smart **965**, renowned **406**, sniper **26** |

**In layman's terms.** GMGN classifies wallets by how they behave: proven profitable traders
("smart"), known influencers ("renowned"), launch snipers, bot bundlers, whales, brand-new
wallets. This tells you which kinds are holding a coin. A coin held mostly by fresh wallets and
bundlers reads very differently from one held by smart money.

### How to test

```bash
curl -s "$B/tokens/0x000ae314e2a2172a039b26378814c252734f556a" | jq '.entries[0].walletTags'

# on the board, and sortable
curl -s "$B/tokens?orderBy=smartWallets&limit=5"    | jq '.entries[] | {rank, holders, smartWallets, renownedWallets}'
curl -s "$B/tokens?orderBy=renownedWallets&limit=5" | jq '.entries[].renownedWallets'
```

### ⚠ The counts are capped at 1000

**A tag reading exactly `1000` means "at least 1000", not "exactly 1000".** Across all 1,095
tokens the distribution runs 0, 1, 2, 3 … then piles up at exactly 1000 — 450 tokens on
`fresh`, 271 on `bundler`, 29 on `whale` — with **not one token above it on any tag**. That is
a truncation, not a count. The response says which tags hit the ceiling:

```json
"cappedTags": ["bundler", "whale", "fresh"],
"capped": true,
"note": "GMGN caps these counts at 1000. …"
```

Treat a capped tag as a floor. Never sum capped tags into a total.

---

## G10 · Creator / dev signals

| In plain words | Call | Read | Live value |
| --- | --- | --- | --- |
| "Who launched this, are they still holding, and what did they launch before?" | `GET $B/tokens/:address` | `entries[].creator` | status **creator_hold**, previous best **T0WER** |

**In layman's terms.** The person who created a coin usually holds some of it. Whether they
still do — or quietly sold — is one of the strongest signals there is. This also says whether
the community took the project over after the dev left, and what the creator's best previous
coin ever reached.

### How to test

```bash
curl -s "$B/tokens/0x0f8b43fcdf0d9d01f3dcd6230fe7a6fca889958a" | jq '.entries[0].creator'
```

```json
{
  "address": "0x1c9ebbc3231645d283e88e50988d0202c15ecadc",
  "status": "creator_hold",
  "stillHolding": true,
  "communityTakeover": true,
  "tokensLaunched": 0,
  "bestPreviousToken": {
    "symbol": "T0WER",
    "address": "0x0f8b43fcdf0d9d01f3dcd6230fe7a6fca889958a",
    "peakMarketCapUsd": 1035942.5
  },
  "tier": "third_party",
  "source": "gmgn"
}
```

### What to know

**`stillHolding` is `true` / `false` / `null`** — and the `null` matters. `creator_token_status`
is blank on 185 of 1,095 tokens, and "we were not told" is a different claim from "the creator
sold". Only one of them is evidence.

**`address` can be `null` while the rest is present.** It is blank on 104 of 1,095 tokens
(9.5%). An unknown address is one missing field, not a reason to withhold a known status.

**`bestPreviousToken` is `null` when the creator has no prior launch.** GMGN returns the object
present but empty in that case — blank symbol, `ath_mc` of 0 — which if passed through would
read as "their best token peaked at $0" rather than "there isn't one".

**`communityTakeover`** is GMGN's `cto_flag`: the original dev walked away and holders took the
project over. Different from a dev who never left, and worth reading next to `stillHolding`.

---

## G11 · Chain-verified P&L

| In plain words | Call | Read | Live value |
| --- | --- | --- | --- |
| "Forget what the leaderboard claims — what did the blockchain actually pay them?" | `GET $B/traders/:handle/pnl` | `chainDerived` | **1** closed position(s), realised **$6** |

**In layman's terms.** Every other profit figure on this API is fomo's — we pass it on and, in
the trust route, test it against itself. This one is **ours**: we read both sides of each swap
straight off Solana, so a buy and its matching sell reconcile on quantity. It is the only
number here that does not depend on anyone's reporting.

### How to test

```bash
curl -s "$B/traders/pointfarmcap/pnl" | jq '{fomo: {banked: .bankedUsd, onPaper: .onPaperUsd}, chain: .chainDerived}'
```

```json
{
  "realizedUsd": 6,
  "closedPositions": 1,
  "winners": 1,
  "netCashUsd": -70720.05,
  "swapsResolved": 410,
  "tokensTraded": 51,
  "firstSwapAt": "2026-09-06T05:08:55.000Z",
  "lastSwapAt": "2026-09-08T10:45:59.000Z",
  "tier": "verified",
  "source": "postgres \u00b7 wallet_swaps (helius rpc pre/post balances)",
  "basis": "both sides of each swap resolved from the wallet's net balance change, so a buy and its matching sell reconcile on quantity. Solana only.",
  "coverage": {
    "of": 410,
    "total": 9821,
    "share": 0.0417
  },
  "note": "coverage is low BY CONSTRUCTION: most rows tagged SWAP are inbound transfers inside someone else's transaction, not trades the wallet made. Only two-sided swaps are counted, and this figure is independent of the fomo numbers above."
}
```

### What to know before you use it

**⚠ Coverage is ~3%, and that is the finding — not a shortfall.** `tx_type` in our transaction
feed is the TRANSACTION's type, not the wallet's action in it. In **57 of 60** sampled rows
tagged `SWAP`, the wallet was not even among the transaction's accounts — somebody else swapped
and sent tokens to the wallet's token account. Only the two-sided remainder is a trade the
wallet made, and only those are counted. A low `coverage.share` means *"few of these rows were
trades"*, never *"the rest lost money"*.

**`realizedUsd` and `netCashUsd` are different questions.** `realizedUsd` counts only positions
opened **and fully closed** on chain — where the token quantity nets to zero, so dollars in and
out are a complete round trip. That is the only subset where "realised profit" is literally
true. `netCashUsd` is dollars out minus dollars in across every resolved swap, and is negative
for anyone still holding — which is correct, and why it is named for cash flow rather than
profit.

**`realizedUsd` is `null`, not `0`, when nothing has round-tripped.** "No closed position" is
not "made nothing".

**It agrees with fomo, which is the point.** Across the 106 positions where both sources have a
figure:

```
same direction as fomo    106 / 106   (100%)
within 25% of fomo        100 / 106    (94%)
```

An earlier attempt that matched raw transfers instead of net balances scored 66% and 15% —
close enough to look plausible, far enough to be worthless. The agreement is what makes
`tier: "verified"` defensible.

**Solana only.** The resolution reads Solana pre/post balances; EVM chains carry no
`chainDerived` block.

**Versus GMGN.** They have no equivalent, and structurally cannot: they publish one P&L and
have no independent second source to check it against. This exists precisely because we do.

---

## G12 · Token security

| In plain words | Call | Read | Live value |
| --- | --- | --- | --- |
| "Can you actually sell this, or does buying it trap your money?" | `GET $B/tokens/:address` | `entries[].security` | **67 honeypots** on the board, held by **49 of 137 leaders** |

**In layman's terms.** A honeypot is a coin you can buy but cannot sell — the contract accepts
your money and refuses to give it back. Until now this API ranked coins purely by how many
tracked leaders held them, which made a honeypot look exactly like a good coin. This adds the
contract's own answer: can you sell, what tax is charged, and who still controls it.

The first full pass found **67 honeypots** among the coins our leaders hold, spread across
**154 positions** and **49 of the 137 traders**.

### How to test

```bash
# a confirmed honeypot
curl -s "$B/tokens/0x000ae314e2a2172a039b26378814c252734f556a" | jq '.entries[0].security'

# on the board, and filterable
curl -s "$B/tokens?limit=500" | jq '[.entries[] | select(.isHoneypot == true)] | length'
curl -s "$B/tokens?excludeHoneypots=true&limit=2000" | jq '.count'
```

```json
{
  "canSell": false,
  "isHoneypot": true,
  "buyTax": 0,
  "sellTax": 0,
  "isOpenSource": true,
  "ownerRenounced": true,
  "mintRenounced": null,
  "freezeRenounced": null,
  "rugRatio": null,
  "flags": [
    "honeypot"
  ],
  "verdict": "cannot_sell",
  "tier": "third_party",
  "source": "gmgn"
}
```

### ⚠ `null` never means safe

**`isHoneypot: null` is "not assessed on this chain", not "no".** GMGN evaluates honeypot
behaviour on EVM only, so it is `null` on **every** Solana token. Reading that as `false` is
exactly the mistake this shape exists to prevent.

**The applicable checks differ by chain**, because the concepts do:

| | assessed | not applicable |
| --- | --- | --- |
| **EVM** (eth/bsc/base/robinhood) | `isHoneypot`, `isOpenSource`, `ownerRenounced`, `blacklistFunction` | `mintRenounced`, `freezeRenounced` — Solana concepts |
| **Solana** | `mintRenounced`, `freezeRenounced` | `isHoneypot`, `isOpenSource`, `ownerRenounced` |

GMGN returns `false` for the inapplicable ones. We store `null` instead — publishing "mint
authority not renounced" about a chain with no mint authority would be a frightening claim
about something that cannot be true or false there. Every response carries
`applicableChecks` naming what could be judged, so an absent field reads as out of scope.

### What else to know

**`verdict` is a summary, not a safety rating.** `cannot_sell` · `caution` ·
`no_flags_raised`. The last one means *GMGN's checks caught nothing* — not that the token is
safe. A contract can be hostile in ways none of these checks cover, and the response says so.

**`?excludeHoneypots=true` is opt-in, and only drops the proven.** The default board still
shows all 1,095 tokens including the 67 — silently removing rows would misstate a count
someone is relying on. And it never drops a Solana token for failing a check that was never
run there.

**Refreshed nightly with the fundamentals**, in the same pass. `fetchedAt` says how old the
answer is; there is no external call at request time.

**Versus GMGN.** Same endpoint, same checks. The difference is that ours arrives beside the
holder data with the per-chain applicability stated, so a `null` cannot be mistaken for a pass.

---

## What is not here yet

 — and **every one of them requires a
migration or an external call**, since the pure-code tier is complete, including everything requiring an
external call — token security (`is_honeypot`, `buy_tax`), fundamentals (`price`, `liquidity`,
`market_cap`), true chain-wide holder counts, wallet tags and creator signals. See
[GMGN_PARITY_PLAN.md](GMGN_PARITY_PLAN.md) for the full list, what each costs, and the eight
GMGN capabilities we have deliberately declined.

**There is still no risk signal anywhere in this API.** We rank tokens by how many tracked
leaders hold them and say nothing about whether the contract lets you sell. That gap is
[GMGN_PARITY_PLAN.md](GMGN_PARITY_PLAN.md) §6 and is the one place where our silence is
actively dangerous.
