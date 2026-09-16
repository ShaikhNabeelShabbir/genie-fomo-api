# API validation and error-handling flags (17 Sep 2026)

Found while generating `docs/openapi.yaml` from the route handlers on branch `cloudflare-migration`. Evidence is `file:line` under `supabase/functions/api/` unless stated. Severity: high = data loss or a wrong answer served as right; medium = a 500 where a 400 belongs, an unbounded read, or a contract the consumer cannot rely on; low = inconsistency.

Already fixed on the branch the same day: the published `error.code` vocabulary (`internal` → `internal_error`, plus `unavailable` and `include_unavailable`; vocabulary v8). Every bullet below that mentions it is kept for the record.


---

# Shared request pipeline

Scope: app.ts, router.ts, errors.ts, db.ts, config.ts, index.ts, shared/batch.ts,
shared/cursor.ts, shared/params.ts, worker/src/api.ts, worker/src/index.ts,
worker/src/webhook.ts (+ worker/src/helius.ts, supabase/functions/helius-webhook/index.ts
read for comparison). Route handler internals out of scope.

## Findings

- **high** — `worker/src/helius.ts:23-37` + `worker/src/webhook.ts:6-45`: no cap on the
  number of events/transfers a webhook delivery may contain before `insert()` builds one
  `sql.unsafe` multi-row INSERT with 11 bind params per row. Postgres's extended-protocol
  limit is 65535 params (~5,957 rows here). Bad input: a large Helius delivery (or a replay/
  backfill burst) pushes `rows.length` past that ceiling → `sql.unsafe` throws → caught only
  by the fire-and-forget `.catch((e) => console.error(...))` at `webhook.ts:73`, which just
  logs. The `{ok:true}` response was already sent at `webhook.ts:74` before the insert even
  ran, so Helius never retries — the whole batch's transfers are silently dropped, no error
  surfaced anywhere but a log line. Same shape exists uncapped in the legacy
  `supabase/functions/helius-webhook/index.ts:100-121`. Fix: chunk `rows` into batches under
  the param ceiling (e.g. 500 rows/insert) inside `insert()`, or reject/split events arrays
  above a stated max before processing.

- **medium** — `supabase/functions/api/shared/params.ts:5-22` (`intParam`): `max` is an
  optional field on `opts`, not defaulted, so a caller that omits it gets no upper bound at
  all — `Math.min` is only applied `opts.max !== undefined`. Three real call sites do exactly
  this: `routes/tokens.ts:137`, `routes/tokens.ts:869`, `routes/traders.ts:36` all call
  `intParam(url, "limit", { min: 1, fallback: null })` with no `max`. Bad input:
  `?limit=999999999` is accepted verbatim and handed to the query as-is (only the 14s
  `statement_timeout` in `db.ts` eventually saves the connection). Fix: give `intParam` a
  hard default ceiling (e.g. `max = opts.max ?? 1000`) so omitting `max` is safe by
  construction instead of relying on every call site to remember it.

- **medium** — `supabase/functions/api/index.ts:12-13` / `supabase/functions/api/app.ts:86,88`:
  `RATE_LIMIT_PER_MINUTE` and `ROUTE_TIMEOUT_MS` are read with `Number(cfg(...) ?? default)`
  and never validated. Bad input: a typo'd env value (e.g. `ROUTE_TIMEOUT_MS=15s` instead of
  `15000`) yields `NaN`. `setTimeout(fn, NaN)` is spec'd to clamp to 0, so **every** request
  would immediately lose the timeout race and return 503 `timeout` — a total, silent outage
  from one bad env var, with no startup check to catch it. `errors.ts:73`'s
  `maxPerWindow()` has the same pattern: `count > NaN` is always `false`, so a malformed
  `RATE_LIMIT_PER_MINUTE` silently disables the limiter instead of failing loudly. Fix:
  validate these once at cold start (`Number.isFinite` + positive) and throw/log fatally
  instead of deriving `NaN` per request.

