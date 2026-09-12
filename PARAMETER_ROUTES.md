# genie-fomo API — complete reference

**Generated: 2026-09-09T09:20Z** · **Updated 2026-09-12** — the directory carries
GMGN-sourced traders alongside fomo's (§0d); the **stable id works on every per-trader route**
and wallets name their **chains** (§0e); balances are **read from the chain** and the asset
list **pages** (§2); the **balance series reaches thirty days back on all five chains**, with
the service's own `reach` and `drawing` verdict (§9); and the batch routes answer with
**identity-safe rows carrying the complete AUM object** under `contractVersion: 2`, and a
`chain` of their own (§11). A day is now stated from the chains that answered rather than
refused whole, which took traders who can draw a line from 96 to **372 of 435** — see
Appendix A3.

Everything the API answers, in one document: the **35 PARAMETERS.md parameters**, the **10
GMGN-parity features** built on top of them, and the corrections from the bug report. One row
per thing you can ask — what it means in plain words, the exact call, and the field to read.

| | |
| --- | --- |
| Parameters (T·K·C series) | **35**, all live |
| GMGN-parity features (G series) | **12 of 12** — G1–G12, complete |
| Reported bugs and issues | **10 of 10 fixed** — see Appendix A |
| Plugin requirements (§ series) | **8 of 8 shipped** — see Appendix C |
| Routes | **19** — 17 `GET`, 2 `POST` batch, plus bulk `?include=` |
| Traders in the directory | **435** — 144 from fomo, **291 from GMGN** |
| Positions | **36,506**, read from chain across **5 chains** |
| Balance history | **35,271 rebuilt points** over 30 days · **389 of 435** traders · **372** can draw a line (2+ dated figures), on **all four windows** |

**Every figure below is a dated example, not current state.** They were pulled from the live
service at the timestamp above; the pipeline refreshes nightly and the Helius webhook ingests
continuously, so they will have moved by the time you read this. Treat them as "what this
field looks like" and re-run the command for today's value.

```bash
export B=https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api
```

No API key. **Zero external calls per request** — every route answers from Postgres. Provider
keys belong to the scheduled loaders, and GMGN-sourced figures (G7–G10) are fetched nightly
and cached, never at request time.

> **Deploying:** the public-access promise above is a deploy flag, not a code setting. The
> function must go out as
> `supabase functions deploy api --project-ref gxnonqlmujmtgczvhvzp --no-verify-jwt`.
> The CLI defaults to requiring a JWT, so omitting the flag makes every route answer
> `UNAUTHORIZED_NO_AUTH_HEADER` until it is redeployed with it.

Supabase already serves this function under `/functions/v1/api`, so an extra `/v1` is
**optional** — `$B/traders/unipcs` and `$B/v1/traders/unipcs` both resolve. The short form is
used throughout.

**The handle is a parameter, not the first segment**: it is `$B/traders/unipcs/wallets`, never
`$B/unipcs/wallets`.

Two conventions run through everything below, and they are the reason several figures look
more careful than they need to:

- **A missing value is `null`, never `0`.** A zero reads as "worth nothing", which is a
  different and much worse statement than "we could not value it".
- **Every borrowed number says so.** `tier: "reported"` is fomo's, `tier: "third_party"` is
  GMGN's, `tier: "verified"` is ours from chain. Nothing is blended.

---

## 0d. Two sources of trader

Until 2026-09-09 every trader here came from fomo, and fomo will not serve anyone outside its
own top 100 — `/v2/users/{handle}` answers *"trader not found"* for everybody else. The
directory now also carries traders discovered from GMGN's two public wallet lists (KOL and
smart money), on the key we already hold.

| | fomo | GMGN |
| --- | --- | --- |
| Traders | 144 | **291** |
| `traders.source` | `fomoapi.io` | `gmgn` |
| Wallets | 141 | 291 |
| `trades` | 141 traders · 13,184 positions | 291 traders · **33,151 positions** |
| `trader_stats` | 144 | 291 |
| Holdings | 140 | 227 |

**No new tables and no new routes.** Every route below works for both, because they key off
`handle` and `address_key` rather than anything fomo-specific. Verified live across 16 routes
× 3 traders: all 200, all returning real figures.

Four things worth knowing before you read a GMGN trader's numbers:

- **`rank` and `followers` are `null`.** They are fomo-leaderboard concepts with no on-chain
  equivalent, and inventing a rank would put a GMGN trader on fomo's ladder as though fomo
  had placed them there. Sorting by rank puts them last, not first.
- **Their `trades` are derived, not reported.** fomo hands us finished positions; a GMGN
  trader's are folded from per-trade activity into the same per-position shape — buys give
  `avgEntryPrice`, sells give `avgExitPrice` and `realizedPnlUsd` via `cost_usd − buy_cost_usd`.
  Same table, same meaning, different provenance.
- **`unrealizedPnlUsd` is `null` for them**, not 0. It needs a current price we do not hold for
  most of these tokens, and 0 would read as "this position is exactly flat".
- **Their entry-price coverage is far better.** 89% of GMGN positions carry an entry price
  against fomo's 45%, so `scorecard.entryPriceCoverage.clearsSpecBar` is often `true` for a
  GMGN trader and rarely for a fomo one. That is a property of the source, not of the trader.

**The cohort tripled, so percentile ranks moved.** Any axis score computed against the old
144-trader cohort is not comparable to one computed now.

```bash
curl -s "$B/traders/feibo03/scorecard?tokens=0" | jq '{winRate, entryPriceCoverage}'
curl -s "$B/traders?limit=500" | jq '.entries | length'   # 435
```

---

## Contents

