# Reply to fix request v5 — 17 Sep 2026

Answering `genie-fomo-fix-request-v5-17-sep.md` ask by ask. Thank you for the appendix: every
read in it was reproducible from the figures you gave, and four of them found the bug directly.

**Deployed to v2 on 17 Sep 2026, ~15:05 UTC**, migration `0005` applied first. Every figure
below quoted as current was read back from production after the deploy, not from a test.

**One thing to read carefully rather than skim: V1d.** We found it after the first deploy and
fixed it (§1) — the cause was one line, and it is the same line behind A4's sawtooth. Hours
already stored keep their old figures until they are rebuilt, so **cupseyy's 07:00 may still
read $2.5B when you check**; keep your $1B guard on until it does not.

**A2 is now met** (§2): 445 of 446 traders carry a figure under an hour old. We cannot tell you
what that number was when you wrote, because the field that measures it did not exist until
this deploy — what we can tell you is that it read 308 of 446 the moment it did exist. It took
three fixes, two of which only showed up because we kept measuring after each one.

**What we need from you: run the ten reads in "Verify the deployment" below** — each one says
what it should return — then re-run your comparisons and send the next batch whenever it suits
you. If a read disagrees with the table, that is the most useful thing you can send us.

**Vocabulary goes to 12.** Three new words — `token_price_stats` (`positions[].priceSource`),
`not_built` (`aumHistory.points[].reason`), `truncated` (`trades.coverage.byChain[].state`).
**Three fields are renamed**: `coverage.chains.*.share` → `rowsPerSentTx`,
`coverage.chains.*.rowsHeld` → `transferRowsHeld`, `onChain.swaps` → `swapsAppearedIn` (plus a
new `onChain.ownSwaps`). Those three are the only breaking changes; everything else is additive.

---

## The short version: four of your top asks were one bug

A1, N1 and R7 are the same defect (V1d is not — see §1). **We had three different price
ladders**, and `/positions` served a price frozen into the row at its last balance read:

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
- **V1d — found and fixed, one line. It is also the cause of A4.**

  Our first draft of this reply said V1d was fixed by the coverage rule; it was not, because
  that hour was built from 45.06% of his wallet, comfortably above the floor. So we went and
  found it. The builder's ladder ended like this:

  ```
  pegged  ->  hourly sample (<= 24 h)  ->  that day's close  ->  token_info IF the hour
                                                                 being built is the hour
                                                                 we are in right now
  ```

  That last rung is GMGN's `token_info.price_usd`: a **current** price with no time attached.
  So an hour's value depended on **when we computed it**, and changed retroactively when it was
  rebuilt. `aum_history.computed_at` shows it exactly:

  | hour | built | priced of 11,278 | `totalUsd` |
  |---|---|---|---|
  | 07:00 | **07:33 — same hour** | 5,082 | **2,509,077,756** |
  | 08:00 | 11:38 — later | 187 | 1,686 |
  | 11:00 | **11:38 — same hour** | 1,131 | 2,950 |
  | 12:00 | 13:28 — later | 193 | 229,389 |
  | 13:00 | **13:32 — same hour** | 1,135 | 229,589 |

  Every jump lines up with whether the build ran inside its own hour. **That is your sawtooth
  and the $2.5B in one mechanism** — and your instinct that "two builds take turns" was right,
  it just was not two builders. GMGN prices one of his memecoins at **$28,160 against a 1e9
  supply**, a $28 trillion implied cap; the suspect rule catches the worst of them, and the
  survivors still summed to two and a half billion dollars.

  Fixed: only a rung that carries a timestamp may value a past hour. `/aum/now` keeps the
  `token_info` rung and should — `now` IS current, so a current price is the right thing to
  value it with. A past hour is not.

  **Two things you need to know about the state of the data.**

  1. **Hours already stored keep their old figures until they are rebuilt.** The builder only
     recomputes the last two hours, so cupseyy's 07:00 still reads $2.5B right now. We are
     running a targeted rebuild; until it lands, **keep your $1B guard on**.
  2. **Expect more nulls, and that is the honest answer.** With the untimestamped rung gone,
     a wallet of 11,278 dust memecoins has dated prices for only about 190 of them — under our
     5% floor — so many of cupseyy's hours will come back `totalUsd: null` with
     `reason: too_little_priced` and a `partialUsd`. We would rather hand you a gap you can see
     than a number built from 1.7% of a wallet. Traders with fewer, better-covered positions are
     unaffected.

## 2. The sawtooth and the missing hours — A4, A3, A2

- **A4 — fixed twice over, and your instinct was right.** "Two builds take turns" is almost
  exactly what was happening: not two builders, but one builder that priced an hour differently
  depending on whether it ran inside that hour. §1 has the mechanism and the evidence — it is
  the same single line as V1d, and it is now gone. What follows is the second half of the
  answer, which stands on its own: even with a consistent ladder, an hour built from a fraction
  of a wallet must say so.

  397397's `01:00` is `basis: reading`, **217 of 279** priced, $351,321.95. His `00:00` is
  `basis: priced`, **2 of 289** priced, $43,780.82.

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