- **medium** — `supabase/functions/api/shared/batch.ts:42`: `const wanted = ids.map(String);`
  performs no type check on array elements — numbers, booleans, `null`, objects and nested
  arrays are all silently coerced to strings (`String({})` → `"[object Object]"`,
  `String(null)` → `"null"`) instead of being rejected. Bad input: `{"ids":[1,2,null]}` is
  accepted as `{"1","2","null"}` and simply resolves as three unknown handles rather than
  400ing on the malformed request shape the docstring implies (`ids: [...]` of ids/handles).
  Fix: `if (ids.some((v) => typeof v !== "string")) throw badRequest(...)` before the
  `.map(String)`.

- **medium** — `supabase/functions/api/router.ts:45-47` (`rewriteVersion`): does a global
  regex replace of the literal text `/v1/` over the **entire serialized JSON body**, with no
  distinction between the self-links the function is meant to fix up
  (e.g. `routes/traders.ts:466-468` builds `` `/v1/traders/${t.display_handle}/pnl` ``) and
  arbitrary string data in the same payload. `display_handle`, token `name`/`symbol` etc. are
  free text with no format CHECK constraint in the migrations. Bad input: a trader handle or
  token name/symbol that happens to contain the substring `/v1/` gets corrupted into `/v2/`
  (or vice versa) for any caller requesting the other version — a data-integrity bug, not
  just a cosmetic one. Fix: build response links as structured values rewritten explicitly
  (or tag them, e.g. a `$link` wrapper) rather than a blind string-replace over the whole body.

- **low** — `supabase/functions/api/shared/batch.ts:9` (`BATCH_MAX = 50`) and
  `supabase/functions/api/app.ts:18` (`BATCH_MAX_COST = 50`) are two independently-defined
  magic constants that must be kept in sync by hand; `app.ts` never imports `BATCH_MAX` from
  `batch.ts`. Bumping one without the other silently changes cost accounting (`asked` would
  exceed `BATCH_MAX_COST` and get truncated in the `x-cost-units` header) without touching the
  actual refusal threshold. Fix: `import { BATCH_MAX } from "./shared/batch.ts"` and drop the
  duplicate constant.

- **low** — `supabase/functions/api/shared/batch.ts:35-40,112-126`: `batchIds` always returns
  `capped: false` (over-cap is a hard 400 refusal per D123, never a trim), yet
  `batchEnvelope` (lines 123-125) still carries a live `capped ? {note: "only the first ${BATCH_MAX} ids were read..."} : {}` branch. That branch is unreachable dead code that documents a
  trim-and-continue behavior the API no longer has — misleading to a future reader who might
  reasonably think oversized batches are silently truncated. Fix: delete the `capped` field/
  branch from `batchEnvelope` and `batchIds`'s return type, or leave a comment pointing at
  D123 explaining why it is always `false`.

- **low** — `worker/src/api.ts:33`: `ctx.waitUntil(sql.end({ timeout: 5 }));` has no
  `.catch`. Contrast `worker/src/webhook.ts:73`, which explicitly attaches `.catch(...)`
  because "the .catch is not optional." If `sql.end()` rejects (e.g. a connection that won't
  close inside the 5s timeout), it becomes an unhandled rejection inside `waitUntil` instead
  of a logged, contained failure. Fix: `ctx.waitUntil(sql.end({ timeout: 5 }).catch((e) =>
  console.error("sql.end:", e)));`.

- **low** — `supabase/functions/api/app.ts:98` (`req.headers.get("x-api-key") !== KEY`) and
  `worker/src/webhook.ts:58` (`req.headers.get("authorization") !== auth`, mirrored in
  `supabase/functions/helius-webhook/index.ts:31`): both compare secrets with `!==`, which
  short-circuits on the first mismatched byte rather than comparing in constant time. Low
  practical exploitability over a real network (jitter dominates), but both are
  attacker-facing secret checks. Fix: compare via a fixed-time helper (e.g. `crypto.subtle`
  HMAC-based comparison, or pad+XOR-accumulate) if these keys are ever treated as
  security-sensitive rather than fair-use gates.

