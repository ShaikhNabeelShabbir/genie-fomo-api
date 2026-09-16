import { sql, n, round } from "../db.ts";
import { get, post } from "../router.ts";
import { notFound, badRequest } from "../errors.ts";
import { median, money } from "../shared/format.ts";
import { NativePrice, nativePrices } from "../shared/prices.ts";
import { resolveChain, SOLANA_NET, KnownChain, knownChainsFor } from "../shared/chains.ts";
import { resolveTrader } from "../shared/traders.ts";
import { batchIds, batchEnvelope } from "../shared/batch.ts";

// --------------------------------------------------------------- AUM over time

/** The windows the route accepts, and how far back each reaches. */
const AUM_WINDOWS: Record<string, number | null> = {
  "1d": 86_400_000,
  "1w": 7 * 86_400_000,
  "1m": 30 * 86_400_000,
  all: null,
};
/**
 * THE SAME WINDOW, SPELLED THE WAY PEOPLE SPELL IT.
 *
 * The four windows are `1d`, `1w`, `1m`, `all`, and everything else was a 400 -- including
 * `30d`, which is the natural request from a document that keeps saying "thirty days", and
 * `1D` / `30D` / `1M`, which is how chart buttons are usually labelled. A consumer whose pills
 * read 1D / 7D / 30D / All got a chart on three of them and an error on the fourth, which
 * reads as the service being down rather than as a spelling disagreement.
 *
 * The canonical names are unchanged and are what `window` echoes back, so nothing that already
 * works changes its answer. These are only ways IN.
 */
const WINDOW_ALIASES: Record<string, string> = {
  "24h": "1d", "1day": "1d",
  "7d": "1w", "1week": "1w", "7day": "1w",
  "30d": "1m", "1month": "1m", "30day": "1m", "1mo": "1m",
  everything: "all", lifetime: "all", max: "all",
};

/** Canonical window for a requested one, or null when it is not a window we serve. */
function resolveWindow(raw: string): string | null {
  const k = raw.trim().toLowerCase();
  if (k in AUM_WINDOWS) return k;
  return WINDOW_ALIASES[k] ?? null;
}

/** Step sizes, coarsest last. The default picks the coarsest that still leaves >= 24 points. */
const AUM_STEPS: { name: string; ms: number }[] = [
  { name: "1h", ms: 3_600_000 },
  { name: "6h", ms: 6 * 3_600_000 },
  { name: "1d", ms: 24 * 3_600_000 },
];

/**
 * A trader's balance over time — one sampled point per hour, in USD, across every wallet
 * and chain.
 *
 * `/portfolio` answers "now"; this answers "over time", and the two are deliberately not
 * merged. If the newest sample here disagrees with `/portfolio`, that is a finding worth
 * chasing, not something to average away.
 *
 * NOT bulk-able through `?include=`, for the same reason `/portfolio` is not: it is a series
 * per trader, and a page of them would be the largest response this API can produce.
 */
/**
 * Parse and validate the three AUM query parameters, once.
 *
 * Shared so the individual route and the batch route cannot drift on what a window means or
 * which steps exist -- GENIE_FOMO_V7_BATCH_AUM_TDR.md §4 requires the two to agree exactly,
 * and the cheapest way to guarantee that is to have one of them.
 */
function aumOptions(url: URL): { windowKey: string; stepRaw: string | null; chainKey: string } {
  const asked = (url.searchParams.get("window") ?? "1w").trim();
  const windowKey = resolveWindow(asked);
  if (windowKey === null) {
    throw badRequest(
      `'window' must be one of ${Object.keys(AUM_WINDOWS).join(", ")} — got '${asked}'. ` +
      `Also accepted: ${Object.keys(WINDOW_ALIASES).join(", ")}, in any case.`,
      { parameter: "window" },
    );
  }
  const stepRaw = url.searchParams.get("step");
  /* Steps take the same courtesy: `1H` and `6H` are the same request as `1h` and `6h`. */
  if (stepRaw !== null &&
      !AUM_STEPS.some((s) => s.name === stepRaw.trim().toLowerCase())) {
    throw badRequest(
      `'step' must be one of ${AUM_STEPS.map((s) => s.name).join(", ")} — got '${stepRaw}'`,
      { parameter: "step" },
    );
  }
  return { windowKey, stepRaw, chainKey: (url.searchParams.get("chain") ?? "").trim().toLowerCase() };
}



/**
 * Build one trader's AUM envelope from rows already fetched.
 *
 * Pure: it does no I/O, so the same rows always produce the same answer. That is what lets
 * `POST /v1/traders/aum` return a row identical to `GET /v1/traders/:id/aum` instead of a
 * summary that drifts from it.
 */
