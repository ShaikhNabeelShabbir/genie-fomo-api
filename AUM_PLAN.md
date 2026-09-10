# AUM over time — build plan

**Written 2026-09-10** against the product requirement dated 2026-09-09.
**Status: phases 1-3 written locally 2026-09-10, nothing applied or deployed.** The migration,
the route and the sampler exist and type-check; none has run, because the database was down
while they were written. Three decisions remain open (§9) and one still blocks hourly cadence.

Route the PRD asks for: `GET $B/traders/:handle/aum?window=1d|1w|1m|all[&step=1h|6h|1d]`

| | |
| --- | --- |
| How much of the sampler already exists | **most of it** — the chain reads are built and proven (§3) |
| What blocks the rest | **prices at hourly cadence** (§4.1) |
| New tables required | **2** — aggregates, not per-position (§6) |
| Cohort the PRD sizes for | 144 traders · **we now carry 435** (§4.3) |

Every figure below was measured on this service. Anything measured before the database
restart of 2026-09-10 is marked *last measured* and should be re-checked before it is
quoted to anyone.

---

## 1. What the feature is

One **hourly-sampled series per trader** of everything he holds, in dollars, across every
wallet and every chain, with coverage attached to every point.

The API today answers *"what does he hold now"* — that is `/portfolio`. It cannot answer
*"what did he hold on Tuesday"*, and consumers who need a balance **line** have been
rebuilding one from the swap stream. The PRD's argument is that this rebuild cannot be
fixed, only replaced:

> The root cause is that nobody records the balance when it happens. Reconstruction after
> the fact cannot be made complete. Sampling can.

**AUM at a moment** = Σ over every wallet and every chain of `amount held × price at that
moment`, in USD. Cash is included. Native SOL and wrapped SOL price at the SOL price.

Three rules carry the design, and all three are already how this API behaves elsewhere:

- **A refused sample is `null`, never a smaller number.** If one wallet will not answer, the
  **whole trader-hour is refused** with a reason. A partial total reads low and nothing
  downstream can tell it apart from a complete one.
- **`coverage.valueShare` on every point** — so a reader can tell a line built from 41 coins
  worth 57% of him from one built from 2 coins worth 0.3%.
- **`basis: "sampled"` vs `"rebuilt"` is never mixed inside a segment.** The join is a marked
  moment, `trackedSince`. Nothing is interpolated.

### Non-goals, restated so they do not drift

Not profit (`/pnl`, `/scorecard`). Not per-coin history (`/positions`). Not a replacement for
`/portfolio` — that is "now", this is "over time", and **the newest AUM sample disagreeing
with `/portfolio` is a finding, not something to merge away.**

---

## 2. The PRD's case, checked against our own data

Three of its four premises hold. One has moved since it was written, and one is already
half-solved.

| PRD premise | Our reading |
| --- | --- |
| "The swap stream is one-sided — ~86% buys, 14% sells" | **Holds.** Our own resolver found the same shape: of 132,128 SWAP-tagged Solana transactions only 696 were the wallet's own two-sided swap. A balance rebuilt from this drifts up and never sees exits. |
| "Only Solana carries prices — `pricedShare` 0 on robinhood, bsc, base, ethereum" | **Out of date.** Chain-read balances now exist on all five chains. But do not read that as "solved": priced share across the whole set was **7,627 of 29,967 positions (25.5%)** *last measured*, because the GMGN traders brought ~21,600 mostly-unpriced positions and the pricing crawl was interrupted at 600 of 17,607 tokens. |
| "Running totals are not balances — frankdegods' positions list counts 196,001.62 USDC, his wallet holds 12,081.96" | **Holds, and it is the fomo-reported figure that is wrong.** We already chain-read 290 traders for exactly this reason. We do **not** chain-read the 77 fomo covers — which is precisely where this discrepancy lives. §5 Phase 0 closes it. |
| "Sold coins are invisible in a holdings list" | **Holds.** Structural, and the reason a past moment cannot be priced from present positions. |

