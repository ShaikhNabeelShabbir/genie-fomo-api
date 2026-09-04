# PLAN — move computation off external APIs and onto our own database

## The principle

> **Every external API call belongs in a scheduled job, never in a request.**

Today a visitor's request can trigger wallet resolution, chain queries and P&L replay — so
traffic costs money linearly and a popular hour can exhaust a free tier. After this work,
every route answers from Postgres and the keys are used once per cron run. One thousand
users cost exactly what one user costs.

A second reason, discovered while writing this plan: **the source data is volatile between
builds, and the file format silently destroys the previous state.**

| | 2026-09-02 build | 2026-09-04 build |
| --- | --- | --- |
| Solana positions | 1,605 | **657** |
| Robinhood positions | 226 | **923** |
| Priced rows overall | 78% | **16.1%** |
| Total value | $18.5M | $10.5M |

Two days apart, the busiest chain changed and pricing coverage collapsed by a factor of
five. With a single JSON file the older state is simply gone. With `captured_at` on every
row, that drift becomes queryable history instead of a silent overwrite — and K2 momentum
falls out of the same design for free.

---

## Status legend

| | Meaning |
| --- | --- |
| ✅ | done and verified |
| 🔄 | in progress |
| 🎯 | next up |
| ⬜ | not started |
| ⏸️ | deliberately deferred — see §7 |

---

## Baseline (measured 2026-09-04, the numbers step 3.2 must reproduce)

```
traders                     100
holdings rows             2,038
value not null              350           <- rows carrying a number
priced rows (value > 0)     328   (16.1%)  <- 22 rows are a genuine 0, not a gap
distinct (chain, token)     903   -> 7 quote pairs -> 896 rankable
total value USD      $10,544,636   (Solana only; every other chain is 0% priced)
wallet coverage      95 evm / 88 sol / 97 either

positions by chain:  robinhood 923 | solana 657 | bsc 285 | base 114 | ethereum 59
priced by chain:     solana 49.9%  | everything else 0.0%
```

---

## Phase 0 — Foundations ✅

| | Step | Why | Verify | Status |
| --- | --- | --- | --- | --- |
| 0.1 | Supabase project | somewhere to put the data | project `genie-fomo-api`, Seoul | ✅ |
| 0.2 | Connection strings | direct host is IPv6-only and unreachable; the pooler is the IPv4 path | both URLs return `ok\|postgres\|17.6` | ✅ |

`SUPABASE_DB_URL` = port **5432** (session pooler, migrations).
`DATABASE_URL` = port **6543** (transaction pooler, app). `?pgbouncer=true` removed — it is
a Prisma-only parameter and libpq rejects it.

---

## Phase 1 — Schema ✅

| | Step | Why | Verify | Status |
| --- | --- | --- | --- | --- |
| 1.1 | Design 9 tables with PKs + FKs | referential integrity we do not get from a JSON blob | 9 tables, 8 FKs, RLS on all | ✅ |
| 1.2 | Write migration SQL | reproducible, re-runnable, reviewable | `supabase/migrations/20260904070000_initial_schema.sql` | ✅ |
| 1.3 | Apply to Supabase | — | applied clean, `ON_ERROR_STOP=1` | ✅ |
| 1.4 | Seed `chains` + `quote_assets` | the quote denylist is currently hardcoded in `metrics.ts`; as data it is editable without a redeploy | 5 chains, 12 quote assets | ✅ |

**Verified by test (inserted, asserted, rolled back):**

```
Solana case preserved   Ai66LHZG9MCz…  ->  key ai66lhzg9mcz…   (base58 not corrupted)
Append-only             2 builds of the same (handle, token) coexist
holdings_current        shows 1 row, the newest build only
NULL value excluded     rows=2  priced=1  total_value=75   <- not 75+0
FK rejects orphan       holdings_handle_fkey on an unknown handle
```

The `total_value=75` line is the one that matters: a `DEFAULT 0` on `value` would have
made that 75 as well, and every coverage figure in PARAMETERS.md would have been quietly
wrong. It is asserted, not assumed.

**Tables**

```
chains         network_id PK                       5 seeded rows
traders        handle PK                           stable identity
trader_stats   (handle, captured_at) PK            rank/pnl/volume over time
tokens         (network_id, token_address) PK      FK -> chains
holdings       (handle, network_id, token_address, captured_at) PK
wallets        (handle, chain, address) PK         the src_evm/src_sol resolutions
trades         trade_id PK                         fomoapi UUID
transactions   (network_id, tx_hash) PK
quote_assets   (network_id, token_address) PK      USDC/USDT/wSOL/WETH/WBNB
```

**Two constraints that are not negotiable:**

1. **`holdings.value` is nullable with NO default.** 1,710 of 2,038 rows have no price. A
   `DEFAULT 0` would silently change concentration, cash share, chain value and every
   coverage figure — the exact class of error the coverage system exists to prevent.
2. **`captured_at` is part of the PK on `holdings` and `trader_stats`.** This is what makes
   ingestion append-only, and it is what gives K2 momentum for free.

