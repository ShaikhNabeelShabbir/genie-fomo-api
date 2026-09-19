# Reply to "Trader service: fix requests" v1.0 — 19 Sep 2026

Answering `TRADER_SERVICE_FIX_REQUESTS_v1.0_2026-09-18.md` request by request. Your report was
right on every point, and two of the faults were ours from the v5 deploy. This reply also corrects
things we told you on 17 Sep that are no longer true, or never were (section 6).

**Deployed to v2 on 19 Sep 2026 between 12:17 and 13:20 UTC**, migrations `0007` and `0011`–`0015`
applied first. Every figure quoted below as current was read from production after the deploy.

**Requests 1, 2 and 4 are done.** We ran your verification block three times, a few minutes apart
(12:25, 12:28 and 12:36 UTC):

| Your check | When you wrote | Now |
| --- | --- | --- |
| `/traders?include=wallets,scorecard&limit=100`, offsets 0–400 | 500 × 4, then 503 | **15 of 15 answered 200**, 4.0–5.8 s each, 448 traders in all, a wallet on every trader |
| `/traders?include=scorecard&limit=100` | 500 / 503 | 200 in about 4 s |
| `/health` | 200 "ok" in 8.6 s while every read failed | 200 in 0.9 s, and it reports the database (section 4) |
| `/tokens/Lyi47…` (UBI) | 503 | 200 in 1.5 s |
| Requests over a 12-minute production tail | 18% failing | 1,068 of 1,075 answered; no database resets |

**Request 3 (GMGN) is NOT fixed, and we can now say why**: GMGN answers HTTP 429 to our Worker.
Section 3 has the detail and what we are doing about it.

**What we need from you:** re-run your block, then read sections 5 and 6 — five behaviours change
numbers on your side. Word list goes to **14** (you are on 11; 12, 13 and 14 are all additive).

---

## 1. The trader list with wallets failed on every page

**The cause was not the database connection.** Our database (Cloudflare D1) accepts at most 100
bound values in one statement. A page of 100 traders bound 100 handles plus one more value: 101.
The scorecard statement bound the page twice: 200. So `limit=100` failed every time and `limit=5`
never did. It had been that way since we moved to D1 on 17 Sep. We never saw it because every one
of our own checks asked for 1, 10 or 25 traders, and you ask for 100.

The 503s mixed in with the 500s were a second fault: the database was being reset by our own
heavy reads (section 2), and a reset kills every request in flight.

What we did:

1. Id lists now bind one value per id while the statement fits, and as a single JSON value when it
   would not. No list of any length can hit the ceiling again. A test runs your exact page at 100
   and at 200 against the real schema.
2. A page **with** includes defaults to 100 and is capped at 200 (`total` and `nextCursor` say when
   there is more). The plain list is unchanged: `?limit=500` still returns the whole directory.
3. Your request 1.3 — never a 500 when the database is down — is now the rule, in both directions
   (section 4).

**Your request 1.1 cannot be done, and that was our fault too.** The request ids you quoted were
never written to our logs: the id was created after the log line was written, and the query string
was not logged at all. From this deploy every 5xx is logged with the same id it returns, the method,
the path and the query string, and every response — success included — carries `x-request-id`.

## 2. Scorecards, the scorecard board, the coin board and the AUM warm-up

Same two faults as request 1, plus the load that caused the resets. With statement timing now in
our logs we could name the statements within two minutes of deploying:

| Statement | What it read per call | Now |
| --- | --- | --- |
| `/positions` (your most frequent call) | about 550,000 rows, 1.8 s of database time | reaches its rows through the wallet |
| `/aum` and `POST /traders/aum` (your warm-up burst) | 2.3–2.5 million rows | the asked traders drive every statement |
| `/traders/:handle/wallets` and the profile | three whole tables | one index seek per chain |
| `/tokens/:address` | whole `trades`, `holdings` and `trader_stats` | reaches its rows through the coin |
| our own half-hourly swaps job | 1.7 million rows per chain, up to 19.6 s | 50,001 rows in 1.2 s (measured 14:15 UTC) |

The last row matters to you: for about 30 seconds at :15 and :45 every request queued behind that
job. If you saw failures cluster at those minutes, that was it.

**Your request 2.2:** the scorecard loader was healthy throughout. Its last successful load before
your report was 2026-09-18T12:01:45Z, 79 traders. The scorecards were there; the route could not
read them.

**AUM warm-up.** `POST /traders/aum` went from 9 statements per call to 7, so your 36-call burst is
252 statements instead of 324, and none of them now reads millions of rows. If you can spread the
36 calls over a few seconds rather than firing them at once, do: our database runs one statement at
a time, so a burst queues behind itself.

## 3. GMGN coin details are 9 days old

**Not done. Two faults, and we have fixed only the one that was ours.**

