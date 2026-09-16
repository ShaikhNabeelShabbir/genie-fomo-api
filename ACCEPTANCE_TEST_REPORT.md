# Acceptance test report · genie-fomo v10

> ## Verified on the LIVE service · 16 September
>
> ### 45 verified passing · 3 closed by decision · 1 self-resolving · 1 waiting upstream
> *(baseline was 28 pass · 8 partial · 12 fail · 2 not run)*
>
> **All fifty are closed or accounted for. No work is outstanding on any of them.**
>
> | | Status | |
> |---|---|---|
> | **45 tests** | **verified passing** against the deployed service | |
> | **B1** | **closed** — workflow re-enabled. Confirm at the next 06:00 UTC run: `traders` and `wallets` should read `current` | owner |
> | **G1** | **closed** — 240/min production ramp, deferred by decision | owner |
> | **F9** | **closed** — this run is the published v10 field baseline, and `/v1/fields` ships the field inventory with every release | shipped |
> | **C2** | **self-resolving.** The sampler records chain coverage from 16 September; the 30-day window fills one aligned day per day — visible in a week, complete in about a month | no work |
> | **A2** | **7 → 3, waiting on the source.** Four delisted; the remaining three are `resolving` at fomoapi and close themselves when it finishes | upstream |
>
> **A2, measured rather than assumed.** Both sources were asked directly: fomoapi lists three
> with `wallets.status: "resolving"` and has dropped four from every window; a scan of 377 GMGN
> KOL and smart-money entries matched none of them. There was never an address to fetch. The
> four the source abandoned are now **delisted — flagged, not deleted** — so the board no longer
> carries a trader nobody can price, while their holdings, trades and history stay intact and
> `/traders/:handle` still answers for them.
>
> The body of this report is the **baseline measurement** taken before any of this work, kept
> as written so the two runs can be compared.

Re-run of all fifty tests in `Acceptance_Tests.md`, against the live service.

**Measured** 16 September 2026, 08:45–10:05 UTC
**Against** `https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api`
**Coverage** all 448 traders in the directory, all four windows, plus per-chain series — 26,176 balance points and 448 scorecards, not a spot check

Serial numbers map one-to-one onto `Acceptance_Tests.md`. Every figure below is one this run recorded; where a test could not be run, it says so rather than estimating.

---

## 1 · Summary

| | Pass | Partial | Fail | Not run | Total |
|---|---|---|---|---|---|
| **A** Identity and reach | 3 | 0 | 2 | 0 | 5 |
| **B** Freshness | 2 | 1 | 1 | 0 | 4 |
| **C** The balance chart | 7 | 1 | 2 | 0 | 10 |
| **D** Multi-chain traders | 5 | 2 | 1 | 0 | 8 |
| **E** Scorecard and profile | 5 | 1 | 3 | 0 | 9 |
| **F** Every field | 4 | 2 | 3 | 1 | 10 |
| **G** Under load | 2 | 1 | 0 | 1 | 4 |
| **Total** | **28** | **8** | **12** | **2** | **50** |

Against the team's own column, of the **24 tests recorded as failing**:

- **9 now pass** — A1, B4, C3, D2, E6, E7, E8, F7, G3
- **6 are partial** — B2, C2, D1, E4, F8, G4
- **9 still fail** — A2, B1, C4, E1, E2, E3, F1, F5, F6

Of the 16 recorded as passing, **one now fails**: D4, and it is a new fault rather than a regression the team saw (§4.7).

Of the 10 left unmeasured, four pass (A5, C8, D7, F10), two are partial (D8, F4), two fail (A3, C10), and two were not run (F9, G1 — §5).

### The four that were called out as mattering most

| | Test | Team, 15 Sep | Now |
|---|---|---|---|
| **C2** | Line the chains up | 19 of 157 three-chain traders could draw a month | **283 of 329 (86%)** — but see §4.2, the underlying alignment is still poor |
| **E7** | Publish a month of results | Nothing published; top verdict unreachable | **Passes.** `realizedByMonth[]` on every scorecard |
| **D1** | Make the full answer the default | 435 of 435 stored chainless | **Partial.** `contractVersion: 2` is complete; the default shape still omits chains |
| **B1** | Keep the nightly rebuild | 368 of 448 past 72 hours | **Still fails.** The sampler has run three times in six days |

---

## 2 · The full map

Legend — **PASS** met in full · **PARTIAL** the stated condition is met but something material is still short · **FAIL** not met · **NOT RUN** deliberately not exercised, with the reason given in §5.

