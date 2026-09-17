# Reply to fix request v5 — 17 Sep 2026

Answering `genie-fomo-fix-request-v5-17-sep.md` ask by ask. Thank you for the appendix: every
read in it was reproducible from the figures you gave, and four of them found the bug directly.

**Everything below is written and verified in the branch, not yet deployed.** The deploy needs
one D1 migration (`0005_solana_backfill_cursor.sql`) that must land first. We will confirm the
deploy time separately.

**Vocabulary goes to 12.** Three new words — `token_price_stats` (`positions[].priceSource`),
`not_built` (`aumHistory.points[].reason`), `truncated` (`trades.coverage.byChain[].state`).
**Three fields are renamed**: `coverage.chains.*.share` → `rowsPerSentTx`,
`coverage.chains.*.rowsHeld` → `transferRowsHeld`, `onChain.swaps` → `swapsAppearedIn` (plus a
new `onChain.ownSwaps`). Those three are the only breaking changes; everything else is additive.

---

## The short version: five of your top asks were one bug

V1d, A1, N1 and R7 are the same defect. **We had three different price ladders**, and
`/positions` served a price that was frozen into the row at the trader's last balance read:

| reader | ladder |
|---|---|
| `/positions` rows | pegged → `token_info` (GMGN) → newest `token_prices` close, **any age** — written at read time, then frozen |
| `/aum/now` | pegged → `token_price_stats` → `token_prices` close ≤ 7 days → `token_info` |
| `/aum/history` past hours | pegged → hourly sample ≤ 24 h → **that day's** close → `token_info`, current hour only |

The balance sweep is 25 traders twice an hour against 450 traders, so a row's price could be
nine hours old — and anything priced after the read stayed `null` until the next one.

Here is that bug in one query, on the token you asked about in U1
(`0xdad7e20952787599f3054d617fa11c224846ac70`). Every trader below holds **the same amount of
the same coin**:

| traders | stored `price` |
|---|---|
| visi235, smokey0x, unipcs, … (28 of them) | 0.000004391 |
| lp1111, kyle, midcurver, … (15 of them) | 0.005436 |
| 397397, aki11a, frankdegods, … (32 of them) | `null` |

Three prices for one coin, decided by when each wallet happened to be read.

**The fix is one price ladder, read at request time**, shared by `/positions`, the batch,
`/portfolio` and the live valuation:

> `pegged` → `token_price_stats` (the hourly DexScreener price) → `token_prices` (newest daily
> close **inside 7 days**) → `token_info` (GMGN, demoted to last: it carries no staleness stamp
> we trust). `fomo_reported_entry` survives only when no rung has a price.

---

## 1. cupseyy's balance and history — V1d, A1

**Your reading was right, and the cause is not what our status implied.** cupseyy has **no
sampled readings at all**: every hour of his is `basis: priced`, built from holdings. What
moves is how many of his 11,278 coins carried a price in the hour we built it:

| hour (17 Sep) | 06:00 | 07:00 | 08:00 | 09:00 | 10:00 | 11:00 | 12:00 | 13:00 |
|---|---|---|---|---|---|---|---|---|
| `totalUsd` | 344.40 | 2,509,077,756 | 1,685.57 | 1,685.57 | 1,682.20 | 2,950.13 | 229,388.66 | 229,589.32 |
| priced of 11,278 | 118 | **5,082** | 187 | 187 | 187 | 1,131 | 193 | **1,135** |

The $2.5B hour is the 5,082-priced hour. The 78× jump between 11:00 and 12:00 is a coverage
jump, not a balance change. **These hours are not comparable with each other**, and we
published them as though they were.

- **A1, which coins make up the $229,589 — fixed, and you can now read it off the list.** With
  one ladder, `/positions` and `/aum/now` are built from the same priced coin list and the same
  quantity (`amountLive ?? amount`), so his list's top rows *are* the answer. The $3,600.97 was
  the frozen-price list; it will not appear again.
