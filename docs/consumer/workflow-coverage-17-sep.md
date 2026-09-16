# Coverage of the app team's automated workflows (W-A … W-J)

Checked 17 September 2026 against branch `cloudflare-migration` (vocabulary v5) and the data the
loaders actually hold. Source: the team's "automated workflows" note. Legend: **have** = the API
serves it today · **derivable** = the rows exist, the route does not · **missing** = no data.

## What every workflow leans on, and what exists

| Building block | State | Where |
|---|---|---|
| A classified cohort (their "137") | partial | 446 traders: 155 fomoapi.io + 291 GMGN (KOL / smart-money lists). GMGN tags are read by `load_gmgn_traders.mjs` but not stored; `traders.source` is the only class. One EVM + one Solana wallet per trader |
| Current holdings per wallet | nightly | `holdings` generations from chain reads (`load_chain_balances.mjs`); `/positions`, `/portfolio` |
| Per-token holdings **hourly** | missing | AUM samples every ~4 h carry chain totals only (`aum_chain_samples`), not tokens |
| Real-time transfers | Solana only | Helius webhook, both legs, `tx_source` (e.g. PUMP_FUN) and `tx_type` stored. EVM is a nightly 5-page backfill; R6's `coverage.chains` measures how thin |
| Per-wallet swap exits with P&L | Solana | `wallet_swaps`: 4,696 Solana swap groups vs 81 EVM; `/trades`, scorecard `byToken`, T3 `onChain` |
| Trade records with entry/exit | have | `trades` from fomoapi (155 traders) + GMGN activity (291) |
| Token fundamentals + security | have (latest only) | `token_info` from GMGN: holder count, mcap, liquidity, honeypot/tax/renounce (G12), creator status and creator's previous best (G10). **No history**: one row per token, overwritten nightly |
| Token price history | missing for most | `token_prices` holds Binance quote assets and, from tonight, Robinhood coins via DexScreener. No per-token ATH, no drawdown, no minute bars |
| Launch metadata (created at, launchpad, bonding curve, graduation) | missing | not read anywhere; pump.fun code lived in the retired Express app and was a live scrape |
| Funding graph | derivable (Solana) | native SOL transfers carry `counterparty`; a tracked wallet funding a fresh one appears as its outbound transfer. `fund_from_address` is not stored; `wallets` allows one address per chain per trader, so linked wallets have no home |
| Alerts / push | missing | the API is pull-only (240/min, batch routes). No event feed, no outbound webhooks |
| Paper-copy simulation | missing | nothing simulates following a wallet at lag and size |

## Per workflow

