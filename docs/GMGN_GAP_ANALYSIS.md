# GMGN vs our API — what we are missing, what we have extra

Source: `https://github.com/GMGNAI/gmgn-skills/wiki` and its linked SKILL.md pages.
Compared against the routes live at
`https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api`.

**Re-verified 2026-09-08** against the four SKILL.md files that actually carry the endpoint
paths (`gmgn-portfolio`, `gmgn-market`, `gmgn-token`, `gmgn-track` — the wiki homepage itself
lists no paths), and against the live API. Corrections from that pass are marked ✅ **fixed**
or ⚠️ **was wrong** inline. Two classes of error were found: rows that were wrong when written,
and rows that went stale because we closed the gap ourselves while fixing the bug report.

We hold a `GMGN_API_KEY` and `src/gmgn.ts` already calls 4 endpoints — confirmed in source:
`/v1/user/kol`, `/v1/user/smartmoney` (via `${HOST}/v1/user/${cohort}`),
`/v1/user/wallet_stats`, `/v1/user/wallet_activity`.

**GMGN's full documented REST surface is 23 endpoints** across portfolio (7), market (6),
token (5) and track (5), plus the trade/cooking order endpoints. We call 4, so 19 remain.

---

## A · What we are missing

### A1. Endpoints GMGN has that we do not call

⚠️ **Was wrong.** This table previously listed `portfolio activity` and `portfolio stats`
as endpoints we do not call — contradicting this document's own preamble. `src/gmgn.ts:199`
calls `/v1/user/wallet_stats` and `src/gmgn.ts:217` calls `/v1/user/wallet_activity`. Both
rows are removed. The portfolio rows also gave CLI command names where every other row gave a
path; the real paths are now used throughout.

| Route | Returns |
| --- | --- |
| `GET /v1/user/wallet_holdings` | positions with per-token P&L |
| `POST /v1/user/wallet_profits` | **batch P&L for 1–100 wallets in one call** |
| `GET /v1/user/wallet_token_balance` | balance for one token |
| `GET /v1/user/created_tokens` | tokens created by a developer wallet |
| `GET /v1/user/info` | wallets and balances bound to the key |
| `GET /v1/token/info` | price, supply, market cap |
| `GET /v1/token/security` | honeypot, taxes, renounce status |
| `GET /v1/token/pool_info` | pool/liquidity detail |
| `GET /v1/market/token_top_holders` | top holders with P&L |
| `GET /v1/market/token_top_traders` | top traders with P&L |
| `GET /v1/market/token_kline` | OHLCV at 30s / 1m / 5m / 15m / 1h / 4h / 1d |
| `GET /v1/market/rank` | trending, 15+ range filters |
| `POST /v1/trenches` | newly launched tokens |
| `POST /v1/market/token_signal` | 21 real-time event types |
| `POST /v1/market/hot_searches` | ranking by visitor count |
| `GET /v1/market/search` | lookup by name / address / ENS |
| `GET /v1/trade/follow_wallet` | trades from followed wallets |
| `GET /v1/user/follow_tokens` | followed token list |
| `GET /v1/user/follow_token_groups` | follow group names |
| Trade / Cooking skills | market + limit orders, trailing TP/SL, multi-wallet |

### A2. Fields GMGN returns that we do not have

**Cost basis and averages**
- `history_bought_cost` — all-time buy cost
- `history_sold_income` — all-time sell proceeds
- `accu_cost` — cost basis of current holdings
- `total_cost` — total spent buying
- `realized_profit_cost` — cost tied to realized profit
- `buy_cost_usd` — cost basis of what was sold, per transaction

✅ **Fixed — no longer missing.** `avg_cost` (average price paid) and `avg_sold` (average
price sold at) were listed here. ISSUE-4 built both: `byToken[].avgEntryPrice` and
`avgExitPrice` are now genuine quantity-weighted averages, with `entryMethod`,
`entryPositions` and `entryPositionsWeighted` stating which computation produced each and
over how many positions — which GMGN does not disclose for its own `avg_cost`.

**Per-transaction money**
- `cost_usd` — USD value of the transaction
- `price_usd` — token price at transaction time
- `gas_usd` — network fee

**Token security**
- `is_honeypot`, `rug_ratio` (0–1), `is_wash_trading`
- `owner_renounced`, `renounced_mint`, `renounced_freeze_account`
- `buy_tax`, `sell_tax`, `open_source`

**Token supply and price**
- `circulating_supply`, `total_supply`, `max_supply`
- `price.price`, `liquidity`
- `market_cap`, `token_ath_mc`

**Holders**
- `holder_count` — all holders on chain
- `top_10_holder_rate` — concentration across all holders
- `wallet_tags_stat.smart_wallets`, `wallet_tags_stat.renowned_wallets`

**Wallet classification**
- tags: `smart_degen`, `renowned`, `fresh_wallet`, `dev`, `sniper`, `rat_trader`, `bundler`
- `rat_trader_amount_rate`, `bundler_rate`, `insider_rate`, `dev_team_hold_rate`
- `smart_degen_count`, `renowned_count`

**Creator**
- `creator_token_status` (`creator_hold` / `creator_close`), `cto_flag`
- `inner_count`, `open_count`, `open_ratio`, `creator_ath_info`