**The one that was ours.** The job's queue put never-read coins first, and a read that found
nothing left no trace — so the head of the queue was permanently coins GMGN has no document for,
asked again on every run. The reason for each failed read was also dropped before it was logged, so
the log said only "returned nothing" and we could not see the second fault at all. Both are fixed:
a coin GMGN has nothing for is parked for 7 days, each run is split between the most-held coins that
are due and the coins that have waited longest, and every refusal is logged with its reason.

**The one we found by fixing that.** On the first run with the reason logged (14:05 UTC today)
**GMGN answered HTTP 429 to the first five reads** and the job stopped, as it now does after five
refusals in a row. GMGN's limit is one request a second **per IP**, and a Cloudflare Worker shares
its outgoing IPs with other customers — so the limit is spent before we ask. That, not our queue,
is why nothing has been read since the move to Cloudflare; the last successful reads (9 Sep, and
16 Sep for a few coins) were made by the old loader, which ran from its own machine.

**What we are doing.** We will run the GMGN reader from an address of our own, or get an allowance
from GMGN that is tied to our key rather than to an IP. We will tell you when the first run lands;
until then `fetchedAt` will not move, and `/health` says so (`feeds.tokenInfo: stale`, 12,524 of
31,522 held coins stale, 18,998 never read).

**What it will deliver when it runs.** One request a second, two requests per coin: roughly 1,100
coins a day against 31,522 held. So coins held by several traders stay under about a day old and a
coin held by one trader is refreshed every few weeks. Your done-criterion — every coin under a day
old — is not reachable at GMGN's rate, and we should have told you so instead of writing "nightly"
in the API reference. That sentence is gone. Each coin's own `fetchedAt` is the truth; please keep
printing it. If a specific set of coins must stay fresh, tell us the rule and we will rank by it.

**Your request 3.3 — Robinhood Chain.** GMGN does cover it: JUGGERNAUT carries details. PAIDCAT has
none because it had not been reached.

## 4. Smaller items

**The health check.** `/health` now reads one stored row under a 2-second deadline, and that read
is the probe: `database: { answering: true, latencyMs }`. If the database does not answer, the
route answers **503** `unavailable` with `error.database.answering: false` — not a 200. The heavy
body is computed by our scheduler every 10 minutes (`computedAt`, `computeMs`, `cacheAgeSeconds`).
New in `staleFeeds`: `prices` (no hourly price written for 3 h) and `scheduler` (the snapshot is
older than 30 minutes, meaning our jobs have stopped). `tokenInfo` is now judged on the coins your
traders hold, which is why it reads `stale` today — correctly.

**The plain list.** One correction to your report: `/traders` without `include` was never a saved
copy. `capturedAt` is the stamp of the daily leaderboard build (01:00 UTC); the rows were read live
each time. So it would have failed too in a full outage. It now goes through a cache that keeps
serving its last good answer when the database throws or stalls for 3 seconds, which is what your
cold-start fallback (your change 2) needs. One limit: the cache lives in a running instance, so an
instance that has never answered the list has nothing to fall back on.

**Status codes, now one rule:**

| Code | Means | Do |
| --- | --- | --- |
| 500 `internal_error` | a fault in our code or SQL; retrying cannot help | report the `requestId` |
| 503 `unavailable`, `Retry-After: 5` | the database is not answering | retry after 5 s |
| 503 `unavailable` or `timeout`, `Retry-After: 15` | the database is busy, or the request ran out of time | retry after 15 s |
| 429 `rate_limited` | your own 240/min window, and nothing else | back off as stated |

Until today a busy database was answered as 429 beside `RateLimit-Remaining: 240`, and a fault in
our own SQL was answered as 503 "retry shortly". Both were wrong, and the second is how `/portfolio`
looked like an outage for two days (section 6).

**The request ceiling is now 11 seconds for the whole request**, rate check included. It was 15 s
for the route alone, so with your 12 s deadline you never saw our coded answer — only your own
timeout.

## 5. Five changes that move numbers on your side

1. **A stale price no longer prices a position.** The hourly price is used for 24 h and a GMGN
   price for 7 days; past that, `priceUsd`, `priceSource`, `pricedAt` and `valueUsd` are `null` and
   the row leaves the totals. While DexScreener refused us (17–19 Sep) the top rung served
   days-old prices as current. `/aum/now` follows the same rule, so `now` and the hourly chart
   agree again. One exception: a row priced from the directory's reported entry
   (`fomo_reported_entry`) keeps that price.
2. **The coverage rule now applies to daily, weekly and monthly history** — the default step for
   `window=1m` and longer. We told you on 17 Sep it judged the whole stored series; it judged only
   the hourly one. Buckets built from under-covered hours lose those hours; a bucket made only of
   them reads `totalUsd: null`. Rollup points now carry `pricedShare`, `partial` and `partialUsd`.