| # | Workflow | Coverage | What we have | What is missing |
|---|---|---|---|---|
| W-A | Genesis Scan | **partial** | Win-rate denominators and per-token round-trips (scorecard, `byToken`); who in the cohort moved in/out of a token recently (`/tokens/:address/activity`); accumulation visible nightly, real-time on Solana; sells visible on Solana (`wallet_swaps`) | "past runners" needs price history and ATH; "early buyers" needs token launch time; bundler / fake-crowd detection needs holder-list snapshots beyond the cohort |
| W-B | Graduation Sniper's Diary | **missing** | Solana buys tagged `tx_source = PUMP_FUN` in `transactions`, so "which cohort wallet bought on pump.fun" is derivable; specialist hit-rate per wallet is derivable from `wallet_swaps` once launches are labelled | bonding-curve % (on-chain curve account read per mint), graduation events, launch phase labels; the "2+ specialists under 60%" alert needs all of those plus an event feed |
| W-C | Dev Tree Hunt | **partial** | G10 on `/tokens/:address`: creator status (holding / sold), creator's previous best launch; G12 honeypot and security pre-check | a dev ledger across launches (creator → every token, peak mcap, sold-vs-held per launch) needs a `creators` table fed nightly from GMGN's `creator_ath_info`; "launches again" needs a new-token feed; serial-rugger scoring |
| W-D | Survivor Scan | **partial** | tracked-money per token rising: daily from `holdings` generations (`/tokens/momentum` already diffs two snapshots); cohort exits on Solana | launch snipers are mostly **outside** the cohort, and only cohort wallets are watched; global holder-count history (one row today, overwritten); C15 as a daily list needs the two above |
| W-E | Second-Act Radar | **partial** | wallets that previously round-tripped a token at verified profit: per-wallet per-token realised P&L from `wallet_swaps` (Solana); re-entry visible in real time on Solana | ">50 % off peak" needs per-token price history with ATH; EVM re-entries are nightly at best |
| W-F | Rotation Compass | **missing** | nightly holdings diff per token per trader is derivable from `holdings` generations | hourly diff (needs hourly per-token holdings or a roll-forward of real-time transfers between nightly reads); a category / launchpad / chain taxonomy for tokens (chain exists, the other two do not) |
| W-G | Copy-the-Copyable | **missing** | the raw material for a Solana paper soak: `wallet_swaps` with `block_time` and `quote_usd` | the simulator itself, minute-level prices to fill at lag, size rules, and a "follower PnL" figure on the leaderboard. E5 is the largest single build in the list |
| W-H | Whale Autopsy | **partial** | per-coin exit timeline of the cohort (`/tokens/:address/activity`, `transactions`), concentration and dev/security flags on `/tokens/:address`, exit velocity derivable from `transactions` | the trigger ("minutes after a dump") needs price history; who "ate it" outside the cohort needs holder snapshots; the write-up is a consumer-side generator |
| W-I | Conviction Ledger | **partial** | per-wallet typical bet size is derivable from `wallet_swaps.quote_usd` (Solana) and `trades.amount × avg_entry_price`; gates exist (G12 security, R4/V1 price sanity) | `typicalBetUsd` is not published; the ≥3× alert needs an event feed; EVM sizing is nightly-only |
| W-J | Fresh Wallet Genealogy | **partial** | a proven wallet's outbound native SOL transfer to an unknown address is already a row (counterparty stored); `POST /traders/:handle/wallets` exists | `fund_from_address` on wallets; a linked-wallets model (`wallets` holds one address per chain); auto-inheriting the watch and the Helius registration; EVM funding is nightly-only |

**Score:** 0 of 10 fully covered, 7 partial, 3 missing (W-B, W-F, W-G).

## The six gaps that unlock most of the list

Ordered by how many workflows each one serves.

1. **Token price history with ATH and drawdown** (W-A, W-E, W-H, W-D). Extend the DexScreener
   loader from Robinhood to every held token on every chain, hourly, into `token_prices` with an
   hourly grain and a rolling ATH. Size: M. Unlocks "runner", "off peak", "dump" everywhere.
2. **An event feed** (W-B, W-C, W-I, W-J, W-H). A keyset-paged `GET /v2/events?since=` over the
   Solana webhook rows plus nightly diffs, with the wallet's class and the token's gates
   attached. No push needed at first; the app polls. Size: M.
3. **Launch metadata** (W-B, W-C, W-D). Token created-at, launchpad and pump.fun curve state
   from one on-chain read per new mint, stored on `tokens`; graduation detected when the curve
   completes. Size: M–L (needs the pump.fun program layout).
4. **Per-token holdings between nightly reads** (W-F, W-A). Roll Solana holdings forward from
   the real-time transfers; EVM stays nightly until the backfill is wider. Size: M.
5. **A dev ledger and a linked-wallets model** (W-C, W-J). Two tables fed nightly from data we
   already fetch (GMGN creator info; native-transfer counterparties). Size: S each.
6. **The paper-copy simulator** (W-G). Only after 1 and 4; it needs fills at lag. Size: L.

Everything above is Solana-first by construction: the webhook is the only real-time feed, and
`wallet_swaps` is 98 % Solana. EVM parity for any workflow means widening the EVM backfill
and receipt resolution first (the same prerequisite as the full T3).
