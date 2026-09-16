# Axis Formulas — GMGN API Calls & Test Queries

Scope: only the API surface needed to compute the 6 axes. Axes score 0–100 as percentile
rank within the 100-trader cohort. Null input → axis renders hollow, never zero.

Setup for testing (public read-only demo key, replace with our key after dashboard setup):

    npm i -g gmgn-cli
    export GMGN_API_KEY=gmgn_solbscbaseethmonadtron      # demo; personal key from gmgn.ai/ai
    # IPv4 only — 401/403 with a valid key usually means IPv6 egress

Add `--raw` to every command for single-line JSON to pipe into jq / the scorer.

---

## Q1 — profits (cohort-batched, 4 calls total)

    gmgn-cli portfolio profits --chain sol \
      --wallet <a1> --wallet <a2> ... --wallet <a100> \
      --period all --raw
    # repeat with --period 1d, 7d, 30d

Envelope: `list[]`, one row per wallet. Monetary values are DECIMAL STRINGS — parse as decimals.

Fields used: `wallet_address`, `realized_profit` (period), `unrealized_profit`,
`total_realized_profit`, `total_profit`, `total_cost`, `buy`, `sell`.

## Q2 — stats (per wallet)

    gmgn-cli portfolio stats --chain sol --wallet <addr> --raw

Envelope: object (array for batch). Fields used: `winrate` (0–1), `buy_count`, `sell_count`,
`total_cost`, `realized_profit`, `unrealized_profit`.
Also store `common.created_at`, `common.fund_from_address` when present (cluster work later);
`common` may be absent — skip silently.

## Q3 — holdings (per wallet, paginated)

    gmgn-cli portfolio holdings --chain sol --wallet <addr> \
      --order-by usd_value --raw
    # response has `list[]` + `next`; pass `--cursor <next>` until next is empty

Fields used per row: `token.token_address`, `token.symbol`, `token.total_supply`,
`token.creation_timestamp`, `balance`, `usd_value`, `accu_cost`,
`history_bought_cost`, `history_sold_income`, `realized_profit`, `unrealized_profit`,
`start_holding_at`, `end_holding_at`, `last_active_timestamp`,
`history_total_buys`, `history_total_sells`.
Note: no `avg_cost` field — derive `accu_cost / balance`. It is `token.token_address` here,
`token.address` in activity.

## Q4 — activity (per wallet, paginated, cache incrementally)

    gmgn-cli portfolio activity --chain sol --wallet <addr> --raw
    # `activities[]` + `next` cursor; store last seen tx and stop paging when reached

Fields used per row: `tx_hash`, `event_type` (read `event_type ?? type`),
`token.address`, `token_amount`, `cost_usd`, `buy_cost_usd` (sell rows: cost basis of what
was sold), `price_usd`, `timestamp`, `gas_usd`.
EXCLUDE `transferIn` / `transferOut` rows from every computation — not trades.

---

## Axis derivations (which query feeds what)

**Axis 1 — Cash-out**
- realizedShare = `total_realized_profit / total_profit`            (Q1 all)
- flow check: Σ `history_sold_income` vs Σ `history_bought_cost`    (Q3)
- null rule: `total_profit = 0` or missing → hollow

**Axis 2 — Consistency**
- per-exit PnL on each sell row: `cost_usd - buy_cost_usd`          (Q4)
- topTradeShare = max(per-token `realized_profit`) / Σ positive     (Q3)
- meanToMedian = mean(exitPnLs) / median(exitPnLs), suppress unless both > 0
- null rule: < 20 sell rows → hollow (and trader → Insufficient tier)

**Axis 3 — Edge**
- raw = `winrate`, n = `sell_count`                                  (Q2)
- shrunk: 0.5 + (winrate − 0.5) × n/(n+30)

**Axis 4 — Risk control**
- worstExit = min(`cost_usd - buy_cost_usd`) over sells             (Q4)
- typicalBet = `total_cost / buy_count`                              (Q2)
- lossRatio = |worstExit| / typicalBet
- cashShare = Σ `usd_value` where token ∈ STABLE_MINTS / Σ `usd_value`   (Q3; we maintain STABLE_MINTS)
- concentration = max `usd_value` / Σ `usd_value`                    (Q3)

**Axis 5 — Selectivity**
- per buy row: entryMcap = `price_usd × token.total_supply`          (Q4 × Q3 metadata)
- score inputs: median(entryMcap) — lower is harder — and winrate restricted to buys
  with entryMcap < $1M
- store per-buy Δt = `timestamp − token.creation_timestamp` NOW (feeds P-params later)
- null rule: supply missing for > 30% of buys → hollow

**Axis 6 — Activity density**
- activeDays = distinct days with ≥ 1 trade row                      (Q4)
- density = tradeCount / activeDays; recency = now − max(`timestamp`);
  evenness = 1 − gini(trades per day)
- cross-check with `last_active_timestamp`                           (Q3)

Percentile step (all axes): rank each wallet's value within the 100-wallet cohort → 0–100.
Recompute ranks on every refresh; store raw value + rank + asOf (our fetch time).

---

## Test sequence (day one)

1. Demo key smoke: `gmgn-cli market trending --chain sol --interval 1h --limit 3 --raw` → JSON = wired.
2. Pick 3 known wallets. Run Q1(all) + Q2 + Q3 (full pagination) + Q4 (full pagination). Dump raw JSON to disk.
3. Field audit: assert every field named above exists in the dumps. Any miss → check their
   SKILL.md tables before renaming anything (names are route-specific and versioned).
4. Sanity identities per wallet:
   - Q2 `realized_profit` ≈ Q1(all) `total_realized_profit`
   - Σ Q3 `realized_profit` ≈ Q1 `total_realized_profit` (tolerance: unpriced/partial rows)
   - Q4 sell-row Σ(`cost_usd − buy_cost_usd`) ≈ realized profit over the same span
5. Compute all 6 axes for the 3 wallets; eyeball against their GMGN wallet pages.
6. Scale to the 100-wallet cohort; measure calls + wall time; set nightly cadence + 429 backoff.

Reminder: GMGN raw numbers only — their tags/labels never enter axis math. Everything derived
is stamped `asOf` = our fetch time and labeled "reported (GMGN)".
