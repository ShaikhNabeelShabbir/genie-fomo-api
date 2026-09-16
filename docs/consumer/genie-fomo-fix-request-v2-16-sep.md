# Fix request v2 to genie-fomo — 16 Sep 2026, verified against the 16:2x update

From the Genie app team. This replaces the morning's fix request. It carries, for every ask, what the service answered **after** today's update, measured the same way as before (the 446-trader sweep re-run with the same scripts at 16:24–16:30 UTC, 67 calls; single-trader reads 16:23–18:10 UTC). The detailed before/after tables are Appendix B; the morning's handle lists per case are Appendix C. This one file holds everything.

How to read it: every defect has a **symptom** (what a person sees in our app), a **repro** (exact requests; `$BASE` = `https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api`, our key in `X-API-Key`), the **observed** answer after the update with its time (UTC), the **expected** answer under your README's own rules, our **guess at the cause**, the **ask**, and its **status** today.

Your README's rules we hold you to, quoted: *"`null` means absent. Zero means zero."* · *"A partial answer says it is partial."* · *"Every refusal is a machine word."* · *"A figure the service will not stand behind is refused, not rounded."*

---

## 0. Scoreboard

Of the morning's 17 asks: **0 fixed, 3 partly fixed, 13 not fixed, 1 cannot tell.** Of the 446 listed traders, our app draws a 7-day chart for 366 and a 30-day chart for 315 tonight (349 and 298 this morning); most of that gain is our own changes, the update added 8 one-day and 4 seven-day charts.

| # | Defect | Ask | Status after the update | Traders affected (after) |
|---|---|---|---|---|
| 1 | Native coins counted nowhere | N1 | **partly**: SOL priced (182 of 182 chains); ETH 0 of 605, BNB 0 of 181 | every ETH/BNB holder; roster holds $241K ETH + 448 BNB uncounted |
| 2 | Readings refused `too_little_priced` for a wallet's life | R1–R4 | **not fixed**: floor still 25%, unpublished; 500 refused 10–14 Sep readings not re-priced; Robinhood 3-of-3 refused 39 → 36 | 42 traders (36 gmgn); hzyjnkimyy 0 of 32 |
| 2b | A chain read once, then failing, served as $0 | R5 | **not fixed** | gmgn_0x314e6555, gmgn_0x65c13772; BSC 51 chains 36 h–7 d stale |
| 2c | BSC coverage a sliver of the wallet | R6 | **not asked before** | gmgn_0xf1d07077 and unknown others |
| 2d | Impossible price served as a verified $101B | V1 | **not asked before** | luckedhub; count from our guard to follow |
| 2e | One chain per sample served as the whole account | Z2 | **not fixed** | 25 whole-account $0 while another chain holds money; 204 traders with a read chain older than 4 h |
| 3 | Rebuilt history prices coins the wallet no longer holds | H1 | **not fixed** (158 drops, unchanged) | 158 |
| 4 | `$0` served for a reading that priced nothing | Z1 | **not fixed**: 220 zero-position points at 0, none null | 76 newest readings |
| 5 | Trade records stale 9 days while the wallet is active | T1–T3 | **not fixed**: the same 16, `nextLoadAt` still 17 Sep 06:00 | 16 + 5 never |
| 6 | `/pnl` open positions 10× the `/positions` list | P1 | **not fixed** | 104 |
| 7 | Daily step folds a short record into one point | S1 | **not fixed** | gmgn_8gv31ab8mt and every trader tracked under ~10 days |
| 8 | Health, live reads, wallets, on-chain block, flags | A1, F1–F3, L1–L2, W1, O1, K1, V2 | **not fixed** (health shape changed, verdicts did not) | — |

What the update did fix, with thanks: gmgn's Ethereum-family wallets are being sampled (every-chain-never-read 50 → 47, at-least-one 216 → 198; `gmgn_0xf80d7961` ethereum `none` → `ready`); the sampler runs every 5 minutes (newest accepted reading 2.5 h old at the median, 3.5 h at p90); `/v1/health` carries `staleTraders`, `capabilities`, `externalCallsPerRequest`; `partialUsd` and `pricedPositionShare` ride on every refused reading (842 of 842); `POST /v1/traders/:handle/wallets` exists (401 without the secret).

---

## 1. Native coins are counted nowhere — ask N1 — PARTLY

**Symptom.** A trader whose only money is plain ETH or BNB shows $0; every ETH/BNB holder shows less than he has.

**Repro.**
```
GET $BASE/v1/traders/gmgn_0xf80d7961/aum?window=all&live=false
GET $BASE/v1/traders/gmgn_0xf80d7961/portfolio
GET $BASE/v1/traders/397397/portfolio
```
**Observed (16:23).** `gmgn_0xf80d7961`: ethereum now sampled, readings 10 Sep, 14 Sep, 16 Sep 16:00, each `totalUsd: 0`; the wallet `0xf80d79610365e31fb6f0baa637e995d626d37403` holds 1.19 ETH (public node). `/portfolio`'s per-chain `native` block: SOL priced (397397: 807.48 SOL at $102.79); ETH `whyNoNative: "no market price for this chain's own coin…"` on 605 of 605 chains, BNB on 181 of 181. Our read of the 51 roster wallets: 35.8 ETH on Ethereum ($85K), 25.0 on Base ($60K), 38.9 on Robinhood chain ($93K), 448.2 BNB, 35 SOL: none of it in any `aum` reading.

**Expected.** The chain's own coin as a position in `/positions`, `/portfolio` and every `aum` reading.

**Cause.** The native block exists but has no price source for ETH and BNB; readings ignore it.

**Ask N1.** Price ETH and BNB (the wrapped coin's price, WETH/WBNB, is already in your token table) and add the native value to `totalUsd`. Publish the position's word in `/v1/fields` first.

---

## 2. Readings refused as `too_little_priced` for a wallet's whole life — asks R1–R4 — NOT FIXED

**Symptom.** No chart on any span for a trader your positions route values at $26K; four-day holes for others.

**Repro.**
```
GET $BASE/v1/traders/gmgn_hzyjnkimyy/aum?window=all&live=false
GET $BASE/v1/traders/gmgn_hzyjnkimyy/positions
POST $BASE/v1/traders/aum {"contractVersion":2,"ids":[…],"window":"1w","chain":"solana","live":false}
```
**Observed (16:25).** `gmgn_hzyjnkimyy` (`HZyJNKiMYYgpvd7xK36tGkdG1xf9SkNQjNy8koSDcGyA`): `status: no_reading`, **0 of 32 readings accepted** since 13 Aug, each `partialReason: unpriced_positions`, `partialUsd` up to $221K; `/positions`: `totalValueUsd: 26688`, 197 coins priced. The floor measured over the week's per-chain readings: lowest accepted share **0.25**, 55 readings at 20–24.3% refused (`frankdegods` Solana `partialUsd: 2418352` at 24.3%; `sadcrissy` Solana three newest at 21.7%, $729K wallet). Refused per-chain readings dated 10–14 Sep: **500 before, 500 after**: nothing re-priced. `gmgn_8gv31ab8mt`: 10–14 Sep still refused, 16 Sep accepted. Traders with a chain whose newest three readings are all refused: 45 → 42; Robinhood 39 → 36, and 27 of those 36 still price under 5% of positions. `/v1/fields` gained only a unit line for `pricedPositionShare`, no floor constant.

**Expected.** A refusal for a thin reading, yes; but a wallet you price at $26K on `/positions` has an accepted `aum` reading, and a $2.4M partial is served as partial, not null.

**Cause.** The floor is on position count; a wallet with hundreds of dust coins and a few valuable ones is refused although its value is priced; the price feed for memecoins and Robinhood chain is thinner in the sampler than in the positions route.

**Asks.**
- **R1.** Publish the rule as a constant in `/v1/fields` (we measure 25% of positions).
- **R2.** Floor on value share where known, or serve the reading with `partial: true` when `partialUsd` is large.
- **R3.** Retry a refused reading within the slice. (See B3 below: we cannot see a retry in the batch answer; say where one would show.)
- **R4.** Price Robinhood chain's coins; `baolingd` had 437 of 440 unpriced on 8 Sep and his newest reading is one dust coin.

---

## 2b. A chain read once, then failing, served as $0 — ask R5 — NOT FIXED

**Symptom.** A 6-day trader with 30 trades, $1,510 banked and an open position shows an empty chart.

**Repro.**
```
GET $BASE/v1/traders/gmgn_0x314e6555/aum?window=1w&live=false
GET $BASE/v1/traders/gmgn_0x65c13772/aum?window=1w&chain=robinhood&live=false
```
**Observed (17:0x).** `gmgn_0x314e6555` (BSC only, `0x314e6555bd6b8775101965959324f5ab8a049494`, `bsc: ready, hasPositions: true`, 37 trades): 10 Sep 16:00 **$338.92** (2 of 2 priced); 14 Sep 04:00, 16 Sep 00:00, 11:00, 14:00 all `totalUsd: 0`, `0 / 0 positions`, `answeredChains: 0 of 1`, `chains_missing`. `/positions`: $139.86. `/pnl`: $1,510 banked, 30 closed, `openPositions: 7`.
`gmgn_0x65c13772` (`0x65c13772a4d22853d2f372a3e2a42d7d72d7aedf`, bsc + robinhood ready): `/positions` prices a Robinhood coin at **$75.59**; `/aum?chain=robinhood`: `no_reading`, every reading since 7 Sep `unpriced_positions`; `/aum?chain=bsc`: $0 (dust) on 16 Sep. `/pnl`: $5,358 banked, 126 closed, 9 open vs 2 listed.
Sweep: BSC held chains fresh under 36 h 176 → 181 of 246; 51 still 36 h–7 d stale.

**Expected.** A failed chain sample is `null` with `chains_missing`; a chain that read before and fails four times is retried and counted.

**Ask R5.** Retry a failing chain within the slice; count failing chains on `/v1/health`; never write a failure as `0`. Tell us why BSC stopped answering for `gmgn_0x314e6555` on 14 Sep and why the Robinhood reader refuses `gmgn_0x65c13772`'s one coin that `/positions` prices.

---

## 2c. BSC coverage is a sliver of the wallet — ask R6 — NEW

**Repro.**
```
GET $BASE/v1/traders/gmgn_0xf1d07077/positions
GET $BASE/v1/traders/gmgn_0xf1d07077/pnl
```
**Observed (17:1x).** One coin, 239 units at $0.0000696 = **$0.02**; `aum` $0.02 on every reading; `/pnl` 3 open, 21 closed, $375 banked; `/wallets` 24 trades seen. The chain: `0xf1d07077e484b900b36809bb3d6b9724c52a0d05` holds 0.389 BNB and has **35,487 transactions** (`eth_getTransactionCount`, public node).

**Ask R6.** Per chain, publish how much of a wallet's activity the indexer covers (transactions seen vs the chain's nonce, one free call) and mark `/positions` `partial: true` when the wallet has more token transfers than the list accounts for.

