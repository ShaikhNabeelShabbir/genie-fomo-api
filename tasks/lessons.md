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
- **Every prediction about a running system was wrong until measured — three times in one
  afternoon.** A2: the cost analysis was right (20x) but the binding constraint was cadence, not
  cost; then the real blocker was a queue ordered by mark age, so the busiest wallets held the
  stalest values — invisible in any diff. V1d's heal: the predicate "built inside its own hour"
  also matches every fresh row, so the first pass RAISED the count 2,078 -> 2,102 and would
  never have converged. Deploy, then read the number back, then claim. A figure that moves in
  the wrong direction is the cheapest bug report available.
- **Read a metric twice before quoting it: the first read may be mid-pass.** `liveStale` read
  243 during the catch-up and 163 after it; quoting the first would have understated the fix by
  half in a document the consumer checks against production.
- **A consumer's own words can carry the diagnosis.** "A flat figure broken by a spike every
  third hour looks like two builds taking turns" was exactly right: one builder whose ladder
  changed with the clock. Take the reported shape seriously before explaining it away.
- **Backticks in a SQL comment inside a JS template literal terminate the template.** Made this
  mistake twice in one session, the second time after writing this file's earlier entry about
  it. `deno check` passes it; `npx tsc -p worker/tsconfig.json` catches it.
