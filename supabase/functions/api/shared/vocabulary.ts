/**
 * The published vocabulary, as data. /v1/fields serves this object; the tests assert it
 * covers every value the SQL check constraints allow. Add a word here (and bump
 * `version`) before any route emits it.
 */
export const VOCABULARY = {
  closed: true,
  version: 6,
  fields: {
    "aum.status": ["ready", "warming", "stale", "no_reading"],
    "aum.points[].basis": ["sampled", "rebuilt"],
    "aum.points[].tier": ["verified", "reported"],
    "aum.points[].refused": ["too_little_priced", "nothing_answered", "chains_unrebuildable", "no_prices", "wallet_unreadable", "service_timeout", "price_rejected", "price_suspect", "no_tokens_known"],
    "aum.gaps[].reason": ["too_little_priced", "nothing_answered", "chains_unrebuildable", "no_prices", "wallet_unreadable", "service_timeout", "price_rejected", "price_suspect", "no_tokens_known"],
    /* gaps[] now carries `from` and `to` as well as `at` — the span, not just the moment. */
    "aum.breaks[].reason": ["chains_changed", "method_changed", "priced_share_changed",
                            "method_and_chains_changed", "method_and_priced_share_changed",
                            "chains_and_priced_share_changed",
                            "method_and_chains_and_priced_share_changed"],
    "aum.drawing.reason": ["too_few_points", "nothing_answered", "warming", "short_coverage", "rebuilt_only"],
    "aum.chains[].reason": ["no_prices", "wallet_unreadable", "service_timeout", "no_tokens_known", "price_suspect"],
    /* `none` is a chain we know he uses and hold no balance history for at all. */
    "aum.knownChains[].historyState": ["ready", "warming", "none"],
    "aum.sampler.state": ["current", "stale", "warming", "never_read"],
    "aum.coverage.partialReason": ["chains_missing", "unpriced_positions",
                                   "chains_missing_and_unpriced_positions"],
    "aum.progress.boundedBy": ["window", "history"],
    /* What this request did about freshness before answering. See the /aum route. */
    "aum.liveRead.state": ["fetched", "still_running", "not_needed", "skipped",
                           "unavailable"],
    /* 17 Sep 2026, v3: the words added by the pre-migration fixes (docs/TO-DO-BEFORE-MIGRATION.md). */
    "aum.stepChosenFrom": ["window", "tracked_span", "fallback"],
    "aum.points[].reliability": ["low"],
    "positions.partialReason": ["unsellable_positions", "unpriced_positions", "indexer_coverage_low", "unsellable_positions_and_indexer_coverage_low"],
    "positions[].priceSuspectReason": ["implied_mcap_over_ceiling", "concentration_over_ceiling"],
    "wallets.resolvedBy.*": ["fomoapi", "gmgn", "submitted"],
    "health.staleFeeds[]": ["traders", "trades", "wallets", "positions", "transactions", "tokenInfo", "aum", "scorecards"],
    /* 17 Sep 2026, v4: second wave (items 10, 11, 12, R6). */
    "scorecard.loadOutcome": ["loaded", "unavailable", "degraded", "not_found", "error"],
    "scorecard.nextLoadBasis": ["nightly_slot"],
    "pnl.openPositionsBasis.*": ["trade_records", "trade_records_still_held_on_chain"],
    "trades.status": ["open", "closed", "closed_by_balance"],
    /* 17 Sep 2026, v5: T3 bounded on-chain scorecard fallback. */
    "scorecard.staleness.fallback": ["on_chain"],
    "scorecard.onChain.basis": ["wallet_swaps"],
    /* 17 Sep 2026, v6: workflow gaps 1-5 (price history, events, launch metadata, live holdings, creators, linked wallets). */
    "events[].kind": ["transfer", "swap", "reading"],
    "events[].direction": ["in", "out"],
    "events[].traderSource": ["fomoapi.io", "gmgn"],
    "tokens[].launchpad": ["pump.fun"],
    "positions.liveBasis.solana": ["rolled_forward_from_transfers"],
    "positions.liveBasis.evm": ["nightly_read"],
    "positions[].tier": ["verified", "reported", "rolled_forward"],
    "flow.basis": ["transactions"],
    "wallets.linked[].kind": ["funded_by", "submitted"],
    "creators.tokens[].status": ["creator_hold", "creator_close"],
    "wallets.walletState": ["on_record", "unresolved_upstream"],
    "traders.delisted.reason": ["absent_from_source"],
    "aum.comparability.reason": ["coverage_differs_by_method"],
    "scorecard.winRateBasis": ["closed_positions_with_realized_figure"],
    /* Why a named figure is null. `not_applicable` means the question does not arise. */
    "scorecard.fieldReasons.*": ["not_applicable", "historical_input_missing",
                                 "not_yet_calculated", "no_realized_figure",
                                 "no_winning_trade", "sign_discipline_not_both_positive",
                                 "source_unavailable"],
    "scorecard.staleness.state": ["current", "stale", "never"],
    "scorecard.meanToMedianBasis": ["per_token"],
    "pnl.realizedShareReason": ["no_trades_on_record", "nothing_banked_or_on_paper",
                                "sign_discipline_not_both_positive"],
    "health.feeds.*.state": ["current", "stale", "never"],
    "health.dataState": ["current", "degraded"],
    "error.code": ["not_found", "bad_request", "duplicate_identifier", "rate_limited",
                   "timeout", "internal",
                   /* POST /traders/:handle/wallets — see that route. */
                   "not_configured", "unauthorized", "invalid_address", "address_in_use",
                   "already_on_record"],
    "walletSubmission.pricing.state": ["pending_first_read"],
  },
} as const;