- **A1, one `asOf` — fixed for `/positions` and `/aum/now`.** Both read `holdings_live`, both
  price at request time. The batch `POST /traders/positions` still reads `holdings_current`
  (rolling Solana forward for 50 traders at once exceeds D1's per-query CPU limit) and says so
  with `tier`; it uses the same ladder.
- **V1d, rebuild 07:00, 12:00, 13:00 — fixed, and for every hour at once, with no rebuild.**
  See §2: the rule is applied when we serve the row, not when we build it.

## 2. The sawtooth and the missing hours — A4, A3, A2

- **A4 — fixed.** Your instinct that "two builds take turns" was right; the mechanism is
  coverage, not two builders. 397397's `01:00` is `basis: reading`, **217 of 279** priced,
  $351,321.95. His `00:00` is `basis: priced`, **2 of 289** priced, $43,780.82.

  **Which figure is his?** Neither, as published. $43,780.82 is 0.7% of his wallet. The ~$354,000
  hours are 78% and are the better figure, but they come from the retired sampler and will not
  recur. The honest answer is the coverage, so we now publish it on every point.

  The old rule refused a figure only when coverage was under 25% **and** the total was under
  $100 — so any figure over $100 was published whatever the coverage. Measured across
  `aum_history`: **25,492 of 32,866 valued hours, 78%, came from under a quarter of the wallet.**

  Every point and `now` now carry `pricedShare`, `partial` and `partialUsd`:

  | `pricedShare` | what you get |
  |---|---|
  | ≥ 0.25 | `totalUsd`, `partial: false` — a figure |
  | 0.05 – 0.25 | `totalUsd`, **`partial: true`** — real and drawable, not a balance. Label it |
  | < 0.05 | `totalUsd: null`, `reason: "too_little_priced"`, **`partialUsd`** keeps what it would have been |

  `partialUsd` is never a balance. The rule runs at read time on counts every stored row already
  carries, so **the whole stored series is judged by it the moment this deploys** — nothing is
  rebuilt and no hour has to wait.

  Your own guards can come off in this order: the $1B ceiling and the "one hour below a
  fiftieth of its neighbours" rule are both subsumed by `pricedShare` — drop them once you see
  `partial` arriving. Keep the flagged-coin and dollar-coin guards; those are yours, not ours.

- **A4, other traders with the same pattern — checked.** It is not a three-hour cycle; it is
  every trader whose priced count moves between builds. The coverage fields make it visible on
  every point rather than something you have to infer from a chart shape.

- **A3 — fixed.** 397397's 08:00 and 09:00 were absent from `points[]`, not null. Every hour
  between the first and last point we hold that carries no row is now a null point with
  `reason: "not_built"` (new word). Hours *before* the first point are still absent: we were not
  tracking him then, and inventing them would claim knowledge we do not have.

- **A2 — fixed.** The live catch-up was the tail of the hourly history job, guarded by
  "while budget remains". The backfill loop above it spent the budget, so the catch-up was
  reached only when there was nothing to build — and a trader the webhook never sees move is
  exactly the one it exists for. It now runs **first**, with a quarter of the job's budget
  reserved. `/health.staleTraders` gains `liveStale`, `liveStaleAfterHours: 1`, `liveNever` and
  `oldestLiveHours`, so you can hold us to it.

## 3. ETH and BNB — N1: fixed, and no sweep needed

The native rows were never a loader problem. The hourly price job excludes natives by design,
so their only price is the daily close in `token_prices` — which **exists**, and which
`/positions` could not reach because it served the frozen row price.

Verified against production for the trader you named:

```
gmgn_0xf80d7961  ethereum native  1.1720  →  daily close 2026-09-17 = $2,450.22
```

With the request-time ladder that row prices on the next request. **The "427 of 450 waiting for
a fresh read" figure no longer gates anything** — there is nothing to wait for, and no reason to
re-order the sweep. gmgn_0x314e6555, gmgn_0xcb4d28c2 and gmgn_0xf1d07077 are the same case.

## 4. `complete` on partial swap lists — W2

- **`complete` — fixed.** It was `!capped`: a pagination fact. It is now false while the page
  was capped, while any chain the trader trades on is `unresolved`, **or** while any chain is
  `truncated`. A new `incompleteReason` names which (`page_capped`, `chains_unresolved`,
  `chains_truncated`, joined with `_and_`).

- **`onChain.swaps` — split, as you asked.** It counted transfer **legs** typed SWAP, with no
  `distinct tx_hash`, for every transaction this wallet appears in. So one trade counted several
  times, *and* other people's trades counted whenever this wallet received tokens inside them.
  Replaced by two fields:
  - `onChain.swapsAppearedIn` — distinct transactions typed SWAP that touched the wallet at all.
    The upper bound. This is the honest version of the old number.
  - `onChain.ownSwaps` — the wallet's own resolved trades, the same store `/trades` serves.
    **This is the trade count.** smokey0x's 1,260 was never comparable with his six rows.

- **smokey0x's Solana swaps after 6 Aug — found, and it is ours.** The transfer loader called
  Helius with `before = null` on every run and walked five pages of 100. It therefore re-read
  the newest **500 signatures** of each wallet for ever and never reached past them. On an
  airdrop-spammed wallet 500 signatures is a few weeks — your 6 Aug wall exactly. Nothing was
  missing from the chain; we had never asked for it.

  Fixed: the loader now walks **backwards** from the oldest signature we hold, one page a run,
  until Helius returns nothing. Until a wallet is finished, its Solana row reads
  `state: "truncated"` with `horizonAt` (the oldest transaction we hold on that chain), and the
  top-level `complete` is false. `horizonAt` is published for every chain.

  The backfill is bounded by Helius's pace: expect the active Solana wallets to be complete
  within **7 days of the deploy**, and we will tell you when `truncated` stops appearing.
  EVM chains publish `horizonAt` but cannot yet say `truncated` — we have no equivalent
  end-of-history signal from Bitquery. That is honest rather than fixed, and it is on our list.

## 5. Per-chain coverage — C1

**You are right that a share should not exceed 1. It was never a share.**

- `chainTxCount` — transactions the wallet **sent**, from Bitquery's *realtime* dataset, which
  is a window rather than chain history. A lower bound on the nonce.
- `rowsHeld` — transfer **legs** we store for that address on that chain. One sent transaction
  produces several. **Renamed `transferRowsHeld`.**
- `share` — the quotient of two different things. **Renamed `rowsPerSentTx`**, which is what it
  is: transfer legs per sent transaction. Values above 1 are correct and expected. Below 0.5
  still makes the list partial, unchanged.

**On the 200: there is no 200-row cap anywhere.** We checked the Bitquery balance query (no
`limit` argument at all), the parser (no truncation) and the writer (batching only, 80 binds a
statement). tdmilky reading 200 on BSC and gmgn_0xf1d07077 reading 200 on BSC is a coincidence
of `transferRowsHeld`, not a page size. The mismatches you spotted between `rowsHeld` and the
rows in the list are the same category error — one counts transfer legs, the other counts
positions held. They were never meant to agree, and nothing said so.

## 6. Speed and the 503s — L2, O2

- **L2, which code to expect — `timeout`.** `timeout` is ours: the route did not answer inside
  15 s and we cut it (`app.ts` races every handler). `unavailable` is the database refusing or
  dropping a connection. Both are 503 with `retryAfterSeconds: 5`, and you are already handling
  both correctly. Our status was wrong to describe the load failure as `unavailable`; under load
  you will see `timeout`, as you did in all five cases.

- **L2, `/health` from cache — already there, and it did not save you.** `/health` has had a 30 s
  per-isolate cache since before your reads. Your 13.78 s was a *cold isolate*: Cloudflare may
  start a fresh one at any moment, and that one pays full price for ~15 full scans. Your second
  read at 7.20 s was the same cache, warmer.

- **L2, `/tokens` from cache — fixed, with a caveat we want to state plainly.** `/tokens` and
  `/tokens/momentum` now cache per query string for 60 s. **This does not save the first caller
  into a cold isolate**, and `/tokens` is the worst case in the service: it aggregates the whole
  holdings view before any limit applies, so `?limit=5` costs exactly what `?limit=500` costs.
  That is why it never answered for you. The real fix is the query, which is item 6 of our own
  efficiency review; **planned, 24 Sep**. Until then, a retry after a successful call will be
  instant and a first cold call may still time out.

- **O2, the 07:39–09:52 outage — answered.** That window is the D1 cutover itself. Three things
  overlapped: the Worker was redeployed repeatedly as the loaders were ported; the Helius
  receiver revalued the **whole roster** on every push, which at 40 pushes a minute took D1 to
  26 s a query; and `holdings_current` aggregated the whole table before the caller's filter, so
  one trader's read touched 252,975 rows and four concurrent traders exceeded D1's per-query CPU
  limit. All three were fixed by 10:49 that morning: the receiver now only marks traders dirty
  and a cron revalues them in slices, connections are capped at 2 per client, and the view was
  rewritten as a correlated maximum an index can seek. It was not a provider outage and it was
  not capacity — it was us, during the migration, and we should have told you before you asked.

## 7. The remaining v4 asks

- **R7, Robinhood-chain prices — fixed by the ladder.** The coins *were* being priced hourly:
  the DexScreener job covers every chain including Robinhood and writes `token_price_stats`.
  `/positions` simply had no rung that read it. `priceSource: token_price_stats` is the new word
  you will see on those rows. Cadence: hourly, most-held tokens first, the dust tail rotating by
  staleness — about 20k of 26k held tokens an hour. A Robinhood coin still on a bonding curve
  with no pool has no price from any source, and stays null.

- **H2, `canSell` on honeypots — fixed.** `canSell` is now false whenever `isHoneypot` is true.
  It previously negated the separate `can_not_sell` column alone, so the two fields contradicted
  each other on the same coin. Still `null` when no security source has judged it. Thank you for
  the correction on the totals — your reading of `unsellableUsd` was right and ours was not
  clearly documented.

- **E1, the EVM read interval — 25 traders at :03 and :33, so 50 an hour, ~9 hours for 450.**
  That is the regular interval today, not a backfill rate; it is set by Bitquery's per-minute
  pacing and a measured 9-minute run. `liveBasis.evm` still reads `nightly_read`, which is now
  wrong by a factor of twelve — **we will correct that word in vocabulary 13**; it needs a
  vocabulary bump so we are not shipping it inside this change.

- **U1, `0xdad7e20952787599f3054d617fa11c224846ac70` — checked. The flag is correct.** It is
  ARCCoin (ARC) on the Robinhood chain and it *does* have a pool: Uniswap v2 against WETH,
  pair `0x2131B1BC5aE07C664b596eE1918364f6413F4B0c`. **The pool holds about one cent.** Our
  hourly sample records `liquidity_usd: 0.01`. A 7,835,500-token position priced at $0.005436 is
  $42,592 against a $0.01 pool, so `no_market_over_ceiling` fires at more than ten times the
  pool, which is exactly what that rule is for. Keep refusing it.

## 8. Small things

- **X3 — fixed, and you found a real contradiction.** `/health.feeds.aum` was still watching
  `aum_samples`, the retired hourly sampler, whose last reading is 17 Sep 06:00 and last run
  06:29 — exactly the figures you saw. It now watches `aum_history` (`newestReadingAt`,
  `lastBuiltAt`) and `aum_live` (`newestLiveAt`), which are what write the hours after 06:00.
  The sampler's own clocks move to `feeds.aum.sampler` with `retired: true` and
  `retiredAt: 2026-09-17T03:52:00Z`. **Both your figures were right; the field was pointed at the
  wrong table.**

- **G2 — fixed in the spec.** `logoUrl` is marked NOT YET PUBLISHED in all three schemas and
  removed from their `required` lists, so a generated client no longer depends on a key no route
  serves. The loaders do store it; when a route serves it we will say so rather than leave it
  documented and absent.

- **Labels — agreed, and adopted.** Nothing above says "Fixed" unless it is written and verified
  in the branch. Where work remains it says "planned" with a date, and where we are choosing not
  to fix something it says so and why. Your point that "Fixed, filling by <date>" would have
  saved a round of checks is correct; V1d, N1 and R6 should have read that way.

- **The Python `User-Agent` 403 — you are right, and it is documented, just not where you
  looked.** It is in `docs/consumer/v2-handoff/README.md`, not the API reference. Cloudflare's
  bot protection in front of the Worker refuses a default library `User-Agent`; `python-requests`
  and `aiohttp` send their own names, which is why they pass and `urllib` does not. Send a
  `User-Agent` naming your app (`genie-fomo-check/1.0` already works — every read in your
  appendix got through). We are adding the line to the API reference too.

- **The wallet-submission secret** will come from us privately, not in a document. Your script's
  shape is right: `secret` in the JSON body.

- **397397 comparison / the 450-trader table** — please re-run after this deploy rather than
  tomorrow. N1, A1 and R7 all move with it, and R7's numbers in particular will change a lot.

---

## What we would ask of you

1. **Re-read `pricedShare` before `totalUsd`** on `/aum/history`, `/aum/now` and
   `/positions.coverage`. It is the field that answers "is this a balance or a fragment", and it
   is the one we should have published from the start.
2. **Three renames land together**: `share` → `rowsPerSentTx`, `rowsHeld` → `transferRowsHeld`,
   `onChain.swaps` → `swapsAppearedIn` (+ `ownSwaps`). You said you match on none of our `source`
   strings; please confirm the same for these three before we deploy.
3. **`complete` gets stricter**, so lists that read `complete: true` today will read false with
   an `incompleteReason`. That is the point, but it will change what your warning-sign counter
   sees — it should now refuse to score a trader whose `/trades` is not `complete`.

## Still open, with dates

| Ask | State | When |
|---|---|---|
| `/tokens` query rewrite (the cold-isolate timeout) | planned | 24 Sep |
| Solana backfill reaching every wallet's first trade | running after deploy | ~7 days |
| `truncated` for EVM chains (no end-of-history signal from Bitquery) | open, no date | — |
| `liveBasis.evm: nightly_read` → the true interval | planned, vocabulary 13 | next bump |
| Retire the v1 Supabase deployment | waiting on you being fully on v2 | — |
