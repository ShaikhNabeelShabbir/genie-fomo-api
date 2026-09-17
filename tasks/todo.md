# Fix request v5 (17 Sep 2026) — plan

Source: `/Users/gr00t/Downloads/genie-fomo-fix-request-v5-17-sep.md`.
Branch `cloudflare-migration`. Every finding below was traced in code and, where marked
MEASURED, confirmed against production D1 (`wrangler d1 execute --remote`).

## Root causes (not symptoms)

### RC1 — three different price ladders value the same coin
| reader | ladder | where |
|---|---|---|
| `/positions` rows | pegged(`is not null`) -> `token_info.price_usd` -> newest `token_prices` close, ANY age | `worker/src/jobs/balances.ts:167` — written at balance-read time and **frozen** in `holdings.price` |
| `/aum/now`, `/aum/history` current hour | pegged(`>0`) -> `token_price_stats.last_usd` -> `token_prices` close <=7d -> `token_info` | `worker/src/jobs/valuation.ts:433` |
| `/aum/history` past hours | pegged -> `token_price_hourly` sample <=24h -> THAT DAY's `token_prices` close -> `token_info` (current hour only) | `worker/src/jobs/valuation.ts:305-311` |

Consequences: V1d, A1, N1, R7 are all one bug. `/positions` can never see the hourly
DexScreener price (`token_price_stats`), so Robinhood coins and re-priced natives stay null
until the next balance read — and the sweep is ~9 h (25 traders x 2 runs/h, 450 traders).

### RC2 — a total is served from any price coverage above $100
`valueGroup` (`worker/src/jobs/valuation.ts:105-109`) only refuses when the count share is
under `PRICED_FLOOR` **and** the total is under $100. So a figure built from 2 of 289 coins is
served as a full `totalUsd` with `reason: null`.

MEASURED, `aum_history`: 32,866 rows carry a `total_usd`; **25,492 of them (78%) are built
from under 25% of the wallet.**

MEASURED, 397397's sawtooth is this and nothing else:
- `01:00` basis `reading`, 217 of 279 priced -> $351,321.95
- `00:00` basis `priced`, **2 of 289** priced -> $43,780.82
Both served as facts. The flat $43,780.82 rung is a 0.7%-coverage figure.

MEASURED, cupseyy has NO readings — every hour is `priced`, and the priced count swings
118 / 5,082 / 187 / 187 / 187 / 1,131 / 193 / 1,135 across 06:00-13:00 on 11,278 positions.
The $2.5B at 07:00 is the 5,082-priced hour: junk that cleared the suspect rule.

### RC3 — the live catch-up runs on the build job's leftovers
`runAumHistory` (cron `25 * * * *`) spends its budget on the hour-build loop, then refreshes
stale `aum_live` rows only `while (Date.now() - started < budgetMs)`
(`worker/src/jobs/aum_history.ts:88-99`). When the build fills the budget, nobody is refreshed.
That is A2: gmgn_0xcb4d28c2 stuck at 07:35 with `source: build`.

### RC4 — `complete` is a pagination fact
`transactions.ts:426` `complete: !capped`. `coverage.byChain[].state` is `complete` iff >=1
`wallet_swaps` row exists (`:462`). Neither knows about the ingestion horizon.

### RC5 — Solana has a hard 500-signature horizon
`worker/src/jobs/transfers.ts:19-21,93`: `PAGES=5`, Helius page size 100, and `before = null` —
**no persisted cursor**. Every run re-pulls the newest 500 signatures per wallet, forever.
That is smokey0x's 6 Aug wall, and it is why his profile counts 1,260 swaps while `/trades`
returns 6.

### RC6 — `share` divides two different things
`positions-core.ts:99-107`: `share = rows_held / chain_nonce`, where `rows_held` is the count of
**transfer legs** we hold and `chain_nonce` is Bitquery's **realtime-window sent-tx count**
(`bitquery.ts:166-173`). Not a ratio of anything. Hence 8.5 and 2.2989. No 200-row cap exists
anywhere — tdmilky's 238 vs 200 is coincidence, not a limit.

