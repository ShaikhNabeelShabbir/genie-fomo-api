# To do before the Cloudflare migration

Written 16 September 2026 from the Genie app team's fix request v2
(`genie-fomo-fix-request-v2-16-sep.md`, copied into this repo unchanged), read against the
code on branch `Junaid-deve-starts`. Every item names the ask ids from that document, the
root cause with a file and line, the fix, its size, and how to prove it.

## Why these come before the migration, not after

1. **The sampler is what is being ported.** Six of the seven P0 items below live in
   `supabase/functions/aum-sample/index.ts` or `_shared/chain_reads.ts`. Fixing them in Deno
   now means the Worker port carries the fix; fixing them after means editing the same
   logic twice, once in each runtime, while both are live.
2. **The migration's gate is a behaviour diff.** `scripts/acceptance_capture.sh` proves the
   port preserves what the service does today. Today it serves a verified $101 billion
   reading and counts 1.19 ETH as $0. A diff that comes back empty would prove the port
   preserved those. Baseline against corrected behaviour, then port.
3. **Every new word must be published in `/v1/fields` before it is served.** The consumer's
   build fails on an unpublished enum value (their §9). Several fixes add words, so the
   `/fields` change ships first in each case, and the field-contract count moves from 150.
4. **The consumer has stopped waiting.** Their §9 lists what they now measure themselves.
   Every week of delay makes the service's readings less load-bearing for its only consumer.

The scoreboard they sent: of 17 asks from the morning, 0 fixed, 3 partly, 13 not. The six
they rank first: **V1, N1, Z1, Z2, R2, R5**. That order is kept here.

## How to use this file

Each item is one PR on `Junaid-deve-starts` (or a branch off it), deployed with
`npx supabase functions deploy`, verified with the repro requests quoted, and then captured:

```bash
# the defect traders, as a second regression set alongside the five acceptance traders
./scripts/acceptance_capture.sh "$BASE" captures/defects \
  gmgn_0xf80d7961 gmgn_0x08b2526b gmgn_0xcb4d28c2 gmgn_hzyjnkimyy gmgn_8gv31ab8mt \
  sadcrissy frankdegods baolingd gmgn_0x314e6555 gmgn_0x65c13772 gmgn_0xf1d07077 \
  gmgn_0x0fde7f37 luckedhub shahh trancey smokey0x Lasercat397 ZephyrTrading
```

Sizes: **S** under a day, **M** one to three days, **L** a week or a data-source decision.

---

## P0 — falsifies screens; do first, in this order

### 1. V1 — an impossible price served as a verified $101B (luckedhub, shahh) · M

**Symptom.** `luckedhub` `aum` 16 Sep: `totalUsd: 101,615,408,967`, `tier: verified`. One
mint, 11.4M units at $8,923.86, 99.93% of the total; on-chain supply 999.9M, so the implied
market cap is $8.9 trillion. `shahh`: $14.7M from one coin at $1,019 a unit, 99.5% of the
total, $2.5K banked.

**Root cause.**
- The sampler's only guards are `MAX_PRICE_PER_TOKEN = 1_000_000` and
  `MAX_POSITION_USD = 1_000_000_000` (`aum-sample/index.ts:56,73`, twin
  `scripts/load_aum_samples.mjs:59,76`). $8,923 passes the first; $101B fails the second
  only since the ceiling was cut from $1T on 16 Sep, and readings written before that deploy
  stand. $14.7M passes both.
- **No implied-market-cap check exists anywhere.** `tokens.total_supply` is never read by
  either sampler or by `scripts/load_chain_balances.mjs`, and `scripts/load_token_supply.mjs:85-93`
  only fetches supply for tokens with a trade at `avg_entry_price > 0`. The mints that
  produce these figures are held-never-traded, so their supply is never loaded.
- **The `/positions` path has no ceiling at all.** `scripts/load_chain_balances.mjs:186-215`
  writes `value = human_amount * price` with no check, so `/positions` shows the $101.5B row
  even after the sampler would refuse it.