- **low** — no application-level request body size limit anywhere in the shared pipeline:
  `supabase/functions/api/app.ts:140` (`body = await req.json()`) and
  `worker/src/webhook.ts:64` (`events = await req.json()`) both buffer and parse whatever the
  client sends with no `Content-Length` check first. Compounding this, individual batch id
  strings in `shared/batch.ts:42` have no per-element length cap either (only the array
  length is capped at 50), so `{"ids": ["A".repeat(50_000_000), ...]}` still passes that
  check. Fix: reject on `Content-Length` above a stated ceiling (e.g. 256KB) before calling
  `.json()`, in `app.ts`'s `handle()` and `webhook.ts`'s `webhook()`.

## Handled well (safe to state as pipeline guarantees)

- Cursor decode failures (`shared/cursor.ts:10-20`) always throw `badRequest` → 400, never a
  raw 500, whether the base64/JSON is malformed or just not an array; a cursor whose shape
  belongs to a different route fails to match any row in `resumeAfter` and also comes back as
  a clean 400, not corrupted data.
- `classify()` in `errors.ts:52-69` never leaks driver/SQL text to the client — every
  non-`ApiError` throw is logged server-side and answered with a fixed, stable
  `internal_error` sentence; pool-exhaustion and connectivity errors are separately
  classified into retryable 429/503s with `Retry-After`.
- The route timeout race (`app.ts:151-158,176-179`) always clears its timer in a `finally`,
  on every exit path (success, thrown error, or timeout loss), and the 14s Postgres
  `statement_timeout` (`db.ts:34`, `worker/src/db.ts:19`) is deliberately set just under the
  15s race so a timed-out query's connection is freed rather than held.
- The rate limiter and the auth gate both fail in a documented, single direction: the limiter
  fails open with `scope: "unlimited"` and a logged warning (`errors.ts:98-104`) rather than
  taking the whole API down when Postgres is unreachable, and missing vs. wrong API
  key/webhook secret return the identical 401 (no information leak about which case applied).
- Batch id handling (`shared/batch.ts`) refuses (400) rather than silently truncates once
  `ids.length > BATCH_MAX`, and that check runs before any DB round-trip; duplicate ids
  (including a handle and its id resolving to the same trader) are also refused rather than
  silently collapsed, and the length cap is enforced before the request is ever costed.
- The Helius webhook is idempotent by construction: `ON CONFLICT (network_id, tx_hash,
  address_key, transfer_key) DO UPDATE` (`worker/src/webhook.ts:31`, mirrored in the Deno
  function) means redelivery of the same event is a safe no-op, not a duplicate row.


---

# Traders, reference and health

All paths relative to `supabase/functions/api/`.

## POST /v1/traders/{handle}/wallets
- **[medium] TOCTOU on the clash check — no uniqueness constraint backs it.** `routes/traders.ts:557-568` selects other traders holding the address, then `:583-600` inserts. `supabase/migrations/20260904073000_wallets_one_row_per_trader.sql:22` gives `wallets` a primary key on `handle` only; there is no unique index on `evm_address_key` / `sol_address_key`. Two concurrent submissions of one address for two traders both pass the check and both land, so `address_in_use` is advisory, not enforced.
- **[medium] Secret compared with `!==`.** `routes/traders.ts:534` `String(b.secret ?? "") !== walletSubmitSecret()` is a short-circuit string compare (timing side channel); no `timingSafeEqual` anywhere in `supabase/functions/api/`. Also no rate-limit tightening for failed secrets beyond the global 240/min, so the secret is brute-forceable at 240 guesses/min per key/IP.
- **[low] Non-object JSON body is not rejected.** `app.ts:139-141` accepts any JSON value; `routes/traders.ts:533` casts `(body ?? {}) as Record<string, unknown>`. An array, number or string body silently reads as "no fields" and produces a 401 (`secret` undefined) instead of a 400 naming the shape.
- **[low] `sol_address_key` is lower-cased base58.** `routes/traders.ts:586` stores `sol.toLowerCase()` as the key. Base58 is case-sensitive, so two distinct Solana addresses can share a key; the clash check (`:564`) compares `sol_address` exactly, so the 409 path is correct but any lookup by `sol_address_key` elsewhere can conflate them.

