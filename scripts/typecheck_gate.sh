#!/usr/bin/env bash
# Typecheck gate for the Deno edge functions.
#
# `deno check` used to report 90 postgres.js row-typing errors (implicit any on
# `.map((r) => …)`, `{}` rows); those are fixed and the baseline is now empty. The gate is
# "no NEW errors": the set of error messages must equal the recorded baseline, ignoring
# file names and line numbers (a split moves both).
#
#   scripts/typecheck_gate.sh            compare against scripts/typecheck_baseline.txt
#   scripts/typecheck_gate.sh --record   rewrite the baseline from the current tree
set -u
cd "$(dirname "$0")/.."
BASELINE=scripts/typecheck_baseline.txt
ENTRIES=(supabase/functions/api/index.ts supabase/functions/aum-sample/index.ts supabase/functions/helius-webhook/index.ts)

current=$(deno check "${ENTRIES[@]}" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^TS[0-9]+ \[ERROR\]' | sort)

if [ "${1:-}" = "--record" ]; then
  printf '%s\n' "$current" > "$BASELINE"
  echo "recorded $(printf '%s\n' "$current" | grep -c . ) errors to $BASELINE"
  exit 0
fi

if diff <(cat "$BASELINE") <(printf '%s\n' "$current") > /dev/null; then
  echo "typecheck gate: ok ($(grep -c . "$BASELINE") known errors, none new)"
  exit 0
fi
echo "typecheck gate: FAILED — error set differs from baseline:"
diff <(cat "$BASELINE") <(printf '%s\n' "$current") | grep -E '^[<>]' | head -40
exit 1
