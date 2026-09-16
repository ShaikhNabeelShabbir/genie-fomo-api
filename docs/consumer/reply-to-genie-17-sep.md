# Reply to the Genie app team — fix request v2, per ask

Draft, 17 Sep 2026. Answers §10 item 2 of `genie-fomo-fix-request-v2-16-sep.md`: one line per
ask, in the order of your scoreboard. Everything marked *fixed on branch* is merged on
`cloudflare-migration` and verified against the code, not against production: **nothing below is
deployed yet**, so the requests in the last column will answer the old way until it is.

## Read this first: the vocabulary is now version 4

Your build gates on `/v1/fields`, so the words come before the fixes. `GET /v1/fields` will
answer `version: 4` once deployed, and the new words are:

| Field | New words |
|---|---|
| `aum.points[].refused`, `aum.gaps[].reason`, `aum.chains[].reason` | `price_suspect`, `no_tokens_known` (and `wallet_unreadable`, `service_timeout` now on `chains[].reason`) |
| `aum.drawing.reason` | `rebuilt_only` |
| `aum.points[].reliability` | `low` |
| `aum.stepChosenFrom` | `window`, `tracked_span`, `fallback` |
| `aum.sampler.state` | `never_read` |
| `positions.partialReason` | `unsellable_positions`, `unpriced_positions`, `indexer_coverage_low`, `unsellable_positions_and_indexer_coverage_low` |
| `positions[].priceSuspectReason` | `implied_mcap_over_ceiling`, `concentration_over_ceiling` |
| `wallets.resolvedBy.*` | `fomoapi`, `gmgn`, `submitted` |
| `health.staleFeeds[]` | `scorecards` |
| `scorecard.loadOutcome` | `loaded`, `unavailable`, `degraded`, `not_found`, `error` |
| `scorecard.nextLoadBasis` | `nightly_slot` |
| `pnl.openPositionsBasis.*` | `trade_records`, `trade_records_still_held_on_chain` |
| `trades.status` | `closed_by_balance` |

Plus a `constants` block on `/v1/fields`: `{ pricedFloor: 0.25, partialServeFloorUsd: 100,
drawableMinPoints: 2 }`. Full contracts are in `Field_Contracts.md`, the two sections headed
"Added 17 Sep 2026"; route-level detail is in `docs/PARAMETER_ROUTES.md`.

## Per ask

`$BASE` is the API root. Add `&live=false` where shown so the check is on stored readings.