---

## 2d. An impossible price served as a verified $101 billion — ask V1 — NEW

**Repro.**
```
GET $BASE/v1/traders/luckedhub/aum?window=1w&live=false
GET $BASE/v1/traders/luckedhub/positions?limit=3000
POST https://api.mainnet-beta.solana.com {"method":"getTokenSupply","params":["6xULRBW2VEsmSpPbpWUsNMbk2e5Cjm7MFHMsnqjZ8mfs"]}
```
**Observed (17:3x).** Three readings on 16 Sep, `basis: sampled, tier: verified`, `totalUsd: 101,615,408,967`, 1,058–1,069 of 2,529–2,604 priced, `valueShare 0.41`. `/positions`: mint `6xULRB…8mfs`, **11,379,341 units at $8,923.86 = $101.5B**, 99.93% of the total. Supply on-chain: 999,917,541 units → implied market cap **$8.9 trillion**. Next three rows: 15–23M units at $1.18, $1.23, $0.55 ($27M, $19M, $11M). `/pnl`: $329 banked, 31 trades. Our own valuation of the same list came to $104B and our pass refused it (one coin over 90% above $10M); your reading arrived `verified`.

**Second case (18:4x).** `shahh` (Solana, 6 days, 83 trades, $2,517 banked): `/positions` 2,907 rows, 1,342 priced, `totalValueUsd: 14,803,605`; the top row is **14,455 units at $1,019.42 = $14.7M, 99.5% of the total**, no symbol, no mint on the row; the next rows are $22K, $18K (181.7 SOL, correct), $17K. His 7-day chart in our app heads $14.8M. Same defect: one absurd unit price, and the positions row does not even carry the mint, so a consumer cannot check the supply itself.

**Ask V1.** Put the mint/contract address and the price source on every positions row. Before a price enters a reading, compute implied market cap (price × supply, one cacheable RPC call per mint) and refuse prices above a ceiling (we suggest $20B implied, and any reading above $1B for a trader with under $1M banked); carry `priceSuspect: true` with a reason on the row; never mark a reading `verified` when a coin over 90% of its value failed the check. Re-price `6xULRB…` and re-sample him.

---

## 2e. One chain per sample served as the whole account — ask Z2 — NOT FIXED

**Repro.**
```
GET $BASE/v1/traders/gmgn_0x0fde7f37/aum?window=all&live=false
GET $BASE/v1/traders/baolingd/aum?window=all&live=false
```
**Observed (18:0x).** `gmgn_0x0fde7f37` (`knownChains`: base `none`, bsc `ready`, robinhood `ready`): whole-account readings answer one chain each, alternating: 9 Sep `[robinhood]` refused, 10 Sep `[bsc]` $0.43, 14 Sep `[bsc]` $0.54, 16 Sep 14:00 `[robinhood]` $2.72; `answeredChains: 1 of 3` every time, `partial` unset; `/positions` 4 rows ($3.26, one unpriced) vs `/pnl` 32 open. `baolingd` newest reading 16 Sep 15:00: `chains: [robinhood]`, `1 of 3`, base still `none`. Sweep: 25 whole-account $0 readings while `/positions` values a chain the reading left out; a trader's stalest read chain is 4.5 h at the median and **160 h at p90**; 204 traders have a read chain older than 4 h while their freshest is under 4 h.

**Ask Z2.** Sample every chain of a wallet in the same slice; a reading that answered fewer chains than `knownChains` with positions is `partial: true`, `partialReason: chains_missing`, naming them; and `/health`'s freshness counts per chain, not per trader.

---

## 3. Rebuilt history prices coins the wallet no longer holds — ask H1 — NOT FIXED

**Repro.** `GET $BASE/v1/traders/trancey/aum?window=1m&live=false`

**Observed (16:5x).** Aug 26–31 rebuilt, 4 of 15 priced, $12–$21; **Sep 1–9 rebuilt, 9–11 of 14 priced, $175–$330**; from Sep 10 16:00 sampled, 4 of 8–10 priced, $6.48 / $37.48 / $6.40 / $14.44. Breaks declared (`priced_share_changed` Sep 1; `method_changed` Sep 10, 11, 14). Sweep: 158 traders with a 90%+ positions drop, all at the rebuilt → sampled switch (baolingd 440 → 2, gmgn_0xcb4d28c2 1,622 → 0), unchanged.

**Ask H1.** Rebuild from the balance the wallet held at the block, not from what it ever received; until then carry `reliability: low` on rebuilt points and never let `drawing.drawable: true` rest on rebuilt points alone.

---

## 4. `$0` served for a reading that priced nothing — ask Z1 — NOT FIXED

**Repro.** `GET $BASE/v1/traders/gmgn_0xcb4d28c2/aum?window=all&chain=robinhood&live=false` and `/positions`.

**Observed (16:4x).** `aum` 16 Sep 14:00: `totalUsd: 0`, `coverage 1/1 priced`, `partial: false`; `/positions` at the same time: `pricedPositions: 0, totalValueUsd: null`. The two routes contradict each other on the same coin. Sweep: newest whole-account reading exactly $0 for 100 traders; 76 of them list no positions; **220 sampled zero-position points at `totalUsd: 0`, 0 at `null`**; 24 readings priced coins and still summed to $0, 15 of them with `/positions` valuing $1+; per-chain newest $0 while `/positions` values that chain: 20 → **28**.

**Ask Z1.** A reading that priced nothing, or listed nothing because the read failed, is `totalUsd: null` with a reason word. `0` only when the wallet was read and holds nothing.

---

## 5. Trade records stale nine days while the wallet is active — asks T1–T3 — NOT FIXED

**Repro.** `GET $BASE/v1/traders/smokey0x/scorecard`, `/v1/traders/smokey0x`, `/v1/traders/smokey0x/trades?limit=100`, `/v1/health`.

**Observed (16:30).** `loadedAt 2026-09-07T11:40:25Z`, `nextLoadAt 2026-09-17T06:00Z`, `staleness: stale, ageSeconds 794848, staleAfterHours 72`; profile `onChain: swaps 1252, lastActiveAt 2026-09-16T08:17Z`; `/trades`: **4 swaps, newest 6 Aug**, all valued `money_side`. The stuck 16 (LowRivalRat, Milliardi, Onchainmetrics, Proteus, TheGasChad, ThePumponomics, USronaldcarter, poker_kb_, rasmr, sadcrissy, smokey0x, sockzt, spartee, tikopumps, valueandtime, ventikohi) are **the same 16 as on 15 Sep**; 5 never loaded; every loaded trader's `nextLoadAt` is 17 Sep 06:00. `/health`: `staleTraders.scorecardStale: 16, oldestScorecardHours: 221` and yet `dataState: current`, `staleFeeds: []`.

