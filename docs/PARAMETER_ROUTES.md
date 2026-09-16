# genie-fomo API — complete reference

**Generated: 2026-09-09T09:20Z** · **Updated 2026-09-14** — the directory carries
GMGN-sourced traders alongside fomo's (§0d); the **stable id works on every per-trader route**
and wallets name their **chains** (§0e); balances are **read from the chain** and the asset
list **pages** (§2); the **balance series reaches thirty days back on all five chains**, with
the service's own `reach` and `drawing` verdict (§9); and the batch routes answer with
**identity-safe rows carrying the complete AUM object** under `contractVersion: 2`, and a
`chain` of their own (§11). A day is now stated from the chains that answered rather than
refused whole, which took traders who can draw a line from 96 to 372 at the time and
**408 of 448** today — see Appendix A3.

**The version 8 report is answered in full — all nineteen asks (Appendices A4–A8).** Every
route now dates itself with `asOf` and `/health` says which feed has stopped (§0f); `now` is
the most complete recent reading rather than the newest, and `breaks[]` marks every seam a
percentage must not cross (§9); every trader carries `knownChains[]`, a cost basis on each
position (§2), fees read from chain per trade and per window, realised profit by month, the
individual buys behind each coin's average, and a reason in four named codes beside every null
(§3).

Everything the API answers, in one document: the **35 PARAMETERS.md parameters**, the **12
GMGN-parity features** built on top of them, and the corrections from the bug report and the
version 8 report. One row per thing you can ask — what it means in plain words, the exact call,
and the field to read.