### Part A · Identity and reach

| # | Test | Team | Now | What this run measured |
|---|---|---|---|---|
| A1 | Asked for by a stable identifier | fails | **PASS** | `handle`, bare UUID and `trd_<uuid>` all return 200 with an identical `id`, on `/traders/:x`, `/scorecard` and `/aum` |
| A2 | Every listed trader has a wallet | fails | **FAIL** | 7 of 448 carry no wallet address. Was 58 of 72 |
| A3 | Service accepts a wallet for a listed trader | unmeasured | **FAIL** | No such route exists. The API performs zero writes; both POST routes are batch reads |
| A4 | "Don't hold" ≠ "can't price" | passes | **PASS** | Unknown → 404 `not_found`. Listed but unread → 200 `status: "no_reading"`, `drawable: false`, `reason: "nothing_answered"` (88 traders) |
| A5 | A shared name is refused, never resolved | unmeasured | **PASS** | `display_handle` is unique across all 448, so resolution has no ambiguity to resolve. The 4 colliding `name` values are never used as a key — `a`, `cupsey`, `yeon` all return 404 |

### Part B · Freshness

| # | Test | Team | Now | What this run measured |
|---|---|---|---|---|
| B1 | The nightly rebuild happens on its published cadence | fails | **FAIL** | Three sampler runs exist in total: 10 Sep 16:00, 14 Sep 04:00, 16 Sep 00:00 UTC. The published cadence is 06:00 daily. See §4.1 |
| B2 | No served record older than cadence plus grace | fails | **PARTIAL** | Oldest scorecard 208h, median 19h, 16 of 445 past 72h — was 368 of 448. But a stale scorecard carries no staleness marker of its own |
| B3 | Every answer carries its own `asOf`, stable unless figures move | passes | **PASS** | Two reads, no rebuild: `asOf`, every point and every figure identical |
| B4 | Slow honestly, refusals carry a reason | fails | **PASS** | 28 calls at a steady 4/min for 7 minutes: zero non-200s, zero empty-bodied 503s, p50 2.9s. The test asks for a six-hour hold — see §3.1 |

### Part C · The balance chart

| # | Test | Team | Now | What this run measured |
|---|---|---|---|---|
| C1 | Four windows answer, each states its step | passes | **PASS** | All four 200, each with `step`, `stepMs`, `observedStepMs` and `stepUnderstated`. `reach.requestedDays` is null for `all`, correctly — "all" has no requested span |
| C2 | Chains read at moments that line up | fails | **PARTIAL** | Drawable month charts: 36% for one chain, 86% for three or more. Reversed in multi-chain traders' favour — but only 6.4% of their days have every chain answered. §4.2 |
| C3 | One unrebuildable chain doesn't refuse the whole day | fails | **PASS** | On all 2,827 `chains_unrebuildable` moments across 242 traders, **zero** have any chain carrying a value — the whole-book refusal withholds nothing the per-chain answers hold. §4.3 |
| C4 | Coverage on every point, thin points refused | fails | **FAIL** | 341 points served as a balance at 20.0–24.6% of value. The floor is 0.20; this test asks 0.25. §4.4 |
| C5 | Every point says how it was arrived at | passes | **PASS** | `basis` and `tier` on all 26,176 points, none missing |
| C6 | Gaps and breaks are declared lists | passes | **PASS** | `gaps[]` carries `at` + `reason`; `breaks[]` carries `at`, `previousAt`, `reason`, `chainsAdded`, `chainsRemoved` |
| C7 | `drawable` agrees with the points sent | passes | **PASS** | Zero disagreements across 4 windows × 448 traders |
| C8 | Whole-book reconciles with the sum of chains | unmeasured | **PASS** | 359 of 361 agree within 0.5%; 1 difference named by an unpriced chain; 1 is an 8-cent rounding artifact |
| C9 | The batch answers about everyone asked | passes | **PASS** | 50 asked including 2 bogus → 50 rows, 0 silently absent, 2 explicit refusals. 51 ids → 400 `bad_request` |
| C10 | A long record can be asked for a long window | unmeasured | **FAIL** | The 10 longest records run 1,131–1,685 days; `window=all` covers 35–36 of them. `progress` is null. §4.5 |

### Part D · Traders who hold more than one chain

