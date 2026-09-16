/**
 * The published vocabulary, as data. /v1/fields serves this object; the tests assert it
 * covers every value the SQL check constraints allow. Add a word here (and bump
 * `version`) before any route emits it.
 */
export const VOCABULARY = {
  closed: true,
  version: 2,
  fields: {
    "aum.status": ["ready", "warming", "stale", "no_reading"],
    "aum.points[].basis": ["sampled", "rebuilt"],
    "aum.points[].tier": ["verified", "reported"],
    "aum.points[].refused": ["too_little_priced", "nothing_answered", "chains_unrebuildable",
                             "no_prices", "wallet_unreadable",
                             "service_timeout", "price_rejected"],
    "aum.gaps[].reason": ["too_little_priced", "nothing_answered", "chains_unrebuildable",
                          "no_prices", "wallet_unreadable",
                             "service_timeout", "price_rejected"],
    /* gaps[] now carries `from` and `to` as well as `at` — the span, not just the moment. */
    "aum.breaks[].reason": ["chains_changed", "method_changed", "priced_share_changed",
                            "method_and_chains_changed", "method_and_priced_share_changed",
                            "chains_and_priced_share_changed",
                            "method_and_chains_and_priced_share_changed"],
    "aum.drawing.reason": ["too_few_points", "nothing_answered", "warming", "short_coverage"],
    "aum.chains[].reason": ["no_prices"],
    /* `none` is a chain we know he uses and hold no balance history for at all. */
    "aum.knownChains[].historyState": ["ready", "warming", "none"],
    "aum.sampler.state": ["current", "stale", "warming"],
    "aum.coverage.partialReason": ["chains_missing", "unpriced_positions",
                                   "chains_missing_and_unpriced_positions"],
    "aum.progress.boundedBy": ["window", "history"],
    /* What this request did about freshness before answering. See the /aum route. */
    "aum.liveRead.state": ["fetched", "still_running", "not_needed", "skipped",
                           "unavailable"],
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
