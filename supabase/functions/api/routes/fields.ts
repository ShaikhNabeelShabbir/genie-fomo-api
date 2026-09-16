import { sql } from "../db.ts";
import { get } from "../router.ts";
import { VOCABULARY } from "../shared/vocabulary.ts";
import { MIN_DRAWABLE_POINTS, PARTIAL_SERVE_FLOOR_USD, PRICED_FLOOR } from "../shared/aum-rules.ts";

// ------------------------------------------------------------------ fields

/** WHAT EVERY FIELD MEANS, WHAT IT CAN SAY, AND HOW OFTEN IT SAYS ANYTHING. See docs/DECISIONS.md#d062 */
get("/v1/fields", async () => {
  const [f] = await sql`
    with sc as (
      select t.handle,
        count(*) filter (where t.status = 'closed')::int as closed,
        count(*) filter (where t.status = 'closed' and t.realized_pnl_usd is not null)::int as realized,
        count(*) filter (where t.avg_entry_price is not null and t.avg_entry_price > 0)::int as entry_px,
        count(distinct to_char(t.closed_at, 'YYYY-MM')) filter (where t.status = 'closed')::int as months,
        count(*) filter (where t.status <> 'closed' and t.unrealized_pnl_usd is not null)::int as unreal
      from trades t group by t.handle),
    w as (select handle from wallets where evm_address is not null or sol_address is not null),
    a as (select handle, count(*) filter (where total_usd is not null)::int as pts
          from aum_samples group by handle)
    select
      (select count(*) from traders)::int                                as traders,
      (select count(*) from w)::int                                      as with_wallet,
      (select count(*) from sc where closed > 0)::int                    as with_closed,
      (select count(*) from sc where realized > 0)::int                  as with_realized,
      (select count(*) from sc where closed > 0 and realized = closed)::int as realized_complete,
      (select count(*) from sc where entry_px > 0)::int                  as with_entry_px,
      (select count(*) from sc where entry_px >= 20)::int                as entry_px_20,
      (select count(*) from sc where months >= 3)::int                   as months_3,
      (select count(*) from sc where unreal > 0)::int                    as with_unrealized,
      (select count(*) from a where pts > 0)::int                        as with_reading`;

  const N = Number(f.traders);
  const rate = (of: unknown, why: string | null = null) => ({
    of: Number(of), total: N, share: N ? Number((Number(of) / N).toFixed(4)) : null,
    commonestAbsence: why,
  });

  return {
    board: "fields",
    asOf: new Date().toISOString(),
    traders: N,

    vocabulary: VOCABULARY,

    /**
     * THE UNIT OF EVERY QUANTITY, by naming convention.
     *
     * The suffix IS the unit and always has been; publishing it is what makes that a contract
     * rather than a habit. A unit change gets a NEW FIELD NAME -- never a new meaning under
     * the old one, because that is the one change no test and no screen can detect.
     */
    units: {
      "*Usd": "United States dollars, as a number. Never cents, never a string",
      "*Native": "the chain's own coin, exact, at full precision",
      "*Share": "a ratio from 0 to 1 inclusive. Never a percentage",
      "pricedPositionShare": "priced positions divided by total positions, 0 to 1 — a COUNT " +
        "ratio, not a share of value. The value of an unpriced position is unknowable, so no " +
        "true value share exists. `valueShare` and `pricedShare` are the same number under " +
        "older names that misdescribe it",
      "winRate": "a ratio from 0 to 1 inclusive",
      "*Pct": "a percentage from 0 to 100. The only quantities on that scale",
      "*Ms": "milliseconds, integer",
      "*Seconds": "seconds, integer",
      "*Hours": "hours, may be fractional",
      "*Days": "days, may be fractional",
      "*At / *From / *To / *Since": "ISO-8601 with an explicit Z. Never epoch seconds",
      "day": "a calendar date, YYYY-MM-DD",
      "month": "a calendar month, YYYY-MM",
      "coverage{of,total,share}": "counts as integers; share is of/total from 0 to 1",
      note: "absence is always null. Zero is a claim and null is an absence — no string ever " +
            "stands in for a missing number, and no number for a missing fact",
    },

    /** THE THRESHOLDS THE RULES APPLY, published so a consumer can explain a refusal (R2). */
    constants: {
      /** Count share of priced positions below which a reading is partial or refused. */
      pricedFloor: PRICED_FLOOR,
      /** A figure below the count floor is served as partial at or above this; refused below. */
      partialServeFloorUsd: PARTIAL_SERVE_FLOOR_USD,
      /** Dated figures needed before an /aum series is drawable. */
      drawableMinPoints: MIN_DRAWABLE_POINTS,
    },

    /**
     * HOW MUCH OF THE DIRECTORY ACTUALLY CARRIES EACH FIELD.
     *
     * Counted over every trader, every time this is called. A field below a rate you are
     * willing to build a screen on is one to treat as not generally available.
     */
    fillRates: {
      "wallets.evmAddress or solanaAddress":
        rate(f.with_wallet, "no wallet has been resolved for this trader"),
      "aum.now.totalUsd (any reading at all)":
        rate(f.with_reading, "the sampler has not reached this trader yet"),
      "scorecard.winRate / wins / losses":
        rate(f.with_realized, "no closed position carries a realized figure"),
      "scorecard.winRate over a COMPLETE record":
        rate(f.realized_complete,
             "some closed positions carry no realized figure, so winRateCoverage.of is " +
             "below closedTrades — see winRateBasis"),
      "scorecard.windows[].closedTrades":
        rate(f.with_closed, "no position has closed on record"),
      "scorecard.entryPriceCoverage (any priced token)":
        rate(f.with_entry_px, "no position carries an entry price"),
      "scorecard.entryPriceCoverage (20+, enough to rank on)":
        rate(f.entry_px_20, "fewer than twenty tokens carry an entry price"),
      "scorecard.realizedByMonth (3+ months)":
        rate(f.months_3, "the record does not span three calendar months of closes"),
      "pnl.onPaperUsd":
        rate(f.with_unrealized, "no open position carries an unrealized figure"),
    },

    plain: "Every enumerated field with its complete set, every quantity with its unit, and " +
           "how much of the directory carries each field. Counted live, not sampled. " +
           "POST /v1/traders/aum accepts and ignores `live`; its rows carry liveRead: skipped. " +
           "RateLimit-Remaining is per X-API-Key; RateLimit-Scope says whether the counter is global.",
  };
});