- Position rows do carry `tokenAddress` (`routes.ts:1538`) and `priceSource` (`:1553`).
  The consumer reports a row with neither for `shahh`; check whether `tokens.address` is
  null for that mint (a Solana mint with a `token_key` but no `address` row).

**Fix.**
1. Publish in `/v1/fields`: reason word `price_suspect`, row field `priceSuspect: true`
   with `priceSuspectReason` (`implied_mcap_over_ceiling`, `concentration_over_ceiling`),
   and the two constants.
2. Extend `load_token_supply.mjs` to every mint in `holdings_current` (one cacheable
   `getTokenSupply` / `totalSupply()` per mint), not only traded ones.
3. One shared `value()` used by both the sampler and `load_chain_balances.mjs`:
   refuse a price when `price × total_supply > $20B` (supply known), and refuse a
   *reading* as `price_suspect` when a single position is over 90% of the total and either
   its implied cap is unknown or the total exceeds $1B. A reading refused this way is
   `total_usd: null`, `refused_reason: 'price_suspect'`, and never `tier: verified`.
4. Re-classify what is already written: `update aum_samples set total_usd = null,
   refused_reason = 'price_suspect' where total_usd > 1e9`; re-sample `luckedhub` and
   `shahh` by hand (`POST aum-sample {"handles":[…]}`).
5. Both `chain_reads` twins and both samplers change together (`_shared/chain_reads.ts:1-13`
   says so).

**Verify.** `GET /v1/traders/luckedhub/aum?window=1w&live=false` → newest reading refused
`price_suspect`, partial figure beside it. `GET /v1/traders/shahh/positions?limit=3` → top
row carries `tokenAddress`, `priceSource`, `priceSuspect`. Their §2d has the exact requests.

### 2. N1 — native ETH and BNB counted nowhere · M

**Symptom.** `gmgn_0xf80d7961` holds 1.19 ETH; every reading is `$0`. Across the roster
$241K of ETH and 448 BNB are in no reading. SOL is priced on 182 of 182 chains; ETH on 0 of
605, BNB on 0 of 181.

**Root cause.** The read, not the price table. `solanaBalances` calls `getBalance` and
pushes native SOL as a position under the system-program key
(`_shared/chain_reads.ts:123-128`). `evmBalances` only ever calls `balanceOf` over tokens
the trader traded (`_shared/chain_reads.ts:139-191`); **there is no `eth_getBalance` in
either copy.** Native ETH/BNB never becomes a `Position`, so it is never priced, summed or
counted. The price rows already exist: `quote_assets` seeds WETH on 1 / 8453 / 4663 and
WBNB on 56 (`20260904070000_initial_schema.sql:245-258`, `20260909120000_robinhood_quote_assets.sql:20-21`)
and `scripts/load_quote_prices.mjs:29-35` already maps `WETH → ETHUSDT`, `WBNB → BNBUSDT`.
`routes.ts:462-465` surfaces the gap as `whyNoNative`.

**Fix.**
1. Publish in `/v1/fields` first: the native position's `symbol` (`ETH`, `BNB`, `SOL`),
   `isNative: true` on the row, and the sentinel `tokenAddress`
   `0x0000000000000000000000000000000000000000` for EVM native.
2. Seed `tokens` and `quote_assets` rows for the sentinel on 1, 56, 8453, 4663, priced by
   `load_quote_prices.mjs` from the same Binance pairs (do **not** key native under WETH's
   address: a wallet holding both would collide on `(handle, network_id, token_key)`).
3. `evmBalances` in both twins: add one `eth_getBalance` per wallet per chain, push
   `{ address: ZERO, amount: scale(wei, 18) }`. `load_chain_balances.mjs` gets the row into
   `holdings`, so `/positions` and `/portfolio` show it too.
4. Retire `whyNoNative` or make it say `priced`.

**Verify.** `GET /v1/traders/gmgn_0xf80d7961/aum?window=all&live=false` → newest reading
≈ 1.19 × ETH price. `GET /v1/traders/397397/portfolio` → per-chain `native` block priced on
every chain. Also unblocks Z1 below: with native read, "wallet is empty" becomes testable.

