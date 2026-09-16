#!/usr/bin/env bash
# Smoke test — verifies the deployed service is up, the directory is populated, and the
# core routes answer with the shape consumers read.
#
#   ./scripts/smoke.sh [base_url] [handle]
#
# Defaults to the live Supabase deployment. The old default (localhost:8787) and the old
# greps (`resolved_wallets`, `chains`) were written against the retired Express app and
# never matched the Edge Function's responses, so `npm run smoke` had been failing silently
# against production. Checks now go through jq so pretty-printed JSON and key order do not
# matter.
set -u
BASE="${1:-https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api}"
HANDLE="${2:-unipcs}"
fail=0

for tool in curl jq; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 2; }
done

check() {
  printf '%-46s' "$1"
  if eval "$2" >/dev/null 2>&1; then echo "ok"; else echo "FAIL"; fail=1; fi
}

get() { curl -sf --max-time 60 "$BASE$1"; }

echo "genie-fomo API smoke test -> $BASE"
check "health responds"          "get /v1/health"
check "directory has traders"    "get /v1/health | jq -e '.rows.traders > 0'"
check "no feed is stale"         "get /v1/health | jq -e '.staleFeeds | length == 0'"
check "trader list responds"     "get '/v1/traders?limit=1' | jq -e '.entries | length == 1'"
check "unknown handle is 404"    "[ \$(curl -s -o /dev/null -w '%{http_code}' $BASE/v1/traders/__nope__/wallets) = 404 ]"
check "wallets resolves $HANDLE" "get /v1/traders/$HANDLE/wallets | jq -e '.wallets and .walletState'"
check "transactions responds"    "get '/v1/traders/$HANDLE/transactions?limit=5' | jq -e '.transfers | type == \"array\"'"
check "fields vocabulary served" "get /v1/fields | jq -e 'keys | length > 0'"

echo
[ $fail -eq 0 ] && echo "all checks passed" || echo "some checks failed"
exit $fail