---

## Phase 2 — Ingest (build time — where every key now lives) 🔄

| | Step | Why | Verify | Status |
| --- | --- | --- | --- | --- |
| 2.1 | `load_to_db.py` upserts traders / tokens / holdings | replaces the JSON write; append-only by `captured_at` | ✅ every §Baseline figure reproduced exactly | ✅ |
| 2.2 | Wallets from `src_evm` / `src_sol` | 97 of 100 traders already carry a resolved address — no fingerprinting needed | ✅ 97 rows, one per trader: 95 evm + 88 sol | ✅ |
| 2.3 | Trades from fomoapi | unlocks T1–T20 **and** turns K5–K8 from a 25-holder fan-out into SQL | ✅ 100/100 traders, 6,398 trades (2,302 closed) | ✅ |
| 2.4 | Transactions via Helius / Bitquery / Etherscan | removes the chain stack from the request path entirely | txs for 97 wallets | ⬜ |

**On 2.2 — this may retire the most expensive machinery in the project.** `resolvers.ts`
fingerprints real wallets by matching position sizes against on-chain holder lists, because
fomo's own `evm`/`sol` fields are empty for all 100 traders. But fomoapi's `src_*` fields
are populated for 97, and all four sampled were **active within hours**. If they hold up
under checking, the resolver stops being load-bearing.

**On 2.1 — the loader is a separate script, not part of the builder.** `build_directory_fomoapi.py`
fetches and validates; `load_to_db.py` only writes. That split means a reload costs zero API
calls, a database failure cannot lose a build, and the file survives as an independent copy
to diff against in step 3.2 — which is the entire point of the checkpoint.

It also revealed a distinction worth keeping: **350 holdings carry a value, but only 328 are
above zero.** A genuine `0` and a missing price are different facts, so the loader stores
what the build actually said and leaves the `> 0` rule to the query layer. Collapsing them
at write time would have destroyed information the coverage figures depend on.

**On 2.2 — `wallets` is one row per trader, not one per wallet.** The normalised
row-per-wallet shape was built first and then reshaped: no trader has two addresses of the
same kind (0 of 97), so it bought flexibility nothing used while making the commonest read
— "this trader's two addresses" — a filtered aggregate.

Provenance is kept **per chain** rather than dropped, because a fomoapi-reported address and
one we verify are different claims (§5 of PARAMETERS.md). `balanceOf` is free and keyless on
all five chains (C5), so `evm_confidence` / `evm_verified_at` and their Solana counterparts
are where that lands. The only thing this shape cannot hold is a *rival* candidate for the
same trader+chain — and `resolvers.ts` already discards losing candidates, returning one
`address` plus a `candidates_considered` count.

**On 2.3 — the budget is why this is daily, not hourly:**

```
100 traders once daily    =  3,000 calls/month   ✅ under the 10,000 free tier
100 traders twice daily   =  6,000 calls/month   ✅
100 traders every 6h      = 12,000 calls/month   ❌ over
```

**fomo sheds load over a time window, and one pass is not enough.** A 6-trader sample
succeeded 6 of 6 at fanout 2, so that looked like the fix; at 100 traders the same settings
returned 59 degraded envelopes. Lowering concurrency further does not help — the limit is
not per-connection.

The answer was to make the loader **resumable** rather than to fight it: `load_trades.py`
only fetches traders it has no trades for, so each pass picks up what the last could not.

```
pass 1   41/100      pass 4   95/100
pass 2   66/100      pass 5   98/100
pass 3   80/100      pass 6  100/100   COMPLETE
```

Six passes, ~250 calls total against a 10,000/month tier. The cron should run passes until
coverage stops improving, not once.

---

## Phase 3 — Read path 🔄

| | Step | Why | Verify | Status |
| --- | --- | --- | --- | --- |
| 3.1 | `directory.ts` reads Postgres | one change moves 9 file-only routes at once — `metrics.ts` is pure functions over a trader array | ✅ `directory loaded from db: 100 traders` | ✅ |
| 3.2 | **CHECKPOINT — diff DB vs file** | the only guard against a schema bug silently changing every number | ✅ 7 of 7 checks identical | ✅ |
| 3.3 | Move heavy aggregates to SQL | `/v1/tokens` inverts 2,038 holdings in memory per request; in Postgres it is an indexed GROUP BY | same output, faster | ⬜ |
| 3.4 | `/pnl` + `/scorecard` from `trades` | removes fomoapi from the request path | no network call during a request | ⬜ |
| 3.5 | K5–K8 from `trades` | **45s → ~10ms, and 25 sampled holders → all 896 tokens** | `/activity` under 100ms | ⬜ |
| 3.6 | K2 from a `captured_at` self-join | deletes `snapshots.ts` and its ephemeral-disk problem | momentum works after 2 cron runs | ⬜ |
| 3.7 | `/wallets` serves stored addresses | it read the directory then discarded it, re-resolving live on every request | ✅ 21ms, reflects the DB; `?verify=true` keeps the resolver | ✅ |