### 3. Z1 — `$0` served for a reading that priced nothing · S

**Symptom.** 220 sampled points with zero positions at `totalUsd: 0`, none `null`; 76
newest readings are $0 while 24 of those traders have holdings on `/positions`.
`gmgn_0xcb4d28c2`: `aum` says "1/1 priced, $0", `/positions` says "0 priced, null".

**Root cause.** `aum-sample/index.ts:361-368`: `else if (total === 0) totalUsd = 0` — zero
positions across answered chains is written as 0 on purpose ("the one place a zero is the
TRUE value"). But `total === 0` also happens when the sampler had **nothing to read**: EVM
chains read only traded tokens (`tradedByNet`), so a wallet whose traded set on that chain is
empty, or whose tokens lack a resolved `network_id`, reads as zero positions, not as
unreadable. The "1/1 priced, $0" case is a position whose value rounds below a cent
(`value()` at `:97-103` returns `{usd}` for any positive price).

**Fix.**
1. Publish `no_tokens_known` in `/v1/fields`.
2. In the sampler: a chain with an empty token set **and** no native balance to read is
   not "answered with zero", it is unread — `total_usd: null`,
   `refused_reason: 'no_tokens_known'`, and it does not count in `chains_answered`.
3. `total === 0` writes `0` only when at least one chain was actually queried (native
   balance call succeeded) and every answer was empty. After N1 that is well-defined.
4. Never round a stored total; round at presentation (`round()` in `db.ts:62` already says
   so). A priced sum under a cent is still a figure; publish it as `0.00` with
   `pricedPositions ≥ 1`, which is what `/positions` should then also say.

**Verify.** Their §4 repro. Sweep count "sampled zero-position points at 0 / null" should
move from 220 / 0 toward 0 / 220 for the unread cases.

### 4. Z2 + R5 — one chain served as the whole account; a failing chain served as $0 · M

**Symptom.** `gmgn_0x0fde7f37` (bsc, robinhood, base known): readings alternate
`[robinhood]`, `[bsc]`, `answeredChains: 1 of 3`, `partial` unset. `gmgn_0x314e6555` (BSC
only): $338 on 10 Sep, then four readings `0/0 positions, answeredChains 0 of 1,
chains_missing` at `totalUsd: 0`. 25 whole-account $0 readings while another chain holds
money; 204 traders have a read chain older than 4 h.

**Root cause.**
- The sampler does loop every chain per trader (`aum-sample/index.ts:161-200`), but the
  chain list comes from `tradedByNet`, and `readBalances` **throws on the first unreadable
  wallet and refuses the whole trader-hour** (`:164-167, 189-192`, documented `:137-144`).
  There is no per-chain isolation: one 403 from a public RPC costs every chain.
- `chains_expected = attemptedCount` (`:404`) counts what the sampler tried, while
  `/aum`'s "of 3" comes from `knownChainsFor` (`routes.ts:7218-7250`: presence ∪ holdings ∪
  chain samples). The two disagree by construction, so a reading can say "1 of 1" in the
  database and "1 of 3" on the wire.
- A reading with `chains_answered = 0` should be `total_usd: null` (`:412-421`); the
  consumer sees `0` with `chains_missing`. Reproduce before fixing: `POST aum-sample
  {"handle":"gmgn_0x314e6555","dryRun":true}` and log which chains were attempted and why.
- `routes.ts:5006-5010` prefers the reading with the most `chains_answered` inside 36 h for
  `now`, but never sets `partial: true` on one that answered fewer than known.

**Fix.**
1. Expected chains = `knownChainsFor` (same set the API publishes), computed once in SQL
   and shared by sampler and routes.
2. Per-chain isolation: catch per chain, write `aum_chain_samples` for the chains that
   answered, `null` with `reason` for the ones that did not, and set the parent
   `partial: true, partialReason: 'chains_missing', chainsMissing: [...]` when
   `chains_answered < chains_expected`. `chains_answered = 0` ⇒ `total_usd: null`, always.
