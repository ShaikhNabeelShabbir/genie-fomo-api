import { sql, n, round } from "../db.ts";
import { money } from "../shared/format.ts";

// ------------------------------------------------------------------- trust

/** Holdings aggregate per trader, grouped so the bulk route needs one statement. */
export const trustHoldings = (handles: string[]) => sql`
  select handle,
         count(*)::int as positions,
         count(value) filter (where value > 0)::int as priced,
         coalesce(sum(value) filter (where value > 0), 0) as holdings_value,
         max(captured_at) as as_of
  from holdings_current where handle = any(${handles}) group by handle`;

/**
 * Shared by the single and bulk routes. As with `pnlBody`, `group by` yields no row for a
 * trader with no holdings where the ungrouped query yielded one row of zeros, so a missing
 * row is treated as zeros.
 */
/**
 * WHAT A BLACKLIST ANSWER LOOKS LIKE WHEN NOTHING WAS CHECKED.
 *
 * `listed` is null, not false. False would mean we looked and he was not on a list; null with
 * `checked: false` means we never looked, and those are opposite statements. `checkedAt` is
 * null for the same reason -- there was no check to time.
 */
export const BLACKLIST_CHECK = {
  checked: false,
  lists: [] as string[],
  listed: null as boolean | null,
  checkedAt: null as string | null,
  why: "no blacklist, sanctions list or known-scam source is consulted by this route. " +
       "An absent blacklist flag means NOT CHECKED — never 'checked and clear'.",
};

/**
 * `asOf` is the board-wide fallback, used only for a trader with no holdings row at all —
 * `trustHoldings` carries each trader's own `as_of` and that is what wins.
 *
 * It stopped being safe to share one value the moment chain-read balances landed. Every
 * fomo row is stamped with one nightly build time, but a chain snapshot is stamped when we
 * read it, so a single global max would put today's timestamp on a trader whose numbers
 * came from yesterday's fomo build — the exact complaint the consuming team raised against
 * /v1/traders, fixed there with a per-trader `updatedAt`.
 */