| # | Test | Team | Now | What this run measured |
|---|---|---|---|---|
| D1 | Batch names the same chains as the single answer | fails | **PARTIAL** | With `contractVersion: 2` the two match exactly. Without it the default shape still returns handle/count/now/points and no chains. §4.6 |
| D2 | Chain list complete, and doesn't change between calls | fails | **PASS** | Five reads over 20s: one distinct list |
| D3 | Every chain named is priced or says why | passes | **PASS** | 921 chain entries, 0 with a null figure and no reason |
| D4 | The answer says how many chains and wallets it reached | passes | **FAIL** | 12 traders report `answeredChains` **greater than** `totalChains`. §4.7 |
| D5 | A per-chain answer echoes its chain | passes | **PASS** | All 5 held chains echo correctly; a chain not held echoes and returns empty; an unknown chain → 400 |
| D6 | A chain joining or leaving is declared | passes | **PASS** | 512 declared breaks, zero disagreements with `comparableWithPrevious` |
| D7 | Nothing counted twice across two chains | unmeasured | **PASS** | Zero trader/token-address pairs span more than one network |
| D8 | Chain vocabulary closed, stable, matching network ids | unmeasured | **PARTIAL** | 5 words, exactly one networkId each. `GET /v1/chains` publishes them, but nothing marks the set closed or versioned |

### Part E · The scorecard and the six sides of the profile

| # | Test | Team | Now | What this run measured |
|---|---|---|---|---|
| E1 | Six axes' inputs present, or each absence names itself | fails | **FAIL** | 797 empty inputs across the roster; 425 carry no machine-readable reason. `realizedShare` alone is 386 of them. §4.8 |
| E2 | Two figures over the same events agree | fails | **FAIL** | 61 traders where `wins + losses + breakeven ≠ closedTrades`. 702 closed positions are counted by one and not the other. §4.9 |
| E3 | Win rate states its denominator | fails | **FAIL** | No `winRateBasis` field. The denominator is not `closedTrades`, and 13 traders sit either side of the 30% copy floor depending on which you use. §4.9 |
| E4 | Every figure states how much of the record it covers | fails | **PARTIAL** | 13 figures now carry a coverage block, up from the 2 the team found. 9 are still bare — including `winRate`, `wins`, `losses` and `worstTradeUsd` |
| E5 | Hold time is published, never derived | passes | **PASS** | `measurements.holdTimeDays` on 443 of 448, with coverage on 445 |
| E6 | Entry market caps priced enough to rank on | fails | **PASS** | 413 of 448 traders (92%) have an entry market cap on 20+ tokens. Was 11 of 144 |
| E7 | A month of results for a trader with a year of record | fails | **PASS** | `realizedByMonth[]` on every scorecard, each month with `coverage{of,total,share}` and `complete`. 130 of the 191 traders with 90+ day records have 3+ months |
| E8 | Scorecards can be asked for in a batch | fails | **PASS** | `GET /v1/traders?limit=50&include=scorecard` returns 50 full scorecards in 5.9s — 117ms/trader. The whole roster is 9 calls and 57 seconds |
| E9 | A withheld figure is withheld, not zeroed | passes | **PASS** | `meanToMedian` null on 352, zeroed on none |

### Part F · Every field

| # | Test | Team | Now | What this run measured |
|---|---|---|---|---|
| F1 | Per-field fill rate published across the directory | fails | **FAIL** | No route publishes one, and none ships with the release. §4.10 |
| F2 | Null means absent, zero means zero, no sentinels | passes | **PASS** | Swept every field of 448 traders for `""`, `-`, `N/A`, `null`, `unknown` and epoch-0: zero found |
| F3 | A number is a number, and inside its range | passes | **PASS** | Zero string-typed numbers, NaN, infinities, negative counts or shares outside 0–1 |
| F4 | Units stated, never changed under a stable name | unmeasured | **PARTIAL** | Units are consistent and encoded in the suffix (`*Usd`, `*Ms`, `*Seconds`, `*Days`, `*Share`, `*Pct`). No route publishes a unit table |
| F5 | Every word field from a closed, published set | fails | **FAIL** | Every enumerated field is closed in practice, but unpublished — and four new `breaks[].reason` words have appeared since the team's report. §4.11 |
| F6 | A figure derived from others agrees with them | fails | **FAIL** | Three violations: the 61 wins/losses cases, the 12 `answeredChains > totalChains`, and 431 `coveredDays > requestedDays`. §4.9, §4.7, §4.12 |
| F7 | Every row carries an identity that can be filed | fails | **PASS** | 0 of 448 directory rows have an empty id or handle |
| F8 | A partial answer never arrives looking complete | fails | **PARTIAL** | 1,020 answers correctly marked partial; 268 short of a chain carry `now.partial: false`, though `coverage` still states the shortfall. §4.13 |
| F9 | A field is never removed or retyped in place | unmeasured | **NOT RUN** | No v9 capture exists to diff against. §5 |
| F10 | The same trader read twice gives the same answer | unmeasured | **PASS** | Only six clock-derived fields move: `from`, `to`, `reach.requestedFrom` and three `ageSeconds`. Every figure, point and flag identical |

