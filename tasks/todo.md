# Trader-service outage, 19 Sep 2026 — todo for the fix session

Source: `/Users/gr00t/Downloads/TRADER_SERVICE_FIX_REQUESTS_v1.0_2026-09-18.md` (Roy Liu, app 0.2.361).
Investigated 19 Sep 06:58–09:15 UTC: a Worker tail while reproducing, then a 19-agent read-only sweep
(7 auditors, 7 adversarial verifiers, a completeness critic, 4 gap follow-ups: 25 findings confirmed,
19 corrected, 1 refuted). Previous todo: `tasks/archive/todo-v5-2026-09-17.md`.

**State when this was written (09:15 UTC):** the For You deck is STILL EMPTY. Two regressions were reverted
and deployed (`23e1e38`, Worker `e8a2de68`); everything below is open.

---

## 0. Read this first

**How to see the truth.** `cd worker && rtk proxy npx wrangler tail genie-copy-trading-api --format json`
(run it in the background; plain `npx wrangler tail` is buffered by the `rtk` wrapper and prints nothing).
The output is concatenated JSON objects: parse with `json.JSONDecoder().raw_decode` in a loop.

**Two traps that cost time in this investigation.**
- A handled 5xx is a *successful* Worker invocation: `outcome` reads `ok`. Count failures from `logs[]`
  (`unhandled:`, `database unavailable`, `database saturated`, `timeout this route`), never from `outcome`.
- zsh: never name a loop variable `path` (it is tied to `PATH`; every command then vanishes).

**The app's client deadline is ~12 s; our route ceiling is 15 s.** A page must answer in well under 12 s.

**Measured baseline after the hotfix (09:11–09:15 UTC):**

| request | before hotfix | after |
|---|---|---|
| `/traders?limit=100` | 6.6 s, sometimes 503 at 17 s | **1.1 s** |
| `/traders?include=wallets&limit=99` | 14.3 s | **3.6 s** |
| `/traders?include=wallets&limit=100` | 500 | **500** (RC-1, open) |
| `/traders?include=scorecard&limit=50` | 503 at 19 s | 200 in 5.2 s |
| `/traders?include=wallets,scorecard&limit=50`, 9 pages | 503 | 8×200 (6–15 s), 1×503 — every trader carries wallets + scorecard |
| `/health` | 17 s / timeouts | 14.5 s |
| `/tokens?limit=5` | 503 at 28 s | 200 in 13.9 s |
| flush cron `*/5` | 231 s, 382 s, 625 s + 2 isolate resets | **14 s** |
| server errors | hundreds per 10 min | ~8 per 530 requests, all binds/timeouts |

---

## 1. Root causes (verified) and who introduced them

### RC-1 — THE OUTAGE. Id lists bind one parameter per element; D1 allows 100  · pre-existing (`e12d303`, the D1 port)
`e12d303` rewrote Postgres `= any(${array})` (ONE bound array) into `in (${array})`, which the shim
(`worker/src/d1.ts:55-56,64-73`) expands to one `?` per element, and the guard (`d1.ts:53,92-95`) throws
above 100. Worker log, reproduced live:
```
d1sql: statement binds 101 parameters … select h.handle, h.chain, h.network_id, h.positions, h.history_state,
d1sql: statement binds 200 parameters … select tr.handle, tr.trade_id, tr.network_id, tr.token_address,
```
`limit=99` answers 200, `limit=100` answers 500. Never caught: `scripts/smoke.ts` uses `limit=1`,
`scripts/acceptance_capture.ts` uses `limit=10`. **The authoritative site list (union of all agents):**

| site | binds for a page of N |
|---|---|
| `shared/chains.ts:50` `knownChainsFor` (+ scalar at :46) | N+1 → 101 at the app's limit=100 |
| `shared/scorecard-core.ts:67` and `:71` `scorecardRows` (same array twice) | 2N → dies at 51 |
| `shared/scorecard-core.ts:164` / `:174` `swapsFor` (handles, then distinct addresses) | N / ~1.33N (590 addresses over 445 wallets) |
| `shared/scorecard-core.ts:100` `feesFor`, `:433` `monthStartCapital` | N (on the cap at 100) |
| `shared/pnl-core.ts:26` `pnlAgg`, `shared/wallets-core.ts:12` `walletRows`, `shared/trust-core.ts:13` `trustHoldings` | N |
| `routes/transactions.ts:316` fee hashes on `/trades` | limit+1 → **101 at the DEFAULT limit**; 119–501 seen live |
| `routes/tokens.ts:732` `/tokens/:address/activity` (every trader who ever traded the coin) | data-sized; 169 and 163 seen live |