## GET /v1/traders
- **[medium] `limit` has no maximum and defaults to "everything".** `routes/traders.ts:36` `intParam(url, "limit", { min: 1, fallback: null })` — `shared/params.ts:8-25` only applies `max` when given. With `?include=pnl,scorecard,wallets,trust` and no limit the route runs five set-based queries over the whole directory (docs cite 969 KB / 5.2 s at 137 traders; the directory is 448 now) inside the 15 s race. Intended for sync, but nothing caps a browsing client.
- **[low] `offset` has no maximum.** `routes/traders.ts:37`; harmless (slice past the end yields `[]`) but inconsistent with `limit` being validated.
- **[low] `updatedSince` bypasses the shared ISO parser.** `routes/traders.ts:61-68` uses bare `Date.parse`, which accepts non-ISO strings ("Sep 1 2026", "1/2/26" — engine-dependent), while `shared/params.ts:64-71` `parseIso` exists and is used by other routes. Docs promise "ISO-8601"; the check does not enforce it.

## GET /v1/traders/{handle}
- **[low] `?dailyTrades=true` is unbounded.** `routes/traders.ts:443-449` returns one row per active day for the wallet's lifetime; the code comment acknowledges it. No cap, no cursor.
- Otherwise none found: `resolveTrader` (`shared/traders.ts`) regex-guards the UUID cast; addresses come from the DB, not the caller.

## GET /v1/traders/{handle}/wallets
- **[low] `source` means two different things.** `shared/wallets-core.ts:54` sets `source` = wallet resolution source (`evm_source ?? sol_source`); `routes/traders.ts:683` then overrides it with the trader's directory source (`fomoapi.io` / `gmgn`). `entries[].included.wallets.source` in the bulk route keeps the first meaning, so the same key on the same block has two vocabularies depending on which route served it.
- Otherwise none found (addresses shape-checked before publishing, `:38-40`).

## GET /v1/traders/{handle}/trust
- none found. Ratios guard zero/absent denominators (`shared/trust-core.ts:43-46`); a missing holdings row is treated as zeros by design (`d183`).

## GET /v1/fields
- **[medium] The published closed `error.code` vocabulary does not match what the API emits.** `shared/vocabulary.ts:70-74` lists `internal` but `errors.ts:63` throws `internal_error`; `unavailable` (`errors.ts:29`) and `include_unavailable` (`errors.ts:35`) are emitted and not listed. A consumer that "fails the build on an unpublished word" (CLAUDE.md contract) will fail on three real codes. `tests/vocabulary_test.ts` only checks SQL constraints, so nothing catches this.
- No inputs; otherwise none found.

## GET /v1/chains
- **[low] Division without a zero guard.** `routes/chains.ts:74` `Number((traders / traderCount).toFixed(4))` — with an empty `traders` table this is `NaN`, which `JSON.stringify` serialises as `null`, so a computed-nonsense value is indistinguishable from "absent". Unreachable while holdings reference traders, but it is the null-vs-0 confusion the repo's own rule forbids.
- Otherwise none found (no inputs; `top`/`orphan` are nullable-guarded).

## GET /v1/health
- none found. All optional rows are `?.`-guarded; the cache is per-isolate and documented (`cached`, `cacheAgeSeconds`).

## GET /v1/creators/{address}
- **[low] `address` is not shape-checked.** `routes/tokens.ts:890-893` lower-cases whatever is in the path and queries on it (parameterised, so no injection). A garbage segment is answered 404 `not_found` rather than 400; the `chain` parameter is validated (`shared/chains.ts:7-11`) but the address is not.

## Shared pipeline (affects every route above)
- **[low] Success responses carry no `x-request-id`.** `app.ts:158` sets only `RateLimit-*` and `x-cost-units` on 200; only `fail` (`app.ts:66`) adds `x-request-id`. `docs/PARAMETER_ROUTES.md:3867` and the task brief describe the header as being on every response. A consumer cannot quote a request id for a *wrong* 200. The OpenAPI fragment follows the code (no `x-request-id` on 200).
- **[low] `classify` promotes any error whose message matches `/connection|terminated|shutdown|timeout/i` to a 503.** `errors.ts:55`. Not triggered by these routes today, but a future handler throwing `new Error("connection to X refused")` becomes a retryable 503 with a stale-copy hint rather than a 500.


---

# Portfolio, positions, scorecard, pnl

