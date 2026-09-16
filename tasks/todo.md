# Overnight autonomous run (2026-09-17, started ~19:30 UTC)

Goal: finish every to-do that needs no user input; nothing deployed. Branch `Junaid-deve-starts`.

- [ ] Wave 1 (5 agents, parallel, worktrees): P1 (#10), T1 (#11), A1/F2/F3 remainder (#12),
      R6 indexer coverage, R4 Robinhood prices + refresh.yml reorder + rebuild twins.
- [ ] Merge wave 1; publish words in `shared/vocabulary.ts` (v4); update Field_Contracts.
- [ ] Wave 2 (1 agent): clear the 90 baseline type errors (postgres.js row typing).
- [ ] Wave 3 (parallel): port `aum-sample` into the Worker (`/sample` + `scheduled`); thread a
      `Ctx { sql, env }` through the api modules so the Worker serves `/v1/*`; docs agent
      (PARAMETER_ROUTES, TO-DO tracker, DECISIONS pointers).
- [ ] Final: gate + tests + worker tsc + dry-run; push; status summary here.

Blocked on the user (not attempted): Cloudflare token `Workers Scripts: Edit`; database password
for Hyperdrive; Supabase deploy + `db push`; Genie-team notification (vocabulary v3+);
`.env.example`.

---

# Restructure for lower token cost — plan (2026-09-17)

Branch: `Junaid-deve-starts`. One commit per phase. Decisions from the user: install deno;
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