3. Retry a failed chain once at the end of the slice (the throttle in
   `_shared/chain_reads.ts:41-73` already backs off; a second pass after the other traders
   is cheap).
4. `/health`: per-chain `feeds.aum.chains[chain].{accepted36h, failed24h, newestAcceptedAt}`
   so "BSC stopped answering on 14 Sep" is visible without a sweep.
5. A partial reading never stands as `now` when a fuller one exists inside the window;
   when only partials exist, `now` carries `partial: true` on the wire.

**Verify.** Their §2b and §2e repros; `/health` shows BSC failure counts; the sweep's
"stalest read chain p90" should fall from 160 h.

### 5. R1 + R2 — the 25% floor: publish it, and serve large partials · S

**Symptom.** `gmgn_hzyjnkimyy`: 0 of 32 readings accepted, `partialUsd` up to $221K,
`/positions` values him at $26,688. `frankdegods` $2.4M partial refused at 24.3%. 55 readings
refused at 20–24.3%. 500 refused readings from 10–14 Sep, none re-priced.

**Root cause.** `PRICED_FLOOR = 0.25` at `routes.ts:4588`, applied at `:4603-4613`. It is a
**count** share (`priced / total` positions, `aum-sample/index.ts:376`), so a wallet with
hundreds of dust mints and a few valuable ones is refused although its value is priced. It is
applied **at read time only**; neither sampler stores the floor. That is the good news: the
500 refused readings are refused by a rule in `routes.ts`, and changing the rule
re-classifies all of them at once. **Nothing needs re-pricing.** `/v1/fields`
(`routes.ts:6737-6892`) publishes the word `too_little_priced` and a unit for
`pricedPositionShare` but not the constant.

**Fix.**
1. Publish `pricedFloor: 0.25` and `partialServeFloorUsd` in `/v1/fields`.
2. Rule: a reading below the count floor is **served as partial**, not refused, when
   `partial_usd ≥ $100` (`partial: true`, `partialReason: 'unpriced_positions'`,
   `pricedPositionShare` beside it); refused only when both the share and the figure are
   small. Refusal keeps `partialUsd` as today.
3. Answer R3 honestly: there is nothing to retry, because the refusal was never in the
   sampler. Point the consumer at `?step=1h` to see every reading (B3 below).

**Verify.** `GET /v1/traders/gmgn_hzyjnkimyy/aum?window=all&live=false` → 32 readings
served partial; the sweep's "refused 20–25%" goes 55 → 0.

### 6. T2 — `dataState: current` beside 16 scorecards stale for nine days · S

**Root cause.** `dataState` is derived only from `staleFeeds` (`routes.ts:7067`), and
`staleFeeds` only from the seven feed clocks (`:7019-7034`). `staleTraders.scorecardStale`
(`:7076-7087`) is computed and published but feeds nothing. The `trades` feed clock moves
whenever *any* trader loads, so it is `current` while 16 traders are 221 h old.

**Fix.** A feed is `stale` when its clock is old **or** when any trader is past that feed's
own `staleAfterHours`; add `scorecards` to `staleFeeds` with the count, so `dataState` says
`degraded`. Publish the rule in `/v1/fields`. One function, no schema.

### 7. S1 — daily step folds a short record into one point · S

**Root cause.** The step chooser at `routes.ts:4702-4706` picks the coarsest step giving
≥24 buckets over the *window*: `1m` → 30d/1d = 30 → `1d`; `all` → `span === null` short-
circuits to `1d`. A trader tracked since 10 Sep gets one daily point and `too_few_points`
(`:5125-5150`), while `1w` draws three at 6 h.

**Fix.** Choose from `min(window, now − trackedSince)` (`trackedSince` is already at
`:4965-4966`), and when daily bucketing leaves `usablePoints < 2`, fall back to the finest
step that gives two. Emit `stepChosenFrom: "tracked_span"` so the change is visible.

### 8. L1 — say what the batch does with `live` · S

