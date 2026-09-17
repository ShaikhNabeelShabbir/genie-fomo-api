# Genie API v2 — status for the app team

**As of 17 September 2026, 12:20 UTC.** Written to be read by a person or handed to a coding agent.

Base URL: `https://genie-copy-trading-api.agent-73b.workers.dev/v2`
Spec: `docs/openapi.yaml` in the handoff bundle. Field words: `GET /v2/fields`. Contracts: `Field_Contracts.md`.

---

## 1. Read this first

Four things changed since the v3 report.

**The database moved to Cloudflare D1.** v2 no longer touches Supabase, Postgres or Hyperdrive. The
API surface, the route list and every field name are unchanged. `GET /v2/health` now reports
`source: "cloudflare d1"` and the per-route provenance strings read `d1 · …` where they used to read
`postgres · …`. If you assert on those strings, update the expected values. Nothing else about the
contract moved.

**On-chain swaps were silently broken and are now fixed.** Every EVM swap batch had been failing
since the loader first ran, which is why `/trades` and `/events?kind=swap` stopped at 14 September
12:41. Swaps now resolve and the feed is current. The backlog is still draining, so per-trader
counts will keep climbing over the next day.

**The suspect-price rule now applies to totals.** Absurd prices no longer inflate
`totalValueUsd`. cupseyy reads `$3,600.97` instead of `$2.5B`, with the excluded value reported
separately as `suspectUsd`.

**Native ETH and BNB are priced, and BNB-paid swaps carry a dollar value.** Both had the same
cause, described in §5. 36,526 of 36,689 stored swaps now carry `valueUsd`, up from 19,630.

What to re-test: anything that reads `/trades`, `/events?kind=swap`, `totalValueUsd`,
`suspectUsd`, `priceSource`, `coverage.chains`, `valueUsd` on trades, native positions, or
`/health.source`.

---

## 2. Bugs found and fixed today

**Every Bitquery error message was being swallowed.** Bitquery answers a failed GraphQL query with
HTTP 200 and a body whose `data` is null. Our client treated a null `data` as a malformed reply and
threw a generic "unexpected reply shape", so the actual message never reached a log. Three separate
failures hid behind that one string for days.

**The swaps loader asked for a field that does not exist.** It requested `Currency { Native }` on
Bitquery's DEXTrades cube. Only the Balances cube defines `Native`; DEXTrades rejects the whole
query. Result: 8,000 candidate transactions failed per run on Ethereum, BSC, Base and Robinhood,
and zero EVM swaps were ever written. Solana was unaffected because it resolves through Helius.
Native currency appears as `SmartContract: "0x"` in DEXTrades, which the decoder already handled,
so removing the field was the entire fix.

**Bitquery rate limits were being tripped and read as failures.** The client paced requests for a
per-second limit while the plan enforces a per-minute one. Requests are now paced at roughly 50 a
minute and a rate-limited reply is waited out rather than counted as an error.

**Job error counts conflated three different outcomes.** "A source failed", "a source answered
nothing is here" and "we do not cover this chain" were all counted as errors. 694 of them in one
run looked like a broken loader and tripped a guard that aborted the job before its later phases
ran. Failures and unresolved items are now counted and reported separately.

---

## 3. Status of the v3 fix request, in your order

