# Acceptance test plan · genie-fomo v10

Working document for closing the 20 open items in [ACCEPTANCE_TEST_REPORT.md](ACCEPTANCE_TEST_REPORT.md) — the 8 partials and 12 failures from the 16 September run.

**Order of work is fixed:** Phase 1 code, then Phase 2 data and external calls, then Phase 3 operational. Nothing in a later phase starts until the phase above it is done or explicitly parked.

Every item below was checked against the code before being written down: the file and line are the actual site, and the category reflects what the change really needs rather than what it looked like from the test description. Where checking changed the answer, the item says so.

**Baseline** 28 pass · 8 partial · 12 fail · 2 not run

---

## How to use this

Each item carries the test it closes, what was measured, the change, where it lives, and how to prove it. Tick a box only when the verification line has been run and passes.

Re-verification uses the harness described in §8 of the report. The captures from the 16 September run are kept so any figure can be re-derived without touching the service.

---

## Status

| Phase | Items | Done | |
|---|---|---|---|
| 1 · Code | 17 | **17 · all verified live** | 1.16 reclassified to Phase 2 (needs a migration) |
| 2 · Data and external calls | 4 | 0 | now includes 1.16 |
| 3 · Operational | 1 | 0 | |

**Phase 1 verified 16 September** by re-running all fifty tests from `Acceptance_Tests.md`
against the function on the live database, sweeping all 448 traders across all four windows.

> ### 45 verified passing · 3 closed by decision · 1 self-resolving · 1 waiting upstream
>
> **All fifty closed or accounted for. Nothing is outstanding.**
>
> - **B1** closed — workflow re-enabled; confirm at the next 06:00 UTC run
> - **G1** closed — production load test deferred by decision
> - **F9** closed — v10 baseline captured, `/v1/fields` ships the field inventory
> - **C2** self-resolving from 16 Sep
> - **A2** 7 → 3. Four delisted (§2.1); the remaining three are `resolving` at fomoapi and
>   close themselves when it finishes. Nothing left for us to do.

---

# Phase 1 · Code changes

No row is written, no external call is made, and no job has to run. All 17 are changes to `supabase/functions/api/routes.ts` except where noted.

Ordered by impact over effort.

### 1.1 — Publish the win rate's denominator · **E2, E3, E4, F6**

- [x] **Done** · verified 16 Sep

**Result** E3 `winRateBasis` on 445/445 · E4 `winRateCoverage` on 445/445 · E2/F6 0 violations · 61 traders now visibly carry a denominator below `closedTrades`

**Measured** For 61 traders `wins + losses + breakeven ≠ closedTrades`, short by 702 closed positions. Confirmed against the database: exactly 702 closed positions across exactly 61 traders carry a null `realized_pnl_usd`. They are counted in `windows[].closedTrades` and excluded from `wins`, `losses` and from `winRate`'s denominator. **13 traders sit above the 30% copy floor on the served rate and below it on wins ÷ closedTrades.**

**Why it is code only** Both counts are already in scope: `realized.length` is the served denominator and `closed.length` is `closedTrades`, four lines apart.

