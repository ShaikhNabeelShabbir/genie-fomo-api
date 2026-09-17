# Postgres → D1 schema map

`worker/d1/migrations/0001_schema.sql` and `0002_views.sql` are the SQLite twin of the FINAL
state of the 55 files under `supabase/migrations/` (applied in order; later `alter table` /
`create or replace view` win). Names of tables, columns, indexes and views are identical.
`tests/d1_schema_test.ts` holds the two files to the Postgres ones.

## Type map (every column follows it)

| Postgres | D1 | What a caller must know |
|---|---|---|
| `timestamptz` | `TEXT` `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC) | Compare and sort as strings; `now()` defaults are `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. Write with `Date#toISOString()`. |
| `date` | `TEXT` `YYYY-MM-DD` | `token_prices.day`, `trader_fees_daily.day`. |
| `numeric`, `double precision` | `REAL` | IEEE double: ~15-16 significant digits. Postgres `numeric` was exact; 18-decimal raw balances lose precision. Every money column keeps NULL = absent, never 0. |
| `bigint`, `int`, `integer` | `INTEGER` | 64-bit. |
| `boolean` | `INTEGER` 0/1, `check (col in (0,1))` | Nullable booleans stay nullable (NULL = not assessed). Bind `true`/`false` as 1/0; rows come back as 1/0, not booleans. |
| `jsonb`, `json` | `TEXT` (JSON document) | `JSON.stringify` in, `JSON.parse` out. `->` / `->>` become `json_extract`. |
| `uuid` | `TEXT` | No default; the Worker supplies `crypto.randomUUID()`. |
| `text[]` | `TEXT` (JSON array) | No column stores one today; function parameters (`p_handles text[]`) become TS arrays. |
| `generated always as (lower(x)) stored` | kept on `wallets`; replaced on `tokens` | See `tokens` below. |

## Tables

| Table | D1 changes beyond the type map |
|---|---|
| `chains` | `network_id INTEGER PRIMARY KEY` (rowid alias; explicit values as before). Seeded with the 5 chains (upsert). |
| `quote_assets` | Seeded with the final 18 rows: the 12 initial, USDG + WETH on Robinhood (20260909120000), the 4 zero-address native coins (20260917110000); `pegged_usd` = 1 folded in for USDC/USDT/USDG (was an `update` in 20260908130000). |
| `traders` | `verified`, `listed` → INTEGER 0/1. **`id TEXT NOT NULL` has no default** (was `gen_random_uuid()`): every insert must pass `crypto.randomUUID()`. Both unique indexes on `id` kept (`traders_id_idx`, `traders_id_uidx`). `traders_listed_idx` partial `where listed = 1`. |
| `wallets` | One row per trader (20260904073000 shape). `evm_address_key` / `sol_address_key` stay generated stored columns (allowed: not in the primary key). The initial row-per-wallet `wallets` and its `wallets_address_idx` / `chain_kind` check were dropped in Postgres and do not exist here. |
| `trader_stats` | none. |
| `tokens` | **`token_key` is a plain `TEXT NOT NULL` column** (SQLite forbids a generated column in a primary key); the writer must pass `lower(address)` and `check (token_key = lower(address))` enforces it. Seeds pass it explicitly. `graduated` → 0/1. `launchpad` / `curve_progress` checks kept. |
| `holdings` | `holdings_source_known` check kept; both foreign keys kept (`tokens` parent is its primary key). |
| `trades` | `trades_handle_idx` dropped (as in 20260917220000); the other four indexes kept. |
| `trade_loads` | `outcome` check is the final 6-word list. |
| `transactions` | Primary key `(network_id, tx_hash, address_key, transfer_key)`. `raw` → TEXT JSON. Index translations: `transactions_address_money_idx` and `transactions_timing_idx` used Postgres `include (...)`, which SQLite lacks, so the payload columns are trailing key columns (same covering effect, slightly larger index); `transactions_keyset_idx` drops `nulls last` because SQLite `DESC` already sorts NULL last; `concurrently` dropped (no-op). `transactions_type_idx` partial `where tx_type is not null` kept. |
| `transaction_fees`, `trader_fees_daily`, `position_timing`, `chain_coverage` | none. |
| `wallet_swaps` | `wallet_swaps_quote_source_check` kept verbatim. |
| `wallet_swaps_checked` | none. The one-off backfill from `wallet_swaps` (20260918070000) is not repeated: export the Postgres rows. |
| `token_prices`, `token_price_hourly`, `token_price_stats` | `day` → `YYYY-MM-DD` text; `hour` → ISO text. |
| `token_info` | 8 boolean security columns → 0/1 nullable; `raw`, `security_raw` → TEXT JSON. `token_info_honeypot_idx` partial `where is_honeypot = 1` (was `is true`). |
| `token_creators`, `creators`, `linked_wallets` | `linked_wallets.watch` → 0/1 default 1; `link_kind` check kept. |
| `aum_samples` | `refused_reason` check is the final 8-word list (`… 'no_tokens_known','nothing_answered'`), `basis` / `tier` checks kept verbatim. Partial index `aum_samples_sampled_idx … where basis = 'sampled'` kept. |
| `aum_chain_samples` | Composite foreign key to `aum_samples` with cascade kept; partial `aum_chain_samples_net_at_idx` kept. |
| `aum_history` | `reason` check is the final 4-word list (with `price_suspect`); `suspect_usd`, `unsellable_usd` present. `hour` is the bucket start as ISO text (`YYYY-MM-DDTHH:00:00.000Z`). |
| `aum_live` | `reason` (4 words) and `source` (4 words) checks kept verbatim; `suspect_usd`, `unsellable_usd` present. |
| `aum_live_dirty`, `builds` | none. |
| `rate_limits` | Table kept; the function is gone (below). |

