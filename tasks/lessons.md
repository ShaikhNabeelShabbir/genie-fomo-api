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

## From the 19 Sep outage (two of its causes were this assistant's 17 Sep changes)

- **A SQL fragment's join contract must be code, not a comment, and EVERY call site gets run against the
  database.** `ladderColumns()` needed `token_price_stats ps`; I added it to three queries, verified
  `/positions` live, and never opened `/portfolio`, which then failed on every call for two days. When a
  fragment is interpolated into N queries: `EXPLAIN` all N on D1 before deploying. It takes a minute.
- **After any route SQL change run the acceptance capture, not just the smoke.** The capture hits `/portfolio`;
  the 8-check smoke does not. I ran the smoke.
- **A number measured on one step is not the cost of the job.** I sized the 5-minute top-up on "106 ms a
  trader" — the balance read alone. The real unit of work (`revalue` → `loadFacts`, 5 serial statements per 80
  token keys) was ~4–10 s a trader, so the job ran 231–625 s on a 300 s cadence and reset D1's isolate.
  Measure the whole unit, end to end, before multiplying it by a schedule.
- **Do not optimise one gauge while blind to the system.** I drove `liveStale` to 0 and declared A2 met while
  the same change made every API route 3–4× slower. For any new cron: watch its wallTime against its period,
  AND API p90, for an hour after deploy. A green job metric can be the outage.
- **"Measured, then claimed" has to include the blast radius, not just the target.** Every A2 reading I took was
  of the thing I was fixing. None was of the thing I might be breaking.
- **Exercise limits at their maximum.** The 100-bind ceiling shipped because every test used `limit` 1 or 10 and
  the consumer uses 100. For any paginated or batched route, the test that matters is the one at the cap.
- **When porting `= any($array)` to SQLite, one array becomes N binds.** The shim now binds per id while the statement
  fits 100 and as one `json_each` parameter only when it would not.
- **"Plan-checked" on ONE statement is not plan-checked.** I EXPLAINed the json_each form on a TABLE predicate, called it
  plan-neutral, and shipped it to 79 call sites; on an AGGREGATE VIEW a subquery term is never pushed down, so the
  sampler and the live refresh went from index seeks to whole-table scans in production (19 Sep, 10:33 UTC). A change
  in a shared layer is checked against every KIND of caller (table, flattened view, aggregate view), and the adversarial
  review is read BEFORE the deploy, not after — the reviewer that found this was still running when I deployed.
- **Audit agents must not touch production D1.** Read-only is not harmless: full-table aggregates from a fan-out of
  agents reset the database 987 times in 15 minutes. Plans are audited locally (`tests/routes_sql_test.ts`).
- **A push to `main` that touches `worker/**` (or the API, tests or scripts) IS a production deploy** (CI, `CLOUDFLARE_DEPLOY=true`); CI does not apply D1 migrations — apply them first.
- **`main` still carries the v1 nightly refresh** (`.github/workflows/refresh.yml`, 06:00 UTC, ~1.5 h, cancelled by
  timeout): it spends the same Helius, Bitquery and GMGN keys the Worker depends on. Check what the default branch
  schedules before believing "everything moved".
- **A handled 5xx is a successful Worker invocation** — `outcome: ok`. Count failures from `logs[]`.
- **A classifier that maps "any database error" to "retry shortly" hides your own bugs as outages.** Deterministic
  SQL errors must be 500 and loud.
- **`rtk` buffers streaming commands**: use `rtk proxy npx wrangler tail …`. **zsh: never name a loop variable
  `path`.**
- **An adversarial verifier per auditor paid for itself.** 19 of 44 findings were corrected and 1 refuted —
  including the "fix" I would otherwise have prescribed without checking (bind fix alone → 503 instead of 500)
  and a "confirmed" GMGN cause that the evidence did not support.
- **Workflow worktrees are cut from the DEFAULT branch, not from HEAD.** `isolation: 'worktree'` gave every agent a
  tree at `main` (no `worker/`, no `tests/`); each lost time working round it. Create the worktrees yourself
  (`git worktree add <path> -b fix-x <integration-branch>`), symlink `node_modules`, and hand agents the path.
- **Keep the owner's checkout deployable while agents work.** Do the work on a side branch in a scratch worktree and
  merge when the gate is green; a deploy from a half-edited tree is the next incident.
- **A queue needs a record of the ATTEMPT, not only of the success.** GMGN (never-fetched first), fees (oldest first),
  balances (last success first) all retried the same unanswerable items for ever while reporting green. Order by the
  attempt, park a miss, and stop after N refusals in a row.
- **An incremental pull is a cost fix AND a correctness fix.** Re-pulling the newest 500 transfers of every wallet
  hourly burned Helius credits, rewrote ~224k rows an hour in D1 and marked every trader "moved", which kept the
  5-minute flush permanently full. Ask "what does this job redo every run?" of every loader.
- **A cache shorter than the caller's cadence is not a cache.** Every TTL was 60 s-5 min; every app read is hourly or
  rarer, so every read was a cold build. Match the TTL to the consumer, and serve the expired answer on failure.
- **"Every enumerated value is published" has to be a test, not a sentence.** 17 documented word sets were never in
  `/fields`. `tests/vocabulary_test.ts` now walks the API reference.
- **A literal NUL byte in a source file makes grep skip it silently** ("Binary file matches"); `tokens-core.ts` hid
  from every search. Write `\u0000`.