- **A2 — fixed, and measured rather than asserted. 445 of 446 traders now carry a figure under
  an hour old.**

  `/health.staleTraders` gains `liveStale`, `liveStaleAfterHours: 1`, `liveNever` and
  `oldestLiveHours`, so you can check this yourself rather than take our word. The series, all
  from production on 17 Sep:

  | 15:17 | 16:29 | 16:52 | **17:15** |
  |---|---|---|---|
  | `liveStale` 308 | 195 | 34 | **1** |

  `oldestLiveHours` went from **9 to 1**. It took three fixes, and the second and third only
  became visible because we kept measuring after each one:

  1. **Cost.** The catch-up read `holdings_live`, which rolls Solana forward with three
     correlated subqueries per row — 818,851 rows and 2,111 ms on our largest trader, against
     105,388 rows and 106 ms for the same trader's balances as read. For a trader nothing has
     marked as moved, that roll-forward can only add zero. Those are now valued from the read.
  2. **Cadence.** An hourly pass against a one-hour threshold can never hold the number down:
     the cohort refreshed at :25 ages out together at :25 the next hour. Moved to the existing
     five-minute job, so a trader is picked up minutes after crossing the line.
  3. **Queue order, which was the real one.** Every trader still stale after (1) and (2) was
     one the webhook had marked as moved — and that queue was served oldest-*mark*-first. A
     busy wallet is re-marked on every push, so its mark is never old and it sat at the back
     for ever. **The most active traders held the stalest figures.** One of them carried a
     value from 12:25 with a mark refreshed at 16:47. The queue now serves the oldest *value*.

  The remaining `liveStale: 1` is a single trader sitting on the one-hour boundary, which is
  what a one-hour threshold looks like when it is working. `liveNever` counts only traders with
  a wallet on record, so it reads 0; three listed traders have no wallet at all and can never
  carry a balance.

## 3. ETH and BNB — N1: fixed, and no sweep needed

The native rows were never a loader problem. The hourly price job excludes natives by design,
so their only price is the daily close in `token_prices` — which **exists**, and which
`/positions` could not reach because it served the frozen row price.

Verified against production for the trader you named:

```
gmgn_0xf80d7961  ethereum native  1.1720  →  daily close 2026-09-17 = $2,464.97
```

With the request-time ladder that row prices on the next request. **The "427 of 450 waiting for
a fresh read" figure no longer gates anything** — there is nothing to wait for, and no reason to
re-order the sweep. gmgn_0x314e6555, gmgn_0xcb4d28c2 and gmgn_0xf1d07077 are the same case.

**A second change was needed to finish this, and you may notice it elsewhere.** Once priced, his
ETH was immediately flagged `concentration_over_ceiling` and his total read 0 — so he still
showed nothing, for a new reason. The native sentinel carries no `total_supply`, so our
"we cannot check this price" test was false, and a wallet holding only ETH puts one position at
100% of its own total, which is exactly what that rule looks for. A `quote_assets` row — a
dollar coin or a chain's own coin — is now exempt from the concentration and no-market rules,
and from nothing else: the implied-market-cap ceiling still applies, and the row stays in the
concentration base so anything beside it is still judged against real value.

The visible effect: a wallet that is all ETH, BNB, SOL or USDC reports a balance instead of
moving it into `suspectUsd`. It only ever affected single-asset wallets — tdmilky holds 609
positions, so no single one reaches 90% and his four natives were always fine.

**Verified in production after the deploy:** gmgn_0xf80d7961 now reads `totalValueUsd: 2889.02`,
`suspectUsd: 0`, his ETH at $2,464.97 from `token_prices`. He read `null` / `no_prices` for you.

## 4. `complete` on partial swap lists — W2

- **`complete` — fixed.** It was `!capped`: a pagination fact. It is now false while the page
  was capped, while any chain the trader trades on is `unresolved`, **or** while any chain is
  `truncated`. A new `incompleteReason` names which (`page_capped`, `chains_unresolved`,
  `chains_truncated`, joined with `_and_`).

- **`onChain.swaps` — split, as you asked.** It counted transfer **legs** typed SWAP, with no
  `distinct tx_hash`, for every transaction this wallet appears in. So one trade counted several
  times, *and* other people's trades counted whenever this wallet received tokens inside them.

  smokey0x, read from production after the deploy: **`swapsAppearedIn: 593`** (your 1,260 was
  that same wallet counted by legs) and **`ownSwaps: 6`** — which is exactly the six rows
  `/trades` returns. The two numbers were never comparable, and now they do not have to be.

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

- **H2, `canSell` on honeypots — fixed and verified.** 397397's four honeypot rows all read
  `canSell: false` in production, with `unsellableUsd: 102147.12` unchanged. `canSell` is now false whenever `isHoneypot` is true.
  `canSell` previously negated the separate `can_not_sell` column alone, so the two fields
  contradicted each other on the same coin. Still `null` when no security source has judged it.
  Thank you for the correction on the totals — your reading of `unsellableUsd` was right and
  ours was not clearly documented.

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