---

## 3. What already exists

The sampler's hardest step — reading true balances off five chains with no paid provider —
is **built, tested and in production** as `scripts/load_chain_balances.mjs`. That was Step 2
of the axis work and it is precisely §4's *"holdings from the chain, not from the running
total"*.

| PRD §4 requirement | Status |
| --- | --- |
| Solana: token accounts by owner + native balance | ✅ Helius `getTokenAccountsByOwner`, both token programs, plus `getBalance` |
| EVM: `balanceOf` batched 40 to a call against a public node | ✅ all four EVM chains, keyless, on the RPC in `chains.rpc` |
| Robinhood: its own node, blockscout as fallback | ✅ — and measured: **blockscout is not a fallback**, it sits behind Cloudflare and 403s any non-browser client. The node is the only path. |
| Dollar coins priced at 1.00 and marked | ✅ `quote_assets.pegged_usd`, already populated |
| "The service's own positions say which coins to ask about" | ✅ exactly how the EVM path scopes its `balanceOf` calls |
| Hourly scheduling | ✅ pattern exists — `.github/workflows/refresh.yml`, cron + `workflow_dispatch` |
| Zero external calls per request | ✅ every route already answers from Postgres alone |
| Price ceilings | Partial — market cap is already bounded at $10T; the per-token ceilings are not built |

One hard-won detail worth carrying into the sampler: `refresh.yml` already documents that
**session mode (5432) exhausted the 15-client pool mid-run and took the live API down**, and
that `.mjs` loaders must use transaction mode (6543). An hourly job over 435 traders needs a
hard connection cap before it goes anywhere near production. We reproduced this failure on
2026-09-09 and the API returned 503 until the database was restarted.

---

## 4. What is missing

### 4.1 Prices at hourly cadence — this blocks the critical path

§4 says prices come from *"the price loaders already on the service (Birdeye,
DexScreener)"*. **Neither exists in this repository.** Verified by search: no Birdeye, no
DexScreener, no GeckoTerminal, no CoinGecko, in any file.

What we actually hold:

| Source | Shape | Fit for hourly sampling |
| --- | --- | --- |
| GMGN `/v1/token/info` | one token per request, **1 req/s** | **No.** 17,607 tokens takes ~10 hours. One pass cannot fit in an hour. |
| `token_prices` | daily closes, quote assets only | No — daily, and only SOL/wSOL carry a series |
| `quote_assets.pegged_usd` | stablecoins at 1.00 | Yes, but only for stablecoins |
| `src/prices.ts` | derives a price from the *known leg* of a swap; majors from Binance 1m klines, free and keyless | Partly — brilliant for trades, but a **holding** has no counter-leg to derive from |

**Pricing ~30,000 positions every hour is not possible with any source we currently hold.**
DexScreener is free, keyless, and batches 30 tokens per call — exactly the shape §4
describes. It is also a new external API, which is a standing "ask first". **This is
decision 1 in §9 and nothing in Phase 2 can start without it.**

### 4.2 The 50×-off-median pool rule cannot be built from our sources

§4 asks to refuse a price *"more than 50× off the median of the coin's other pools when
there are at least three"*. That needs **per-pool** prices. GMGN returns one price per
token, so the rule has nothing to take a median of.

This is not a nicety. The PRD's own example — one Orca pool quoting STONK at $3,110 against
29 pools at $0.187, producing a **$26.7 billion** portfolio — is exactly what it guards
against. The two absolute ceilings (>$1,000,000 per token, >$1,000,000,000,000 whole-coin)
**can** be built today and catch the worst of it. The median rule arrives only with a
multi-pool source.

### 4.3 The cohort tripled, so the budget in the PRD is wrong

§4 sizes for 137–144 traders. We now carry **435** (144 fomo + 291 GMGN).

