#!/bin/bash
#
# Keep filling in Solana until the roster is done.
#
# WHY A SUPERVISOR AND NOT ONE LONG RUN. Helius answers "max usage reached" when the account's
# credits are spent, and no amount of patience inside a single run gets past that -- it is a
# quota, not a rate limit. So this checks whether the key is answering, does as much work as
# the quota allows, and comes back later for the rest.
#
# NOTHING WAITS FOR THE WHOLE ROSTER. rebuild_aum_solana.mjs caches and writes one wallet at a
# time, so every wallet it reads is in the database moments later and being served. A quota
# that dies mid-pass costs the wallet in flight, nothing more.
#
# It runs WITHOUT --offline on purpose: when credits exist, two extra calls buy the forward
# check that proves the reconstruction reproduces the wallet. The same pass re-checks wallets
# written unverified earlier and deletes any that fail.
#
#   nohup bash scripts/solana_backfill_daemon.sh 600 > /tmp/solana_daemon.log 2>&1 &
#   tail -f /tmp/solana_daemon.log
#   pkill -f solana_backfill_daemon
#
cd /Users/nabeelshaikh/Desktop/api-ts || exit 1
KEY=$(grep '^HELIUS_SOLANA_KEY=' .env | cut -d= -f2- | tr -d '"')
TOTAL=170
INTERVAL=${1:-600}

while :; do
  CACHED=$(ls .cache/rebuild_solana_v2 2>/dev/null | wc -l | tr -d ' ')
  if [ "$CACHED" -ge "$TOTAL" ]; then
    echo "$(date -u +%H:%M:%S) all $TOTAL cached — final verified pass"
    node --env-file=.env scripts/rebuild_aum_solana.mjs --gap 2000 2>&1 | tail -60
    node --env-file=.env scripts/aggregate_aum_rebuilt.mjs 2>&1 | tail -6
    echo "SOLANA BACKFILL COMPLETE"
    break
  fi

  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "https://mainnet.helius-rpc.com/?api-key=$KEY" \
    -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth","params":[]}')

  if [ "$CODE" = "200" ]; then
    echo "$(date -u +%H:%M:%S) quota available — working ($CACHED/$TOTAL cached)"
    # NOT filtered down to the happy path. An earlier version grepped for success lines only,
    # so a run that died at its third wallet produced one line and read exactly like a run
    # that finished.
    node --env-file=.env scripts/rebuild_aum_solana.mjs --gap 2500 2>&1 | tail -60
    echo "  (node exit ${PIPESTATUS[0]})"
    NOW=$(ls .cache/rebuild_solana_v2 2>/dev/null | wc -l | tr -d ' ')
    echo "$(date -u +%H:%M:%S) pass finished — $NOW/$TOTAL cached (+$((NOW - CACHED)))"
    node --env-file=.env scripts/aggregate_aum_rebuilt.mjs 2>&1 | tail -4
  else
    echo "$(date -u +%H:%M:%S) helius HTTP $CODE — $CACHED/$TOTAL cached, retrying in ${INTERVAL}s"
  fi
  sleep "$INTERVAL"
done