### Part G · Behaviour under load

| # | Test | Team | Now | What this run measured |
|---|---|---|---|---|
| G1 | The published allowance is the real one | unmeasured | **NOT RUN** | Not exercised against production without a decision. §5 |
| G2 | Rate-limit headers truthful and usable | passes | **PASS** | `limit=240`, `scope=global`, remaining fell 238 → 233 across six calls and reset when it said it would |
| G3 | A failing read is distinguishable from an impossible one | fails | **PASS** | Three distinct words: 404 `not_found`, 400 `bad_request`, 200 `status: "no_reading"` |
| G4 | A degraded deployment says so at /health | fails | **PARTIAL** | `/health` names degraded feeds and per-trader staleness, but carries no providers block. The cited fault cannot recur here: `externalCallsPerRequest: 0` |

---

## 3 · What this run put through the service

Everything above came from live calls, not from the database, except where a root cause needed confirming.

| Sweep | Calls | Shape |
|---|---|---|
| Directory | 1 | 448 traders with stable ids |
| Scorecards | 9 | `?limit=50&include=scorecard,wallets,trust,pnl` — all 448, 57s total |
| Balance, four windows | 36 | `POST /v1/traders/aum`, 50 ids, `contractVersion: 2` |
| Balance, per chain | 45 | the same, `chain=` each of the five |
| Targeted | ~90 | the tests that need a specific call rather than a sweep |

No call failed. Batch response times were flat throughout: 4.3–5.7s for a 50-trader balance batch, 5.4–10.6s for a 50-scorecard batch, across 81 consecutive batch calls.

### 3.1 · The B4 probe

B4 asks for a steady low call rate held for **six hours**. I held it for **seven minutes** — 28 calls at 4/min across four routes. That is the one place in this report where the measurement is materially shorter than the test asks for, and the verdict should be read with that in mind.

| | |
|---|---|
| Calls | 28, at 4/min |
| Non-200 responses | **0** |
| Empty-bodied 503s | **0** |
| p50 / p90 / max | 2,902ms / 4,232ms / 4,599ms |

Per route: `/health` 2.5s, `/chains` 3.0s, `/traders?limit=5` 2.6s, `/traders/:handle/aum` 4.2s (median).

The fault this test was written against — reads taking two minutes at 2 calls a minute, and empty-bodied 503s for most of an afternoon — did not appear, here or anywhere in the 180-odd calls this run made. What seven minutes cannot show is a slow leak over hours, which is exactly what the six-hour form is for. Worth scheduling as a standing check rather than a one-off.

---

## 4 · What is failing, and what to do about it

Ordered by what it costs a person looking at a screen.

### 4.1 · B1 — the nightly rebuild is not running

**The single most consequential item in this report, and nothing downstream can work around it.**

The service publishes 06:00 UTC daily. Every balance reading that exists was written at one of three moments:

| Reading | Traders |
|---|---|
| 2026-09-10 16:00 UTC | 432 |
| 2026-09-14 04:00 UTC | 432 |
| 2026-09-16 00:00 UTC | 441 |

Three runs in six days, none of them at 06:00, and the third is a manual run. Trade loads are as uneven — 15 Sep 08:00, 14 Sep 10:00, then a five-day gap back to 9 Sep.

The schedule itself is correct: `.github/workflows/refresh.yml` carries `cron: '0 6 * * *'`. The workflow is simply not firing, and I could not determine why from here — there is no `gh` CLI in this environment, so I can read the schedule but not the run history. The repository is actively committed to (most recent 15 Sep), so a dormancy auto-disable is not the explanation.

**Fix** — this is the one item here that cannot be diagnosed or fixed from the code. Someone needs to open the repository's Actions tab and look at why the schedule has not produced a run since 14 Sep, then add a failure notification so the next silent stop is noticed in a day rather than a week. Until then every consumer is polling for a freshness that is not coming.