| | PRD | Actual |
| --- | --- | --- |
| Traders per pass | 144 | **435** |
| Chain calls per pass | ~1,500 | **~4,500** |
| Rows per year at one row per trader-hour | 1.26M | **3.81M** |

Storage is still modest. The call budget is not: ~4,500 calls an hour, every hour, against
public RPCs that already 403 and 429 us under load. Throttling and per-host serialisation
are not optional — both are already implemented in `load_chain_balances.mjs` and must be
carried over.

### 4.4 Refusal semantics differ from what is built

`load_chain_balances.mjs` today records a **per-chain** failure and keeps the rest of the
trader's balances. The PRD requires the opposite: one unreadable wallet **refuses the entire
trader-hour**, with a reason from `wallet_unreadable | service_timeout | no_prices |
price_rejected`. That is a deliberate behaviour change, and the PRD's reasoning is right —
a partial total is indistinguishable from a complete one downstream.

---

## 5. Build order

### Phase 0 — chain-read all 435 traders · ~half a day · no new dependencies

The only phase that can start today. It removes the fomo-vs-chain discrepancy the PRD names
in §1, and it is a prerequisite for sampling anyway: a series built on fomo's running totals
would inherit exactly the error the PRD is written to eliminate.

- Run `load_chain_balances.mjs --all` so the 77 fomo-covered traders are read from chain too
- Decide whether chain rows now **override** fomo rows rather than only filling gaps
  (decision 3, §9) — today `holdings_current` resolves per (trader, network) and never
  overrides
- **Done when:** frankdegods' USDC reads from chain rather than from fomo's running total

### ✅ Phase 1 — storage · written

`supabase/migrations/20260910090000_aum_samples.sql`. Two tables (§6), aggregates only.
**Not applied** — needs the database.

`basis` sits in the primary key so a rebuilt point and a real sample for the same hour coexist
and stay distinguishable, rather than a backfill silently overwriting a measurement.

### ✅ Phase 2 — the sampler · written · **hourly cadence still blocked on decision 1**

`scripts/load_aum_samples.mjs`, plus `scripts/lib/chain_reads.mjs`.

The chain reads were **extracted into a shared module** rather than copied: the sampler and
`load_chain_balances.mjs` now read balances through the same code. Two implementations would
drift the first time either was edited, and a running total disagreeing with a balance is the
exact bug this feature exists to remove.

- whole-trader refusal with a reason, replacing the per-chain tolerance the loader had
- both absolute price ceilings applied *before* any multiplication, `price_rejected` per coin
- `valueShare` = priced ÷ total positions. The PRD's wording reads circular; its own worked
  example settles it — 41 of 72 positions, `valueShare` 0.57, and 41/72 = 0.569
- one genuine exception to *null never 0*: a trader whose wallets **all answered and held
  nothing** is `0`, not `null`. That zero is the true value, and null would hide a real empty
  wallet behind "we could not tell". Unreachable unless the reads succeeded
- `max: 3` on the pool. `refresh.yml` already records the loaders exhausting the pooler and
  taking the API to 503; we reproduced it on 2026-09-09

**Not run.** It samples correctly at whatever cadence it is invoked; only the *hourly* budget
needs a batch price source (§4.1).

### ✅ Phase 3 — the route · written · type-checks

`GET /v1/traders/:handle/aum` in `supabase/functions/api/routes.ts`. Passes `deno check`.
**Not deployed** — the live function is unchanged until someone runs `supabase functions deploy`.

`?window` and `?step`, defaulting to the coarsest step leaving ≥24 points. Reads Postgres
only. Not bulk-able through `?include=`.

Thinning keeps the **last** point in each bucket, never an average: averaging would invent a
balance he never held, and a refused hour averaged with a measured one would launder the
refusal into a number.

### Phase 4 — the marked rebuild · ~1-2 days