**Root cause.** `POST /v1/traders/aum` never calls the sampler (design note
`routes.ts:5791-5792`, body parsing `:6589-6604` reads no `live` key). It is already
`live=false`; it just does not say so.

**Fix.** Put `liveRead: { state: "skipped", note: "batch never reads live; use the
single-trader route" }` on every batch row, accept and ignore `live` in the body, and say so
in `/v1/fields`. K1 answer in the same reply: `RateLimit-Remaining` is already per key
(`index.ts:95-101` buckets on `x-api-key`); the `RateLimit-Scope` header says whether the
counter is global.

---

## P1 — before cutover

### 9. V2 — a confirmed honeypot counted at full value · S

`/portfolio` (`routes.ts:428-436`) and `/positions` (`:1493-1509`) never join
`token_info.is_honeypot` / `can_not_sell`; only the token routes do (`:1719-1720`, `:1909`).
Fix: join the flags onto position rows (`isHoneypot`, `canSell`), exclude flagged value from
`totalUsd` into `unsellableUsd`, and mark the reading `partial: true, partialReason:
'unsellable_positions'`. The sampler's `pricesFor` (`aum-sample/index.ts:119-135`) gets the
same join. Publish the word first. Repro: Lasercat397, `0x26bec…4608`.

### 10. P1 — `/pnl.openPositions` ten times the `/positions` list (104 traders) · M

`/pnl` counts `trades` with `status <> 'closed'` (`routes.ts:7646-7654`, note: not
`= 'open'`); `/positions` lists `holdings_current` (chain balances, `:1493-1509`). Two
sources, nothing reconciles them. Fix in two steps: (a) publish both,
`openPositions` (trade records) and `openPositionsHeld` (trade records whose token is in
`holdings_current` with `human_amount > 0`), with `basis` on each; (b) a nightly step that
marks a trade `status = 'closed_by_balance'` when the wallet no longer holds the token,
carrying `closedBy`. Publish the status word first.

### 11. T1 — trades stuck at 7–8 Sep for the same 16 traders · M

`refresh.yml:94-95` runs `load_trades.py --converge --all --stale-hours 20`. A trader whose
fetch fails (degraded / 404 / error, `load_trades.py:252-260`) is dropped **without writing**,
so `ingested_at` never moves, they are reselected every pass, and `loadedAt` ages forever.
`nextLoadAt` (`routes.ts:3417-3422`) is a hard-coded next 06:00, not a schedule. All 16 are
fomoapi.io traders; run the loader for `smokey0x` by hand with logging to see which answer
fomoapi gives (a changed handle is one candidate: `traders.handle_changed_at` exists).

Fix: record every attempt (`trade_loads(handle, attempted_at, outcome, detail)`), surface
`loadAttemptedAt` / `loadOutcome` on the scorecard and `staleTraders.scorecardLoadFailed` on
`/health`, and add a second, lighter cron (every 6 h, `--stale-hours 72`, no `--all`) so a
trader past his own allowance is retried the same day. fomoapi budget is ~100 calls a run
against 10k a month; four extra small passes fit.

### 12. A1 / F2 / F3 — health counts per chain, freshness from accepted readings · M

`feeds.aum.state` comes from the sampler's `lastSuccessAt` (`routes.ts:7019-7032`), which
is `current` while 54 traders have no accepted reading anywhere. Add
`feeds.aum.historyState: {ready, warming, none}` per chain (the states `knownChains`
already computes per trader), base `state` on accepted readings per chain inside 36 h, and
give a never-read wallet its own word on `/aum` (`sampler.state: 'never_read'`) instead of
`current, warming: false, no_reading`. Publish the word first.

### 13. H1 — rebuilt points: mark them, and do not draw on them alone · S

No `reliability` field exists; `drawable` counts rebuilt and sampled points identically
(`routes.ts:5126`). Add `reliability: 'low'` to every `basis: rebuilt` point, and require
`MIN_DRAWABLE_POINTS` to be met by **sampled** points. The larger ask (rebuild from balance
at block rather than from everything ever received) is declined for now: the archive
reads it would need are the ones `README.md` §"What all means" already rules out.