| # | Item | Status | Where to check |
|---|---|---|---|
| V1a | Suspect prices counted in totals | **Fixed** | `/traders/cupseyy/positions` → `totalValueUsd` 3600.97, `suspectUsd` 2919502387.63, `partialReason` `price_suspect` |
| V1b | cupseyy's $28k coin not flagged | **Fixed** | Same response, `entries[].priceSuspect` true with `priceSuspectReason` `no_market_over_ceiling`; `coverage.suspectPositions` 3900 |
| V1c | `priceSource` always null | **Fixed, still filling** | `/traders/gmgn_0xf1d07077/positions` → `priceSource` `pegged` / `token_info` with `pricedAt`. 81,527 of 314,534 stored holdings rows carry it so far, about a quarter; the balances loader rewrites the rest over about a day |
| V1d | Rebuild affected AUM | **Fixed** | `/traders/cupseyy/aum/now` and `/aum/history` apply the same rule |
| X1 | Swaps frozen at 14 Sep 12:41 | **Fixed, backlog draining** | `/health.feeds.swaps` state `current`, newest swap today. Per-trader counts still catching up, see §6 |
| X1b | No swaps clock in `/health` | **Fixed** | `/health.feeds.swaps` exists with a 6-hour threshold; `feeds.trades` now carries a description saying it measures fomoapi trade records |
| X1c | `/events?kind=swap` empty | **Fixed** | `/events?kind=swap` returns rows |
| X2 | BNB/ETH-paid swaps have no `valueUsd` | **Fixed** | `/traders/feibo03/trades` → `valueUsd` 504.42 with `valueSource` `money_side_daily_close`. 163 of 36,689 swaps remain unvalued, down from 15,038 |
| N1 | Native ETH and BNB never priced | **Fixed, still filling** | `/traders/tdmilky/positions` → native ETH 9.5528 at 2444.29 with `priceSource` `token_prices`. Each trader's native balance is priced as the balances loader sweeps them |
| Z1b | `$0` reported with "1 of 1 priced" | **Fixed** | `/traders/gmgn_0xcb4d28c2/aum/now` → `totalUsd` 16.13 with 122 of 185 priced |
| R5b | Newest valued history point `$0` | **Fixed** | Same rule; a sub-cent value is no longer rounded to zero in storage |
| T1 | Stale scorecards never reloaded | **Fixed** | `/health.staleTraders` → `scorecardStale` 1 of 446, down from 16. `scorecardLoadFailed` and `scorecardNeverAttempted` are now separate counts. smokey0x `loadedAt` 17 Sep 06:00 |
| T3 | On-chain fallback dishonest | **Fixed** | `/traders/smokey0x/scorecard` → `staleness.fallback` null, `fallbackReason` null, instead of claiming coverage from 4 rows |
| X3 | "18 Sep" stop date | **Fixed** | Sampling stopped **17 Sep 2026 at about 03:52 UTC**. The handoff bundle is corrected |
| P1 | `openPositions` doc wrong | **Fixed** | `openPositions` counts trade records. `openPositionsHeld` is the figure that matches `/positions`. `openPositionsBasis` says which |
| R6 | `coverage.chains` empty | **Fixed for EVM** | `/traders/gmgn_0xf1d07077/positions` → `coverage.chains.bsc` has `chainTxCount`, `rowsHeld`, `share`, `readAt`, `basis: bitquery_realtime`. Solana-only traders still return `{}`, see §6 |
| H1/V2 | `trancey`, `Lasercat397` 404 | **Answered, not a bug** | `Lasercat397` is the display **name** of trader `397397`; look it up by handle or id. `trancey` has never appeared in the directory |
| G2 | No token logo | **Open** | No `logoUrl` field is published yet. GMGN's document is stored, DexScreener's image URL is dropped at parse |
| B3 | Same-day retries invisible | **Answered, closed** | Refused readings were overwritten by design and sampling has stopped, so no retry can be shown |
| L2 | Slow reads | **Improved, not closed** | The routes that timed out now answer. `/tokens` 8.7 s and `/market/regime` 9.7 s are still slow, see §6 |
| — | Wallet submission secret | **Open, needs an ops step** | `POST /traders/:handle/wallets` answers 503 `not_configured` until `WALLET_SUBMIT_SECRET` is set on the Worker |

---

## 4. Status of your 11-point follow-up

| # | What you reported | Status now |
|---|---|---|
| 1 | cupseyy shows $2.5B | **Fixed.** `totalValueUsd` 3600.97, the rest in `suspectUsd` |
| 2 | shahh got worse | **Fixed.** `totalValueUsd` 19596.04, `suspectUsd` 14784009.35 |
| 3 | Swaps stop 14 Sep | **Fixed.** Feed current; per-trader backlog draining |
| 4 | BNB swaps unvalued | **Fixed.** WBNB-paid swaps carry `valueUsd` and `valueSource` `money_side_daily_close` |
| 5 | ETH and BNB unpriced | **Fixed.** ETH 2444.29, BNB 725.90, SOL 100.31, with 367 days of daily closes behind them |
| 6 | `priceSource`, `coverage`, logos blank | **Two of three fixed.** `priceSource` and `coverage.chains` populate on EVM traders. Logos are not published yet |
| 7 | `/v2/tokens` timed out | **Fixed.** Answers in 8.7 s. Still slower than we want |
| 8 | 397397 figures disagree | **Needs your retest.** The swap backlog was the likely cause and it is now draining. Re-run the comparison in a day |
| 9 | smokey0x shows 4 swaps | **Cause found, filling.** The profile counts 1,258 on-chain swaps and `/trades` resolves 4. The EVM resolver only began working today; this number climbs as the backlog drains |
| 10 | Reads slower than v1 | **Partly.** No route times out now. `/tokens` and `/market/regime` remain around 9 s |
| 11 | Python user-agent refused | **Not reproducible.** `python-requests/2.31.0` and `aiohttp` both get 200 from v2. Retry and send us the request id if you still see it |

---

## 5. What actually caused the two pricing gaps

Both N1 and X2 came from one thing: **Binance answers HTTP 403 to every request from our Cloudflare
Worker.** It refuses Cloudflare's egress addresses. Binance was the only source of daily closes for
the quote assets, so ETH, WETH, BNB and WBNB had no price for any day, and every run recorded ten
failed fetches that nobody had read.