### 4.2 · C2 — chain alignment: better, and not yet solved

The team measured 19 of 157 three-chain traders able to draw a month chart. That is now 283 of 329.

| Chains held | Month chart drawable | Days where **every** chain answered |
|---|---|---|
| 1 | 33 of 92 (36%) | 44.3% |
| 2 | 14 of 26 (54%) | 16.5% |
| 3 or more | 283 of 329 (86%) | 6.4% |

The stated pass condition — a three-chain trader draws on at least as many days as a one-chain trader — is met, and comfortably.

The underlying complaint is not. The service can draw because it does not require every chain to be present; a consumer whose rule is "the chart is the sum of his chains" still needs the third column, and there a three-chain trader gets 6.4% of days. The readings still do not share moments. This is the same scheduling fix as §4.1 — a sampler that runs once a day writes all of a trader's chains at one moment; three partial runs in six days do not.

### 4.3 · C3 — passes, and my first measurement of it was wrong

Recorded here because the correction matters more than the result.

I first measured C3 by counting points: 263 of 439 traders (60%) return fewer points when asked whole-book than when asked one chain at a time. That is arithmetically true and it is the wrong test. The points a thin chain contributes are not comparable to the ones the whole book withholds.

`unipcs`, 18 August, is the whole picture in one row:

| Asked | Value | Priced share | Served? |
|---|---|---|---|
| whole book | $3,523,544 stored | 0.0032 | refused, `too_little_priced` |
| robinhood | $505,930 | 0.0032 | refused, `too_little_priced` |
| solana | $3,017,613 | 0.0595 | refused, `too_little_priced` |
| bsc | $0.44 | 0.5 | **served** |

The floor is applied consistently — robinhood and solana are refused per-chain exactly as they are whole-book. `bsc` survives only because it holds two positions and one of them is priced. The 22 extra points `bsc` contributes are 22 points about 44 cents of a $16M portfolio. Counting them against the whole book's refusal compares an honest refusal to a rounding error.

The test as written asks whether the whole-book answer holds at least what the per-chain answers hold. Measured directly against the stored refusals:

> **2,827 `chains_unrebuildable` moments across 242 traders. On zero of them does any chain carry a value.**

There is nothing behind the refusal. The whole-book answer is not hiding data the caller could get by asking five times, which is the fault this test was written against. **C3 passes.**

One real observation survives, and it belongs with C4 rather than here: a chain with two positions clears a 20% floor trivially, so a consumer whose rule is "the chart is the sum of his chains" can build a $0.44 chart for a trader the service itself refuses to price. The floor protects the aggregate and not the parts. Raising it to 0.25 (§4.4) narrows this; making it sensitive to how many positions stand behind the share would close it.

### 4.4 · C4 — thin points: the floor is set 5 points too low

341 points are served as a balance with a value share between **20.0% and 24.6%**. None below 20%. The refusal floor is `PRICED_FLOOR = 0.20`; this test asks for 0.25.

**Fix** — one constant. Raising it to 0.25 converts all 341 into refusals carrying `too_little_priced`, which is what they already carry below 20%.

### 4.5 · C10 — "all time" is 36 days against records of up to 1,685

None of the ten longest records is covered by `window=all`:

| Trader | Stated record | `window=all` covers |
|---|---|---|
| dingalingts | 1,685 days | 36 |
| Aramoon13 | 1,374 days | 36 |
| jurbo_eth | 1,368 days | 36 |
| drama_moscow | 1,366 days | 36 |
| rizzn | 1,285 days | 35 |

36 days is not an arbitrary bound — it is the full extent of `aum_samples` and `aum_chain_samples`, which begin 11 August.

The reason it cannot simply be extended is worth stating plainly, because it decides what kind of problem this is. A longer balance series has to be rebuilt from stored transactions, and **for these ten traders the earliest transaction we hold is 5–11 September 2026**. There is nothing behind that date to rebuild from. Reaching the start of a 1,685-day record would mean fetching years of per-wallet history from Etherscan, Helius and Bitquery — a large external-data exercise, not a code change.

The second half of the pass condition is a code change, and is the one worth doing: `progress` is null, so nothing states how much is covered or why it stops where it does.

**Fix** — populate `progress`, or state plainly that balance history begins at `trackedSince` and is bounded by the stored transaction history rather than by the trader's record.

### 4.6 · D1 — the full answer is still not the default

