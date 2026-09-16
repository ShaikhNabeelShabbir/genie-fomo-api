# Coverage of the app team's composite workflows (badges and protection)

Checked 17 September 2026 against branch `cloudflare-migration`. Source: the team's "Composite
Workflows" note. Their premise holds: most badges are one scorecard call per trader, because
`scorecard.byToken[]` already carries per coin the first/weighted entry and exit price, the
quantity legs, supply (so entry market cap), fomo's token creation time, first-open and
first/last-close times, and realised P&L. What is missing is listed per badge and patched by
the "Composite patch" items at the end.

| Badge | Needs | Have | Missing → patch |
|---|---|---|---|
| Early to Microcaps / Low Caps | entry mcap band, ≥10x / ≥5x realised, cashed, attempts denominator | `byToken[].entry` × `totalSupply` = entry mcap (already published as entry-mcap fields); `realizedPnlUsd`; `trades` count as denominator; `tokenCreatedUnix` for "within 24h of launch" (fomo-reported) | realised **multiple** per coin (`exit.weighted / entry.weighted`) and `realizedShare` (exit qty ÷ entry qty) as explicit fields → C1 |
| Active Trader | days since last ≥5x; green share of closes over 4 weeks | `lastClosedMs` per coin; realised per close in `trades` | a `recent` block: `lastBigWinAt`, `closes4w`, `green4w` → C2 |
| Exit Master | on ≥10x coins, share of position realised and exit mcap vs entry | entry/exit legs and supply exist | `realizedShare`, `exitMcapUsd`, `peakMcapSinceEntryUsd` (needs price history: hourly ATH from gap 1 going forward; null before) → C1 |
| Consistent Trader | big wins spread across months | `lastClosedMs` per coin | `closedMonth` per coin and `bigWinMonths` count → C1/C2 |
| Win size vs loss size | median win, median loss in dollars, W/L count | `trades.realized_pnl_usd` per close | `medianWinUsd`, `medianLossUsd` on the scorecard → C2 |
| Rug Dodger | coins that LATER turned honeypot, and whether he exited before | `token_info.is_honeypot` (latest only), `byToken[].lastClosedMs` | when the flag first appeared: `token_info.honeypot_since` set by the loader on the first flip → C3; `byToken[].isHoneypotNow`, `honeypotSince`, `exitedBeforeFlag` |
| Pump Catcher | coins that ran ≥100x from his entry mcap, captured or not | entry mcap; current mcap (`token_info.market_cap_usd`) | `currentMcapUsd`, `multipleCurrent`, `multiplePeak` (peak from gap 1 hourly ATH, null before sampling began) → C1 |
| Cabal Trader | coins held alongside N+ tracked leaders that crossed $10M/$100M; independence check | cohort holders per token (`/tokens/:address` holders); linked wallets (gap 5b) for independence | `byToken[].coHolders` (distinct cohort traders with a trade in the coin) and `coHoldersIndependent` (minus linked-wallet groups) → C3; peak mcap crossing needs history (gap 1) |
| Conviction Paid | bet size on ≥10x plays vs typical bet | `entry.sum` per coin = dollars in | `betUsd` per coin, `typicalBetUsd` (median dollars-in across coins) on the scorecard → C1/C2 |
| Bleeding Out | last 20 closes vs career: avg realised per close, red share; materiality floor vs typical bet | `trades` closes with dates | `recent.last20: { avgRealizedUsd, redShare }`, `career.avgRealizedUsd`, and `bleeding: boolean` computed with the team's floor → C2 |
| Style Drift | current entry-mcap band, pace, hold time vs the record the user copied | entry mcap per coin, `opened_at`/`closed_at` → hold time; the user's copy baseline is client-side | `recent.entryMcapMedianUsd`, `recent.holdHoursMedian`, `recent.tradesPerDay` and the same for career → C2; the comparison is the app's |
| Casino Closed | cohort share green this week, launch survival rate, rotation speed | trades across the cohort; launches (gap 3, Solana); flow (gap 4) | `GET /v1/market/regime` → C4 |
| Smart Exits (weighted) | reductions on a coin by tracked holders, weighted by each seller's exit-timing score | reductions: `holdings` diff nightly, real-time on Solana (gap 4 `/flow`); `/tokens/:address/activity` lists movers | `exitTimingScore` per trader (share of past exits where the coin now sits below his exit price) on the scorecard, and on `activity` sellers → C5 |

**Score:** every badge is computable once C1–C5 land; none is fully served today because
the per-coin multiples, realised share and recency windows are not published, and three need
data the branch only started collecting today (hourly price history, launch metadata, linked
wallets).

## Composite patch (five items, one agent each)

- **C1 `byToken[]` per-coin economics**: `entryMcapUsd` (exists), `exitMcapUsd`, `currentMcapUsd`,
  `peakMcapSinceEntryUsd` (from `token_price_hourly` × supply when present), `multipleRealized`,
  `multipleCurrent`, `multiplePeak`, `realizedShare`, `betUsd`, `closedMonth`, `entryHoursAfterLaunch`
  (from `tokens.created_at` when set, else `tokenCreatedUnix`).
- **C2 scorecard windows**: `typicalBetUsd`, `medianWinUsd`, `medianLossUsd`, `bigWinMonths`,
  `recent: { lastBigWinAt, closes4w, green4w, last20: { avgRealizedUsd, redShare }, entryMcapMedianUsd,
  holdHoursMedian, tradesPerDay }`, `career: { avgRealizedUsd, entryMcapMedianUsd, holdHoursMedian,
  tradesPerDay }`, `bleeding: boolean` (their floor: recent − career beyond `typicalBetUsd`, or red
  share ≥ 60 %).
- **C3 honeypot-since and cohort co-holders**: `token_info.honeypot_since` (loader sets it on the
  first flip, never clears), `byToken[].isHoneypotNow / honeypotSince / exitedBeforeFlag`,
  `byToken[].coHolders / coHoldersIndependent` (linked-wallet groups collapsed).
- **C4 `GET /v1/market/regime`**: `leadersGreenShare7d`, `launchSurvival7d` (Solana launches
  from gap 3 still above the curve or graduated), `rotation7d` (net flow concentration from gap 4),
  `asOf`, and a `regime` word (`open` | `caution` | `closed`) with published thresholds.
- **C5 exit-timing score**: `scorecard.exitTimingScore` (share of closed coins whose current price
  is below his weighted exit; null under 5 exits) and `sellers[].exitTimingScore` on
  `/tokens/:address/activity`.

Everything is Solana-first where it depends on real-time or launch data, as before.