**Position timing**
- `start_holding_at`, `end_holding_at`, `last_active_timestamp`

**Other**
- `visiting_count` — search heat
- `price_change` — ratio since a trade
- `winrate`, `pnl` as a ratio

### A3. Capabilities we do not have

- Cursor pagination (`next`, `--cursor`) — we page with `limit`/`offset`, not a cursor
- Server-side range filters (`--min-*` / `--max-*`) on 15+ metrics — GMGN's `market trending`
  alone exposes ~19, and `trenches` ~28
- Server-side sorting (`--order-by`, `--direction`) — 15 sort keys on `trending`
- `--tag` filtering by wallet class (10 tags)
- Order execution: market, limit, trailing take-profit / stop-loss
- **7 chains** — `sol`, `bsc`, `base`, `eth`, `robinhood`, `arc`, `stable`. Verified against
  live `/chains`: we return `solana, robinhood, bsc, base, ethereum`, so `arc` and `stable`
  are genuinely missing. ✅ still accurate.

✅ **Fixed — no longer missing.** Two rows were removed from this list:

- **Batch queries.** ISSUE-8 shipped `GET /traders?include=pnl,scorecard,wallets,trust`,
  which returns all 137 traders with four sub-resources in one call (5.2s, 969KB). GMGN's
  equivalent (`POST /v1/user/wallet_profits`) caps at 100 wallets and covers P&L only.
- **Rate-limit headers.** ISSUE-7 shipped `RateLimit-Limit`, `RateLimit-Remaining`,
  `RateLimit-Reset` and `RateLimit-Scope` on every response including the 429, all exposed
  via CORS. GMGN publishes `X-RateLimit-Reset` / `reset_at` on 429 only; ours also states
  scope, which theirs does not.

---

## B · What we have extra

### B1. Routes with no GMGN equivalent

| Our route | Returns |
| --- | --- |
| `GET /traders/:handle/trust` | plausibility verdict on a trader's own reported numbers |
| `GET /tokens/momentum` | holder change between two dated snapshots |
| `GET /traders` | fomo's ranked leaderboard, by fomo's rank |
| `GET /traders/:handle/wallets` | fomo handle → EVM and Solana addresses |
| `GET /health` | row counts and build timestamp per table |
| `GET /traders?include=…` | whole board + 4 sub-resources in one call; GMGN's batch is P&L-only and caps at 100 |
| `GET /traders?updatedSince=…` | incremental sync — GMGN has no changed-since filter |

### B2. Fields with no GMGN equivalent

**Trust**
- `verdict` — ⚠️ **was wrong.** Listed as `implausible / unverified / insufficient / ok`.
  BUG-2 renamed `implausible` to `self_contradictory`, and `unverifiable` was missing from
  the list. The real set is **five** values, confirmed at `routes.ts:434-437`:
  `self_contradictory` / `unverified` / `unverifiable` / `insufficient` / `ok`
- `flags[]` with `code`, `severity`, `plain`
- `pnlToVolume`, `pnlToHoldings`
- `basis` — names the denominator behind each ratio (added by BUG-2)

**Coverage, on every derived figure**
- `coverage.of`, `coverage.total`, `coverage.share`
- `partial`
- `coverage.holdersNow`, `coverage.withTradeRecord`, `coverage.holdersNowWithNoRecord`
  — ⚠️ **was wrong.** Written as `sampled.*`; the live response has no `sampled` key at all.
  These live under `coverage`, and the rename mattered: `holdersNow` and `withTradeRecord`
  are different populations, and the old shape conflated them.

**Provenance**
- `tier` (`reported` / `verified`)
- `source` per figure
- `reported` vs `stored` split on `/traders/:handle`
- `entryBasis` — a statement of what an average is computed over. Now seven fields after
  ISSUE-4: `scope`, `sellsReduceIt`, `note`, `weighting`, `sells`, `marketCap`, `previously`.
  `weighting` names the rule (open legs by `amount`, closed legs by `pnl / (exit − entry)`)
  and `previously` records what the field returned before it was corrected — GMGN publishes
  `avg_cost` with no such statement.

**Freshness**
- `asOf` per figure, scoped per trader or per token
- `updatedAt` per trader
- `capturedAt` per build
- `generations` count

**Momentum**
- `previousHolders`, `change`, `gained[]`, `lost[]`, `isNew`
- `from`, `to`, `spanHours`

**Chain coverage**
- `historyCoverage.available`, `.via` — which provider can serve history per chain
- `balanceVerifiable`
- `unattributedRealized` — P&L that could not be assigned to a chain

**Narration**
- `plain` — a sentence per figure
- `caveats[]` — named limitations per response

### B3. Conventions with no GMGN equivalent

- A missing value is `null`, never `0`
- A ratio is suppressed when its inputs make it meaningless (`meanToMedian` requires both positive)
- A win rate is never stated without the net beside it
- A 404 body lists the valid routes
- Errors carry a stable `code` and name the offending `parameter`
- `everSold` returns `null`, not `false`, when there is no evidence either way

### B4. Data we hold that GMGN does not expose

- fomo leaderboard rank, handle, follower count, verified flag
- fomo's own reported `pnl` and `volume` per trader — the figure our trust route tests
- our own `transactions` table, fed live by a Helius webhook
- dated holdings generations (`captured_at`) enabling snapshot diffs
