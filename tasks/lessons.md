# Lessons

- **Do not block on background agents.** The user interrupted a long `TaskOutput` wait twice
  (17 Sep). Poll with `block: false` between other work; merge what has landed; keep the main
  thread productive. Blocking is only for the final agent when nothing else is left.
- **Check the smallest output sample before a scripted rewrite over many sites** (the comment
  extractor's first pass produced 140-char anchors across 197 pointers).
- **`git add -A` after agent worktrees exist sweeps `.claude/worktrees/` into the index.** It is
  ignored now; add paths explicitly when in doubt.
- **The Supabase URL contains `/functions/v1/`, which is not the API version.** Any script that
  parametrises the version must leave that segment alone.
- **A consumer's bug report names a symptom; the symptom is usually shared.** The v5 fix request
  listed 20 asks. Five of the top ones (V1d, A1, N1, R7) were a single defect — three price
  ladders for the same coin — and two more (A4, V1d again) were a single missing rule. Grep for
  every reader of the value before touching the one the ticket names.
- **Apply a coverage rule where the figure is SERVED, not where it is built.** Moving the
  priced-share rule to read time fixed 25,492 stored rows on deploy instead of requiring a
  rebuild, and needed no migration. Build-time withholding also destroys the number.
- **Backticks inside a SQL comment inside a JS template literal terminate the template.**
  `deno check` passed it; `npx tsc -p worker/tsconfig.json` caught it. Run both.
- **`git stash` then re-lint to get the real baseline** before claiming a doc change is clean:
  the 7 openapi warnings were mine (stale response examples using the renamed fields).