Also: `limit` has NO maximum on `routes/traders.ts:36`, `routes/tokens.ts:154` and `:934`
(`intParam(url,"limit",{min:1,fallback:null})`), and the default is the whole directory (448 → `binds 448`).
Batch routes are SAFE (`BATCH_MAX = 50`, worst statement 54 binds; ceiling is 96 — say so at `shared/batch.ts:9`).

### RC-2 — every `/portfolio` call failed for two days  · MINE (`b9baeca`) · **FIXED `23e1e38`**
`ladderColumns()` (`routes/positions.ts:41-49`) selects `ps.last_usd`; `/portfolio` never joined
`token_price_stats ps`. The join contract lived in a doc comment. D1: `no such column: ps.last_usd`, served as
503 "retry shortly" (RC-5). 99 of the first 102 server errors in the tail. I verified `/positions` live on
17 Sep and never `/portfolio`; the acceptance capture hits it and I did not run the capture.

### RC-3 — the 5-minute flush overran its cadence and crashed D1's isolate  · MINE (`4285202`, `57b5693`, `c628159`) · **MITIGATED `23e1e38`**
The 60-trader top-up made `*/5` run 231 / 382 / 625 s; twice in 40 min a run died with
`D1 DB's isolate exceeded its memory limit and was reset` (stack: `loadFacts ← revalue ← refreshAumLive`),
after which D1 refuses every statement for ~1 minute (236 refusals in two bursts, median 14 ms each).
"0.1 s a trader" measured only the balance read; `loadFacts` (`worker/src/jobs/valuation.ts:139-190`) runs 5
serial statements per 80 token keys. Mitigation: `TOP_UP_PER_RUN = 0`, 60 s deadline, slices of 5. **A2's
"every trader hourly" is knowingly given up** — `oldestLiveHours` will rise; the v5 reply's A2 claim is now false.

### RC-4 — routes are 100% D1-wait and sit on the timeout  · pre-existing, made 3–4× worse by RC-3
cpuTime median 2–7 ms against wallTime 4.5–18 s. After the hotfix the list with both includes still takes
~10 s per 50 traders, so **a bind-only fix turns the app's 500 into a 503**. Contributors, all verified:
- `scorecardRows`' `co` sub-select recounts distinct holders over `trades` per call (`scorecard-core.ts:64-69`).
- `include=scorecard` issues 8 statements, 4 of them serial (`routes/traders.ts:169-175`, then `:200`, `:203`, `:253`).
- `checkRate` is a D1 WRITE on every request, awaited BEFORE the 15 s race arms (`app.ts:96` vs `:157`);
  25 s responses observed. The table has 2 rows.
- A route that loses the race does not cancel its D1 work; `/positions` ran to 54 s after its 503.
- `/positions` (both routes) materialise the whole `token_price_hourly` window twice per call: +144k rows read,
  fixed cost (`routes/positions.ts:282-286`, `:493-497`).
- `asOfHoldings()` with no handle reads 953k rows (`shared/asof.ts:13`), on `/tokens/:address`, `/chains`, `/trust`.
- `/trades` reads the trader's entire swap history on every call (`routes/transactions.ts:250-256`).
- `GET /tokens` aggregates all of `holdings_current` before `limit` applies (known; was promised for 24 Sep).

### RC-5 — the API lies about what failed  · pre-existing (`b362849`)
`classify()` (`api/errors.ts:52-70`): (a) rung 3 matches a bare `D1_ERROR`, and D1 prefixes EVERY SQLite error
with it, so our own broken SQL is served as 503 "the database is not answering — retry shortly";
(b) rung 2 matches `overloaded`/`too many`, so a genuine D1 overload is served as **429 rate_limited** — 236 of
them, shipped with `RateLimit-Remaining: 240` because the limiter had already failed open (`app.ts:178-181`);
(c) the bind guard is a bare 500 with no hint that `limit` is the lever.
**The consumer's ask "503, never 500" rests on a wrong premise** — both their failures were our SQL. Correct rule:
database unreachable/overloaded/reset/timeout → 503 + `retryAfterSeconds`; our SQL or code → 500, logged loudly.

