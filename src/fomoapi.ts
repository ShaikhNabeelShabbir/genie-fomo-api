/**
 * fomoapi.io client — the one source with realized/unrealized P&L per trade.
 *
 * Unlike metrics.ts (pure file arithmetic), everything here costs an API call, so results
 * are cached. Free tier is 10,000 requests/month.
 */

const HOST = process.env.FOMOAPI_BASE ?? "https://api.fomoapi.io";
const KEY = (process.env.FOMOAPI_KEY ?? "").trim();
export const haveFomoapi = () => !!KEY;

const TTL_MS = 10 * 60_000;

/**
 * The cache holds the RAW `/trades` document, not a derived result.
 *
 * `banked()` (T1) and `scorecard()` (T2-T20) read the same payload, so caching the
 * document rather than either answer means the second route costs nothing. Given the
 * 10,000 request/month free tier, that difference is the whole reason both can ship.
 */
const cache = new Map<string, { at: number; doc: any }>();

export type Banked = {
  /** T1 — money that has actually left the table. */
  bankedUsd: number | null;
  closedTrades: number;
  /** T1 — marks on positions still open. Often unrealisable; never call it "profit". */
  onPaperUsd: number | null;
  openPositions: number;
  /**
   * banked / (banked + on paper), 0..1 — or null when the ratio would be meaningless.
   *
   * Sign discipline matters here. A naive `total !== 0` guard lets realized −$8,000 and
   * unrealized −$2,000 render as "80% banked" for a trader who LOST $10,000. We emit a
   * share only when both sides are positive; every other case gets the dollar figures and
   * no ratio.
   */
  realizedShare: number | null;
  capturedAt: string | null;
  /** fomoapi serves trades live and reports its own unavailability — pass it through. */
  available: boolean;
  note: string | null;
  plain: string;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

const money = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

async function fetchTrades(handle: string, limit: number): Promise<any> {
  const r = await fetch(`${HOST}/v2/users/${encodeURIComponent(handle)}/trades?limit=${limit}`, {
    headers: { authorization: `Bearer ${KEY}`, Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (r.status === 404) return { notFound: true };
  if (!r.ok) throw new Error(`fomoapi HTTP ${r.status}`);
  return r.json();
}

/**
 * T1 — banked versus on paper.
 *
 * The spine of the trust model: a headline profit that is entirely unrealised can be a
 * honeypot mark. The measured case was $95,577,723 of "profit" on $41 of volume, against a
 * cost basis of $9.87, in a token nobody had ever sold.
 */
/**
 * The `/trades` document for a handle, cached.
 *
 * Only a document that actually carries trades is cached: a degraded `{available:false}`
 * envelope is a transient fomo condition and must be retried, not remembered for 10
 * minutes.
 */
async function tradesDoc(handle: string, limit = 500, retry = true): Promise<any> {
  const key = handle.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.doc;

  const usable = (d: any) =>
    d?.available !== false && Array.isArray(d?.trades) && d.trades.length > 0;

  let doc = await fetchTrades(handle, limit);
  if (doc?.notFound) return doc;
  // fomo serves trades live and returns `{available:false, trades:[]}` when its upstream
  // is momentarily unwilling. Measured: this fires on roughly the first call after a cold
  // start and clears on an immediate retry, so one retry converts a confusing empty
  // scorecard into the real one. Still only one — if it degrades twice it is degraded, and
  // the envelope is passed through rather than being rendered as zeroes.
  //
  // `retry` is off for the K5-K8 fan-out. There the caller is waiting on 10 lookups, a
  // degraded one is already reported as "no trade record" with the sample size attached,
  // and paying 1.5s plus a second request per degraded holder doubles a 45s call to buy a
  // caveat we already print.
  if (retry && !usable(doc) && doc?.available === false) {
    await new Promise((r) => setTimeout(r, 1_500));
    const second = await fetchTrades(handle, limit);
    if (usable(second)) doc = second;
  }
  if (usable(doc)) cache.set(key, { at: Date.now(), doc });
  return doc;
}

export async function banked(handle: string, limit = 500): Promise<Banked | null> {
  if (!haveFomoapi()) throw new Error("FOMOAPI_KEY is not set");

  const doc = await tradesDoc(handle, limit);
  if (doc?.notFound) return null;

  // Two response shapes observed in the wild: a full one with counts, and a degraded
  // `{available:false, trades:[], note}` envelope when trades cannot be served.
  const trades: any[] = Array.isArray(doc?.trades) ? doc.trades : [];
  const available = doc?.available !== false;

  let realized = 0;
  let unrealized = 0;
  let closed = 0;
  let open = 0;
  for (const t of trades) {
    const r = Number(t?.realizedPnlUsd);
    const u = Number(t?.unrealizedPnlUsd);
    if (t?.status === "closed") {
      closed++;
      if (Number.isFinite(r)) realized += r;
    } else {
      open++;
      if (Number.isFinite(u)) unrealized += u;
    }
  }

  const any = trades.length > 0;
  // Only a genuinely mixed, positive picture gets a ratio — see the note on realizedShare.
  const share = any && realized > 0 && unrealized > 0
    ? Number((realized / (realized + unrealized)).toFixed(4))
    : null;

  let plain: string;
  if (!available) {
    plain = "fomo could not serve this trader's trades just now, so we cannot say what is banked.";
  } else if (!any) {
    plain = "No trades on record for this trader.";
  } else if (share !== null) {
    plain =
      `Cashed out ${money(realized)} across ${closed} closed trades. ` +
      `${money(unrealized)} is still on paper in ${open} open position${open === 1 ? "" : "s"} ` +
      `— ${Math.round(share * 100)}% of the total is actually banked.`;
  } else if (realized > 0 && unrealized <= 0) {
    plain = `Cashed out ${money(realized)} across ${closed} closed trades, and is currently down ${money(Math.abs(unrealized))} on open positions.`;
  } else if (realized <= 0 && unrealized > 0) {
    plain = `${money(unrealized)} of gains are on paper only — nothing has been banked yet across ${closed} closed trades.`;
  } else {
    plain = `Down ${money(Math.abs(realized))} on closed trades and ${money(Math.abs(unrealized))} on open ones.`;
  }

  const value: Banked = {
    bankedUsd: any ? Number(realized.toFixed(2)) : null,
    closedTrades: closed,
    onPaperUsd: any ? Number(unrealized.toFixed(2)) : null,
    openPositions: open,
    realizedShare: share,
    capturedAt: doc?.capturedAt ?? null,
    available,
    note: doc?.note ?? null,
    plain,
  };
  return value;
}

// ---------------------------------------------------------------- T2 - T20

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** A denominator that travels with its number. */
type Coverage = { of: number; total: number; share: number | null };
const coverage = (of: number, total: number): Coverage => ({
  of,
  total,
  share: total ? Number((of / total).toFixed(4)) : null,
});

export type TokenPnl = {
  symbol: string | null;
  address: string | null;
  trades: number;
  closed: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  /** T17 — present only where fomo actually carries the prices. */
  avgEntryPrice: number | null;
  avgExitPrice: number | null;
};

export type Scorecard = {
  /** Every array-derived figure below is over THIS many trades, not the lifetime. */
  sample: {
    returned: number;
    reportedTotal: number | null;
    /** T15 — fomo's own open/closed counts. */
    activeCount: number | null;
    closedCount: number | null;
    /**
     * True when the envelope's own counts add up to the rows it returned. Measured on
     * `unipcs`: 159 active + 243 closed = 402, against 184 rows at limit=500. When this
     * is false the sample is a window on the history, not the history.
     */
    reconciles: boolean;
    plain: string;
  };
  /** T6 */
  winRate: number | null;
  wins: number;
  losses: number;
  breakeven: number;
  /** T7 — worst is the minimum, which is only a "loss" when it is negative. */
  bestTradeUsd: number | null;
  worstTradeUsd: number | null;
  /** T8 — best trade as a share of GROSS gains, never of the net (which can be negative). */
  topTradeShare: number | null;
  /** T9 — mean/median skew across closed trades. >>1 means one hit carries the record. */
  meanToMedian: number | null;
  meanTradeUsd: number | null;
  medianTradeUsd: number | null;
  /** T2 — derived from amount x price; fomo carries no bought_cost/sold_income. */
  moneyIn: { usd: number | null; coverage: Coverage };
  moneyOut: { usd: number | null; coverage: Coverage };
  /** T3 — realized return on the cost basis we can actually see. */
  returnPct: { value: number | null; coverage: Coverage };
  /** T10 — median position size at entry. */
  typicalBetUsd: { value: number | null; method: "entry_price" | "volume_per_trade" | null; coverage: Coverage };
  /** T16 — median time from open to close. */
  holdingTime: { medianHours: number | null; medianDays: number | null; coverage: Coverage };
  /** T18 */
  lastTradeAt: string | null;
  lastTradeAgoHours: number | null;
  /** T19 */
  firstTradeAt: string | null;
  trackRecordDays: number | null;
  /** T20 — over the returned sample and its span, not the lifetime. */
  tradesPerDay: number | null;
  /** T5 (+T17) — biggest realized winner first. */
  byToken: TokenPnl[];
  capturedAt: string | null;
  available: boolean;
  note: string | null;
  plain: string;
  caveats: string[];
};

/**
 * T2, T3, T5-T10, T15-T20 from the `/trades` document already fetched for T1.
 *
 * Two things shape every field here.
 *
 *   Coverage.  fomo carries entry/exit prices on a minority of trades — measured on
 *              `unipcs`, 21 of 184 have an entry price and only 2 of 25 closed trades have
 *              both. So every price-derived figure ships with the denominator it was
 *              computed over, and returns null rather than a confident number drawn from
 *              8% of the evidence.
 *
 *   Sign.      Ratios are only emitted when they mean something. `topTradeShare` divides
 *              by GROSS gains, because dividing the best trade by a net total that can be
 *              negative produces unbounded nonsense; `returnPct` requires a positive cost
 *              basis; `worstTradeUsd` is reported as a minimum and only described as a
 *              loss when it is actually below zero.
 *
 * `optional.volume` / `optional.trades` come from the directory file and are used only as
 * a labelled fallback for T10 when entry prices are too sparse to take a median.
 */
export async function scorecard(
  handle: string,
  optional: { volume?: number | null; trades?: number | null } = {},
  limit = 500,
): Promise<Scorecard | null> {
  if (!haveFomoapi()) throw new Error("FOMOAPI_KEY is not set");
  const doc = await tradesDoc(handle, limit);
  if (doc?.notFound) return null;

  const all: any[] = Array.isArray(doc?.trades) ? doc.trades : [];
  const available = doc?.available !== false;
  const caveats: string[] = [];

  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const when = (v: unknown): number | null => {
    if (typeof v !== "string") return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  };

  const closed = all.filter((t) => t?.status === "closed");
  const realized = closed.map((t) => num(t?.realizedPnlUsd)).filter((n): n is number => n !== null);

  // ---- T6/T7/T8/T9 -------------------------------------------------------
  const wins = realized.filter((n) => n > 0).length;
  const losses = realized.filter((n) => n < 0).length;
  const breakeven = realized.filter((n) => n === 0).length;
  const winRate = realized.length ? Number((wins / realized.length).toFixed(4)) : null;

  const best = realized.length ? Math.max(...realized) : null;
  const worst = realized.length ? Math.min(...realized) : null;
  // Denominator is gross gains. A net total can be zero or negative, which is exactly how
  // a "share" ends up reading 2000%.
  const gains = realized.filter((n) => n > 0).reduce((s, n) => s + n, 0);
  const topTradeShare = best !== null && best > 0 && gains > 0 ? Number((best / gains).toFixed(4)) : null;

  const meanTrade = realized.length ? realized.reduce((s, n) => s + n, 0) / realized.length : null;
  const medTrade = median(realized);
  // Sign discipline, same rule as realizedShare. A near-zero median makes this ratio
  // explode (measured: mean -$8,368 over median $0.15 renders "-56822x"), and a ratio
  // across a sign change describes nothing. Emit it only for a coherent positive record;
  // meanTradeUsd and medianTradeUsd are always returned so nothing is hidden.
  const meanToMedian =
    meanTrade !== null && medTrade !== null && meanTrade > 0 && medTrade > 0
      ? Number((meanTrade / medTrade).toFixed(2))
      : null;

  // ---- T2/T3/T10 — everything price-derived, gated on coverage ------------
  const entryRows = all
    .map((t) => ({ amount: num(t?.amount), px: num(t?.avgEntryPrice) }))
    .filter((r): r is { amount: number; px: number } => r.amount !== null && r.px !== null && r.px > 0);
  const exitRows = all
    .map((t) => ({ amount: num(t?.amount), px: num(t?.avgExitPrice) }))
    .filter((r): r is { amount: number; px: number } => r.amount !== null && r.px !== null && r.px > 0);

  const inUsd = entryRows.reduce((s, r) => s + r.amount * r.px, 0);
  const outUsd = exitRows.reduce((s, r) => s + r.amount * r.px, 0);
  const inCov = coverage(entryRows.length, all.length);
  const outCov = coverage(exitRows.length, all.length);

  // T3 on the closed subset only — an open position has not returned anything yet.
  const closedPriced = closed
    .map((t) => ({ amount: num(t?.amount), px: num(t?.avgEntryPrice), pnl: num(t?.realizedPnlUsd) }))
    .filter((r): r is { amount: number; px: number; pnl: number } =>
      r.amount !== null && r.px !== null && r.px > 0 && r.pnl !== null);
  const basis = closedPriced.reduce((s, r) => s + r.amount * r.px, 0);
  const closedPnl = closedPriced.reduce((s, r) => s + r.pnl, 0);
  const retCov = coverage(closedPriced.length, closed.length);
  const returnPct = basis > 0 ? Number(((closedPnl / basis) * 100).toFixed(2)) : null;

  const betSizes = entryRows.map((r) => r.amount * r.px).filter((n) => n > 0);
  // A median over a handful of rows is not a typical anything. Below a third of the
  // sample, fall back to the directory's lifetime volume/trades and SAY which was used.
  let bet: Scorecard["typicalBetUsd"];
  if (betSizes.length >= 5 && inCov.share !== null && inCov.share >= 0.33) {
    bet = { value: Number((median(betSizes) ?? 0).toFixed(2)), method: "entry_price", coverage: inCov };
  } else if (optional.volume && optional.trades && optional.trades > 0) {
    bet = {
      value: Number((optional.volume / optional.trades).toFixed(2)),
      method: "volume_per_trade",
      coverage: inCov,
    };
  } else {
    bet = { value: null, method: null, coverage: inCov };
  }

  // ---- T16/T18/T19/T20 — timestamps, which ARE fully populated -----------
  const holds = closed
    .map((t) => ({ a: when(t?.createdAt), b: when(t?.closedAt) }))
    .filter((r): r is { a: number; b: number } => r.a !== null && r.b !== null && r.b >= r.a)
    .map((r) => r.b - r.a);
  const medHoldMs = median(holds);
  const holdCov = coverage(holds.length, closed.length);

  const created = all.map((t) => when(t?.createdAt)).filter((n): n is number => n !== null);
  const lastActivity = Math.max(
    ...[...created, ...all.map((t) => when(t?.closedAt)).filter((n): n is number => n !== null)],
    -Infinity,
  );
  const firstAt = created.length ? Math.min(...created) : null;
  const lastAt = Number.isFinite(lastActivity) ? lastActivity : null;
  const spanDays = firstAt !== null && lastAt !== null ? (lastAt - firstAt) / 86_400_000 : null;
  const tradesPerDay =
    spanDays !== null && spanDays >= 1 && all.length ? Number((all.length / spanDays).toFixed(2)) : null;

  // ---- T5 (+T17) ---------------------------------------------------------
  const byTokenMap = new Map<string, TokenPnl>();
  for (const t of all) {
    const addr = t?.token?.address ?? null;
    const sym = t?.token?.symbol ?? null;
    const key = String(addr ?? sym ?? "unknown").toLowerCase();
    const rec =
      byTokenMap.get(key) ??
      { symbol: sym, address: addr, trades: 0, closed: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0,
        avgEntryPrice: null, avgExitPrice: null };
    rec.trades++;
    if (t?.status === "closed") {
      rec.closed++;
      rec.realizedPnlUsd += num(t?.realizedPnlUsd) ?? 0;
    } else {
      rec.unrealizedPnlUsd += num(t?.unrealizedPnlUsd) ?? 0;
    }
    // First usable value wins; these are absent on most rows and we do not average them,
    // because averaging two prices from different position sizes is not a price. Zero is
    // treated as absent — fomo returns avgEntryPrice: 0 for rows it has no price for, and
    // surfacing that as a price implies someone got in for nothing.
    const ep = num(t?.avgEntryPrice);
    const xp = num(t?.avgExitPrice);
    if (rec.avgEntryPrice === null && ep !== null && ep > 0) rec.avgEntryPrice = ep;
    if (rec.avgExitPrice === null && xp !== null && xp > 0) rec.avgExitPrice = xp;
    byTokenMap.set(key, rec);
  }
  const byToken = [...byTokenMap.values()]
    .map((r) => ({
      ...r,
      realizedPnlUsd: Number(r.realizedPnlUsd.toFixed(2)),
      unrealizedPnlUsd: Number(r.unrealizedPnlUsd.toFixed(2)),
    }))
    .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd || b.unrealizedPnlUsd - a.unrealizedPnlUsd);

  // ---- T15 ---------------------------------------------------------------
  const activeCount = num(doc?.activeCount);
  const closedCount = num(doc?.closedCount);
  const reportedTotal = num(doc?.count);
  const declared = (activeCount ?? 0) + (closedCount ?? 0);
  const reconciles = activeCount === null || closedCount === null ? true : declared === all.length;
  const samplePlain = reconciles
    ? `${all.length} trades on record.`
    : `fomo reports ${activeCount} open and ${closedCount} closed (${declared} total) but returned ` +
      `${all.length} rows — the figures below describe those ${all.length}, not the full history.`;
  if (!reconciles) caveats.push(samplePlain);
  if (inCov.share !== null && inCov.share < 0.5) {
    caveats.push(
      `Entry prices are present on only ${entryRows.length} of ${all.length} trades, so money-in, ` +
        `return % and typical bet size are computed from a minority of the record.`,
    );
  }
  if (entryRows.length !== exitRows.length) {
    caveats.push(
      `Money-in covers ${entryRows.length} trades and money-out covers ${exitRows.length} — different ` +
        `subsets of the record. The difference between them is NOT a profit figure.`,
    );
  }

  // ---- headline sentence -------------------------------------------------
  let plain: string;
  if (!available) {
    plain = "fomo could not serve this trader's trades just now.";
  } else if (!all.length) {
    plain = "No trades on record for this trader.";
  } else if (winRate === null) {
    plain = `${all.length} trades on record, but none are closed yet — there is no win rate to report.`;
  } else {
    const net = realized.reduce((s, n) => s + n, 0);
    // The net travels with the win rate, always. Measured on `unipcs`: 14 wins out of 25
    // (56%) alongside a net of -$209,403, because one loss was -$118,667. A win rate on
    // its own inverts that story completely.
    const w =
      `Closed ${realized.length} trades and made money on ${wins} of them ` +
      `(${Math.round(winRate * 100)}%), for a net of ${money(net)}.`;
    const conc =
      topTradeShare !== null && topTradeShare >= 0.5
        ? ` ${Math.round(topTradeShare * 100)}% of the gains came from a single trade.`
        : "";
    const held =
      medHoldMs !== null
        ? ` Typically holds for ${medHoldMs / 86_400_000 >= 1
            ? `${(medHoldMs / 86_400_000).toFixed(1)} days`
            : `${Math.round(medHoldMs / 3_600_000)} hours`}.`
        : "";
    plain = w + conc + held;
  }

  return {
    sample: {
      returned: all.length,
      reportedTotal,
      activeCount,
      closedCount,
      reconciles,
      plain: samplePlain,
    },
    winRate,
    wins,
    losses,
    breakeven,
    bestTradeUsd: best === null ? null : Number(best.toFixed(2)),
    worstTradeUsd: worst === null ? null : Number(worst.toFixed(2)),
    topTradeShare,
    meanToMedian,
    meanTradeUsd: meanTrade === null ? null : Number(meanTrade.toFixed(2)),
    medianTradeUsd: medTrade === null ? null : Number(medTrade.toFixed(2)),
    moneyIn: { usd: entryRows.length ? Number(inUsd.toFixed(2)) : null, coverage: inCov },
    moneyOut: { usd: exitRows.length ? Number(outUsd.toFixed(2)) : null, coverage: outCov },
    returnPct: { value: returnPct, coverage: retCov },
    typicalBetUsd: bet,
    holdingTime: {
      medianHours: medHoldMs === null ? null : Number((medHoldMs / 3_600_000).toFixed(2)),
      medianDays: medHoldMs === null ? null : Number((medHoldMs / 86_400_000).toFixed(2)),
      coverage: holdCov,
    },
    lastTradeAt: lastAt === null ? null : new Date(lastAt).toISOString(),
    lastTradeAgoHours: lastAt === null ? null : Number(((Date.now() - lastAt) / 3_600_000).toFixed(1)),
    firstTradeAt: firstAt === null ? null : new Date(firstAt).toISOString(),
    trackRecordDays: spanDays === null ? null : Number(spanDays.toFixed(1)),
    tradesPerDay,
    byToken,
    capturedAt: doc?.capturedAt ?? null,
    available,
    note: doc?.note ?? null,
    plain,
    caveats,
  };
}

// ---------------------------------------------------------------- K5 - K8

/**
 * How many holders we will pull trades for in one request.
 *
 * This is a hard budget, not a page size. Each holder costs one fomoapi call against a
 * 10,000/month free tier, so an uncapped board-wide version of this (100 traders, every 10
 * minutes) would burn 14,400 calls a day. Capped and cached, a token drill-down costs at
 * most CAP calls and shares its cache with /pnl and /scorecard.
 */
const HOLDER_CAP = 25;
/** Parallelism — enough to be quick, low enough not to look like an attack. */
const FANOUT = 5;

export type TokenActivity = {
  tokenAddress: string;
  symbol: string | null;
  /** How many holders we asked about, against how many hold it. */
  sampled: { holders: number; ofHolders: number; capped: boolean; failed: number };
  /** K7 — the one that matters most. Null means we could not establish it either way. */
  everSold: boolean | null;
  holdersWhoSold: number;
  holdersStillHolding: number;
  /** K6 — of holders with a closed position, how many closed it in profit. */
  winRate: number | null;
  winners: number;
  losers: number;
  /** K5 — mean of the entry prices fomo actually carries. */
  crowdAvgEntryPrice: { value: number | null; coverage: Coverage };
  /** K8 — direction of travel over the sampled trades. */
  flow: { opened: number; closed: number; verdict: "accumulating" | "distributing" | "mixed" | "unknown" };
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  perHolder: {
    handle: string;
    trades: number;
    closed: number;
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;
    avgEntryPrice: number | null;
    avgExitPrice: number | null;
    firstBuyAt: string | null;
    lastSellAt: string | null;
  }[];
  plain: string;
  caveats: string[];
};

/** Run `work` over `items` at most FANOUT at a time. */
async function pool<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += FANOUT) {
    out.push(...(await Promise.all(items.slice(i, i + FANOUT).map(work))));
  }
  return out;
}

/**
 * K5, K6, K7, K8 — what the leaders who hold a token have actually DONE with it.
 *
 * `/v1/tokens/:address` says who holds a token. This says whether any of them ever got out
 * of it, which is a different and much sharper question: a token every leader holds and
 * nobody has ever sold is the exact shape of a honeypot, and holder count alone cannot
 * distinguish that from a good call.
 *
 * Costs one fomoapi call per sampled holder (cached 10 min, shared with T1/T2-T20).
 */
export async function tokenActivity(
  handles: string[],
  tokenAddress: string,
  cap = HOLDER_CAP,
): Promise<TokenActivity> {
  const needle = tokenAddress.toLowerCase();
  const asked = handles.slice(0, cap);
  const caveats: string[] = [];
  let failed = 0;

  const rows = await pool(asked, async (handle) => {
    let doc: any;
    try {
      doc = await tradesDoc(handle, 500, false);
    } catch {
      failed++;
      return null;
    }
    const trades: any[] = Array.isArray(doc?.trades) ? doc.trades : [];
    const mine = trades.filter((t) => String(t?.token?.address ?? "").toLowerCase() === needle);
    if (!mine.length) return null;

    const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const closedRows = mine.filter((t) => t?.status === "closed");
    const sells = closedRows.map((t) => t?.closedAt).filter(Boolean).sort();
    const buys = mine.map((t) => t?.createdAt).filter(Boolean).sort();
    return {
      handle,
      symbol: mine.find((t) => t?.token?.symbol)?.token?.symbol ?? null,
      trades: mine.length,
      closed: closedRows.length,
      realizedPnlUsd: Number(closedRows.reduce((s, t) => s + (n(t?.realizedPnlUsd) ?? 0), 0).toFixed(2)),
      unrealizedPnlUsd: Number(
        mine.filter((t) => t?.status !== "closed").reduce((s, t) => s + (n(t?.unrealizedPnlUsd) ?? 0), 0).toFixed(2),
      ),
      avgEntryPrice: mine.map((t) => n(t?.avgEntryPrice)).find((x) => x !== null && x > 0) ?? null,
      avgExitPrice: mine.map((t) => n(t?.avgExitPrice)).find((x) => x !== null && x > 0) ?? null,
      firstBuyAt: buys[0] ?? null,
      lastSellAt: sells.length ? sells[sells.length - 1] : null,
      opened: mine.filter((t) => t?.status !== "closed").length,
    };
  });

  const found = rows.filter((r): r is NonNullable<typeof r> => r !== null);
  const withClosed = found.filter((r) => r.closed > 0);
  const winners = withClosed.filter((r) => r.realizedPnlUsd > 0).length;
  const losers = withClosed.filter((r) => r.realizedPnlUsd < 0).length;

  const entries = found.map((r) => r.avgEntryPrice).filter((x): x is number => x !== null && x > 0);
  const crowdEntry = entries.length
    ? Number((entries.reduce((s, x) => s + x, 0) / entries.length).toPrecision(8))
    : null;

  const opened = found.reduce((s, r) => s + r.opened, 0);
  const closedTotal = found.reduce((s, r) => s + r.closed, 0);
  const flowVerdict: TokenActivity["flow"]["verdict"] =
    !found.length ? "unknown"
      : closedTotal === 0 ? "accumulating"
      : opened === 0 ? "distributing"
      : opened > closedTotal * 2 ? "accumulating"
      : closedTotal > opened * 2 ? "distributing"
      : "mixed";

  // `everSold` is null, not false, when nobody we sampled has a trade record for it — an
  // absence of evidence here is not evidence of a honeypot.
  const everSold = found.length ? withClosed.length > 0 : null;

  if (asked.length < handles.length) {
    caveats.push(
      `${handles.length} leaders hold this; trades were pulled for the first ${asked.length} to stay ` +
        `inside the fomoapi budget.`,
    );
  }
  if (found.length < asked.length) {
    caveats.push(
      `${asked.length - found.length} of the ${asked.length} sampled holders have no fomo trade record ` +
        `for this token, so their behaviour is unknown.`,
    );
  }
  if (failed) {
    caveats.push(
      `${failed} holder lookup${failed === 1 ? "" : "s"} failed and ${failed === 1 ? "is" : "are"} excluded.`,
    );
  }

  let plain: string;
  if (!found.length) {
    plain = "None of the sampled holders have a fomo trade record for this token, so we cannot say what they have done with it.";
  } else if (everSold === false || withClosed.length === 0) {
    plain =
      `Not one of the ${found.length} holder${found.length === 1 ? "" : "s"} with a trade record for this ` +
      `token has ever closed a position in it. Every gain shown against it is on paper.`;
  } else {
    plain =
      `Of the ${found.length} holder${found.length === 1 ? "" : "s"} with a trade record for this token, ` +
      `${withClosed.length} ${withClosed.length === 1 ? "has" : "have"} sold at least part of the ` +
      `position and ${winners} came out ahead.`;
  }

  return {
    tokenAddress,
    symbol: found.find((r) => r.symbol)?.symbol ?? null,
    sampled: { holders: found.length, ofHolders: handles.length, capped: asked.length < handles.length, failed },
    everSold,
    holdersWhoSold: withClosed.length,
    holdersStillHolding: found.length - withClosed.length,
    winRate: withClosed.length ? Number((winners / withClosed.length).toFixed(4)) : null,
    winners,
    losers: losers,
    crowdAvgEntryPrice: { value: crowdEntry, coverage: coverage(entries.length, found.length) },
    flow: { opened, closed: closedTotal, verdict: flowVerdict },
    realizedPnlUsd: Number(found.reduce((s, r) => s + r.realizedPnlUsd, 0).toFixed(2)),
    unrealizedPnlUsd: Number(found.reduce((s, r) => s + r.unrealizedPnlUsd, 0).toFixed(2)),
    perHolder: found
      .map(({ opened: _o, symbol: _s, ...rest }) => rest)
      .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd),
    plain,
    caveats,
  };
}