function buildAum(
  t: { handle: string; display_handle: string },
  rows: Record<string, unknown>[],
  chainRows: Record<string, unknown>[],
  presence: { chains: number; on_solana: boolean; on_evm: boolean } | null,
  opts: {
    windowKey: string; stepRaw: string | null;
    chainFilter: { network_id: number; name: string } | null; to: Date;
    /** Every point's chain split, keyed "<iso at>|<basis>". Null when not fetched. */
    pointChains?: Map<string, { chain: string; usd: number | null }[]> | null;
    /** Every chain this trader uses, window-independent. Null when not fetched. */
    knownChains?: KnownChain[] | null;
    /** Each chain's own coin and what one costs, for the native amounts on `chains[]`. */
    natives?: Map<number, NativePrice> | null;
    sampler?: { lastAt: Date | null; lastSuccess: Date | null };
  },
) {
  const { windowKey, stepRaw, chainFilter, to } = opts;
  const span = AUM_WINDOWS[windowKey];
  const from = span === null ? null : new Date(to.getTime() - span);

  /*
   * A FIGURE BUILT FROM ALMOST NONE OF A WALLET IS NOT A BALANCE.
   *
   * Section 9 has always said `totalUsd` is null, never a smaller number, when a wallet could
   * not be read. That rule was applied to outright refusals and not to the case that actually
   * bites: a point that DID answer, for 1.7% of the wallet.
   *
   * Measured over thirty days: the median REBUILT point prices 1.7% of its trader's value,
   * and 6,133 of 7,815 price under a tenth. The median SAMPLED point prices 66.7%. So the
   * rebuilt history is thinly priced by construction -- and drawing it as a balance line
   * produces exactly what the consumer reported: $40 to $389,797 between two neighbouring
   * points, with no method change and no chain change to explain it. 1,226 of 3,033 jumps of
   * half or more had no declared cause, and on those the lower side priced a median 1.2%.
   *
   * No break marker fixes that, because both sides are thin: the ratio between 1.2% and 1.5%
   * is nothing, while the dollar figures differ by a thousandfold. The honest answer is the
   * one this document already gives everywhere else -- refuse the number and say why. The
   * point still exists, `gaps[]` still lists it, and a chart breaks its line there instead of
   * drawing through a figure that is wrong in a way no consumer could detect.
   *
   * PRICED_FLOOR is the one number that decides this. It is deliberately a single constant,
   * and the trade at each setting was measured against the consumer's own metric -- jumps of
   * half or more on the month window that carry no declared cause:
   *
   *     floor   traders who can draw     undeclared jumps
   *     none            432                    1,226
   *     0.10            416                      254
   *     0.20            408                      158   <- here
   *     0.30            393                      122
   *
   * 0.20 halves the residual for the cost of eight traders. Of the 158 that remain, 66 have
   * both sides pricing over half the wallet -- those are most likely real moves, and marking
   * them would be a false alarm rather than a fix.
   *
   * RAISED TO 0.25 for the v10 acceptance tests, which ask for a quarter rather than a fifth.
   * Measured at 0.20: 341 points were served as a balance on a value share between 20.0% and
   * 24.6%, and none below 20%. Those 341 are exactly what this move converts into refusals.
   *
   * A MINIMUM PRICED-POSITION COUNT BELONGS HERE TOO, and cannot be added yet.
   *
   * Measured on unipcs, 18 August: the whole book was refused at a 0.32% priced share, and so
   * were robinhood and solana on the same reading. `bsc` was SERVED, at a 50% share, because
   * bsc held two positions and one of them was priced -- so a consumer summing chains built a
   * $0.44 chart for a man the service itself refused to price. A share alone cannot catch
   * that; it needs the count behind the share.
   *
   * `aum_chain_samples` does not carry one. The chain query below selects
   * `null::int as priced_positions` because the column does not exist, so a count-based guard
   * would silently never fire on exactly the path that needs it. Adding it is a migration
   * plus a rebuild, not a read-path change.
   */
  const PRICED_FLOOR = 0.25;
  /*
   * THE REFUSED FIGURE IS KEPT, not discarded.
   *
   * Refusing a thin point is right: served as `totalUsd` it is a balance, and a balance built
   * from 3% of a wallet is wrong in a way no consumer can detect. But the number was computed
   * from real positions at a real moment, and throwing it away meant a month of history with
   * three drawable points out of twenty-seven -- the other twenty-four existed and said
   * nothing at all.
   *
   * So the refusal stands and the arithmetic survives beside it. `partialUsd` is the figure as
   * computed, carrying the coverage it was computed at, and it is NEVER `totalUsd`: a caller
   * has to reach for it deliberately, and cannot mistake it for a balance the service stands
   * behind. Plot it as a faint line, a shaded band, a tooltip -- but not as his money.
   */
  rows = rows.map((r) => {
    const share = n(r.value_share);
    if (n(r.total_usd) === null || share === null || share >= PRICED_FLOOR) return r;
    return {
      ...r,
      total_usd: null,
      refused_reason: "too_little_priced",
      /** What `total_usd` would have been. Not a balance — see the note above. */
      partial_usd: n(r.total_usd),
    };
  });

  /*
   * THE READING JUST BEFORE THE WINDOW IS KEPT, as an anchor.
   *
   * History steps once a day, so a 24-hour window contained at most one point and usually
   * none -- `window=1d` drew nothing for anybody. But a one-day chart wants exactly two
   * figures: what he was worth at the start of the day and what he is worth now. We hold
   * both; the older one simply sat one row outside the filter.
   *
   * So the newest reading BEFORE the window joins the series, marked `outsideWindow` so it is
   * never mistaken for one inside it. `reach.coveredFrom` reports where the line really
   * starts. This also stops 7d and 30d beginning a day late for the same reason.
   */
  const inWindow = from === null ? rows : rows.filter((r) => Date.parse(String(r.at)) >= from.getTime());
  const before = from === null
    ? []
    : rows.filter((r) => Date.parse(String(r.at)) < from.getTime());

  /*
   * Reach back far enough for a LINE, not just for one point.
   *
   * One anchor is not always enough. History steps once a day and the newest step can be a
   * day and a half old, so the last 24 hours held nothing and the single preceding reading
   * gave one point -- still not a line. Taking preceding readings until the series holds two
   * turns `window=1d` into the two figures a one-day chart actually wants.
   *
   * Nothing here is invented: every point is a real dated reading, the ones from before the
   * window carry `outsideWindow`, and `reach.coveredFrom`/`coveredTo` report the span the
   * line truly covers rather than the span that was asked for.
   */
  /*
   * BORROWED POINTS MUST SHARE THE NEWEST POINT'S BASIS.
   *
   * Two numbers valued on different bases are not a line. unipcs held a sampled reading of
   * $15,665,318 and a rebuilt one of $5,101,125 eight hours apart -- a 67% fall that never
   * happened, because the two count different things. Borrowing across that seam would have
   * drawn exactly the cliff the whole basis/tier distinction exists to prevent.
   *
   * So a borrowed reading has to be the same kind as the one it is being compared with.
   */
  const NEED = 2;
  const newestBasis = rows.length ? String(rows[rows.length - 1].basis) : null;
  const comparable = newestBasis === null
    ? before
    : before.filter((r) => String(r.basis) === newestBasis);

  /*
   * Borrow until the series holds two readings THAT CARRY A FIGURE.
   *
   * Counting rows rather than figures was not enough: GeorgeDroid holds 28 real points, but
   * his two most recent rebuilt readings are both refused, so taking "the last two rows"
   * took two blanks and drew nothing. A refused day is not half a line.
   */
  const hasFigure = (r: Record<string, unknown>) => n(r.total_usd) !== null;
  const anchors: Record<string, unknown>[] = [];
  let have = inWindow.filter(hasFigure).length;
  for (let i = comparable.length - 1; i >= 0 && have < NEED; i--) {
    anchors.unshift(comparable[i]);
    if (hasFigure(comparable[i])) have++;
  }
  const windowed = [...anchors, ...inWindow];
  const anchorAts = new Set(anchors.map((r) => new Date(String(r.at)).toISOString()));

  /*
   * THE DEFAULT STEP IS THE COARSER OF WHAT THE WINDOW AFFORDS AND WHAT THE DATA HOLDS.
   *
   * It used to be the first of those alone: the coarsest step leaving at least 24 points in
   * the requested span, so a week does not arrive as 168 points nobody plots and a day does
   * not collapse to 1. That is a sound rule about the WINDOW and says nothing about the
   * readings, so every one of the 435 weeks declared 6h steps over readings a day apart --
   * 566 of the gaps between neighbouring readings measured 24 hours, against 156 at 8 and
   * 258 at 16. The answer described itself wrongly, which is its own kind of untrue figure.
   *
   * So the observed spacing sets a floor. A week over daily readings declares 1d, and starts
   * declaring 6h on its own the day the readings are actually six-hourly.
   */
  const rawGaps: number[] = [];
  for (let i = 1; i < windowed.length; i++) {
    const g = Date.parse(String(windowed[i].at)) - Date.parse(String(windowed[i - 1].at));
    if (Number.isFinite(g) && g > 0) rawGaps.push(g);
  }
  rawGaps.sort((a, b) => a - b);
  /** Median, not mean: one long gap after a quiet spell must not coarsen the whole series. */
  const observedStepMs = rawGaps.length ? rawGaps[Math.floor(rawGaps.length / 2)] : 0;

  const chosen = stepRaw !== null
    ? AUM_STEPS.find((s) => s.name === stepRaw.trim().toLowerCase())!
    : [...AUM_STEPS].reverse().find((s) =>
        span === null || Math.floor(span / s.ms) >= 24
      ) ?? AUM_STEPS[0];

  /*
   * WHAT IS DECLARED IS NOT WHAT IS BUCKETED, and conflating them costs real readings.
   *
   * `chosen` is the bucket the points are thinned into, and it must stay as fine as the
   * window affords: coarsening it to match the data merged both of one trader's 10 September
   * readings into one and returned five points where six exist. Thinning is for keeping a
   * chart plottable, not for making the label true.
   *
   * `declared` is what the answer CALLS its step, and that has to match the readings. It is
   * the coarsest step that covers the observed spacing, so a week over daily readings says
   * 1d and begins saying 6h by itself the day the readings are six-hourly.
   *
   * A caller who names a step gets that step in both places: they asked, and the answer
   * should not argue. `observedStepMs` still reports what the data does either way.
   */
  const declared = stepRaw !== null
    ? chosen
    : (AUM_STEPS.find((x) => x.ms >= Math.max(chosen.ms, observedStepMs))
       ?? AUM_STEPS[AUM_STEPS.length - 1]);

  /*
   * Thin by keeping the LAST point in each bucket rather than the first or an average.
   * Averaging would invent a balance he never held, and a refused hour averaged with a
   * measured one would launder the refusal into a number.
   */
  const kept = new Map<number, Record<string, unknown>>();
  for (const r of windowed) {
    const ms = Date.parse(String(r.at));
    if (!Number.isFinite(ms)) continue;
    kept.set(Math.floor(ms / chosen.ms), r);
  }
  const points = [...kept.values()].map((r) => ({
    at: new Date(String(r.at)).toISOString(),
    totalUsd: round(n(r.total_usd)),
    /**
     * THE FIGURE BEHIND A REFUSAL. Present only when this point was refused for thin pricing,
     * null otherwise.
     *
     * Not a balance, and deliberately not `totalUsd`. It is what the priced positions summed
     * to at this moment, and `coverage.valueShare` says how much of him that was. A month
     * window that draws three points out of twenty-seven has twenty-four of these: real
     * arithmetic over real positions, too thin to publish as his money, too informative to
     * throw away. Draw it faint, or on request, or not at all — but never as the line.
     */
    partialUsd: round(n((r as { partial_usd?: unknown }).partial_usd)),
    basis: r.basis as string,
    tier: r.tier as string,
    coverage: {
      pricedPositions: r.priced_positions === null ? null : Number(r.priced_positions),
      totalPositions: r.total_positions === null ? null : Number(r.total_positions),
      /**
       * `valueShare` IS NOT A SHARE OF VALUE, and the name has misled for long enough.
       *
       * It is `pricedPositions ÷ totalPositions` -- a COUNT. Measured on poopinyourhands:
       * 18 priced of 20 positions, valueShare 0.9, and 18÷20 = 0.9 exactly. The consumer
       * caught this and is right: a trader whose one real holding is fully priced but who
       * carries sixteen dust positions reads as thin and gets refused by a floor built on
       * this number, when by value we have priced essentially everything he owns.
       *
       * A TRUE share of value cannot be computed and never could: the unpriced positions are
       * unpriced, so their value is unknown by definition. Pretending otherwise would be a
       * worse answer than a badly named one.
       *
       * So the field is named honestly alongside, and the old name keeps working. Read
       * `pricedPositionShare`; `valueShare` is the same number under a name that lies about
       * what it counts.
       */
      pricedPositionShare: n(r.value_share),
      /** @deprecated A count ratio, not a share of value. Read `pricedPositionShare`. */
      valueShare: n(r.value_share),
      /*
       * HOW MUCH OF HIM THIS DAY IS, per point rather than per response.
       *
       * A rebuilt day used to be refused outright unless every chain answered at it, which
       * refused 8,894 days across the directory while the per-chain figures for those days
       * existed all along. The day is now stated with the chains that answered -- and these
       * two numbers are the reason that is safe. `chainsAnswered` below `chainsTotal` means
       * the total is a real figure for PART of him, and a consumer can decide whether to
       * draw it. Null on a single-chain series, where the question does not apply.
       */
      chainsAnswered: r.chains_answered === null ? null : Number(r.chains_answered),
      chainsTotal: r.chains_expected === null ? null : Number(r.chains_expected),
      /*
       * PARTIAL MEANS THE FIGURE IS INCOMPLETE, by whichever route it got that way.
       *
       * It used to mean only "a chain is missing", so 106 readings priced less than all of
       * their value and still said `partial: false`. A total built from 63% of a wallet is
       * partial whether the missing 37% is a whole chain or a thousand unpriced coins.
       */
      partial: (() => {
        const chainsShort = r.chains_answered !== null && r.chains_expected !== null &&
          Number(r.chains_answered) < Number(r.chains_expected);
        const share = n(r.value_share);
        const priceShort = share !== null && share < 1;
        return (r.chains_answered === null || r.chains_expected === null) && share === null
          ? null
          : (chainsShort || priceShort);
      })(),
      /** Which of the two made it partial, so a consumer can tell them apart. */
      partialReason: (() => {
        const chainsShort = r.chains_answered !== null && r.chains_expected !== null &&
          Number(r.chains_answered) < Number(r.chains_expected);
        const share = n(r.value_share);
        const priceShort = share !== null && share < 1;
        if (chainsShort && priceShort) return "chains_missing_and_unpriced_positions";
        if (chainsShort) return "chains_missing";
        if (priceShort) return "unpriced_positions";
        return null;
      })(),
    },
    ...(r.refused_reason ? { refused: r.refused_reason as string } : {}),
    /** True for a real dated reading borrowed from just before the requested window. */
    ...(anchorAts.has(new Date(String(r.at)).toISOString()) ? { outsideWindow: true } : {}),
  }));

  /*
   * ===================== THE SEAM BETWEEN TWO KINDS OF POINT =====================
   *
   * Section 9 already says a sampled figure and a rebuilt one count different things, and
   * refuses to borrow across that seam. The series itself was not held to the same rule: two
   * neighbouring points could be valued over different sets of chains, and the difference was
   * printed as a move in the balance. `fhn_gt` read $65,367.54, then $33.26, then $52,276.29,
   * and a card said "+155,855.5% in 7 days". He did not lose 99.9% of his money -- the second
   * point answered for robinhood alone, having dropped the ethereum leg the first one had.
   *
   * The consumer asked for three things, best first. What each one costs, measured over the
   * last week across all 435 traders (1,418 consecutive valued steps, 865 of which move the
   * line by half or more):
   *
   *   1. "Value both kinds the same way." NOT POSSIBLE from what is stored, and the reason is
   *      specific rather than a shrug. Per chain, a rebuilt point prices 39% of the positions
   *      on average and a sampled one 77-84%; the cliffs concentrate exactly on the steps that
   *      cross between them (60% of sampled-after-rebuilt steps, 74% of rebuilt-after-sampled,
   *      against 14% of sampled-after-sampled). Equalising that needs the per-token history the
   *      rebuild did not keep -- only the per-chain totals were stored. Valuing every point
   *      over the chains they all share was tried and measured: it removes the chain-set
   *      cliffs and leaves the coverage ones, 548 of 1,074 steps still moving by half or more.
   *      A column called "comparable" that is wrong half the time is the failure this API is
   *      organised against, so it is not published.
   *
   *   2. "Mark every change of method." Done, and WIDENED, because as asked it would have
   *      missed a quarter of them: 542 of the 865 big moves change `basis`, but 226 more keep
   *      the same method and change the set of chains -- both of `fhn_gt`'s first two steps
   *      among them. Marking either catches 768 of 865.
   *
   *   3. "Failing both, don't call it drawable." Not needed, and not done: `drawable` stays
   *      the service's answer about whether a line exists, which is a different question, and
   *      85% of rebuilt points are partial -- refusing all of them would delete the history
   *      rather than describe it.
   */
  const pointChains = opts.pointChains ?? null;
  const keyOf = (at: string, basis: string) => `${at}|${basis}`;

  /** The chains a point actually put a number on. Empty when we hold no split for it. */
  const chainsAt = (at: string, basis: string): string[] => {
    if (!pointChains) return [];
    const rowsHere = pointChains.get(keyOf(at, basis)) ?? [];
    const names = rowsHere.filter((x) => x.usd !== null).map((x) => x.chain);
    // A one-chain series has no chain-set question to answer; it is already comparable.
    return (chainFilter ? names.filter((c) => c === chainFilter.name) : names).sort();
  };

  /*
   * EVERY SEAM BETWEEN TWO VALUED POINTS, in either direction. A change of method and a
   * change of chain set are both reasons two figures cannot be subtracted, and a step can be
   * both at once. This is a statement about what the two numbers COUNT, not about how far
   * apart they are: a step that changed composition and barely moved is still marked, because
   * the next one like it will move a great deal.
   */
  const valued = points.filter((p) => p.totalUsd !== null);
  const breaks: {
    at: string; previousAt: string; reason: string;
    chainsAdded: string[]; chainsRemoved: string[];
    pricedShareBefore: number | null; pricedShareAfter: number | null;
  }[] = [];
  /** The source row behind each returned point, for the priced share the point does not carry. */
  const valuedRowByKey = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    valuedRowByKey.set(
      `${new Date(String(r.at)).toISOString()}|${r.basis}`, r);
  }
  /*
   * A THIRD REASON, AND IT IS THE COMMONEST ONE.
   *
   * Method and chain set were the two I marked, and I tested a priced-share rule once, on the
   * WEEK window at a ten-point threshold, found it bought 21 catches for 25 extra marks, and
   * dropped it. That was the wrong window and the wrong threshold. On the MONTH window 1,261
   * of 2,768 jumps of half or more carry no break at all -- 46% -- and on those jumps the
   * lower point prices a median 1.5% of the trader's value. One measured example: a line went
   * $358,325 -> $1,132,934 drawn from 3 of 2,477 priced holdings, same chains, same method.
   *
   * That is not a move in the balance, it is a move in how much of the wallet we could see.
   * So a material change in priced share is a break, on the same footing as the other two.
   *
   * The threshold is a RATIO, not a difference in points: 63% against 60% is the same picture
   * twice, while 1.5% against 60% is two different pictures. A doubling either way is the
   * line at which the smaller reading is no longer measuring the same trader.
   */
  const SHARE_RATIO = 2;
  const shareAt = (p: { at: string; basis: string }): number | null => {
    const row = valuedRowByKey.get(`${p.at}|${p.basis}`);
    return row ? n(row.value_share) : null;
  };

  for (let i = 1; i < valued.length; i++) {
    const prev = valued[i - 1], cur = valued[i];
    const a = chainsAt(prev.at, prev.basis), b = chainsAt(cur.at, cur.basis);
    const added = b.filter((c) => !a.includes(c));
    const removed = a.filter((c) => !b.includes(c));
    const methodChanged = prev.basis !== cur.basis;
    const chainsChanged = added.length > 0 || removed.length > 0;

    const ps = shareAt(prev), cs = shareAt(cur);
    const shareChanged = ps !== null && cs !== null && ps > 0 && cs > 0 &&
      Math.max(ps / cs, cs / ps) >= SHARE_RATIO;

    if (!methodChanged && !chainsChanged && !shareChanged) continue;
    const why: string[] = [];
    if (methodChanged) why.push("method");
    if (chainsChanged) why.push("chains");
    if (shareChanged) why.push("priced_share");
    breaks.push({
      at: cur.at,
      previousAt: prev.at,
      reason: why.join("_and_") + "_changed",
      chainsAdded: added,
      chainsRemoved: removed,
      /** The share of value each side priced, so the size of the change is visible. */
      pricedShareBefore: ps,
      pricedShareAfter: cs,
    });
  }
  const breakAt = new Set(breaks.map((b) => b.at));

  /** The seam fields live on the point, so a chart reading `points[]` alone still sees them. */
  const pointsOut = points.map((p, i) => ({
    ...p,
    /**
     * The chains this point put a number on, by name. `coverage.chainsAnswered` gives the
     * count; this says WHICH, which is what makes a step explicable rather than mysterious.
     */
    chains: chainsAt(p.at, p.basis),
    /**
     * False when this figure and the one before it do not count the same thing. Never measure
     * a percentage across a `false` -- break the line there. Null on the first point, which
     * has nothing before it.
     */
    comparableWithPrevious: i === 0 || p.totalUsd === null ? null : !breakAt.has(p.at),
  }));

  /**
   * The moment real sampling began. Everything before it is a marked rebuild, everything
   * after is measured, and the response never blurs the two together.
   */
  /*
   * WINDOW-INDEPENDENT, both of them. What a trader is worth right now does not depend on how
   * much of his past you asked for, and computing these from the windowed rows meant asking
   * for one day hid the current total entirely -- `now: null` on a trader carrying a month of
   * history and a $5.1M balance.
   */
  const firstSampled = rows.find((r) => r.basis === "sampled");
  const trackedSince = firstSampled ? new Date(String(firstSampled.at)).toISOString() : null;

  /*
   * `now` IS THE MOST COMPLETE RECENT READING, NOT SIMPLY THE NEWEST.
   *
   * It used to be the last row by time, and that published a number three times too small.
   * When the sampler fell behind, the newest row became a REBUILT point covering 1 of a
   * trader's 5 chains, and unipcs was reported at $5.1M -- eight hours after a measured
   * reading of $15.7M, against a portfolio route saying $15.8M. The figure people read first
   * was a fifth of him, presented as all of him.
   *
   * So completeness wins over recency: the newest reading that answered for every chain he is
   * known to be on, falling back to the newest that answered for the most of them, and only
   * then to the newest row at all. Recency still breaks ties, so a fresh full reading always
   * beats a stale one.
   */
  const withFigure = rows.filter((r) => n(r.total_usd) !== null);
  const cover = (r: Record<string, unknown>) =>
    r.chains_answered === null || r.chains_answered === undefined ? -1 : Number(r.chains_answered);
  const wanted = (r: Record<string, unknown>) =>
    r.chains_expected === null || r.chains_expected === undefined ? -1 : Number(r.chains_expected);

  let newest: Record<string, unknown> | null = null;
  if (withFigure.length) {
    /*
     * RECENT FIRST, THEN COMPLETE. Completeness alone is not enough -- ranking purely on it
     * picked a five-day-old rebuild covering 5 of 5 chains over a measured reading taken that
     * morning covering 4 of 5, which is a different way of publishing the wrong number.
     *
     * So only readings close to the freshest one compete, using the same 36-hour allowance
     * the sampler is judged by. Among those: widest coverage wins, a measured reading beats an
     * inferred one at equal coverage, and recency settles the rest.
     */
    const freshest = Date.parse(String(withFigure[withFigure.length - 1].at));
    const RECENT_MS = 36 * 3_600_000;
    const recent = withFigure.filter((r) => freshest - Date.parse(String(r.at)) <= RECENT_MS);
    const pool = recent.length ? recent : [withFigure[withFigure.length - 1]];

    const score = (r: Record<string, unknown>): [number, number, number] => [
      cover(r),
      r.basis === "sampled" ? 1 : 0,
      Date.parse(String(r.at)),
    ];
    let best = pool[0];
    for (const r of pool) {
      const a = score(r), b = score(best);
      if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) best = r;
    }
    newest = best;
  } else if (rows.length) {
    // Every reading was refused. The newest one still carries the reason, which is the answer.
    newest = rows[rows.length - 1];
  }

  /*
   * REACH -- what the stored data actually covers, as opposed to what was asked for.
   * `from` echoes the request and is not evidence of anything; a caller that reads it as
   * coverage will label a one-point series "30D".
   */
  const firstAt = points.length ? Date.parse(points[0].at) : null;
  const lastAt  = points.length ? Date.parse(points[points.length - 1].at) : null;
  const requestedDays = span === null ? null : Math.round(span / 86_400_000);
  /*
   * ANCHOR POINTS ARE EXCLUDED FROM `coveredDays`, because they were not asked for.
   *
   * A 1d window keeps one real reading from just BEFORE the window so a single-point chart
   * has something to compare against (see the anchor block above), and marks it
   * `outsideWindow: true`. Counting it made `coveredDays: 2` against `requestedDays: 1` on
   * 431 of 448 one-day answers -- a consumer testing the documented
   * `coveredDays <= requestedDays` relation failed on 96% of them.
   *
   * The anchor is still SERVED and still flagged; it is simply not counted as coverage of a
   * window it sits outside. `reach.anchorPoints` says how many were borrowed, so the
   * difference between what is drawn and what was requested stays visible.
   */
  const inWindowPoints = points.filter((p) => !(p as { outsideWindow?: boolean }).outsideWindow);
  const anchorPoints = points.length - inWindowPoints.length;
  const covFirst = inWindowPoints.length ? Date.parse(inWindowPoints[0].at) : firstAt;
  const covLast = inWindowPoints.length
    ? Date.parse(inWindowPoints[inWindowPoints.length - 1].at) : lastAt;
  const coveredDays = covFirst !== null && covLast !== null
    ? Math.max(0, Math.round((covLast - covFirst) / 86_400_000))
    : 0;

  /*
   * DOES THE DATA REACH BACK TO WHAT WAS ASKED FOR -- measured as a gap, not a day count.
   *
   * The first version compared coveredDays against requestedDays, which is off by one bucket
   * by construction: thirty daily points span twenty-nine days of difference, so a complete
   * month always reported 29 of 30 and `complete: false`. pointfarmcap had all thirty days
   * present and valued and still failed the PRD's own acceptance test.
   *
   * What actually matters is whether the oldest point we hold sits at or before the start of
   * the requested window, allowing one step of slack -- a daily series cannot be expected to
   * land exactly on a boundary computed to the millisecond.
   */
  /*
   * The slack is the DATA's granularity, not the requested step. Rebuilt history is daily, so
   * a week asked for at six-hour steps would judge a complete daily series "short" purely
   * because its oldest point sits a day inside a boundary computed to the millisecond. That
   * is a category error, not a coverage gap -- pointfarmcap held all thirty days and was
   * reported short on the 1w window. So the tolerance is the larger of the requested step and
   * the median spacing of the points we actually hold.
   */
  const spacings: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const gap = Date.parse(points[i].at) - Date.parse(points[i - 1].at);
    if (Number.isFinite(gap) && gap > 0) spacings.push(gap);
  }
  spacings.sort((a, b) => a - b);
  const medianGap = spacings.length ? spacings[Math.floor(spacings.length / 2)] : 0;
  const slack = Math.max(chosen.ms, medianGap);

  const reachesBack = from === null
    ? points.length > 0
    : firstAt !== null && firstAt - from.getTime() <= slack;

  /*
   * TWO DATED FIGURES ARE A LINE. One never is.
   *
   * This threshold was three, taken from the compatibility rule in
   * GENIE_FOMO_V7_BATCH_AUM_AND_COVERAGE_PRD.md -- but that rule is what the CONSUMER applies
   * when we decline to say anything, not what we should demand of ourselves. Their own
   * measurement states the rule they actually draw by: "two or more real points, which is the
   * owner's rule (one point is never a line)". Holding out for a third made a real two-point
   * series undrawable and put our flag out of step with the figures we report.
   */
  /*
   * A ZERO THAT NOTHING ANSWERED FOR IS NOT A ZERO.
   *
   * Section 9 says a trader whose wallets all answered and held nothing reads `0`, and that
   * zero is a measurement. The rule was right and the CHECK was missing: nothing verified
   * that a wallet had answered. 72 of 432 ready traders returned exactly $0 with no chain
   * count, no priced share and no positions, and 71 of them were still marked drawable -- so
   * a consumer following the flag drew a flat $0 line for a trader whose wallets are on known
   * chains and hold real coins.
   *
   * An empty read is a refusal. It is told apart from a real zero by the coverage beside it:
   * a measured zero answered for at least one chain or looked at at least one position.
   */
  const emptyRead = (r: Record<string, unknown> | null): boolean => {
    if (!r) return false;
    if (n(r.total_usd) !== 0) return false;
    const chains = r.chains_answered === null || r.chains_answered === undefined
      ? 0 : Number(r.chains_answered);
    const looked = r.total_positions === null || r.total_positions === undefined
      ? 0 : Number(r.total_positions);
    return chains === 0 && looked === 0;
  };
  /*
   * TWO WAYS TO HAVE NOTHING, and both must stop `ready`.
   *
   *   a zero nothing answered for  -- total 0, no chains, no positions   (72 traders)
   *   no figure at all             -- every reading refused               (seen live)
   *
   * The second was reported as `ready` even after the first was fixed, because a refused row
   * is still a row and the fallback picked it up.
   */
  const newestIsEmpty = emptyRead(newest) || withFigure.length === 0;

  const MIN_DRAWABLE_POINTS = 2;
  const usable = points.filter((p) => p.totalUsd !== null);
  let drawable = true;
  let reason: string | null = null;
  if (newestIsEmpty) {
    /*
     * Nothing answered for this trader at the newest reading. Not drawable, and not `ready`
     * below -- the series would otherwise be a flat line at zero drawn from nothing.
     */
    drawable = false;
    reason = "nothing_answered";
  } else if (usable.length < MIN_DRAWABLE_POINTS) {
    /*
     * Fewer than three numbers. Which of these it is matters: a backfill that has not
     * finished is temporary and worth waiting for, a refusal is not.
     */
    drawable = false;
    reason = newest?.refused_reason
      ? String(newest.refused_reason)
      : (usable.length === 0 ? "warming" : "too_few_points");
  } else if (!reachesBack) {
    // Enough points to draw, but not across the span that was asked for. Both facts are true
    // and the consumer needs the second one to label its axis honestly.
    drawable = false;
    reason = "short_coverage";
  }

  /** Gaps are returned, never smoothed over. A chart breaks its line at each of these. */
  /*
   * EACH GAP CARRIES THE SPAN IT COVERS, not just the moment it sits at.
   *
   * `at` alone says where the hole is; `from`/`to` say how wide. A consumer drawing a broken
   * line needs the width -- it is the difference between a dot and a segment -- and the
   * consumer's own field contract asks for all three: "Each carries at, from, to, reason."
   *
   * The span is the bucket this point occupies: from its own moment to the next point's, or
   * to the end of the window when it is the last. Consecutive refusals therefore describe a
   * continuous hole rather than a row of unconnected dots.
   */
  const gaps = points
    .map((p, i) => ({ p, next: points[i + 1] }))
    .filter(({ p }) =>
      p.totalUsd === null &&
      /*
       * A REFUSED ANCHOR IS NOT A GAP IN THIS WINDOW.
       *
       * The anchor is a reading borrowed from BEFORE the window so a short chart has a
       * baseline; it is served and flagged `outsideWindow`. When it happens to be refused it
       * was also landing in `gaps[]`, dated before `from` — and a consumer walking gaps to
       * draw holes inside the window got one outside it, which is both wrong and a violation
       * of the stated `every gap falls inside from..to`. Four answers did this.
       *
       * The point itself still carries its `refused` word, so nothing is hidden; it simply is
       * not described as a hole in a window it was never part of.
       */
      !(p as { outsideWindow?: boolean }).outsideWindow)
    .map(({ p, next }) => ({
      at: p.at,
      from: p.at,
      /**
       * The next reading's moment, or this point's own when it is the last.
       *
       * NOT the window's end, which is computed from the clock: that made the final gap's
       * span widen by a few milliseconds on every request, so two reads seconds apart
       * disagreed about a hole that had not moved.
       */
      to: next?.at ?? p.at,
      reason: (p as { refused?: string }).refused ?? "no_prices",
    }));

  /*
   * How much of the trader the newest point could see, in wallets and chains. A chain we
   * hold no row for did not contribute zero dollars -- it contributed nothing at all.
   */
  /*
   * TOTAL CHAINS COMES FROM THE SAME UNION `knownChains` DOES, not from what is held today.
   *
   * `presence` counts `holdings_current where human_amount > 0` -- chains the trader holds
   * something on RIGHT NOW. `answeredNets` below counts chains that produced a reading. A
   * trader who has sold out of a chain still has readings there, so answered exceeded total
   * for twelve traders: RunningClam reported 5 of 4, gundam 4 of 3, 0xkuidian 3 of 2. A
   * coverage ratio above 1 is not a coverage ratio.
   *
   * `opts.knownChains` is already built from the union of wallet_chain_presence,
   * holdings_current and aum_chain_samples, and is already carried on this envelope, so this
   * costs no query. Falls back to the old count when it was not fetched.
   */
  const totalChains = opts.knownChains?.length ?? Number(presence?.chains ?? 0);

  const answeredNets = new Set(
    chainRows.filter((r) => r.total_usd !== null).map((r) => Number(r.network_id)));
  /*
   * TOTAL WALLETS FROM THE SAME UNION AS THE CHAINS, for the reason `totalChains` above moved.
   *
   * `presence` counts wallet families the trader holds something on RIGHT NOW. `answeredNets`
   * counts families that produced a reading, and a trader who has sold out of a family still
   * has readings there — so answered exceeded total for gmgn_0xc91063fd on all four windows,
   * which is a coverage ratio above 1 and therefore not a coverage ratio.
   *
   * `knownChains` already unions presence, holdings and chain samples, so the families it
   * names are the honest denominator. Falls back to the old count when it was not fetched.
   */
  const totalWallets = opts.knownChains?.length
    ? (opts.knownChains.some((c) => Number(c.networkId) !== SOLANA_NET) ? 1 : 0) +
      (opts.knownChains.some((c) => Number(c.networkId) === SOLANA_NET) ? 1 : 0)
    : (presence?.on_evm ? 1 : 0) + (presence?.on_solana ? 1 : 0);
  const answeredWallets =
    ([...answeredNets].some((x) => x !== SOLANA_NET) ? 1 : 0) +
    (answeredNets.has(SOLANA_NET) ? 1 : 0);
  /*
   * IS THE NEWEST READING SHORT OF A CHAIN -- asked of the ENVELOPE when the reading cannot say.
   *
   * `partial` used to be computed from the reading's own `chains_answered` / `chains_expected`
   * alone. Those are frequently null, and when they are, only the pricing share is left -- so
   * an answer missing a whole chain reported `partial: false`. 268 answers did exactly that.
   * ethersole: `coverage` said 3 chains of 4 and 1 wallet of 2, while `now.partial` said false
   * and `status` said ready. Two blocks of one answer disagreeing about whether it is complete.
   *
   * The envelope's own counts are computed just above and know better, so they are the
   * fallback. The reading's own numbers still win when it has them -- they describe that
   * reading, where the envelope describes the trader.
   */
  const newestPartial = (() => {
    const r = newest;
    if (!r) return { partial: null as boolean | null, reason: null as string | null };
    const ownCover = cover(r), ownWanted = wanted(r);
    const hasOwn = ownCover >= 0 && ownWanted >= 0;
    /*
     * EITHER MEASURE SAYING "SHORT" MAKES IT SHORT, and it has to be an OR rather than a
     * preference for the reading's own numbers.
     *
     * The two count different things. A reading's `chains_expected` is what that read went and
     * ASKED -- the sampler only reaches an EVM chain the trader has traded tokens on. The
     * envelope's `totalChains` is every chain he is KNOWN to use, from the wider union. For
     * `enci` those are 4 and 5: his reading answered everything it asked and still covered
     * four fifths of him, so trusting the reading alone published `partial: false` beside a
     * `coverage` block that plainly said 4 of 5. Four answers did exactly that.
     *
     * Neither number is wrong; they answer different questions. The honest combination is the
     * pessimistic one -- complete means complete by both.
     */
    const ownShort = hasOwn && ownCover < ownWanted;
    const envShort = totalChains > 0 && answeredNets.size < totalChains;
    const chainsShort = ownShort || envShort;
    const share = n(r.value_share);
    const priceShort = share !== null && share < 1;
    const known = hasOwn || totalChains > 0 || share !== null;
    if (!known) return { partial: null as boolean | null, reason: null as string | null };
    return {
      partial: chainsShort || priceShort,
      reason: chainsShort && priceShort
        ? "chains_missing_and_unpriced_positions"
        : chainsShort
        ? "chains_missing"
        : priceShort
        ? "unpriced_positions"
        : null,
    };
  })();

  const warming = drawable === false && (reason === "warming" || reason === "short_coverage");
  const nextRun = new Date();
  nextRun.setUTCHours(6, 0, 0, 0);
  if (nextRun.getTime() <= Date.now()) nextRun.setUTCDate(nextRun.getUTCDate() + 1);

  /*
   * SAMPLER STATE, NAMED RATHER THAN IMPLIED.
   *
   * The sampler runs daily, so a reading inside 36 hours is on schedule -- one run plus a
   * fully missed one, the same allowance the staleness check uses. Past that the readings are
   * still true, they are simply old, and the answer has to say so instead of reporting
   * `ready` over three-day-old figures.
   *
   * `lastAttemptAt` is null on purpose: we record successes, not attempts, and inventing a
   * value would be worse than admitting the gap.
   */
  const STALE_AFTER_H = 36;
  const lastSuccess = opts.sampler?.lastSuccess ?? null;

  /*
   * THE STATE IS THIS TRADER'S, NOT THE PIPELINE'S.
   *
   * This was computed from the newest successful run anywhere in the table -- so on a night
   * the sampler ran for most of the directory, a trader whose OWN newest reading was 6.8 days
   * old still answered `current`, and `status` still said `ready`. Fourteen traders were
   * measured in exactly that state, and a consumer trusting `status` drew a week-old figure
   * as today's.
   *
   * A trader is asking about himself. The age that matters is the age of the reading he is
   * about to be shown, so that is what decides the verdict. The pipeline's own last run is
   * still reported, under a name that says what it is, because "my reading is old" and "the
   * job has stopped" are different problems with different fixes.
   */
  /*
   * The age of the FIGURE, not of the newest row.
   *
   * When every reading a trader has is refused, `newest` falls back to the newest row so its
   * reason can be reported -- but that row carries no number. Ageing it said "this trader's
   * reading is 25 hours old" about a reading that does not exist, and `status` answered
   * `ready`. A reading with no figure has no age.
   */
  const ownAgeH = newest?.at && n(newest.total_usd) !== null
    ? (to.getTime() - Date.parse(String(newest.at))) / 3_600_000
    : null;
  const sinceSuccessH = lastSuccess === null
    ? null
    : (to.getTime() - lastSuccess.getTime()) / 3_600_000;

  const samplerState = ownAgeH === null
    ? "warming"
    : (ownAgeH > STALE_AFTER_H ? "stale" : "current");

  const samplerBlock = {
    state: samplerState,
    lastAttemptAt: null,
    /** When THIS trader was last measured. The figure `state` is judged on. */
    lastSuccessAt: newest?.at ? new Date(String(newest.at)).toISOString() : null,
    ageSeconds: ownAgeH === null ? null : Math.round(ownAgeH * 3600),
    nextExpectedAt: nextRun.toISOString(),
    staleAfterHours: STALE_AFTER_H,
    reason: samplerState === "stale"
      ? `this trader's newest reading is ${ownAgeH!.toFixed(1)}h old — it is true, but old`
      : null,
    /**
     * The pipeline's own clock, for telling "my reading is old" from "the job has stopped".
     * A fresh `pipelineLastSuccessAt` beside a stale `state` means the sampler ran and did
     * not reach this trader.
     */
    pipelineLastSuccessAt: lastSuccess ? lastSuccess.toISOString() : null,
    pipelineAgeSeconds: sinceSuccessH === null ? null : Math.round(sinceSuccessH * 3600),
  };

  return {
    handle: t.display_handle,
    /** Null means the whole portfolio. A name means this series is that chain alone. */
    chain: chainFilter ? chainFilter.name : null,
    window: windowKey,
    /**
     * When the figure this answer is anchored on was taken. Every route carries `asOf` so a
     * profile can date each panel separately instead of assuming they share a moment -- they
     * do not: balances, trades and the directory are refreshed by different jobs.
     */
    asOf: newest ? new Date(String(newest.at)).toISOString() : null,
    step: declared.name,
    /** The step in milliseconds, so a consumer need not parse "6h". */
    stepMs: declared.ms,
    /** The bucket the points were thinned into, which may be finer than the step declared. */
    bucketMs: chosen.ms,
    /**
     * The median spacing of the readings actually held, in milliseconds. `step` is the bucket
     * the points are thinned into; this is what the data does. They agree unless a caller
     * asked for a step explicitly, and a consumer labelling an axis should read this one.
     */
    observedStepMs: observedStepMs || null,
    /**
     * TRUE WHEN `step` UNDERSTATES THE REAL SPACING, AND IT CANNOT SAY SO ANY OTHER WAY.
     *
     * `step` is an enum of `1h`, `6h`, `1d` — a consumer switches on it, so it stays an enum.
     * But a one-day window over readings three and a half days apart has no honest value in
     * that set: `1d` is the coarsest name available and it still overstates how close the
     * points are. Rather than quietly return the wrong one, the answer says the label is a
     * floor and `observedStepMs` carries the truth.
     */
    stepUnderstated: observedStepMs > declared.ms,
    from: from ? from.toISOString() : (points[0]?.at ?? null),
    to: to.toISOString(),
    trackedSince,
    now: newest
      ? {
        at: new Date(String(newest.at)).toISOString(),
        totalUsd: round(n(newest.total_usd)),
        /** The figure behind a refusal, when this reading was refused. See points[].partialUsd. */
        partialUsd: round(n((newest as { partial_usd?: unknown }).partial_usd)),
        /** How old this reading is, so a card can say "as of Thursday" without doing date maths. */
        ageSeconds: Math.max(0, Math.round((to.getTime() - Date.parse(String(newest.at))) / 1000)),
        /** `sampled` was read from the chain at the time; `rebuilt` was inferred afterwards. */
        basis: newest.basis as string,
        tier: newest.tier as string,
        /**
         * True when this figure covers only part of the trader — a missing chain, unpriced
         * positions, or both. `partialReason` names which.
         */
        partial: newestPartial.partial,
        partialReason: newestPartial.reason,
        /*
         * ON `now` ITSELF, not only inside `coverage`.
         *
         * The contract names `now.chainsAnswered` and `now.chainsTotal`, and a consumer
         * reading the balance reads `now` -- asking it to descend into `coverage` to find out
         * whether the figure it just printed covers the whole trader is how a partial total
         * gets published as a whole one. Both spellings carry the same value.
         */
        chainsAnswered: newest.chains_answered === null ? null : Number(newest.chains_answered),
        chainsTotal: newest.chains_expected === null ? null : Number(newest.chains_expected),
        coverage: {
          pricedPositions: newest.priced_positions === null ? null : Number(newest.priced_positions),
          totalPositions: newest.total_positions === null ? null : Number(newest.total_positions),
          /** A count ratio. See points[].coverage.pricedPositionShare for why. */
          pricedPositionShare: n(newest.value_share),
          /** @deprecated A count ratio, not a share of value. Read `pricedPositionShare`. */
          valueShare: n(newest.value_share),
          chainsAnswered: newest.chains_answered === null ? null : Number(newest.chains_answered),
          chainsTotal: newest.chains_expected === null ? null : Number(newest.chains_expected),
        },
      }
      : null,
    count: points.length,

    /** What the stored data covers, as opposed to what was requested. */
    reach: {
      requestedFrom: from ? from.toISOString() : null,
      /*
       * The span INSIDE the window. An anchor borrowed from before it is served and flagged,
       * but reporting it here would contradict `coveredDays`, which excludes it -- a consumer
       * subtracting these two dates must get the same answer the day count gives.
       * Falls back to the full range when every point we hold is an anchor.
       */
      coveredFrom: (inWindowPoints[0] ?? points[0])?.at ?? null,
      coveredTo: (inWindowPoints[inWindowPoints.length - 1]
                  ?? points[points.length - 1])?.at ?? null,
      requestedDays,
      coveredDays,
      /** Real readings borrowed from before the window so a short chart has a baseline. */
      anchorPoints,
      complete: reachesBack,
    },

    /**
     * The service's own answer to "can this be drawn". Consumers must not infer readiness
     * from `window`, `from`, `count` or the position counts.
     */
    drawing: {
      drawable, usablePoints: usable.length, reason,
      /**
       * Points carrying a `partialUsd` — real arithmetic refused as too thin to be a balance.
       *
       * Published so a consumer can tell "there is nothing here" from "there is something
       * here we will not call his balance", which are very different answers to a blank
       * chart and used to look identical.
       */
      partialPoints: pointsOut.filter((p) =>
        (p as { totalUsd: number | null; partialUsd: number | null }).totalUsd === null &&
        (p as { partialUsd: number | null }).partialUsd !== null).length,
    },

    /** Coverage of the newest point, in wallets and chains rather than positions. */
    coverage: { answeredWallets, totalWallets, answeredChains: answeredNets.size, totalChains },

    /**
     * EVERY CHAIN THIS TRADER USES, and it does not change with the window.
     *
     * `chains` below is the split of the newest reading; this is the trader. They answer
     * different questions and both are needed: draw the chain switches from this one, and
     * read `chains` for what the latest reading actually covered. `coverage` and each point's
     * `chainsAnswered` / `chainsTotal` are untouched.
     */
    knownChains: opts.knownChains ?? [],

    /**
     * `ready` — this is what we have to offer.
     * `warming` — a backfill or first sampling is still filling it.
     * `stale` — the readings are true but the sampler has not written for a while; see
     *   `sampler`. This never used to be said, and 432 of 435 answers claimed `ready` over
     *   figures three days old.
     */
    status: newestIsEmpty
      ? "no_reading"
      : (warming ? "warming" : (samplerState === "stale" ? "stale" : "ready")),

    /** When measurement last succeeded, and when it is next due. */
    sampler: samplerBlock,
    /**
     * HOW MUCH OF THE ASKED-FOR WINDOW IS ACTUALLY BEHIND THIS ANSWER, always.
     *
     * This used to be populated only while `warming`, so every settled answer served null --
     * and `window=all` therefore said nothing at all about what "all" meant. Measured: the ten
     * longest records run 1,131 to 1,685 days and `window=all` covers 35 or 36 of them, which
     * is the full extent of the stored readings rather than any statement about the trader.
     *
     * It is not a backfill that is missing. Balance history is rebuilt from stored
     * transactions, and for those ten traders the earliest transaction held is 5-11 September
     * -- there is nothing behind that date to rebuild from. So the honest answer is not a
     * promise that more is coming; it is to say what bounds the series and stop implying the
     * window covers a career.
     *
     * `boundedBy` is the load-bearing field: `window` means the answer covers what was asked,
     * `history` means the stored readings ran out first.
     */
    progress: {
      coveredDays,
      targetDays: requestedDays ?? coveredDays,
      /** Where the readings themselves begin, regardless of the window asked for. */
      historyStartsAt: trackedSince,
      boundedBy: requestedDays !== null && coveredDays >= requestedDays ? "window" : "history",
      /** Only meaningful while filling; null once the series is as long as it will get. */
      nextRunAt: warming ? nextRun.toISOString() : null,
      warming,
    },

    gaps,

    /**
     * WHY TWO NEIGHBOURING FIGURES MAY NOT BE SUBTRACTABLE, stated once for the series.
     *
     * `equalised: false` is the honest answer to "value both kinds the same way": a rebuilt
     * point and a sampled one price different fractions of the same wallet, and the per-token
     * history that would let us equalise them was never stored -- only per-chain totals were.
     * So the seam is MARKED rather than removed, and `breaks` below is where it is marked.
     */
    comparability: {
      equalised: false,
      reason: "coverage_differs_by_method",
      detail: "a rebuilt point prices about 39% of a chain's positions and a sampled one " +
              "77-84%, so the two count different fractions of the same wallet. Break the " +
              "line at every entry in `breaks` and do not measure a percentage across one.",
    },

    /**
     * EVERY SEAM, shaped like `gaps` because that is the list a chart already breaks on.
     *
     * A step appears here when the two figures do not count the same thing: the method
     * changed (`method_changed`), the set of answered chains changed (`chains_changed`), or
     * both. `chainsAdded` / `chainsRemoved` name which chains moved, so the step is
     * explicable rather than mysterious.
     *
     * `chains_changed` is the one a method marker alone would miss, and it is not rare:
     * measured over the last week across the whole directory, 226 of the 865 steps that move
     * a line by half or more keep the same method and change only the chain set.
     */
    breaks,
    points: pointsOut,
    chains: chainRows.map((r) => {
      const usd = round(n(r.total_usd));
      const nat = opts.natives?.get(Number(r.network_id)) ?? null;
      return {
        chain: r.chain as string,
        networkId: Number(r.network_id),
        totalUsd: usd,
        /**
       * Also a COUNT ratio, not a share of value -- the same fault as `valueShare` above, and
       * the consumer's own note names both. `pricedPositionShare` is the honest name; this
       * stays so nothing that reads it breaks.
       */
      pricedPositionShare: n(r.priced_share),
      /** @deprecated A count ratio, not a share of value. Read `pricedPositionShare`. */
      pricedShare: n(r.priced_share),
        /**
         * The same dollars in the chain's own coin. `nativeAmount` is `totalUsd / nativeUsd`
         * and nothing more, and the rate travels with it so the division can be rechecked.
         * Null, never 0, when we hold no market price for that coin -- see `whyNoNative`.
         */
        nativeSymbol: nat?.symbol ?? null,
        nativeUsd: nat?.usd ?? null,
        nativePriceSource: nat?.source ?? null,
        nativeAmount: nat?.usd && usd !== null
          ? Number((usd / nat.usd).toPrecision(10))
          : null,
        whyNoNative: nat?.usd && usd !== null ? null
          : usd === null ? "this chain carries no total at this reading"
          : "no market price for this chain's own coin — the only figures we hold for it are " +
            "traders' reported entry prices, which are not what it is worth now",
        ...(r.reason ? { reason: r.reason as string } : {}),
      };
    }),
    /** Non-null only when the NEWEST sample was refused; the reason names which wall we hit. */
    refused: newest?.refused_reason ?? null,
    plain: !newest
      ? "No balance samples for this trader yet — the sampler has not covered them."
      : newest.total_usd === null
      ? `The most recent reading was refused (${newest.refused_reason}), so there is no total for it. ` +
        `A partial total would read like a real drawdown.`
      : `${points.length} point${points.length === 1 ? "" : "s"} over ${windowKey} at ${declared.name} steps` +
        (chainFilter ? ` on ${chainFilter.name} alone` : "") + "." +
        (trackedSince === null
          ? " Every point is a marked rebuild — sampling has not started."
          : rows.some((r) => r.basis === "rebuilt")
          ? ` Points before ${trackedSince} are rebuilt from chain transfers, not measured.`
          : ""),
  };
}