Scope: GET /v1/traders/{handle}/portfolio, /positions, POST /v1/traders/positions, GET /v1/traders/{handle}/scorecard, /pnl.
Paths are relative to /Users/gr00t/Documents/projects/genie-fomo-api/supabase/functions/api unless stated.

## POST /v1/traders/positions

- **[medium] Batch cost is reported, never charged.** `app.ts:96` bumps the rate window once per request (`checkRate`), and `app.ts:162` only computes `x-cost-units = min(asked, 50)` for the header. A 50-id batch costs the same rate budget as a single GET, so `BATCH_MAX_COST` bounds nothing in practice.
- **[medium] Legacy projection (`contractVersion: 1`) cannot distinguish an unknown id from a trader with no holdings.** `routes/positions.ts:491-497` iterates `handles` and emits `{ handle, positions: [], coverage: {of:0,total:0,share:null} }` for a handle that resolved to nothing; `handle` is the lower-cased raw input, not a directory value. v2 answers `ok:false` for the same case.
- **[medium] Null-vs-0 inconsistency on `amount`.** Single route `routes/positions.ts:244` emits `amount: n(r.human_amount) ?? 0`; the batch row `routes/positions.ts:407` emits `amount: n(r.human_amount)` (null). Same column, two answers; the single route turns "unknown balance" into "zero balance", against the repo's own rule.
- **[low] `ids[]` entries are not type- or shape-checked before SQL.** `shared/batch.ts:42` does `ids.map(String)`: numbers, objects (`"[object Object]"`), `null` (`"null"`) and empty strings are all accepted and sent to `handle = any(...)` / `lower(display_handle) = any(...)` (parameterised, so no injection; but no length cap per id and a 50 x multi-MB string body is passed straight through). A non-string entry should be a 400 naming the index.
- **[low] `contractVersion` accepted as any type.** `routes/positions.ts:365` uses `Number(...) !== 1`, so `"1"`, `1.0`, `true`-like values are silently interpreted; anything unparsable becomes v2 without a 400.
- **[low] `capped` / `note` in the envelope are dead.** `shared/batch.ts:9` refuses > 50 with a 400, so `capped` is always `false` and the `note` branch in `batchEnvelope` never fires; the docs (`docs/PARAMETER_ROUTES.md:3091`) also still say leaving `contractVersion` out returns the older shape, while the code defaults to v2 (`routes/positions.ts:365`).

## GET /v1/traders/{handle}/positions

- **[low] `limit` above 500 is silently clamped, not refused.** `routes/positions.ts:302` via `shared/params.ts:21` (`Math.min(v, opts.max)`). The applied value is echoed in the body, so it is visible, but it is the only bound on this route that does not 400.
- **[low] `includeQuote` only honours the literal string `false`.** `routes/positions.ts:299`; `0`, `FALSE`, `no` are ignored without a 400.

## GET /v1/traders/{handle}/scorecard

- **[low] `?tokens=` has no upper bound.** `routes/scorecard.ts:48` (`intParam` min 0, no max). Harmless today (it only slices an in-memory array) but the body size is otherwise unbounded: every `byToken[]` row carries up to 100 `buys` (`shared/scorecard-core.ts:716`), so a trader with many coins can exceed the 15 s route budget and 503 with `timeout` instead of a paged answer.
- **[low] 404 is overloaded.** A known trader with zero stored trades gets `not_found` ("no stored trades for ...") — the same code and status as an unknown handle. A consumer cannot tell "not a trader" from "trader, no record yet" without parsing `detail`.

## GET /v1/traders/{handle}/portfolio

- none found (the `token` query is trimmed/lower-cased and compared in memory, never interpolated; every null is explained).

## GET /v1/traders/{handle}/pnl

- none found.

## Shared (affects all five)

- **[medium] Published `error.code` vocabulary does not match what `errors.ts` emits.** `shared/vocabulary.ts:74` lists `internal`, but `errors.ts:68` emits `internal_error`; `errors.ts:31` (`unavailable`) and `errors.ts:37` (`include_unavailable`) are not in the list at all. The consumer's build fails on an unpublished word, and `/v1/fields` is the contract they generate from.


