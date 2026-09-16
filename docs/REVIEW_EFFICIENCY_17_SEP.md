# Efficiency review of the API refactor (17 Sep 2026)

Senior review of branch `Junaid-deve-starts`, efficiency first. Ranked; each item names the fix.
Line numbers are as of commit 3168e0e and drift as the branch moves.

## Ranked findings

1. **`routes/aum.ts` `aumFor` loads a trader's entire history from three tables regardless of
   window.** ~1k rows per trader today, ~50k in a year; a 50-id batch is the one cost curve that
   will hit the 15 s route race and the Worker's 30 s CPU budget. Fix: bound the `aum_samples`
   read to the window plus two days of anchor slack; aggregate `trackedSince` (`min(at) filter
   (where basis='sampled')`) and `newest` (last 36 h) in SQL; fetch chain rows only for the
   points emitted.
2. **`max(sampled_at) from aum_samples where basis='sampled'` is a full scan on every `/aum`
   and on `/health`.** Fix: `create index aum_samples_sampled_idx on aum_samples (sampled_at
   desc) where basis = 'sampled'`, and cache the value per isolate for a minute.
3. **`aumFor` awaits eight queries sequentially; five are independent** (`allChainRows`,
   `knownChainsFor`, `nativePrices`, `samplerRow`, `presenceRows`). Fix: one `Promise.all`.
4. **`app.ts` pretty-prints every response** (`JSON.stringify(body, null, 2)`), 1.5–2× the bytes
   and CPU on multi-MB batch bodies, then the version regex walks it. Fix: compact JSON; keep
   the regex.
5. **A timed-out route keeps its query and its connection.** `Promise.race` rejects but cancels
   nothing; with `max: 2` on Deno two slow routes starve the pool. Fix: `connection:
   { statement_timeout: "14000" }` on both clients (≤ `ROUTE_TIMEOUT_MS`) and `clearTimeout`.
6. **`/health` runs ~15 full scans across six queries** (`trades` 5×, `aum_chain_samples` 2×,
   `holdings_current` materialised 2×). Fix: indexes below, rewrite the per-chain block as
   laterals, and cache the body per isolate for 30 s.
   ```sql
   create index if not exists trades_handle_captured_idx on trades (handle, captured_at desc);
   drop index if exists trades_handle_idx;
   create index if not exists trades_captured_idx on trades (captured_at desc);
   create index if not exists aum_samples_sampled_idx on aum_samples (sampled_at desc) where basis = 'sampled';
   create index if not exists aum_chain_samples_net_at_idx on aum_chain_samples (network_id, at desc) where basis = 'sampled';
   ```
7. **`routes/scorecard.ts` `seen` joins `transactions` to `wallets` on an OR**, forcing a
   BitmapOr and a heap filter per row; `swapsFor` in `scorecard-core.ts` has the same shape.
   Fix: resolve the address keys in JS and pass `address_key = any($addrs)` as `/pnl` does;
   move `monthStartCapital` into the `Promise.all`.
8. **`/portfolio` evaluates `holdings_current` four to five times; `/positions` re-queries
   `asOf` it already has in hand.** Fix: fetch the rows once and derive in JS; `POST
   /traders/positions` re-queries `known` that `batchIds` already resolved.
9. **The sampler reads a trader's chains sequentially.** The per-host throttle makes
   `Promise.all` across chains safe; a 25-trader slice drops from ~100 s to ~30 s. Edit both
   twins and `scripts/load_aum_samples.mjs`, whose fixed `sleep(120)` the throttle makes redundant.
10. `routes/aum.ts` parses `r.at` 8–12 times per row and recomputes `score(best)` per
    iteration; ~1 ms once item 1 lands. Parse once into `atMs`.
11. `scorecard-core.ts`: `loadedAtIso` computed three times, `windowAgg` re-parses `closed_at`
    per window, `onChainFrom` recomputes entries/exits the route already built. 1–5 ms.
12. Scripts: `load_chain_balances.mjs` re-prices all history nightly (scope the trailing update
    to the run's `captured_at`); `load_token_supply.mjs` N single-row updates → one `unnest`
    update, and no per-host throttle against the hosts the sampler throttles.
13. `router.ts`: `decodeURIComponent` throws on a malformed `%` → 500; should be 400.

## Structural notes worth acting on

- `buildAum` (~660 lines) and `scorecardBody` (~850 lines) derive 20+ blocks each from one row
  set, typed `Record<string, unknown>`/`any` end to end. Extract per-block pure builders over a
  parsed `Sample { atMs, totalUsd, … }` type. `scorecardBody(t: any, rows: any[])` breaks the
  repo's own no-`any` rule.
- `/health` and `knownChainsFor` duplicate the `seen`/`ah`/`hist` CTEs with a comment promising
  they mirror each other: one SQL view (`trader_chain_history`) ends the drift risk.

## Leave alone

`db.ts` Proxy (~100 ns per call), `router.ts` linear scan, `config.ts`, `aum-rules.ts`,
`positions-core.ts`, `batch.ts`, the chain-read throttle and batching, the sampler's `pricesFor`
unnest, `holdings_current` for handle-filtered routes, the sequential-by-design `/health` awaits.