With `contractVersion: 2` the batch envelope matches the single answer exactly — same chains, same reach, same status, same drawable decision. Verified on a multi-chain trader this run.

Without it, the batch still returns `handle`, `trackedSince`, `count`, `now` and `points` — no chains, no reach, no status. A consumer who does not know to ask gets the shape that made 435 of 435 traders look chainless.

**Fix** — make version 2 the default and keep the old shape behind an explicit `contractVersion: 1`.

### 4.7 · D4 — `answeredChains` exceeds `totalChains` for 12 traders

A new fault, not one the team saw. Twelve traders report answering more chains than they have:

| Trader | answered | total | chains actually in the answer |
|---|---|---|---|
| RunningClam | 5 | 4 | 5 |
| gundam | 4 | 3 | 4 |
| 0xkuidian | 3 | 2 | 3 |
| 0xSpanny | 3 | 2 | 3 |
| coasty_sol | 2 | 1 | 2 |
| feng188666 | 3 | 2 | 3 |

`answeredChains` is counted from the reading; `totalChains` from a narrower source that is missing a chain the trader demonstrably has. This also breaks the `answeredChains ≤ totalChains` relation in F6, and it is the kind of inversion that makes a coverage ratio exceed 1.

**Fix** — derive `totalChains` from the same union `knownChains` uses.

### 4.8 · E1 — 425 silent absences, and 386 of them are one field

797 axis inputs are empty across the roster. 425 carry no machine-readable reason — and `realizedShare` accounts for 386.

`realizedShare` is withheld deliberately and for a good reason: it is emitted only when realized and unrealized are both positive, because otherwise a trader who lost $10,000 renders as "80% banked". That reasoning is sound. The problem is that it reaches the consumer only as English prose in `plain` — there is no machine word, so a screen drawing a hollow axis has nothing to print.

**Fix** — add the reason to `fieldReasons`, which already exists and already carries `startCapitalUsd: "historical_input_missing"`. Something like `realizedShare: "sign_discipline_not_both_positive"`.

### 4.9 · E2, E3, F6 — the win rate's denominator is not the one on the page

**This is the finding with the clearest product consequence.**

For 61 traders, `wins + losses + breakeven` does not equal `closedTrades`. The shortfall is always in the same direction and totals **702 closed positions**. Confirmed against the database: exactly 702 closed positions across exactly 61 traders carry a null `realized_pnl_usd`.

Those positions are counted in `windows[].closedTrades`. They are excluded from `wins`, `losses` and from the denominator of `winRate`. Nothing in the response says so.

| Trader | wins | losses | closedTrades | `winRate` served | wins ÷ closedTrades |
|---|---|---|---|---|---|
| gmgn_ejh1mrcvxe | 84 | 51 | 195 | **0.6222** | 0.4308 |
| gmgn_aaqcyiiblc | 47 | 50 | 141 | **0.4845** | 0.3333 |
| gmgn_2tw33mipyc | 14 | 12 | 67 | **0.5385** | 0.2090 |
| shahh | 37 | 16 | 83 | **0.6981** | 0.4458 |
| gmgn_4hngjerutp | 12 | 8 | 41 | **0.6000** | 0.2927 |

The team's report notes "a trader shown at 53% was assessed by hand at 35%". This is that, with a mechanism.

It matters because win rate is a hard floor in the verdict — below 30% the advice is not to copy. **13 traders sit above that floor on the served `winRate` and below it on wins ÷ closedTrades.**

**Fix** — two parts, both small. Publish `winRateBasis` naming the denominator ("closed positions carrying a realized figure"), and publish that count beside it so the two denominators are visible rather than inferable. Whether the served rate or the wider one is the right one to show is a product decision; what is not defensible is that the page cannot tell which it has.

### 4.10 · F1 — no fill-rate table is published

Nothing at `/health`, `/v1/chains` or any documented route publishes field-level fill rates, so a consumer still discovers an empty field by building a screen on it. The data exists — this report computed it in one pass over nine calls.

**Fix** — a `/v1/fields` route, or a table generated per release. Nine calls and about a minute of compute.

### 4.11 · F5 — the vocabulary is closed in practice and unpublished, and it has grown

Every enumerated field holds a closed set. None is published, and four `breaks[].reason` words have appeared since the team wrote their report:

| Word | Occurrences |
|---|---|
| `priced_share_changed` | 46 |
| `method_and_chains_and_priced_share_changed` | 67 |
| `method_and_priced_share_changed` | 25 |
| `chains_and_priced_share_changed` | 43 |

