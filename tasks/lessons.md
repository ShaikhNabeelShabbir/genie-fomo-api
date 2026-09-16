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