### RC-6 — `/health` cannot see an outage  · pre-existing
`status: "ok"` is a literal (`routes/health.ts:17`); no liveness probe; six serial statements, the first reading
2.78M rows (the comment at `:29` says four); the 30 s cache fills only after a full success, per isolate, no
in-flight dedupe. It now times out itself. The `tokenInfo` feed is graded `current` for **14 days**
(`health.ts:195`), which is why the GMGN freeze never showed.

### RC-7 — GMGN coin details: the Worker has NEVER written a `token_info` row  · pre-existing (`a0631d0` + a never-run path)
`max(fetched_at)` = 2026-09-16T12:00Z, before the D1 cut-over. Every one of the 14,942 rows was imported.
`a0631d0` deleted the nightly `scripts/load_token_info.mjs`; its replacement (`runTokens` phase 3,
`worker/src/jobs/tokens.ts:302-353`, `storeInfo` `:273-298`) has zero successful executions. Verified facts:
queue = 31,486 held tokens (18,965 never fetched AHEAD of 12,521 stale, NULL-first at `:320`); ~92 tokens/run →
~1,100/day → ~17 days to reach an existing row; a non-rate-limit GMGN error is never logged (`:231-240`, the
`attempt === 2` branch is unreachable); the all-failed guard sums three phases so phase 3 failing 100% is green
(`:373-377`); `infoRefreshed: 0, stoppedEarly: true` has been printed every run and nobody reads it.
**NOT established: why GMGN returns nothing.** "Rate-limited key" is one of two indistinguishable candidates
(the freeze predates the only observed `RATE_LIMIT` by 38 h). Robinhood coins DO reach GMGN (1,968 rows).

### RC-8 — hourly pricing collapsed on 17 Sep 12:00 UTC  · pre-existing, unexplained
DexScreener answers **HTTP 429 to 1,027 of 1,052 batches**; 163 of 31,499 tokens priced in the 07:17 run.
Tokens priced per hour: 4,545 at 11:00 → 702 at 12:00 → a few hundred since. This predates every change of
17 Sep afternoon. Every valuation has been degrading for two days. Not in the consumer's report.

### RC-9 — Helius answers 429 to everything  · cause unproven; `walkBack` (MINE, `48b7a5b`) is the suspect
Both balances runs in the window: `all 25 chain reads failed` (50× `solana: HTTP 429`), 390 s each. Swaps: 30
batches `Helius parse HTTP 429`, and that cron still reports `ok`. `walkBack` added a second 5-page pull per
Solana wallet per hour (114 of 186 wallets still walking; `transactions` +21% in two days). Enhanced-transaction
calls are credit-metered. Knock-on: the newest chain capture is 2026-09-18T04:33Z, so every `asOf` the API
stamps is a day old. Also: `balances.ts:348-350` marks 25 traders dirty per run even when every read failed,
and `markIfSolana` (`transfers.ts:138`) marks on rows the head pull merely re-read.

### RC-10 — nothing can be looked up  · pre-existing
The `requestId` is minted AFTER the error is logged (`app.ts:54` vs `:173`), so it appears in no log line: the
consumer's ask 1.1 ("look up req_…") is impossible. The one error log drops the query string, which is the only
thing that decided 200 vs 500. SQL errors carry no statement text (`d1.ts:146,167`).

### Cleared — do not re-investigate
Batch routes' binds · the scorecards loader (last success 2026-09-18T12:01:45Z, 79 traders; next wave 21 Sep 12:00
by design) · `includeUnavailable` at offsets 0–400 · the heal (converged to 0 rows) · rate limiting by the app
(~83 req/min vs 240) · the `tokens.ts:303-320` target query as a *crash* cause (runs in 2.0 s) · vocabulary 12 is
purely additive · `capturedAt` is the daily 01:00 build stamp, NOT a cached copy — the plain list is a live query.