3. **The hourly series has one writer.** The live refresh no longer writes the current hour, so
   between :00 and :25 the newest stored point is the previous hour and `now` carries the live
   figure. This is the last piece of the $2.5 billion hour (V1d): the live refresh was still
   writing hours with GMGN's undated price. Hours written before this deploy are not rewritten
   yet; tell us if you still see one and we will rebuild that trader.
4. **Scorecard month-start capital** (`startCapitalUsd`, `returnPct`) is now built from the hourly
   history instead of a sampler that was retired on 17 Sep. September's figure may move once.
   Without this change every trader's October would have been `null`.
5. **`/aum`** no longer answers `status: warming`, and `sampler.nextExpectedAt` is `null`: no run is
   scheduled, because the sampler is gone. Read `/aum/history` and `/aum/now`.

Smaller: `/events` cursors are four-part now (a page boundary that split a transaction used to drop
its remaining transfers; old cursors still work and re-deliver rather than lose). `/trades` answers
400 for an unreadable `since`/`until` or an unknown chain, where it used to answer an empty 200.

## 6. Corrections to our reply of 17 Sep

| We said | The truth |
| --- | --- |
| **A2 is met: no live figure older than about an hour** | **Withdrawn on 19 Sep.** The hourly refresh of every trader ran 4–10 minutes on a 5-minute schedule and was resetting the database, so we switched it off. A live figure now refreshes within about 5 minutes of a watched Solana wallet moving, and when the balance sweep reads the trader (about 9 h a lap). `oldestLiveHours` rises by design and `liveStale` is not a fault signal. |
| `/portfolio` was unchanged | **Our v5 change broke it**: a missing join made every call fail from 17 Sep to 19 Sep 09:03 UTC, served as 503 "retry shortly". |
| The Solana history walk completes within 7 days | It will take far longer. Walking every wallet every hour doubled our Helius use and two days later Helius refused every balance read, so the walk is now 3 wallets an hour. `truncated` will keep appearing; we will give you a date when we have measured a week of it. |
| Every enumerated value is published by `/fields` | 17 word sets the routes already emitted were missing, among them `/trades` `incompleteReason`, the trust and security verdicts and flags, and `tier: third_party`. Version 14 publishes them, and a test now holds the API reference and the word list together. `positions.liveBasis.evm` still answers `nightly_read`, which was never true here; version 14 publishes its replacement `rolling_read` and the route will switch in a later version. |
| GMGN details refresh nightly | See section 3. |

## 7. What is still open on our side

- **Helius answers 429** to balance reads and swap parsing. We believe the key's credits were spent
  by our own over-pulling, which is fixed; the owner is checking the dashboard. Until it recovers,
  Solana balances and new swaps lag. `/health` shows it (`feeds.positions`, `feeds.swaps`).
- **DexScreener refuses most of our price reads**, for the same reason GMGN does: its limit is per
  IP and our Worker's addresses are shared. The refusal is Cloudflare's "you are being rate limited"
  with a wait of 24–46 s. Prices were last written for the 11:00 UTC hour today; the 12:17, 13:17 and
  14:17 runs were refused. The job now waits exactly as long as it is told and tries again (it used
  to ask a thousand more times), and prices the most-held coins of every chain first. **This matters
  with change 1 in section 5**: a price older than 24 h prices nothing, so if the refusals last a
  day, position values will read `null` rather than a stale figure. `/health` shows it as
  `staleFeeds: prices`. Moving the price reader off shared addresses fixes this one too.
- **ETH, WETH and BNB prices**: Binance refuses our Worker and Bybit refused it today; Kraken is now
  the third source, and each price row names the exchange that produced it.
- The roster page takes 4–6 s. It is inside your deadline; we know where the rest of the time goes
  (it ships about 30,000 trade rows to build one page) and it is next.

## Verify the deployment

Your own block, unchanged, is the right check:

```
B=https://genie-copy-trading-api.agent-73b.workers.dev/v2
for o in 0 100 200 300 400; do curl -s -o /dev/null -w "$o %{http_code} %{time_total}s\n" "$B/traders?include=wallets,scorecard&limit=100&offset=$o"; done
curl -s -o /dev/null -w "%{http_code}\n" "$B/traders?include=scorecard&limit=100&offset=0"
curl -s "$B/tokens/Lyi47medADEVDd5hxJo1mbxhnBct841sFpcGRyHTuwp" | grep -o '"fetchedAt":"[^"]*"' | head -1
curl -s -w "\n%{time_total}s\n" "$B/health"
```

Expected: five 200s, each under 8 s; 200; a `fetchedAt` that has NOT moved yet (section 3);
`/health` under a second with `"database":{"answering":true,…}` and `dataState: "degraded"` naming
`scorecards` and `tokenInfo`.

If any read disagrees with this, send us the `x-request-id` — this time we can find it.