/**
 * AUM envelopes for MANY traders in a fixed number of queries.
 *
 * WHY SET-BASED AND NOT A LOOP. The individual route answers in about 3.1 seconds, so fifty
 * of them in sequence is roughly 158 -- an order of magnitude past the 15-second route
 * budget. That is the reason the batch route used to return a five-field summary instead of
 * the real envelope, and why Genie could not read the service's own drawing verdict. Four
 * queries answer fifty traders as readily as one.
 *
 * The per-trader arithmetic stays in buildAum(), which does no I/O, so the batch row and the
 * individual response are the same object built by the same code rather than two shapes kept
 * in sync by hand.
 */
async function aumFor(
  handles: string[],
  opts: { windowKey: string; stepRaw: string | null; chainFilter: { network_id: number; name: string } | null },
): Promise<Map<string, ReturnType<typeof buildAum>>> {
  const out = new Map<string, ReturnType<typeof buildAum>>();
  if (!handles.length) return out;

  const to = new Date();

  /*
   * EVERY ROW, WINDOWED IN MEMORY. The window used to be a WHERE clause, which meant a short
   * window could not see the reading just outside it -- and `window=1d` returned nothing at
   * all, not even the current total, for a trader we hold a month of history for.
   */
  const traders = await sql`
    select handle, display_handle from traders where handle = any(${handles})`;
  if (!traders.length) return out;
  const present = traders.map((r) => String(r.handle));

  /*
   * Coverage on a chain series is `pricedShare` and nothing else. The position counts on the
   * parent row are whole-trader for a sampled point and one chain's for a rebuilt one.
   */
  const rows = opts.chainFilter
    ? await sql`
        select a.handle, a.at, a.total_usd, a.reason as refused_reason,
               null::int as priced_positions, null::int as total_positions,
               a.priced_share as value_share, a.basis, s.tier,
               null::int as chains_answered, null::int as chains_expected
        from aum_chain_samples a
        join aum_samples s
          on s.handle = a.handle and s.at = a.at and s.basis = a.basis
        where a.handle = any(${present}) and a.network_id = ${opts.chainFilter.network_id}
        order by a.handle, a.at asc`
    : await sql`
        select handle, at, total_usd, refused_reason, priced_positions, total_positions,
               value_share, basis, tier, chains_answered, chains_expected
        from aum_samples
        where handle = any(${present})
        order by handle, at asc`;

  const byHandle = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const h = String(r.handle);
    let a = byHandle.get(h); if (!a) byHandle.set(h, a = []);
    a.push(r);
  }

  /*
   * The chain split of each trader's NEWEST point, in one query rather than one per trader.
   * The (handle, at, basis) triples are joined through unnest so the database matches them
   * instead of us issuing fifty lookups.
   */
  const nh: string[] = [], na: string[] = [], nb: string[] = [];
  for (const h of present) {
    const rs = byHandle.get(h);
    if (!rs?.length) continue;
    const newest = rs[rs.length - 1];
    nh.push(h); na.push(String(newest.at)); nb.push(String(newest.basis));
  }
  const chainRows = nh.length
    ? await sql`
        select a.handle, c.name as chain, a.network_id, a.total_usd, a.priced_share, a.reason
        from aum_chain_samples a
        join chains c using (network_id)
        join unnest(${nh}::text[], ${na}::timestamptz[], ${nb}::text[]) as u(handle, at, basis)
          on u.handle = a.handle and u.at = a.at and u.basis = a.basis
        order by a.handle, a.total_usd desc nulls last`
    : [];
  const chainsBy = new Map<string, Record<string, unknown>[]>();
  for (const r of chainRows) {
    const h = String(r.handle);
    let a = chainsBy.get(h); if (!a) chainsBy.set(h, a = []);
    a.push(r);
  }

  /*
   * THE CHAIN SPLIT OF EVERY POINT, not only the newest -- because the seam that breaks a
   * chart is a change in WHICH CHAINS a point could answer for, and nothing above can see it.
   *
   * unipcs measured 15.1M (5 chains, rebuilt), then 5.4M (4 chains, rebuilt, robinhood
   * missing), then 15.7M (3 chains, sampled). The middle step is a 64% fall that never
   * happened: the same trader, one chain short. Both points are rebuilt, so marking changes
   * of METHOD -- which is what the consumer asked for -- would not have caught it. Measured
   * over the last week across all 435 traders: 865 steps move the line by half or more, 542
   * change method, and 226 change only the chain set. A method marker alone misses a quarter
   * of them.
   *
   * Costed before adding: 5,979 rows for fifty traders in 188 ms against a table of 37,062.
   * Cheap enough to fetch outright rather than approximate.
   */
  const allChainRows = present.length
    ? await sql`
        select a.handle, a.at, a.basis, c.name as chain, a.total_usd
        from aum_chain_samples a
        join chains c using (network_id)
        where a.handle = any(${present})
        order by a.handle, a.at asc`
    : [];
  /** Window-independent chain list, one query for the whole batch. */
  const knownBy = await knownChainsFor(present);
  /** Cached for the process; five rows that barely move. */
  const natives = await nativePrices();

  /** handle -> "<iso at>|<basis>" -> [{ chain, usd }]. One map, built once for the batch. */
  const pointChainsBy = new Map<string, Map<string, { chain: string; usd: number | null }[]>>();
  for (const r of allChainRows) {
    const h = String(r.handle);
    let m = pointChainsBy.get(h); if (!m) pointChainsBy.set(h, m = new Map());
    const k = `${new Date(String(r.at)).toISOString()}|${r.basis}`;
    let a = m.get(k); if (!a) m.set(k, a = []);
    a.push({ chain: String(r.chain), usd: n(r.total_usd) });
  }

  /*
   * WHEN THE SAMPLER LAST SUCCEEDED, read once for the whole batch.
   *
   * The consumer measured every answer saying `ready` while the newest reading anywhere was
   * 75 hours old, and nothing in the response said so. Freshness has to travel WITH the
   * number rather than be reconstructed from dates by every caller.
   */
  const [samplerRow] = await sql`
    select max(at) as last_at, max(sampled_at) as last_success
    from aum_samples where basis = 'sampled'`;

  const presenceRows = await sql`
    select handle, count(distinct network_id)::int as chains,
           bool_or(network_id = ${SOLANA_NET}) as on_solana,
           bool_or(network_id <> ${SOLANA_NET}) as on_evm
    from holdings_current where handle = any(${present}) and human_amount > 0
    group by handle`;
  const presBy = new Map(presenceRows.map((r) => [String(r.handle), {
    chains: Number(r.chains), on_solana: r.on_solana === true, on_evm: r.on_evm === true,
  }]));

  for (const t of traders) {
    const h = String(t.handle);
    out.set(h, buildAum(
      { handle: h, display_handle: String(t.display_handle) },
      byHandle.get(h) ?? [],
      chainsBy.get(h) ?? [],
      presBy.get(h) ?? null,
      { ...opts, to, pointChains: pointChainsBy.get(h) ?? null,
        knownChains: knownBy.get(h) ?? [], natives, sampler: {
        lastAt: samplerRow?.last_at ? new Date(String(samplerRow.last_at)) : null,
        lastSuccess: samplerRow?.last_success ? new Date(String(samplerRow.last_success)) : null,
      } },
    ));
  }
  return out;
}