Data-only migrations are not replayed (the exported Postgres rows already carry their effect):
display-handle de-collision and delisting of 4 traders (20260910160000, 20260916140000),
`price_suspect` re-classification (20260917100000), `wallet_swaps.quote_source` backfill and
`wallet_swaps_checked` seed (20260918070000), `transfer_key` backfill (20260904120000).

## Dropped objects (logic moves to TypeScript)

| Postgres object | Defined in | Where the logic goes |
|---|---|---|
| `bump_rate_limit(p_key, p_window_seconds)` (plpgsql) | `20260908090000_rate_limits.sql` | One `insert … on conflict (key) do update … returning count, window_start` statement in `supabase/functions/api/errors.ts`, with the window test and the 1 % prune (`delete … where window_start < now - 10 min`) done in TS around it. SQLite upsert supports `returning`. |
| `trade_qty(status, amount, pnl, entry, exit)` (SQL, immutable) | `20260908120000_trade_qty.sql` | Inline the `case` into the two queries in `routes/tokens.ts` (lines ~636 and ~675); the TS twin already exists in `shared/scorecard-core.ts` (`legQty`, ~line 555). |
| `run_aum_sample(slice)` + `cron.schedule('aum-sample-rotate')` + `pg_cron`, `pg_net`, `vault` | `20260916120000_aum_sample_schedule.sql`, unscheduled in `20260918000000_aum_sample_schedule_off.sql` | Retired; nothing to port. |
| `aum_history_build(p_handle, p_from, p_to)` (SQL) | `20260918010000` → `…040000` → `…060000` → **final body `20260918100000_valuation_v4_no_market.sql`** | `worker/src/jobs/aum_history.ts` (called at line ~50). Port as TS over D1 reads: the hour series (`generate_series`), reading-per-hour, capture-per-(hour, network), price ladder (peg → hourly ≤ 24 h → daily → token_info current hour), the value.ts classification (window sums per hour) and the upsert into `aum_history`. |
| `aum_live_refresh(p_handles, p_source, p_older_than)` (SQL) | `20260918030000` → `…060000` → **final body `20260918100000_valuation_v4_no_market.sql`** | `worker/src/jobs/aum_history.ts` (~line 96), `worker/src/jobs/aum_live_flush.ts` (~line 23), `worker/src/webhook.ts`. Same valuation as above over `holdings_live`, price ladder peg → `token_price_stats` → `token_prices` ≤ 7 days → `token_info`, upserting `aum_live` and the current hour of `aum_history`. |
| `pgcrypto` extension, `gen_random_uuid()` default on `traders.id` | `20260904140000_stable_ids_and_supply.sql` | `crypto.randomUUID()` in the directory loader. |
| `comment on …`, `enable row level security` | throughout | Dropped: comments live in this file and `docs/DECISIONS.md`; D1 has no RLS (the Worker is the only client). |
| `create index concurrently` | `20260910170000`, `20260912090000`, `20260912110000` | Plain `create index`. |