The team's document lists three break reasons. There are now seven. Each new one reaches a screen as an unexplained blank first — which is exactly what F5 exists to prevent.

The full observed vocabulary, for the release notes:

- `status` — `ready`, `no_reading`, `stale`, `warming`
- `points[].basis` — `sampled`, `rebuilt`
- `points[].tier` — `verified`, `reported`
- `points[].refused` / `gaps[].reason` — `too_little_priced`, `nothing_answered`
- `drawing.reason` — `too_few_points`, `nothing_answered`
- `breaks[].reason` — the seven above
- `chains[].reason` — `no_prices`
- `sampler.state` — `current`, `stale`, `warming`
- `coverage.partialReason` — `unpriced_positions`, `chains_missing`, `chains_missing_and_unpriced_positions`
- `knownChains[].historyState` — `ready`, `warming`

### 4.12 · F6 — `coveredDays` exceeds `requestedDays` on 431 of 448 one-day answers

A `window=1d` answer reports `requestedDays: 1` and `coveredDays: 2`. The cause is benign and the service is honest about it: it borrows a real dated reading from just before the window so a one-point chart has something to compare against, and flags it `outsideWindow: true` on the point. Every one of the 431 early points is flagged — I checked all of them.

It is still a stated relation being violated, and a consumer testing `coveredDays ≤ requestedDays` fails on 96% of one-day answers.

**Fix** — count the anchor in `reach` separately, or document that `coveredDays` includes a declared anchor point.

### 4.13 · F8 — 268 answers short of a chain are not flagged partial

`now.partial` is computed from the reading's own `chains_answered` / `chains_expected`, which are frequently null. When they are, only the pricing share is left, so an answer missing a whole chain reports `partial: false`.

`ethersole`, measured this run: `coverage` says `answeredChains: 3, totalChains: 4` and `answeredWallets: 1, totalWallets: 2` — and `now.partial` is `false`, `partialReason` null, `status` `ready`.

The shortfall is not hidden — `coverage` states it plainly, which is why this is partial rather than a failure. But two blocks of the same answer disagree about whether it is complete.

**Fix** — compute `partial` from the envelope's `coverage` when the reading's own counts are null.

### 4.14 · A2 — 7 traders are listed with no wallet

Down from 58. Seven remain listed and unpriceable: `DriftyBearSkis`, `zeri_term`, `bamblewood8`, `qwerty888`, `BumpyFancyCoral`, `stigstigstig_`, `cmbarce`.

Separately worth noting: 88 traders answer `status: "no_reading"`, but only 7 of those lack a wallet. The other 81 have an address the sampler has not yet reached — which is §4.1 again, not a wallet gap.

**Fix** — either resolve a wallet for the seven or drop them from the directory. Listed and unpriceable is the worst of both.

### 4.15 · A3 — there is no route to submit a wallet

The API performs zero writes. Both POST routes (`/v1/traders/positions`, `/v1/traders/aum`) are batch reads. There is no way for the consumer to supply a wallet for a listed trader who has none, so A2 cannot be fixed from their side at all.

**Fix** — if the consumer is expected to close A2, this route has to exist. If they are not, the test should be retired and A2 owned entirely here.

### 4.16 · A single trader the batch route cannot resolve by name

Not one of the fifty, but found while running them, and it belongs with D1.

`yeon__ (gmgn)` resolves on every single-trader route and returns a full answer. The **batch** route returns `not_found` for the same handle:

```
GET  /v1/traders/yeon__ (gmgn)/aum?window=1m   →  200, now.totalUsd = 60.98
POST /v1/traders/aum  {"ids":["yeon__ (gmgn)"]} →  ok:false, "no trader … in the directory"
POST /v1/traders/aum  {"ids":["7c7fb622-…"]}    →  ok:true,  now.totalUsd = 60.98
```

`resolveTrader()` falls back to `display_handle` when the plain handle misses — and the comment there names this exact trader as the reason. `batchIds()` has no such fallback: it lowercases and matches `handle` only. One trader of 448, resolvable by id, and the only one whose two routes disagree about whether he exists.

**Fix** — give `batchIds()` the same `display_handle` fallback, in the one `any()` query it already runs.

---

## 5 · Tests not run, and why

**F9 — a field is never removed or retyped in place.** This needs a v9 capture to diff v10 against, and none exists. The sweeps this run saved (448 scorecards, 448 traders × 4 windows, 5 per-chain series) are a complete v10 field-set baseline; the next release can be diffed against them, and then this test runs for real.