| § | | |
| --- | --- | --- |
| **0** | [Routes that are not a single parameter](#0-routes-that-are-not-a-single-parameter) | the 15 endpoints, plus bulk `?include=` |
| **0a** | [Errors — telling apart "stop", "back off" and "retry"](#0a-errors-telling-apart-stop-back-off-and-retry) | status codes, stable `code`, rate-limit headers |
| **0b** | [Cursor pagination (G4)](#0b-cursor-pagination-g4) | **G4** |
| **0c** | [Sorting and range filters (G5)](#0c-sorting-and-range-filters-g5) | **G5** |
| **0d** | [Two sources of trader](#0d-two-sources-of-trader) | fomo's 144 + **GMGN's 291** |
| **0e** | [Stable id, and wallets that name their chains](#0e-stable-id-and-wallets-that-name-their-chains) | key on `id`, read on the right chain |
| **1** | [Trader — money](#1-trader-money) | T1–T10 |
| **2** | [Trader — positions](#2-trader-positions) | T11–T15 |
| **2b** | [Position timing (G1)](#2b-position-timing-g1) | **G1** |
| **3** | [Trader — time](#3-trader-time) | T16–T20 |
| **3b** | [On-chain activity counters (G2)](#3b-on-chain-activity-counters-g2) | **G2** |
| **3c** | [USD value per transfer (G6)](#3c-usd-value-per-transfer-g6) | **G6** |
| **4** | [Trust](#4-trust) | does fomo's own story hold together |
| **5** | [Token](#5-token) | K-series |
| **5a** | [Token security (G12)](#5a-token-security-g12) | **G12** — can you sell it |
| **5b** | [Leader concentration (G3)](#5b-leader-concentration-g3) | **G3** — ours |
| **5c** | [Token fundamentals (G7)](#5c-token-fundamentals-g7) | **G7** |
| **5d** | [Chain-wide concentration (G8)](#5d-chain-wide-concentration-g8) | **G8** — theirs |
| **5e** | [Wallet tags (G9)](#5e-wallet-tags-g9) | **G9** |
| **5f** | [Creator / dev signals (G10)](#5f-creator-dev-signals-g10) | **G10** |
| **6** | [Chain](#6-chain) | C-series |
| **7** | [Two parameters that used to be listed as impossible](#7-two-parameters-that-used-to-be-listed-as-impossible) |  |
| **7b** | [Chain profitability, and what it does not say](#7b-chain-profitability-and-what-it-does-not-say) |  |
| **4b** | [Chain-verified P&L](#4b-chain-verified-pl-g11) | **G11** |
| **8** | [Read the coverage before the number](#8-read-the-coverage-before-the-number) | how to not misread any of it |
| **9** | [AUM over time](#9-aum-over-time) | the balance series |
| **10** | [Trades, both sides](#10-trades-both-sides) | valued from the money side |
| **11** | [Batch reads](#11-batch-reads) | the whole board in a bounded number of calls |
| **C** | [What the plugin team asked for](#appendix-c-what-the-plugin-team-asked-for) | § by §, and where each landed |
| **A** | [What the bug report found, and what changed](#appendix-a-what-the-bug-report-found-and-what-changed) | all 10 fixes |
| **B** | [Where each figure comes from](#appendix-b-where-each-figure-comes-from) | `reported` / `verified` / `third_party` |
---

## 0. Routes that are not a single parameter

| Route | In plain words | Live value |
| --- | --- | --- |
| `GET $B/health` | "What's in the database, and when was it loaded?" | **435 traders** · 29,967 holdings · 51,581 trades · ~652k transfers |
| `GET $B/traders` | "Who are the top 137?" | each entry carries a stable `id` and its own `updatedAt` |
| `GET $B/traders/unipcs` | "Everything about one trader, and **what else I can ask**" | summary + `links` to all seven sub-routes |
| `GET $B/traders/unipcs/transactions?limit=5` | "What have their wallets actually done on-chain?" | `?kind=swap` filters to trades; each row carries `kind` and `protocol` |
| `GET $B/traders?include=pnl,scorecard` | "Give me the whole board **and** its sub-resources in one call" | 137 traders x 4 sub-resources in **one 5.2s call**, replacing 548 |
| `GET $B/traders?updatedSince=<ISO>` | "Only what changed since my last sync" | returns the changed set plus anything whose freshness is unknown |

**`id` is stable, `handle` is not.** Every trader carries a UUID `id` that is ours and never
reissued; `handle` comes from fomo and is theirs to rename. Key your rows on `id`.

**`updatedAt` is per trader.** The board envelope's `capturedAt` covers the whole list, so it
cannot tell a trader refreshed a minute ago from one refreshed yesterday — each entry now
carries its own.

### Bulk fetch — `?include=` (for syncing, not for browsing)

Mirroring the directory used to mean 137 traders x 7 sub-routes, ~960 calls, ~30 minutes
sequentially. `?include=` inlines sub-resources from **one set-based query each**:

```bash
curl -s "$B/traders?include=pnl,scorecard,wallets,trust"      # 137 traders, 5.2s, 969KB
curl -s "$B/traders?include=pnl&limit=25&offset=50"           # paged
curl -s "$B/traders?include=pnl&updatedSince=2026-09-07T00:00:00Z"
```

Valid values are `pnl`, `scorecard`, `wallets`, `trust`. Anything else is a **400** naming the
valid set — a silently ignored parameter is how a consumer ends up believing they have data
they never received. `portfolio`, `positions` and `transactions` are not bulk-able and are
still fetched per trader.

**Sub-resources arrive under `entries[].included`, not on the entry itself.** `entries[].pnl`
is fomo's *reported* figure; `included.pnl` is what we compute from stored trades. They are
different numbers answering different questions and must not share a key — the same
reported-versus-verified split that runs through this whole document.

```json
{ "handle": "unipcs",
  "pnl": 17852542,                      // fomo's reported figure
  "included": {
    "pnl": { "bankedUsd": -131120.08, "onPaperUsd": 17491475.98, ... }   // ours
  } }
```

**`included.scorecard.byToken` is empty here.** That one field is 98% of a scorecard's bytes
(185KB against 3KB), so 137 of them would be a 24MB response. `tokensTotal` still reports the
real count; `/traders/:handle/scorecard` serves the tokens in full.

**`?updatedSince=<ISO-8601>` is for incremental sync.** It returns traders refreshed since that
moment — **plus every trader whose refresh time is unknown** (37 of 137 have no stats row).
Unknown freshness cannot prove nothing changed, and omitting them would hide them from every
incremental sync with nothing to signal the gap. The response says so in `updatedSinceNote`.

**Start at `$B/traders/<handle>`.** It returns a `links` object naming every sub-route for
that trader, so the next URL never has to be guessed. It also separates `reported`
(the leaderboard's own figures) from `stored` (what we actually hold), which is the same
Reported-vs-Verified split that runs through the rest of this document.

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

## 0b. Cursor pagination (G4)

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

## 0c. Sorting and range filters (G5)

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

## 0e. Stable id, and wallets that name their chains

| In plain words | Call | Read | Live value (`unipcs`) |
| --- | --- | --- | --- |
| "Which trader is this, and where do I read them?" | `GET $B/traders/unipcs/wallets` | `id`, `wallets[].family`, `wallets[].chains` | **`a06e3ef7-425a-…`** · solana + evm, evm active on **4 chains** |

**In layman's terms.** A handle is a display name and people change them. `id` never changes
and is never reused, so key on it and show the handle. And one Ethereum-style address is the
same wallet on Ethereum, Base, BNB Chain and Robinhood Chain **at once** — so the wallet block
names the chains we have actually seen it trade on, and you read exactly those.

**The id is an opaque string.** Today's values happen to be UUID-shaped; do not parse them,
match on a format, or assume a prefix. Compare them whole.

**One spelling, and every route accepts both.** The id is returned bare — the same characters
from `GET /traders` and from `/wallets`. The older `trd_`-prefixed form is still accepted as
*input* everywhere and always will be, so a consumer holding either keeps working.

**It works on every per-trader route**, not just some of them:
`/`, `/aum`, `/portfolio`, `/positions`, `/scorecard`, `/transactions`, `/trust`, `/pnl`,
`/wallets`, `/trades` — all ten answer to the id and to the handle, and both return the same
trader. This is the contract `GENIE_FOMO_V7_BATCH_AUM_AND_COVERAGE_PRD.md` §1 requires.

### How to test

```bash
curl -s "$B/traders/unipcs/wallets" | jq '{id, handle, handleChangedAt, presence}'
curl -s "$B/traders/unipcs/wallets" | jq '.wallets[] | {family, address, chains}'

# the id from the directory works on EVERY per-trader route, not only this one
ID=$(curl -s "$B/traders?limit=1" | jq -r '.entries[0].id')
for r in aum portfolio positions scorecard transactions trust pnl wallets trades; do
  curl -s -o /dev/null -w "$r %{http_code}\n" "$B/traders/$ID/$r"
done
```

```json
{
  "id": "a06e3ef7-425a-48e9-a131-220a4dcea4cc",
  "handle": "unipcs",
  "handleChangedAt": null,
  "presence": "observed",
  "wallets": [
    { "address": "2heJbC32Tpfcb3nbUb5ER61K11FGZVfVGtVnDm6LDogF", "family": "solana",
      "chains": [ { "chain": "solana", "networkId": 1399811149,
                    "tradesSeen": 45, "lastActiveAt": "2026-09-05T04:30:29.000Z" } ] },
    { "address": "0x0a6ebed0155edb4b21d92ad02897a626cd90119e", "family": "evm",
      "chains": [ { "chain": "robinhood", "networkId": 4663, "tradesSeen": 178,
                    "lastActiveAt": "2026-09-07T11:40:41.000Z" },
                  { "chain": "bsc", "networkId": 56, "tradesSeen": 34, "lastActiveAt": "…" } ] }
  ]
}
```

### What to know before you use it

**`family` is `solana` or `evm`, and never a chain.** The family says how to talk to the
address; `chains` says where it has been. Of our 260 Ethereum-only traders, **140 trade on
four chains** — one address, four places to read.

**`chains` is observed, never inferred.** A chain we have not seen the wallet on is **absent**
from the list, not `tradesSeen: 0`. "We have never seen them there" and "they have done
nothing there" are different statements and only one of them is ours to make.

**`presence: "not_yet_scanned"`** appears instead of an empty list when a wallet exists but no
chain activity has been observed yet — so a quiet wallet and an unscanned one are
distinguishable.

**`wallets: []` is a valid answer**, not an error. Three traders in the directory are
registered without an address on record.

**Rename-safe.** `handleChangedAt` carries the moment a display handle last changed, so a
consumer following a name can notice it moved.

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

### Paging the asset list

```bash
curl -s "$B/traders/unipcs/positions?limit=100" | jq '{count, positions, complete, nextCursor}'
curl -s "$B/traders/unipcs/positions?limit=100&cursor=<nextCursor>" | jq '{count, complete}'
```

**`complete: false` means rows remain, and a `false` page is not a portfolio.** `positions` is
the full count, `count` is what this page holds, and `nextCursor` is null only on the last
page. Walked end to end on `unipcs`: **521 assets over 6 pages, no asset repeated, none lost.**

**The cursor names the last row returned, not an offset**, so a position appearing or
disappearing between pages cannot make the sequence skip or repeat one. Row identity is
`(chain, tokenAddress)` — never `symbol`, which is display metadata two different coins can
share.

### Every position says where its numbers came from

`entries[]` carries the provenance of both halves of a valuation — the amount and the price:

```bash
curl -s "$B/traders/frankdegods/positions?limit=1" \
  | jq '.entries[0] | {amount, balanceAt, tier, priceUsd, priceSource, pricedAt, valueUsd, whyNoPrice}'
```

```json
{
  "amount": 2389557.260697,
  "balanceAt": "2026-09-10T15:40:33.000Z",
  "tier": "verified",
  "priceUsd": 1,
  "priceSource": "pegged_usd",
  "pricedAt": "2026-09-10T16:15:58.000Z",
  "valueUsd": 2389557.26,
  "whyNoPrice": null
}
```

| Field | What it tells you |
| --- | --- |
| `amount` | the **balance**, read from the chain — `getTokenAccountsByOwner` on Solana, batched `balanceOf` on the four Ethereum-style chains |
| `balanceAt` | the moment that balance was read |
| `tier` | `verified` when we read it ourselves, `reported` when a build supplied it |
| `priceSource` | `pegged_usd` · `gmgn_token_info` · `token_prices_daily` · `fomo_reported_entry` · `wallet_swap_derived` |
| `pricedAt` | when that price was true — a reported entry price can be older than a live quote, and says so |
| `whyNoPrice` | present instead of a bare `null` when a holding cannot be valued |

**A coin we cannot price is counted, never zeroed.** It appears in `positions` and in
`coverage.unpricedPositions`, and stays out of `totalValueUsd` — so the count of what someone
holds and the value of what we could measure are two separate, honest numbers.

**Verified against the chain.** The example above reads 2,389,557.26 USDC; a direct
`getTokenAccountsByOwner` call on the same wallet returns 2,389,565.66 — the two agree to
0.0004%, the difference being the minutes between the two reads.

---

## 2b. Position timing (G1)

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

## 3b. On-chain activity counters (G2)

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

## 3c. USD value per transfer (G6)

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

# one transfer row in full
curl -s "$B/traders/unipcs/transactions?limit=1" | jq '.transfers[0]'

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

**A transfer row is keyed by `txHash`.** Every route in this API spells it that way. This one
also still returns `tx_hash`, the same value under the older snake_case name it was first
published with, so nothing reading it breaks — but `txHash` is the one to use and `tx_hash`
is deprecated.

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

## 4b. Chain-verified P&L (G11)


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

## 5a. Token security (G12)


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

## 5b. Leader concentration (G3)

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

## 5c. Token fundamentals (G7)

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

## 5d. Chain-wide concentration (G8)

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

## 5e. Wallet tags (G9)

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

## 5f. Creator / dev signals (G10)

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

---

## 9. AUM over time

| In plain words | Call | Read | Live value (`0xAvast`) |
| --- | --- | --- | --- |
| "How much has this trader been holding, and how has it moved?" | `GET $B/traders/0xAvast/aum?window=1d` | `now.totalUsd`, `points[]` | **$4,416,026.98** across 216 positions, 198 priced |

**In layman's terms.** `/portfolio` answers *"what does he hold right now"*. This answers
*"what has he been holding, over time"* — the line a chart draws. Every sampled point was
**measured and written down at the time**, so the series is a record rather than a running
total. Add `?chain=` and the same line narrows to a single chain.

### How to test

```bash
curl -s "$B/traders/0xAvast/aum?window=1d" | jq .
curl -s "$B/traders/0xAvast/aum?window=1w" | jq '.now, .chains'
curl -s "$B/traders/0xAvast/aum?window=1w&step=1d" | jq '{step, count}'
```

```json
{
  "handle": "0xAvast", "window": "1d", "step": "1h",
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
  "refused": null
}
```

### Windows and steps

```
?window=1d | 1w | 1m | all        how far back            default 1w
?step=1h  | 6h | 1d               thin the series         default: the coarsest leaving >= 24 points
?chain=robinhood | solana | ...   one chain instead of the whole portfolio
```

| `?window=` | default `step` | points |
| --- | --- | --- |
| `1d` | `1h` | 24 |
| `1w` | `6h` | 28 |
| `1m` | `1d` | 30 |

### One chain at a time — `?chain=`

```bash
curl -s "$B/traders/0xAvast/aum?window=1m&chain=robinhood" | jq .
```

```json
{
  "handle": "0xAvast", "chain": "robinhood", "window": "1m", "step": "1d",
  "trackedSince": "2026-09-10T14:00:00.000Z",
  "now": {
    "at": "2026-09-10T16:00:00.000Z",
    "totalUsd": 1518328.05,
    "coverage": { "pricedPositions": null, "totalPositions": null, "valueShare": 1 },
    "tier": "verified"
  },
  "count": 1,
  "points": [
    { "at": "2026-09-10T16:00:00.000Z", "totalUsd": 1518328.05,
      "basis": "sampled", "tier": "verified",
      "coverage": { "pricedPositions": null, "totalPositions": null, "valueShare": 1 } }
  ],
  "refused": null
}
```

A chain series answers *"how much of him is on this chain, and how has that moved"*. The five
chains all answer; `chain` on the response echoes which one you narrowed to, and `null` there
means you are looking at the whole portfolio.

**The series reaches thirty days back on all five chains**, written `basis: "rebuilt"` /
`tier: "reported"` so a reconstruction is never mistaken for a measurement.

| Chain | Points | Traders | How the balance was obtained |
| --- | --- | --- | --- |
| robinhood | 10,230 | 341 | every `Transfer` log replayed backwards from today's balance |
| bsc | 8,010 | 267 | asked an archive node for the balance at that block |
| ethereum | 7,440 | 248 | asked an archive node for the balance at that block |
| solana | 5,091 | 169 | the balance each transaction recorded, from Helius |
| base | 4,500 | 150 | asked an archive node for the balance at that block |

**35,271 points across 388 of 435 traders**, and **363 traders have at least one series with
three or more usable points** — enough for the service to call it drawable.

**Nothing is written until it reproduces the wallet.** Where a balance is inferred rather than
read — robinhood and Solana — the anchor plus every movement since it must equal what the
wallet holds now before a single row is stored. robinhood passed **40 of 40** in each of its
seven address batches. Solana is checked **per coin**: 169 of 170 wallets reconcile, and a coin
whose own balance cannot be reproduced is counted as a position and never valued, exactly as
native ETH is on robinhood. One wallet reconciles nothing and is not written at all.

**`reach.complete` is judged against the data's own granularity.** Rebuilt history is daily, so
a week requested at six-hour steps is not "short" merely because its oldest point sits inside
a boundary computed to the millisecond. The slack is the larger of the requested step and the
median spacing of the points actually held — so a complete daily month reports `complete: true`
rather than 29 of 30.

**`count` is how much history is behind the line, and it is honest about it.** The series
deepens by one point per sampling run, so a consumer should draw `count` points rather than
assume a full window — `trackedSince` says when the record starts.

| Ask for | You get |
| --- | --- |
| no `chain` | the whole portfolio, every chain summed |
| `chain=robinhood` \| `solana` \| `bsc` \| `base` \| `ethereum` | that chain alone |

**`trackedSince` is the seam, and the response never blends the two sides of it.** Points
after it carry `basis: "sampled"` / `tier: "verified"` — read from the chain at that moment.
Points before it carry `basis: "rebuilt"` / `tier: "reported"` — worked out backwards from the
chain's own `Transfer` logs. `plain` names the seam in words.

**On a chain series the coverage field is `pricedShare`, and the position counts are `null`.**
The counts on a portfolio point describe the whole trader, so showing them beside one chain's
dollars would make the line look like it changed scope halfway along. `pricedShare` means the
same thing on every point.

**`now` is the newest reading we hold, whatever window you asked for.** Asking for one day
used to return `now: null` on a trader carrying a month of history and a $5.1M balance — what
someone is worth does not depend on how much of their past you requested. A null total there
now means the newest reading was genuinely refused, and `refused` names why.

**A short window borrows the readings just before it, marked `outsideWindow`.** History steps
once a day, so a 24-hour window held at most one point and usually none — `window=1d` drew
nothing for anybody. A one-day chart wants two figures: what he was worth at the start of the
day and what he is worth now, and we hold both. The older one simply sat outside the filter.

```bash
curl -s "$B/traders/unipcs/aum?window=1d" | jq '{now: .now.totalUsd, points: [.points[] | {at, totalUsd, outsideWindow}]}'
```

Three rules keep that honest:

- a borrowed point is **a real dated reading**, never interpolated, and carries `outsideWindow: true`
- `reach.coveredFrom` / `coveredTo` report the span the line **actually** covers, not the span requested
- borrowed points must share the newest point's **`basis`**, because a sampled figure and a
  rebuilt one count different things. `@unipcs` held $15,665,318 sampled and $5,101,125 rebuilt
  eight hours apart — borrowing across that seam would have drawn a 67% fall that never happened

It borrows until the series holds **two readings that carry a figure**, not merely two rows: a
refused day is not half a line.

**A day is stated from the chains that answered, and says so.** Every point carries
`coverage.chainsAnswered`, `coverage.chainsTotal` and `coverage.partial`:

```json
{ "pricedPositions": 2, "totalPositions": 83, "valueShare": 0,
  "chainsAnswered": 1, "chainsTotal": 3, "partial": true }
```

A day used to be refused outright unless every chain the trader touches answered at it — which
refused 8,894 days across the directory while the per-chain figures for those days existed all
along. `partial: true` means the total is a **real figure for part of him**, not an estimate of
all of him, and whether to draw it is the caller's decision. A day where *nothing* answered is
still refused with a reason, because there is no number to state.

**Read `pricedShare` before comparing a rebuilt point to a sampled one.** A rebuilt point is
valued from prices carrying a date, a sampled point from live prices, and the two cover
different fractions of the same wallet — so the step at `trackedSince` reflects how much of
him each side could value, not a move he made. `pricedShare` gives the fraction on both, and
a day nothing could be valued returns `totalUsd: null` rather than a zero.

### The service decides whether the series can be drawn

```bash
curl -s "$B/traders/pointfarmcap/aum?window=1m&chain=robinhood" | jq '{reach, drawing}'
```

```json
{
  "status": "ready",
  "reach": { "requestedFrom": "2026-08-12T08:38:38Z", "coveredFrom": "2026-08-13T00:00:00Z",
             "coveredTo": "2026-09-10T16:00:00Z",
             "requestedDays": 30, "coveredDays": 29, "complete": true },
  "drawing": { "drawable": true, "usablePoints": 29, "reason": null },
  "coverage": { "answeredWallets": 1, "totalWallets": 1,
                "answeredChains": 1, "totalChains": 1 }
}
```

**`status` separates "this is all there is" from "this is all there is SO FAR".** A `ready`
series is the finished answer; a `warming` one will be longer if the same request is made
later, and carries a `progress` block saying how much longer and when:

```json
{
  "status": "warming",
  "drawing": { "drawable": false, "usablePoints": 1, "reason": "warming" },
  "progress": { "coveredDays": 0, "targetDays": 30, "nextRunAt": "2026-09-12T06:00:00.000Z" }
}
```

**`from` echoes the request. `reach` is the evidence.** Asking for a month does not create a
month, so the span the stored rows actually cover is stated separately, and `complete` answers
"does this reach the window you asked for" directly.

**Do not infer readiness from `window`, `from`, `count` or the position counts** — read
`drawing.drawable`. Only the service knows whether a change in the line came from the trader
or from missing data, so it makes the call rather than leaving each consumer to guess.

**Two dated figures are a line; one never is.** That is the threshold `drawable` applies.

| `drawing.reason` | What it means |
| --- | --- |
| `null` | drawable — plot it |
| `warming` | backfill or first sampling still running; temporary |
| `too_few_points` | fewer than three comparable numeric points |
| `short_coverage` | enough points, but not across the requested window |
| `wallet_unreadable` · `service_timeout` · `no_prices` · `price_rejected` | the newest point's own refusal |

**`gaps[]` lists every bucket with no number, and its reason.** Nothing is interpolated — a
chart breaks its line at each gap rather than drawing through it, because joining two points
across a hole draws a balance the trader never held.

**`coverage` says how much of the trader a point could see, in wallets and in chains.** A
chain with no row at that moment did not contribute zero dollars; it contributed nothing at
all, and those are different facts. Wallets are counted as well as chains because one EVM
address serves four of the five chains — so "three of four chains" can still mean either
wallet went unread, and which one it was changes what the number is missing.

### What to know before you use it

**The parts sum to the whole.** `sum(chains[].totalUsd)` equals `now.totalUsd` on every
response, so a per-chain line and the total line always agree.

**`tier: "verified"` means we read the chain.** Amounts come from `getTokenAccountsByOwner`
on Solana and batched `balanceOf` on the four Ethereum-style chains — not from a running
total. A `basis` of `sampled` is a reading taken at that moment.

**Thinning keeps the last point in each bucket, never an average.** An average would show a
balance the trader never actually held.

**Nothing is interpolated.** A gap in the series is a gap, and a chart should draw a break
rather than a straight line through it.

**`totalUsd` is `null`, never a smaller number, when a wallet could not be read** — with
`refused` naming which wall was hit (`wallet_unreadable`, `service_timeout`, `no_prices`,
`price_rejected`). A partial total would read exactly like a real drawdown.

**A trader whose wallets all answered and held nothing is `0`.** That zero is a measurement.

**The series deepens on its own.** `trackedSince` marks where sampling began and `count`
says how many points came back, so a consumer renders whatever exists rather than waiting
for a full window.

---

## 10. Trades, both sides

| In plain words | Call | Read | Live value (`frankdegods`) |
| --- | --- | --- | --- |
| "What did they actually trade, and what did it cost?" | `GET $B/traders/frankdegods/trades?limit=2` | `trades[]` | **sold 12,255,236 MUSE for 954.81 USDC** |

**In layman's terms.** Each row is one swap the wallet actually made, with **both sides**:
the coin, and the money it changed hands for. The dollar figure comes from the **money side**
— what was really paid or received in a coin whose value we know — so it does not depend on
guessing a memecoin's price.

### How to test

```bash
curl -s "$B/traders/frankdegods/trades?limit=2" | jq '.trades'
curl -s "$B/traders/frankdegods/trades?chain=solana&since=2026-09-01" | jq '.count'
curl -s "$B/traders/frankdegods/trades" | jq '.coverage'
```

```json
{
  "chain": "solana", "networkId": 1399811149,
  "txHash": "2Rzxy4RvkGf6KEz7aKYVA8gfzMJb5JzwFM5XAGQMkuRLiaTY1b64DS2WSshAp8NhEAZSuePSjVBNzrwM3gASfWzh",
  "at": "2026-09-09T04:32:10.000Z",
  "side": "sell",
  "token": { "address": "AUZrzyaejPs4zqGQ7xpPrSz9qs2rq4WhvtKANXvaWupT",
             "symbol": "MUSE", "amount": 12255236.712766 },
  "money": { "symbol": "USDC", "amount": 954.8140330000006 },
  "valueUsd": 954.81,
  "valueSource": "money_side",
  "priceUsd": 7.79106969028e-05,
  "tier": "verified"
}
```

### What to know before you use it

**`valueUsd` comes from the money side, not from a price.** `valueSource: "money_side"` says
so. `priceUsd` is the price *implied* by the two legs and is there to cross-check against,
not to value the trade with.

**`side` is derived from the token leg**, not from a provider's label — positive means they
bought, negative means they sold.

**`coverage` names the chains served and the chains not.** `chainsResolved` and
`chainsTradedButUnresolved` mean a consumer can tell "we have this chain's swaps" from "this
trader also trades there" without inferring silence.

**The cap is stated.** `limit` and `capped` appear on every response, so a truncated page is
never mistaken for the end of the data.

**Filters:** `?chain=` and `?since=` narrow the set; `?limit=` bounds the page.

---

## 11. Batch reads

| In plain words | Call | Read | Live value |
| --- | --- | --- | --- |
| "The whole board, without 435 calls" | `POST $B/traders/positions` | `traders[]` | **50 traders per call** |

**In layman's terms.** A background pass over the directory cannot make one call per trader.
These take a list of ids or handles and answer for all of them at once.

### How to test

```bash
curl -s -X POST "$B/traders/positions" -H 'content-type: application/json' \
  -d '{"ids":["frankdegods","0xAvast"]}' | jq '.traders[] | {handle, coverage}'

curl -s -X POST "$B/traders/aum" -H 'content-type: application/json' \
  -d '{"ids":["0xAvast","0xleo"],"window":"1w"}' | jq '.traders[] | {handle, count, now}'
```

```json
{
  "limit": 50, "asked": 2, "capped": false,
  "traders": [
    { "handle": "frankdegods",
      "positions": [ { "chain": "solana", "amount": 2389557.26,
                       "balanceAt": "2026-09-10T15:40:33.000Z", "tier": "verified",
                       "priceUsd": 1, "priceSource": "pegged_usd",
                       "valueUsd": 2389557.26, "whyNoPrice": null } ],
      "coverage": { "of": 437, "total": 1454, "share": 0.3006 } }
  ]
}
```

### `contractVersion: 2` — identity-safe rows and the whole AUM object

Send `contractVersion: 2` in the body and both batch routes answer with the permanent
contract. Leave it out and the older shape comes back unchanged, so a consumer already
reading it keeps working until it migrates.

```bash
curl -s -X POST "$B/traders/aum" -H 'content-type: application/json' \
  -d '{"contractVersion":2,"ids":["a06e3ef7-425a-48e9-a131-220a4dcea4cc"],"window":"1w"}' \
  | jq '.traders[0] | {ok, requested, id, handle, drawable: .aum.drawing.drawable}'
```

```json
{
  "contractVersion": 2, "limit": 50, "asked": 2, "capped": false, "window": "1w",
  "traders": [
    { "ok": true,
      "requested": "a06e3ef7-425a-48e9-a131-220a4dcea4cc",
      "id": "a06e3ef7-425a-48e9-a131-220a4dcea4cc",
      "handle": "unipcs",
      "aum": { "window": "1w", "step": "6h", "stepMs": 21600000, "status": "ready",
               "reach": {}, "drawing": {}, "progress": null, "gaps": [],
               "coverage": {}, "now": {}, "points": [], "chains": [],
               "refused": null, "plain": "…" } },
    { "ok": false, "requested": "nope", "id": null, "handle": null,
      "error": { "code": "not_found", "detail": "no trader 'nope' in the directory" } }
  ]
}
```

**A batch can name a chain.** `chain` on the body does what `?chain=` does on the individual
route, through the same resolver and the same code:

```bash
curl -s -X POST "$B/traders/aum" -H 'content-type: application/json' \
  -d '{"contractVersion":2,"ids":["unipcs","zakum"],"window":"1m","chain":"robinhood"}' \
  | jq '{chain, rows: [.traders[] | {requested, points: .aum.count}]}'
```

Without it, a screen of fifty traders on one chain was fifty calls. It is now one.

**`requested` is the value you sent; `id` is canonical.** Join on either. A handle can change
between your request and the answer — `requested` cannot, so a row is never ambiguous.

**`row.aum` is the individual response, not a summary of it.** Both are produced by the same
function from the same rows, so they cannot drift. Verified on all four windows: identical
apart from `from`/`to`/`reach.requestedFrom`, which differ by the seconds between the two
HTTP calls.

**One row per id you sent, including the ones that failed.** An omitted row is
indistinguishable from a trader with no data, so an unresolvable id comes back as
`ok: false` with a reason and never removes the rows that succeeded.

**Batch positions carries the same envelope**, plus `positionCount`, `pricedPositionCount`,
`totalValueUsd`, `coverage`, `complete` and `nextCursor`:

```bash
curl -s -X POST "$B/traders/positions" -H 'content-type: application/json' \
  -d '{"contractVersion":2,"ids":["unipcs"]}' \
  | jq '.traders[0] | {ok, id, positionCount, pricedPositionCount, totalValueUsd, complete}'
```

**`totalValueUsd: null` and `0` are different answers.** Zero means he was read and holds
nothing; null means nothing he holds could be valued. `complete: true` because a batch row
carries every position — it does not page.

**Batch positions omits the holding and activity times** the individual route returns. They
come from an aggregate over `transactions` that costs 12.5 seconds for our busiest trader;
fifty of those would not fit in any sane budget. Read the individual route for the one trader
you are showing.

**Fifty traders, four windows, measured:**

| Call | 50 ids |
| --- | --- |
| `aum` `window=1d` | 3.4 s |
| `aum` `window=1w` | 3.8 s |
| `aum` `window=1m` | 3.9 s |
| `aum` `window=all` | 4.2 s |
| `positions` | 4.7 s |

### What to know before you use it

**`POST` because these are reads with a body.** Fifty ids do not belong in a query string.
Nothing here mutates.

**More than 50 ids is refused, not trimmed.** `POST` with 51 returns `400` naming the cap:

```json
{ "error": { "code": "bad_request",
             "detail": "at most 50 ids per call — got 51; split the list rather than relying on truncation" } }
```

Truncating would return `200` for a list the caller asked about in full, and the ids that were
never read would look exactly like ids with no data. `limit`, `asked` and `capped` still appear
on every response.

**A duplicate id is refused**, because two entries mean the caller expects two rows and
returning one silently breaks the one-result-per-input guarantee:

```json
{ "error": { "code": "duplicate_identifier",
             "detail": "'0xangeryy' appears more than once — every id must be distinct" } }
```

This is checked **after** resolution too — sending a trader's id *and* their handle in the same
call is the same trader named twice, and is refused with the same code.

**Ids or handles, interchangeably.** Both resolve to the same trader.

**`X-Cost-Units` is the number of traders asked for, not the number of HTTP calls.** A batch of
ten reports `10`; every non-batch route reports `1`. A batch is capped at 50, so one call never
costs more than 50. Cost is charged per **requested** trader, whether or not each one resolved,
so a caller can predict a pass before making it.

```bash
curl -sD - -o /dev/null -X POST "$B/traders/aum" -H 'content-type: application/json' \
  -d '{"ids":["0xAvast"],"window":"1w"}' | grep -i x-cost-units     # 1
```

**Every successful response also carries** `RateLimit-Limit`, `RateLimit-Remaining`,
`RateLimit-Reset` and `RateLimit-Scope`, per `GENIE_FOMO_V7_BATCH_AUM_TDR.md` §7.

---

## Appendix A3 · The balance-history report, and what changed (2026-09-12)

The consumer read the whole directory — 434 traders, 1,342 requests in one 47-minute run — and
sent eight asks ranked by value. **All eight are done.** Their measurements were taken on 11–12
September; four of the eight were already fixed by work that landed after their run, which is
why some figures below look nothing like theirs.

| # | What they asked for | What was wrong | What changed |
| --- | --- | --- | --- |
| **1** | Stop refusing a whole day because one chain could not be rebuilt | **8,894 days** across the directory came back as the single word `chains_unrebuildable`, while the per-chain answers carried real figures for the other chains on those very days. Only **109 of 434** could draw from the all-chains answer; among the hundred largest, **3 of 100** | the day is now stated from the chains that answered, and every point carries `chainsAnswered` / `chainsTotal` / `partial` so a part is never mistaken for a whole. Days with a figure went **1,855 → 9,305**; traders who can draw **96 → 372 of 435**. `@ethersole` went from 2 real points to **29** |
| **2** | A close date on each closed trade, or a realised total per day | the scorecard grouped realised profit by `closed_at` and published four windows, and the per-coin breakdown carried 21 fields with no trading date among them — so nothing could say what a trader made on a Tuesday | `realizedByDay` for the last thirty days, plus `firstClosedAt` / `lastClosedAt` on every `byToken` row. Verified against their own figure: the daily rows for `@unipcs` sum to **−$131,120.08 over 43 closed trades**, matching the 30-day window exactly |
| **3** | Backfill the balance history, solana first | **147 of 169** solana answers contained a single step; 22 of 169 could draw | solana rebuilt from the balance each transaction records, checked per coin. **169 of 170 wallets** verified, **29 real points** where there was one |
| **4** | What is the `drawable` flag meant to mean? | every one of their 1,327 reads said `false`, **including all 188 carrying a full 28 days** — the flag compared a span in days against a day count, and N daily points span N−1 days, so a complete month always reported 29 of 30 | the reach test now measures whether the oldest point reaches the requested window, with slack taken from the data's own granularity. `@unipcs` on robinhood: 28 points, `drawable: true`. Their instinct to ignore it was right; it was ours to fix |
| **5** | The directory's identifier is refused by the balance route | the id from `GET /traders` answered **404** on `/aum` while the handle answered 200, so every read cost two calls | the resolver is now the single way in to **all ten** per-trader routes. **§0e** |
| **6** | Let the batch balance call name a chain | the batch took traders and a window with nowhere to name a chain, so a screen of fifty traders on one chain was fifty calls | `chain` on the POST body, same resolver and same code path as `?chain=` on the individual route. **§11** |
| **8** | One trader 404s on the balance route | `yeon__ (gmgn)` — the one handle of 435 with a source in brackets — could not be charted at all. A migration had appended the source to the *display* name to separate two traders sharing a folded handle, and the resolver never matched on it | the resolver falls back to `display_handle` after the plain handle misses. Both spellings answer 200 |

| **7** | `window=1d` answers nothing for anybody | the window was a `WHERE` clause, so a 24-hour span could not see the reading just outside it. Worse, `now` was computed from the windowed rows — so asking for one day returned **no current total either**, on traders carrying a month of history | `now` and `trackedSince` are window-independent, and a short window borrows the readings just before it, marked `outsideWindow`, until it holds two that carry a figure. **All four windows now draw** for every trader in a twelve-trader sample including all five of their worked examples |

**What Ask 7 does NOT give them: an intraday curve.** The 1D line is two real dated figures
about a day apart, and the line between them is straight because we hold no prices in between
— `token_info` carries one price per token, fetched once. A chart meant to show movement
*through* the day needs a moving price feed, which is a data-source decision rather than a
code change. What they now get is a correct one-day line and a current total, instead of a
blank panel.

Three of the seven were defects of ours that their report is what surfaced: the `drawable`
arithmetic in #4, the unroutable display handle in #8, and the windowed `now` in #7.

---

## Appendix A2 · Found while verifying the routes against GMGN traders (2026-09-09)

Three defects surfaced only once the directory tripled. All three are fixed and deployed.

| What | Symptom | Cause | Fix |
| --- | --- | --- | --- |
| **`holdings_current` was 21× too slow** | `/tokens` took 33-39s, `/chains` 27s, a bare `count(*)` 7.4s | the view's anti-join referenced a **CTE**, which has no indexes, so the planner re-scanned 2,918 fomo rows for each of ~27,000 chain rows | anti-join now references `holdings` itself, whose primary key already begins `(handle, network_id)`. Same rows, **345ms** |
| **`/health` sequential-scanned 666,895 rows** | 13-38s, and it hit the 2min statement timeout once | `count(*) from transactions` on the endpoint whose whole job is a fast liveness answer | the planner's row estimate, reported under the same key and listed in a new **`estimatedRows`** field so it is never mistaken for a counted figure |
| **163 traders had a blank `display_handle`** | `/v1/traders/:handle` answered 200 with `handle: ""` | GMGN returns `twitter_username: ""` — not null — and `??` only catches null | empty strings normalised to null on the way in; the 163 rows repaired |

The first two were latent before the cohort grew: correct at 144 traders, unusable at 435.
The third shipped with the GMGN loader and is mine.

---

## Appendix A · What the bug report found, and what changed

All ten items in `FOMO_API_BUG_REPORT.md` are fixed and verified live. Tracked in
[DEBUGGING_PLAN.md](DEBUGGING_PLAN.md); recorded here because several of them changed a field
documented above, and a reader comparing against an older response needs to know why it moved.

| ID | What was wrong | What it is now | Where |
| --- | --- | --- | --- |
| **BUG-1** | `returnPct` wrong by ~10^17 whenever non-null | Cost basis derived as `pnl x entry / (exit − entry)`; `ether_monk` went from 877,995,983,169,868,200 to **74.67** | §1 T3 |
| **BUG-2** | `/trust` called ranks 1–3 "implausible" | Verdict renamed **`self_contradictory`** — it is fomo's own figures contradicting each other, not a judgement on the trader. `pnl_exceeds_holdings` now gated on ≥50% price coverage; a `basis` block names every denominator | §4 |
| **BUG-3** | `?limit=abc` returned 200 and the full list | Shared `intParam()`; a parameter that cannot be parsed is a **400** naming it. An ignored filter returns *more* rows than asked for and looks like data | §0c |
| **ISSUE-4** | "average entry" was the **first** entry | `avgEntryPrice` is a genuine quantity-weighted average; `entryMethod` says which computation ran. A fomo "trade" is a position, so renaming to `firstEntryPrice` would have mislabelled 96.9% of rows to fix 3.1% | §3 |
| **ISSUE-5** | Per-chain realized profit carried no tier | `realized` carries `tier`, `source` and a note that it is independent of that chain's price coverage | §6 |
| **ISSUE-6** | Momentum asserted a buy it could not see | `isNew` rows now say *"first seen in this snapshot"* rather than *"43 leaders opened a position"* | §5 |
| **ISSUE-7** | No rate-limit headers; a `401` that could not occur | `RateLimit-Limit/Remaining/Reset/Scope` on every response including the 429. The limiter itself was broken — a per-isolate `Map` that never bound — and now lives in Postgres | §0a |
| **ISSUE-8** | ~2s per call, no bulk route | `?include=pnl,scorecard,wallets,trust` — 137 traders in one call, replacing 548 | §0 |
| **ISSUE-9** | `detail` duplicated at two depths | Top-level keys are `['error']` alone | §0a |
| **DOC-10** | Every number in the doc was stale | Regenerated against live, with a `Generated` stamp and an explicit statement that figures are dated examples | this file |

**Three of these changed a published value**, so a consumer holding an older response will see
a difference:

- `returnPct` (BUG-1) — was wrong by ~15 orders of magnitude
- `trust.verdict` (BUG-2) — `implausible` → `self_contradictory`, and `unverifiable` added
- `avgEntryPrice` (ISSUE-4) — moved on 319 of 10,918 positions; `firstEntryPrice` carries the
  old value so the two can be reconciled

**Two bugs the report itself got wrong**, recorded because the corrected diagnosis is the one
that matters: BUG-1's stated cause (a unit error) and expected sign were both incorrect — the
real cause was `amount` being the *remaining* quantity on a closed trade, which is nothing.
And BUG-2 claimed `pnl_exceeds_volume` used our stored volume; it uses fomo's own, which is
why that flag was kept while the holdings-based one was gated.

---

## Appendix C · What the plugin team asked for

Requirements dated 9 September 2026. **Eight of eight shipped**; the ninth is a schedule
rather than a build.

| § | Asked for | Shipped as |
| --- | --- | --- |
| **§1** | a stable id that is never reused and never derived from the handle; `:id` on every per-trader route | `id` on the directory and the wallets block in one spelling, accepted in place of `:handle` on **all ten** per-trader routes, plus `handleChangedAt`. The `trd_` prefix remains accepted as input. **§0e** |
| **§2** | wallets with a `family` and the chains each is present on | `family` (`solana`/`evm`) and `chains[]` with `tradesSeen` and `lastActiveAt`, observed rather than inferred. **§0e** |
| **§3** | balances read from the chain; every position carrying `priceUsd`, `priceSource`, `pricedAt`, `valueUsd`, `balanceAt`, `whyNoPrice`, and `coverage` | all present on `/positions` and the batch route. Balances come from `getTokenAccountsByOwner` and batched `balanceOf`; **36,506 positions across five chains**, 367 traders served from chain reads. **§2** |
| **§4** | every swap, both sides, valued from the money side, with a stated cap | `GET /traders/:id/trades` — `side`, `token`, `money`, `valueUsd` with `valueSource: "money_side"`, `priceUsd` as a cross-check, `?chain=`/`?since=`, `limit` and `capped` stated. **§10** |
| **§5** | a `measurements` block for every trader, one stated definition, each figure with `basis`, `window`, `coverage`, `asOf` | on every scorecard. **99.08%** of traders carry a usable rhythm figure, reported on `/health`. **§3** |
| **§6** | loud failures, `asOf` on every figure, `/health` freshness, stable error codes, stated caps | `include_unavailable` (503) rather than a 200 with a missing block; `requestId` in the body and the `x-request-id` header; per-feed `lastRefreshAt` on `/health`; stable codes with no internal text; every route bounded, answering `code: "timeout"` rather than hanging; pool pressure answers `429` with `Retry-After`. **§0a** |
| **§7** | AUM per trader per chain over 30 days, `chains[]` per point, coverage windows | `GET /traders/:id/aum` live, `chains[]` on the response, `coverage` and `trackedSince` on every point, `sum(chains) == now.totalUsd`. `?chain=` narrows the series to one chain. **Thirty days of history on all five chains** — 32,160 reconstructed points, each proved against the wallet before it was stored. `reach` states the covered span, `drawing.drawable` is the service's own call on whether it can be plotted, `status` distinguishes ready from warming, `coverage` counts answered wallets and chains, and `gaps[]` names every hole. **§9** — the daily sampler fills the window forward from `trackedSince` |
| **§8** | batch reads for the whole directory in a bounded number of calls, with cost stated | `POST /traders/positions` and `POST /traders/aum`, 50 per call, `limit`/`asked`/`capped` on every response, `X-Cost-Units` reporting the traders asked for. `contractVersion: 2` adds `ok`/`requested`/canonical `id` per row and the complete AUM object, deep-equal to the individual route on all four windows. **§11** |

### The one thing still on the clock

**§7's thirty-day window fills by sampling forward.** Each point is a balance read at that
moment, so a thirty-day series is thirty days of readings — the route serves whatever exists
from day one and the window deepens on its own. `trackedSince` and `count` tell a consumer
exactly how much history is behind the line they are drawing.

---

## Appendix B · Where each figure comes from

Every number in this document is one of three things, and the response always says which.

| `tier` | Meaning | Examples |
| --- | --- | --- |
| `reported` | fomo said so. We pass it on and, in §4, test it against itself | `reported.pnl`, `reported.volume`, per-chain `realized` |
| `verified` | We counted it ourselves from data we ingested | `onChain.*` (G2), transfer counts, `costUsd` (G6) |
| `third_party` | GMGN's, fetched nightly and cached | `fundamentals` (G7), `chainConcentration` (G8), `walletTags` (G9), `creator` (G10) |

Anything without a `tier` is computed by us from stored rows — the parameter series (T·K·C),
`leaderConcentration` (G3), and position timing (G1).

**Nothing is blended.** Where ours and a third party's answer the same question, both are
returned under different names — `leaderConcentration` beside `chainConcentration`,
`totalValueUsd` beside `estimatedValueUsd` — because their denominators differ and a merged
figure would hide that.
