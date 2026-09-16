# Overnight autonomous run (2026-09-17, started ~19:30 UTC)

Goal: finish every to-do that needs no user input; nothing deployed. Branch `cloudflare-migration`.

- [x] Wave 1 (5 agents, parallel, worktrees): P1 (#10), T1 (#11), A1/F2/F3 remainder (#12),
      R6 indexer coverage, R4 Robinhood prices (DexScreener) + refresh.yml reorder + rebuild twins.
      Merged with 2 small conflicts; 29 tests; pushed as 67ef909.
- [x] Merge wave 1; publish words in `shared/vocabulary.ts` (v4); update Field_Contracts.
- [x] Wave 2 (3 agents, parallel): typecheck baseline 90 → 0; `aum-sample` ported into the
      Worker (`worker/src/sampler.ts`, `/sample` + `scheduled`, shares chain_reads/value.ts);
      PARAMETER_ROUTES documented, `docs/consumer/reply-to-genie-17-sep.md` drafted, phase
      status updated. Pushed as 3840085.
- [x] Wave 3 (1 agent): api modules are runtime-agnostic (`db.ts` Proxy over an
      AsyncLocalStorage store, `config.ts` `cfg()`, `app.ts` handle, Deno entry `index.ts`);
      the Worker serves `/v1/*` from the SAME modules (`worker/src/api.ts`). Verified under
      workerd with a dead DB: 404 route list and 503 unavailable both correct. Pushed 0b3ac30.
- [x] Comment extractor re-run: nothing new to move (agents kept comments short).
- [x] Wave 4 (2 agents): T3 bounded (`scorecard.onChain` + `staleness.fallback`, vocabulary v5);
      read-only review found 5 bugs + 1 twin divergence, all confirmed and fixed by a 5th agent
      (price_suspect backfill also fixes chain rows and tier; `nothing_answered` instead of
      `wallet_unreadable` when nothing was asked; GET /positions total null/zero contract;
      known chains from answered rows only; dead `applyFloor` fields; MJS twin imports
      `decideTotal`).
- [x] Final: gate 0 errors, 32 tests, worker tsc clean, bundle 371 KB, node/py checks, loaders
      build; pushed 1e652b4 (78 commits ahead of main, 6 new migrations).

## Afternoon run (17 Sep 2026)

- [x] Workflow coverage (`docs/consumer/workflow-coverage-17-sep.md`) → gaps 1–5 built by 5 agents
      and merged: hourly price history + ATH, `/events`, launch metadata (pump.fun curve),
      `holdings_live` + `/flow`, dev ledger + linked wallets. Vocabulary v6. 42 tests.
- [x] Composite workflows coverage (`docs/consumer/composite-workflows-coverage-17-sep.md`).
- [x] Efficiency review (`docs/REVIEW_EFFICIENCY_17_SEP.md`).
- [x] Wave A (7 agents): A2 health scans + `trader_chain_history` view + 30 s cache; A3 `/portfolio`
      7→2 queries; A4 sampler chains in parallel + supply loader unnest/throttle; A5 scorecard join
      fixes + C1 per-coin multiples + C2 windows/bleeding + C5 exit-timing score; C4 `/market/regime`;
      C3 honeypot-since + cohort. Plus a fix: the nightly re-price pass now honours the ceilings.
      52 tests. Vocabulary v7.
- [x] A1: `aumFor` window-bounded (+2 d anchor slack, `trackedSince`/`newest` in SQL), `Promise.all` over
      the five independent reads, compact JSON, `statement_timeout` 14 s on both clients + `clearTimeout`,
      malformed `%` → 400, migration `20260917220000_perf_indexes.sql`. Merged; worker `tsc` needed one
      row-type annotation in `routes/positions.ts` (A3's query). 53 tests, gate 0, bundle 408 KB.
      Caveat: `statement_timeout` as a startup parameter may be refused by Supavisor's transaction
      pooler / Hyperdrive — run `scripts/smoke.sh` right after each deploy; if it fails, move it to a
      `set local` per query.

## Status for the morning (17 Sep 2026)

Everything that needed no input is done and pushed. Total: ~30 agents over 4 overnight waves, the workflow-gap wave and wave A.
Vocabulary is at **v7**; the consumer reply draft is `docs/consumer/reply-to-genie-17-sep.md`.

Waiting on you, in order:
1. Cloudflare token: add `Account › Workers Scripts › Edit`, then I deploy the Worker and set
   `CLOUDFLARE_DEPLOY=true` + `WORKER_URL`.
2. Database password (from the dev): `wrangler hyperdrive create … --caching-disabled`, paste the id
   into `worker/wrangler.toml` (uncomment the block), `wrangler secret put HELIUS_WEBHOOK_SECRET`,
   `AUM_SAMPLE_SECRET`, `HELIUS_SOLANA_KEY`, `WALLET_SUBMIT_SECRET`; redeploy; shadow diff.
3. Supabase: `supabase db push` (14 migrations dated 20260917), deploy `api` + `aum-sample`;
   re-sample `luckedhub`/`shahh`; run `scripts/acceptance_capture.sh` on main-vs-branch.
4. Send the reply draft to the Genie team (vocabulary v7 will fail their build until they add
   the words).
5. `.env.example` tail by hand.

Not done, deliberately: full T3 (EVM receipt resolution, `/trades` from the swap stream), L2
latency (needs measurements against a database), H1 rebuild-from-balance (declined).

Blocked on the user (not attempted): Cloudflare token `Workers Scripts: Edit`; database password
for Hyperdrive; Supabase deploy + `db push`; Genie-team notification (vocabulary v3+);
`.env.example`.

---

# Restructure for lower token cost — plan (2026-09-17)

Branch: `cloudflare-migration`. One commit per phase. Decisions from the user: install deno;
retire `src/` (keep only the modules the loaders need); push only, no deploy; move comment
blocks of 8+ lines.

## Phases

- [x] A. deno installed. Baseline `deno check` has 90 pre-existing errors (postgres.js row
      typing under TS 6), so the gate is "no new errors": `scripts/typecheck_gate.sh`.
- [x] B. Folders: `docs/`, `docs/consumer/`, `docs/data/`, `loaders/`; `src/` retired, the
      two loader modules live in `scripts/lib/ts` → `scripts/lib/dist`. Commit 4eeb905.
- [x] C. `routes.ts` → 9 route modules + 13 shared modules, mechanical, 3 dead
      declarations dropped; local run serves the route list. Commit 6372e41.
- [x] D. 197 comment blocks → `docs/DECISIONS.md` with numbered pointers. Commit 97fb376.
- [x] E. `shared/vocabulary.ts` + `tests/vocabulary_test.ts` (found and published two
      storable-but-unpublished words: `service_timeout`, `price_rejected`; version 2).
- [x] F. `shared/aum-rules.ts`, `aum-sample/value.ts`, 12 tests, `deno task test`.
- [x] G. `CLAUDE.md`.
- [x] H. README, dating notes on four docs; push.

## Not done here
- Deploy to Supabase and the acceptance diff: user runs
  `npx supabase functions deploy api --project-ref <ref> --no-verify-jwt`, then
  `./scripts/acceptance_capture.sh $BASE captures/after` and `diff -r captures/before captures/after`.

## Review (2026-09-17)

Measured on `supabase/functions/api`: 393 KB in one file → 22 modules totalling ~290 KB of
code, with 142 KB of rationale in `docs/DECISIONS.md`. Largest module now `routes/aum.ts`
at ~48 KB (was 393 KB to read anything). Verification on every commit: typecheck gate (no new
errors against the 90-error baseline), `deno task test` 12/12, and a local `deno run` that
serves the route list.

Not done, deliberately:
- **Not deployed.** User deploys with `npx supabase functions deploy api …`, then runs
  `scripts/acceptance_capture.sh` against production and diffs with `captures/cap1` from
  16 Sep (kept in the session scratchpad; re-capture from `main` if lost).
- **The 90 baseline type errors** are real (postgres.js rows typed `{}` under TS 6) and are a
  separate fix: annotate row types at each `sql<...>` call.
- **`/v1/fields` version 2** publishes two words consumers have not seen. Tell the Genie
  team before deploying; their build fails on an unpublished word by design.
- `.env.example` tail still needs `=` added by hand.

Lesson: the extractor's first pass produced 140-char anchors; numbered sections cost one
re-run and cut every pointer to ~30 chars. Check the smallest output sample before running
a scripted rewrite over 197 sites.