/**
 * READ-THROUGH REFRESH: when the stored reading is old, go and get a new one.
 *
 * Until now this route served whatever the sampler last wrote and nothing else, so a trader
 * nobody had sampled for a day answered with yesterday's money however many times you asked.
 * The `aum-sample` function can read his wallets in about eight seconds; the only reason not
 * to do it on every request is cost -- a popular trader viewed a hundred times would be a
 * hundred chain sweeps for one number.
 *
 * So it is a FLOOR, not a cache bypass. Older than `AUM_LIVE_AFTER_MINUTES` and the request
 * pays for a fresh read; newer and it serves what is already there. At five minutes that is
 * live for anyone watching and roughly free for everyone else, because the hundred viewers in
 * that window share one fetch.
 *
 * WHAT THIS COSTS, said plainly: this route can now make an external call, which no route
 * here could before. `/health` reports it under `externalCallsPerRequest` rather than leaving
 * the old claim standing -- that field was true of every route and must not quietly stop being
 * true of this one.
 *
 * Bounded three ways, because a slow chain must never become a slow API:
 *   - only the single-trader route, never the batch. Fifty traders is fifty sweeps.
 *   - `AUM_LIVE_WAIT_MS` caps the wait. Past it the request serves the stored reading and
 *     lets the sample finish in the background, so the NEXT caller gets it.
 *   - one in-flight fetch per trader per instance; concurrent callers wait on the same one.
 *
 * `?live=false` opts out entirely and `?live=true` forces a read regardless of age.
 */