## Verify the deployment

Ten reads, with what each should say. All against `$BASE = https://genie-copy-trading-api.agent-73b.workers.dev`,
and **send a `User-Agent` that names your app** or Cloudflare will answer 403 `error code: 1010`.

| # | Read | What you should see |
|---|---|---|
| 1 | `GET /v2/fields` | `vocabulary.version: 12`; `positions[].priceSource` includes `token_price_stats` |
| 2 | `GET /v2/traders/gmgn_0xf80d7961/positions?limit=5` | `totalValueUsd` about **2,889** (it moves with the ETH close), `suspectUsd: 0`; the ethereum native priced `token_prices`, **not null** — it was null for you (N1) |
| 3 | `GET /v2/traders/397397/aum/history?window=1d` | no flat $43,780.82 rung: those hours are `totalUsd: null`, `reason: too_little_priced`, `partialUsd: 43780.82`, `pricedShare: 0.0069` (A4) |
| 4 | the same read | 08:00 and 09:00 present as `totalUsd: null`, `reason: not_built` (A3) |
| 5 | `GET /v2/traders/cupseyy/aum/history?window=1d` | 12:00 withheld, 13:00 `partial: true`. **07:00 reads $2.5B until the rebuild lands** — the cause is fixed and deployed, the stored row is not yet rewritten (V1d, §1). Expect more `null` hours here afterwards, not fewer |
| 6 | `GET /v2/traders/smokey0x/trades?limit=50` | `complete: false`, `incompleteReason: chains_unresolved_and_chains_truncated`; solana `state: truncated` with a `horizonAt` that moves EARLIER on later reads as the backfill walks (W2) |
| 7 | `GET /v2/traders/smokey0x` | `onChain.swapsAppearedIn` about **593** and `onChain.ownSwaps` about **6** — both rise as transfers land, the point is the gap between them, not the figures; **`onChain.swaps` is gone** |
| 8 | `GET /v2/traders/397397/positions?limit=500` | all four honeypot rows `isHoneypot: true, canSell: false` (H2) |
| 9 | `GET /v2/traders/tdmilky/positions?limit=500` | `coverage.chains.bsc` reads `transferRowsHeld: 200, rowsPerSentTx: 2.2989` — **the same 2.2989 you flagged, under a name that makes it correct**; `rowsHeld` and `share` are gone (C1). His four natives all price `token_prices` (N1) |
| 10 | `GET /v2/health` | `feeds.aum` current, with `sampler.retired: true`; **`staleTraders.liveStale` in the low single digits of 446** and `oldestLiveHours` 1 (A2). A number in the hundreds means the five-minute job has stopped — tell us |

Three of those are breaking renames (7, 9, and `share`/`rowsHeld`). If any of them breaks your
build, tell us and we will serve both spellings for a version rather than make you rush a fix.

## What we need back from you

1. **Confirm the ten reads above**, or tell us which one disagrees and what you saw.
2. **Re-run the 450-trader comparison and the 397397 comparison now**, not tomorrow — N1, A1 and
   R7 all moved with this deploy, and R7's numbers in particular should change a lot.
3. **Send the next batch of feedback whenever it suits you.** The measurement style in v5 — two
   timed read sets, an appendix with every status and duration, and the figures quoted back —
   is what let us find the price-ladder bug in an afternoon. Please keep it.

## Two changes that will move numbers on your side

- **Read `pricedShare` before `totalUsd`** on `/aum/history`, `/aum/now` and
  `/positions.coverage`. It answers "is this a balance or a fragment", and it is the field we
  should have published from the start. Your $1B ceiling and your "one hour below a fiftieth of
  its neighbours" rule are both subsumed by it — except on cupseyy, where §1 means the $1B guard
  still earns its place.
- **`complete` is stricter**, so a `/trades` list that read `complete: true` yesterday reads
  false today with an `incompleteReason`. That is the point, but it changes what your
  warning-sign counter sees: it should now refuse to score a trader whose list is not
  `complete`, rather than scoring a record we have told you is partial.

## Still open, with dates

| Ask | State | When |
|---|---|---|
| **V1d** — the cause is fixed and deployed; stored hours need a targeted rebuild before 07:00 stops reading $2.5B | code fixed, data pending | rebuild today |
| `/tokens` query rewrite (the cold-isolate timeout) | planned | 24 Sep |
| Solana backfill reaching every wallet's first trade (184 wallets hold a Solana address; 0 finished) | starts on the :40 run | ~1 week |
| `truncated` for EVM chains (no end-of-history signal from Bitquery) | open, no date | — |
| `liveBasis.evm: nightly_read` → the true interval | planned, vocabulary 13 | next bump |
| Retire the v1 Supabase deployment | waiting on you being fully on v2 | — |