**Asks.**
- **T1.** Load when a scorecard passes its own `staleAfterHours`, not on the nightly slot.
- **T2.** Retry the skipped the same day, and make `dataState` say `degraded` while `scorecardStale > 0`.
- **T3.** Feed `/trades` from your on-chain swap stream (it holds 4 of his 1,252) and build the scorecard from it when fomoapi is behind.

---

## 6. `/pnl` open positions 10× the `/positions` list — ask P1 — NOT FIXED

**Observed.** 104 → 104 traders. `baolingd` `/pnl.openPositions: 28` (`asOf 2026-09-15T08:23:47Z`), `/positions count: 1`; `gmgn_0xcb4d28c2` 6 vs 1; `gmgn_0x0fde7f37` 32 vs 4; `/pnl.asOf` is 15 Sep for 359 traders. Our on-chain reads of four of the wallets agree with `/positions` every time.

**Ask P1.** Make `openPositions` count what `/positions` lists, or close the positions the wallet no longer holds. Our 446-row on-chain table (open per `/pnl`, listed per `/positions`, actually held) follows tonight.

---

## 7. The daily step folds a short record into one point — ask S1 — NOT FIXED

**Observed (16:28).** `gmgn_8gv31ab8mt` `window=1m` and `all`: `step: 1d`, `trackedSince 2026-09-10T16:00Z`, `usablePoints: 1`, `too_few_points`; `window=1w` draws 3.

**Ask S1.** Choose the step from `trackedSince`→`now`, or return the finest-step points when daily bucketing leaves fewer than two.

---

## 8. Health, live reads, wallets, on-chain block, flags — NOT FIXED / NEW

- **A1 / F2 / F3 (health).** `feeds.aum` still has no `historyState` counts; `feeds.aum.state: current` comes from the sampler's `lastSuccessAt`, while 54 traders have no accepted reading on any chain and `staleTraders.noReading` says 6 (refused readings count as readings there); 45 of the 47 never-read traders answer `sampler.state: current, progress.warming: false, status: no_reading`. Publish ready/warming/none counts, base freshness on accepted readings per chain, and give a never-read wallet one word.
- **L1 (live reads).** Single route: 4.1 s with `live=false` (`liveRead: skipped`), 7.6 s without on the first ask (`still_running`, `waitedMs: 3000`), 4.0 s on the second. **The batch route carries no `liveRead` block at all**, with `?live=false` or `live: false` in the body, so we cannot tell whether a batch of 50 triggers 50 live reads. Say what the batch does, default it to `live=false`, and put the block on its rows.
- **L2 (latency).** 4 s for a stored single-trader answer, 3.5–6.6 s per batch of 50. A stored answer should be well under a second.
- **W1 (wallets).** For all 155 fomoapi.io-listed traders, `/wallets` serves one address set (152 identical in `evmAddress`/`solanaAddress` and `wallets[]`, 3 none, 0 differ), every one tagged `source: fomoapi.io`; the README's own fingerprint wallet (`0x0a6EBEd0…119E`, PONS) is what you serve as unipcs's address. So the served address is the resolved one, but nothing says so. Add `resolvedBy` (fingerprint / fomo / gmgn / submitted) and `fingerprintMatches: N` per wallet.
- **O1.** `onChain` on `/v1/traders/gmgn_0xf80d7961` is all zeros, `source: helius webhook`, although his Ethereum chain is now read. Cover every chain or drop the block.
- **B3 (visibility).** The batch `1w` answer keeps at most 3 readings per chain per day (6-hour buckets), so a same-day retry cannot be seen. Tell us where a retry shows, or return the readings unbucketed on request.
- **V2 (flags).** `/v1/tokens/0x26bec…4608` flags Lasercat397's $58,631 Robinhood coin `isHoneypot: true, canSell: false`; `/portfolio` counts it at full value. Carry the flag onto the position row and either exclude it from `totalUsd` or mark the reading `partial` with `unsellable_positions`.
- **K1.** Rate-limit headers present; add the remaining allowance for the key.

---

## 9. What we have built on our side, so you know what we no longer need

