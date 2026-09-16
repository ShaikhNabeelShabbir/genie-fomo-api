#!/usr/bin/env bash
#
# Acceptance capture — fetch every route the acceptance suite covers, for a fixed set of
# traders, and write one normalised JSON file per call so two deployments can be diffed.
#
# This exists because the harness that produced ACCEPTANCE_TEST_REPORT.md lived in a session
# scratchpad and was never committed. Until that is rebuilt, this is the gate for any change
# that must preserve behaviour — the Cloudflare port in CLOUDFLARE_MIGRATION.md §12 first.
#
#   scripts/acceptance_capture.sh <base_url> <out_dir> [handle ...]
#
#   scripts/acceptance_capture.sh https://<ref>.supabase.co/functions/v1/api captures/before
#   scripts/acceptance_capture.sh https://genie-copy-trading-api.<subdomain>.workers.dev      captures/after
#   diff -r captures/before captures/after
#
# Run it TWICE against the same deployment first and diff those. That diff must be empty; if
# it is not, the harness is stripping too little and cannot be trusted to judge a port.
#
# What is stripped, and why: the fields the API documents as live — `asOf`, `liveRead`,
# timestamp-valued `from`/`to` (window bounds), every `*ageSeconds`/`*AgeSeconds`,
# `requestedFrom`, `pipelineLastSuccessAt` and `requestId` — change on every call and say
# nothing about whether the port is correct. Everything else, including every other `*At`,
# is kept: those are stored values and two reads minutes apart against one database must
# agree. Measured 16 Sep 2026: two runs five minutes apart differed in exactly those fields
# and in nothing else.
#
# `/v1/health` is captured as its key set only. Its body is per-feed freshness, which is
# live by definition; what a port must preserve is the shape.
#
# Set GENIE_API_KEY in the environment if the deployment requires X-API-Key.

set -euo pipefail

if [ $# -lt 2 ]; then
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

BASE="${1%/}"
# The contract to capture: v1 (Supabase) or v2 (the Cloudflare Worker, same routes).
V="${API_VERSION:-v1}"
OUT="$2"
shift 2

# The five traders CLOUDFLARE_MIGRATION.md §12 names: a spread of sizes and chains.
if [ $# -gt 0 ]; then
  HANDLES=("$@")
else
  HANDLES=(unipcs ogle poopinyourhands 0xavast notanicecat69)
fi

for tool in curl jq; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 2; }
done

mkdir -p "$OUT"

AUTH=()
if [ -n "${GENIE_API_KEY:-}" ]; then
  AUTH=(-H "x-api-key: ${GENIE_API_KEY}")
fi

# Remove the documented-live fields, then sort keys so ordering never shows up in a diff.
NORMALISE='
  def is_iso: type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T");
  (if type == "object" then del(.asOf, .liveRead) else . end)
  # links are spelled for the requested version; fold v2 back to v1 so the two deployments diff
  | walk(if type == "string" then gsub("/v2/"; "/v1/") else . end)
  | walk(
      if type == "object"
      then with_entries(select(
        (.key | test("[aA]geSeconds$|^requestId$|^requestedFrom$|^pipelineLastSuccessAt$")) or
        # window bounds are computed from the request clock; a `from`/`to` that is an
        # address (transfers) is data and stays
        ((.key == "from" or .key == "to") and (.value | is_iso))
        | not))
      else . end
    )
'

fail=0

# capture <name> <method> <path> [json-body]
capture() {
  local name="$1" method="$2" path="$3" body="${4:-}"
  local file="$OUT/$name.json" status
  local args=(-sS --max-time 60 -o "$file.raw" -w '%{http_code}' -X "$method" ${AUTH[@]+"${AUTH[@]}"})
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data "$body")
  fi

  if ! status=$(curl "${args[@]}" "$BASE$path"); then
    echo "FAIL  $name  (curl error)" >&2
    fail=1
    rm -f "$file.raw"
    return
  fi

  if ! jq -S "$NORMALISE" "$file.raw" > "$file" 2>/dev/null; then
    # Not JSON. Keep it verbatim so the diff shows what came back.
    mv "$file.raw" "$file"
    echo "WARN  $name  HTTP $status  (non-JSON body)" >&2
  else
    rm -f "$file.raw"
  fi
  echo "$status" > "$OUT/$name.status"
  printf '%-44s HTTP %s\n' "$name" "$status"
}

echo "capturing $BASE -> $OUT"

# ---- global routes -------------------------------------------------------------------------
capture chains            GET "/$V/chains"
capture fields            GET "/$V/fields"
capture tokens            GET "/$V/tokens?limit=25"
capture tokens_momentum   GET "/$V/tokens/momentum"
capture traders           GET "/$V/traders?limit=25"
capture traders_included  GET "/$V/traders?limit=10&include=pnl,scorecard,wallets,trust"
capture traders_search    GET "/$V/traders?q=${HANDLES[0]}"

# health: shape only
if health=$(curl -sS --max-time 60 ${AUTH[@]+"${AUTH[@]}"} "$BASE/$V/health"); then
  printf '%s' "$health" | jq -S 'keys' > "$OUT/health_keys.json"
  printf '%-44s %s\n' health_keys ok
else
  echo "FAIL  health_keys" >&2; fail=1
fi

# ---- per-trader routes ---------------------------------------------------------------------
for h in "${HANDLES[@]}"; do
  p="/$V/traders/$h"
  capture "$h.profile"       GET "$p"
  capture "$h.wallets"       GET "$p/wallets"
  capture "$h.scorecard"     GET "$p/scorecard"
  capture "$h.pnl"           GET "$p/pnl"
  capture "$h.portfolio"     GET "$p/portfolio"
  capture "$h.positions"     GET "$p/positions?limit=25"
  capture "$h.trades"        GET "$p/trades?limit=25"
  capture "$h.transactions"  GET "$p/transactions?limit=25"
  capture "$h.transactions_money" GET "$p/transactions?limit=25&money=true"
  capture "$h.trust"         GET "$p/trust"
  capture "$h.aum_1m"        GET "$p/aum?window=1m&live=false"
  capture "$h.aum_1w_solana" GET "$p/aum?window=1w&chain=solana&live=false"
done

# ---- batch routes --------------------------------------------------------------------------
IDS=$(printf '%s\n' "${HANDLES[@]}" | jq -R . | jq -sc .)
capture batch_positions POST "/$V/traders/positions" "{\"ids\":$IDS}"
capture batch_aum_1m    POST "/$V/traders/aum"       "{\"ids\":$IDS,\"window\":\"1m\"}"

# ---- the refusals the suite checks ---------------------------------------------------------
capture unknown_handle  GET "/$V/traders/__no_such_trader__/wallets"
capture unknown_route   GET "/$V/nope"

# A colliding wallet submission must answer 409 address_in_use. Only exercised when the
# secret is available; the route is the service's one write and is refused without it.
if [ -n "${WALLET_SUBMIT_SECRET:-}" ]; then
  first_evm=$(jq -r '.evmAddress // .resolved_wallets.evm // empty' "$OUT/${HANDLES[0]}.wallets.json" 2>/dev/null || true)
  if [ -n "$first_evm" ]; then
    capture wallet_collision POST "/$V/traders/${HANDLES[1]}/wallets" \
      "{\"secret\":\"$WALLET_SUBMIT_SECRET\",\"evmAddress\":\"$first_evm\"}"
  fi
fi

echo
if [ $fail -eq 0 ]; then
  echo "captured $(ls "$OUT"/*.json | wc -l | tr -d ' ') files into $OUT"
else
  echo "captured with failures — see above" >&2
fi
exit $fail