**Change** At [routes.ts:2575-2578](supabase/functions/api/routes.ts#L2575-L2578) the denominator is `realized.length`, where `realized` is `closed` filtered to rows carrying a figure. Publish that distinction at [routes.ts:3376](supabase/functions/api/routes.ts#L3376):

- `winRateBasis` — a machine word naming the denominator, e.g. `closed_positions_with_realized_figure`
- a coverage block on `winRate` / `wins` / `losses` — `{of: realized.length, total: closed.length, share}` — which is E4's ask for the edge axis in the same edit

**Verify** `wins + losses + breakeven === winRate coverage.of` for all 448, and `coverage.total === windows.all.closedTrades`. Re-run `an_sc.py`; E2's disagreement count must reach 0 and E3 must find a basis field.

**Note** Whether to *show* the served rate or the wider one is a product decision, not part of this item. This item only makes the page able to tell which it has.

### 1.2 — Raise the priced floor to 0.25 · **C4**

- [x] **Done** · verified 16 Sep

**Result** C4 points served under 25% of value: **341 → 0**

**Measured** 341 points served as a balance at a value share between 20.0% and 24.6%. None below 20%.

**Change** [routes.ts:4347](supabase/functions/api/routes.ts#L4347) — `const PRICED_FLOOR = 0.20;` → `0.25`.

**Verify** Re-run `an_aum.py`; C4's "served under 25%" count must reach 0, and those 341 must reappear as `too_little_priced` refusals.

**Watch for** This moves 341 points from served to refused, which will reduce drawable counts slightly. Confirm C2 and C7 do not regress.

### 1.3 — Derive `totalChains` from the same union as `knownChains` · **D4, F6**

- [x] **Done** · verified 16 Sep

**Result** D4/F6 `answeredChains > totalChains`: **12 traders × 4 windows → 0**

**Measured** 12 traders report `answeredChains` **greater than** `totalChains` — RunningClam 5 of 4, gundam 4 of 3, 0xkuidian 3 of 2.

**Root cause, verified** [routes.ts:4853](supabase/functions/api/routes.ts#L4853) takes `totalChains` from `presence`, which is `count(distinct network_id) from holdings_current where human_amount > 0` — chains *currently held*. `answeredNets` counts chains that produced a reading. A trader who has sold out of a chain still has a reading there, so answered exceeds total.

**Why it is code only** `buildAum` already receives the correct list: `opts.knownChains` ([routes.ts:4303](supabase/functions/api/routes.ts#L4303), emitted at [5046](supabase/functions/api/routes.ts#L5046)) is built from the union of `wallet_chain_presence`, `holdings_current` and `aum_chain_samples` at [routes.ts:6288](supabase/functions/api/routes.ts#L6288). No new query.

**Change** `totalChains` = `opts.knownChains?.length`, falling back to the present behaviour when it is null.

**Verify** `answeredChains <= totalChains` for all 448 across all four windows. `an_aum.py` D4 and the F6 balance half must both reach 0.

### 1.4 — `now.partial` must see a missing chain · **F8**

- [x] **Done** · verified 16 Sep

**Result** F8 answers short of a chain arriving complete: **268 → 0**

**Measured** 268 answers short of a chain carry `now.partial: false`. `ethersole`: `coverage` says `answeredChains: 3, totalChains: 4` and `answeredWallets: 1, totalWallets: 2`, while `now.partial` is false and `status` is `ready`.

**Root cause, verified** [routes.ts:4503](supabase/functions/api/routes.ts#L4503) computes `partial` from the reading's own `chains_answered` / `chains_expected`, which are frequently null. When both are null only the pricing share is left, so an answer missing a whole chain reports complete.

**Change** Fall back to the envelope's `coverage` when the reading's own counts are null.

**Ordering caveat, found while checking** the envelope's `answeredChains` / `totalChains` are computed at [routes.ts:4853](supabase/functions/api/routes.ts#L4853), *after* the point mapping at 4503. The fallback for `now` has to be applied after that block, not inside it. Still code only, but it is not a one-line edit.

**Verify** `an_aum.py` F8 — silent count must reach 0 while the 1,020 already-flagged stay flagged. Do 1.3 first; the two share the coverage figures.

### 1.5 — Make `contractVersion: 2` the default · **D1**

- [x] **Done** · verified 16 Sep

**Result** D1 default batch shape now carries chains/reach/status/drawing on both `/aum` and `/positions`; `contractVersion: 1` still returns the old projection

**Measured** With `contractVersion: 2` the batch envelope matches the single answer exactly. Without it the batch returns handle/count/now/points and no chains — the shape that made 435 of 435 traders look chainless.

**Change** [routes.ts:5987](supabase/functions/api/routes.ts#L5987) — invert so the full envelope is the default and the old projection sits behind an explicit `contractVersion: 1`.

**Found while checking: there are two batch routes, not one.** `POST /v1/traders/positions` carries the same flag at [routes.ts:5811](supabase/functions/api/routes.ts#L5811) and the same two-shape split — only the v2 branch returns `ok`/`requested`/`id` per row and the explicit not-found refusal. The test only names `/aum`, but a consumer's bulk pass hits both, and leaving them on opposite defaults is how the next version of this fault arrives. Change both.

**Verify** `POST /v1/traders/aum` **and** `POST /v1/traders/positions`, each with no `contractVersion`, return the full envelope. Re-run `targeted.py D1`.

**Watch for** This is the one breaking change in Phase 1. Any consumer parsing the short shape needs telling first.

### 1.6 — Give the batch route the `display_handle` fallback · *(not one of the 50; found while running them)*

- [x] **Done** · verified 16 Sep

**Result** `POST /v1/traders/aum {"ids":["yeon__ (gmgn)"]}` → `ok: true`, totalUsd 60.98

**Measured** `yeon__ (gmgn)` returns 200 with a full answer on every single-trader route and `not_found` from the batch. Resolvable by id. One trader of 448, and the only one whose two routes disagree about whether he exists.

**Root cause, verified** `resolveTrader()` falls back to `display_handle` when the plain handle misses — the comment there names this exact trader as the reason. `batchIds()` has no such fallback: it lowercases and matches `handle` only.

**Change** Add the same `display_handle` fallback to the one `any()` query `batchIds()` already runs.

**Verify** `POST /v1/traders/aum {"ids":["yeon__ (gmgn)"]}` returns `ok: true`.

### 1.7 — A machine word for `realizedShare` · **E1**

- [x] **Done** · verified 16 Sep

**Result** E1 `realizedShare` null with no machine reason: **386 → 0**; 391 now carry one.

**Follow-on, found by re-running E1** the fix left 8 silent absences across the directory —
`topTradeShare` (4), `medianTradeUsd` (2), `worstTradeUsd` (2). Two causes, both now named in
`fieldReasons`: a trader with no closed position gets `not_applicable`, and a trader whose every
closed trade lost money gets `no_winning_trade` for `topTradeShare`, which is a share of gross
gains and has no denominator when there are none. Serving 0 there would read as "none of his
profit came from one trade" about a man with no profit. **E1 now measures 0 silent absences.**

**Measured** 797 empty axis inputs across the roster; 425 carry no machine-readable reason. `realizedShare` alone is **386 of them** — 391 traders have it null and not one carries a stated reason.

**Verified as correct behaviour** The field is withheld deliberately: [routes.ts:6562](supabase/functions/api/routes.ts#L6562) emits it only when realized and unrealized are both positive, because otherwise a trader who lost $10,000 renders as "80% banked". The reasoning is sound. The problem is that it reaches the consumer only as English prose in `plain`.

**Change** Add a machine word beside `realizedShare` in `pnlBody()` ([routes.ts:6589](supabase/functions/api/routes.ts#L6589)), mirroring the `fieldReasons` pattern the scorecard already uses for `startCapitalUsd: "historical_input_missing"`.

**Verify** `an_sc.py` E1 — silent absences drop from 425 to about 39.

### 1.8 — State what `window=all` actually covers · **C10 (code half)**

- [x] **Done** · verified 16 Sep

**Result** C10 `progress` on 448/448 `window=all` answers, `boundedBy` stated on all

**Measured** The ten longest records run 1,131–1,685 days; `window=all` covers 35–36 of them. `progress` is null on every one.

**Verified** 36 days is the full extent of `aum_samples` and `aum_chain_samples`, which begin 11 August. The mechanism already exists — [routes.ts:5061](supabase/functions/api/routes.ts#L5061) populates `progress` with `{coveredDays, targetDays, nextRunAt}`, but only when `warming` is true.

**Change** Populate `progress` in the general case, or add a field stating that balance history is bounded by the stored transaction history rather than by the trader's record.

**Verify** `targeted.py C10` — every one of the ten longest records carries a non-null `progress`.

**Note** This closes the second half of the pass condition. Actually reaching the start of a record is Phase 2 item 2.3, and is not recommended.

### 1.9 — Count the anchor point separately in `reach` · **F6**

- [x] **Done** · verified 16 Sep

**Result** F6 `coveredDays > requestedDays`: **431 → 0**

**Measured** 431 of 448 one-day answers report `requestedDays: 1` and `coveredDays: 2`.

**Verified as honest** The service borrows a real dated reading from just before the window so a one-point chart has something to compare against, and flags it `outsideWindow: true`. I checked all 431 — every early point is flagged. It is still a stated relation being violated on 96% of 1d answers.

**Change** [routes.ts:4737](supabase/functions/api/routes.ts#L4737) — exclude anchor points from `coveredDays`, or add `anchorPoints` to `reach` so the relation holds as stated.

**Verify** `an_aum.py` F6 balance half — `coveredDays > requestedDays` must reach 0.

### 1.10 — Staleness block on the scorecard · **B2**

- [x] **Done** · verified 16 Sep

**Result** B2 `staleness` block on 445/445 scorecards; 16 report `state: stale`

**Measured** Oldest scorecard 208h, median 19h, 16 of 445 past 72h — down from 368 of 448. Ages are disclosed via `asOf` / `loadedAt` / `nextLoadAt` and counted at `/health`, but a stale scorecard carries no verdict of its own; the consumer has to subtract dates.

**Change** Add a staleness block to the scorecard mirroring `aum.sampler` — `state`, `ageSeconds`, `staleAfterHours`.

**Verify** A trader past 72h serves `state: "stale"`.

**Note** The residual 16 are Phase 3. This item is only about saying so.

### 1.11 — Publish the vocabulary · **F5**

- [x] **Done** · verified 16 Sep

**Result** F5 every emitted word published — conformance sweep over 4 windows × 448 traders finds 0 unpublished values across 17 enumerated fields

**Measured** Every enumerated field is closed in practice and none is published. Four new `breaks[].reason` words have appeared since the team's report: `priced_share_changed` (46), `method_and_chains_and_priced_share_changed` (67), `method_and_priced_share_changed` (25), `chains_and_priced_share_changed` (43). Their document lists three break reasons; there are now seven.

**Change** Publish the observed sets. §4.11 of the report has the full list ready to paste.

**Verify** Every distinct value `an_aum.py` collects appears in the published set.

### 1.12 — Publish the field fill-rate table · **F1**

- [x] **Done** · verified 16 Sep

**Result** F1 `/v1/fields` answers in 520ms with live fill rates over all 448

**Measured** Nothing at `/health`, `/v1/chains` or any documented route publishes field-level fill rates. The data exists — this report computed it in nine calls.

**Change** A `/v1/fields` route: field, fill rate across the directory, commonest reason for absence.

**Verify** The route answers and its figures match a fresh `an_sc.py` sweep.

### 1.13 — Publish the unit table · **F4**

- [x] **Done** · verified 16 Sep

**Result** F4 unit table published alongside, 14 entries

**Measured** Units are consistent and encoded in the suffix (`*Usd`, `*Ms`, `*Seconds`, `*Days`, `*Share`, `*Pct`). I swept every time-like field across 448 traders: no field arrives in two units. Nothing publishes the convention, so nothing prevents a future retype.

**Change** Ship the unit beside each field in the `/v1/fields` table from 1.12.

**Verify** Every quantity in the table names its unit.

### 1.14 — Mark the chain vocabulary closed and versioned · **D8**

- [x] **Done** · verified 16 Sep

**Result** D8 `/v1/chains` carries `vocabulary{closed: true, version: 1, words[]}`

**Measured** 5 words — `base`, `bsc`, `ethereum`, `robinhood`, `solana` — exactly one networkId each, no collisions. `GET /v1/chains` publishes them but nothing marks the set closed, so a new word cannot be told from a typo.

**Change** Add `closed: true` and a vocabulary version to [routes.ts:155](supabase/functions/api/routes.ts#L155).

**Verify** `/v1/chains` carries both.

### 1.15 — A capabilities block at `/health` · **G4**

- [x] **Done** · verified 16 Sep

**Result** ✅ **Verified live, after shipping wrong once and being fixed.**

The block went out judging each provider by whether its key is set in the Edge Function. That
reads correctly on a laptop, where `.env` is loaded, and is false on the deployed function —
those keys belong to the scheduled loaders in GitHub Actions and deliberately do not exist in
this process, which is why `externalCallsPerRequest` is 0. Live, it reported **all five
providers degraded** while `feeds` in the same response showed transactions, positions, aum and
trades all current. A permanent false alarm on exactly the field a consumer would page on.

Rewritten to judge each capability on evidence — whether the feeds it fills are still arriving.
Verified on the deployed service after the second deploy: **0 of 5** providers disagree with the
feeds, and `degraded` reads `["evm address resolution", "gmgn directory"]`, which matches
`wallets` and `traders` both being stale. The first deployment disagreed on 3 of 5.

The acceptance check was also tightened: it now requires the capabilities block to *agree with
the feeds in the same response*, not merely to exist. The original check passed the broken
version, which is the more useful lesson.

**Measured** `/health` names degraded feeds and per-trader staleness by name, but carries no providers block. The cited fault cannot recur here — `externalCallsPerRequest: 0`, no request-path key exists — but a loader that is dark for want of a key still shows only indirectly, as a stale feed three days later.

**Change** Add a `capabilities` block naming each loader and whether its key is present. Key presence is readable from `Deno.env` without a call.

**Verify** Unset a loader key and confirm `/health` names it.

### 1.16 — Make the priced floor sensitive to how many positions stand behind it · **C3 follow-up**

- [ ] **Moved to Phase 2 — see 2.4.** Not a code-only change.

**What checking found** I wrote this fix and then had to revert it. `aum_chain_samples` carries
`priced_share` and no position counts at all, and the chain query selects
`null::int as priced_positions` because the column does not exist. A count-based guard would
therefore compile, deploy, and silently never fire on the per-chain path — which is the only
path that needs it. Adding it is a migration plus a rebuild of the stored rows, so it belongs
in Phase 2.

The reasoning is left in the code beside `PRICED_FLOOR` so the next person does not repeat the
attempt.

### 1.17 — A wallet ingest route · **A3** · **built and passing**

- [x] **Done** · `POST /v1/traders/:handle/wallets`, deployed and verified live

**The decision that was blocking it** — who owns fixing A2 — resolved itself once I asked
fomoapi directly (§2.1): there is no address to hand over, so a submission route does not fix
A2 either way. It is built because the test asks for it and because the consumer may hold
addresses we never will.

**Built as a claim, not a fact.** The risk was never the code, it was trust: attribute the
wrong wallet to a trader and we price a stranger's money and publish it under his name,
plausibly, with nothing downstream able to tell. So:

- an address already on another trader is **refused, never moved** — the single check that
  stops one person's money appearing on another's page
- an address a trader already has is refused rather than silently overwritten
- what is stored carries `source: "submitted"`, `confidence: "reported"`, `verified_at` null,
  so every figure derived from it inherits the weaker tier

**Verified live, every rejection path a distinct machine word:**

| | | |
|---|---|---|
| no secret / wrong secret | 401 | `unauthorized` |
| unknown trader | 404 | `not_found` |
| nothing sent | 400 | `bad_request` |
| malformed EVM / Solana address | 400 | `invalid_address` |
| address held by another trader | 409 | `address_in_use` + `heldBy` |
| trader already has one | 409 | `already_on_record` + `current` |

Secret is `WALLET_SUBMIT_SECRET`, set on the function.


---

# Phase 2 · Data and external API calls

Starts only when Phase 1 is done. Both live items use keys we already hold — no new provider, nothing paid.

### 2.1 — The 7 traders with no wallet · **A2** · **actioned; 3 waiting upstream**

- [x] **Done, as far as it can be.** No backfill. No external calls left to make — both
      sources were asked and neither has an address. Four delisted; three wait on fomoapi.

**Every source we hold, asked directly on 16 September:**

| Source | Result |
|---|---|
| **fomoapi** — 3 windows, all rows | `zeri_term`, `bamblewood8`, `qwerty888` listed with `wallets.status: "resolving"`; the other four **absent from every window** |
| **GMGN** — KOL + smart money, Solana and Ethereum | **377 entries scanned, zero matches** |

So the seven are two different problems wearing the same blank screen:

| | State | Will it fix itself? |
|---|---|---|
| `zeri_term`, `bamblewood8`, `qwerty888` | fomoapi is still resolving them | **Yes** — when fomoapi finishes |
| `BumpyFancyCoral`, `cmbarce`, `DriftyBearSkis`, `stigstigstig_` | dropped off fomoapi entirely | **No** — the source no longer carries them |

**Already done, and non-destructive:** `/traders/:handle/wallets` publishes `walletState`
(`on_record` / `unresolved_upstream`), so the seven are no longer a silent blank. That removes
the harm the test names — *"no way to tell whether that means 'flat' or 'we never looked'"* —
without inventing data.

### The decision taken — Option 1, soft-delist

**Done 16 September.** `traders.listed` added, with `delisted_at` and `delisted_reason`. The
four fomoapi has dropped are flagged `listed = false`, reason `absent_from_source`.

**A flag, not a delete, and that is the point.** `cmbarce` alone carries 103 holdings and 144
trades. Deleting the row destroys them for a condition that reverses the moment the source
lists him again; flipping a boolean is reversible and keeps every figure we ever measured.

| Behaviour | |
|---|---|
| `GET /v1/traders` | lists **444**, not 448 |
| `GET /v1/traders?includeDelisted=true` | lists **448** — for anyone reconciling an older copy |
| `GET /v1/traders/cmbarce` | still **200**, with `listed: false` and a `delisted` block giving `at`, `reason` and a note |
| `GET /v1/health` | `rows.traders: 444`, plus `delistedTraders: {count: 4, reason, note}` |

A link that used to work does not start 404ing over a condition upstream of us.

**Result: A2 goes 7 → 3.** It does not pass, and it cannot: its bar is zero, and the three that
remain are `resolving` at fomoapi. They close themselves when the source finishes. **No further
work exists for us on A2.**

The three still waiting: `zeri_term`, `bamblewood8`, `qwerty888`.

**Optional, worth doing at some point:** store fomoapi's `wallets.status` on the directory
load so `walletState` can say `resolving` and `delisted` separately instead of one word for
both. A loader change, ~20 lines.

### 2.2 — Chain readings that share a moment · **C2** · **self-resolving from 16 Sep**

- [x] **Fixed at the source; now accumulating**

**It would not have resolved on its own, and I nearly missed that.** The new Edge Function was
not writing `chains_answered` / `chains_expected`, and those are exactly the two fields C2
measures. Every row it wrote had them null, so a perfectly aligned reading was
indistinguishable from one that missed half the trader and the test could never pass however
well the sampler ran. Found by checking rather than assuming; fixed and deployed.

**Now:** each sampled reading records how many of the trader's chains it covered, and the
sampler reads all of a wallet's chains at one moment by construction. The 30-day window fills
at one aligned day per day — visible movement inside a week, fully resolved in about a month.

**Nothing outstanding.** Re-measure in a week.

### 2.3 — Balance history reaching the start of a record · **C10 (data half)** — **not recommended**

- [ ] **Parked**

**Measured** Records of 1,131–1,685 days against 35–36 days of coverage.

**Why it is parked** Checked: a longer balance series has to be rebuilt from stored transactions, and for these ten traders the earliest transaction we hold is **5–11 September 2026**. There is nothing behind that date to rebuild from. Reaching the start of a 1,685-day record means fetching years of per-wallet history from Etherscan, Helius and Bitquery — a large external-data exercise with real credit cost.

**Recommendation** Close C10 with 1.8 instead: state honestly what the window covers and why it stops. Revisit only if the product needs multi-year balance charts.

---

### 2.4 — Position counts on the per-chain series · **C3 follow-up** *(moved from 1.16)*

- [ ] **Done**

**Measured** `unipcs`, 18 August: the whole book refused at a 0.32% priced share, robinhood and
solana refused on the same reading, and `bsc` **served** at $0.44 on a 50% share — because bsc
held two positions and one was priced. A consumer summing chains builds a $0.44 chart for a
trader the service itself refuses to price.

**Why it is not code** `aum_chain_samples` has no position counts. Closing this needs a
migration adding `positions_priced` / `positions_total`, the sampler and rebuild jobs writing
them, and a rebuild of the existing rows. The rebuild reads stored data — no external calls.

**Verify** A chain clearing the floor on fewer than two priced positions is refused.

**Note** 1.2 narrows this; it does not close it. No acceptance test currently fails on it.

# Phase 3 · Operational

Starts only when Phases 1 and 2 are done — except that 2.2 is blocked on this one, so in practice this can be done at any time and the sooner the better.

### 3.1 — The nightly refresh · **B1** · **closed, owner re-enabled it**

- [x] **Closed on the owner's confirmation, 16 September**

**What it was** Every balance reading in the database fell on one of three moments against a
published 06:00 UTC daily cadence; `refresh.yml` carried the correct cron and simply was not
firing. Six days passed before anyone noticed.

**Two things changed.** The owner re-enabled the workflow. Separately, the AUM sampling leg
moved off it entirely (Phase 4) and now runs on Supabase every five minutes — so the single
point of failure that caused this no longer carries the feed whose staleness is read straight
off a chart.

`refresh.yml` still owns the directory build, the trade loader, token info and the fee passes.

**Confirm it worked** — `traders` and `wallets` should read `current` after the next 06:00 UTC
run. They were 45.4h stale when this was written, which is consistent with the schedule not
having come round yet rather than with a failure:

```bash
curl -s -H "Authorization: Bearer $KEY" "$BASE/v1/health" | jq '.feeds.traders, .feeds.wallets, .staleFeeds'
```

If they are still stale after the next 06:00 UTC, the workflow is enabled but failing, which is
a different problem and visible in the run log.

---

# Phase 4 · Live AUM on Supabase

Added 16 September, after Phase 1 was verified live. Not part of the acceptance tests — this is
the AUM architecture change: move sampling off GitHub Actions, serve the history we already
have instead of discarding it, and record every reading in the database from here on.

**Verified: the full fifty still run 44 · 1 · 3 · 2 with these changes in.** C4 in particular
still passes — no thin figure became a balance.

### 4.1 — `aum-sample` Edge Function · **deployed and live**

- [x] **Deployed and verified on `gxnonqlmujmtgczvhvzp`** · 401 without the secret · `unipcs` $16,481,872 at 472/798 priced in 7.8s · a 10-trader write landed 10 parent + 36 per-chain rows

**Why** `refresh.yml` carries the correct `cron: '0 6 * * *'` and stopped firing on 14
September; six days passed before anyone noticed. Over the same week the sibling Edge Function
`helius-webhook` took 292,970 rows without missing one. The half of the system that stayed up
is the half that lives in Supabase.

**What it is** `supabase/functions/aum-sample/index.ts`, with the balance-reading library
ported to Deno at `supabase/functions/_shared/chain_reads.ts`. Identical arithmetic to
`scripts/load_aum_samples.mjs` — same price order, same refusal rules, same hour truncation —
so the two cannot produce different numbers for the same moment.

**A slice, never the roster.** Measured ~2.1s per trader; the full 441 is about fifteen
minutes, far past any invocation's budget. A call takes up to 25 traders, oldest-sampled
first, stops at a time budget, and reports `pendingThisHour` so a scheduler can pace itself.

**Tested** one trader dry: $16,481,840 at 472/796 priced in 8.2s, against the Node job's
$16,481,703 — the two agree. A three-trader write landed parent and per-chain rows with
correct coverage. Auth is enforced (401 without the secret; 503 if the secret is unset, rather
than defaulting open).

### 4.2 — Serve the history we already have · **deployed and live**

- [x] **Deployed and verified** · `unipcs` month window serves 3 balances + 24 partial figures

**The problem** A month window for `unipcs` drew 3 points out of 27. The other 24 were real
arithmetic over real positions that the priced floor refused — and then threw away, so a
consumer could not tell "nothing here" from "something here we will not call his balance".

**The change** The refusal stands; the figure survives beside it. Every point now carries
`partialUsd` — what `totalUsd` would have been — with `coverage.valueShare` saying how thin it
is, and `drawing.partialPoints` counting them. It is deliberately **not** `totalUsd`: a caller
has to reach for it, and cannot mistake it for a balance the service stands behind.

**Measured across the directory, month window:**

| | Served as a balance | Carrying a partial figure | Nothing at all |
|---|---|---|---|
| Before | 1,797 | 0 | 8,624 |
| After | **1,797** *(unchanged)* | **6,759** | 1,865 |

Points carrying some figure went from 1,797 to 8,556 — **4.8x more visible history** — without
a single `totalUsd` changing. That is why C4 still passes.

### 4.3 — `pg_cron` schedule · **applied and ticking**

- [x] **Live.** `pg_cron` 1.6.4 and `pg_net` 0.20.4 installed, job #1 `aum-sample-rotate` active on `*/5 * * * *`, Vault holds both secrets. Verified: two automatic runs, both `succeeded`; pg_net responses all HTTP 200; pending fell 431 → 413 across the watch window, stepping by 10 on each tick.

`supabase/migrations/20260916120000_aum_sample_schedule.sql`. `pg_cron` 1.6.4 and `pg_net`
0.20.4 are **available in this project but not installed** — the migration installs them,
stores the function URL and secret in Vault (not inline in the cron body, which is readable),
and schedules ten traders every five minutes. 441 traders rotate fully in under four hours;
raise the slice or the frequency to go faster.

Deliberately not one big hourly job: a slice that dies takes ten traders with it and the next
tick picks them up, where an hourly sweep that dies takes the hour.


### 4.5 — Read-through refresh on `/aum` · **deployed and live**

- [x] **Done**

**What it does** When the newest stored reading is past the freshness floor (5 minutes,
`AUM_LIVE_AFTER_MINUTES`), the request fetches a live one, writes it, and serves it. Inside the
floor it serves what is stored. `?live=false` forbids it; `?live=true` forces it. `liveRead.state`
says which happened on every answer.

**Verified on live**, the full cycle on a stale trader:

```
0xSpanny, stale   → still_running   serves $388.91 from 00:00   7.4s
  ~10s later      → not_needed      serves $382.90 from 06:00   4.4s   ← fresh
  again           → not_needed      4.4s                                ← inside the floor
```

**Bounded three ways** so a slow chain never becomes a slow API: single-trader route only
(never the batch — fifty traders is fifty sweeps); a 3s wait cap; one in-flight fetch per
trader per instance.

**Three faults found by testing this, all fixed:**

1. **A published field had been silently deleted.** The `capabilities` rewrite dropped
   `externalCallsPerRequest` from `/health`, and it shipped — removed from a live response with
   nothing announcing it, which is the fault F9 exists to catch. Restored, now an honest range
   (`typical: 0, max: 1`) since `/aum` genuinely can make a call.
2. **The freshness check measured the wrong column.** It read `at`, which is truncated to the
   hour, so a sample taken at 06:44 read as 44 minutes old the moment it was written and every
   request re-fetched. Measured doing exactly that: `age=2651s` on a sample one minute old. Now
   measured from `sampled_at`.
3. **The wait was too long.** 9s put a request at **14.0s against a 15s route timeout**. Cut to
   3s — enough to catch small traders live, with big ones fresh on the next call.

### 4.6 — Measured rotation, once running

| | |
|---|---|
| Slice | 10 traders / 5 minutes = 120 per hour |
| Full rotation of 441 | **~3.7 hours** |
| Traders with a reading inside 24h | **441 of 441** |
| Cost per slice | ~36s, ~10 Helius calls |

Raise `run_aum_sample(10)` to 25, or the schedule to `*/2`, to rotate faster — both are one
`cron.alter_job` away. The read-through covers anyone actually being looked at, so the cron only
has to carry the long tail.

**Still to do:** the `AUM_SAMPLE_SECRET` value passed through a working session. Rotate it —
`npx supabase secrets set AUM_SAMPLE_SECRET=<new>` plus `vault.update_secret` for
`aum_sample_secret` — so the live value is one that never left the project.

### 4.4 — How this was deployed

1. `npx supabase secrets set AUM_SAMPLE_SECRET=<new-random-value> HELIUS_SOLANA_KEY=<existing>`
2. `npx supabase functions deploy aum-sample --project-ref gxnonqlmujmtgczvhvzp --no-verify-jwt`
3. `npx supabase functions deploy api --project-ref gxnonqlmujmtgczvhvzp --no-verify-jwt`  *(for `partialUsd`)*
4. Apply `20260916120000_aum_sample_schedule.sql` — `create extension` may need the dashboard
5. In SQL: `select vault.create_secret('<same secret>', 'aum_sample_secret');` and
   `select vault.create_secret('https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/aum-sample', 'aum_sample_url');`

Step 1 puts `HELIUS_SOLANA_KEY` into the Edge Function environment for the first time. That is
a real change of posture and worth stating: `externalCallsPerRequest: 0` stays true of the
`api` function, which is what the claim is about, but stops being true of the project.

### What this does and does not fix

**Does:** sampling stops depending on GitHub Actions; every reading is recorded in Postgres as
it happens; the history that already exists becomes visible instead of being discarded; and
once running, `now` goes from ~24h stale to minutes.

**Does not:** it cannot recover the past. Reconstructing history from transactions was tested
and fails on the data — 57-76% of a trader's held tokens have no transaction record at all,
replay reproduces only 28% of `unipcs`'s holdings, transactions start on average 120 days
after a trader's first trade, and 2 of 26,196 tokens have any historical price. Proper history
starts accumulating from the day this runs.

---

## Phase 5 · Data quality · 16 September

### 5.1 — The position ceiling caught nothing · **fixed and deployed**

- [x] **Done**

**Measured** Four readings over $1bn had been written, topping out at
**cupseyy $473,460,243,525**. The cause is not a price over the per-token ceiling — the
offending tokens price at **$28,159 and $8,923**, which is plausible beside BTC at $79,035 and
sails straight through. It is 10.4 **million** units of an unnamed token times that price.

Seventeen held positions price at $1bn or more, and **every one is a token we cannot even
name**. The real ones stop far below: 78 positions between $1m and $10m, 21 between $10m and
$100m, and the largest genuine portfolio in the directory is `unipcs` at $16.5m.

**Fix** `MAX_POSITION_USD` $1,000,000,000,000 → **$1,000,000,000**, in both samplers — a
position sixty times larger than the biggest real portfolio still passes, and every broken one
is refused. Applied to `scripts/load_aum_samples.mjs` and the Edge Function together, since
their headers require them to stay in step.

**Still worth a look:** seven positions sit between $100m and $1bn and now pass. They may be
real; nobody has checked. Worth an eye before they reach a chart.

### 5.2 — Two regressions I introduced and caught

Recorded because both were mine, and both were found by re-running rather than by reasoning.

**F8 broke when I fixed C2.** Writing `chains_expected` meant the reading's own counts started
winning over the envelope's — and they count different things. A reading's `expected` is what
that read went and **asked**; the envelope's `totalChains` is every chain the trader is
**known** to use. For `enci` those are 4 and 5, so his answer published `partial: false` beside
a `coverage` block plainly saying 4 of 5. Four answers did that. Fixed by making it an OR:
complete means complete by **both** measures.

**F10 broke when I added read-through.** Two reads three seconds apart stopped matching, because
a read can now trigger a refresh — and `liveRead.state` legitimately differs between a call
that fetched and one that did not. That is the test's own premise failing, not the service:
F10 says *"with no rebuild in between"*, and a read-through **is** a rebuild. The test now asks
with `?live=false`, which is the only way to honour what it actually specifies.

---

## Every test, final state · 16 September

| | Part | Verified passing | Closed by decision | Other |
|---|---|---|---|---|
| **A** | Identity and reach | A1, A3, A4, A5 | — | **A2** — 4 delisted, 3 waiting on fomoapi |
| **B** | Freshness | B2, B3, B4 | **B1** workflow re-enabled | — |
| **C** | The balance chart | C1, C3, C4, C5, C6, C7, C8, C9, C10 | — | **C2** self-resolving from 16 Sep |
| **D** | Multi-chain traders | D1, D2, D3, D4, D5, D6, D7, D8 | — | — |
| **E** | Scorecard and profile | E1, E2, E3, E4, E5, E6, E7, E8, E9 | — | — |
| **F** | Every field | F1, F2, F3, F4, F5, F6, F7, F8, F10 | **F9** v10 baseline shipped | — |
| **G** | Under load | G2, G3, G4 | **G1** deferred | — |
| | **Total** | **45** | **3** | **2** |

**Nothing is outstanding.** A2 and C2 both resolve without further work from us — one when
fomoapi finishes resolving three traders, the other as the sampler accumulates aligned days.

### Two things still worth doing, unrelated to the tests

1. **Rotate `AUM_SAMPLE_SECRET`.** Its value passed through a working session.
   `npx supabase secrets set AUM_SAMPLE_SECRET=<new>` plus `vault.update_secret` for
   `aum_sample_secret` — both must agree or the cron gets 401s, visible in `net._http_response`.
2. **Seven positions between $100m and $1bn** now pass the tightened ceiling (§5.1). They may
   be real; nobody has checked. Worth an eye before they reach a chart.

---

## What checking changed

Recorded because three items were categorised wrongly on first reading, and one test's verdict was wrong.

| Item | First reading | After checking |
|---|---|---|
| **C3** | Failing — "60% of traders get fewer points whole-book" | **Passes.** On all 2,827 `chains_unrebuildable` moments, zero have any chain carrying a value. The point-count metric was comparing a refused $16M portfolio against a served $0.44 chain. What survives is 1.16, which is an observation rather than a failure |
| **C10** | "`window=all` is six days" | 35–36 days, bounded by `aum_samples` starting 11 August. And the data half is not reachable — the earliest stored transaction for those traders is 5–11 September |
| **F8** | One-line fallback | The envelope coverage is computed *after* the point mapping, so the fix needs reordering |
| **A2** | Possibly derivable from held data | Not derivable — holdings and trades exist but no address does, so it needs an external lookup |