- We read and price a chain ourselves when you have no accepted reading for it, from your positions list plus the wallet, native coin included, marked "measured by Genie" (live since 09:20 local). Your accepted readings are never overwritten.
- Every `$0` while the trader holds coins is refused on our side and the card says why. Rebuilt points draw dimmer and never join a sampled reading across `method_changed`.
- Every reading we draw, yours included, goes through a sanity guard (V1's rule on our side); a $101B reading is refused and the coin named.
- The chart sums every chain you say he holds coins on, not only the chains that answered; a known chain with no reading is named as missing.
- Where you have fewer than two accepted readings in a span, we value him from your positions list the moment a card is dealt and rebuild the history through your `/trades` at our daily prices, marked "rebuilt by Genie".
- We copy your positions list hourly in one batch call (`live=false`), read every listed wallet on-chain hourly, and run your `/v1/fields` and `/v1/chains` in a build check: a new word fails our build until it has a sentence. Publish first, then ship.

## 10. What we need from you

1. `WALLET_SUBMIT_SECRET`, to submit the wallets we hold for the 3 listed traders you have none for (zeri_term, bamblewood8, qwerty888) and any gmgn trader we can fingerprint.
2. A reply per ask: fixed, planned with a date, or declined with the reason. **V1, N1, Z1, Z2, R2 and R5** are the six that blank or falsify the most screens; V1 first, because a wrong billion is worse than a blank.
3. The B4 ramp figures for G1 (non-production only), whenever you run it.

## Appendix: the traders named, one line each

| handle | chain(s) | wallet | what is wrong |
|---|---|---|---|
| gmgn_0xf80d7961 | ethereum | 0xf80d79610365e31fb6f0baa637e995d626d37403 | samples now, $0 every time; holds 1.19 ETH (N1); `onChain` all zeros (O1) |
| gmgn_0x08b2526b | ethereum | 0x08b2526b646b7efe235adaefd28ef534c6577d31 | same, 1.13 ETH (N1) |
| gmgn_0xcb4d28c2 | robinhood | 0xcb4d28c2106fe9f781615005ff87056d114135c9 | `aum` "1/1 priced, $0" vs `/positions` "0 priced, null" (Z1); 1.25 ETH (N1); 1,622 → 0 (H1); pnl 6 vs 1 (P1) |
| gmgn_hzyjnkimyy | solana | HZyJNKiMYYgpvd7xK36tGkdG1xf9SkNQjNy8koSDcGyA | 0 of 32 accepted, $221K partial refused; `/positions` $26,688 (R1–R3) |
| gmgn_8gv31ab8mt | solana | see /wallets | 10–14 Sep refused, 16 Sep fine (R3); 1m/all fold to one point (S1) |
| sadcrissy (Crissy) | solana + 3 | see /wallets | Solana refused at 21.7% with $729K (R2); scorecard stuck since 7 Sep (T1) |
| frankdegods | solana | see /wallets | $2.4M partial refused at 24.3% (R2) |
| baolingd | robinhood, bsc, base | 0xfee4f6e8d6b5706876aceb3ad5185f9fbacf88ec | 437/440 unpriced (R4); 440 → 2 (H1); pnl 28 vs 1 (P1); 1 of 3 chains per sample, base never (Z2, A2) |
| gmgn_0x314e6555 | bsc | 0x314e6555bd6b8775101965959324f5ab8a049494 | read once 10 Sep, failed since 14 Sep, served as $0 (R5, Z1) |
| gmgn_0x65c13772 | bsc, robinhood | 0x65c13772a4d22853d2f372a3e2a42d7d72d7aedf | Robinhood coin priced $75.59 on /positions, refused on /aum since 7 Sep (R5, R2); pnl 9 vs 2 (P1) |
| gmgn_0xf1d07077 | bsc | 0xf1d07077e484b900b36809bb3d6b9724c52a0d05 | one coin at $0.02 vs 0.389 BNB and 35,487 transactions (R6, N1) |
| gmgn_0x0fde7f37 | bsc, robinhood, base | 0x0fde7f375b635992cd5b0eb1d0e2f272ced7ca9b | one chain per sample (Z2); 4 listed vs 32 open (P1); base never (A2) |
| luckedhub | solana | see /wallets | $101.6B verified reading from one coin at $8,924, implied cap $8.9T (V1) |
| shahh | solana | see /wallets | $14.8M from one coin at $1,019 a unit, 99.5% of the total; $2.5K banked (V1) |
| trancey | solana | see /wallets | rebuilt plateau $330 vs sampled $6–$14 (H1) |
| smokey0x | bsc, solana, ethereum + 1 | see /wallets | scorecard 7 Sep, stale by your rule, next load 17 Sep; `/trades` 4 of 1,252 swaps (T1–T3) |
| Lasercat397 | robinhood | see /wallets | $58,631 honeypot counted at full value (V2) |
| ZephyrTrading | several | see /wallets | $0 whole-account reading with $23.5K on other chains (Z2) |
| 397397, AnselFang | solana, evm | see /wallets | served = resolved, tagged fomoapi.io; control for W1 |
| zeri_term, bamblewood8, qwerty888 | — | none | no wallet on record; we will submit (A3 secret) |

---

# Appendix B. Verification of the 16:2x update, in full

(The file `genie-fomo-verification-16-sep.md`, unchanged, with headings demoted so this one document holds everything.)

## genie-fomo update, checked against the fix request — 16 Sep 2026

From the Genie app team. This checks the service as it answered between 16:23 and 16:50 UTC on 16 Sep, after the update announced at 16:2x UTC, against `genie-fomo-fix-request-16-sep.md` (asks A1–F4) and the new README. The 446-trader sweep was re-run with the same scripts as the 14:40 sweep in `genie-fomo-sweep-16-sep.md`, so the numbers compare. The one change: every balance batch was sent with `live=false`, so the sweep could not set off outside reads.

### The short answer

**Most of the asks are not fixed yet.** Of the 17 open asks: 0 fixed, 3 partly fixed, 13 not fixed, 1 we cannot tell.

- **What moved.** The sampler now reads some of the gmgn EVM wallets. The two sample wallets now have an Ethereum reading, and traders with a chain never read fell from 216 to 198 (every chain never read: 50 → 47). BSC and Base freshness improved a little. Healthy traders: 264 → 276.
- **What did not move:**
  - The 25% refusal floor is unchanged and not published. None of the 500 refused readings from 10–14 Sep was re-priced.
  - The daily step still folds a short record into one point.
  - An empty read is still served as `totalUsd: 0`. There are 220 such points and not one `null`, although the README says null means absent.
  - `/pnl` against `/positions`: still 104 traders ten times apart.
  - The same 16 trade records are stuck at 7–8 Sep, and every `nextLoadAt` is still 17 Sep 06:00.
  - `/health` shape is unchanged: no ready/warming/none counts, and `dataState: current`.
  - The on-chain block still covers Solana only.
- **Parts of the README that do not match the live answers:**
  - **Null means absent:** empty reads are still $0.
  - **Resolved wallets:** see check 5. `/wallets` serves one address set, all tagged `fomoapi.io`. There is no second, published set to compare against.
  - **Live read latency:** a single balance read takes about 4 s with or without `live=false`. When a live read starts, the answer waits a further 3 s (`AUM_LIVE_WAIT_MS`).
- **Our app on a copy after one forced read of the updated service** draws on 1 day / 7 days / 30 days / all (of 446):
  - Now: 361 / 366 / 315 / 316.
  - 14:44 (before): 349 / 347 / 298 / 300.
  - Most of the gain came from our own changes landed in between. The newest backup, taken before any read of the update, already drew 353 / 362 / 316 / 316.
  - The forced read added 8 / 4 / −1 / 0.

---

### 1. Before and after, same method

Before: 14:40–14:46 UTC (74 calls). After: 16:24–16:30 UTC (67 calls in the sweep). Counts are of 446 listed traders unless a row says otherwise.

#### A. Chains on record never read (`historyState: "none"`) — A1–A3

| measure | before | after |
|---|---|---|
| every chain on record never read (gmgn / fomoapi.io) | 50 (46 / 4) | **47** (43 / 4) |
| at least one chain never read (gmgn / fomoapi.io) | 216 (173 / 43) | **198** (159 / 39) |
| solana: never read / on record / of those holding | 22 / 204 / 3 | 22 / 204 / 3 |
| ethereum | 87 / 345 / 7 | **80** / 345 / 6 |
| base | 124 / 288 / 5 | **112** / 288 / 5 |
| bsc | 34 / 331 / 5 | 33 / 331 / 5 |
| robinhood | 37 / 357 / 5 | 34 / 357 / 5 |
| trader-chains `warming` | 54 | 73 |

#### B. Newest 3 readings on a chain all refused — B1, B3, D3

| measure | before | after |
|---|---|---|
| traders with such a chain (gmgn) | 45 (39) | **42** (36) |
| robinhood: chains / only `too_little_priced` / only `no_prices` / both / best share 0%, <5%, 5–20%, 20%+ / `/positions` values that chain | 39 / 13 / 11 / 15 / 11, 28, 0, 0 / 15 | 36 / 12 / 9 / 15 / 9, 27, 0, 0 / 14 |
| base | 3 / 0 / 3 / 0 / 3, 0, 0, 0 / 0 | same |
| solana (gmgn_hzyjnkimyy, sadcrissy) | 2 / 2 / 0 / 0 / 0, 0, 1, 1 / 2 | same |
| bsc | 1 / 0 / 1 / 0 / 1, 0, 0, 0 / 0 | same |
| lowest priced share on any accepted per-chain reading this week | 0.25 | **0.25** |
| refused `too_little_priced` while pricing 20–25% | 55 | **55** |
| `too_little_priced` points / carrying `partialUsd` | 853 / 853 | 842 / 842 |
| refused per-chain readings dated 10–14 Sep | 500 | **500** |
| 16 Sep refused per-chain readings / another reading that day / that one accepted | 75 / 43 / 17 | 77 / 51 / 23 |

#### C. Newest whole-account reading is exactly $0 — A3, D5

| measure | before | after |
|---|---|---|
| newest whole-account reading exactly $0 | 101 | 100 |
|   listed no positions (an empty read shown as $0) / `/positions` lists holdings | 76 / 24 | **76 / 24** |
|   priced some and still $0 / `/positions` values $1+ | 25 / 17 | 24 / 15 |
| newest whole-account reading `null` with 0 positions | 0 | **0** |
| per-chain newest $0 while `/positions` values that chain at $1+ | 20 | **28** |
| whole-account $0 while `/positions` values a chain the reading left out | 28 | 25 |
| sampled whole-account points with 0 positions: `totalUsd` 0 / null | 220 / 0 | **220 / 0** |

#### D. Positions list drops and the `/pnl` contradiction — D1, D2

| measure | before | after |
|---|---|---|
| 90% drop in the positions list in 10 days (all at the rebuilt → sampled switch) | 158 | 158 |
| `/pnl` says 10+ open, `/positions` lists a tenth or less | 104 | **104** |
| `/pnl.asOf` | 15 Sep 08h: 359, 16 Sep 10h: 65 | same |

#### E. No wallet at all

| measure | before | after |
|---|---|---|
| no Solana and no EVM address (zeri_term, bamblewood8, qwerty888) | 3 | 3 |

#### F. Healthy: an accepted reading under 36 h on every chain he holds something on

| measure | before | after |
|---|---|---|
| healthy (gmgn / fomoapi.io) | 264 (148 / 116) | **276** (158 / 118) |
| holds nothing on any chain on record | 54 | 54 |
| solana: held / <36 h / 36 h–7 d / >7 d / never accepted | 185 / 179 / 2 / 0 / 4 | 185 / 180 / 1 / 0 / 4 |
| ethereum | 259 / 249 / 1 / 1 / 8 | 259 / 251 / 1 / 1 / 6 |
| base | 76 / 51 / 8 / 8 / 9 | 76 / 54 / 8 / 6 / 8 |
| bsc | 246 / 176 / 55 / 8 / 7 | 246 / **181 / 51** / 7 / 7 |
| robinhood | 302 / 265 / 13 / 1 / 23 | 302 / 268 / 13 / 1 / 20 |

#### G. Freshness of trades and balances — E1–E3

| measure | before | after |
|---|---|---|
| trade record age <1 d / 1–2 d / 3–7 d / >7 d / never | 65 / 360 / 0 / 16 / 5 | **65 / 360 / 0 / 16 / 5** |
| the stuck group | LowRivalRat, Milliardi, Onchainmetrics, Proteus, TheGasChad, ThePumponomics, USronaldcarter, poker_kb_, rasmr, sadcrissy, smokey0x, sockzt, spartee, tikopumps, valueandtime, ventikohi | **the same 16** |
| `nextLoadAt` | 17 Sep 06:00 for all 441 loaded | same |
| newest accepted balance, any chain: <1 h / 1–6 h / 6–36 h / >36 h / none | 96 / 268 / 5 / 18 / 59 | 65 / 308 / 3 / 16 / 54 |
| newest accepted balance age, hours: median / p90 | 1.78 / 3.78 | 2.51 / 3.51 |
| stalest read chain per trader, hours: median / p90 / traders over 4 h | 14.8 / 158.8 / 223 | 4.5 / 160.5 / 204 |
| `/health`: `dataState` / `staleFeeds` / `staleTraders.scorecardStale` / `noReading` | current / [] / 16 / 6 | **current / [] / 16 / 6** |

---

### 2. Verdict per ask

| ask | verdict | evidence (route, what it answered after the update) |
|---|---|---|
| **A1** publish ready/warming/none counts on `/health` | **NOT FIXED** | `GET /v1/health` 16:23 and 16:30: `feeds.aum` has `rowCount, traders: 443, newestReadingAt, lastSuccessAt`, no history-state counts. The shape is identical to 14:47 except row counts. |
| **A2** sample gmgn EVM wallets; say why when a wallet cannot be read | **PARTLY** | gmgn_0xf80d7961 `/wallets`: ethereum `historyState: "ready"` (was `none`); `/aum?window=all`: a 16 Sep 16:00 reading with `chains: ["ethereum"]`, `coverage.answeredChains 1/1`. gmgn_0x08b2526b: `warming`, a 15:00 reading. Every-chain-never-read 50 → 47, some-chain 216 → 198, ethereum never read 87 → 80, base 124 → 112. But both readings are `totalUsd: 0` with 0 positions while each wallet holds about 1.1–1.2 ETH (see F4), and 43 gmgn traders still have no chain ever read. No reason word for an unreadable wallet was added to `/v1/fields`. |
| **A3** no `totalUsd: 0` for a trader with no readable chain | **NOT FIXED** | Of the 47 traders with every chain never read, 45 answer `status: "no_reading"`, `sampler.state: "current"`, `now.totalUsd: 0`. There are still 220 sampled whole-account points with 0 positions at `totalUsd: 0`, and 0 at `null`. gmgn_0xcb4d28c2 10 and 14 Sep: `chains: []`, `totalUsd: 0`, as before. |
| **B1** state the floor; re-price 10–14 Sep; consider a lower floor for big partials | **NOT FIXED** | The lowest accepted per-chain share this week is still 0.25, and 55 readings at 20–25% are still refused. `/v1/fields` added only a unit description for `pricedPositionShare`, with no floor constant. Refused readings dated 10–14 Sep: 500 → 500. gmgn_8gv31ab8mt `window=all`: 10 Sep 16:00, 11 Sep and 14 Sep still `too_little_priced`; 16 Sep 14:00 $60,071 accepted at 196/475. gmgn_hzyjnkimyy `window=all`: **0 of 32** readings accepted; 32 of 32 carry `partialUsd`; newest $221,506 partial at 17.2%. |
| **B3** retry a refused reading the same day | **CANNOT TELL** | The batch 1w answer keeps at most 3 readings per chain per day (6 h buckets), so a retry inside a bucket is invisible. What shows: 16 Sep refused per-chain readings followed by another that day, 43 → 51, of which accepted 17 → 23. Chains refused 3 of 3: 45 → 42 traders. |
| **C1** choose the step from `trackedSince` | **NOT FIXED** | gmgn_8gv31ab8mt `window=1m` and `window=all`: `step: "1d"`, `trackedSince 2026-09-10T16:00Z`, `drawing: {drawable: false, usablePoints: 1, reason: "too_few_points"}`. |
| **D1** (withdrawn) rebuilt points counting coins not held | not asked | 158 drops, all at the rebuilt → sampled switch, unchanged. |
| **D2** `/pnl.openPositions` against `/positions` | **NOT FIXED** | 104 → 104 traders. baolingD `/pnl`: `openPositions: 28`, `asOf 2026-09-15T08:23:47Z`; `/positions`: `count: 1`. gmgn_0xcb4d28c2: 6 against 1. |
| **D3** price Robinhood chain coins | **PARTLY** | Robinhood chains refused 3 of 3: 39 → 36, and 27 of those 36 still price under 5%. Newest Robinhood per-chain readings accepted: 277 → 285 of 347. baolingD robinhood 16 Sep 15:00: $0.38, 1/1 priced, which is the single dust coin and not the 440 he held. |
| **D4** read every chain with trades at every sample | **NOT FIXED** | baolingD `window=all`: newest reading 16 Sep 15:00 `chains: ["robinhood"]`, `chainsAnswered 1 of 3`, `partialReason: "chains_missing"`; base still `historyState: "none"`. BSC held chains fresh under 36 h: 176 → 181 of 246; 51 still 36 h–7 d. Stalest read chain per trader: p90 160 h, 204 traders over 4 h. |
| **D5** a reading that priced nothing is refused, not $0 | **NOT FIXED** | gmgn_0xcb4d28c2 `/aum` 16 Sep 14:00: `totalUsd: 0`, `coverage 1/1 priced`, `partial: false`. His `/positions` at the same time: `pricedPositions: 0, totalValueUsd: null`. The two routes contradict each other on the same coin. Per-chain $0 beside a `/positions` value of $1+: 20 → 28. |
| **E1** load trades when a scorecard passes `staleAfterHours` | **NOT FIXED** | smokey0x `/scorecard`: `loadedAt 2026-09-07T11:40:25Z`, `nextLoadAt 2026-09-17T06:00Z`, `staleness: {state: "stale", ageSeconds: 794848, staleAfterHours: 72}`. Still the same 16 traders over 7 days. |
| **E2** retry skipped traders; stale scorecards count on `/health` | **NOT FIXED** | `/health` counts `staleTraders.scorecardStale: 16`, `oldestScorecardHours: 221`, but `dataState: "current"`, `staleFeeds: []`, and the trades feed is `current`. The traders feed is `current` (10:33 refresh), so it no longer disagrees, but it does not reflect the 16. |
| **E3** build the record from on-chain swaps, or value the swaps | **NOT FIXED** | smokey0x `/v1/traders/smokey0x/trades?limit=100`: `count: 4`, newest 6 Aug, all valued (`valueSource: "money_side"`). His profile `onChain`: `swaps: 1252`, `lastActiveAt 2026-09-16T08:17:40Z`. The swaps route values what it has, but holds 4 of his 1,252 swaps. |
| **F1** on-chain block for every chain, or drop it | **NOT FIXED** | `/v1/traders/gmgn_0xf80d7961`: `onChain` all zeros, `source: "postgres · transactions (helius webhook)"`, although his Ethereum chain is now read. |
| **F2** feed freshness from accepted readings per chain | **NOT FIXED** | `feeds.aum.state: "current"` from `lastSuccessAt` (the sampler run). `staleTraders.noReading: 6`, while 54 traders have no accepted reading on any chain (refused readings count as readings there). |
| **F3** one word for a wallet never read | **NOT FIXED** | 45 of the 47 never-read traders: `sampler.state: "current"`, `progress.warming: false`, `status: "no_reading"`. |
| **F4** count the native coin | **PARTLY** | The `chains[]` native block was already present at 14:40 and is unchanged. SOL is priced on 182 of 182 chains (397397 `/portfolio`: 807.48 SOL at $102.79). ETH is priced on 0 of 605 and BNB on 0 of 181, with `whyNoNative: "no market price for this chain's own coin…"`. `/positions` rows never list the native coin. So the 1.1–1.2 ETH in gmgn_0xf80d7961, gmgn_0x08b2526b and gmgn_0xcb4d28c2 is still worth $0 on your side. |

Tally over the 17 open asks (D1 was withdrawn): FIXED 0, PARTLY 3 (A2, D3, F4), NOT FIXED 13, CANNOT TELL 1 (B3).

---

### 3. The README's own claims, checked

1. **"Whole roster comes round in under four hours."** The newest accepted reading per trader is 2.5 h old at the median and 3.5 h at the 90th percentile, which agrees for each trader's freshest chain. Readings are stamped on the hour, so ages round up. It does not hold per chain: a trader's stalest read chain is 4.5 h old at the median and 160 h at the 90th percentile, and 204 traders have a read chain over 4 h old.
2. **Live reads on `/aum`.** `GET /v1/traders/397397/aum?window=1d`:
   - with `live=false`: 4.1 s, `liveRead: {state: "skipped"}`;
   - first ask without it: 7.6 s, `still_running`, `waitedMs: 3000`;
   - second ask: 4.0 s, `not_needed`.

   gmgn_hzyjnkimyy without the flag: 5.8 s, `still_running`. The batch route `POST /v1/traders/aum` carries **no `liveRead` block** on any row, with or without `?live=false` or `live: false` in the body. Both forms answer 200, and batch balance reads took 3.5–6.6 s each (4.4–10.7 s at 14:40). `/health` `externalCallsPerRequest: {typical: 0, max: 1}` says only the single-trader route reads live.
3. **`/health` per-trader staleness and capabilities.** It carries `staleTraders` (readingStale 0, noReading 6, scorecardStale 16, oldestScorecardHours 221), `capabilities.providers` (five, all `current`; evm history, address resolution and both directories have `keyInThisProcess: false`), `delistedTraders` 4 and `externalCallsPerRequest`. All of this was already present at 14:47. `scorecardStale: 16` matches our 16 stuck traders exactly. The `traders` feed is `current` (10:33 refresh).
4. **"null means absent, zero means zero."** Not true for balances. The 76 empty reads are still `totalUsd: 0` with 0 positions, and 220 sampled zero-position points are 0 with none null. gmgn_0xcb4d28c2's newest reading is $0 at "1/1 priced" while `/positions` says 0 priced and `null` value. 24 readings priced coins and still total $0.
5. **Published against resolved wallets.** `GET /v1/traders/{id}/wallets` for all 155 fomoapi.io-listed traders:
   - 152 serve the same addresses in `evmAddress`/`solanaAddress` and in `wallets[]`, every one tagged `source: "fomoapi.io"`;
   - 3 have none;
   - 0 differ.

   No provisioned per-user address is served anywhere, so the difference the README describes cannot be counted from the API. The README's own fingerprint wallet (`0x0a6EBEd0…119E`, PONS) is what the service serves as unipcs's `evmAddress`, so the served address is the resolved one there. Please add a `resolvedBy` (fingerprint / fomoapi.io / gmgn) and `confidence` per wallet so we can tell. **Our roster:** for all 443 listed traders with an address, our roster holds every served address. It holds one extra, a third address for sadcrissy (`2GtmuqG3…FzLw`).
6. **New routes, once each:**
   - `GET /v1/traders/397397/trades`: 12 resolved swaps, newest 3 Sep, each with both sides, `valueUsd` from the money side (`valueSource: "money_side"`), fees in native coin and USD, and `whyNoPosition` when a sell has no matching buy.
   - `GET /v1/traders/397397/portfolio`: 289 positions, $327,560, concentration 0.179, cash share 0.14, per-chain split with the native block.
   - `GET /v1/tokens/0x26bec…4608` (Robinhood): fundamentals from gmgn and a `security` block: `isHoneypot: true`, `canSell: false`, `flags: ["honeypot"]`. This is Lasercat397's largest Robinhood position ($58,631), which `/portfolio` counts at full value.
   - `GET /v1/tokens/CTPoy…pump` (Solana): `verdict: "no_flags_raised"`.
   - `GET /v1/tokens/momentum`: 2 snapshots over 10.3 h, 25,556 coins moved.
   - `POST /v1/traders/zeri_term/wallets` with an empty body: **401** `unauthorized`, "a valid `secret` is required". The route exists and refuses.
7. **`partialUsd` beside refusals.** Confirmed. gmgn_hzyjnkimyy: 32 of 32 readings carry it. Every `too_little_priced` per-chain point this week carries it (842 of 842).

---

### 4. Our app

Counted with our own chart reader (the same one used for 14:44). Each copy is of our app's data, never the running app. The latest backup was taken at 16:20 UTC, before any hourly pass had read the updated service. I forced one read of the updated service on that copy: the hourly pass's whole-account half (36 calls, 1,781 answers, 3 unavailable), then its chain half (88 calls, 3,958 chain answers for 376 traders, no refusals).

| copy | 1 day | 7 days | 30 days | all |
|---|---|---|---|---|
| 14:44 copy (the fix request's numbers) | 349 | 347 | 298 | 300 |
| 16:20 backup, untouched | 353 | 362 | 316 | 316 |
| 16:20 backup + one read of the updated service | **361** | **366** | **315** | **316** |
| same three copies, on #391's 363-trader list | 344 / 347 / **350** | 342 / 351 / **354** | 294 / 306 / **304** | 296 / 306 / **305** |
| #391's own count after its joins (00:34 copy, 363 traders) | 227 | 286 | 296 | 298 |

The forced read added 8 one-day and 4 seven-day charts: gmgn_0xab34e383, gmgn_0xa0e72dc2, jinneyqi and gmgn_0x314e6555 on 7 days. It lost 3 thirty-day charts (lzGB14blWdWV03A, hzjxhcyy, jurbo_eth) to readings on two sides of a declared break (`moments_do_not_join`). That is ours to fix. The two gmgn EVM sample wallets still draw nothing on 7 days (`too_few_points`), because their Ethereum readings began today. Why the rest do not draw after the read: 7 days, no chain named 63, too few points 5, a chain with too few 5, too little covered 5, moments do not join 2; 30 days, warming 40, too few points 24, no chain named 23, moments do not join 19, a chain with too few 13, too little covered 12.

**Vocabulary check.** `/v1/fields` and `/v1/chains` were read fresh at 16:23 UTC. Every published word list is the same as the 08:58 copy our check is built on. The only difference in `/v1/fields` is a new unit entry for `pricedPositionShare`; `/v1/chains` changed only its counts. Our check (`nmo-ui-fomo-vocabulary-test`) passes 35 of 35, and its Chinese run passes, against the fresh answers. **No new reason word or field reached us.** The directory and balance answers carry exactly the keys they carried at 14:40.

---

### 5. Still open for the engineer

1. **B1.** Publish the floor (it is 25%, and `/v1/fields` still says nothing). Re-price the 500 refused readings from 10–14 Sep. Decide on large partials: gmgn_hzyjnkimyy is $221K refused on every one of 32 days.
2. **A3 / D5 and the README's null rule.** An empty or zero-priced reading must be `null` with a reason, not 0: 76 newest readings and 220 points. Also, `/aum` says "1/1 priced" where `/positions` says "0 priced" for gmgn_0xcb4d28c2.
3. **A1, F2, F3.** Publish ready/warming/none counts. Base feed freshness on accepted readings per chain, not on the sampler's run. Give a never-read wallet its own word; today it answers `sampler: current, warming: false`.
4. **A2.** 43 gmgn traders still have no chain ever read, and 198 traders have at least one. The newly read Ethereum wallets answer $0 because native ETH is not priced (F4: 0 of 605 ETH and 0 of 181 BNB chains priced).
5. **C1.** Choose the step from `trackedSince`. gmgn_8gv31ab8mt still cannot draw 30 days or all.
6. **D2.** 104 traders' `/pnl` and `/positions` still disagree ten to one. `/pnl.asOf` is 15 Sep 08:23 for 359 of them.
7. **D4.** Read every chain at every sample. baolingD's newest reading answers 1 of 3 chains, and 204 traders have a read chain older than 4 h.
8. **E1–E3.** The same 16 traders have been stuck since 7–8 Sep, and `nextLoadAt` is still a fixed 06:00 slot. smokey0x's swap route holds 4 of the 1,252 swaps his on-chain block counts.
9. **Wallets.** Say on `/wallets` how each address was found (fingerprint, fomo, gmgn), so the README's warning about provisioned addresses can be checked.
10. **B3.** Can't be checked from the batch answer, because its 6-hour buckets hide a retry. Tell us where a same-day retry would show.
11. **Security flags.** `/portfolio` values a coin flagged `isHoneypot: true, canSell: false` at full price (Lasercat397, $58,631). Consider marking it in the total.

### What this check cost

382 calls to the service, all recorded in our app's spend ledger before each went out (`trader-service`, background, caller `sweep_405`, `{"calls":382,"units":382}` on 16 Sep):

| calls | what |
|---|---|
| 5 | shape probes: `/health`, `/v1/fields`, `/v1/chains`, two small balance batches |
| 67 | the sweep |
| 31 | sample traders, token lookups and the swaps route |
| 155 | `/wallets` for every fomoapi.io trader |
| 124 | the forced read on our data copy |

The lowest remaining allowance the service reported was 156 of 240 in the minute. One call was refused: the deliberate 401 on the wallet submission. Nothing was retried.

Scripts and saved answers are kept with our task #405 (`proof/405/`).

---

# Appendix C. Sweep of all 446 listed traders at 14:40 UTC, in full, with the handle lists per case

(The file `genie-fomo-sweep-16-sep.md`, unchanged.)

## Sweep of 446, 16 Sep 14:40–14:47 UTC — for the genie-fomo engineer

From the Genie app team. This is section 7 of `genie-fomo-fix-request-16-sep.md`, with the counts in. Every listed trader was read off the production service with our key between 14:40:10 and 14:46:57 UTC on 16 Sep, in batches:

- the directory with `include=scorecard,wallets,pnl`, 100 a page (5 pages, 446 traders);
- `POST /v1/traders/aum` (`contractVersion: 2`), 50 ids a call: the whole account on `window=all` and `window=1w`, then each chain on `window=1w` for every trader whose `knownChains` lists it (1,525 trader-chains);
- `POST /v1/traders/positions` (`contractVersion: 2`), 50 ids a call;
- `/health` before and after.

Every batch answered 200 at full size; nothing had to be paged smaller. What our app draws was counted off a copy of our app's data taken at 14:44 UTC, during the sweep.

### The short answer

- **59% of listed traders are healthy** (264 of 446): every chain he holds something on has an accepted reading under 36 hours old. Another 54 (12%) hold nothing on any chain on record, so there is nothing to judge.
- **The biggest gap is wallets never read: 50 traders (11%) have no chain that was ever read**, 46 of them gmgn EVM wallets. 216 (48%) have at least one chain never read.
- **Zero shown as a balance is common: 101 traders (23%) have a newest whole-account reading of exactly $0.** In 76 of them the reading listed no positions at all. In 25 it priced positions and still added up to $0.
- **Refused readings are mostly Robinhood chain: 45 traders have a chain whose newest 3 readings were all refused. For 39 of them that chain is Robinhood.**
- **The Robinhood "collapse" is not lost rows.** All 158 drops of 90% or more happen at the same moment: 9 Sep, the last rebuilt point, to 10 Sep, the first sampled one. Only 2 drops happen between two sampled readings. The real contradiction is different. For 104 traders, `/pnl` says 10 or more open positions while `/positions` lists a tenth of that or less.
- **Trades are not real time.** At 14:46 UTC, 65 traders' trades were loaded today at 10:33–10:38 UTC. 359 were loaded on 15 Sep at 08:4x (30 hours old), 16 on 7–8 Sep (9 days old, all fomoapi.io, the same 16 as yesterday), and 5 never. Every loaded trader's `nextLoadAt` is 17 Sep 06:00. Balances are much fresher: 364 traders have an accepted reading under 6 hours old.
- **Our app draws a 7-day chart for 347 of 446 (78%) and a 30-day chart for 298 (67%).** With every service-side case fixed, the ceiling would be 439 (98%) and 420 (94%).

### Three corrections to the fix request, from the sweep

1. **B1, the floor is 25%, not the documented one fifth.** In the week's per-chain readings, no reading pricing under 25% of positions was accepted, not even one at 0%. 55 readings were refused `too_little_priced` while pricing 20–24.3%. Examples: frankdegods Solana, $2,418,352 partial at 24.3%; Crissy (`sadcrissy`) Solana, all 3 newest readings refused at 21.7%. Please state the constant that is live.
2. **B2 is already done on the per-chain batch answer.** All 1,050 `too_little_priced` points in the week carry `partialUsd`, and 2,671 of 2,748 refused points carry `pricedPositionShare`. We will use them; no change needed from you for that part.
3. **D1 is a change of method, not a list that lost its rows.** The 440 → 2 (baolingd) and 1,622 → 0 (gmgn_0xcb4d28c2) drops, like all 158 others, go from the rebuilt 9 Sep point to the sampled 10 Sep point. The rebuilt history counts every coin the wallet ever received. The sampled reading counts what it holds. D2 stands and is the real question (see D below).

---

### A. Chains on record never read (`historyState: "none"`) — asks A1–A3

| | traders | gmgn (of 291) | fomoapi.io (of 155) |
|---|---|---|---|
| every chain on record never read | 50 (11.2%) | 46 | 4 |
| at least one chain never read | 216 (48.4%) | 173 | 43 |

| chain | trader-chains never read | chains on record | of those, `hasPositions: true` |
|---|---|---|---|
| solana | 22 | 204 | 3 |
| ethereum | 87 | 345 | 7 |
| base | 124 | 288 | 5 |
| bsc | 34 | 331 | 5 |
| robinhood | 37 | 357 | 5 |
| all | 304 | 1,525 | 25 |

Only 25 never-read chains say `hasPositions: true`, but that flag cannot be trusted here: a chain nobody reads has no positions to report. gmgn_0xf80d7961 says `hasPositions: false` and traded yesterday.

Every chain never read (50): zeri_term, bamblewood8, TheOldNite, ThePumponomics (fomoapi.io); gmgn_0x036c43c6, gmgn_0x055854da, gmgn_0x08b2526b, gmgn_0x1069999a, gmgn_0x17fb4a31, gmgn_0x26f0670c, gmgn_0x2fe65206, gmgn_0x39a50a0f, gmgn_0x43605d68, gmgn_0x45923a43, gmgn_0x45e6345d, gmgn_0x4ac9d866, gmgn_0x4b9fcc41, gmgn_0x51f9d44c, gmgn_0x67bdbd57, gmgn_0x6a189f61, gmgn_0x7881b699, gmgn_0x7bf30399, gmgn_0x81eb6f2b, gmgn_0x825c4ccb, gmgn_0x8f8b72da, gmgn_0x90637f23, gmgn_0x90b082dd, gmgn_0x9a374325, gmgn_0xa1725770, gmgn_0xa70d360a, gmgn_0xa7944019, gmgn_0xab2f731f, gmgn_0xac371986, gmgn_0xae22b8a0, gmgn_0xb5359761, gmgn_0xb5e22de9, gmgn_0xbc60577b, gmgn_0xd12f62f4, gmgn_0xd90acdda, gmgn_0xdc0d3715, gmgn_0xe156ba39, gmgn_0xe4613af9, gmgn_0xefda500e, gmgn_0xf80d7961, gmgn_0xff7f4768, gmgn_0xff83d6e3, izukki, MariusCOW, mung0x, stormtradez (gmgn).

### B. Newest 3 readings on a chain all refused — asks B1–B3, D3

45 traders (10.1%), 45 chains; gmgn 39, fomoapi.io 6. 5 of these chains had fewer than 3 readings in the week, and every one of them was refused.

| chain | chains | only `too_little_priced` | only `no_prices` | both | best priced share sent: 0% / under 5% / 5–20% / 20%+ | `/positions` values something on that chain today |
|---|---|---|---|---|---|---|
| robinhood | 39 | 13 | 11 | 15 | 11 / 28 / 0 / 0 | 15 |
| base | 3 | 0 | 3 | 0 | 3 / 0 / 0 / 0 | 0 |
| solana | 2 | 2 | 0 | 0 | 0 / 0 / 1 / 1 | 2 |
| bsc | 1 | 0 | 1 | 0 | 1 / 0 / 0 / 0 | 0 |
| ethereum | 0 | – | – | – | – | – |

Robinhood chain is the price feed not covering that chain's coins (D3): 28 of 39 priced under 5%. The two Solana chains are gmgn_hzyjnkimyy (17%, while `/positions` prices 198 of his 1,150 positions at $221,778) and sadcrissy (21.7%, refused under a floor documented as 20%).

Handles: The__Solstice (bsc); LP1111, Binkieee, TizzWhisperer (base); sadcrissy, gmgn_hzyjnkimyy (solana); robinhood: WuKong365, antpositions, casino847, coasty_sol, CupseyV, Cupseyy, fnmilito, Gmf_winner, gmgn_0x1ad2cdd2, gmgn_0x1ff54f07, gmgn_0x38d01d4e, gmgn_0x456e4590, gmgn_0x4dc959c7, gmgn_0x4e020c0d, gmgn_0x5fe2583f, gmgn_0x65c13772, gmgn_0x67257593, gmgn_0x6a2c23a0, gmgn_0x82f217fb, gmgn_0x88669768, gmgn_0x8a8c09c8, gmgn_0x8d73a36d, gmgn_0xa7c0dad5, gmgn_0xc5d3c566, gmgn_0xc84248de, gmgn_0xcdcae7d2, gmgn_0xd5ac55f2, gmgn_0xef1639a6, gmgn_0xef90471f, gmgn_0xf20db64d, Kevin85083031, lucas_paixalc, ohzarke, pheromones_sol, sol_lucky_, TurtleTavernTV, twisterchessur, wnggngdn119805, YYzzy_diamond.

### C. Newest whole-account reading is exactly $0 — asks A3, D5

| newest reading says $0 and… | traders | `/pnl` open positions > 0 |
|---|---|---|
| …listed no positions and priced none (an empty read shown as $0) | 76 (17.0%) | 76 |
|   of which `/positions` lists holdings today | 24 | 24 |
| …priced some positions and still totals $0 | 25 (5.6%) | 25 |
|   of which `/positions` values the trader at $1 or more | 17 | 17 |
| all | 101 (22.6%) | 101 |

Two separate faults sit in the "priced and still $0" row:

- **The same chain, two answers.** 20 trader-chains have a newest per-chain reading of $0 while `/positions` values that same chain at $1 or more: lzGB14blWdWV03A ethereum $1,991 (reading 12:00), summerrainy888 ethereum $1,294, Able777C robinhood $744, gmgn_0xd126780e ethereum $739, sol_lucky_ ethereum $601, CryptoCharming robinhood $242, NotVanGogh88 ethereum $242, 0xkuidian ethereum $158, gmgn_0xcf7607ff ethereum $156, xingxingxing88 ethereum $124, plus 10 under $50 (bsc 9, ethereum 8, robinhood 3 in all).
- **A one-chain reading shown as the whole account.** 28 traders' newest whole-account reading is $0 while `/positions` values $1 or more on a chain that reading did not include. ZephyrTrading's 14:00 reading covers Ethereum only and says $0. `/positions` holds $18,801 on BSC, which has not been read since 10 Sep, and $4,735 on Robinhood, read at 10:00 but not at 14:00.

Ask, adding to D5: a whole-account reading that did not read every chain on record should not stand as the account's `now`. Carry the newest accepted figure per chain, or refuse.

### D. Positions list dropped 90% or more in 10 days — asks D1, D2

| | traders |
|---|---|
| a reading with 100+ positions followed by one with 10% or fewer | 158 (35.4%) |
|   of which the drop is 9 Sep rebuilt → 10 Sep first sampled reading | 158 |
|   of which `/pnl` still says 10+ open and `/positions` lists 10% of that or less | 38 |
| a drop of 90%+ between two sampled readings (from 20+ rows) | 2: Aomake70 79 → 7 (Robinhood dropped out of the reading), CryptoCharming 75 → 2 (same chains) |
| any trader: `/pnl` says 10+ open, `/positions` lists 10% of that or less | 104 (23.3%) |

So D1 is answered by the method change, which your `breaks` and `comparability` already declare. D2 is the live question for 104 traders: `/pnl.openPositions` is built from the trade records, `/positions` from balances, and they disagree by ten times or more. Examples: baolingd 28 vs 1, TheOldNite 20 vs 0, ThePumponomics 36 vs 0, 277422149x 55 vs 2.

### E. No wallet at all

| | traders |
|---|---|
| no Solana and no EVM address (`walletState: "unresolved_upstream"`) | 3 (0.7%): zeri_term, bamblewood8, qwerty888 — all fomoapi.io |
| no chain on record | 1 (qwerty888) |

zeri_term (2 chains on record, 23 open) and bamblewood8 (5 chains, 29 open) list chains but no address. We can supply addresses through the wallet-submission route once it exists.

### F. Healthy

| | traders |
|---|---|
| healthy: accepted reading under 36 h on every chain he holds something on | 264 (59.2%) — gmgn 148 of 291, fomoapi.io 116 of 155 |
| holds nothing on any chain on record | 54 (12.1%) |
| not healthy | 128 (28.7%) |

| chain | chains holding something | accepted under 36 h | 36 h – 7 days | over 7 days | never accepted |
|---|---|---|---|---|---|
| solana | 185 | 179 | 2 | 0 | 4 |
| ethereum | 259 | 249 | 1 | 1 | 8 |
| base | 76 | 51 | 8 | 8 | 9 |
| bsc | 246 | 176 | 55 | 8 | 7 |
| robinhood | 302 | 265 | 13 | 1 | 23 |

BSC is the chain that falls behind: 70 of 246 held BSC chains have no accepted reading in 36 hours (D4).

### G. How fresh trades and balances really are, per trader — asks E1–E3

Trade record age (`scorecard.loadedAt`), at 14:46 UTC:

| age | traders | loaded at (UTC) | gmgn / fomoapi.io |
|---|---|---|---|
| under 1 day | 65 (14.6%) | 16 Sep 10:33–10:38 | 12 / 53 |
| 1–2 days | 360 (80.7%) | 15 Sep 08:4x: 359; 14 Sep 10:xx: 1 | 279 / 81 |
| 3–7 days | 0 | | |
| over 7 days | 16 (3.6%) | 7 Sep 11:40: 14; 8 Sep 10:40: 2 | 0 / 16 |
| never loaded | 5 (1.1%) | | 0 / 5 |

Every loaded trader has `nextLoadAt: 2026-09-17T06:00:00Z`.

**The 7–8 Sep group is stuck, and it is the same 16 people as yesterday.** On 15 Sep there were 16 traders with a 7–8 Sep load. Today there are 16, and a load time only moves forward, so today's 16 are exactly yesterday's. Each one's last trade on record falls within hours before that load (smokey0x: last trade 7 Sep 11:06, loaded 11:40), while the directory row of 7 of them was refreshed today at 10:33. The 16: sadcrissy, USronaldcarter, ventikohi, smokey0x, Milliardi, valueandtime, Proteus, TheGasChad, Onchainmetrics, spartee, tikopumps, ThePumponomics, rasmr, LowRivalRat, poker_kb_, sockzt. Never loaded (5): TheDazzleNovak, tremendoustoad, OmakaseOnly, qwerty888, RareDualJay. Yesterday 11 traders had a 14 Sep load; today 1 does.

**What `/health` said at the same moment** (14:40 and 14:47 UTC): `dataState: "current"`, `staleFeeds: []`. The trades feed was `current` with `lastRefreshAt 10:38:23` and a 72-hour allowance. `staleTraders.scorecardStale: 16`, `oldestScorecardHours: 219`. So `/health` counts the 16 but still calls the data current. Ask, adding to E2: a trader past his own `staleAfterHours` should put the trades feed in `staleFeeds`.

**Balances are near-real-time for most traders, never for some.** Newest accepted balance reading on any of his chains:

| age | traders |
|---|---|
| under 1 h | 96 (21.5%) |
| 1–6 h | 268 (60.1%) |
| 6–36 h | 5 (1.1%) |
| over 36 h | 18 (4.0%) |
| no accepted reading on any chain | 59 (13.2%) |

The `/positions` feed was last refreshed at 10:33 UTC.

In plain words for the owner: the service is not real time. 364 of 446 traders have a balance reading from the last 6 hours. Trades are loaded about once a day for most, the last full load was 15 Sep 08:4x, 16 traders have not been loaded since 7–8 Sep, and the next load is promised for 17 Sep 06:00.

---

### What our app draws today, and would draw with each case fixed

Counted off a copy of our app's data (14:44 UTC) with our own chart reader, per span. Each trader not drawn is counted under one case: the first that applies, in the order no wallet, every chain never read, empty $0 read with no figure on any chain, refused, a held chain never read, any $0 newest reading, the method-change drop, then our own reasons. "If fixed" adds that case's traders to today's count. It is an upper bound: a trader can have a second reason behind the first. Traders who would draw only a flat $0 line are counted as drawing.

| span | draws today (of 446) | A fixed | B fixed | C fixed | D fixed | E fixed | our own reasons fixed | every service case fixed |
|---|---|---|---|---|---|---|---|---|
| 1 day | 349 (78.3%) | +48 → 397 | +13 → 362 | +24 → 373 | +3 → 352 | +3 → 352 | +6 → 355 | 440 (98.7%) |
| 7 days | 347 (77.8%) | +48 → 395 | +11 → 358 | +25 → 372 | +5 → 352 | +3 → 350 | +7 → 354 | 439 (98.4%) |
| 30 days | 298 (66.8%) | +52 → 350 | +15 → 313 | +26 → 324 | +26 → 324 | +3 → 301 | +26 → 324 | 420 (94.2%) |
| all | 300 (67.3%) | +52 → 352 | +14 → 314 | +25 → 325 | +26 → 326 | +3 → 303 | +26 → 326 | 420 (94.2%) |

On the 30-day and all-time spans, the D and "our own reasons" traders are mostly readings on two sides of a declared break that our reader will not join (`moments_do_not_join`, `too_few_points`). That fix is ours.

### Whose fix, per case

| case | traders | fix owner | the fix |
|---|---|---|---|
| A. never read | 50 every chain, 216 some | **service** (A1–A3); **ours** meanwhile | Service: sample gmgn EVM wallets, mainly base (124) and ethereum (87), and publish the ready/warming/none counts. Ours: #398 reads and prices those chains ourselves, marked "measured by Genie"; #391's sentence says "has his wallet on record but has never read its balance". |
| B. refused 3 of 3 | 45 (39 Robinhood) | **service** (B1, B3, D3); **ours** now | Service: price Robinhood chain coins; state the live floor (25%); retry within the day. Ours: `partialUsd` and the priced share already arrive, so #391's wording can say how little was priced, and #398 values the chain ourselves. |
| C. $0 newest reading | 101 (76 empty, 25 priced) | **service** (A3, D5 and the addition above) | An empty read is not $0. A $0 reading beside a `/positions` value on the same chain is a bug (20 chains). A one-chain reading must not stand as the whole account (28). Ours: never print a $0 whose reading listed nothing. |
| D. 90% drop | 158, all at the method change | **ours** for the chart; **service** for D2 | The drop is declared; our reader must break the line there and not call it a collapse. Service: make `/pnl.openPositions` and `/positions` agree, or say which to trust (104 traders 10× apart). |
| E. no wallet | 3 | **service**; **ours** can supply | Resolve the 3 fomoapi.io addresses; we submit ones we hold through the wallet route once built. |
| G. trades 9 days old | 16 stuck, 5 never | **service** (E1–E3) | Load on staleness, not a fixed slot; retry skipped traders; count them in `dataState`. Ours: fill the days since `loadedAt` from the swap feed and say so. |

### What this sweep cost

74 calls to the service: 67 for the sweep and 7 to check answer shapes first. All were recorded in our app's spend ledger before each call went out (`trader-service`, background, caller `sweep_399`, 74 calls on 16 Sep). The service reported 2,878 cost units across them, one per trader asked for in a batch. The lowest remaining allowance it reported was 198 of 240 in the minute, and no call was refused or retried.

Per-trader lists for every case are kept with our task #399 (`proof/399/handles/`).