const LIVE_AFTER_MS = Number(Deno.env.get("AUM_LIVE_AFTER_MINUTES") ?? 5) * 60_000;
/*
 * SHORT ON PURPOSE. The route's own budget is 15s and its query work is 4-6s, so a nine
 * second wait measured 14.0s end to end -- inside the limit and far too close to it. A big
 * trader takes about eight seconds to sample and was never going to finish inside the wait
 * anyway; a small one finishes in one or two. So the wait is sized for the traders it can
 * actually catch, and everyone else is served the stored reading with `still_running` and
 * gets the fresh one on their next call a moment later.
 */
const LIVE_WAIT_MS = Number(Deno.env.get("AUM_LIVE_WAIT_MS") ?? 3_000);
const SAMPLE_URL = (Deno.env.get("AUM_SAMPLE_URL") ?? "").trim();
const SAMPLE_SECRET = (Deno.env.get("AUM_SAMPLE_SECRET") ?? "").trim();
/** Per instance. Edge Functions scale out, so this thins the stampede rather than ending it. */
const inFlight = new Map<string, Promise<void>>();

/** True when a live read is configured and possible at all. */
const liveReadable = () => SAMPLE_URL !== "" && SAMPLE_SECRET !== "";

async function refreshNow(handle: string): Promise<void> {
  const running = inFlight.get(handle);
  if (running) return running;
  const task = (async () => {
    try {
      const r = await fetch(SAMPLE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-sample-secret": SAMPLE_SECRET },
        body: JSON.stringify({ handle }),
        /* Its own ceiling, above our wait, so a fetch we stopped waiting for still completes. */
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) console.error(`aum live refresh ${handle}: HTTP ${r.status}`);
    } catch (e) {
      /*
       * A failed refresh is NOT a failed request. The stored reading is still a true reading
       * of an earlier moment, and `now.ageSeconds` already says how old it is -- serving that
       * is strictly better than turning a slow chain into a 500.
       */
      console.error(`aum live refresh ${handle}: ${(e as Error).message}`);
    } finally {
      inFlight.delete(handle);
    }
  })();
  inFlight.set(handle, task);
  return task;
}