**On 3.7 — found by editing a row in the dashboard and watching the API ignore it.**
Appending `Nabeel` to `wallets.evm_address` proved the directory *was* reading Postgres
(`src_evm` came back edited) and that `/wallets` then threw that answer away:

```
verifyCandidate("0x…119eNabeel")  ->  balanceOf fails, address = null
evmOk === false                   ->  resolveAll() searches holder lists
                                  ->  re-derives the real 0x…119e
```

Two problems, not one. The route spent Bitquery and Helius quota per visitor to re-derive a
value already in the database — and a single malformed row turned a 431ms request into a
measured **4m12s** one, which is a denial-of-service shape rather than a slow path.

Now: stored addresses by default, labelled `tier: "reported"`; `?verify=true` opts into the
resolver and returns `tier: "verified"` with confidence grades. Addresses are shape-checked
before anything expensive touches them, so bad data is withheld with a warning in
microseconds instead of triggering a chain-wide search.

**Step 3.2 is the one step that must not be skipped.** Everything after it assumes the DB
is a faithful copy. If a number moves here, it is a schema bug, and finding it later means
unpicking three phases.

**Result — 7 of 7 identical.** `DIRECTORY_SOURCE=file|db` forces the source, so both were
run side by side on ports 8788 and 8787 and compared:

```
/v1/chains                      (100, 2038, 5)
/v1/chains solana value         10544636.01
/v1/tokens                      ranked 896, excluded (7 tokens, 93 positions)
/v1/traders/unipcs/portfolio    118 positions, 0.9851 concentration, $3,630,587.09
/v1/traders/unipcs/trust        implausible, 5.98, 3.91
/v1/traders?limit=3             unipcs, DumbCrayonEater, Salem1299534
```

The `DIRECTORY_SOURCE` override is kept deliberately: without a way to run both sources at
once, a schema bug becomes the new truth instead of a visible difference.

**One known gap:** `window` is now null. The build window ("30d") was a field in the JSON
and has no column. Cosmetic, but `/v1/traders` reports it.

---

## Phase 4 — Automation ⬜

| | Step | Why | Verify | Status |
| --- | --- | --- | --- | --- |
| 4.1 | GitHub Actions cron | data refreshes without a human or a redeploy | run appears in `trader_stats` | ⬜ |
| 4.2 | Staleness alert | a silently stale DB is worse than an obviously broken one | alert fires past threshold | ⬜ |

---

## Phase 5 — Serving ⬜

| | Step | Why | Verify | Status |
| --- | --- | --- | --- | --- |
| 5.1 | Edge Functions port | serve from the DB's edge, drop the Render instance | parity with Express | ⬜ |
| 5.2 | RLS policies | published data should be readable without exposing writes | anon can read, not write | ⬜ |

**Two routes cannot move to Edge Functions:**
- `/v1/hyperliquid/traders` — 36MB feed, ~121MB heap to parse. Exceeds the memory budget.
- Anything that fans out — but 3.5 removes the only one, so this resolves itself.

Sequencing matters: **do not port the runtime and the data layer at once.** If a number
comes out wrong you will not know which change caused it.

---

## 6. What this actually buys

| | Today | After |
| --- | --- | --- |
| External calls per request | up to 25 (`/activity`), unbounded (Stack A) | **0** |
| Cost of traffic | scales with visitors | flat |
| `/activity` | 45s, 25 of 896 tokens | ~10ms, all 896 |
| K2 momentum | broken on every redeploy | works, free |
| Updating data | commit file → redeploy | cron writes rows |
| Historical state | overwritten each build | queryable |

---

## 7. Deliberately deferred ⏸️

| | Why not now |
| --- | --- |
| **Transaction watcher** | Polling ~200 wallets/minute is 288,000 calls/day against a 100k/month Helius tier — **86× over**. Helius webhooks invert it for Solana, but nothing in PARAMETERS.md needs live transactions. Decide whether sub-hourly freshness is actually required before paying for it. |
| **K10** (is the price real) | needs Bitquery pool prices |
| **C3** (chain profitability) | the source carries one `pnl` per trader, not one per chain — splitting it means inventing an attribution |
| **`pnl.ts` bug fixes** | 3 confirmed bugs (`top_position_share` unbounded, `worst_trade_usd` can report a gain as a loss, `realized_share` ignores sign). Stack A only. Fix before 2.4 makes that path primary. |

---

## 8. Open risks

1. **PARAMETERS.md figures are now stale.** Every measured number in it came from the
   2026-09-02 build. They need refreshing after 3.2, not before — the DB is about to become
   the source of truth for them.
2. **Pricing coverage is degrading** — 78% → 16.1% in two days. If fomoapi keeps dropping
   prices, value-based parameters (T13, T14, K3, C2) get thinner regardless of architecture.
   The DB will at least make the trend visible.
3. **Transaction volume is unmeasured.** Step 2.4 is sized on an assumption; measure one
   wallet's history before backfilling 97.
