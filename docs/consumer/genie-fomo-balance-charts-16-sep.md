# Four traders with a wrong or missing balance chart — for the genie-fomo engineer

From the Genie app team, 16 Sep 2026, read off the production service at ~12:45 UTC with our key.
Three cards in our app show no chart. Each is a different cause on the service side. Evidence, then the fix we ask for.

## 1. Wallets on record that the sampler never reads

**Traders:** `gmgn_0xf80d7961` (0xf80d79610365e31fb6f0baa637e995d626d37403) and `gmgn_0x08b2526b` (0x08b2526b646b7efe235adaefd28ef534c6577d31). Both `source: "gmgn"`, one EVM wallet each, no Solana wallet, on record since `asOf 2026-09-09T11:40:36Z`.

What the service answers today:

| route | answer |
|---|---|
| `GET /v1/traders/{handle}/wallets` | `knownChains: [{chain: "ethereum", networkId: 1, wallets: 1, hasPositions: false, historyState: "none"}]`; `wallets[0].chains[0]: {tradesSeen: 33 (34), lastActiveAt: 2026-09-15T08:23:47Z}`; `walletState: "on_record"`, `tier: "reported"` |
| `GET /v1/traders/{handle}` | `reported.trades: 33 (34)`, `reported.pnlUsd: 8681`; `onChain.transactions: 0, swaps: 0, tokensTouched: 0` with `source: "postgres · transactions (helius webhook)"` |
| `GET /v1/traders/{handle}/aum?window=all` | `status: "no_reading"`, `coverage: {answeredWallets: 0, totalWallets: 1, answeredChains: 0, totalChains: 1}`, `drawing.reason: "nothing_answered"`; three sampled points (10 Sep 16:00, 14 Sep 04:00, 16 Sep 12:00) all `totalUsd: 0`, the newest with `coverage.chainsAnswered: 0, chainsTotal: 1, partialReason: "chains_missing"`; `sampler.state: "current"`, `progress.warming: false` |
| `GET /v1/traders/{handle}/positions` | `count: 0, complete: true, totalValueUsd: null` |

So: the sampler runs for these traders (a reading was taken at 12:00 today) but the Ethereum chain never answers, every reading is an empty read, and positions are empty although the wallet has 33 trades with activity yesterday. The on-chain source is named as the Helius webhook, which is a Solana indexer; it looks like EVM wallets that came in from gmgn are never indexed, so there is nothing to value.

291 of the 446 listed traders are `source: "gmgn"`. We do not know how many of them are in this state.