get("/v1/traders/:handle/aum", async ({ handle }, url) => {
  const h = await resolveTrader(handle);
  const { windowKey, stepRaw, chainKey } = aumOptions(url);
  const chainFilter = await resolveChain(chainKey);

  const liveParam = (url.searchParams.get("live") ?? "").trim().toLowerCase();
  let refreshed: string | null = null;

  if (liveParam !== "false" && liveReadable()) {
    /*
     * AGE IS MEASURED FROM `sampled_at`, NOT `at`, and the difference is the whole feature.
     *
     * `at` is the HOUR the reading describes -- truncated, so a sample taken at 06:44 is
     * stamped 06:00 and reads as forty-four minutes old the moment it is written. Checking
     * that against a five minute floor meant every request re-fetched a reading taken
     * seconds earlier, which is not a freshness floor at all, just a slow route. Measured
     * exactly that way before this line was fixed: `ageSeconds 2651` on a sample a minute old.
     *
     * `sampled_at` is when we actually read the chain, which is the only thing "how fresh is
     * this" can honestly mean.
     */
    const [newest] = await sql`
      select max(sampled_at) as at from aum_samples
      where handle = ${h} and basis = 'sampled' and total_usd is not null`;
    const ageMs = newest?.at ? Date.now() - Date.parse(String(newest.at)) : Infinity;
    if (liveParam === "true" || ageMs > LIVE_AFTER_MS) {
      const fetching = refreshNow(h);
      /*
       * Wait, but not forever. Whichever finishes first decides what this caller gets, and
       * either way the sample completes and the next caller is served from it.
       */
      const won = await Promise.race([
        fetching.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), LIVE_WAIT_MS)),
      ]);
      refreshed = won ? "fetched" : "still_running";
    } else {
      refreshed = "not_needed";
    }
  } else if (liveParam === "false") {
    refreshed = "skipped";
  } else if (!liveReadable()) {
    refreshed = "unavailable";
  }

  const got = await aumFor([h], { windowKey, stepRaw, chainFilter });
  const envelope = got.get(h);
  if (!envelope) throw notFound(`no trader '${handle}' in the directory`);
  return {
    ...envelope,
    /**
     * WHAT THIS REQUEST DID ABOUT FRESHNESS, so `now.ageSeconds` can be read in context.
     *
     * `fetched` — a live read finished and `now` is from it.
     * `still_running` — one was started and outlasted our wait; this answer is the previous
     *   reading and the next request will have the new one.
     * `not_needed` — the stored reading is inside the freshness floor.
     * `skipped` — the caller passed `live=false`.
     * `unavailable` — no live read is configured on this deployment.
     */
    liveRead: {
      state: refreshed,
      freshnessFloorMinutes: LIVE_AFTER_MS / 60_000,
      waitedMs: refreshed === "fetched" || refreshed === "still_running" ? LIVE_WAIT_MS : null,
    },
  };
});