There is no `chain_coverage` function: `chain_coverage` is a table, kept as-is.

## Views (`0002_views.sql`)

All 12 views of the final Postgres state. Column names and order are unchanged; bucket
columns are ISO text `YYYY-MM-DDT00:00:00.000Z`.

| View | Postgres features it used | SQLite form |
|---|---|---|
| `latest_capture` | — | Same. |
| `holdings_current` | CTEs, `union all`, anti-join `not exists` | Same shape (SQLite views accept `with`). Chain wins, fomo fills gaps (20260910180000). |
| `trader_stats_current` | `distinct on (handle) … order by handle, captured_at desc` | `row_number() over (partition by handle order by captured_at desc) = 1`. |
| `wallet_chain_presence` | `count(*)::int`, `join … using (network_id)` | Cast dropped; explicit `on`. |
| `holdings_live` | `left join lateral (aggregate) on true`, `null::timestamptz` / `0::numeric` typed nulls, CTE `sol_read`, `not exists` | The lateral aggregate became three correlated scalar subqueries (`delta`, `last_transfer_at`, `transfers`) over the same predicate, guarded by `network_id = 1399811149` so EVM rows never run them; untyped `null` / `0` in the second `union all` branch. ponytail: three subqueries read the wallet's post-read transfers three times; fold into one join if `/flow` or `aum_live` refresh measures slow. |
| `trader_chain_history` | `sum(...)::int`, `using (network_id)` | Casts dropped; explicit `on`. |
| `aum_history_daily` / `_weekly` / `_monthly` | `date_trunc('day'/'week'/'month', hour, 'UTC')`, `(array_agg(total_usd order by hour desc) filter (where total_usd is not null))[1]`, `count(...)::int` | Bucket = `strftime('%Y-%m-%dT00:00:00.000Z', hour)`; week = `strftime(..., hour, '-6 days', 'weekday 1')` (Monday, verified: Mon → itself, Sun → 6 days back, Tue → 1 day back); month = `strftime('%Y-%m-01T00:00:00.000Z', hour)`. The close is `max(case when rn = 1 then total_usd end)` with `rn = row_number() over (partition by handle, bucket, total_usd is null order by hour desc)`, so the newest VALUED hour wins. `hours` / `valued_hours` plain `count`. |
| `token_price_daily` / `_weekly` / `_monthly` | `date_trunc(...) at time zone 'UTC'`, `(array_agg(usd order by hour asc))[1]`, `(array_agg(usd order by hour desc))[1]`, `count(*)::int` | Same bucket expressions; `open_usd` / `close_usd` from `row_number() … order by hour asc` / `desc` inside a subquery. |

## D1 notes for the porting agents

- Foreign keys are on in D1; insert parents first (`chains` → `tokens` → `holdings`, `traders` → everything keyed by `handle`, `aum_samples` → `aum_chain_samples`).
- `on conflict (…) do update set … = excluded.…` and `returning` work unchanged; `on conflict do nothing` too.
- `now()` → `strftime('%Y-%m-%dT%H:%M:%fZ','now')`; `now() - interval '7 days'` → `strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')`; `date_trunc('hour', t)` → `strftime('%Y-%m-%dT%H:00:00.000Z', t)`; `t::date` → `substr(t, 1, 10)`.
- `= any($1)` over an array → `in (?, ?, …)` or `in (select value from json_each(?))`.
- `filter (where p)` → `sum(case when p then x end)` / `count(case when p then 1 end)`; window `sum(...) filter (where …) over (partition by …)` → `sum(case when … then x end) over (partition by …)`.
- `lower()` in SQLite is ASCII-only, which is all an address key needs.