| Ask | Status | What changed | How to verify |
|---|---|---|---|
| **N1** native ETH / BNB counted nowhere | fixed on branch, not yet deployed | The sampler now reads `eth_getBalance` per wallet per chain; ETH and BNB are positions with `isNative: true` under the sentinel `0x0000000000000000000000000000000000000000`, priced from the same Binance pairs as the wrapped coin, on `/aum`, `/positions` and `/portfolio`. | `GET $BASE/v1/traders/gmgn_0xf80d7961/aum?window=all&live=false` → newest `totalUsd` ≈ 1.19 × ETH price, not 0 |
| **R1** publish the floor | fixed on branch, not yet deployed | `constants.pricedFloor: 0.25` and `constants.partialServeFloorUsd: 100` on `/v1/fields`. | `GET $BASE/v1/fields` → `.constants` |
| **R2** serve a large partial | fixed on branch, not yet deployed | A reading under the count floor whose figure is ≥ $100 is served with `totalUsd`, `partial: true`, `partialReason: unpriced_positions`; only thin *and* small readings are refused `too_little_priced`. The rule is read-time, so every refused reading was re-classified at once. | `GET $BASE/v1/traders/gmgn_hzyjnkimyy/aum?window=all&live=false` → readings carry `totalUsd` with `partialReason: unpriced_positions` |
| **R3** retry a refused reading | declined, reason: there was nothing to retry | The refusal was never in the sampler; the floor is applied when the route reads, so R2 re-classified all 500 readings with no re-pricing. A same-day retry, when one happens, is visible with `?step=1h` (B3). | `GET $BASE/v1/traders/gmgn_hzyjnkimyy/aum?window=1w&step=1h&live=false` → every reading in the week, none refused for the floor alone |
| **R4** price Robinhood-chain coins | fixed on branch, not yet deployed | A nightly DexScreener loader writes Robinhood (4663) prices into `token_prices`; they surface as the existing `priceSource: token_prices_daily` on `/positions` and in the sampler (`docs/R4_ROBINHOOD_PRICES.md`). | `GET $BASE/v1/traders/baolingd/positions?limit=20` → Robinhood rows with `priceSource: token_prices_daily`, `coverage.pricedPositions` well above 3 |
| **R5** a failing chain served as $0 | fixed on branch, not yet deployed | Chains are read in isolation; a chain that fails carries `reason` on `chains[]`, the reading is `partial: true, partialReason: chains_missing`, and a reading with no chain answered is `totalUsd: null`, never 0. `/health` counts `feeds.aum.chains.{chain}.failed24h`. | `GET $BASE/v1/traders/gmgn_0x314e6555/aum?window=1w&live=false` → no `totalUsd: 0` with `chainsAnswered: 0` |
| **R6** BSC coverage a sliver of the wallet | fixed on branch, not yet deployed | `positions.coverage.chains.{chain}` = `{ chainTxCount, rowsHeld, share, readAt }` from one `eth_getTransactionCount` per sampled EVM chain; `share < 0.5` marks the list `partialReason: indexer_coverage_low`. | `GET $BASE/v1/traders/gmgn_0xf1d07077/positions` → `.coverage.chains.bsc.share`, `.partialReason` |
| **V1** $101B served as verified | fixed on branch, not yet deployed | A price is refused when `price × total supply > $20B`; a reading is refused `price_suspect` when one position is > 90% of a total that is > $1B or whose cap is unknown. Refused readings keep `partialUsd` and are never `tier: verified`; the row carries `priceSuspect: true`, `priceSuspectReason`. Readings already written over $1B were re-classified. | `GET $BASE/v1/traders/luckedhub/aum?window=1w&live=false` → newest reading `refused: price_suspect`, no verified billion |
| **V2** honeypot counted at full value | fixed on branch, not yet deployed | `isHoneypot` and `canSell` ride on every position row; flagged value is kept out of `totalValueUsd` into `unsellableUsd`, and the answer is `partial: true, partialReason: unsellable_positions` on `/portfolio`, `/positions` and the batch. | `GET $BASE/v1/traders/Lasercat397/positions` → `unsellableUsd` ≈ 58,631, `partialReason: unsellable_positions` |
| **Z1** $0 for a reading that priced nothing | fixed on branch, not yet deployed | A chain with nothing to read is `totalUsd: null`, `refused: no_tokens_known`, and does not count in `chainsAnswered`; `0` is written only when a chain was actually queried and every answer was empty. A priced sum under a cent is `0.00` with `pricedPositions ≥ 1`, not rounded away. | `GET $BASE/v1/traders/gmgn_0xcb4d28c2/aum?window=1m&live=false` → the empty readings are `null` with `no_tokens_known`, not `0` |
| **Z2** one chain served as the whole account | fixed on branch, not yet deployed | Expected chains are `knownChains` on both sampler and route; a reading answering fewer is `partial: true, partialReason: chains_missing` and never stands as `now` while a fuller one exists in the window. | `GET $BASE/v1/traders/gmgn_0x0fde7f37/aum?window=1w&live=false` → one-chain readings carry `partial: true`, `now` is the fullest reading |
| **H1** rebuilt points draw coins no longer held | partly | Every `basis: rebuilt` point carries `reliability: low`, and a series of rebuilt points alone is not drawable (`drawing.reason: rebuilt_only`); `drawableMinPoints` is met by sampled points only. Rebuilding from balance-at-block is declined: it needs the archive `eth_call`s `README.md` §"What all means" rules out. | `GET $BASE/v1/traders/frankdegods/aum?window=1m&live=false` → `points[] | select(.basis == "rebuilt") | .reliability` is `low` |
| **T1** load when a scorecard passes its allowance | fixed on branch, not yet deployed | Every fomoapi attempt is recorded: `scorecard.loadAttemptedAt`, `loadOutcome` (`loaded` / `unavailable` / `degraded` / `not_found` / `error`), `nextLoadBasis: nightly_slot`; `/health` counts `staleTraders.scorecardLoadFailed`. A second, 6-hourly loader pass retries traders past 72 h the same day. | `GET $BASE/v1/traders/smokey0x/scorecard` → `loadAttemptedAt` moves each pass, `loadOutcome` says what fomoapi answered |
| **T2** `dataState` says degraded while scorecards are stale | fixed on branch, not yet deployed | A feed is stale when its clock is old *or* any trader is past that feed's own allowance; `staleFeeds` carries `scorecards` while `scorecardStale > 0`, and `dataState` is `degraded`. | `GET $BASE/v1/health` → `staleFeeds` includes `scorecards` and `dataState: degraded` while `staleTraders.scorecardStale > 0` |
| **T3** build the scorecard from the on-chain swap stream | planned | After the migration; depends on T1 and on EVM receipt resolution first (`wallet_swaps` holds 81 EVM swap groups against Solana's 4,696). No date yet. | — |
| **P1** `/pnl.openPositions` 10× the `/positions` list | fixed on branch, not yet deployed | `openPositions` (trade records) is now beside `openPositionsHeld` (trade records whose token is still held on chain), with `openPositionsBasis` naming each; a nightly step marks a trade `status: closed_by_balance` when the wallet no longer holds the token, never counted as open or as a realised close. | `GET $BASE/v1/traders/baolingd/pnl` → `openPositionsHeld` matches `/positions` `count`, `openPositions` is the old figure |
| **S1** daily step folds a short record into one point | fixed on branch, not yet deployed | The step is chosen from the shorter of the window and `now − trackedSince`, with a fallback to the finest step that gives two points; `stepChosenFrom` (`window` / `tracked_span` / `fallback`) says which. | `GET $BASE/v1/traders/gmgn_8gv31ab8mt/aum?window=1m&live=false` → `stepChosenFrom: tracked_span`, `drawing.drawable: true` |
| **A1** ready / warming / none counts on `/health` | fixed on branch, not yet deployed | `feeds.aum.historyState: { ready, warming, none }` over every trader-chain, and the same block inside `feeds.aum.chains.{chain}`, by the same rule as `knownChains[].historyState`. | `GET $BASE/v1/health` → `.feeds.aum.historyState`, `.feeds.aum.chains` |
| **F1** on-chain block for every chain, or drop it | fixed on branch, not yet deployed | `onChain.chainsCovered: [...]` names the chains the transaction feed holds for the wallet; zeros beside a chain not in the list mean "not covered", not "inactive". | `GET $BASE/v1/traders/gmgn_0xf80d7961` → `.onChain.chainsCovered` |
| **F2** feed freshness from accepted readings | fixed on branch, not yet deployed | `feeds.aum.state` is judged on the newest *accepted* reading; the sampler's own clock moved to `feeds.aum.samplerLastRunAt`; `staleTraders.noReading` counts traders with no accepted reading (refused rows do not count). | `GET $BASE/v1/health` → `staleTraders.noReading` ≈ your 54, not 6 |
| **F3** one word for a wallet never read | fixed on branch, not yet deployed | `aum.sampler.state: never_read` when the sampler has never written a row for the trader, with `sampler.reason` saying so, instead of `current, warming: false, no_reading`. | `GET $BASE/v1/traders/<a trader whose /wallets shows every chain historyState: none>/aum?window=1w&live=false` → `sampler.state: never_read` |
| **L1** say what the batch does with `live` | fixed on branch, not yet deployed | `POST /v1/traders/aum` accepts and ignores `live` (query or body); it never reads live. Every row carries `liveRead: { state: "skipped", note: "batch never reads live; use GET /v1/traders/:handle/aum" }`. | `POST $BASE/v1/traders/aum?live=true` body `{"contractVersion":2,"ids":["unipcs"],"window":"1w","live":true}` → `traders[0].aum.liveRead.state: skipped` |
| **L2** 4 s for a stored single-trader answer | planned | Profiled after the Cloudflare port, where the cost is measured on the runtime it will run on; Hyperdrive query caching is part of that work. No date yet. | — |
| **W1** say how a wallet was found | partly | `wallets.resolvedBy.{evm, solana}` is `fomoapi` / `gmgn` / `submitted`, a straight mapping of the stored source. `fingerprintMatches` is on the response and always `null`: no fingerprint count is stored, and none will be invented. | `GET $BASE/v1/traders/unipcs/wallets` → `.resolvedBy`, `.fingerprintMatches` |
| **O1** `onChain` all zeros on a read chain | fixed on branch, not yet deployed | Same change as F1: `onChain.chainsCovered`. | `GET $BASE/v1/traders/gmgn_0xf80d7961` → `.onChain.chainsCovered` excludes `ethereum`, so the zeros are "not covered" |
| **B3** where a same-day retry shows | fixed on branch, not yet deployed | `?step=1h` is the unbucketed form: every reading in the window comes back one per hour bucket (readings are never closer than an hour). Documented in `PARAMETER_ROUTES.md` §9. | `GET $BASE/v1/traders/gmgn_8gv31ab8mt/aum?window=1w&step=1h&live=false` → `count` equals the readings held, `bucketMs: 3600000` |
| **K1** remaining allowance for the key | declined, reason: already served | The counter is keyed on `x-api-key`, so `RateLimit-Remaining` is that key's own allowance; `RateLimit-Scope` says whether it is `global` or `unlimited` (limiter failing open). No change. | `curl -sD - -o /dev/null -H "x-api-key: $KEY" $BASE/v1/health` → `RateLimit-Remaining`, `RateLimit-Scope` |
| **G1** ramp figures (240/min) | planned | Runs against a non-production deployment only: the shadow Worker from the migration's Phase 1. Figures follow when it runs; no date yet. | — |
| **A3 secret** `WALLET_SUBMIT_SECRET` | planned | Handed over out of band, never through the repo or this document. `POST /v1/traders/:handle/wallets` is live and answers `401` without it. | `POST $BASE/v1/traders/zeri_term/wallets` with the header once you have it → `201`; `409 address_in_use` on a collision |

## Not asked, but changed alongside

- `aum.chains[].reason` now names the wall a single chain hit (`wallet_unreadable`,
  `service_timeout`, `no_tokens_known`, `price_suspect`), so a partial reading says which chain
  is missing and why.
- `aum.coverage.partialReason: unpriced_positions` can now carry a `totalUsd` (R2); read
  `partial` before `totalUsd`, as before.

## Deployment

All of the above is on the branch and verified there; the deployment date is pending and will
be sent with the `/v1/fields` version bump so your build check can gate on it.

## Versioning note

The Cloudflare deployment will serve these same routes under `/v2/*`; the Supabase deployment stays `/v1/*`. Links inside responses are spelled for whichever version you call, and `/health.apiVersion` says which answered. No field changes between the two.