/**
 * AUM for many traders in one call.
 *
 * TWO CONTRACTS, CHOSEN BY THE CALLER. `contractVersion: 2` returns the identity-safe
 * envelope: one row per requested id, carrying the value submitted, the canonical id, and
 * the COMPLETE AUM object -- byte-identical to what `GET /v1/traders/:id/aum` returns for
 * the same trader and window, because both are built by the same function from the same
 * rows. Without that field the older projection is returned unchanged, so a consumer already
 * reading it keeps working until it migrates.
 *
 * The older shape identifies rows by display handle alone, which cannot survive a rename or
 * a folded-handle collision, and it drops the service's own `drawing` verdict -- leaving a
 * consumer to guess whether a short series is a warming backfill or a real refusal. That is
 * why version 2 exists; see GENIE_FOMO_V7_BATCH_AUM_AND_COVERAGE_PRD.md.
 */
post("/v1/traders/aum", async (_p, _url, body) => {
  const { requested, handles, asked, capped } = await batchIds(body);
  const b = body as { window?: string; step?: string; contractVersion?: number; chain?: string };
  /* Same aliases as the individual route, from the same table, so the two cannot disagree. */
  const askedWindow = (b?.window ?? "1w").trim();
  const windowKey = resolveWindow(askedWindow);
  if (windowKey === null) {
    throw badRequest(
      `'window' must be one of ${Object.keys(AUM_WINDOWS).join(", ")} — got '${askedWindow}'. ` +
      `Also accepted: ${Object.keys(WINDOW_ALIASES).join(", ")}, in any case.`,
      { parameter: "window" });
  }
  const stepRaw = typeof b?.step === "string" ? b.step : null;
  if (stepRaw !== null &&
      !AUM_STEPS.some((s) => s.name === stepRaw.trim().toLowerCase())) {
    throw badRequest(`'step' must be one of ${AUM_STEPS.map((s) => s.name).join(", ")}`,
                     { parameter: "step" });
  }

  /*
   * A BATCH CAN NAME A CHAIN, because the history mostly lives in the per-chain answers.
   * Without this a screen of fifty traders on one chain was fifty calls; it is now one.
   * The individual route has always taken `?chain=`, and aumFor() is the same code for both,
   * so the two cannot disagree about what a chain series means.
   */
  const chainFilter = await resolveChain((b?.chain ?? "").trim().toLowerCase());
  const envelopes = await aumFor(handles, { windowKey, stepRaw, chainFilter });

  /*
   * The newest reading anywhere in this batch. Each trader carries his own `now.at`; this is
   * the one date for the answer as a whole, and matches what the individual route reports for
   * the freshest trader in the list.
   */
  const batchAsOf = [...envelopes.values()].reduce<string | null>((best, e) => {
    const at = e.asOf ?? null;
    return at !== null && (best === null || at > best) ? at : best;
  }, null);

  /*
   * THE FULL ENVELOPE IS THE DEFAULT here too, for the reason above and one measurement:
   * without it this route answers a handle, a count, a newest figure and the points, and
   * nothing else -- no chains, no reach, no status, no drawable decision. Every consumer's
   * bulk pass uses this route, so that shape became the stored copy of the world.
   *
   * `contractVersion: 1` still returns the old projection, unchanged, for anyone parsing it.
   */
  if (Number(b?.contractVersion) !== 1) {
    const idRows = await sql`
      select handle, id from traders where handle = any(${handles})`;
    const idBy = new Map(idRows.map((r) => [String(r.handle), r.id ? String(r.id) : null]));

    const rowsOut = requested.map((req, i) => {
      const h = handles[i];
      const aum = envelopes.get(h);
      if (!aum) {
        return {
          ok: false as const,
          requested: req,
          id: null,
          handle: null,
          error: { code: "not_found", detail: `no trader '${req}' in the directory` },
        };
      }
      return {
        ok: true as const,
        requested: req,
        id: idBy.get(h) ?? null,
        handle: aum.handle,
        aum,
      };
    });

    return {
      contractVersion: 2,
      ...batchEnvelope(asked, capped, batchAsOf),
      window: windowKey,
      /** Null when the batch asked for the whole portfolio; a name when it named a chain. */
      chain: chainFilter ? chainFilter.name : null,
      /**
       * THE IDS WE COULD NOT ANSWER FOR, gathered under the name the consumer looks for.
       *
       * Every asked id has always appeared in `traders[]` -- a failure as an `ok: false` row
       * carrying its own error, which is what stops a dropped row looking like a trader with
       * no data. But their contract reads `unreadableRows[]`, and a consumer checking that key
       * found nothing and concluded every id had answered.
       *
       * Same rows, listed twice on purpose: `traders[]` keeps one entry per requested id in
       * the order asked, and this is the subset that failed. Empty is the healthy state.
       */
      unreadableRows: rowsOut.filter((r) => !r.ok).map((r) => ({
        requested: r.requested,
        error: (r as { error?: unknown }).error,
      })),
      /*
       * EXACTLY ONE ROW PER REQUESTED ID, INCLUDING THE ONES THAT FAILED. An omitted row is
       * indistinguishable from a trader with no data, so an id we could not resolve comes
       * back as an explicit refusal rather than a hole in the list.
       */
      traders: rowsOut,
    };
  }

  // ---- the pre-version-2 projection, unchanged so existing consumers keep working
  return {
    ...batchEnvelope(asked, capped, batchAsOf),
    window: windowKey,
    ...(chainFilter ? { chain: chainFilter.name } : {}),
    traders: handles.map((h) => {
      const aum = envelopes.get(h);
      return {
        handle: h,
        trackedSince: aum?.trackedSince ?? null,
        count: aum?.count ?? 0,
        now: aum?.now
          ? { at: aum.now.at, totalUsd: aum.now.totalUsd, tier: aum.now.tier,
              coverage: aum.now.coverage }
          : null,
        points: (aum?.points ?? []).map((p) => ({
          at: p.at,
          totalUsd: p.totalUsd,
          basis: p.basis,
          ...((p as { refused?: string }).refused ? { refused: (p as { refused?: string }).refused } : {}),
        })),
      };
    }),
  };
});
