import { sql, n, round } from "../db.ts";
import { cfg } from "../config.ts";
import { get, post } from "../router.ts";
import { notFound, badRequest } from "../errors.ts";
import { median, money } from "../shared/format.ts";
import { NativePrice, nativePrices } from "../shared/prices.ts";
import { resolveChain, SOLANA_NET, KnownChain, knownChainsFor } from "../shared/chains.ts";
import { resolveTrader } from "../shared/traders.ts";
import { batchIds, batchEnvelope } from "../shared/batch.ts";
import { AUM_WINDOWS, WINDOW_ALIASES, resolveWindow, AUM_STEPS, MIN_DRAWABLE_POINTS, type StepChosenFrom, applyFloor, chooseStep } from "../shared/aum-rules.ts";

// --------------------------------------------------------------- AUM over time


/** A trader's balance over time — one sampled point per hour, in USD, across every wallet and… See docs/DECISIONS.md#d015 */
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

  rows = rows.map(applyFloor);

  /** THE READING JUST BEFORE THE WINDOW IS KEPT, as an anchor. See docs/DECISIONS.md#d018 */
  const inWindow = from === null ? rows : rows.filter((r) => Date.parse(String(r.at)) >= from.getTime());
  const before = from === null
    ? []
    : rows.filter((r) => Date.parse(String(r.at)) < from.getTime());

  /** Reach back far enough for a LINE, not just for one point. See docs/DECISIONS.md#d019 */
  /** BORROWED POINTS MUST SHARE THE NEWEST POINT'S BASIS. See docs/DECISIONS.md#d020 */
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

  /** THE DEFAULT STEP IS THE COARSER OF WHAT THE WINDOW AFFORDS AND WHAT THE DATA HOLDS. See docs/DECISIONS.md#d021 */
  const rawGaps: number[] = [];
  for (let i = 1; i < windowed.length; i++) {
    const g = Date.parse(String(windowed[i].at)) - Date.parse(String(windowed[i - 1].at));
    if (Number.isFinite(g) && g > 0) rawGaps.push(g);
  }
  rawGaps.sort((a, b) => a - b);
  /** Median, not mean: one long gap after a quiet spell must not coarsen the whole series. */
  const observedStepMs = rawGaps.length ? rawGaps[Math.floor(rawGaps.length / 2)] : 0;

  /** THE STEP IS CHOSEN OVER THE RECORD HELD, not only the window asked for (S1). */
  const firstSampled = rows.find((r) => r.basis === "sampled");
  const trackedSpan = firstSampled ? to.getTime() - Date.parse(String(firstSampled.at)) : null;
  const pick = chooseStep(span, trackedSpan);
  let chosen: { name: string; ms: number } = stepRaw !== null
    ? AUM_STEPS.find((s) => s.name === stepRaw.trim().toLowerCase())!
    : pick;
  /** Null when the caller named the step; then nothing was chosen. */
  let stepChosenFrom: StepChosenFrom | null = stepRaw !== null ? null : pick.chosenFrom;

  /** WHAT IS DECLARED IS NOT WHAT IS BUCKETED, and conflating them costs real readings. See docs/DECISIONS.md#d022 */
  const declared = stepRaw !== null
    ? chosen
    : (AUM_STEPS.find((x) => x.ms >= Math.max(chosen.ms, observedStepMs))
       ?? AUM_STEPS[AUM_STEPS.length - 1]);

  /*
   * Thin by keeping the LAST point in each bucket rather than the first or an average.
   * Averaging would invent a balance he never held, and a refused hour averaged with a
   * measured one would launder the refusal into a number.
   */
  const thin = (bucketMs: number): Record<string, unknown>[] => {
    const kept = new Map<number, Record<string, unknown>>();
    for (const r of windowed) {
      const ms = Date.parse(String(r.at));
      if (!Number.isFinite(ms)) continue;
      kept.set(Math.floor(ms / bucketMs), r);
    }
    return [...kept.values()];
  };
  let thinned = thin(chosen.ms);
  /** A DAILY BUCKET THAT FOLDS THE RECORD INTO ONE POINT falls back to the finest step (S1). */
  if (stepChosenFrom !== null && chosen.ms !== AUM_STEPS[0].ms &&
      thinned.filter(hasFigure).length < MIN_DRAWABLE_POINTS) {
    const finest = thin(AUM_STEPS[0].ms);
    if (finest.filter(hasFigure).length >= MIN_DRAWABLE_POINTS) {
      thinned = finest;
      chosen = AUM_STEPS[0];
      stepChosenFrom = "fallback";
    }
  }
  const points = thinned.map((r) => ({
    at: new Date(String(r.at)).toISOString(),
    totalUsd: round(n(r.total_usd)),
    /** THE FIGURE BEHIND A REFUSAL. See docs/DECISIONS.md#d023 */
    partialUsd: round(n((r as { partial_usd?: unknown }).partial_usd)),
    basis: r.basis as string,
    /** H1. A rebuilt point is arithmetic over everything ever received, not a balance read. */
    ...(r.basis === "rebuilt" ? { reliability: "low" } : {}),
    tier: r.tier as string,
    coverage: {
      pricedPositions: r.priced_positions === null ? null : Number(r.priced_positions),
      totalPositions: r.total_positions === null ? null : Number(r.total_positions),
      /** `valueShare` IS NOT A SHARE OF VALUE, and the name has misled for long enough. See docs/DECISIONS.md#d024 */
      pricedPositionShare: n(r.value_share),
      /** @deprecated A count ratio, not a share of value. Read `pricedPositionShare`. */
      valueShare: n(r.value_share),
      /** HOW MUCH OF HIM THIS DAY IS, per point rather than per response. See docs/DECISIONS.md#d025 */
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

  /** ===================== THE SEAM BETWEEN TWO KINDS OF POINT ===================== Section 9… See docs/DECISIONS.md#d026 */
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
  /** A THIRD REASON, AND IT IS THE COMMONEST ONE. See docs/DECISIONS.md#d027 */
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
  const trackedSince = firstSampled ? new Date(String(firstSampled.at)).toISOString() : null;

  /** `now` IS THE MOST COMPLETE RECENT READING, NOT SIMPLY THE NEWEST. See docs/DECISIONS.md#d028 */
  const withFigure = rows.filter((r) => n(r.total_usd) !== null);
  const cover = (r: Record<string, unknown>) =>
    r.chains_answered === null || r.chains_answered === undefined ? -1 : Number(r.chains_answered);
  const wanted = (r: Record<string, unknown>) =>
    r.chains_expected === null || r.chains_expected === undefined ? -1 : Number(r.chains_expected);

  let newest: Record<string, unknown> | null = null;
  if (withFigure.length) {
    /** RECENT FIRST, THEN COMPLETE. See docs/DECISIONS.md#d029 */
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
  /** ANCHOR POINTS ARE EXCLUDED FROM `coveredDays`, because they were not asked for. See docs/DECISIONS.md#d030 */
  const inWindowPoints = points.filter((p) => !(p as { outsideWindow?: boolean }).outsideWindow);
  const anchorPoints = points.length - inWindowPoints.length;
  const covFirst = inWindowPoints.length ? Date.parse(inWindowPoints[0].at) : firstAt;
  const covLast = inWindowPoints.length
    ? Date.parse(inWindowPoints[inWindowPoints.length - 1].at) : lastAt;
  const coveredDays = covFirst !== null && covLast !== null
    ? Math.max(0, Math.round((covLast - covFirst) / 86_400_000))
    : 0;

  /** DOES THE DATA REACH BACK TO WHAT WAS ASKED FOR -- measured as a gap, not a day count. See docs/DECISIONS.md#d031 */
  /** The slack is the DATA's granularity, not the requested step. See docs/DECISIONS.md#d032 */
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

  /** TWO DATED FIGURES ARE A LINE. See docs/DECISIONS.md#d033 */
  /** A ZERO THAT NOTHING ANSWERED FOR IS NOT A ZERO. See docs/DECISIONS.md#d034 */
  const emptyRead = (r: Record<string, unknown> | null): boolean => {
    if (!r) return false;
    if (n(r.total_usd) !== 0) return false;
    const chains = r.chains_answered === null || r.chains_answered === undefined
      ? 0 : Number(r.chains_answered);
    const looked = r.total_positions === null || r.total_positions === undefined
      ? 0 : Number(r.total_positions);
    return chains === 0 && looked === 0;
  };
  /** TWO WAYS TO HAVE NOTHING, and both must stop `ready`. See docs/DECISIONS.md#d035 */
  const newestIsEmpty = emptyRead(newest) || withFigure.length === 0;

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
  } else if (usable.filter((p) => p.basis === "sampled").length < MIN_DRAWABLE_POINTS) {
    // H1. Rebuilt points never draw alone: the minimum must be met by sampled readings.
    drawable = false;
    reason = "rebuilt_only";
  } else if (!reachesBack) {
    // Enough points to draw, but not across the span that was asked for. Both facts are true
    // and the consumer needs the second one to label its axis honestly.
    drawable = false;
    reason = "short_coverage";
  }

  /** Gaps are returned, never smoothed over. A chart breaks its line at each of these. */
  /** EACH GAP CARRIES THE SPAN IT COVERS, not just the moment it sits at. See docs/DECISIONS.md#d036 */
  const gaps = points
    .map((p, i) => ({ p, next: points[i + 1] }))
    .filter(({ p }) =>
      p.totalUsd === null &&
      /** A REFUSED ANCHOR IS NOT A GAP IN THIS WINDOW. See docs/DECISIONS.md#d037 */
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
  /** TOTAL CHAINS COMES FROM THE SAME UNION `knownChains` DOES, not from what is held today. See docs/DECISIONS.md#d038 */
  const totalChains = opts.knownChains?.length ?? Number(presence?.chains ?? 0);

  const answeredNets = new Set(
    chainRows.filter((r) => r.total_usd !== null).map((r) => Number(r.network_id)));
  /** TOTAL WALLETS FROM THE SAME UNION AS THE CHAINS, for the reason `totalChains` above moved. See docs/DECISIONS.md#d039 */
  const totalWallets = opts.knownChains?.length
    ? (opts.knownChains.some((c) => Number(c.networkId) !== SOLANA_NET) ? 1 : 0) +
      (opts.knownChains.some((c) => Number(c.networkId) === SOLANA_NET) ? 1 : 0)
    : (presence?.on_evm ? 1 : 0) + (presence?.on_solana ? 1 : 0);
  const answeredWallets =
    ([...answeredNets].some((x) => x !== SOLANA_NET) ? 1 : 0) +
    (answeredNets.has(SOLANA_NET) ? 1 : 0);
  /** IS THE NEWEST READING SHORT OF A CHAIN -- asked of the ENVELOPE when the reading cannot sa… See docs/DECISIONS.md#d040 */
  const newestPartial = (() => {
    const r = newest;
    if (!r) return { partial: null as boolean | null, reason: null as string | null };
    const ownCover = cover(r), ownWanted = wanted(r);
    const hasOwn = ownCover >= 0 && ownWanted >= 0;
    /** EITHER MEASURE SAYING "SHORT" MAKES IT SHORT, and it has to be an OR rather than a prefere… See docs/DECISIONS.md#d041 */
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

  /** SAMPLER STATE, NAMED RATHER THAN IMPLIED. See docs/DECISIONS.md#d042 */
  const STALE_AFTER_H = 36;
  const lastSuccess = opts.sampler?.lastSuccess ?? null;

  /** THE STATE IS THIS TRADER'S, NOT THE PIPELINE'S. See docs/DECISIONS.md#d043 */
  /** The age of the FIGURE, not of the newest row. See docs/DECISIONS.md#d044 */
  const ownAgeH = newest?.at && n(newest.total_usd) !== null
    ? (to.getTime() - Date.parse(String(newest.at))) / 3_600_000
    : null;
  const sinceSuccessH = lastSuccess === null
    ? null
    : (to.getTime() - lastSuccess.getTime()) / 3_600_000;

  /** F3. No row at all is its own word: nothing is filling, nothing was refused. */
  const samplerState = rows.length === 0
    ? "never_read"
    : ownAgeH === null
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
      : (samplerState === "never_read" ? "the sampler has never covered this trader" : null),
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
    /** What decided `step`: the window, the shorter tracked span, or the fallback to the finest step. */
    stepChosenFrom,
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
    /** TRUE WHEN `step` UNDERSTATES THE REAL SPACING, AND IT CANNOT SAY SO ANY OTHER WAY. See docs/DECISIONS.md#d045 */
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
        /** ON `now` ITSELF, not only inside `coverage`. See docs/DECISIONS.md#d046 */
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

    /** EVERY CHAIN THIS TRADER USES, and it does not change with the window. See docs/DECISIONS.md#d047 */
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
    /** HOW MUCH OF THE ASKED-FOR WINDOW IS ACTUALLY BEHIND THIS ANSWER, always. See docs/DECISIONS.md#d048 */
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

    /** WHY TWO NEIGHBOURING FIGURES MAY NOT BE SUBTRACTABLE, stated once for the series. See docs/DECISIONS.md#d049 */
    comparability: {
      equalised: false,
      reason: "coverage_differs_by_method",
      detail: "a rebuilt point prices about 39% of a chain's positions and a sampled one " +
              "77-84%, so the two count different fractions of the same wallet. Break the " +
              "line at every entry in `breaks` and do not measure a percentage across one.",
    },

    /** EVERY SEAM, shaped like `gaps` because that is the list a chart already breaks on. See docs/DECISIONS.md#d050 */
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
        whyNoNative: !nat?.usd ? "no market price for this chain's own coin"
          : usd === null ? "this chain carries no total at this reading"
          : null,
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

/** AUM envelopes for MANY traders in a fixed number of queries. See docs/DECISIONS.md#d051 */
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
  const present = traders.map((r: Record<string, unknown>) => String(r.handle));

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

  /** THE CHAIN SPLIT OF EVERY POINT, not only the newest -- because the seam that breaks a char… See docs/DECISIONS.md#d052 */
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
  const presBy = new Map<string, { chains: number; on_solana: boolean; on_evm: boolean }>(presenceRows.map((r: Record<string, unknown>) => [String(r.handle), {
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

/** READ-THROUGH REFRESH: when the stored reading is old, go and get a new one. See docs/DECISIONS.md#d053 */
const liveAfterMs = () => Number(cfg("AUM_LIVE_AFTER_MINUTES") ?? 5) * 60_000;
/** SHORT ON PURPOSE. See docs/DECISIONS.md#d054 */
const liveWaitMs = () => Number(cfg("AUM_LIVE_WAIT_MS") ?? 3_000);
const sampleUrl = () => (cfg("AUM_SAMPLE_URL") ?? "").trim();
const sampleSecret = () => (cfg("AUM_SAMPLE_SECRET") ?? "").trim();
/** Per instance. Edge Functions scale out, so this thins the stampede rather than ending it. */
const inFlight = new Map<string, Promise<void>>();

/** True when a live read is configured and possible at all. */
const liveReadable = () => sampleUrl() !== "" && sampleSecret() !== "";

async function refreshNow(handle: string): Promise<void> {
  const running = inFlight.get(handle);
  if (running) return running;
  const task = (async () => {
    try {
      const r = await fetch(sampleUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-sample-secret": sampleSecret() },
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
    /** AGE IS MEASURED FROM `sampled_at`, NOT `at`, and the difference is the whole feature. See docs/DECISIONS.md#d055 */
    const [newest] = await sql`
      select max(sampled_at) as at from aum_samples
      where handle = ${h} and basis = 'sampled' and total_usd is not null`;
    const ageMs = newest?.at ? Date.now() - Date.parse(String(newest.at)) : Infinity;
    if (liveParam === "true" || ageMs > liveAfterMs()) {
      const fetching = refreshNow(h);
      /*
       * Wait, but not forever. Whichever finishes first decides what this caller gets, and
       * either way the sample completes and the next caller is served from it.
       */
      const won = await Promise.race([
        fetching.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), liveWaitMs())),
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
    /** WHAT THIS REQUEST DID ABOUT FRESHNESS, so `now.ageSeconds` can be read in context. See docs/DECISIONS.md#d056 */
    liveRead: {
      state: refreshed,
      freshnessFloorMinutes: liveAfterMs() / 60_000,
      waitedMs: refreshed === "fetched" || refreshed === "still_running" ? liveWaitMs() : null,
    },
  };
});


/** WHAT THE BATCH DOES ABOUT FRESHNESS: nothing, and it says so on every row (L1). */
const BATCH_LIVE_READ = {
  state: "skipped",
  note: "batch never reads live; use GET /v1/traders/:handle/aum",
} as const;

/** AUM for many traders in one call. See docs/DECISIONS.md#d057 */
post("/v1/traders/aum", async (_p, _url, body) => {
  const { requested, handles, asked, capped } = await batchIds(body);
  /** `live` is accepted and ignored: the batch never reads live (L1); every row says so. */
  const b = body as { window?: string; step?: string; contractVersion?: number; chain?: string; live?: unknown };
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

  /** THE FULL ENVELOPE IS THE DEFAULT here too, for the reason above and one measurement: witho… See docs/DECISIONS.md#d058 */
  if (Number(b?.contractVersion) !== 1) {
    const idRows = await sql`
      select handle, id from traders where handle = any(${handles})`;
    const idBy = new Map<string, string | null>(idRows.map((r: Record<string, unknown>) => [String(r.handle), r.id ? String(r.id) : null]));

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
        aum: { ...aum, liveRead: BATCH_LIVE_READ },
      };
    });

    return {
      contractVersion: 2,
      ...batchEnvelope(asked, capped, batchAsOf),
      window: windowKey,
      /** Null when the batch asked for the whole portfolio; a name when it named a chain. */
      chain: chainFilter ? chainFilter.name : null,
      /** THE IDS WE COULD NOT ANSWER FOR, gathered under the name the consumer looks for. See docs/DECISIONS.md#d059 */
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
        liveRead: BATCH_LIVE_READ,
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
