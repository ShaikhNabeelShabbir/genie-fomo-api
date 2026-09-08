# GMGN vs our API — what we are missing, what we have extra

Source: `https://github.com/GMGNAI/gmgn-skills/wiki` and its linked SKILL.md pages.
Compared against the 15 routes and 35 parameters live at
`https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api`.

We hold a `GMGN_API_KEY` and `src/gmgn.ts` already calls 4 endpoints:
`/v1/user/kol`, `/v1/user/smartmoney`, `/v1/user/wallet_stats`, `/v1/user/wallet_activity`.

---

## A · What we are missing

### A1. Endpoints GMGN has that we do not call

| Route | Returns |
| --- | --- |
| `portfolio holdings` | positions with per-token P&L |
| `portfolio activity` | transaction history with USD values |
| `portfolio stats` | trading statistics, batch-capable |
| `portfolio profits` (POST) | **batch P&L for 1–100 wallets in one call** |
| `portfolio token-balance` | balance for one token |
| `portfolio created-tokens` | tokens created by a developer wallet |
| `portfolio info` | wallets and balances bound to the key |
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
- `avg_cost` — average price paid per token
- `avg_sold` — average price sold at
- `buy_cost_usd` — cost basis of what was sold, per transaction

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

- Batch queries: 1–100 wallets in one request
- Cursor pagination (`next`, `--cursor`)
- Server-side range filters (`--min-*` / `--max-*`) on 15+ metrics
- Server-side sorting (`--order-by`, `--direction`)
- `--tag` filtering by wallet class
- Rate-limit headers: `X-RateLimit-Reset`, `reset_at`
- Order execution: market, limit, trailing take-profit / stop-loss
- 7 chains: `sol`, `bsc`, `base`, `eth`, `robinhood`, `arc`, `stable` (we have 5 — no `arc`, no `stable`)

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

### B2. Fields with no GMGN equivalent

**Trust**
- `verdict` (`implausible` / `unverified` / `insufficient` / `ok`)
- `flags[]` with `code`, `severity`, `plain`
- `pnlToVolume`, `pnlToHoldings`

**Coverage, on every derived figure**
- `coverage.of`, `coverage.total`, `coverage.share`
- `partial`
- `sampled.holdersNow`, `sampled.withTradeRecord`, `sampled.holdersNowWithNoRecord`

**Provenance**
- `tier` (`reported` / `verified`)
- `source` per figure
- `reported` vs `stored` split on `/traders/:handle`
- `entryBasis` — a statement of what an average is computed over

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