Backfill the past from `wallet_swaps` and `transactions`, `basis: "rebuilt"`,
`tier: "reported"`, never mixed with sampled points inside a segment. Expected to be lower,
and expected to be labelled. **Worth doing last** — the sampler is the feature; the rebuild
only makes the first week look less empty.

---

## 6. Storage

```sql
aum_samples        (handle, at, total_usd, priced_positions, total_positions,
                    value_share, basis, tier, refused_reason, sampled_at)
aum_chain_samples  (handle, at, network_id, total_usd, priced_share, reason)
```

- `total_usd` is **null** when the sample was refused, and `refused_reason` says why. Never a
  smaller number.
- `basis` is `sampled` or `rebuilt`; `tier` is `verified` for sampled (amounts from chain) and
  `reported` for rebuilt (amounts from swaps we saw).
- `value_share` is the share of the total that priced positions represent — the field that
  makes a thin line legible as thin.
- Primary key `(handle, at, basis)` so a rebuild and a sample for the same hour can coexist
  and be told apart rather than one silently overwriting the other.

---

## 7. Acceptance, mapped to what we can actually verify

| PRD §8 criterion | Can we test it today? |
| --- | --- |
| Newest sample and `/positions` at the same prices agree within 1% on Solana | Yes, after Phase 0 |
| `sum(chains[].totalUsd) == now.totalUsd` on every response | Yes — pure arithmetic, worth a test |
| A pool above the ceilings is refused, counted, never multiplied; injected test survives with `price_rejected` on that coin only | Yes for the absolute ceilings; **no** for the median rule until §4.2 is resolved |
| After 24 passes every readable trader has 24 points on the day window | Yes, once the sampler is scheduled |
| `null` never 0 | Yes — already the house rule, and enforced by the schema above |
| No response mixes sampled and rebuilt without a `trackedSince` between them | Yes |
| Zero external calls per request | Yes — already true of every route |
| Route latency under 300 ms for 1w at default step | Yes, and the aggregate tables are what make it reachable |

---

## 8. Risks

- **Hourly load against public RPCs.** ~4,500 calls an hour on nodes that already 403 and 429
  us. Mitigated by the throttle and backoff already written, but it should run at reduced
  cadence first and be measured before going hourly.
- **Connection exhaustion.** Already happened once, on 2026-09-09, and took the live API to
  503 until the database was restarted. A recurring hourly job makes this a standing risk
  rather than a one-off. Hard connection cap, transaction-mode pooler, and no overlapping
  runs (`concurrency` group, as `refresh.yml` already does).
- **Silent partial samples.** The whole point of whole-trader refusal. Any code path that
  lets a partial total through defeats the feature.
- **A price source we do not control.** If DexScreener is adopted, its outage becomes our
  `no_prices` refusal — visible and honest, but it will show up as gaps in the chart.

---

## 9. Decisions needed before Phase 2

1. **DexScreener — yes or no.** Free, keyless, batches 30 tokens per call, and is the shape
   §4 already assumes. But it is a **new external API** and the standing rule is to ask.
   **Without it, hourly sampling cannot be priced and Phase 2 does not start.** It also
   unlocks the median-of-pools rule in §4.2.
2. **Two new tables — confirm.** `aum_samples` and `aum_chain_samples`. Aggregates only.
3. **Do chain reads override fomo for the 77 fomo-covered traders?** The PRD's §1 argues yes
   — fomo's running totals are the thing it calls wrong. It changes existing published
   numbers, so it is a visible change and not mine to make quietly.

Phase 0 needs none of these and can start as soon as the database is back.

### What to run, in order, once the database is healthy

1. Apply `20260910090000_aum_samples.sql`
2. `node --env-file=.env scripts/load_chain_balances.mjs --limit 3` — **one verification run**,
   because that script was rewired to the shared module and has not executed since
3. `supabase functions deploy api`
4. `node --env-file=.env scripts/load_aum_samples.mjs --limit 5 --dry-run`
5. `curl "$B/traders/frankdegods/aum?window=1w"`