**Asks**
- A1. Count listed traders whose every `knownChains` entry has `historyState: "none"`, and put the three counts (`ready` / `warming` / `none`) on `/health` under the `aum` feed, so both sides can see the size of the gap.
- A2. Make the sampler value EVM wallets that arrived from gmgn (the Ethereum reader clearly exists: Crissy's Ethereum and BSC chains read fine). If a wallet cannot be read for a reason (unsupported chain, no indexer, rate limit), say it on the reading: `partialReason` is `chains_missing` today, which reads as a transient miss, not a wallet nobody reads.
- A3. Until then, a reading for a trader with no readable chain should not be `totalUsd: 0` with `basis: "sampled"`. Zero is a balance; this is an empty read. `totalUsd: null` with `refused: "no_readable_chain"` (or the word you choose) would let us say the right sentence.

## 2. Readings refused as `too_little_priced`, in bulk

**Trader:** `gmgn_8gv31ab8mt` (Solana, `source: "gmgn"`, trading 6 days).

`GET /v1/traders/gmgn_8gv31ab8mt/aum?window=1w&chain=solana` → `status: "ready"`, `step: "1d"`, `count: 7`, `drawing: {drawable: true, usablePoints: 3, partialPoints: 4}`. Points: 10 Sep 00:00 (rebuilt) null, 10 Sep 16:00 (sampled) null, 11 Sep 00:00 (rebuilt) null, 14 Sep 04:00 (sampled) null, 16 Sep 00:00 $57,095, 16 Sep 08:00 $57,448, 16 Sep 12:00 $59,704. Every gap before 16 Sep carries `reason: "too_little_priced"`.

Same at `window=1m` (27 points, 26 refused `too_little_priced`, `usablePoints: 1`, `drawable: false, reason: "too_few_points"`) and `window=all` (32 points, 31 refused).

He was priceable on 16 Sep at all three readings and not once on 10, 11 or 14 Sep. A wallet does not change that much in two days; the token-price coverage did.

**Crissy** (`G-55XGTD3N` in our app) is the same refusal on one reading: her Solana wallet holds ~$729K (14 Sep 04:00 reading) and the 16 Sep 00:00 Solana reading came back refused `too_little_priced`, pricing 22% of her coins. Her other three chains read fine that hour. (Our earlier note said the Solana wallet was skipped; it was read and refused. Correction.)

**Asks**
- B1. What is the `too_little_priced` threshold (share of positions priced? share of value?) and which price source failed on 10–14 Sep for a Solana wallet that priced fine on 16 Sep? If tokenInfo was stale for those days, can those readings be re-priced now that prices exist (`tokenInfo.lastRefreshAt` is 12:00 today)?
- B2. Carry `partialUsd` and `coverage.pricedPositionShare` on a refused reading, not only on drawn ones. We then decide whether to draw it at reduced coverage; today the point is `null` and nothing can be done with it.
- B3. Retry a refused reading within the same day rather than waiting for the next scheduled sample, so a transient pricing miss does not cost a whole day.

## 3. The daily step folds a short record into one point

Same trader, `window=1m` and `window=all`: `step: "1d"`. His three priced readings, all on 16 Sep, fold into one daily bucket, so `usablePoints: 1` and `drawable: false` (`too_few_points`), while `window=1w` draws three points from the same readings. The trader has been tracked 6 days (`trackedSince`), so a 30-day or all-time view of him is a 6-day view.

**Ask**
- C1. Choose the step from the span the trader actually has readings in (`trackedSince` to `now`), not from the requested window. A trader tracked 6 days should answer `window=all` with the same step and points as `window=1w`. Or return the finest-step points that exist when the daily bucketing leaves fewer than two.

## What we will do on our side either way

- Our card says "the trader service names no chains for him" for case 1; that is wrong, it names Ethereum. We are changing it to "the trader service has his Ethereum wallet on record but has never read its balance" (our task #391, third case).
- For cases 2 and 3 our card shows the figure and no sentence. We will say "only one day of his readings could be priced; the 30-day view needs two", naming `too_little_priced`, once B2 tells us how much was priced.
- We keep reading `/v1/fields` and `/v1/chains` in a check, so any new reason word you add gets a sentence before it reaches a screen.

Reply with the shape of any new field and we wire it the same day.

## 4. A $10K trader whose balance reads $0.38: the Robinhood positions list collapsed

**Trader:** `baolingd` (EVM wallet 0xfee4f6e8d6b5706876aceb3ad5185f9fbacf88ec, `source: "gmgn"`, KOL). `/pnl`: `bankedUsd: 10162`, `closedTrades: 247`, `openPositions: 28`. `/wallets`: robinhood 169 trades, bsc 101, base 5, all active 15 Sep.

`GET /v1/traders/baolingd/aum?window=all&chain=robinhood`, per reading:

| reading | totalUsd | positions priced / total |
|---|---|---|
| 7 Sep 00:00 | null (`unpriced_positions`) | 2 / 439 |
| 8 Sep 00:00 | null | 3 / 440 |
| 9 Sep 00:00 | null | 3 / 440 |
| 10 Sep 16:00 | null (`no_prices`) | 1 / 2 |
| 14 Sep 04:00 | null (`no_prices`) | 1 / 2 |
| 16 Sep 12:00 | $0.38 | 1 / 1 |

`GET /v1/traders/baolingd/positions` today: `count: 1`, one Robinhood position of 8.7M units at $4.4e-8 = $0.38. `stored.positions: 1`.

So the service held 440 Robinhood positions for this wallet on 9 Sep, 2 on 10 Sep and 1 today, while `/pnl` still counts 28 open positions and `/wallets` shows him trading on 15 Sep. The 440 were 99% unpriced, which is its own problem, but the drop to 2 the next day is not a wallet emptying; it is the positions feed losing the rows. Base is `historyState: "none"` (never read) and BSC's newest reading is 14 Sep and marked `stale`, so today's readings answer 1 of 3 chains.

Our app draws $0.38 because that is what every route says; the verdict beside it ($10K banked, 247 closed trades) comes from the trade records and is right. The two contradict on your side.

**Asks**
- D1. Why did the Robinhood positions for this wallet go from 440 to 2 between 9 and 10 Sep? If the 10 Sep rebuild replaced the list rather than merged it, other Robinhood wallets have the same hole.
- D2. `/pnl` says 28 open positions and `/positions` says 1 for the same `asOf`. One of them is wrong; tell us which to trust, or make them agree.
- D3. Price the Robinhood positions: 437 of 440 unpriced on 8 Sep means the token-price feed does not cover that chain's coins.
- D4. Read BSC and Base each sample for a trader with trades on them (BSC has not been read since 14 Sep; Base never).