---

## 2. P0 — bring the deck back. ONE deploy; do not ask the app team to re-test after a bind-only deploy.

- [x] **P0.1 Bind every id list as ONE parameter with `json_each`.** Rewrite each site in the RC-1 table from
      `in (${arr})` to `in (select value from json_each(${arr}))`. Reuse, do not invent: the idiom already ships
      at `routes/token-prices.ts:69-92` and `routes/aum.ts:823-825,834-836,895-898`; an array that does not
      directly follow `in (`/`= any(` is JSON-stringified into one bind (`d1.ts:64-70`). **Plan-checked on the
      real `scorecardRows` statement against remote D1: every index seek is preserved** (only
      `SCAN json_each VIRTUAL TABLE` is added). It also removes the `in ()` syntax-error trap on empty lists
      (`d1.ts:81-83`; four fragment builders have no guard). Do NOT chunk: chunking adds round trips, which RC-4
      cannot afford. `tokens.ts:648` holds a twin CTE of `:732` — check it.
- [x] **P0.2 Cap `limit`** on `traders.ts:36`, `tokens.ts:154`, `tokens.ts:934` (suggest `max: 200`; keep the
      plain list's default). Decide and document; the app uses 100.
- [x] **P0.3 Get `include=wallets,scorecard&limit=100` under ~8 s.** Measure first (per-statement
      `meta.duration` / `rows_read` for 100 handles), then cut: (a) replace `co` with one handle-independent
      `select network_id, token_key, count(distinct handle) from trades group by 1,2` (78k rows; cacheable per
      isolate with `shared/cache.ts` `ttlCache`); (b) issue the include statements in ONE `db.batch` — the shim
      coalesces un-awaited statements inside `sql.begin` (`d1.ts:129-162`, as `jobs/prices.ts` does for writes);
      confirm it returns per-statement rows for reads; (c) fold `knownChainsFor`/`feesFor`/`monthStartCapital`
      into that batch instead of three serial awaits.
- [x] **P0.4 Move `checkRate` inside the timeout race**, or give it its own 2 s deadline and fail open
      (the fail-open path exists at `errors.ts:116-123`). Today total latency is unbounded.
- [x] **P0.5 Verify exactly as the consumer will** (their block, §6), three runs a few minutes apart, starting
      ON a `:00/:05` flush tick, asserting payload not just status: every entry carries wallets with a family
      and a scorecard. Then tail for 10 minutes: zero `d1sql:` lines.

## 3. P1 — stop it recurring

- [x] **P1.1 A route-SQL test harness.** `tests/valuation_test.ts:13-35` already runs the real migrations in
      `node:sqlite` through the real shim — reuse it for `supabase/functions/api/routes/*`. Minimum: every route
      executes once against the schema (this alone would have caught RC-2), and the list/`/trades`/`activity`
      routes run at their MAXIMUM page size (catches RC-1). Note the harness loads only `0001`/`0002`; add
      `0003`–`0005`.
- [ ] **P1.2 A lint test:** fail on any `in (${` under `supabase/functions/api/` without an allow-list comment
      stating its bound. Cheap, and it makes RC-1 unrepeatable.
- [x] **P1.3 `acceptance_capture.ts` / `smoke.ts`:** add `/traders?include=wallets,scorecard&limit=<max>`,
      `/trades?limit=<max>`, a batch at `BATCH_MAX`. Run the capture after ANY route SQL change (not just smoke).
- [x] **P1.4 Classification (RC-5):** SQLITE_ERROR / `no such column|table` / `syntax error` / `d1sql:` /
      TypeError → 500, logged with statement text; D1 overloaded/reset/`exceeded`/timeout/network → 503 +
      `retryAfterSeconds`; NEVER 429 for a server-side fault. Fix the contradictory headers at `app.ts:178-181`.
      Tell the consumer why "never 500" is the wrong rule (§5).
- [x] **P1.5 `/health` (RC-6):** a cheap probe (`select 1` with its own ~1 s deadline) decides `status` and a
      new `database` block; heavy stats served stale-while-revalidate so it answers < 1 s even when they fail;
      in-flight dedupe; drop `tokenInfo` from 14 days to ~2; add a `prices` feed (RC-8) and a `balances`
      freshness line (RC-9). Update the stale "FOUR SEQUENTIAL AWAITS" comment and `docs/DECISIONS.md#d064`.
- [x] **P1.6 Observability (RC-10):** mint `requestId` first and put it in every log line and an
      `x-request-id` header on success too; log `url.search`; have the shim attach the first ~200 chars of SQL
      to any D1 error.
- [ ] **P1.7 Per-cron budgets.** `index.ts:96` hands every cron 600 s, including the 5-minute one. Make the
      budget a property of each `JOBS` entry, below its period. Abort a job after N consecutive upstream 429s
      (balances burned 390 s producing nothing).
- [ ] **P1.8 Re-enable live freshness properly (A2).** Batch `loadFacts` (5 serial statements per chunk → one
      `db.batch`); replace its `row_number()` window over `token_price_hourly` with a correlated
      `order by hour desc limit 1` (the memory suspect); mark dirty only for rows that were NEW
      (`transfers.ts:138`, and drop the pointless mark in `walkBack` `:155`); stop `balances.ts:348` marking
      traders whose read failed. Only then raise `TOP_UP_PER_RUN` — with a budget, and while watching API p90,
      not just `liveStale`.
- [x] **P1.9 Cheap latency wins (RC-4):** correlated liquidity lookup instead of the materialised window in
      both `/positions` queries; 60 s cache on the no-handle `asOfHoldings()` and pass the handle where one is in
      hand; bound `/trades`' pairing read; reuse `batchIds`' map in `POST /traders/aum` (`aum.ts:1041`, delete the
      two redundant directory reads at `:750`, `:1081`).

## 4. P2 — data freshness (each needs a first observation before any code)

- [x] **P2.1 GMGN (request 3).** FIRST make the failure visible: log the HTTP status/body on every non-success
      in `tokens.ts:231-240`, and make the guard per-phase. Tail one tick (`5 */2 * * *`) and read it:
      `returned nothing` = provider side, `store failed` = ours. THEN: refresh held-and-recently-viewed tokens
      first instead of NULL-first; stop re-queuing tokens GMGN cannot resolve (record the miss); size the budget
      honestly — at ~1,100/day "nightly" is unreachable for 31k tokens, so either prioritise the coins traders
      hold most (a few thousand) or correct the promise in `docs/openapi.yaml:7754,8927,10082`.
- [x] **P2.2 DexScreener 429 (RC-8).** Find what changed at 17 Sep 12:00 UTC (`git log` around `prices.ts`,
      the throttle in `_shared/dexscreener.ts`; are the five chains each running their own throttle?). Workers
      share egress IPs, so a per-IP limit may be unwinnable — pace far lower, honour `Retry-After`, stop after N
      consecutive 429s, and consider pricing only tokens that back a material position.
- [x] **P2.3 Helius 429 (RC-9).** Owner checks the plan's credits first (§7). In code: make the head pull
      incremental (stop at the newest stored signature — Helius takes `until=`) so it costs ~1 call per wallet
      per hour instead of 5; pace `walkBack` to a credit budget or pause it; make swaps report partial failure
      instead of `ok`.

## 5. P3 — housekeeping and the reply

- [x] Delete `healClockBuiltHours` and its call (`worker/src/jobs/aum_history.ts`) — converged to 0 rows.
- [x] Cache ONLY the no-include branch of `/traders` with `ttlCache` (consumer ask 4.2: "keep it serving while
      the database is down") — the app's cold-start fallback currently rests on a false premise (see Cleared).
- [ ] `loadAttemptedAt`/`loadOutcome` are NULL for ~345 of 453 traders (the table began at the cut-over and only
      fomoapi traders are targeted) — document null-means-no-attempt-since-17-Sep, or fall back to `loadedAt`.
- [x] Stagger `15 2 * * *` (gmgn) away from `15,45` swaps and the `*/5` tick.
- [x] **Reply to Roy** (`docs/consumer/reply-to-trader-service-v1.md`), same format as v5, after P0 verifies:
      - Requests 1 and 2 were ONE cause and it was ours, not the database: a 100-parameter SQL ceiling their
        page size of 100 crosses by one. Their "500/503 alternating → the connection" inference was reasonable
        and wrong; say so kindly, and explain why "never 500" is the wrong rule.
      - Ask 1.1 cannot be done (request ids were never logged) — and that it is being fixed.
      - Ask 2.2: last successful scorecard load 2026-09-18T12:01:45Z, 79 traders; loader healthy.
      - **Correct the v5 reply:** A2 ("every trader hourly") is withdrawn; `/portfolio` was broken by our v5
        deploy for two days; a 429 from this service meant OUR database was saturated, not their quota.
      - `capturedAt` is the daily build's stamp, not a snapshot — their fallback plan (their change 2) needs to
        know the plain list is a live query.
      - Suggest their client deadline and our ceiling be reconciled (12 s vs 15 s).
      - Request 3 honestly: what the measured throughput can and cannot promise.

## 6. Verification (the consumer's block — run it three times, a few minutes apart)

```
B=https://genie-copy-trading-api.agent-73b.workers.dev/v2 ; UA='User-Agent: genie-fomo-api/1.0'
for o in 0 100 200 300 400; do curl -s -o /dev/null -w "$o %{http_code} %{time_total}\n" -H "$UA" "$B/traders?include=wallets,scorecard&limit=100&offset=$o"; done
curl -s -o /dev/null -w "%{http_code}\n" -H "$UA" "$B/traders?include=scorecard&limit=100&offset=0"
curl -s -H "$UA" "$B/tokens/Lyi47medADEVDd5hxJo1mbxhnBct841sFpcGRyHTuwp" | grep -o '"fetchedAt":"[^"]*"' | head -1
curl -s -w "\n%{time_total}s\n" -H "$UA" "$B/health"
```
Pass = every page 200 **in under 10 s**, each trader carrying wallets + scorecard; then `deno task check`,
`deno task test`, `npx tsc -p worker/tsconfig.json`, `deno task capture` diffed against a pre-change capture,
and a 10-minute tail with zero `d1sql:` / `no such` lines and the `*/5` cron under 60 s.

## 7. Needs the owner (cannot be done from the repo)

- **Helius dashboard:** are credits exhausted / is the key rate-limited? This decides P2.3.
- **GMGN:** is the key still valid? It was public in this repo until 17 Sep (`0b4e0a4`); rotate it regardless.
- Still open from before: make the repo private (owner-only), rotate the other provider keys and the DB
  password, set a `JOB_SECRET` you hold — there is currently no way to run any job on demand.
- Decide the `limit` cap (P0.2) and whether to tell the app team to page at 25–50 as a stopgap until P0 ships
  (at `limit=50` today: 8 of 9 pages answer, in 6–15 s, against their 12 s deadline — not reliable).

---

## 8. Review — what the 19 Sep fix session did (written 19 Sep 2026, 13:30 UTC)

**State:** production healthy. The app team's verification block passed three times a few minutes apart
(15/15 roster pages 200 in 4.0–5.8 s, wallets on every trader; scorecard page 200 in ~4 s; `/health` 200 in
0.9 s with the database probe). A 12-minute tail: 1,068 of 1,075 requests answered, 0 D1 resets (before: 18%
failing, 132 reset lines in 5 minutes). CI/CD verified on three pushes: verify + deploy + a post-deploy smoke
that now really runs. Reply: `docs/consumer/reply-to-trader-service-v1.md`.

**How it was done:** four workflows — a pre-deploy adversarial review, five route-family fixers, a six-lens
read-only audit (82 findings, 25 of 26 serious ones checked by a skeptic: 6 confirmed, 18 corrected, 1 refuted)
and six audit-fix owners; every fixer's work was adversarially reviewed and repaired before merge. 348 tests
(254 at the start of the day).

**What actually broke production today, in order of cost** (all named by the shim's new `d1 slow:` log within
two minutes of its first deploy — nothing else found them):
1. `/positions` read ~550,000 rows / 1.8 s per call through `holdings_live`'s `sol_read` CTE -> migration 0007.
2. `/aum` read 2.3–2.5 M rows per call: D1 chose a join order local SQLite does not -> `cross join` pins it.
3. The swaps cron read 1.7 M rows per chain, up to 19.6 s, at :15 and :45 -> windowed candidates + a lap.
4. My own 10:33 deploy (always-`json_each`) stopped filter push-down into aggregate views -> `compileToFit`.
5. `/traders/:h/wallets` and the profile read three tables whole through `trader_chain_history`.

**Found at 14:05-14:17 UTC, the first runs with refusals logged in the source's own words:**
- **GMGN answers HTTP 429 to the Worker** on the first read of a run. Its limit is 1 req/s PER IP and a Worker
  shares egress IPs with other tenants. This — not only our queue — is why `token_info` has not moved since the
  old loader (own runner IP) last ran. Request 3 is NOT done. Fix: read GMGN from an address of our own (a small
  VM or a scheduled runner writing to D1 through the Cloudflare API), or a key-bound allowance from GMGN.
- **DexScreener answers Cloudflare 1015 "you are being rate limited", `retry-after: 24-46`**, for the same
  reason. Last hour priced: 11:00 UTC. With the 24 h price age limit a day of refusals nulls every position value:
  `staleFeeds: prices` is the alarm. The job now waits as long as it is told, up to 8 times a run.
- Swaps: the time-windowed scan (a86c9bd) did NOT work (24.6 s at 13:45: nearly every transfer is a few weeks old,
  so a 14-day window is the table). Rowid ranges + a lap (2ff8ae5) did: 14:15 ran in 2 s, worst statement
  50,001 rows / 1.2 s.
- Tail 14:03-14:22: 1,846 of 1,852 requests ok, 0 resets. API statements still queue 1.5-4 s behind job
  statements: THREE jobs each group all of `holdings_current` per run (tokens 6.6 s / 1.6 M rows, prices 5.9 s /
  1.46 M, health 2.6 s / 1.98 M), fees `pending` 3.6-3.8 s, the `/tokens` board 4.4 s cold.

**Still open, ranked:**
- [ ] **Move the GMGN and DexScreener readers off shared Worker egress** (see above) — the only thing that closes
      request 3 and keeps prices alive. Setting a `JOB_SECRET` first would let `POST /jobs/prices` be run on demand
      to measure what DexScreener's limit really allows.
- [ ] One `held_tokens` table (network, token, holders), maintained by the balances job, read by tokens, prices and
      the health snapshot instead of three whole-`holdings_current` group-bys a run.
- [ ] **Owner:** Helius dashboard — are the key's credits spent? Balance reads and swap parsing still answer 429.
- [ ] **Owner:** pause the Supabase project (dashboard; reversible 90 days), delete after a quiet week.
- [ ] **Owner:** rotate the GMGN key that is in git history; make the repo private; set a `JOB_SECRET`.
- [ ] `holdings` grows ~107k rows a day and nothing prunes it. The safe rule (fomo generations older than the
      newest; chain generations only under an owner decision "hours older than N days are final") is written up
      in the balances owner's proposal — needs the decision before any delete.
- [ ] `holdings_current`'s first branch needs `+h.source` so the not-exists probe in `holdings_live` seeks by
      token (valuation owner's F1(b) proposal): one view migration, both views recreated.
- [ ] Roster page: 4–6 s, ships ~30,000 trade rows per page. Safe first win: skip the `co_holders` recount when
      `tokens: 0` (patch and proof in the routes owner's proposal). The real fix is aggregating in SQL.
- [ ] GMGN capacity is ~1,100 coins/day against 31,522 held. A cron of its own (every 30 min) would give ~9,000.
- [ ] Two small partial indexes clear `/market/regime`'s two whole reads (`trades.closed_at`, `tokens(network_id,
      created_at)`) — build cost on D1 to be weighed first.
- [ ] Hours the live flush wrote on the live ladder since 17 Sep are not rewritten (needs `JOB_SECRET` for the
      on-demand rebuild, or a one-off heal like V1d's).
- [ ] `positions.liveBasis.evm` still answers `nightly_read`; `rolling_read` is published (v14) — switch in v15.
- [x] Observed 14:05-14:17: swaps no stall; fees ok (Robinhood answers on Bitquery `realtime`: 1,000 receipts);
      GMGN and DexScreener refused by IP (above). Still to observe: quote_prices :50 (Kraken).