---

# Transactions, trades, events, flow, market

Paths are under `supabase/functions/api/`.

## GET /v1/traders/{handle}/trades

- **[high]** `since` / `until` are read raw (`routes/transactions.ts:199-200`) and cast in SQL as `${since}::timestamptz` (`routes/transactions.ts:239-240`) with no `isoParam`/`parseIso`. An unparseable value (`?since=yesterday`) is a Postgres cast error, which `errors.ts:classify` (line 60-63) turns into **500 `internal_error`**, not 400. Every other route in this set uses `isoParam` (`shared/params.ts:63-75`).
- **[medium]** `cursor` shape is not checked (`routes/transactions.ts:215-218`). `decodeCursor` only guarantees an array; `/transactions` (line 45) and `/events` (`routes/events.ts:33-36`) refuse a wrong-length/typed cursor with 400 "does not belong to this route", `/trades` does not. A 5-part `/transactions` cursor is silently accepted as `(at, hash)`; a cursor whose first element is not a timestamp (`[1,2]`, `[null]`) reaches `${curAt}::timestamptz` and becomes a 500. Docs (PARAMETER_ROUTES.md §0b) promise a 400 for a cross-route cursor.
- **[medium]** `chain` is not validated against the `chains` table (`routes/transactions.ts:198`, `238`). `/transactions` and `/events` go through `chainWhere` (400 "unknown chain"); `/trades` passes the string straight into `c.name = ${chainQ}`, so `?chain=sol` answers 200 with `count: 0`, `complete: true`, indistinguishable from "no trades on that chain".
- **[low]** `allSwaps` (`routes/transactions.ts:250-258`) loads the trader's entire swap record on every page request, unbounded by `limit` or `since`; only the 15 s route budget bounds it. Worst wallet today is 525 rows, so this is a ceiling, not a bug.

## GET /v1/traders/{handle}/transactions

- **[low]** `kind` is validated after the no-wallet early return (`routes/transactions.ts:25-33` returns before `36-39`), so `?kind=bogus` is 200 for a trader without wallets and 400 for one with. Inconsistent, not harmful.
- **[low]** `cursor` length is checked (line 45) but element types are not: `Number(after[2])` of a non-numeric part is `NaN`, which reaches `::bigint` (line 61) and answers 500 rather than 400.
- Error handling otherwise clean: `chainWhere` 400s, `intParam` bounds `limit` to 1..500, `moneyQ`/`storedQ` are lazy tagged templates (not unhandled promises), `null` is never coerced to 0 in `costUsd`/`stored`.

## GET /v1/events

- **[medium]** `since` has no lower bound and `cursor` does not bound the scan either (`routes/events.ts:71-76`, `123`). The 24 h default exists because `transactions` has no time-only index (comment at lines 86-89); `?since=2020-01-01` walks the whole union with a `limit` applied only at the end. Only the 15 s timeout bounds it.
- **[low]** Unknown `?handle=` is not a 404 (`routes/events.ts:81-82`): `resolveTrader` falls through to the lowercased string (`shared/traders.ts:30`) and the feed answers 200 with 0 events, indistinguishable from "no events for that trader".
- **[low]** `filters.chain` echoes the raw query value (`routes/events.ts:129`) while the filter applied is trimmed/lowercased (line 80); `filters.kind`/`filters.handle` echo the normalised form. Cosmetic inconsistency.
- Cursor decoding, `kind`, `limit`, `chain` are all validated with 400s; `totalUsd` is `round(n(...))`, never 0 for a refused reading. Clean.

## GET /v1/traders/{handle}/flow and POST /v1/traders/flow

- **[medium]** No `limit`, no paging, no lower bound on `since` (`routes/flow.ts:19-36`, `61-73`, `76-105`). One row per token moved since `since`; `?since=1970-01-01` returns every token the wallet ever touched, and the batch form multiplies that by up to 50 traders in one query. Only the 15 s timeout bounds it.
- **[low]** `asOf` is always `null` on the batch route (`routes/flow.ts:91`, `batchEnvelope(asked, capped, null)`), and the GET form has no `asOf` at all (`routes/flow.ts:66-71`). PARAMETER_ROUTES.md §0f says every route carries one; `max(last_at)` over the rows is already computed and could serve.
- Validation otherwise clean: `since` required and parsed via `isoParam`/`parseIso` (400), `batchIds` refuses empty/over-cap/duplicate ids with 400, unknown ids are per-entry `ok: false` not a whole-call failure. `in`/`out` default to 0 only for "no transfers in that direction", which is a real zero.