| | |
| --- | --- |
| Parameters (T·K·C series) | **35**, all live |
| GMGN-parity features (G series) | **12 of 12** — G1–G12, complete |
| Reported bugs and issues | **10 of 10 fixed** — see Appendix A |
| Version 8 report | **19 of 19 answered** — see Appendices A4–A8 |
| Plugin requirements (§ series) | **8 of 8 shipped** — see Appendix C |
| Routes | **19** — 17 `GET`, 2 `POST` batch, plus bulk `?include=` |
| Traders in the directory | **448** — 157 from fomo, **291 from GMGN** |
| Positions | **39,961**, read from chain across **5 chains**, for **379** traders |
| Balance history | **35,271 rebuilt chain points** over 30 days · **388 of 448** traders · **408** carry two or more dated figures that price enough of the wallet to draw |

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
curl -s "$B/traders?limit=500" | jq '.entries | length'   # 448
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
| **0f** | [How old is this answer](#0f-how-old-is-this-answer) | `asOf` everywhere, and feeds that say they stopped |
| **1** | [Trader — money](#1-trader-money) | T1–T10 |
| **2** | [Trader — positions](#2-trader-positions) | T11–T15 |
| **2b** | [Position timing (G1)](#2b-position-timing-g1) | **G1** |
| **2c** | [Live holdings between reads, and net flow](#2c-live-holdings-between-reads-and-net-flow) | workflow gap 4: `amountLive`, `/flow` |
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
| **12** | [Events feed](#12-events-feed) | transfers, swaps and readings, one cursor |
| **13** | [Market regime](#13-market-regime) | the cohort's week, one word, published thresholds |
| **C** | [What the plugin team asked for](#appendix-c-what-the-plugin-team-asked-for) | § by §, and where each landed |
| **A4** | [The version 8 report, and what changed](#appendix-a4-the-version-8-report-and-what-changed-2026-09-14) | freshness, `now`, and the seam |
| **A5** | [The version 8 report, the rest of the asks](#appendix-a5-the-version-8-report-the-rest-of-the-asks-2026-09-14) | ten more, measured |
| **A6** | [Cost basis, reasons, and paired trades](#appendix-a6-cost-basis-reasons-and-paired-trades-2026-09-14) | the last code-only three |
| **A7** | [Fees, read from chain](#appendix-a7-fees-read-from-chain-2026-09-14) | the fee gap, closed |
| **A8** | [The buys themselves, and version 8 closed](#appendix-a8-the-buys-themselves-and-version-8-closed-2026-09-14) | 19 of 19 |
| **A9** | [The version 9 report — A1, A2, A3 re-tested](#appendix-a9-the-version-9-report-a1-a2-a3-re-tested-2026-09-15) | measured on all 448 |
| **A10** | [Trades on four chains, and a directory that refreshes](#appendix-a10-trades-on-four-chains-and-a-directory-that-refreshes-2026-09-15) | two selectors, one decoder |
| **A11** | [Fees, swaps and entry prices](#appendix-a11-fees-swaps-and-entry-prices-2026-09-16) | the last three, with coverage |
| **A** | [What the bug report found, and what changed](#appendix-a-what-the-bug-report-found-and-what-changed) | all 10 fixes |
| **B** | [Where each figure comes from](#appendix-b-where-each-figure-comes-from) | `reported` / `verified` / `third_party` |
---

## 0. Routes that are not a single parameter

| Route | In plain words | Live value |
| --- | --- | --- |
| `GET $B/health` | "What's in the database, and when was it loaded?" | **448 traders** · 39,961 holdings · 51,581 trades · ~1.00M transfers |
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

**Every entry says which directory it came from.**

```bash
curl -s "$B/traders?limit=500" | jq '[.entries[].source] | group_by(.) | map({(.[0]): length}) | add'
# { "fomoapi.io": 157, "gmgn": 291 }
```

`source` is on the directory, on `GET /traders/:id` and on `/wallets`. It matters because the
two sources fail in **opposite directions**, and a profile built to one contract looks rich on
some traders and threadbare on others with nothing in the answer to explain why:

| source | traders | mostly | entry prices | resolved trades | fees |
| --- | --- | --- | --- | --- | --- |
| `fomoapi.io` | 157 | **Solana** (142 of 157) | thin | 121 of 157 | 146 of 157 |
| `gmgn` | 291 | **EVM** (255 of 291) | rich | **50 of 291** | 216 of 291 |

Until now the only tell was that `rank` and `followers` came back null — an inference, not a
field.

**Every trader in the directory carries its figures.** `pnl`, `volume`, `numTrades` and
`updatedAt` are present on **448 of 448**.

```bash
curl -s "$B/traders?limit=500" | jq '[.entries[] | select(.volume == null)] | length'
# 0
```

Two loaders write the stats behind these fields and they do not run together — one covers 100
traders, the other 291. The directory used to publish whichever load ran most recently as
"current" for everybody, so every trader belonging to the other loader had all four fields
null while their figures sat in the store unchanged. The figures are now taken per trader.

**`updatedAt` therefore varies between entries**, and that is the point: it is that trader's
own freshness rather than a date borrowed from a trader you are not looking at.

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

### `/fields` — the published vocabulary, and the constants the rules apply

```bash
curl -s "$B/fields" | jq '{version, closed, constants}'
curl -s "$B/fields" | jq '.fields["aum.points[].refused"]'
```

```json
{ "version": 4, "closed": true,
  "constants": { "pricedFloor": 0.25, "partialServeFloorUsd": 100, "drawableMinPoints": 2 } }
```

**`fields` is every word any route can emit, and `version` moves when a word is added.** The
consumer's build fails on a word it has no sentence for, so a word is published here before
any route says it. Version 4 (17 Sep 2026) added the words the pre-migration fixes emit:
`price_suspect`, `no_tokens_known`, `rebuilt_only`, `never_read`, `closed_by_balance`,
`indexer_coverage_low`, `unsellable_positions`, and the `stepChosenFrom`, `reliability`,
`resolvedBy`, `loadOutcome`, `nextLoadBasis` and `openPositionsBasis` lists.

**`constants` is the thresholds, so a refusal can be explained without reading this file.**

| `constants.*` | Used by |
| --- | --- |
| `pricedFloor` (0.25) | the count share of priced positions below which an `/aum` reading is partial or refused — §9 |
| `partialServeFloorUsd` (100) | a reading under the floor is **served** `partial` at or above this figure, refused `too_little_priced` below it |
| `drawableMinPoints` (2) | dated figures an `/aum` series needs before `drawing.drawable` is true |

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

### Linked wallets (gap 5b, W-J) — added 17 Sep 2026

`/wallets` also carries `linked: [{ chain, address, linkedFrom, kind, firstSeenAt, evidenceTx, watch }]`
— wallets the trader funded from his known Solana wallet, found nightly by
`scripts/link_wallets.mjs` from native SOL transfers out to an address that is not tracked,
not a known program or exchange, and has since been used (a second transfer, or ≥ 0.05 SOL).
`kind` is `funded_by` today; `submitted` is reserved. `evidenceTx` is the funding signature.
`watch: true` rows are registered with the Helius webhook alongside `wallets`, so their
transfers land in `transactions` like a primary wallet's. `[]` when nothing has been linked.

```bash
curl -s "$B/traders/unipcs/wallets" | jq '.linked'
```

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

**A leading `@` is accepted.** `@unipcs` and `unipcs` resolve to the same trader, because that
is how a handle is written in prose and a consumer should not have to strip it.

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

**`resolvedBy` says how each address was found; `fingerprintMatches` says no count is stored.**

```bash
curl -s "$B/traders/unipcs/wallets" | jq '{resolvedBy, fingerprintMatches}'
# { "resolvedBy": { "evm": "fomoapi", "solana": "fomoapi" }, "fingerprintMatches": null }
```

| `resolvedBy.{evm,solana}` | The address came from |
| --- | --- |
| `fomoapi` | the fomoapi.io directory, as the trader's listed wallet |
| `gmgn` | the GMGN directory |
| `submitted` | `POST /traders/:handle/wallets` |
| `null` | no address of that family on record |

`fingerprintMatches` is always `null`: the service does not store a fingerprint count, and a
number invented here would read as one. It is on the response so the absence is explicit.

---

## 0f. How old is this answer

Nothing in this API is live. Every figure was read at some moment by some job, and the jobs run
on different schedules — balances nightly, trades less often, the directory on its own build.
Two panels on one screen can be days apart while both look current.

So **every route carries `asOf`**, and the ones that depend on a job running carry the job's
state as well.

### `asOf` on every route

```bash
curl -s "$B/traders/unipcs/aum?window=1w" | jq .asOf
curl -s "$B/traders/unipcs/portfolio"     | jq .asOf
curl -s "$B/traders/unipcs/trades"        | jq .asOf
curl -s -X POST "$B/traders/aum" -H 'content-type: application/json' \
  -d '{"contractVersion":2,"ids":["unipcs"],"window":"1w"}' | jq .asOf
```

| Route | What its `asOf` is the moment of |
| --- | --- |
| `/traders/:id` | the directory build this trader's row came from (same value as `updatedAt`) |
| `/traders/:id/aum` | the reading `now` is taken from |
| `/traders/:id/portfolio`, `/positions` | when the balances were read |
| `/traders/:id/scorecard`, `/pnl` | when the trades behind it were loaded |
| `/traders/:id/trades` | the newest trade on the page, under the filters asked for |
| `/traders/:id/transactions` | the newest transfer stored |
| `/traders/:id/wallets` | when the wallet record was last confirmed |
| `/traders/:id/trust` | the holdings capture the checks ran against |
| `/tokens`, `/tokens/:address`, `/tokens/momentum` | the snapshot behind the figures |
| `POST /traders/aum`, `POST /traders/positions` | the newest reading anywhere in the batch |

A batch answer dates itself once, at the top, next to `limit` and `asked`. Each trader still
carries his own `now.at`, which is the one to use when they differ.

### The balance series says whether the sampler is still running

A date is not a verdict. `asOf` tells you when the reading was taken; `sampler` tells you
whether more are coming.

```bash
curl -s "$B/traders/unipcs/aum?window=1w" | jq '{status, asOf, now: .now.ageSeconds, sampler}'
```

```json
{
  "status": "ready",
  "asOf": "2026-09-14T04:00:00.000Z",
  "now": 5485,
  "sampler": {
    "state": "current",
    "lastAttemptAt": null,
    "lastSuccessAt": "2026-09-14T04:28:37.000Z",
    "nextExpectedAt": "2026-09-14T06:00:00.000Z",
    "ageSeconds": 3768,
    "staleAfterHours": 36,
    "reason": null
  }
}
```

| `sampler.state` | What it means |
| --- | --- |
| `current` | **this trader's own** newest reading is inside `staleAfterHours` |
| `stale` | past that allowance. The points are still true, they are simply old, and `reason` says how old |
| `warming` | no measured reading yet for this trader |
| `never_read` | the sampler has never covered this trader at all — no reading row, accepted or refused. `status` is `no_reading`; `reason` says so |

**The state is the trader's, not the pipeline's.** It used to be computed from the newest
successful run anywhere in the table — so on a night the sampler ran for most of the directory,
a trader whose own newest reading was 6.8 days old still answered `current`, and `status` still
said `ready`. Fourteen traders were measured in exactly that state.

**Both clocks are reported, because they answer different questions:**

| field | question |
| --- | --- |
| `lastSuccessAt`, `ageSeconds`, `state` | how old is **this trader's** reading — what `status` is judged on |
| `pipelineLastSuccessAt`, `pipelineAgeSeconds` | when did the **job** last write anything |

A fresh `pipelineLastSuccessAt` beside a `stale` state means the sampler ran and did not reach
this trader — a different problem from the sampler having stopped, and a different fix.

**The allowance is 36 hours and it is on the response**, not buried in a doc: the sampler runs
daily, so one run plus a fully missed one is still on schedule, and anything past that is not.

**`status` tells the truth when the sampler falls behind.** A series whose readings have gone
stale answers `status: "stale"`, not `ready`. `ready` never describes a two-day-old figure.

**`now.ageSeconds`** is the age of the chosen reading in seconds, so a caller can print "as of
Thursday" without parsing a date.

**`lastAttemptAt` is `null` on purpose.** We record successes, not attempts. Inventing a value
would be worse than admitting the gap.

### `/health` says which feed stopped

```bash
curl -s "$B/health" | jq '{dataState, staleFeeds, feeds}'
```

```json
{
  "dataState": "current",
  "staleFeeds": [],
  "feeds": {
    "traders":      { "lastRefreshAt": "…", "ageSeconds": 3600,   "staleAfterHours": 36,  "state": "current" },
    "trades":       { "lastRefreshAt": "…", "ageSeconds": 410000, "staleAfterHours": 72,  "state": "stale" },
    "wallets":      { "…": "…" },
    "positions":    { "…": "…" },
    "transactions": { "…": "…" },
    "tokenInfo":    { "…": "…" },
    "aum":          { "lastSuccessAt": "…", "newestReadingAt": "…", "rowCount": 0, "traders": 0 }
  }
}
```

**Each feed carries its own allowance and the verdict that follows from it**, so one call
answers "has anything stopped arriving" without subtracting seven dates from the clock.
`state` is `current`, `stale`, or `never` — and `never` is not `stale`, because a feed that has
never run has a different cause and a different fix.

**`staleFeeds` names them**, and `dataState` is `current` or `degraded`.

**A feed is stale when its clock is old *or* any trader is past that feed's own allowance.**
The `trades` clock moves whenever anyone loads, so sixteen traders sat 221 hours old under
`dataState: current`. `staleFeeds` now carries `scorecards` whenever `staleTraders.scorecardStale`
is above zero, and `dataState` reads `degraded` while it does.

**`staleTraders` counts the traders themselves, which no feed clock can express.**

```json
{ "readingStale": 14, "readingStaleAfterHours": 36, "noReading": 14,
  "oldestReadingHours": 177,
  "scorecardStale": 175, "scorecardStaleAfterHours": 72, "scorecardLoadFailed": 9,
  "oldestScorecardHours": 189,
  "of": 448 }
```

**`noReading` counts traders with no *accepted* reading.** A refused reading is not a reading
here; a trader whose every row is refused is counted as having none. **`scorecardLoadFailed`**
is, of the stale, how many the loader last asked fomoapi about and did not get back — the same
`loadOutcome` each scorecard carries (§1), counted.

A feed reports when its job last wrote *anything*. A trader the job did not reach keeps his old
figures and moves no feed — so `feeds` can read `current` across the board, `dataState` can say
`current`, and 368 traders can still be carrying week-old scorecards. That is exactly the state
above, and it is why these counts are published: they are what either team would watch to notice
a reload has stopped landing, without hand-checking traders one at a time.

**`status` stays `ok` while the service answers.** It has always meant liveness and consumers
check it for that. Whether the *data* is still arriving is the separate question `dataState`
answers.

**`aum` reports three moments, and its `state` follows the first.** `lastRefreshAt` is the
newest **accepted** reading, and `state` is judged on it; `newestReadingAt` is the newest
reading's own timestamp, accepted or not; `samplerLastRunAt` is when the sampler last wrote
anything. A sampler that runs every five minutes and refuses everything it reads moves only the
third, so the feed reads `stale` rather than `current`.

**`aum` also counts coverage per chain**, so "BSC stopped answering on the 14th" is visible
without a sweep:

```bash
curl -s "$B/health" | jq '.feeds.aum | {historyState, chains}'
```

```json
{ "historyState": { "ready": 610, "warming": 41, "none": 120 },
  "chains": {
    "bsc": { "accepted36h": 176, "failed24h": 12, "newestAcceptedAt": "…",
             "historyState": { "ready": 181, "warming": 9, "none": 56 } } } }
```

`historyState` is `knownChains[].historyState` (§9) summed over every trader-chain, at the
top for the whole roster and inside each chain. `accepted36h` is chain rows carrying a figure;
`failed24h` is chain rows carrying a reason.

**`traders` is the directory build.** It used to be filled from the trade loader's clock — two
different jobs under one name — so a five-day-old trade load read as a five-day-old directory
while the loader had no entry of its own. `trades` is now its own feed.

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

**`openPositions` counts trade records; `openPositionsHeld` counts the ones the wallet still
holds.** The two used to be one number, and it was ten times the `/positions` list for 104
traders: fomo calls a trade open until it sees a sell, and a coin that left by transfer never
gets one. Both are on `/pnl` and on `?include=pnl`, with `openPositionsBasis` naming each:

```bash
curl -s "$B/traders/unipcs/pnl" | jq '{openPositions, openPositionsHeld, openPositionsBasis}'
# { "openPositions": 320, "openPositionsHeld": 97,
#   "openPositionsBasis": { "openPositions": "trade_records",
#                           "openPositionsHeld": "trade_records_still_held_on_chain" } }
```

A trade whose token a chain read no longer holds is stored as `status: closed_by_balance`. It
is never counted as open and never as a realised close — there was no sell to value — so
`closedTrades`, `winRate` and the realised figures do not move when it is marked.

**The scorecard says when the loader last *tried*, not only when it last succeeded.** A trader
whose fomoapi fetch fails was reselected every night and never written, so `loadedAt` aged for
nine days with nothing on the response to say the loader had been asking:

```bash
curl -s "$B/traders/smokey0x/scorecard" | jq '.sample | {loadedAt, loadAttemptedAt, loadOutcome, nextLoadAt, nextLoadBasis}'
```

| field | |
| --- | --- |
| `loadAttemptedAt` | the last fomoapi fetch for this trader, whatever it returned; `null` when never attempted |
| `loadOutcome` | `loaded` · `unavailable` · `degraded` · `not_found` · `error` — what that fetch came back with |
| `nextLoadBasis` | `nightly_slot`: `nextLoadAt` is the next 06:00 UTC run, not a per-trader schedule. A 6-hourly retry pass also picks up traders past their own `staleAfterHours` |

`staleTraders.scorecardLoadFailed` on `/health` is the roster-wide count of the same thing.

**When fomoapi is behind, `onChain` is the scorecard we can still stand behind (T3, bounded).**
The top-level figures come only from the trade load, so a trader stuck since 7 Sep carried a
stale `winRate` with nothing to draw in its place. `onChain` is the same handful of figures —
`swaps`, `buys`, `sells`, `volumeUsd`, `realizedPnlUsd`, `winRate`, `wins`, `losses` — from the
wallet's own resolved swaps (`basis: wallet_swaps`, the rows `/trades` serves), each sell paired
against the token's average buy cost exactly as `perExit` does. `coverage` is resolved swaps over
the swap-shaped transactions we hold, so a low share reads as "we resolved little", not "he
traded little". `staleness.fallback` says which block to draw: `on_chain` when the record is
`stale` or `never` and `onChain.swaps > 0`, else `null`. Figures are `null`, never `0`, when no
swap resolved. Computed on the single-trader route only; `?include=scorecard` carries
`onChain: null` and `onChainNote`, so the page does not slow down.

```bash
curl -s "$B/traders/smokey0x/scorecard?tokens=0" | jq '{fallback: .staleness.fallback, onChain}'
```

**Composite badges read from the same call (17 Sep).** Each `byToken[]` row now carries its own
economics: `multipleRealized` (weighted exit ÷ weighted entry), `multipleCurrent`, `multiplePeak`
(sampled ATH since his first open, null before the hourly sampler reached the coin),
`realizedShare` (sold ÷ bought, 0..1), `betUsd`, `exitMcapUsd`, `currentMcapUsd`,
`peakMcapSinceEntryUsd`, `closedMonth` and `entryHoursAfterLaunch`. The scorecard adds
`medianWinUsd`, `medianLossUsd`, `bigWinMonths`, `typicalBetUsd.perCoinUsd`, a `recent` block
(`lastBigWinAt`, `closes4w`, `green4w`, `last20: { avgRealizedUsd, redShare }`, plus the
entry-mcap median, hold-hours median and pace over the last 20 closes), the same three under
`career`, `bleeding` with its floor in `bleedingBasis`, and `exitTimingScore` (share of closed
coins now priced below his exit; null under five). Null is "not known", never 0.

```bash
curl -s "$B/traders/unipcs/scorecard?tokens=3" | jq '{bleeding, bleedingBasis, exitTimingScore, recent, career,
  coins: [.byToken[] | {symbol, multipleRealized, multiplePeak, realizedShare, betUsd, closedMonth}]}'
```

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
98.7% of the money is in one of them. T15's `openPositions` is trade records, not holdings;
`openPositionsHeld` beside it is the count that matches T11 (§1).

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

### Each chain's dollars, said in that chain's own coin

```bash
curl -s "$B/traders/unipcs/portfolio" | jq '.byChain[] | {chain, valueUsd, nativeAmount, nativeSymbol, nativeUsd, nativePriceSource}'
```

| chain | `valueUsd` | `nativeAmount` | | `nativeUsd` | `nativePriceSource` |
| --- | --- | --- | --- | --- | --- |
| solana | $4,797,285.24 | **46,670.73879** | SOL | 102.79 | `token_prices_daily` |
| robinhood | $11,002,305.93 | **4,439.112504** | ETH | 2,478.49 | `gmgn_token_info` |
| bsc | $31,441.38 | `null` | BNB | `null` | — |
| ethereum | $18,505.32 | `null` | ETH | `null` | — |
| base | `null` | `null` | ETH | `null` | — |

**`nativeAmount` is `valueUsd / nativeUsd` and nothing more**, so the two always agree. The
rate and its source travel with it so the division can be rechecked.

**The chain's own coin is a position, and is priced.** Since 17 Sep the sampler reads
`eth_getBalance` beside `balanceOf`, so ETH and BNB appear on `entries[]` and on the batch
rows with `isNative: true`, under the sentinel address `0x0000000000000000000000000000000000000000`
(Solana's SOL under `11111111111111111111111111111111`), priced from the same Binance pairs
as the wrapped coin. Before that only SOL was read, and $241K of ETH across the roster was
counted nowhere.

**A chain with no market price for its coin answers `null`, and `whyNoNative` says why.** The
rate has to be a *market* price. Most of what we hold for a wrapped native is `fomo_reported_entry` — the price
a trader reported paying, not what the coin is worth now — and some rows carry a price with no
source at all. Neither can be stood behind: one chain's WETH rows range $1,885 to $2,931. A
portfolio converted at a number nobody can defend is a worse answer than no number.

### What he paid for what he holds — the cost basis

Their §7.4 asks for acquisition cost on every position. Every field is on `entries[]` and on
`POST /traders/positions`, from one shared function so the two cannot drift.

```bash
curl -s "$B/traders/unipcs/positions?limit=1" | jq '.entries[0] | {amount, priceUsd, costKnownAmount, avgCostPrice, costUsd, unrealizedUsd, costMethod, costCoverage, costAmountShare, costReason}'
```

```json
{ "amount": 10957904.674690466, "priceUsd": 0.7678352,
  "costKnownAmount": 10957904.674690466, "avgCostPrice": 0.00615984, "costUsd": 67498.92,
  "unrealizedUsd": 8346363.51,
  "costMethod": "weighted_open_positions",
  "costCoverage": { "share": 1 }, "costAmountShare": 1, "costReason": null }
```

`(0.7678352 − 0.00615984) × 10,957,904.67 = 8,346,363.51`. The figures reconcile by hand.

**A holding with no stored position is `null`, never `0`.** Coins arrive by transfer as well
as by purchase, and reading a transfer in as a free acquisition turns every airdrop into
infinite profit. Measured over one trader's 500 positions: **18 carry a cost, 482 do not, and
none report a cost of 0.** `costReason` tells the two causes apart —

| `costReason` | Count | Means |
| --- | --- | --- |
| *no stored position for this holding…* | 300 | it may have arrived as a transfer |
| *…open positions carry no entry price* | 182 | he bought it; what he paid was never recorded |

**`unrealizedUsd` is measured against `costKnownAmount`, not the whole holding.** Those differ
whenever some positions carry an entry price and others do not, and multiplying a partial cost
by a full quantity invents a number. `costAmountShare` says what fraction of the holding the
basis covers.

**`realizedUsd` is this coin's closed positions** — a different quantity from the one still
held, and labelled as such rather than blended in.

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
| `isNative` | `true` for the chain's own coin (ETH, BNB, SOL), read from the wallet balance rather than a token contract |
| `priceSuspect` | `true` when the price fails a sanity check; the row is listed but its value stays out of `totalValueUsd` |
| `priceSuspectReason` | `implied_mcap_over_ceiling` (price × total supply over $20B) · `concentration_over_ceiling` (one row over 90% of a total over $1B, or its supply unknown) · `null` |
| `isHoneypot` | GMGN's verdict on the coin, `null` where the chain is not assessed (§5a) |
| `canSell` | `false` when GMGN says the coin cannot be sold; `null` when never judged |

**A coin we cannot price is counted, never zeroed.** It appears in `positions` and in
`coverage.unpricedPositions`, and stays out of `totalValueUsd` — so the count of what someone
holds and the value of what we could measure are two separate, honest numbers.

**A coin that cannot be sold is counted, and valued, but not summed.** A confirmed honeypot
was counted at $58,631 on one trader's `/portfolio` while `/tokens` said `canSell: false`.
The flags now ride on the row, its priced value goes into `unsellableUsd` instead of
`totalValueUsd`, and the answer is marked `partial: true, partialReason: unsellable_positions`
on `/portfolio`, `/positions` and `POST /traders/positions` alike:

```bash
curl -s "$B/traders/Lasercat397/positions" | jq '{totalValueUsd, unsellableUsd, partial, partialReason}'
```

**`coverage.chains` says how much of a wallet's history the indexer has actually seen.** One
`eth_getTransactionCount` per sampled EVM chain gives the wallet's own transaction count; the
rows the indexer holds for it are counted beside it:

```bash
curl -s "$B/traders/gmgn_0xf1d07077/positions" | jq '.coverage.chains'
# { "bsc": { "chainTxCount": 1412, "rowsHeld": 63, "share": 0.0446, "readAt": "…" } }
```

`share` is `rowsHeld / chainTxCount`, `null` when either side is unknown. Any chain under 0.5
marks the list `partialReason: indexer_coverage_low`; with an unsellable coin as well the word
is `unsellable_positions_and_indexer_coverage_low`. On the batch route it is on
`contractVersion: 2` rows.

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

## 2c. Live holdings between reads, and net flow

Added 17 Sep 2026 for workflow gap 4 (`docs/consumer/workflow-coverage-17-sep.md`: W-F Rotation
Compass, W-A Genesis Scan). Balances are read from chain nightly; on Solana the Helius webhook
delivers every transfer in between. These routes roll the read forward from that feed at read
time. **No new writer, no new chain read.**

### `amountLive` on `/traders/:handle/positions`

| Field | Solana | EVM |
|---|---|---|
| `amount`, `valueUsd` | the nightly read, unchanged | the nightly read |
| `amountLive` | `amount` + Σ signed transfers (`in` +, `out` −) with `block_time > balanceAt` | `null` |
| `deltaSinceRead` | that sum (`0` when nothing moved) | `null` |
| `lastTransferAt` | newest transfer since the read, or `null` | `null` |
| `liveBasis` (top level) | `{ solana: "rolled_forward_from_transfers", evm: "nightly_read" }` | |

A position opened since the read (a mint the read did not hold) appears with `amount: 0`,
`balanceAt: null`, `tier: "rolled_forward"` and `amountLive` = the net inflow — but only once
the mint is in `tokens`; until then it is visible on `/flow` only.

**What it is not.** A roll-forward is only as complete as the webhook's coverage: a transfer
Helius did not deliver, a wallet not registered, a burn or rebase the feed does not carry, all
leave `amountLive` off by that much until the next nightly read replaces the base. `amount` and
`valueUsd` stay the read values; the app decides which to show. `valueUsd` is NOT re-priced
from `amountLive`.

SQL: view `holdings_live` (`supabase/migrations/20260917190000_holdings_live.sql`).

### `GET /traders/:handle/flow?since=<iso>` and `POST /traders/flow { ids, since }`

Net token flow per trader since a moment, from `transactions` — Solana only. `since` is required
(400 without it). One row per token that moved:

```json
{ "chain": "solana", "tokenAddress": "…", "tokenKey": "…", "in": 120.5, "out": 20,
  "net": 100.5, "transfers": 3, "firstAt": "…", "lastAt": "…" }
```

`tokenAddress` is `null` when the mint is not yet in the directory (the feed stores a lowercased
key; base58 is case-sensitive, so the key is served as `tokenKey`, not passed off as an
address). Envelope: `since` (normalised), `basis: "transactions"`, `chains: ["solana"]`. The
batch form takes up to 50 ids under the §11 rules and answers one `traders[]` entry per id,
`ok: false` with `not_found` for unknown ones.

This is the W-F "hourly holdings diff across the cohort" substrate: poll it hourly with `since`
= the previous poll. **A category / launchpad taxonomy for tokens is not in scope here** —
group by `tokenKey` yourself; the chain is the only taxonomy the directory holds.

---

## 3. Trader — time

| # | In plain words | Call | Read | Live value |
| --- | --- | --- | --- | --- |
| **T16** | "How long do they usually hold?" | `GET $B/traders/unipcs/scorecard` | `holdingTime`, `measurements.holdTimeDays` | **1.06 days** (25.4h), coverage **43/43 on both** |
| **T17** | "What did they pay to get in — **as a market cap**?" | same | `byToken[].avgEntryMarketCapUsd` + `totalSupply` | `frankdegods` · Stonks **$2,398,439 MC** from supply 1,000,000,000, `entryMethod: weighted` over 2 positions |
| **T18** | "Are they still active?" | same | `lastTradeAt` | **2026-09-07T11:22Z** |
| **T19** | "How long have they been trading?" | same | `trackRecordDays` | **108.4 days** |
| **T20** | "How busy are they?" | same | `tradesPerDay` | **3.35 trades/day** |

Unlike the price fields, **timestamps are populated on 100% of trades** — which is why all
of §3 is solid while §1 carries coverage caveats.

### Dollars in and dollars out, per coin

An average price cannot answer "how much a bet": two traders with the same average entry may
have staked a hundred dollars or a hundred thousand. Each `byToken` row carries both sums.

```bash
curl -s "$B/traders/turtletaverntv/scorecard" | jq '.byToken[0] | {symbol, costUsd, proceedsUsd, costCoverage, whyNoCostUsd}'
```

| symbol | `costUsd` | `proceedsUsd` | `costCoverage.share` |
| --- | --- | --- | --- |
| Basecat | $13,425.88 | $43,634.94 | 1 |
| ASTEROID | $58,125.30 | $75,836.26 | 1 |
| SESH | $7,797.60 | $18,339.30 | 1 |

**These are the same quantity-weighted sums that produced `avgEntryPrice`** — each position's
price times the quantity recovered for it — so they reconcile with it exactly rather than
being a second estimate of the same thing. `costQuantity` and `proceedsQuantity` carry the
quantity each was taken over, so the division can be rechecked.

**Null, never 0**, when no position in the coin carried a recoverable quantity, with
`whyNoCostUsd` naming which of the two reasons it was.

### Realised profit by month

`realizedByDay` covers thirty days. `realizedByMonth` covers the twelve completed calendar
months plus the one running, which is what a "worst month" reading needs.

```bash
curl -s "$B/traders/turtletaverntv/scorecard" | jq '.realizedByMonth[] | {month, realizedUsd, closedTrades, complete}'
```

```
2026-02   -1,769.08   16 trades
2026-05  -10,556.09   14 trades     <- worst month
2026-06   16,860.89   10 trades
2026-08   34,166.74   29 trades
2026-09    4,602.17  124 trades     complete: false
```

**`complete: false` marks the month still running**, so a part-month is never compared with
whole ones.

**A month with no closed trade is absent, not zero** — the same rule `realizedByDay` follows.

**The months do not sum to `windows.all` for a longer record, and `realizedByMonthBasis` says
by how much.** For the trader above, the months total $59,422.09 against an `all` of
$64,427.81; the difference is `beforeWindowUsd: 5005.73` — twenty closes that happened before
this window. Both figures are right, and the arithmetic is stated rather than left to be
discovered.

### Fees, and volume per window

**Nothing here is after fees, and the answer says so.** `includesFees: false` travels on every
realised window, and `fees` states the reason once:

```json
{ "includedInRealized": false, "paidUsd": null, "perTradeUsd": null, "source": null,
  "why": "no fee or gas figure is stored on any trade or transfer we hold." }
```

No fee or gas column exists on any trade or transfer in the store, so a fee figure would have
to be invented. The profile's "made, after fees" cannot be answered from this data, and saying
that is the only correct answer available.

**Volume is now measured per window, not only reported for a lifetime.**

```bash
curl -s "$B/traders/unipcs/scorecard" | jq '.windows["30d"] | {realizedUsd, volumeUsd, volumeCoverage, includesFees}'
```

```json
{ "realizedUsd": -131120.08, "volumeUsd": 419969.75,
  "volumeCoverage": { "of": 3, "total": 43, "share": 0.0698 }, "includesFees": false }
```

The leaderboard gives one lifetime figure with nothing to slice it by, so "volume in the last
7 days" had no answer at all before. This counts **both legs** of each round trip — a round
trip trades twice — over the closed positions carrying an entry price, an exit price and a
recoverable quantity, with `volumeCoverage` saying how many that was. `volume.reportedLifetimeUsd`
keeps the leaderboard's number beside it; the two are different measurements and will not agree.

### Fees — what each trade cost to make

Nothing in this database could answer this before: no fee or gas column existed on any table,
and `transactions.raw` is empty on all 1,025,559 rows, so it was not recoverable from what was
already stored either. It is read from chain now — free, on the public RPC in `chains.rpc` for
the four Ethereum-style chains and the Helius key we already hold for Solana.

```bash
curl -s "$B/traders/unipcs/scorecard" | jq '.fees, (.windows["30d"] | {realizedUsd, feesUsd, feesCoverage})'
```

```json
{ "includedInRealized": false,
  "paidUsd": 1966.112168,
  "byWindowUsd": { "24h": 0.03, "7d": 77.54, "30d": 1960.408923, "all": 1966.112168 },
  "paidNative": [ { "symbol": "ETH", "amount": 0.789553423698, "chains": 3 },
                  { "symbol": "BNB", "amount": 0.0898807848313, "chains": 1 },
                  { "symbol": "SOL", "amount": 0.089601398, "chains": 1 } ],
  "coverage": { "of": 4, "total": 5, "share": 0.8 },
  "usdBasis": "native fee valued at the current native price, not the price when it was paid" }
```

**`includesFees` is still `false`, and that is the point.** Fees are now measured and still not
deducted. A consumer that wants "after fees" subtracts `paidUsd` itself; one that reads
`realizedUsd` is not silently handed a net figure where it expected a gross one. The flag is on
every window.

**`paidNative` is the measurement; `paidUsd` is derived.** A fee is paid once, in the chain's
own coin, at a moment. We hold no historical price for those coins, so the dollar figure applies
**today's** rate to a past payment — `usdBasis` says so. The native amount does not move.

**ETH is summed once, not three times.** It is the native coin of three of our five chains, and
`chains` says how many it was paid across.

**bsc contributes nothing to `paidUsd`, and `coverage` says 4 of 5.** There is no market price
for BNB anywhere in our store, so its fees are real, exact in `paidNative`, and deliberately not
converted. Adding zero for it would state that trading on bsc was free.

**Per trade, on `/trades`** — where a row genuinely *is* a transaction:

```json
{ "feeNative": 0.000029182, "feeNativeSymbol": "SOL", "feeUsd": 0.003,
  "feeUsdBasis": "native fee valued at the current native price, not the price when it was paid" }
```

A Solana fee is a fraction of a cent, so fee dollars carry six decimals. Rounding them to two
would print `0`, and no trade on any chain costs nothing.

**A stored position cannot carry a fee, and `perTradeWhy` says why.** The scorecard is built
from positions, which have no transaction hash — there is nothing to look up. Per-trade fees
live on `/trades`.

### Is this the whole record? — `sample`

```bash
curl -s "$B/traders/unipcs/scorecard" | jq .sample
```

```json
{ "returned": 363, "complete": true, "capped": false, "unit": "position",
  "positionsStored": 363, "reportedTrades": 4745,
  "reportedTradesSource": "leaderboard, lifetime, counted as fills",
  "loadedAt": "2026-09-05T04:30:29.000Z", "nextLoadAt": "2026-09-15T06:00:00.000Z" }
```

**`complete` answers one question: was anything left out of this response.** No cap is applied
— every stored position is used.

**363 against 4,745 is not a coverage gap.** We hold **positions**, already averaged across
the fills inside them; the leaderboard counts **fills**. `unit` and `reportedTradesSource` make
that visible instead of alarming.

**`loadedAt` and `nextLoadAt`** are the scorecard's half of the freshness contract — the same
question `sampler` answers for the balance series, asked of the store that feeds this route.

**`loadedAt` is the NEWEST row's capture, not the first one's.** A refreshed record keeps its
older rows, so taking whichever row came back first reported a load stamp ten days old on a
record refreshed that morning — one trader's rows span 4 September to 15 September. The field
that exists to report staleness was manufacturing it, while `asOf` beside it took the maximum
and disagreed. Both now take the maximum.

**`source` says which provider these rows came from, per trader.**

| `traderSource` | `source` |
| --- | --- |
| `fomoapi.io` | `postgres · trades (loaded from fomoapi)` |
| `gmgn` | `postgres · trades (folded from GMGN wallet activity)` |

It used to say fomoapi for everybody, including the 291 traders whose trades are folded from
GMGN's activity feed. A consumer reading it to judge how far to trust a figure was told the
wrong provider for two thirds of the directory — and the two behave differently, which is the
whole reason to ask.

### Where an entry price comes from — `entryPriceSource`

A per-coin entry price has two possible origins, and the row says which it used:

| `entryPriceSource` | means |
| --- | --- |
| `reported` | the directory supplied it |
| `chain` | derived from this wallet's own resolved buys, because the directory supplied none |
| `null` | neither had it — `fieldReasons.avgEntryPrice` says `historical_input_missing` |

**The fallback only fires where a resolved buy exists for that coin**, and it must be a buy whose
money leg carries a dollar value — a swap paid for in a coin we cannot price resolves fine and
still yields no entry price.

That is why the second row can read zero on a trader with hundreds of resolved buys: his buys and
his unpriced coins are different coins. One trader measured 262 coins, 71 priced by the
directory, 191 not — and exactly **1** of those 191 had a valued chain buy. The fallback was
built and had nothing to work with.

**It fills as swaps resolve.** Of that same trader's 191 unpriced coins, **155 appear in
transactions we hold and have not yet resolved**; for another, 190 of 424. Those are reachable.
The rest are not, and no amount of resolving reaches them — `fieldReasons` says so rather than
implying a pending job.

### Rug Dodger and Cabal Trader — `byToken[].exitedBeforeFlag`, `coHolders`

Added 17 Sep 2026 (C3). Each coin carries `isHoneypotNow` (latest GMGN read, `null` where the
chain is not assessed), `honeypotSince` (first nightly read that flagged it, never cleared) and
`exitedBeforeFlag`: `true` when his `lastClosedAt` precedes `honeypotSince`, `false` when he
closed after it or still holds, `null` when the coin was never flagged. `coHolders` is the number
of OTHER tracked traders with a trade in the same coin on the same chain, from one grouped pass
over `trades`; `0` means he was alone. Linked-wallet collapsing is published on
`/tokens/:address.cohort`, not per coin here.

### The buys themselves — `byToken[].buys[]`

`avgEntryPrice` is one number per coin, and fomoapi hands it to us **already averaged** across
the fills inside a position. An average cannot be un-averaged: five buys at five prices arrive
as one figure. A question about buys has to count buys.

```bash
curl -s "$B/traders/unipcs/scorecard" | jq '[.byToken[] | select(.buysTotal > 0)][0] | {symbol, buysTotal, buys: .buys[0:3]}'
```

```json
{ "symbol": "USELESS", "buysTotal": 8,
  "buys": [
    { "at": "2026-07-25T20:11:12Z", "txHash": "…", "amount": 63637.547083,
      "costUsd": 3360.2, "priceUsd": 0.0528021671485, "marketCapUsd": 52753797.6 },
    { "at": "2026-07-27T14:30:29Z", "txHash": "…", "amount": 2032.663698,
      "costUsd": 122.23, "priceUsd": 0.060133316751, "marketCapUsd": 60078231.49 }
  ] }
```

**`marketCapUsd` is the figure a size band is drawn from** — that buy's price times the supply
we hold, so "how big was the coin when he bought it" is answerable per buy rather than per coin.
Null, never 0, wherever either input is.

**Read `buysCoverage` before counting anything.**

```json
{ "buys": 398, "coinsWithBuys": 25, "coinsTotal": 104, "share": 0.2404,
  "basis": "individual buys resolved from chain swaps. Solana throughout; the four
            Ethereum-style chains only where a transaction shows this wallet both sending and
            receiving a token, which is what a trade the wallet made looks like" }
```

**The buys we hold are not a random sample of a trader's buying.** They are the ones on chains
whose swaps resolve — 2,070 individual priced buys across 139 wallets, heavily Solana. A
percentile computed over them and printed as a fact about the trader is exactly the failure this
document exists to prevent. With coverage stated, the bands are real:

| entry market cap | buys | share |
| --- | --- | --- |
| under $100K | 2 | 0.5% |
| $100K – $1M | 38 | 9.5% |
| $1M – $10M | 193 | 48.5% |
| over $10M | 165 | 41.5% |

**Capped at 100 per coin**, with `buysTotal` stating the real count, so one heavily traded coin
cannot dominate a response. `buysTotal: 0` means we hold no individual buys for that coin — not
that none were made — and `fieldReasons.buys` says `source_unavailable` there.

**Why the EVM chains contribute little.** A wallet's own trade is a transaction where it both
sends and receives a token. Measured on a random sample of 100 bsc transactions: 74% contain no
swap at all, 25% contain a swap in which our wallet is **one-sided** — a counterparty inside
someone else's trade — and 1% are the wallet's own two-sided swap. Only the last kind is
resolved. Counting the 25% would have manufactured hundreds of fills at prices the trader never
paid.

### A reason beside every empty field — `fieldReasons`

A null says a figure is absent and nothing about why, and the causes want different responses
from a screen. Four codes, per coin and per answer:

| code | means |
| --- | --- |
| `not_applicable` | the question does not arise — nothing has closed yet |
| `not_yet_calculated` | a job has not produced it; it may appear later |
| `source_unavailable` | no source we hold carries it |
| `historical_input_missing` | the inputs existed once and were not recorded |

```bash
curl -s "$B/traders/unipcs/scorecard" | jq '.fieldReasons, [.byToken[].fieldReasons][0]'
```

Measured across one trader's 317 coins:

| field | count | reason |
| --- | --- | --- |
| `avgEntryPrice` | 293 | `historical_input_missing` |
| `avgEntryMarketCapUsd` | 293 | `historical_input_missing` |
| `avgExitPrice` | 277 | `not_applicable` — nothing in the coin has closed |
| `proceedsUsd` | 24 | `historical_input_missing` — it closed, unpriced |
| `tokenCreatedAt` | 86 | `source_unavailable` |
| `totalSupply` | 17 | `source_unavailable` |

**That `avgExitPrice` split is the point.** 277 coins have never been sold and 24 were sold
without a recorded price. Both were one null before, and only the second is a gap in our data.

**Only keys that ARE null appear.** A fully populated coin carries `{}`, not a wall of
nulls-about-nulls. Three of the 317 have nothing missing at all.

**The answer-level `fieldReasons` covers the trader-wide figures** — `winRate`, `holdingTime`,
`moneyIn`, `moneyOut`, `returnPct`, `typicalBetUsd`, `trackRecordDays`, `feesUsd`,
`startCapitalUsd` — by the same rule.

This explains existing fields. It never replaces a null with a zero.

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
  "transactions": 33359,  "chainsCovered": ["solana"],
  "transfers": 33863,
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

**`chainsCovered` says which chains the counts are counted over.** The transfer feed is
almost entirely Solana, so an Ethereum-only trader answered all zeros here while his chain
was being read for balances — and zeros read as "inactive". A chain absent from
`chainsCovered` is one this block does not see; the zeros beside it say nothing about him.

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

**`checks` says what was looked at, so an absent flag is never a clean bill of health.**

```bash
curl -s "$B/traders/unipcs/trust" | jq .checks
```

```json
{
  "performed": ["pnl_exceeds_volume", "pnl_exceeds_holdings",
                "holdings_coverage_too_low", "too_few_trades", "partial_pricing"],
  "basis": "internal consistency only — figures we hold, checked against each other",
  "blacklist": { "checked": false, "lists": [],
                 "why": "no blacklist, sanctions list or known-scam source is consulted by this route." },
  "externalReputation": { "checked": false, "sources": [] }
}
```

**No blacklist, sanctions list or scam list is consulted here.** Every flag is an internal
consistency check on figures we already hold. "We checked a list and this trader is not on it"
and "we never looked" are opposite statements, and `blacklist.checked: false` says which one
this is. An absent blacklist flag means **not checked** — never *checked and clear*.

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

**Solana only.** This particular cross-check reads Solana pre/post balances, which is what
makes its `tier: "verified"` defensible. The EVM chains resolve trades by a different route —
see §10 — and carry no `chainDerived` block.

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

**`honeypotSince` and `cohort` (C3, added 17 Sep 2026).** `isHoneypot` is only the latest read,
so `security.honeypotSince` records the first nightly refresh where it (or sell-blocked) turned
true and is never cleared; `null` means never flagged since the column existed. Beside it,
`entries[].cohort: { holders, independent, linkedGroups }` counts the tracked traders with any
trade in the coin on that chain, then collapses traders whose wallet is another trader's
`linked_wallets` address — `independent` is what remains and `linkedGroups` the difference.
Both are what the Rug Dodger and Cabal Trader badges read; the exit-before-flag test itself
sits on the scorecard's `byToken[]`.

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

### The dev ledger (gap 5a, W-C) — added 17 Sep 2026

`entries[].creator.ledger` is the same creator across **every** token we hold GMGN info for,
rebuilt nightly by `scripts/refresh_creators.mjs` into `creators` / `token_creators`:
`{ launches, bestPeakMcapUsd, bestToken, stillHoldingCount, soldCount, honeypotCount, lastLaunchAt }`.
`null` until the ledger has a row for that creator. `launches` counts tokens a tracked leader
holds, not everything the address ever minted; `lastLaunchAt` is when *we* first saw the newest
of them (`tokens.first_seen_at`), not the mint time; `bestToken` is an address key.

```bash
curl -s "$B/creators/0x1c9ebbc3231645d283e88e50988d0202c15ecadc" | jq '{ledger, tokens: .tokens[:3]}'
```

`GET /creators/:address` (`?chain=` optional; without it EVM ledgers sum across chains) answers
`{ creator, asOf, ledger, tokens: [{ chain, tokenAddress, symbol, status, isHoneypot, marketCapUsd }] }`.
`tokens[].status` is GMGN's word (`creator_hold` / `creator_close`) or `null` when it was silent.
404 `not_found` for an address the ledger has never seen.

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
?step=1h  | 6h | 1d               thin the series         default: see below
?chain=robinhood | solana | ...   one chain instead of the whole portfolio
```

**Window names are forgiving.** The canonical four are `1d`, `1w`, `1m`, `all`, and those are
what `window` echoes back — but the spellings people actually type resolve too, in any case:

| you send | you get |
| --- | --- |
| `30d` · `30D` · `1M` · `30day` · `1mo` | `1m` |
| `7d` · `7D` · `1week` | `1w` |
| `24h` · `1day` | `1d` |
| `ALL` · `lifetime` · `everything` · `max` | `all` |

A consumer whose chart buttons read 1D / 7D / 30D / All used to get a chart on three of them
and a 400 on the fourth, which reads as the service being down rather than as a spelling
disagreement. Anything genuinely unknown is still a 400, and the message now lists the
accepted aliases. `?step=` takes the same courtesy: `1H` is `1h`.

**`step` describes the readings, not the request.** It used to be chosen from the requested
span alone — the coarsest leaving at least 24 points — which is a sound rule about the window
and says nothing about the data. Every week therefore declared `6h` over readings a day apart:
of the gaps between neighbouring readings, 566 measured 24 hours against 156 at 8 and 258 at
16. The answer described itself wrongly.

The observed spacing is now a floor, so a week over daily readings declares `1d`, and will
declare `6h` again by itself the day the readings are six-hourly.

| `?window=` | `step` declared | `bucketMs` | `observedStepMs` |
| --- | --- | --- | --- |
| `1d` | `1d` | 1h | whatever the data does |
| `1w` | `1d` | 6h | 86,400,000 (24h) |
| `1m` | `1d` | 1d | 86,400,000 (24h) |

**`step` and `bucketMs` are different knobs on purpose.** `bucketMs` is what the points are
thinned into and stays as fine as the window affords — coarsening it to match the label merged
two readings taken on the same day and returned five points where six exist. Thinning keeps a
chart plottable; it is not how a label is made true.

**`observedStepMs` is the median spacing of the readings actually held.** A consumer labelling
an axis should read this one. Median, not mean, so one long gap after a quiet spell does not
coarsen the whole series.

**A caller who names a `step` gets it in both places.** They asked; the answer does not argue.
`observedStepMs` still reports what the data does.

**`stepChosenFrom` says what the default was chosen from.** The rule used to look at the
window alone, so a trader tracked for six days asked for a month, got `1d`, and drew one point
with `too_few_points` while `1w` drew three. The chooser now takes the shorter of the window
and `now − trackedSince`:

| `stepChosenFrom` | |
| --- | --- |
| `window` | the requested span decided |
| `tracked_span` | the record is shorter than the window, and the record decided |
| `fallback` | daily bucketing left fewer than two usable points, so the finest step that gives two was taken |
| `null` | the caller passed `step` |

**`stepUnderstated` is true when the label cannot tell the truth.** `step` is an enum — `1h`,
`6h`, `1d` — so a consumer can switch on it. A one-day window over readings three and a half
days apart has no honest value in that set: `1d` is the coarsest name available and it still
overstates how close the points are. Rather than quietly return the wrong one, the answer says
the label is a floor and `observedStepMs` carries the truth.

```json
{ "step": "1d", "bucketMs": 3600000, "observedStepMs": 302400000, "stepUnderstated": true }
```

**`?step=1h` is the unbucketed form of `window=1w`.** The week's default 6 h buckets keep the
last reading per bucket, so a same-day retry replaces the reading it retried and the earlier
one is not shown. Ask `?window=1w&step=1h` and every reading in the week comes back
(verified 16 Sep: readings are never closer than an hour, so the 1 h bucket holds one each);
`count` rises to the number held and `bucketMs` reads `3600000`. Use it to see a retry
beside the reading it replaced; use the default when a chart only needs the shape.

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

**35,271 chain points across 388 of 448 traders**, and **408 traders carry at least two dated
figures that price enough of the wallet to be a balance** — see the priced floor in §9.

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

**`now` is the most complete RECENT reading, not simply the newest**, and it is window-independent
— what someone is worth does not depend on how much of their past you requested.

```bash
curl -s "$B/traders/unipcs/aum?window=1w" | jq .now
```

```json
{
  "at": "2026-09-14T04:00:00.000Z",
  "totalUsd": 15770542.96,
  "ageSeconds": 5485,
  "basis": "sampled",
  "tier": "verified",
  "partial": true,
  "coverage": { "pricedPositions": 322, "totalPositions": 595, "valueShare": 0.5412,
                "chainsAnswered": 4, "chainsTotal": 5 }
}
```

The selection rule, in order:

1. only readings within **36 hours** of the freshest one compete — the same allowance the
   sampler is judged by, so a complete but stale reading never beats a fresh one;
2. among those, the one that answered for **the most chains** wins;
3. at equal coverage a **measured** reading beats a rebuilt one;
4. recency settles the rest.

Taking the last row by time published a number a fifth of the right size: when the newest row was
a rebuild covering 1 of a trader's 5 chains, `now` read $5,101,125.87 eight hours after a measured
reading of $15,665,318.55, against a portfolio route saying $15.8M.

**`now` carries its own coverage, not just the points'.** `ageSeconds` gives its age without
parsing a date. A null total means the newest reading was genuinely refused, and `refused` names
why.

**`partial` means the figure is incomplete, by either route.** It used to mean only "a chain is
missing", so 106 readings priced less than all of their value and still said `partial: false`. A
total built from 63% of a wallet is partial whether the missing 37% is a whole chain or a
thousand unpriced coins. `partialReason` names which:

| `partialReason` | |
| --- | --- |
| `chains_missing` | a chain this trader uses did not answer |
| `unpriced_positions` | every chain answered, but not every position could be priced. Since 17 Sep this also covers a reading under `pricedFloor` whose figure is at least `partialServeFloorUsd` — it is **served** with its `totalUsd`, marked partial, rather than refused |
| `chains_missing_and_unpriced_positions` | both |

**A zero that nothing answered for is not a zero.** A trader whose wallets all answered and held
nothing reads `0`, and that zero is a measurement. A reading of `$0` with **no chain answered and
no position examined** is an empty read, not a balance — 72 traders were being returned that way,
71 of them marked drawable, so a consumer drew a flat $0 line for traders holding real coins.
Those now answer `status: "no_reading"` and `drawable: false`, with `nothing_answered` as the
reason. The same applies when every reading a trader has is refused.

**`chainsAnswered` / `chainsTotal` are filled on sampled and rebuilt points alike.** They are
`null` only where no chain split was stored for that reading at all — 149 readings of 872 — and
that is a missing count, never a zero.

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

**`status` has four values, and only one of them means "plot this".**

| `status` | |
| --- | --- |
| `ready` | this is what we have to offer |
| `warming` | it will be longer if you ask again later; `progress` says how much and when |
| `stale` | **this trader's** newest reading is past the 36-hour allowance. True, but old |
| `no_reading` | nothing answered — no chain, no position, or every reading refused. Not a zero |

A `ready` series is the finished answer; a `warming` one will be longer if the same request is
made later, and carries a `progress` block saying how much longer and when:

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
| `nothing_answered` | the newest reading answered for no chain and examined no position. Not a balance of zero — an empty read |
| `warming` | backfill or first sampling still running; temporary |
| `too_few_points` | fewer than two comparable numeric points |
| `short_coverage` | enough points, but not across the requested window |
| `too_little_priced` | the newest point priced too small a share of the wallet to be a balance — see below |
| `rebuilt_only` | enough points, but every one is `basis: rebuilt`; a line needs sampled points |
| `wallet_unreadable` · `service_timeout` · `no_prices` · `price_rejected` · `price_suspect` · `no_tokens_known` | the newest point's own refusal |

**Rebuilt points carry `reliability: "low"`, and never make a series drawable on their own.**
A rebuilt point prices a median 1.7% of the wallet (see below); drawing a line through
rebuilt points alone showed coins the wallet no longer held. `drawableMinPoints` (2, published
in `/fields`) is met by **sampled** points only; a rebuilt point has `reliability: "low"` and a
sampled one carries no `reliability` key at all.

**`gaps[]` lists every bucket with no number, and its reason.** Nothing is interpolated — a
chart breaks its line at each gap rather than drawing through it, because joining two points
across a hole draws a balance the trader never held.

**`coverage` says how much of the trader a point could see, in wallets and in chains.** A
chain with no row at that moment did not contribute zero dollars; it contributed nothing at
all, and those are different facts. Wallets are counted as well as chains because one EVM
address serves four of the five chains — so "three of four chains" can still mean either
wallet went unread, and which one it was changes what the number is missing.

### Every chain a trader uses — `knownChains[]`

```bash
curl -s "$B/traders/unipcs/aum?window=1w" | jq .knownChains
curl -s "$B/traders/unipcs/wallets"       | jq .knownChains
```

```json
[ { "chain": "base",      "networkId": 8453,       "wallets": 1, "hasPositions": true, "historyState": "ready" },
  { "chain": "bsc",       "networkId": 56,         "wallets": 1, "hasPositions": true, "historyState": "ready" },
  { "chain": "ethereum",  "networkId": 1,          "wallets": 1, "hasPositions": true, "historyState": "ready" },
  { "chain": "robinhood", "networkId": 4663,       "wallets": 1, "hasPositions": true, "historyState": "ready" },
  { "chain": "solana",    "networkId": 1399811149, "wallets": 1, "hasPositions": true, "historyState": "ready" } ]
```

**It does not change with the window, and it is not the newest reading's chain list.** `chains`
below is the split of one reading — for the trader above it held four chains while he uses
five. Draw chain tags and per-chain switches from `knownChains`; read `chains` for what the
latest reading actually covered.

**Built from every place a chain can be evidenced**, unioned: a chain his wallets have been
seen trading on, a chain he currently holds something on, and a chain we hold balance history
for. One query per batch — 117 ms for fifty traders.

| field | means |
| --- | --- |
| `wallets` | 1 when the address family reaching this chain is on record. One Ethereum-style address serves four chains |
| `hasPositions` | he holds something there right now |
| `historyState` | `ready` (two or more valued readings, the same rule the series draws by), `warming` (one), `none` |

It appears on `GET /aum`, `POST /traders/aum`, `GET /wallets` and `?include=wallets`.
`chainsAnswered` / `chainsTotal` / `partial` on each point are untouched — they answer a
different question.

### A figure built from almost none of a wallet is not a balance

This section has always said `totalUsd` is `null`, never a smaller number, when a wallet could
not be read. That rule was applied to outright refusals and not to the case that actually
bites: a point that *did* answer, for 1.7% of the wallet.

| basis | points | median share of value priced | under 10% |
| --- | --- | --- | --- |
| **rebuilt** | 7,815 | **1.7%** | 6,133 |
| sampled | 703 | **66.7%** | 13 |

The rebuilt history is thinly priced by construction, and drawing it as a balance line produces
figures that are wrong in a way no consumer can detect — one trader's line ran **$40 →
$389,797** between neighbouring points with no method change and no chain change to explain it.
Of 3,033 jumps of half or more on the month window, **1,226 had no declared cause**, and on
those the lower side priced a median 1.2%.

**No break marker fixes that**, because both sides are thin: the ratio between 1.2% and 1.5% is
nothing while the dollar figures differ a thousandfold.

**So a point that prices less than a fifth of its wallet is refused.** `totalUsd` is `null`,
`refused` reads `too_little_priced`, the point appears in `gaps[]`, and a chart breaks its line
there instead of drawing through it.

```bash
curl -s "$B/traders/unipcs/aum?window=1m" | jq '[.points[] | select(.refused == "too_little_priced")] | length'
```

| after the floor | |
| --- | --- |
| month-window jumps | 2,768 → **302** |
| undeclared jumps | **1,261 → 134** |
| traders affected | 316 → **67** |
| traders who can still draw a line | 432 → **408** |

Of the 134 that remain, about half have **both** sides pricing over 50% of the wallet — those
are most likely real moves, and marking them would be a false alarm rather than a fix.

**The floor is a count share, it is published, and a large figure under it is served.** The
rule counts positions, not value, so a wallet with hundreds of dust mints and a few valuable
ones was refused for its whole life — one trader had 0 of 32 readings accepted with a $221K
partial beside each, while `/positions` valued him at $26K. Since 17 Sep:

- the floor is `constants.pricedFloor` on `/fields` (0.25), and the second threshold is
  `constants.partialServeFloorUsd` ($100);
- a reading under the floor whose figure is at least $100 is served: `totalUsd` stands,
  `partial: true`, `partialReason: unpriced_positions`, `pricedPositionShare` beside it;
- only a reading that is both thin and small is refused `too_little_priced`, keeping
  `partialUsd` as before.

The floor is applied at read time, so every reading ever refused by it was re-classified at
once; nothing was re-priced, and there is nothing to retry (their R3). To see every reading
including a same-day retry, ask `?step=1h`.

```bash
curl -s "$B/traders/gmgn_hzyjnkimyy/aum?window=all&live=false" | jq '[.points[] | select(.partialReason == "unpriced_positions")] | length'
```

**The threshold is one constant**, chosen against the measured trade:

| floor | traders who can draw | undeclared jumps |
| --- | --- | --- |
| none | 432 | 1,226 |
| 0.10 | 416 | 254 |
| **0.20** (shipped) | **408** | **134** |
| 0.30 | 393 | 122 |

### Two neighbouring points may not count the same thing — `breaks[]`

A gap is a bucket with no number. A **break** is two numbers that cannot be subtracted.

```bash
curl -s "$B/traders/unipcs/aum?window=1w" | jq '{comparability, breaks}'
```

```json
{
  "comparability": { "equalised": false, "reason": "coverage_differs_by_method" },
  "breaks": [
    { "at": "2026-09-10T00:00:00Z", "previousAt": "2026-09-09T00:00:00Z",
      "reason": "chains_changed", "chainsAdded": [], "chainsRemoved": ["robinhood"] },
    { "at": "2026-09-10T16:00:00Z", "previousAt": "2026-09-10T00:00:00Z",
      "reason": "method_and_chains_changed",
      "chainsAdded": ["robinhood"], "chainsRemoved": ["base", "bsc"] }
  ]
}
```

**Break the line at every entry, and never measure a percentage across one.** Each point also
carries `comparableWithPrevious` (`null` on the first), so a chart reading `points[]` alone
sees the same thing, and `chains[]` naming which chains that point answered for.

| `reason` | What changed between the two figures |
| --- | --- |
| `method_changed` | one is a measured reading, the other a rebuild |
| `chains_changed` | the same method answered for a different set of chains |
| `priced_share_changed` | the same method and chains, but one point could price twice as much of the wallet as the other |
| combinations | joined with `_and_`, e.g. `method_and_chains_changed` |

`pricedShareBefore` and `pricedShareAfter` travel on every break, so the size of the change is
visible rather than implied.

**`chains_changed` is the one that catches what a method marker misses.** `fhn_gt` read
$65,367.54, then $33.26, then $52,276.29 in three days, and a consumer's card printed
"+155,855.5% in 7 days". He did not lose 99.9% of his money — the second point answered for
robinhood alone, having dropped the ethereum leg the first one had. **Both** of those steps are
rebuilt-to-rebuilt: the method never changed. Measured over the last week across all 435
traders, of the 865 consecutive steps that move a line by half or more, 542 change method and
**226 more change only the chain set**.

**The two kinds are marked, not equalised, and `comparability` says so.** Valuing both the same
way is the better answer and it is not available: per chain, a rebuilt point prices about 39% of
the positions and a sampled one 77–84%, and the cliffs concentrate exactly on the steps that
cross between them — 60% of sampled-after-rebuilt steps, 74% of rebuilt-after-sampled, against
14% of sampled-after-sampled. Equalising needs the per-token history the rebuild did not keep;
only per-chain totals were stored. Valuing every point over the chains they all share was tried
and measured: it removes the chain-set cliffs and leaves the coverage ones, with 548 of 1,074
steps still moving by half or more. A column called "comparable" that is wrong half the time is
worse than no column, so there is not one.

**Asking one chain at a time removes half the problem.** With `?chain=`, every point answers for
that chain, so `chains_changed` cannot occur and only `method_changed` remains.

**`drawable` is unchanged by any of this.** Whether a line exists and whether two of its points
can be subtracted are different questions. 85% of rebuilt points answer for fewer chains than
the trader trades on; refusing them would delete the history rather than describe it.

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
`price_rejected`, `price_suspect`, `no_tokens_known`). A partial total would read exactly like
a real drawdown. The same words appear as `chains[].reason` on the chain that hit the wall,
and as `gaps[].reason`.

**`price_suspect` is a reading one impossible price would have dominated.** A verified
$101 billion was served for a wallet holding one coin at $8,923 a unit — an implied market
cap of $8.9 trillion. A price is now refused when `price × total supply` exceeds $20B, and a
reading is refused `price_suspect` when a single position is over 90% of the total and either
its implied cap is unknown or the total exceeds $1B. The refused reading keeps its partial
figure and is never `tier: verified`; the row on `/positions` carries `priceSuspect: true`
with the reason (§2).

**`no_tokens_known` is a chain the sampler had nothing to read on.** EVM chains are read over
the tokens the trader has traded there; a chain with an empty token set and no native balance
to read is unread, not "answered with zero". It is `totalUsd: null` with this reason, and it
does not count in `chainsAnswered`.

**A trader whose wallets all answered and held nothing is `0`.** That zero is a measurement,
and it is written only when at least one chain was actually queried and every answer was
empty. A priced sum under a cent is still a figure, published as `0.00` with
`pricedPositions ≥ 1`, never rounded away in storage.

**A chain that fails does not cost the others.** One unreadable wallet used to refuse the whole
trader-hour; each chain is now read on its own, the chains that answered are written, the
ones that did not carry a `reason`, and a reading that answered fewer chains than
`knownChains` lists is `partial: true, partialReason: chains_missing`, with `chains[]` naming
which ones answered. A reading that answered no chain is `null`, always. A chain refused
`wallet_unreadable` is retried once at the end of the slice.

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

### Reading the whole record — `?cursor=`, and the filters

```
?limit=1..500                page size
?cursor=<nextCursor>         keyset paging on (block_time desc, tx_hash)
?chain= ?since= ?until=      narrow the set
?status=open | closed        by the pairing below, not by a stored column
```

**Paging is keyset, not offset**, so new swaps arriving at the head cannot shift a page under
a caller. Walked four pages of 50 on the busiest wallet: **200 rows, 200 unique, no overlap**.
Follow `nextCursor` until it is `null`; `complete` is true on the last page.

**`?status=` filters after paging, and says so.** Whether a swap is still open is a fact about
what happened afterwards, not a stored column, so the database cannot filter it. A filtered
page carries `scanned` — the rows it held before filtering — and **`count` can be 0 while
`nextCursor` is non-null**. That is a sparse page, not the end: keep following the cursor.

### Each sell paired to the buy it closed

FIFO over the trader's **entire** swap record, not the page — a sell's buy may be nine pages
away.

```bash
curl -s "$B/traders/pointfarmcap/trades?limit=100&status=closed" | jq '.trades[] | {side, at, positionId, status, openedAt, closedAt, holdSeconds}'
```

| field | means |
| --- | --- |
| `positionId` | the transaction that OPENED the lot — stable, and lookupable on an explorer |
| `status` | `open` until a later sell finishes consuming the buy; `closed` after |
| `openedAt` | on a sell, when the quantity it sold was bought |
| `holdSeconds` | `closedAt − openedAt`; this is what "in and out under five seconds" measures |

FIFO because it is the convention a reader assumes, and the only one defensible without
knowing the trader's own accounting.

**A sell with no matching buy gets `positionId: null` and `whyNoPosition`**, never an invented
pairing. On one wallet's closed page that was 24 of 33 rows — the wallet's earlier buys predate
our record of it. Nine carried a full pairing, with hold times from 19,436 to 248,484 seconds.

### Which chains were actually read — `coverage.byChain[]`

```json
[ { "chain": "base",      "state": "unresolved", "swaps": 0,   "from": null, "to": null },
  { "chain": "bsc",       "state": "unresolved", "swaps": 0,   "from": null, "to": null },
  { "chain": "robinhood", "state": "unresolved", "swaps": 0,   "from": null, "to": null },
  { "chain": "solana",    "state": "complete",   "swaps": 525,
    "from": "2026-09-06T…", "to": "2026-09-09T…" } ]
```

**`unresolved` and "no trades" stop looking identical.** `unresolved` means we resolved none of
this wallet's own trades on that chain — not that it made none. `complete` carries `from`/`to`,
so a caller asking for last week can tell whether last week was even read.

**Trades now resolve on four chains, not one.** The resolver originally accepted only
token-for-token swaps, and on the Ethereum-style chains that is the *uncommon* shape: buying a
token with BNB or ETH moves the coin as a value transfer, which emits no `Transfer` event and
so is invisible in a receipt's logs. Reading the transaction body alongside the receipt — `from`
and `value`, plus the `Withdrawal` a router fires when it unwraps — makes those trades readable.

| chain | swaps | wallets |
| --- | --- | --- |
| solana | 18,893 | 160 |
| bsc | 4,234 | 150 |
| base | 2,164 | 104 |
| ethereum | 206 | 13 |

**A wallet appears in far more transactions than it trades in.** Measured on a random sample,
**5 in 6** are the wallet receiving tokens inside someone else's trade — an airdrop, a router
hop, a distribution. Only a transaction the wallet signed, with one token in and one out (or a
native leg on one side), is written here. That is why a chain can hold thousands of a wallet's
transactions and a handful of its trades.

**`feeUsd` is `null` on every row and will stay null** until fees are stored. Zero would claim
the trade cost nothing to make, which is never true on any chain. `source` and `confidence`
travel per row rather than per answer.

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
| "The whole board, without 448 calls" | `POST $B/traders/positions` | `traders[]` | **50 traders per call** |

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

**The batch never reads live, and every row says so.** `live` — `?live=` on the URL or
`live` in the body — is accepted and ignored on `POST /traders/aum`; the route only ever
serves stored readings, so a batch of fifty cannot trigger fifty chain reads. Each row's
`aum.liveRead` is the constant `{ "state": "skipped", "note": "batch never reads live; use GET /v1/traders/:handle/aum" }`
(on `contractVersion: 2` under `aum`, on the older shape on the row). A consumer that needs a
fresh read asks the single-trader route with `?live=true`.

```bash
curl -s -X POST "$B/traders/aum?live=true" -H 'content-type: application/json' \
  -d '{"contractVersion":2,"ids":["unipcs"],"window":"1w","live":true}' | jq '.traders[0].aum.liveRead'
# { "state": "skipped", "note": "batch never reads live; use GET /v1/traders/:handle/aum" }
```

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

## 12. Events feed

| In plain words | Call | Read | Live value |
| --- | --- | --- | --- |
| "What happened across the cohort since I last looked?" | `GET $B/events?since=…` | `events[]`, `nextCursor` | three kinds, one order, oldest first |

**In layman's terms.** Every workflow that starts with "when a tracked wallet does X" needs one
place to watch. This is that place: transfers (`transactions`), the wallet's own swaps
(`wallet_swaps`) and the sampler's balance readings (`aum_samples`, `basis: sampled`), unioned
in SQL and served oldest-first so a poller reads forward with the cursor it was last handed.
Nothing is pushed; the app polls. Workflow gap 2 in `docs/consumer/workflow-coverage-17-sep.md`.

### How to test

```bash
# the last 24 hours (the default `since`), first page
curl -s "$B/events?limit=100" | jq '{count, nextCursor, kinds: [.events[].kind] | unique}'

# from a point in time, one kind, one chain, one trader
curl -s "$B/events?since=2026-09-17T00:00:00Z&kind=swap&chain=solana&handle=unipcs" \
  | jq '.events[0]'

# poll: feed nextCursor back until it is null, then keep the last one and ask again later
curl -s "$B/events?cursor=CURSOR_FROM_ABOVE" | jq '{count, nextCursor}'
```

```json
{
  "asOf": "2026-09-17T12:00:03.120Z", "since": "2026-09-16T12:00:03.000Z",
  "count": 100, "limit": 100, "nextCursor": "CURSOR",
  "filters": { "kind": null, "chain": null, "handle": null },
  "events": [
    { "kind": "transfer", "at": "2026-09-16T12:04:11.000Z", "handle": "unipcs",
      "traderSource": "fomoapi.io", "chain": "solana", "tokenAddress": "…pump",
      "txHash": "5Kj…", "gates": { "isHoneypot": false, "canSell": true, "priceSuspect": null },
      "direction": "in", "amount": 1250000, "counterparty": "6EF8…", "source": "PUMP_FUN",
      "txType": "SWAP" },
    { "kind": "swap", "at": "2026-09-16T12:04:11.000Z", "handle": "unipcs",
      "traderSource": "fomoapi.io", "chain": "solana", "tokenAddress": "…pump",
      "txHash": "5Kj…", "gates": null,
      "tokenDelta": 1250000, "quoteDelta": -1.5, "quoteUsd": -210.46 },
    { "kind": "reading", "at": "2026-09-16T12:05:00.000Z", "handle": "0xAvast",
      "traderSource": "gmgn", "totalUsd": 48211.9, "refusedReason": null }
  ],
  "note": "Solana transfers and swaps arrive in real time from the Helius webhook; EVM transfers are backfilled nightly…"
}
```

### What to know before you use it

**Parameters.** `since` (ISO; default now − 24 h), `cursor`, `limit` (≤ 500, default 100),
`kind` (`transfer` | `swap` | `reading`), `chain` (a `/chains` name), `handle` (handle or id).
`?chain=` excludes readings, which are not per chain.

**Ordering is `(at, kind, txHash | handle)` ascending and the cursor carries exactly that.**
Newest is last. A full page is a hint that more exist; `nextCursor: null` is the end. A cursor
from `/transactions` or `/trades` gets a **400** here.

**Solana is real time, EVM is nightly.** The Helius webhook writes Solana transfers as they
land; EVM transfers come from the nightly backfill, so an EVM event with an `at` of yesterday
can first appear today. Poll with a cursor, not with `since = last poll time`, or nightly rows
will be skipped.

**`gates` is `null` when `token_info` holds no row for the token** — unassessed, not safe.
`isHoneypot` and `canSell` are GMGN's security read (G12); `priceSuspect` is reserved and
always `null` on this feed (the price check lives on `/positions`).

**`traderSource`** is `traders.source` (`fomoapi.io` or `gmgn`): the only class the cohort has.

**`reading.totalUsd: null` means refused**, and `refusedReason` says why — never zero.

---

## 13. Market regime

Added 17 Sep 2026 for the "Casino Closed" workflow (composite C4,
`docs/consumer/composite-workflows-coverage-17-sep.md`). One cohort-wide reading, identical for
every caller, computed at most once a minute per instance. **It is a reading of the tracked
cohort's week, not advice.**

### `GET /market/regime`

```json
{
  "board": "market", "asOf": "…", "window": "7d",
  "regime": "caution",
  "rule": { "closedBelow": 0.25, "cautionBelow": 0.5, "survivalDowngradeBelow": 0.1, "basis": "…" },
  "leaders":  { "total": 84, "green7d": 31, "greenShare7d": 0.369, "basis": "…" },
  "launches": { "seen7d": 40, "graduated7d": 3, "survival7d": 0.075, "chains": ["solana"], "basis": "…" },
  "rotation": { "tokensMoved7d": 612, "topShare7d": 0.41, "basis": "…" },
  "plain": "37% of tracked leaders are green this week (31 of 84); 8% of 40 Solana launches graduated; regime caution. A cohort reading, not advice.",
  "cachedForSeconds": 60
}
```

| Block | What |
|---|---|
| `leaders` | traders with ≥ 1 trade whose `closed_at` falls in the last 7 days; `green7d` = those whose `sum(realized_pnl_usd)` over that week's closes is > 0. `greenShare7d = green7d / total`, `null` when `total = 0` |
| `launches` | Solana tokens with `tokens.created_at` in the last 7 days (the pump.fun curve read, `docs/LAUNCH_METADATA.md`); `graduated7d` = `graduated = true`. `survival7d = graduated7d / seen7d`, `null` when `seen7d = 0` |
| `rotation` | `transactions` in the last 7 days across tracked wallets: `tokensMoved7d` distinct tokens, `topShare7d` the share of transfer count carried by the 10 most-moved tokens (a concentration proxy: high = the cohort is piling into few names). `null` when nothing moved |
| `regime` | `closed` when `greenShare7d < 0.25`, `caution` when `< 0.5`, else `open`; `survival7d < 0.1` moves the result one step down (never past `closed`). `null` when `greenShare7d` is `null` |
| `rule` | the thresholds above, published so the app can show why |

The rule is a pure function (`regimeFrom` in `routes/market.ts`, tested in `tests/market_test.ts`).
Launch metadata is nightly and Solana-only, so `survival7d` lags a day and says nothing about
EVM; the leaders figure moves with each trade load.

---

## Appendix A11 · Fees, swaps and entry prices (2026-09-16)

The last three asks from the version 9 list, and what each one answers today.

| | what it does | coverage |
| --- | --- | --- |
| **A7** · fees | every transaction's cost read from chain — `gas_used x effective_gas_price` on the four Ethereum-style chains, `meta.fee` on Solana — rolled into per-trader daily buckets and served per window and per trade | **402 of 448** traders · 105,966 transactions priced |
| **A5** · buys and sells | each swap resolved from the wallet's own net balance change, then FIFO-paired so a sell carries the buy it closed: `positionId`, `openedAt`, `closedAt`, `holdSeconds` | **28,300** swaps · **352** wallets · 10,733 carrying a dollar value |
| **A4** · entry prices | the directory's figure where it has one, and a price derived from the wallet's own resolved buys where it does not — `entryPriceSource` names which | **57,339 of 75,010** coins priced |

### Why each figure is a coverage figure and not a total

**A trader with no stored transactions has no fee to read.** That is the whole of the 46 not
counted above: nothing was skipped, there was nothing to price. `fees.coverage` says so on the
answer and `fieldReasons.feesUsd` names it.

**A wallet appears in far more transactions than it trades in.** Measured on the resolver's own
population, roughly 7 in 10 Solana transactions tagged as swaps are the wallet receiving tokens
inside somebody else's trade. Only a transaction where the wallet's own balance moved in two
directions is written as its swap — which is why a chain can hold tens of thousands of a
wallet's transactions and a few hundred of its trades.

**An entry price needs a buy that can be valued.** A swap paid for in a coin we hold no market
price for resolves correctly and still yields no entry price. `entryPriceSource: "chain"`
appears only where both conditions hold; where neither source has it, `fieldReasons` says
`historical_input_missing` rather than leaving a bare null.

### The one number that governs all three

Every figure above is drawn from transactions the service already holds. The limit on all of
them is the same: **a wallet's own trades are a small share of the transactions it appears in**,
and a figure is only published where the evidence for it is in hand. That is why each of these
carries its coverage beside it rather than a total — the same rule the rest of this document
follows.

---

## Appendix A10 · Trades on four chains, and a directory that refreshes (2026-09-15)

Three faults, each one a piece of code that could only ever do half its job while reporting
success.

### The decoder could not see a native leg

The EVM swap resolver accepted **token for token** and nothing else. On the Ethereum-style
chains that is the uncommon shape: paying with BNB or ETH moves the coin as a value transfer,
which emits no `Transfer` event, so a receipt shows the wallet receiving a token and sending
nothing — indistinguishable, from logs alone, from an airdrop.

Measured on 60 random bsc transactions before changing anything:

| | count |
| --- | --- |
| token ↔ token — the only kind it resolved | **1** |
| **native → token** | **2** |
| **token → native** | **3** |
| wallet is a counterparty in someone else's trade | 50 |

It was finding one trade in six and discarding five. Reading the transaction body beside the
receipt — `from`, `value`, and the `Withdrawal` a router fires on unwrap — fixed it:

| chain | swaps before | after | wallets |
| --- | --- | --- | --- |
| bsc | 76 | **4,234** | 5 → **150** |
| base | 37 | **2,164** | 10 → **104** |
| ethereum | 0 | **206** | 0 → 13 |

Two traders the consumer named as returning zero rows now answer:

```
0xcaishen_1   rows 0 → 80   28 sells, 20 paired to their buys
0xKaroshi     rows 0 →  6    1 sell,   1 paired
```

**robinhood stays at 3, and that is the right answer.** Sampling its transactions, the wallet
receives a token and is not the sender in every one — several inside 200-to-500-log batch
transactions. What we ingested there are inbound transfers, so there are no wallet-signed trades
in them to resolve.

### One resolver was throwing away most of its own work

The Solana resolver made exactly one attempt per transaction and counted anything else a
failure. Smoke runs read a 30% hit rate. With backoff added, the same 200 events read **92%**,
and a full run over 15,738 events resolved **94.9% with zero failures**. The earlier number was
never the data — it was rate limits being counted as refusals, and each one still cost a call.

### Two loaders that could fill a table but never refresh it

Both trade loaders selected traders **with no rows at all**:

```sql
and not exists (select 1 from trades tr where tr.handle = t.handle)
```

Correct for a first fill, useless afterwards — and silent about it. All 291 GMGN traders already
had rows, so that loader selected **nobody** and reported success. Both now take a staleness
selector, which is self-converging: a trader that loads successfully moves his own `ingested_at`
and drops out of the next pass.

The fomo loader also gained `--source`. Without it a converge loop retries traders that API
cannot serve — it answers `{"available": false}` for anyone outside its own leaderboard — on
every pass, which at 250 credits a call and 8 passes is 2,328 calls against a budget under a
thousand.

**Scorecards past 72 hours: 368 of 448 → 16.** The GMGN loader finished at **291 of 291
traders, 39,591 positions, 0 skipped.**

| source | traders | scorecard fresh (<72h) | fees | resolved swaps |
| --- | --- | --- | --- | --- |
| fomoapi.io | 157 | 138 | 146 | 121 |
| gmgn | 291 | **278** | **216** | **205** |

The GMGN side went from an empty trades route to 205 of 291 traders with resolved swaps, and
from 93 to 216 with fees.

### What a resolver run is, and what it is not

Three gaps that look like three jobs are two, and both are the same kind of work.

**Fees were never collected.** `transaction_fees` did not exist before 14 September; no fee or
gas figure was stored anywhere, and `transactions.raw` is empty on all 1,025,559 rows. This is
a first collection, not a recovery.

**Swaps were collected and never processed.** `transactions` holds one row per transfer leg —
hash, address, token, amount. Whether a transaction was *this wallet's own swap* needs its
pre/post balances, which only the chain has. One trader has **64,975 Solana transactions stored
and 49 resolved**. The rows were never lost; the pass over them had not been run.

So resolving is not a database operation. It is one `getTransaction` per signature:

| | calls | endpoint |
| --- | --- | --- |
| fees | 34,772 | Helius `getTransaction` |
| swaps | 223,726 | Helius `getTransaction` |

Same key, no credit meter, rate-limited at about 3.6 per second — which is the whole cost, in
wall clock rather than money.

**Nothing was lost to make this necessary.** Integrity across the store: no orphaned trades, no
orphaned swaps, no invalid statuses, no negative prices, no negative balances, no empty handles.
Every table has grown.

### Two fields that were quietly wrong, found by a consumer re-test

Neither was a missing feature — both were fields that answered confidently and incorrectly.

**`loadedAt` reported the first row it happened to see.** On a refreshed record that is an old
row, so the scorecard claimed a ten-day-old load on a record refreshed that morning. `asOf` next
to it was already taking the maximum, so the response disagreed with itself.

**The scorecard named the wrong provider for 291 of 448 traders.** `source` was the fixed string
`postgres · trades (loaded from fomoapi)` for everyone, including every trader whose trades are
folded from GMGN's activity feed. It now names the provider that actually produced the rows, and
`traderSource` carries the directory the trader came from.

Also confirmed in the same re-test, against a consumer report written before the last deploy:
`window=30d` answers 200 rather than 400, and the `all` window that carried **18 undeclared
breaks now carries 1** — the thin points behind the other seventeen are refused rather than
drawn.

---

## Appendix A9 · The version 9 report — A1, A2, A3 re-tested (2026-09-15)

The consumer re-tested the three asks that mattered most, this time across **all 448 traders**
rather than a sample, and found all three still failing. They were right on every count, and all
three were faults in what we shipped rather than missing data.

| | measured by them | now |
| --- | --- | --- |
| **A1** readings past the 36h bar still answering `ready` | **14** | **0** |
| **A2** `$0` readings with no coverage, still `ready` | **72** | **0** |
| **A2** …of those, still `drawable` | **71** | **0** |
| **A2** points pricing under 100% yet `partial: false` | **106** | **0** |
| **A3** month-window jumps of half or more | 2,768 | 302 |
| **A3** …with no declared cause | **1,261** | **134** |
| **A3** traders affected | 316 | **67** |

### What each fault actually was

**A1 — the state was the pipeline's, not the trader's.** `sampler.state` was computed from the
newest successful run anywhere in the table. On a night the sampler reached most of the
directory, a trader whose own newest reading was 6.8 days old still answered `current`. Both
clocks are now reported and they answer different questions — see **§0f**.

**A2 — a zero nobody answered for.** The rule "a trader whose wallets all answered and held
nothing reads `0`" was right; the check that a wallet *had* answered was missing. Live testing
after the fix found a second shape of the same fault: a trader whose readings are **all refused**
(`totalUsd` null rather than `0`) still answered `ready`, because the fallback picked the newest
row and aged a figure that does not exist. Both now answer `no_reading`.

**A3 — the marker was never going to be enough.** Their first suggestion was a break wherever
the priced share moves. It was implemented and measured: undeclared jumps went 1,226 → 1,025.
Barely moved, because on those jumps *both* sides are thin — the ratio between 1.2% and 1.5% is
nothing while the dollar figures differ a thousandfold. Their second suggestion was the right
one, and it is the rule this document already states everywhere else: refuse the number. A point
pricing under a fifth of its wallet now answers `too_little_priced`. See **§9**.

### What it cost, stated plainly

The floor removes 77% of rebuilt points and takes traders who can draw a line from 432 to
**408**. Those points were never balances — the median rebuilt point priced **1.7%** of its
trader's wallet — but 24 traders lost a line they previously had, and that is a real loss to
set against a chart that was wrong undetectably.

### The rest of the version 9 list

| ask | what changed |
| --- | --- |
| **N1** `window=30d` was a 400 | `30d`, `7d`, `24h`, `1mo`, `lifetime` and case variants all resolve, on the individual and batch routes from one table. **§9** |
| **N2** nothing named the source | `source` on the directory, the profile and `/wallets`, with the two sources' opposite failure modes stated. **§0** |
| **A13.7** the 1d window declared `1d` over 3.5-day spacing | `stepUnderstated` says the enum label is a floor; `observedStepMs` carries the truth. **§9** |
| **stale-trader count** on `/health` | `staleTraders` — 14 readings and 368 scorecards past their own bars, of 448. **§0f** |

### What the A2 fix cost, stated plainly

Traders drawable on the month window went from **428 to 331**. Almost all of that is the fix
working rather than a loss:

| `drawing.reason` | traders |
| --- | --- |
| `nothing_answered` | **106** |
| `too_few_points` | 8 |
| `warming` | 2 |
| `short_coverage` | 1 |

The 106 are the empty reads — 72 returning `$0` with nothing behind it, plus 34 whose every
reading is refused. They were being drawn as flat `$0` lines for traders holding real coins.
The priced floor accounts for only 8 of the 117.

`status` across the directory now reads: **326 ready, 106 no_reading, 13 stale, 3 warming.**

### One regression this round, found by testing

Making `/health` concurrent — four queries in one `Promise.all` instead of four sequential
awaits — stopped it answering entirely, 90 seconds to the route timeout, while every underlying
query still returned in 150 ms by hand. Every other route kept working. It is sequential again,
and the note above it says to test `/health` specifically if anyone tries that optimisation
again, because a smoke test that skips it passes.

---

## Appendix A8 · The buys themselves, and version 8 closed (2026-09-14)

A4's last bullet asked for entry price and entry market cap **per buy**, "so '95% of buys under
$100K' counts buys". It was the final open item in the version 8 report.

**The obstacle was never the fetching.** fomoapi gives us a POSITION carrying one
`avg_entry_price`, already averaged across the fills inside it, and an average cannot be taken
apart. The buys had to come from chain swaps, and only Solana had them.

### What the probe found, before anything was built

A random sample of 100 bsc transactions:

| | Share | What it is |
| --- | --- | --- |
| no swap at all | 74% | transfers, approvals, bridges |
| a swap, **wallet one-sided** | 25% | the wallet received or sent one token, not both — a counterparty inside someone else's trade |
| the wallet's own two-sided swap | **1%** | a trade this wallet made |

That 25% is the trap the `/trades` coverage note has always warned about. Treating those as the
trader's buys would have manufactured hundreds of fills at prices the trader never paid, so the
resolver accepts only transactions where the wallet **both sends and receives** — 1,979
candidates across four chains, about 20 batched requests rather than 52,420.

### What it yielded

| chain | buys held | priced | wallets |
| --- | --- | --- | --- |
| solana | 2,017 | 2,017 | 122 |
| bsc | 40 | 40 | 5 |
| base | 14 | 12 | 10 |
| robinhood | 1 | 1 | 2 |

**2,070 individual priced buys across 139 wallets**, and `buysCoverage` says so on every answer.
116 EVM swaps were resolved where the previous attempt found none — because a receipt carries
every log, while the transfer rows we had ingested carry only the legs the ingest happened to
store. Ethereum yielded nothing: all 60 of its two-sided candidates moved more than two tokens
for the wallet, which is a route or a rebalance and not a single trade.

### Version 8, closed

All nineteen asks are answered, verified against the live service:

| | Asks |
| --- | --- |
| **Answered in full** | A1, A2, A3, A5, A6, A8, A9, A10, A11, A12, A13.1, A13.2, A13.3, A13.4, A13.5, A13.6, A13.7 |
| **Answered, with coverage stated on every answer** | A4 — entry prices on 57,339 of 75,010 coins; A5 — 28,300 resolved swaps across 352 wallets; A7 — fees for 402 of 448 traders |

Nothing here is a partial answer presented as a whole. Every figure that covers part of a trader
says which part: `buysCoverage`, `fees.coverage`, `costCoverage`, `volumeCoverage`,
`feesCoverage`, `entryPriceCoverage`, `chainsAnswered` / `chainsTotal`, and `fieldReasons` in
four named codes beside every null.

---

## Appendix A7 · Fees, read from chain (2026-09-14)

The consumer's A7 asked for five things. Four were answered from stored data; the fifth — fees
in dollars — could not be, because **no fee or gas column existed on any table** and
`transactions.raw` was empty on all 1,025,559 rows. It is now read from chain.

**No paid API, no new key.** Measured before any of it was written:

| Chain | Call | Batches |
| --- | --- | --- |
| robinhood, bsc, base, ethereum | `eth_getTransactionReceipt` on the public RPC in `chains.rpc` | yes |
| solana | `getTransaction` on the Helius key already held | yes |

A receipt carries `gasUsed` and `effectiveGasPrice`; Solana carries `meta.fee`. Both batch, so
52,420 EVM transactions cost about 525 requests rather than 52,420.

### Where each chain stands

| Chain | Fees read | Traders covered | Dollars |
| --- | --- | --- | --- |
| robinhood | **28,943** — complete | 128 | priced |
| bsc | **10,644** — complete | 149 | **native only** — no market price for BNB exists in our store |
| base | **9,267** of 9,377 | 219 | priced |
| solana | **3,629** — every transaction behind a resolved swap | 122 | priced |
| ethereum | 3,390 of 3,456 | 134 | priced |

**Solana is scoped on purpose.** 3,629 is every transaction behind a resolved swap — the ones a
per-trade fee can attach to. The chain holds 636,689 transactions in total; sweeping all of them
is ~6,367 requests and buys fees on transfers that are not trades.

**ethereum's 66 remaining are not a fee problem.** Those hashes return `result: null` — the node
has no receipt for them, so they are not Ethereum mainnet transactions. That is an ingest
question about how they were attributed, and it is recorded here rather than hidden.

### Three measurements that shaped the build

- **Summing fees at request time took 24.5 seconds** for our busiest trader, because the honest
  query takes DISTINCT transactions out of a table holding one row per transfer leg. That is the
  bill that made `/positions` answer 503 once. It moved off the request path into
  `trader_fees_daily`; the same answer now takes **0.78 ms**. Daily buckets rather than window
  totals, because windows roll and a closed day stays true.
- **base caps a JSON-RPC batch at 10** and returns HTTP 200 with the refusal in the body. The
  loader reads a non-array reply as a refusal and stops, rather than recording "these
  transactions have no fee" across a whole chain.
- **Solana refuses a batch of 100 and accepts 10.** A batch-size limit rather than anything to
  do with the key, which had answered a smaller batch moments earlier. Worth knowing, because
  the two look identical from the HTTP status alone.

### What is deliberately still missing

- **`includesFees` stays `false`.** Fees are measured, not deducted.
- **`feesUsd` is null for bsc** and `coverage` reports 4 of 5. Its fees are real and exact in
  `paidNative`; there is simply no BNB price to convert them with.
- **A stored position can never carry a fee.** It has no transaction hash. Per-trade fees are on
  `/trades`, where a row is a transaction, and `fees.perTradeWhy` says so on the scorecard.

---

## Appendix A6 · Cost basis, reasons, and paired trades (2026-09-14)

The last three version 8 asks answerable from data already stored. Every figure was read from
the live service after the change.

| # | What was wrong | What changed |
| --- | --- | --- |
| **A12** | `/positions` gave quantity, price and value with no acquisition cost, so "up 3x on this coin" could not be said | the nine fields §7.4 names, on the single and batch routes from one function. A holding with no stored position is `null`, never `0`: of one trader's 500 positions, 18 carry a cost, 482 do not, **none report 0**, and `costReason` separates the 300 that may have arrived as transfers from the 182 he bought without a recorded price. `unrealizedUsd` is measured against the quantity whose cost we know, with `costAmountShare` stating what fraction that is. **§2** |
| **A11** | `tokenAgeAtEntryDays`, `avgExitPrice` and `totalSupply` could be null on a coin with nothing to say why | `fieldReasons` per coin and per answer, in the four codes asked for. Across 317 coins: `avgEntryPrice` 293 `historical_input_missing`, `avgExitPrice` **277 `not_applicable`** against **24 `historical_input_missing`** — never sold versus sold unpriced, which were one null before. Only keys that are null appear; three coins carry `{}`. **§3** |
| **A5** (what the stored data supports) | the first 100 trades, no way to read the rest, and no pairing | keyset `?cursor=` paging — four pages of 50 walked **200 rows, 200 unique, no overlap**; `?until=` and `?status=` filters; FIFO round-trip pairing over the trader's entire swap record giving `positionId`, `status`, `openedAt`, `closedAt` and `holdSeconds`; and `coverage.byChain[]` separating a chain with no trades from one never read. **§10** |

**Three deliberate refusals, each visible on the response.**

- **A sell with no matching buy is not paired.** 24 of 33 closed rows on one wallet carry
  `positionId: null` and `whyNoPosition` — the wallet's earlier buys predate our record. An
  invented pairing would produce a confident, wrong holding time.
- **A transfer in is not a purchase at zero.** That rule is the reason 482 of 500 positions
  answer `null` rather than showing a cost basis that would read as pure profit.
- **`feeUsd` is null on every trade row and stays null.** Nothing stores fees; zero would claim
  the trade cost nothing to make.

**`?status=` filters after paging**, because the pairing that decides open-versus-closed is not
a stored column. A filtered page reports `scanned`, and `count` can be 0 while `nextCursor` is
non-null — a sparse page, not the end.

---

## Appendix A5 · The version 8 report, the rest of the asks (2026-09-14)

The ten asks after A1-A3 that could be answered from data already stored. Every figure below
was read from the live service after the change.

| # | What was wrong | What changed |
| --- | --- | --- |
| **A13.2** | `pnl`, `volume`, `numTrades` and `updatedAt` null for a large part of the directory | two loaders write the stats and never run together, so whichever ran last defined "current" and the other's traders fell out of the view entirely. Taken **per trader** now: **442 of 442** carry all four, from 100. `updatedAt` is each trader's own. **§0** |
| **A10 · A13.7** | every week declared `6h` over readings a day apart — 566 of the gaps measured 24 hours | the observed spacing is a floor on the declared step, so the week says `1d` and will say `6h` again on its own. `observedStepMs` reports the median spacing; `bucketMs` stays as fine as the window affords, because coarsening the thinning lost a real reading. **§9** |
| **A13.1** | one median under two coverages, 43 of 43 and 3 of 43 | the 3-of-43 was the PRICED-position coverage, which belongs to the return figures and has nothing to do with a duration. Both now read **43 of 43**, the positions the median was actually taken over. **§3** |
| **A6** | `realizedByDay` covered 30 days; no monthly field existed | `realizedByMonth` — twelve completed months plus the one running, each with dollars, closed-trade count, coverage and `complete`. `realizedByMonthBasis.beforeWindowUsd` states what falls outside, so a calendar that does not sum to the lifetime figure is explained rather than puzzling. **§3** |
| **A4** | no dollars-in or dollars-out on any coin | `costUsd` and `proceedsUsd` per coin with quantities, coverage and a reason when null. They are the quantity-weighted sums that already produced `avgEntryPrice`, so they reconcile with it exactly. **§3** |
| **A8** | `aum.chains` listed the newest reading's chains, so chain switches were drawn from one reading | `knownChains[]` on `/aum`, `POST /traders/aum`, `/wallets` and `?include=wallets`: every chain traded on, held on, or with balance history, each with `wallets`, `hasPositions` and `historyState`. Window-independent. 117 ms for fifty traders. **§9** |
| **A13.3** | no way to say "114.09 BNB" beside "$83.6K" | `nativeAmount`, `nativeSymbol`, `nativeUsd` and `nativePriceSource` per chain on `/portfolio.byChain`. **§2** |
| **A9** | `sample: { returned, storedAt }` left it unclear whether 363 was a whole record or a slice | `complete`, `capped`, `unit`, `positionsStored`, `reportedTrades`, `loadedAt` and `nextLoadAt`. 363 positions against 4,745 reported fills is two units counted, not a gap, and the response now says so. **§3** |
| **A7** (what the data supports) | no realised figure stated whether fees were included; volume existed only as a lifetime total | `includesFees: false` on every realised window with the reason stated once in `fees`, and **volume measured per window** — both legs of each round trip, with coverage. **§3** |
| **A13.4** | unclear whether `/trust.flags` included any blacklist check | a `checks` block: the five consistency checks it performs, and `blacklist.checked: false`. An absent blacklist flag means **not checked**, never *checked and clear*. **§4** |

**Two of these could not be answered the way the report hoped, and say so on the response.**

- **A13.3 answers `null` on three of five chains.** The rate has to be a market price, and the
  only figures we hold for BNB and for ETH on base and ethereum are `fomo_reported_entry` —
  what a trader said they paid — plus rows carrying a price with no source at all. One chain's
  WETH rows range $1,885 to $2,931. `whyNoNative` names the reason rather than converting a
  portfolio at a number nobody can defend.
- **A4's larger half needs data that is not stored.** The report hoped the valued transaction
  legs would fill entry cost. Those valued legs are Solana-only: 109,874 of 936,792 on solana,
  and none at all on robinhood, bsc, base or ethereum.

**A7's fee figures and the per-buy breakdown in A4 are not here**, and no field pretends
otherwise: no fee or gas column exists on any trade or transfer in the store.

---

## Appendix A4 · The version 8 report, and what changed (2026-09-14)

The consumer read all 435 traders through the batch call and reported what version 8 still got
wrong. The three ranked first are below, with the measurement that settled each one. A fourth —
chains answered on sampled points — was closed by the same work as **A2**.

| # | What they asked for | What was wrong | What changed |
| --- | --- | --- | --- |
| **A1** | Say how fresh an answer is, and put the same `asOf` on every route | **432 of 435** answers said `status: "ready"` while the newest balance reading anywhere was **75 hours old**, and nothing in the response said so. seven routes carried no `asOf` at all, the two batch calls among them | every route carries `asOf`, including both batch calls, which date the whole batch beside `limit` and `asked`. The balance series carries a `sampler` block — `state`, `lastSuccessAt`, `nextExpectedAt`, `ageSeconds`, `staleAfterHours` — and answers `status: "stale"` rather than `ready` once readings pass the stated 36-hour allowance. `/health` gives every feed its own allowance and a verdict, with `dataState` and `staleFeeds` naming what stopped. **§0f** |
| **A2** | Choose `now` from the most complete recent reading, not the newest | `now` for `@unipcs` was **$5,101,125.87** from a rebuild covering **1 of his 5 chains**, taken eight hours after a measured reading of **$15,665,318.55** and against a portfolio route saying $15.8M. The figure read first was a fifth of him, presented as all of him | `now` is the widest-coverage reading inside 36 hours of the freshest, measured beating rebuilt at equal coverage and recency breaking ties. It carries `partial`, `chainsAnswered`, `chainsTotal` and `ageSeconds` at the place it is read. `chainsAnswered` / `chainsTotal` are filled on sampled points as well as rebuilt ones — **723 of 872**; the remaining 149 stored no chain split at all, so the count is `null` rather than invented. **§9** |
| **A3** | Value both kinds the same way; failing that, mark every change of method | two neighbouring points could be valued over different sets of chains and the difference printed as a move in the balance. `@fhn_gt` read $65,367.54, then $33.26, then $52,276.29, and a card said "+155,855.5% in 7 days" | `breaks[]` marks every step whose two figures do not count the same thing, and marks **more** than was asked: of the **865 of 1,418** steps that move a line by half or more, 542 change method and **226 more keep the same method and change only the chain set** — both of `@fhn_gt`'s first two steps among them. Marking either catches **768 of 865**. Each point also carries `chains[]` and `comparableWithPrevious`. **§9** |

**On A3's first preference, valuing both kinds the same way.** It was attempted and measured
rather than declined. Per chain, a rebuilt point prices about **39%** of the positions and a
sampled one **77–84%**, and the steps that cross between them are where the cliffs sit — 60% of
sampled-after-rebuilt and 74% of rebuilt-after-sampled, against 14% of sampled-after-sampled.
Valuing every point over the chains they all share removes the chain-set cliffs and leaves the
coverage ones: **548 of 1,074** steps still move by half or more. A column named "comparable"
that is wrong half the time is worse than none, so `comparability` states plainly that the two
kinds are marked rather than equalised, and `breaks` is where they are marked.

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
