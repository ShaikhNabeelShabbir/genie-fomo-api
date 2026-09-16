# Executing PROJECT_ANALYSIS.md Part 3

Branch: `Junaid-deve-starts`. One commit per action.

- [x] 1. Correct `CLOUDFLARE_MIGRATION.md` (counts, driver config, limits, caching, IPv6,
      Phase 2–3 data gap, Option A′, single Worker, harness reality) — commit 57c5bac
- [x] 2. Commit a runnable acceptance harness (`scripts/acceptance_capture.sh`) that takes a
      base URL and writes normalised captures for diffing — two runs against production
      five minutes apart, 72 files each, diff empty
- [x] 3. Repo hygiene — commits 8eac72b, a9d5e3b. **Left undone:** `.env.example` lines 32–38
      (bare names, no `=`) — the file is edit-protected in this environment; fix by hand.
      `index.ts` 404-list edit is untyped-checked locally (no deno installed).
- [ ] 4. Decide fate of `src/` — needs a decision from the user (retire vs keep)
- [ ] 5. Port to Workers — needs Cloudflare account access; starts with
      `wrangler hyperdrive create` against the Supabase direct host

## Review (2026-09-16)

Done on `Junaid-deve-starts`, five commits after the analysis itself:

| Commit | What |
|---|---|
| 57c5bac | `CLOUDFLARE_MIGRATION.md` corrected: counts, driver config, Option A′, single Worker, caching/IPv6/connection budget/data-gap sections, harness reality |
| 8eac72b | hygiene: untracked `supabase/.temp/`, removed dead files, daemon path, requirements comment, 404 hint list, runbook banners |
| a9d5e3b | `smoke.sh` targets production with jq checks; 8/8 pass |
| 0c8766e | `scripts/acceptance_capture.sh`; two production runs diff empty |

Not done, and why:
- `.env.example` tail (7 bare names): file is tool-protected here. Manual fix needed.
- `index.ts` edit not typechecked: no `deno` on this machine. Change is string literals only.
- Item 4 (`src/` retirement) needs a decision: the 11 hyperliquid/pumpfun/gmgn routes exist
  only there, and three loaders import from `dist/`.
- Item 5 (the port) needs a Cloudflare account; first command is `wrangler hyperdrive create`
  against the Supabase direct host.

Lesson for the harness: macOS ships bash 3.2, where `"${arr[@]}"` on an empty array trips
`set -u`; use `${arr[@]+"${arr[@]}"}`. And the API's live fields are not uniformly named
(`ageSeconds` vs `AgeSeconds`, `requestedFrom`, `pipelineLastSuccessAt`) — the two-run diff is
what found them, which is exactly why the harness insists on it.