### 14. W1 / O1 — say how a wallet was found; cover every chain in `onChain` · S

No `resolvedBy` and no fingerprint count exists in the schema; `wallets.evm_source` is
fomoapi's own `src_evm` (`20260904073000_wallets_one_row_per_trader.sql:47-50`). Publish
`resolvedBy` as a straight mapping of `*_source` (`fomoapi.io` / `gmgn` / `submitted`) and
state that no fingerprint count is stored. `onChain` on `/v1/traders/:handle`
(`routes.ts:1246-1270`) counts whatever `transactions` holds, which is almost all Solana;
add `chainsCovered: [...]` to the block so all-zeros reads as "not covered", not "inactive".

### 15. B3 — where a same-day retry shows · S

The 6 h buckets keep the last point per bucket (`routes.ts:4730-4735`). `?step=1h` is
already accepted (`aumOptions`); confirm it returns every reading on `window=1w` and
document it in `PARAMETER_ROUTES.md` as the unbucketed form.

---

## P2 — after the migration, or needs a decision

| Ask | What it needs | Why later |
|---|---|---|
| **R4** price Robinhood-chain coins (28 of 39 refused chains price under 5%) | a price source for chain 4663 that GMGN does not cover: on-chain DEX pool reads or an aggregator | data-source decision and a new loader |
| **T3** build the scorecard from the on-chain swap stream | `wallet_swaps` holds 81 EVM swap groups against Solana's 4,696 (`routes.ts:5940-5950`); EVM receipt resolution first | L, and depends on T1 |
| **R6** per-chain indexer coverage (`eth_getTransactionCount` vs rows held) | one RPC call per wallet per sample, a `coverage` block on `/positions` | M; do with Z2's health work |
| **L2** 4 s for a stored single-trader answer | profile `aumFor` (`routes.ts:5620-5700`); the migration's Hyperdrive caching helps only once query caching is turned back on | after the port, where the cost is measured on the new runtime |
| **H1** rebuild from balance-at-block | archive `eth_call`s for every held token at every point | declined for now (see 13) |

---

## Replies the consumer is waiting for (their §10)

1. **`WALLET_SUBMIT_SECRET`** — hand over out of band, never in the repo. Their three
   traders without an address (zeri_term, bamblewood8, qwerty888) are waiting on it.
2. **One line per ask**: fixed / planned with a date / declined with the reason. This
   file is the draft of that reply; send it once P0 dates are set.
3. **G1 ramp** (240/min) — run against a non-production deployment only; the shadow Worker
   from `CLOUDFLARE_MIGRATION.md` §13 Phase 1 is the right target.

## Where this touches the migration

- P0 items 1–4 change `aum-sample/index.ts` and both `chain_reads` twins. Land them and
  deploy on Supabase **before** porting the sampler (`CLOUDFLARE_MIGRATION.md` §15 phase 4),
  then port the corrected file once.
- Items 5–8, 12, 13 and 15 change `routes.ts` only. They are safe to land before the
  `Ctx` threading of the port; do them first so the mechanical edit is done once on the
  final logic.
- After P0: re-run `scripts/acceptance_capture.sh` twice against Supabase with both the
  five acceptance traders and the defect list above, diff, and keep those captures as the
  migration baseline. `Field_Contracts.md` count goes up by the number of new words.

## Tracking

| # | Ask | Owner | Status |
|---|---|---|---|
| 1 | V1 | | open |
| 2 | N1 | | open |
| 3 | Z1 | | open |
| 4 | Z2, R5 | | open |
| 5 | R1, R2, R3 | | open |
| 6 | T2 | | open |
| 7 | S1 | | open |
| 8 | L1, K1 | | open |
| 9 | V2 | | open |
| 10 | P1 | | open |
| 11 | T1 | | open |
| 12 | A1, F2, F3 | | open |
| 13 | H1 | | open |
| 14 | W1, O1 | | open |
| 15 | B3 | | open |