## GET /v1/market/regime

- none found. No inputs; the cache is a single entry with a 60 s TTL (`routes/market.ts:33-37`, bounded by construction); a failed query is not cached; all three shares return `null` on a zero denominator (`share`, line 27-28), never 0; `regimeFrom` is pure and tested.

## Cross-cutting (affects the error documentation of every route here)

- **[low]** `shared/vocabulary.ts:70-75` publishes `error.code` as `internal`, but `errors.ts:63` emits `internal_error`; `unavailable` (`errors.ts:29`) and `include_unavailable` (`errors.ts:35`) are emitted but unpublished. `tests/vocabulary_test.ts` only checks SQL constraints, so this does not fail the build. The YAML documents the words the code actually emits.


---

# AUM and tokens

Evidence is file:line on branch `cloudflare-migration`, 17 Sep 2026. Paths are relative to `supabase/functions/api/`.

## POST /v1/traders/aum
- **[medium] Body fields `window` and `chain` are accepted as any JSON type and `.trim()`ed unguarded.** `routes/aum.ts:1027` `(b?.window ?? "1w").trim()` and `:1049` `(b?.chain ?? "").trim()`: a number, object or `null`-free non-string throws `TypeError`, which `errors.ts:75` classifies as 500 `internal_error` instead of 400 `bad_request`. (`step` is guarded at `:1036` with `typeof === "string"`; `ids` entries are coerced with `String()` at `shared/batch.ts:41`.)
- **[low] `contractVersion` is not validated.** `routes/aum.ts:1063` `Number(b?.contractVersion) !== 1`: any value other than 1 (including `"v1"`, `true`, `3`) silently selects v2. A typo cannot be told from a deliberate v2 request.
- **[low] Legacy projection coerces an unknown trader to `count: 0` and `points: []`.** `routes/aum.ts:1118-1131`: with `contractVersion: 1` an id that did not resolve gets a row identical to a known trader with no data (`trackedSince: null, count: 0, now: null`), which is the null-vs-0 confusion the v2 shape was built to fix. Only v2 emits `ok: false`.

## GET /v1/traders/{handle}/aum
- **[low] `live` is not validated.** `routes/aum.ts:972-999`: only `true` and `false` mean anything; `live=yes` or `live=1` is silently treated as omitted, so the caller cannot tell a typo from the default path.
- **[low] Live-read timing config is unchecked.** `routes/aum.ts:928,930`: `Number(cfg("AUM_LIVE_AFTER_MINUTES"))` / `Number(cfg("AUM_LIVE_WAIT_MS"))` yield `NaN` on a misconfigured env, making `ageMs > NaN` always false (live read never triggers unless `live=true`) and `setTimeout(fn, NaN)` fire immediately (`waitedMs` reports `NaN`). Not a request-input gap, but a silent misconfiguration path.
- Live-read errors are swallowed **by design** (`routes/aum.ts:952-960`, logged, stored reading served): documented in `liveRead.state`, not a gap.
- Error handling otherwise: none found (window/step/chain all 400 with `parameter`; unknown trader 404).

## GET /v1/tokens
- **[medium] `limit` has no maximum and no default; the unpaged response is the whole board.** `routes/tokens.ts:137` `intParam(url, "limit", { min: 1, fallback: null })`, then `:144` `rows.slice(start)` when null. Every row carries `holderHandles[]`, so a bare `GET /v1/tokens` ships thousands of rows (`ranked` was 1,873 on the sample), and `limit=1000000` is accepted. `shared/params.ts:22` supports `max` but it is not passed here.
- **[low] Range filters are unbounded and uncross-checked.** `routes/tokens.ts:44-46` via `numParam` (`shared/params.ts:25-33`): negative values and `minValue > maxValue` are accepted and simply yield an empty board rather than a 400 naming the contradiction.
- **[low] `excludeHoneypots` accepts only the literal `true`.** `routes/tokens.ts:49`: `excludeHoneypots=1` or `=TRUE` is silently ignored, not refused.
- Sort, direction, chain and minHolders: none found (whitelisted at `shared/params.ts:36-58`, `shared/chains.ts:7-12`, `routes/tokens.ts:17`).