Everything downstream was already built correctly and was simply starved:

- A native ETH or BNB balance had no price to find, so `priceUsd` was null. That was N1.
- A swap paid for in WBNB had no way to value its money side, so `valueUsd` was null. That was X2.

Bybit serves the same pairs, and its candle rows put the open time and the close at the same
positions a Binance kline does, so the existing parser reads them unchanged. Binance is still asked
first and the fallback is logged, so a price can always be traced to the exchange that gave it.

Result: all ten quote assets now carry 367 days of closes to today, and the re-pricing pass valued
15,305 stored swaps in one run.

---

## 6. Known limits and what is still filling

**The swap backlog.** 1,779 swaps were resolved in the first hour after the fix and about 9,000
candidates remain, with more arriving on every wallet read. Per-trader swap counts stay lower than
the profile's `onChain.swaps` until this drains. Expect a day.

**Token supplies.** 27,576 tokens have no total supply. Supply is what lets the implied-market-cap
check run, so a token without one can only be caught by the other suspect rules. Our Bitquery plan
allows about 50 reads a minute, so this fills over hours, valuable holdings first.

**Prices.** 20,678 tokens are queued for a price refresh, paced by DexScreener.

**Native balances.** 34 of 683 native positions are priced so far. The rest fill as the balances
loader sweeps each trader, over roughly a day.

**Balances.** 427 of 450 traders are queued for a fresh on-chain read. `priceSource` and
`coverage.chains` populate as each trader is swept, which is why a Solana-heavy trader like cupseyy
still shows nulls where an EVM trader like gmgn_0xf1d07077 shows values.

**Solana chain coverage.** `coverage.chains` is written from EVM wallet reads only, so a
Solana-only trader gets `{}`. Treat an empty object as "not measured", not as "zero coverage".

**Live AUM latency.** A watched wallet transfer marks the trader and a flush runs every five
minutes, 40 traders at a time. In practice a trader's `aum/now` refreshes within about ten minutes
of a transfer, not instantly. `now.ageSeconds` always tells you how old the figure is.

**Read speed.** `/tokens` and `/market/regime` take around 9 seconds. The 15 second route timeout
still applies. Cache these two if you poll them.

**`dataState` is `degraded`.** It means one thing right now: one trader of 446, `poker_kb_`, has a
stale scorecard. We ask fomoapi for it every six hours and fomoapi returns an empty document, which
we record as `loadOutcome: degraded`. That is a gap at the source, not a loader failure, and
`/health.staleTraders` now separates `scorecardLoadFailed` from `scorecardNeverAttempted` so you can
tell which. `staleFeeds` names what is stale. Do not treat `degraded` as an outage; `status` is `ok`.

**Occasional 503 under load.** D1 runs one query at a time, so while the loaders are working a read
can exceed its CPU allowance. You get a clean `503` with `code: "unavailable"` and
`retryAfterSeconds: 5`, not a broken payload. In a quiet minute every route answers; during a heavy
loader run we measured roughly one request in three failing this way on the heaviest route.
**Retry on `unavailable` with the delay we give you.** We are spreading the loaders to reduce it.

---

## 7. Data freshness right now

| Feed | Newest row | State |
|---|---|---|
| transactions | 17 Sep 11:51 UTC | current |
| swaps | 17 Sep 12:01 UTC | current |
| positions | 17 Sep 11:30 UTC | current |
| trades (fomoapi) | 17 Sep 11:10 UTC | current |
| aum (built history) | 17 Sep 06:00 UTC | current |
| aum_live | 17 Sep 11:54 UTC | 443 traders |
| traders, wallets | 16 Sep 10:33 UTC | current |
| scorecards | 1 of 446 stale | degraded |

Row counts: 446 traders, 443 wallets, 76,434 trades, 1,347,392 transactions, 110,761 holdings,
55,977 tokens, 36,689 resolved swaps of which 36,526 carry a dollar value.

---

## 8. Reaching v2

```
GET https://genie-copy-trading-api.agent-73b.workers.dev/v2/health
```

Every route is under `/v2`. The Worker refuses `/v1/*` with a 404 that points at `/v2`. Response
links are rewritten to the version you asked for, so you never need to rewrite them yourself.
`/v2/health.apiVersion` tells you which deployment answered.

Rate limit is 240 requests a minute. Batch routes exist for positions, prices, AUM, AUM history and
flow; prefer them over loops.

`GET /v2/fields` is the published word list. Any enum-like string we return appears there. If you
see a word that is not in `/v2/fields`, that is a bug on our side — send it to us.

v1 on Supabase still answers and is frozen. It is not being written to any more and will be retired
once you are fully on v2. Do not build anything new against it.