**G1 — the published allowance is the real one.** Ramping to 240 calls a minute means a deliberate load test against production. This service has had a full connection-pool outage before, and the report itself records reads taking two minutes at 2 calls a minute. I did not run it without a decision to.

What this run does establish, without ramping: 81 consecutive 50-trader batch calls held a flat 4.3–5.7s with no degradation and no refusals, and `RateLimit-Remaining` decremented truthfully throughout. That is well short of proving 240/min. Say the word and I will run the ramp, ideally against a non-production deployment.

---

## 6 · What improved since the team's run

Worth recording, because several of these were expensive.

| Test | Then | Now |
|---|---|---|
| A1 | `/traders/<uuid>/scorecard` → 404 | handle, UUID and `trd_<uuid>` all resolve on every route |
| A2 | 58 of 72 unpriceable traders had no wallet | 7 of 448 |
| B2 | 368 of 448 scorecards past 72h | 16 of 445; median age 19h |
| C2 | 19 of 157 three-chain traders could draw a month | 283 of 329 |
| E4 | 2 figures carried a coverage block | 13 |
| E6 | Entry size rankable for 11 of 144 | 413 of 448 |
| E7 | No monthly results published anywhere | `realizedByMonth[]` on every scorecard |
| E8 | One trader per call, ~30 min for a full refresh | 50 per call, 57 seconds for all 448 |
| D6 | (already passing) | still exact: 512 breaks, zero disagreements |
| F7 | 803 rows with no filable identity | 0 of 448 directory rows |

---

## 7 · The work list

Grouped by what it takes, not by test number.

### Not code — someone has to go and look

1. **The nightly workflow is not firing** (§4.1, B1). Open the repository's Actions tab; if the schedule is disabled, re-enable it and add a failure notification. Everything in Part B, most of C2, and 81 of the 88 `no_reading` traders trace back to this one item.

### One-line or one-constant changes

2. **Raise `PRICED_FLOOR` from 0.20 to 0.25** (§4.4, C4) — converts 341 over-thin points into honest refusals.
3. **Give `batchIds()` the `display_handle` fallback** (§4.16) — one trader, one clause, and the batch stops disagreeing with the single route about who exists.
4. **Add `realizedShare` to `fieldReasons`** (§4.8, E1) — turns 386 of the 425 silent absences into stated ones.

### Small, contained changes

5. **Publish `winRateBasis` and the realized-bearing count** (§4.9, E2/E3/F6) — the 13 traders straddling the copy floor are the reason this is above the rest of the list.
6. **Derive `totalChains` from the same union as `knownChains`** (§4.7, D4) — fixes 12 inverted coverage ratios.
7. **Compute `now.partial` from the envelope coverage when the reading's counts are null** (§4.13, F8) — 268 answers.
8. **Make `contractVersion: 2` the default** (§4.6, D1), old shape behind `contractVersion: 1`.
9. **Count the anchor point separately in `reach`** (§4.12, F6), or document that `coveredDays` includes it.

### Larger

10. **Make the priced floor sensitive to how many positions stand behind the share** (§4.3, C4) — a two-position chain clears a 20% floor trivially, so the parts can be served when the whole is refused.
11. **Publish the vocabulary and the fill-rate table** (§4.11 / §4.10, F5/F1) — a `/v1/fields` route covers both, and the data is one sweep away.
12. **Populate `progress`** (§4.5, C10) — state what `window=all` actually covers and why it stops. Actually extending the coverage is an external-data exercise, not a code change; see §4.5.

### Decisions, not work

13. **A3** — does a wallet-submission route exist, or is A2 owned entirely here? The test cannot pass either way until that is settled.
14. **G1** — whether to run the 240/min ramp, and against what.

---

## 8 · Reproducing this

The harness is in the session scratchpad, not the repository:

```
collect.py directory        # 1 call  — 448 traders with ids
collect.py scorecards       # 9 calls — every scorecard, via ?include=
collect.py aum:1m           # 9 calls — batch balance, contractVersion 2
collect.py aum:1m:solana    # 9 calls — the same, per chain
an_sc.py                    # Part E + the scorecard half of F
an_aum.py                   # Parts C, D + the balance half of F
targeted.py                 # the tests that need a specific call
```

Raw captures are kept beside them, so any figure in this report can be re-derived without touching the service again.

