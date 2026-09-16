# Restructure for lower token cost — plan (2026-09-17)

Branch: `Junaid-deve-starts`. One commit per phase. Decisions from the user: install deno;
retire `src/` (keep only the modules the loaders need); push only, no deploy; move comment
blocks of 8+ lines.

## Phases

- [ ] A. Prerequisites: `brew install deno`; `deno check` the current `api/index.ts` as the
      baseline that must stay green through every phase.
- [ ] B. Folder restructure (no code changes): root docs → `docs/`, consumer reports →
      `docs/consumer/`, data files → `docs/data/`, Python loaders → `loaders/`; delete
      `src/` (after extracting what the loaders import into `scripts/lib/`), `Dockerfile`,
      `.dockerignore`, `fly.toml`, `render.yaml`. Update `refresh.yml`, `tsconfig.json`,
      `package.json`, README links, `.gitignore`.
- [ ] C. Split `routes.ts` into `api/routes/*.ts` by family plus `api/shared/*.ts`;
      `deno check` after each module lands. `router.ts`, `errors.ts`, `db.ts` unchanged.
- [ ] D. Extract comment blocks of 8+ lines from the api modules into `docs/DECISIONS.md`
      (scripted), leaving the first sentence plus a pointer. `deno check` after.
- [ ] E. `/v1/fields` generated from `api/vocabulary.ts`; a test asserts every word there
      matches the SQL check constraints.
- [ ] F. Unit tests (`deno test`) for the pure functions: `value()`, step chooser, floor rule,
      `classify()`, `router.match()`.
- [ ] G. `CLAUDE.md`: route → file map, twin-file rule, vocabulary process, live vs dead,
      verification and deploy commands.
- [ ] H. Update `README.md`, `PROJECT_ANALYSIS.md`, `TO-DO-BEFORE-MIGRATION.md` paths; final
      `deno check`, push; leave deploy + harness-diff instructions for the user.

## Not done here
- Deploy to Supabase and the acceptance diff: user runs
  `npx supabase functions deploy api --project-ref <ref> --no-verify-jwt`, then
  `./scripts/acceptance_capture.sh $BASE captures/after` and `diff -r captures/before captures/after`.

## Review
(filled in when done)