## GET /v1/tokens/{address}
- **[low] `address` is not shape-checked before the query.** `routes/tokens.ts:241` `address.toLowerCase()` goes straight into a parameterised `where h.token_key = ${key}` (no injection risk), so a malformed address costs a full holdings/token_info join and answers 404 rather than 400. Same at `:609` (activity).
- **[low] `holders_detail[].amount` coerces a missing amount to 0.** `routes/tokens.ts:590` `n(g.human_amount) ?? 0`: an unknown amount is indistinguishable from a zero holding, contrary to the repo's null-means-absent rule. (`valueUsd` on the same row correctly stays null.)
- **[low] The per-chain `chain` filter error carries no `parameter` extra.** `shared/chains.ts:10` `badRequest(\`unknown chain '${chain}'\`)` vs `resolveChain` at `:19-22` which adds `{ parameter: "chain" }` and lists valid names. Two different 400 bodies for the same mistake depending on the family.
- Otherwise none found: every third-party block is null-gated on its `fetched_at`; `top3`/`top10` are null under the count rather than a smaller-k answer.

## GET /v1/tokens/{address}/activity
- **[low] Aggregate PnL sums coerce null legs to 0.** `routes/tokens.ts:754-755` `round(per.reduce((s, r) => s + (n(r.realized) ?? 0), 0))`: a trader whose realized figure is unknown contributes 0 to the crowd total, and an empty `per` gives `0`, not `null`, while every sibling figure on the route (`winRate`, `everSold`, `crowdAvgEntryPrice.value`) is null in the same situation.
- **[low] The multi-chain refusal carries no `parameter` extra.** `routes/tokens.ts:620` `badRequest(\`'${address}' exists on N chains — pass ?chain= to pick one\`)` without `{ parameter: "chain" }`, so a client keyed on `error.parameter` cannot route it to the chain picker.
- Validation otherwise: none found (unknown chain 400, no holder 404, `everSold` null-vs-false kept apart).

## GET /v1/tokens/momentum
- **[medium] `limit` has no maximum and no default; unbounded response.** `routes/tokens.ts:869` `intParam(url, "limit", { min: 1, fallback: null })` then `entries: limit === null ? filtered : ...` at `:880`: the sample day had 1,171 moved rows, each with `gained[]`/`lost[]` handle arrays, all returned by default.
- **[low] Three full-table reads per call, uncached.** `routes/tokens.ts:822-832` load every `traders`, `chains` and `tokens` row into Maps on each request (`tokens` is ~5k rows), inside a route with a 15 s race. Not a validation gap, but the one place in this set where cost grows with the directory rather than with the answer.
- `direction` is validated before the data check (`:786-788`): none found there.

## Shared pipeline (affects all six)
- **[medium] Published error vocabulary disagrees with the codes the pipeline emits.** `shared/vocabulary.ts` `error.code` lists `internal` and `timeout`, but `errors.ts:75` emits `internal_error`, and `unavailable` (`errors.ts:28`) and `include_unavailable` (`errors.ts:33`) are not in the list at all. A consumer that builds against `/v1/fields` (the repo's stated contract) fails on a real 500 or 503.
- **[low] `x-cost-units` is derived from any response carrying a numeric `asked`.** `app.ts:160-163`: cost = `min(asked, 50)` whenever a handler's JSON has a top-level `asked` number. Correct for the batch route today, but a future route echoing an unrelated `asked` field would be billed as a batch. Not exploitable by callers.
- Auth, body parsing, timeout, rate limit: none found (`app.ts:98`, `:140-141`, `:152-157`; `errors.ts:96-121` fails open on a limiter outage but says so via `RateLimit-Scope: unlimited`).

Totals: 17 flags — 4 medium (3 route-level, 1 shared vocabulary), 13 low.