### RC7 — `canSell` ignores the honeypot flag
`positions-core.ts:83-87`: `canSell` negates `can_not_sell` alone; `is_honeypot` never touches it.

### RC8 — `/health.feeds.aum` still watches the retired sampler
`health.ts:181-182` reads `aum_samples`. The sampler was unscheduled 17 Sep; `aum_history` and
`aum_live` are what write the hours after 06:00. That is X3's contradiction.

## Work items — all done

- [x] **W1 RC1, one price ladder.** `shared/price-ladder.ts` (`ladderPrice`, `oldestUsableDay`,
      `unpackDaily`): pegged -> `token_price_stats` -> `token_prices` <= 7 days -> `token_info`.
      Wired into `/positions`, `POST /traders/positions` and `/portfolio` as four selected
      columns plus one packed correlated seek (`day || '|' || usd`, so the rung costs one seek
      per row, not two). Rows are repriced and revalued in memory, then re-sorted, because the
      stored `h.value` the SQL ordered by no longer equals the served value. `/portfolio` also
      gains the suspect rule, which it never had. Fixes V1d, A1, N1, R7 together.
- [x] **W2 RC2, coverage decides what is published.** `confidence()` in `shared/aum-history-rules.ts`,
      applied at READ time in `routes/aum-history.ts` to points and to `now`. `pricedShare` on
      every figure; `partial: true` between 0.05 and 0.25; withheld below 0.05 with `partialUsd`.
      Read time, not build time: the whole stored series is judged on deploy with no rebuild.
      `coverage.pricedShare` added to `/positions` so the three routes are comparable.
- [x] **W3 A3, no holes.** `fillHourGaps()`; an hour between the first and last point with no
      row is a null point with `reason: "not_built"`. Nothing invented before the first point.
- [x] **W4 RC3, A2.** `catchUpLive()` extracted and moved to the FRONT of `runAumHistory` with
      `LIVE_BUDGET_SHARE = 0.25` reserved. `/health.staleTraders` gains `liveStale`,
      `liveStaleAfterHours`, `liveNever`, `oldestLiveHours`.
- [x] **W5 RC4/RC5, W2.** `complete` = not capped AND no chain unresolved AND none truncated,
      with `incompleteReason`. `coverage.byChain[].horizonAt` on every chain and `truncated` on
      Solana until the walk finishes. `_shared/transactions.ts` gains `solanaBefore` and
      reports `exhausted`; `transfers.ts` `walkBack()` pages backwards from the oldest signature
      we hold. Migration `0005_solana_backfill_cursor.sql`: `wallets.sol_backfill_done` plus
      `transactions (address_key, network_id, block_time)` for the seek.
- [x] **W6 RC4, the trade counts.** `onChain.swaps` -> `swapsAppearedIn` (distinct tx, not legs)
      plus `ownSwaps` from `wallet_swaps`.
- [x] **W7 RC6, C1.** `share` -> `rowsPerSentTx`, `rowsHeld` -> `transferRowsHeld`.
- [x] **W8 RC7, H2.** `canSell` is false whenever `isHoneypot` is true.
- [x] **W9 RC8, X3.** `feeds.aum` watches `aum_history` / `aum_live`; the retired sampler's
      clocks move to `feeds.aum.sampler` with `retired: true`.
- [x] **W10 L2.** `shared/cache.ts` (`ttlCache`, `urlKey`, bounded at 64 slots); `/tokens` and
      `/tokens/momentum` cached 60 s per query string.
- [x] **W11 vocabulary 12.** `token_price_stats`, `not_built`, `truncated`;
      `trades.coverage.byChain[].state` published for the first time.
