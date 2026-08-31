#!/usr/bin/env bash
# Smoke test — verifies the service is up, providers are reporting, and both
# endpoints return sane data. Usage: ./scripts/smoke.sh [base_url] [handle]
set -u
BASE="${1:-http://localhost:8787}"
HANDLE="${2:-unipcs}"
fail=0

check() {
  printf '%-46s' "$1"
  if eval "$2" >/dev/null 2>&1; then echo "ok"; else echo "FAIL"; fail=1; fi
}

echo "genie-fomo API smoke test -> $BASE"
check "health responds"          "curl -sf $BASE/v1/health"
check "directory has traders"    "curl -sf $BASE/v1/health | grep -q '\"traders\":[1-9]'"
check "trader list responds"     "curl -sf '$BASE/v1/traders?limit=1'"
check "unknown handle is 404"    "[ \$(curl -s -o /dev/null -w '%{http_code}' $BASE/v1/traders/__nope__/wallets) = 404 ]"
check "wallets resolves $HANDLE" "curl -sf $BASE/v1/traders/$HANDLE/wallets | grep -q resolved_wallets"
check "transactions responds"    "curl -sf '$BASE/v1/traders/$HANDLE/transactions?limit=5' | grep -q chains"

echo
[ $fail -eq 0 ] && echo "all checks passed" || echo "some checks failed"
exit $fail
