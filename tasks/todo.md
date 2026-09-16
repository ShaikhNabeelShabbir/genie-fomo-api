# Executing PROJECT_ANALYSIS.md Part 3

Branch: `Junaid-deve-starts`. One commit per action.

- [ ] 1. Correct `CLOUDFLARE_MIGRATION.md` (counts, driver config, limits, caching, IPv6,
      Phase 2–3 data gap, Option A′, single Worker, harness reality)
- [ ] 2. Commit a runnable acceptance harness (`scripts/acceptance_capture.sh`) that takes a
      base URL and writes normalised captures for diffing
- [ ] 3. Repo hygiene: untrack `supabase/.temp/`, fix `.env.example`, remove dead files, fix
      daemon path, update 404 hint list in `index.ts`, point `smoke.sh` at the live URL
- [ ] 4. Decide fate of `src/` — needs a decision from the user (retire vs keep)
- [ ] 5. Port to Workers — needs Cloudflare account access; starts with
      `wrangler hyperdrive create` against the Supabase direct host

## Review

(filled in when done)