// deno-lint-ignore no-explicit-any
export function trustBody(t: any, h: any | undefined, asOf: string | null) {
  const pnl = n(t.pnl_usd), volume = n(t.volume_usd), trades = n(t.trade_count);
  const holdingsValue = (h ? n(h.holdings_value) : 0) ?? 0;
  const positions = Number(h?.positions ?? 0), priced = Number(h?.priced ?? 0);

  const flags: { code: string; severity: string; plain: string }[] = [];
  const pnlToVolume = pnl !== null && volume !== null && volume > 0
    ? Number((pnl / volume).toFixed(2)) : null;
  const pnlToHoldings = pnl !== null && holdingsValue > 0
    ? Number((pnl / holdingsValue).toFixed(2)) : null;

  const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
  const pricedShare = positions > 0 ? priced / positions : null;

  /**
   * The two "exceeds" flags look alike and are not.
   *
   * pnl_exceeds_volume divides fomo's REPORTED profit by fomo's REPORTED volume. Both sides
   * are their own figures, stored verbatim, so a ratio above 1 is a contradiction inside
   * their data and nothing to do with our coverage. It stays.
   *
   * pnl_exceeds_holdings divides that same reported profit by OUR sum of priced positions —
   * and for `ogle` that is 6 of 48 positions. "2,364x everything they hold" was 2,364x an
   * eighth of what they hold. A denominator we know is partial cannot support a claim about
   * the whole, so the flag is withheld below the same 0.5 floor the rest of the API uses,
   * and a note explains why instead.
   *
   * The wording changed too. "That cannot come from trading alone" is a conclusion; the
   * response now states the arithmetic and leaves the conclusion to the reader.
   */
  if (pnlToVolume !== null && pnlToVolume > 1) {
    flags.push({ code: "pnl_exceeds_volume", severity: "warn",
      plain: `fomo reports ${usd(pnl!)} of profit on ${usd(volume!)} of lifetime volume — ` +
             `a ratio of ${pnlToVolume}x. Both figures are fomo's own, so they disagree with ` +
             `each other regardless of what we hold.` });
  }
  if (pnlToHoldings !== null && pnlToHoldings > 10 && (pricedShare ?? 0) >= 0.5) {
    flags.push({ code: "pnl_exceeds_holdings", severity: "warn",
      plain: `Reported profit is ${Math.round(pnlToHoldings)}x the value of everything they ` +
             `currently hold (${priced} of ${positions} positions priced) — the money is not ` +
             `visible in the portfolio.` });
  } else if (pnlToHoldings !== null && pnlToHoldings > 10) {
    flags.push({ code: "holdings_coverage_too_low", severity: "info",
      plain: `Reported profit is ${Math.round(pnlToHoldings)}x our valuation of their holdings, ` +
             `but only ${priced} of ${positions} positions have a price — too little of the ` +
             `portfolio is visible to draw a conclusion from that ratio.` });
  }
  if (trades !== null && trades < 10) {
    flags.push({ code: "too_few_trades", severity: "warn",
      plain: `Only ${trades} trade${trades === 1 ? "" : "s"} on record — far too few to tell skill from luck.` });
  }
  if (positions > 0 && priced / positions < 0.5) {
    flags.push({ code: "partial_pricing", severity: "info",
      plain: `Only ${priced} of ${positions} positions have a usable price, so portfolio figures are incomplete.` });
  }

  /**
   * `self_contradictory` replaces `implausible`. The old word passed judgement on the
   * TRADER; the new one describes the NUMBERS, which is all the data supports — two figures
   * fomo published that cannot both be right.
   */
  const verdict = flags.some((f) => f.code === "pnl_exceeds_volume") ? "self_contradictory"
    : flags.some((f) => f.code === "pnl_exceeds_holdings") ? "unverified"
    : flags.some((f) => f.code === "holdings_coverage_too_low") ? "unverifiable"
    : flags.some((f) => f.code === "too_few_trades") ? "insufficient" : "ok";

  return {
    handle: t.display_handle, name: t.name ?? null,
    /**
     * WHAT WAS CHECKED, so an absent flag cannot be read as a clean bill of health.
     *
     * Every flag this route raises is an internal-consistency check on figures we already
     * hold: two numbers that cannot both be true, or too little evidence to judge. NOTHING
     * here consults an external reputation service, a blacklist, or a known-scam list.
     *
     * That distinction is the whole point of publishing this block. "We checked a blacklist
     * and this trader is not on it" and "we never looked" are opposite statements, and until
     * now an absent blacklist flag was indistinguishable from the first while meaning the
     * second. `blacklist.checked: false` says which one it is.
     */
    checks: {
      performed: [
        "pnl_exceeds_volume", "pnl_exceeds_holdings", "holdings_coverage_too_low",
        "too_few_trades", "partial_pricing",
      ],
      basis: "internal consistency only — figures we hold, checked against each other",
      blacklist: BLACKLIST_CHECK,
      externalReputation: { checked: false, sources: [] },
    },
    /**
     * The contract names `trust.blacklist`, so it is here as well as inside `checks`. Same
     * object, one source, so the two can never disagree.
     */
    blacklist: BLACKLIST_CHECK,
    // Every money figure carries its measurement time; these are derived from the holdings
    // snapshot, so they age with it — this trader's own, not the board's.
    asOf: h?.as_of ? new Date(String(h.as_of)).toISOString() : asOf,
    reportedPnlUsd: pnl, volumeUsd: volume,
    flags, pnlToVolume, pnlToHoldings, trades, verdict,
    // What each denominator was, so a consumer can weigh the verdict rather than take it.
    basis: {
      pnlToVolume: { numerator: "fomo reported pnl", denominator: "fomo reported volume",
                     bothReported: true },
      pnlToHoldings: { numerator: "fomo reported pnl", denominator: "our sum of priced positions",
                       pricedPositions: priced, totalPositions: positions,
                       pricedShare: pricedShare === null ? null : Number(pricedShare.toFixed(4)) },
    },
    plain: verdict === "self_contradictory"
      ? "fomo's own profit and volume figures for this trader do not reconcile with each other."
      : verdict === "unverified"
      ? "The reported profit is far larger than the portfolio we can see, so we cannot corroborate it."
      : verdict === "unverifiable"
      ? "Too little of this trader's portfolio has a price for us to say anything about the reported profit."
      : verdict === "insufficient"
      ? "There is not enough trading history here to judge skill."
      : "Nothing in the numbers contradicts itself.",
  };
}