- [x] **W12 docs.** `openapi.yaml` (G2 `logoUrl` marked not-yet-published and dropped from
      `required`; every renamed and new field; the Python `User-Agent` note in `info`),
      `docs/consumer/Field_Contracts.md`, `docs/consumer/reply-to-genie-v5.md`.
- [x] **W13 tests.** `tests/price_ladder_test.ts`, `tests/aum_confidence_test.ts`,
      `tests/cache_test.ts`; `positions_core_test`, `events_test`, `vocabulary_test` updated.

## Not done here, deliberately

- **Not deployed, and the migration is not applied.** `0005` MUST land before the deploy: the
  new code selects `wallets.sol_backfill_done` and `/trades` will 500 without it.
  `cd worker && npx wrangler d1 migrations apply genie-copy-trading --remote`, then
  `npx wrangler deploy`.
- **The `/tokens` query rewrite.** The cache does not save a cold isolate, and `/tokens`
  aggregates the whole holdings view before any limit applies. Item 6 of
  `docs/REVIEW_EFFICIENCY_17_SEP.md`. Promised to the app team for 24 Sep.
- **`truncated` for EVM chains.** Bitquery gives no end-of-history signal, so only Solana can
  say the walk finished. `horizonAt` is published for every chain; the state is not.
- **`liveBasis.evm: nightly_read`** is wrong by a factor of twelve (the read is twice an hour).
  Correcting it is a vocabulary bump, so it waits for 13 rather than riding on this one.
- **`market.ts` and `fields.ts`** keep their own inline caches. `shared/cache.ts` should absorb
  them, but converting working code with no behaviour change is churn, not a fix.

## Review (2026-09-17)

Twenty asks; every one answered in `docs/consumer/reply-to-genie-v5.md` as fixed, planned with
a date, or open with the reason. Thirteen code changes across 14 files.

**The finding that mattered.** Five of their top asks were one bug. Three price ladders existed
for the same coin, and `/positions` served a price frozen into the row at the last balance read
— a sweep of about nine hours. The proof is one query: 75 traders hold the identical amount of
`0xdad7e2...ac70`, and the stored price reads 0.000004391 for 28 of them, 0.005436 for 15, and
null for 32, decided purely by when each wallet was last read.

**The finding that changed the product.** A total was published from any price coverage as long
as it exceeded $100. Measured on production D1: **25,492 of 32,866 valued `aum_history` hours,
78%, were built from under a quarter of the wallet.** 397397's flat $43,780.82 rung is a
2-of-289 figure and his ~$354,000 hours are 217-of-279; both were served as facts, and the
sawtooth between them is what the app team charted. Applying the rule at read time rather than
at build time means the whole stored series is judged the moment it deploys, with no rebuild.

**Verification.** `deno task check` 0 errors; `deno task test` 238 passed, 0 failed;
`npx tsc -p worker/tsconfig.json` clean; `npx wrangler deploy --dry-run` bundles;
`npx @redocly/cli lint docs/openapi.yaml` valid with 0 warnings (the baseline was 0; the 7 my
renames introduced were stale response examples and are fixed). The ladder query was run
against production D1: 33 rows / 10.7 ms on a small trader, and 2.6 s on cupseyy's 11,325 rows,
of which the new correlated seek is ~0.83 s.

**Two changed tests were the point, not collateral.** `events_test` asserted a honeypot could be
sold, and `vocabulary_test` asserted `now.reason` and `points[].reason` are identical lists —
the second is now a subset check, because `not_built` is a word only a series can use.

**The cost we accepted.** `/positions` for the largest trader gains ~0.8 s of D1 time against a
15 s route budget on a route that already took 13.1 s. It buys correctness on four asks. If it
starts tripping the race, the fix is the `holdings_live` roll-forward (807k rows read for one
trader), not the ladder.

Lesson: the app team's figures were right every time and our status labels were wrong three
times (V1d, N1, R6 said "Fixed" while data was still filling). Their suggested wording,
"Fixed, filling by <date>", is now the rule in the reply.
