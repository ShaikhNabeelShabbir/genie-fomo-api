import { sql, n, round } from "../db.ts";
import { get, post } from "../router.ts";
import { notFound } from "../errors.ts";
import { intParam } from "../shared/params.ts";
import { cov, money } from "../shared/format.ts";
import { nativePrices } from "../shared/prices.ts";
import { resolveTrader } from "../shared/traders.ts";
import { encodeCursor, resumeAfter } from "../shared/cursor.ts";
import { batchIds, batchEnvelope } from "../shared/batch.ts";
import {
  CostBasis, PortfolioRow, costBasisFor, costBlock, coverageLow, indexerCoverageFor, latestIso, portfolioFrom,
  positionsPartialReason, sellFlags, unsellable,
} from "../shared/positions-core.ts";
import { SOL_MINT, ZERO_ADDRESS } from "../../_shared/chain_reads.ts";
import { type PriceSuspectReason, suspectRows, value } from "../../aum-sample/value.ts";
import { ladderPrice, oldestUsableDay } from "../shared/price-ladder.ts";

/** The chain's own coin: EVM native under the sentinel, SOL under the system-program key. */
const NATIVE_KEYS = new Set([ZERO_ADDRESS, SOL_MINT.toLowerCase()]);
const isNative = (tokenKey: unknown): boolean => NATIVE_KEYS.has(String(tokenKey));

/**
 * The amount a value is taken from: Solana's rolled-forward balance where the webhook feed has
 * one, else the balance as read. Same quantity `refreshAumLive` uses, so a row's `valueUsd` and
 * the trader's `/aum/now` figure are built from the same number (v5 fixes, A1).
 */
const liveAmount = (r: Record<string, unknown>): number | null =>
  n(r.human_amount_live) ?? n(r.human_amount);

/** A row's gross amount x price, before any ceiling withheld its `value` (V1). */
const gross = (r: Record<string, unknown>): number | null => {
  const a = liveAmount(r), p = n(r.price);
  return a !== null && p !== null ? a * p : null;
};

/**
 * The four price rungs as columns. Every positions query selects this fragment, so /positions,
 * the batch and /portfolio cannot price the same coin differently. Requires `h` (the holdings
 * row) plus `left join quote_assets q`, `token_price_stats ps` and `token_info ti` in scope.
 */
const ladderColumns = () => sql`
  q.pegged_usd,
  ps.last_usd as stats_usd, ps.last_at as stats_at,
  ti.price_usd as info_usd, ti.fetched_at as info_at,
  -- Packed day|usd: two columns would be two correlated seeks on an 11,000-row list.
  (select tp.day || '|' || tp.usd from token_prices tp
    where tp.network_id = h.network_id and tp.token_key = h.token_key
      and tp.usd > 0 and tp.day >= ${oldestUsableDay(new Date())}
    order by tp.day desc limit 1) as daily`;

/**
 * V5 A1/N1/R7: the row priced from the ladder AT REQUEST TIME, and revalued from that price.
 *
 * `holdings.price` is written by the balances job and frozen until the trader is read again --
 * a ~9 h round trip -- so a coin priced an hour ago still came back null, and the list
 * disagreed with `/aum/now` by construction. The one rung the ladder cannot reproduce is the
 * directory build's own reported entry price, so that alone survives as a fallback.
 */
const repriced = (r: Record<string, unknown>): Record<string, unknown> => {
  const p = ladderPrice(r);
  if (p === null) {
    return r.price_source === "fomo_reported_entry"
      ? r
      : { ...r, price: null, price_source: null, priced_at: null, value: null };
  }
  const amount = liveAmount(r);
  const usd = amount === null ? undefined : value(amount, p.usd, n(r.total_supply)).usd;
  return { ...r, price: p.usd, price_source: p.source, priced_at: p.at, value: usd ?? null };
};

/** Priced first, descending, unpriced trailing by address -- the SQL order, redone on ladder prices. */
const byValueThenAddress = (a: Record<string, unknown>, b: Record<string, unknown>): number => {
  const av = n(a.value), bv = n(b.value);
  if (av !== bv) return (bv ?? -Infinity) - (av ?? -Infinity);
  return String(a.address ?? a.token_address ?? "").localeCompare(String(b.address ?? b.token_address ?? ""));
};

/** V1b: one trader's rows judged together; an unsellable row is already out of the total and never enters the base. */
const suspectVerdicts = (rows: readonly Record<string, unknown>[]): (PriceSuspectReason | null)[] =>
  suspectRows(rows.map((r) => ({
    price: n(r.price), supply: n(r.total_supply), usd: unsellable(r) ? null : gross(r),
    liquidityUsd: n(r.liquidity_usd),
    /* N1: a dollar coin or a chain's own coin is not judged by the market checks. */
    quoteAsset: !!r.is_quote,
  })));

get("/v1/traders/:handle/portfolio", async ({ handle }, url) => {
  const [t] = await sql`
    select handle, display_handle, name from traders where handle = ${await resolveTrader(handle)}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  /**
   * The trader's rows, once; every figure below (per-chain breakdown, totals, top position,
   * cash share, asOf) is derived from them in memory.
   *
   * "Which chains are in this number" is not a nicety here: only Solana carries prices in
   * the current snapshot, so a cross-chain-looking AUM is in practice a Solana figure.
   * Saying so per chain is the difference between a total and a total that misleads.
   */
  const raw = await sql`
    select tk.address, h.network_id, h.token_key, c.name as chain, h.value, h.captured_at,
           h.human_amount, h.price, h.price_source,
           (q.token_key is not null) as is_quote, ti.is_honeypot, ti.can_not_sell,
           cast(coalesce(nullif(tk.total_supply, 0), nullif(ti.total_supply, 0)) as real) as total_supply,
           cast(ti.liquidity_usd as real) as liquidity_usd,
           ${ladderColumns()}
    from holdings_current h
    join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    join chains c on c.network_id = h.network_id
    left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    left join token_info ti on ti.network_id = h.network_id and ti.token_key = h.token_key
    where h.handle = ${t.handle}`;
  /**
   * The same ladder and the same suspect rule as /positions (v5 fixes, A1): this route used to
   * sum the stored `h.value` and apply no suspect rule at all, so one broken price put a
   * trillion dollars in `totalValueUsd` while `/positions` left it out.
   */
  const repricedRows = (raw as Record<string, unknown>[]).map(repriced);
  const portfolioVerdicts = suspectVerdicts(repricedRows);
  const rows = repricedRows.map((r, i) =>
    (portfolioVerdicts[i] === null ? r : { ...r, value: null })) as PortfolioRow[];
  const p = portfolioFrom(rows);

  /**
   * Is a particular coin inside this total, or outside it?
   *
   * The consuming screen shows AUM beside one coin's row, where "their whole portfolio" and
   * "their whole portfolio excluding this coin" are different statements. Rather than make
   * them subtract — and get it wrong when the position is unpriced — the route answers it.
   */
  const tokenQ = (url.searchParams.get("token") ?? "").trim().toLowerCase() || null;
  let includesToken: Record<string, unknown> | null = null;
  if (tokenQ) {
    const held = rows.filter((r: Record<string, unknown>) => String(r.token_key) === tokenQ);
    const priced = held.filter((r: Record<string, unknown>) => (n(r.value) ?? 0) > 0);
    includesToken = {
      tokenAddress: held[0]?.address ?? tokenQ,
      held: held.length > 0,
      // Held but unpriced means it is in the portfolio and NOT in the total — the case
      // most likely to be read wrongly if we only returned a boolean.
      inTotal: priced.length > 0,
      valueUsd: priced.length ? round(priced.reduce((a: number, r: Record<string, unknown>) => a + (n(r.value) ?? 0), 0)) : null,
      chains: [...new Set(held.map((r: Record<string, unknown>) => r.chain))],
      note: held.length === 0 ? "this trader does not hold that token"
        : priced.length === 0 ? "held, but unpriced — it is NOT part of totalValueUsd"
        : "held and priced — it IS part of totalValueUsd",
    };
  }

  // V2: a confirmed honeypot / unsellable coin is priced but not part of the total.
  const { positions, priced, total, cash } = p;
  const top = p.top ? n(p.top.value) : null;
  const unsellableUsd = round(p.unsellable)!;

  const natives = await nativePrices();
  const chainCoverage = p.byChain.map((r) => {
    const net = r.network_id;
    const usd = r.priced ? round(r.value) : null;
    const nat = natives.get(net) ?? null;
    return {
      chain: r.chain,
      networkId: net,
      positions: r.positions,
      priced: r.priced,
      valueUsd: usd,
      /** The same dollars said in the chain's own coin, which is how a wallet says them. See docs/DECISIONS.md#d071 */
      nativeSymbol: nat?.symbol ?? null,
      nativeUsd: nat?.usd ?? null,
      nativePriceSource: nat?.source ?? null,
      nativeAmount: nat?.usd && usd !== null
        ? Number((usd / nat.usd).toPrecision(10))
        : null,
      whyNoNative: !nat?.usd ? "no market price for this chain's own coin"
        : usd === null ? "nothing on this chain carries a price"
        : null,
    };
  });

  const base = {
    handle: t.display_handle,
    name: t.name ?? null,
    // The measurement time of every money figure below.
    asOf: p.asOf,
    positions,
    concentration: null as number | null,
    topPosition: null as unknown,
    totalValueUsd: null as number | null,
    cashShare: null as number | null,
    coverage: {
      pricedPositions: priced,
      unpricedPositions: positions - priced,
      pricedShare: positions ? Number((priced / positions).toFixed(4)) : null,
    },
    byChain: chainCoverage,
    ...(includesToken ? { includesToken } : {}),
    partial: (positions > 0 && priced / positions < 0.5) || unsellableUsd > 0,
    partialReason: unsellableUsd > 0 ? "unsellable_positions"
      : positions > 0 && priced / positions < 0.5 ? "unpriced_positions" : null,
    /** V2. Priced value in honeypot / unsellable coins, kept OUT of `totalValueUsd`. */
    unsellableUsd,
    plain: positions === 0
      ? "No positions on record."
      : "Holds positions, but none of them have a usable price — we cannot say how concentrated this is.",
  };
  if (!priced || total === null || top === null || total <= 0) return base;

  const tp = p.top;
  const share = top / total;
  const pct = Math.round(share * 100);
  const unpriced = positions - priced;

  // The sentence exists because the ratio alone misleads: "118 positions" reads as
  // diversified when 98% of the money is in one of them.
  let plain: string;
  if (priced === 1) plain = "Everything is in a single coin — there is nothing to spread the risk.";
  else if (pct >= 90) plain = `Holds ${positions} coins, but ${pct}% of the money is in just one of them.`;
  else if (pct >= 50) plain = `Holds ${positions} coins, with ${pct}% of the money in the biggest one.`;
  else plain = `Holds ${positions} coins, spread fairly evenly — the biggest is ${pct}% of the money.`;

  // When most of the portfolio has no price, the caveat has to LEAD — a trailing footnote
  // would let a 98% figure stand on a fraction of the evidence.
  if (priced / positions < 0.5) {
    plain = `Only ${priced} of ${positions} positions have a usable price, so this is a ` +
            `partial picture. Of what we can see, ${pct}% sits in one coin.`;
  } else if (unpriced > 0) {
    plain += ` (${unpriced} position${unpriced === 1 ? "" : "s"} had no price and are excluded.)`;
  }

  return {
    ...base,
    concentration: Number(share.toFixed(4)),
    topPosition: tp
      ? { tokenAddress: tp.address, networkId: Number(tp.network_id), valueUsd: round(n(tp.value)) }
      : null,
    totalValueUsd: round(total),
    cashShare: Number((cash / total).toFixed(4)),
    plain,
  };
});


// ---------------------------------------------------------- T12 positions

/** T1.1. See docs/DECISIONS.md#d072 */
const positionTiming = (addrs: string[]) => sql`
  select network_id, token_key, start_at, end_at, last_at
  from position_timing
  where address_key in (${addrs})`;


get("/v1/traders/:handle/positions", async ({ handle }, url) => {
  const [t] = await sql`
    select t.handle, t.display_handle, t.name, w.evm_address, w.sol_address
    from traders t left join wallets w using (handle)
    where t.handle = ${await resolveTrader(handle)}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const addrs = [t.evm_address, t.sol_address]
    .filter((a): a is string => !!a).map((a) => a.toLowerCase());

  const raw = await sql`
    select tk.address, h.network_id, h.token_key, c.name as chain, h.human_amount, h.price, h.value,
           -- PRD §3: a price is only judgeable if it says where it came from and when it
           -- was true. A live quote and a three-week-old reported entry are both usable and
           -- are not the same claim.
           h.price_source, h.priced_at, h.captured_at, h.source as balance_source,
           (q.token_key is not null) as is_quote,
           ti.is_honeypot, ti.can_not_sell, ps.drawdown_share,
           cast(coalesce(nullif(tk.total_supply, 0), nullif(ti.total_supply, 0)) as real) as total_supply,
           -- V1d: the best pair's liquidity, latest hourly sample first, else GMGN's; null = no pair known.
           cast(coalesce(ph.liquidity_usd, ti.liquidity_usd) as real) as liquidity_usd,
           -- Workflow gap 4: Solana rolled forward from the webhook feed since the read.
           h.human_amount_live, h.delta, h.last_transfer_at,
           ${ladderColumns()}
    from holdings_live h
    join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    join chains c on c.network_id = h.network_id
    left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    left join token_info ti on ti.network_id = h.network_id and ti.token_key = h.token_key
    left join token_price_stats ps on ps.network_id = h.network_id and ps.token_key = h.token_key
    -- The lateral's order by hour desc limit 1 is the rn = 1 row of the same ordering.
    left join (
      select network_id, token_key, liquidity_usd,
             row_number() over (partition by network_id, token_key order by hour desc) as rn
      from token_price_hourly
    ) ph on ph.network_id = h.network_id and ph.token_key = h.token_key and ph.rn = 1
    where h.handle = ${t.handle}`;

  /**
   * Priced rows first, descending. Unpriced rows TRAIL rather than being dropped: they are
   * real holdings we simply cannot value, and hiding them would misstate the count. Address
   * breaks the tie among the unpriced, which would otherwise be arbitrary.
   *
   * The sort is in memory because the value it sorts on is the LADDER value, which the stored
   * `h.value` the SQL used to order by no longer equals.
   */
  const rows = (raw as Record<string, unknown>[]).map(repriced).sort(byValueThenAddress);

  const [timing, costBy, coverBy] = await Promise.all([
    addrs.length ? positionTiming(addrs) : Promise.resolve([]),
    costBasisFor([t.handle as string]),
    indexerCoverageFor([t.handle as string]),
  ]);
  const costs = costBy.get(t.handle as string) ?? new Map<string, CostBasis>();
  /** R6. How much of each chain's activity the indexer holds; a thin chain makes the list partial. */
  const chains = coverBy.get(t.handle as string) ?? {};

  /** The floor under every timestamp on this page, derived in memory from `timing`. See docs/DECISIONS.md#d073 */
  const observedFrom = timing
    .map((r: Record<string, unknown>) => (r.start_at ? Date.parse(String(r.start_at)) : null))
    .filter((x: number | null): x is number => x !== null && Number.isFinite(x));
  const historyFrom = observedFrom.length
    ? new Date(Math.min(...observedFrom)).toISOString() : null;
  const timeBy = new Map<string, Record<string, unknown>>();
  for (const r of timing) timeBy.set(`${r.network_id}:${r.token_key}`, r);
  const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);

  const valued = (r: Record<string, unknown>) => ((n(r.value) ?? 0) > 0 ? n(r.value)! : 0);
  /** V1: the suspect verdict comes BEFORE the totals, so a broken price is never in one. */
  const verdicts = suspectVerdicts(rows);
  const suspectRow = (r: Record<string, unknown>, i: number) => !unsellable(r) && verdicts[i] !== null;
  const total = rows.reduce((s: number, r: Record<string, unknown>, i: number) => s + (unsellable(r) || suspectRow(r, i) ? 0 : valued(r)), 0);
  const unsellableUsd = round(rows.reduce((s: number, r: Record<string, unknown>) => s + (unsellable(r) ? valued(r) : 0), 0))!;
  const suspectUsd = round(rows.reduce((s: number, r: Record<string, unknown>, i: number) => s + (suspectRow(r, i) ? valued(r) : 0), 0))!;
  const all = rows.map((r: Record<string, unknown>, i: number) => {
    const tm = timeBy.get(`${r.network_id}:${r.token_key}`);
    const v = (n(r.value) ?? 0) > 0 ? n(r.value) : null;
    const suspect = verdicts[i];
    return {
      tokenAddress: r.address,
      networkId: Number(r.network_id),
      chain: r.chain,
      isNative: isNative(r.token_key),
      amount: n(r.human_amount) ?? 0,
      /** Solana: `amount` + signed transfers since `balanceAt` (see `liveBasis`). EVM: null. */
      amountLive: n(r.human_amount_live),
      deltaSinceRead: n(r.delta),
      lastTransferAt: iso(r.last_transfer_at),
      /**
       * PRD §3. When the balance was read, and whether we read it or were told it.
       *
       * `verified` means we called the chain; `reported` means a build said so. Those two
       * disagreed by more than a tenth on ten of twelve traders, so which one you are
       * holding is not a detail.
       */
      balanceAt: r.captured_at ? new Date(String(r.captured_at)).toISOString() : null,
      tier: r.balance_source === "chain" ? "verified"
        : r.balance_source === null ? "rolled_forward" : "reported",
      priceUsd: n(r.price),
      /**
       * Which rung priced it, AT REQUEST TIME (v5 fixes, A1/N1/R7):
       * pegged | token_price_stats | token_prices | token_info | fomo_reported_entry.
       * `token_price_stats` is the hourly DexScreener price and is new here -- this row used
       * to serve the price frozen into `holdings` at the last balance read, so a coin priced
       * an hour ago still came back null until the trader's next read, up to nine hours later.
       */
      priceSource: (r.price_source as string) ?? null,
      /** When that price was true. A reported entry price can be weeks old and says so. */
      pricedAt: r.priced_at ? new Date(String(r.priced_at)).toISOString() : null,
      /** Gap 1: 1 - last / ATH over our hourly samples (token_price_stats); null when never sampled. */
      drawdownShare: n(r.drawdown_share),
      // null, never 0 — 0 would imply we checked and found the position worthless.
      valueUsd: v === null ? null : round(v),
      /** Why there is no value, rather than an unexplained null. */
      whyNoPrice: v !== null ? null
        : n(r.price) !== null ? "price refused by the valuation ceilings; see priceSuspectReason"
        : "no price for this token on any rung of the ladder: no peg, no hourly sample, no " +
          "daily close inside seven days, and nothing from token_info",
      /** V1: the price fails a check a consumer cannot run alone (price x supply, concentration). The row keeps its figures; the totals do not. */
      priceSuspect: suspect !== null,
      priceSuspectReason: suspect,
      share: v !== null && total > 0 && !unsellable(r) && suspect === null ? Number((v / total).toFixed(4)) : null,
      isQuoteAsset: !!r.is_quote,
      ...sellFlags(r),
      /**
       * WHAT HE PAID FOR THIS, and the profit measured against it.
       *
       * `costUsd` is null rather than 0 when nothing we store says he bought it: coins arrive
       * by transfer too, and reading a transfer in as a free acquisition turns every airdrop
       * into infinite profit. `costReason` names which case a null is.
       */
      ...costBlock(costs.get(`${Number(r.network_id)}:${r.token_key}`),
                   n(r.human_amount), n(r.price)),
      /**
       * T1.1. First time we saw this token arrive, last time we saw any leave, and the last
       * movement of either kind. `null` means no on-chain record — which for a position
       * opened before ingestion began is the honest answer, not a claim that nothing
       * happened. Compare against `chainHistory.observedFrom` in the envelope.
       */
      startHoldingAt: iso(tm?.start_at),
      endHoldingAt: iso(tm?.end_at),
      lastActiveAt: iso(tm?.last_at),
    };
  });

  const filtered = url.searchParams.get("includeQuote") === "false"
    ? all.filter((r: Record<string, unknown>) => !r.isQuoteAsset) : all;
  /** PAGED, AND HONEST ABOUT IT. See docs/DECISIONS.md#d074 */
  const limit = intParam(url, "limit", { min: 1, max: 500, fallback: null });
  const cursor = url.searchParams.get("cursor");
  const rowId = (r: { chain: unknown; tokenAddress: unknown }) =>
    `${String(r.chain)}:${String(r.tokenAddress ?? "").toLowerCase()}`;
  const from = cursor ? resumeAfter(filtered, cursor, rowId) : 0;
  const page = limit === null ? filtered.slice(from) : filtered.slice(from, from + limit);
  const last = page.length ? page[page.length - 1] : null;
  const more = from + page.length < filtered.length;
  const priced = all.filter((r: Record<string, unknown>) => r.valueUsd !== null && !r.priceSuspect).length;
  const suspectPositions = all.filter((r: Record<string, unknown>) => r.priceSuspect).length;

  return {
    handle: t.display_handle,
    name: t.name ?? null,
    // This trader's snapshot, not the board's — chain-read rows and fomo builds are
    // stamped at different times, so a global max would misdate one of them. Taken from
    // the rows in hand: holdings_live carries every holdings_current row's captured_at.
    asOf: latestIso(rows.map((r: Record<string, unknown>) => r.captured_at)),
    /** What `amountLive` is: Solana is a roll-forward of webhook transfers, EVM the nightly read. */
    liveBasis: { solana: "rolled_forward_from_transfers", evm: "nightly_read" },
    count: page.length,
    positions: filtered.length,
    /** What was asked for, so a short page is legible as a page rather than a total. */
    limit,
    /**
     * Null when this page is the end of the list. Pass it back as `?cursor=` for the next
     * page; it names the row you stopped on, so the sequence survives the list changing
     * underneath you.
     */
    nextCursor: more && last ? encodeCursor([rowId(last)]) : null,
    /** False whenever rows remain. A consumer must not call a `false` page a portfolio. */
    complete: !more,
    /** Null means we could not value ANY of what he holds; zero means read and holding nothing (mirrors POST /traders/positions). */
    totalValueUsd: rows.length === 0 ? 0 : priced === 0 ? null : round(total),
    /** V2. Priced value in honeypot / unsellable coins, kept OUT of `totalValueUsd`. */
    unsellableUsd,
    /** V1. Priced value under a suspect price, kept OUT of `totalValueUsd`; the rows still show it. */
    suspectUsd,
    partial: unsellableUsd > 0 || coverageLow(chains) || suspectPositions > 0,
    partialReason: positionsPartialReason(unsellableUsd > 0, coverageLow(chains), suspectPositions > 0),
    coverage: {
      pricedPositions: priced, suspectPositions,
      /**
       * A1/A4: the share of the wallet `totalValueUsd` is built from, the same figure
       * `/aum/history` points and `/aum/now` carry, so the three are comparable at a glance.
       * A total under a quarter is a fragment of a portfolio, not a portfolio.
       */
      pricedShare: all.length ? Number((priced / all.length).toFixed(4)) : null,
      unpricedPositions: all.filter((r: Record<string, unknown>) => r.valueUsd === null).length, chains,
    },
    /** T1.1. See docs/DECISIONS.md#d075 */
    chainHistory: {
      observedFrom: historyFrom,
      note: "on-chain timing is a FLOOR, not a first event. Ingestion began part-way through " +
            "this trader's history, so a position opened earlier shows the first movement we " +
            "saw, not the first that happened. `observedFrom` is the earliest we hold for " +
            "this trader; positions without timing predate it or never moved on chain.",
      positionsWithTiming: all.filter((r: Record<string, unknown>) => r.startHoldingAt !== null).length,
      positionsWithoutTiming: all.filter((r: Record<string, unknown>) => r.startHoldingAt === null).length,
    },
    entries: page,
  };
});


/**
 * Positions for many traders in one call.
 *
 * POST rather than GET because fifty ids do not belong in a query string: a 2 KB URL breaks
 * proxies and fills logs. Nothing here mutates -- it is a read that needs a body.
 */
/** Positions for many traders in one call. See docs/DECISIONS.md#d076 */
post("/v1/traders/positions", async (_p, _url, body) => {
  const { requested, handles, asked, capped, traders: known } = await batchIds(body);
  /** THE FULL ENVELOPE IS THE DEFAULT. See docs/DECISIONS.md#d077 */
  const v2 = Number((body as { contractVersion?: number })?.contractVersion) !== 1;

  const raw = await sql`
    select h.handle, ch.name as chain, h.network_id, h.token_key,
           tk.address as token_address,
           coalesce(ti.symbol, tk.symbol) as symbol,
           h.human_amount, h.price, h.value, h.source, h.captured_at,
           h.price_source, h.priced_at, ti.is_honeypot, ti.can_not_sell, ps.drawdown_share,
           (q.token_key is not null) as is_quote,
           cast(coalesce(nullif(tk.total_supply, 0), nullif(ti.total_supply, 0)) as real) as total_supply,
           cast(coalesce(ph.liquidity_usd, ti.liquidity_usd) as real) as liquidity_usd,
           ${ladderColumns()}
    from holdings_current h
    join chains ch using (network_id)
    join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    left join token_info ti on ti.network_id = h.network_id and ti.token_key = h.token_key
    left join token_price_stats ps on ps.network_id = h.network_id and ps.token_key = h.token_key
    -- The lateral's order by hour desc limit 1 is the rn = 1 row of the same ordering.
    left join (
      select network_id, token_key, liquidity_usd,
             row_number() over (partition by network_id, token_key order by hour desc) as rn
      from token_price_hourly
    ) ph on ph.network_id = h.network_id and ph.token_key = h.token_key and ph.rn = 1
    where h.handle in (${handles})`;

  /**
   * Same ladder as the single route (v5 fixes, A1). This route reads `holdings_current`, not
   * `holdings_live`: rolling Solana forward per row for fifty traders at once exceeded D1's
   * per-query CPU budget, so a batch row carries the balance as read and says so with `tier`.
   */
  const rows = (raw as Record<string, unknown>[]).map(repriced);
  const by = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    if (!by.has(String(r.handle))) by.set(String(r.handle), []);
    by.get(String(r.handle))!.push(r);
  }
  for (const own of by.values()) own.sort(byValueThenAddress);

  /*
   * The newest balance read across the traders asked for -- taken from the rows already in
   * hand rather than from a second query, so dating the batch costs nothing.
   */
  const positionsAsOf = latestIso(rows.map((r: Record<string, unknown>) => r.captured_at));

  /** Same cost basis and indexer coverage the individual route serves, from the same functions. */
  const [costByHandle, coverByHandle] = await Promise.all([costBasisFor(handles), indexerCoverageFor(handles)]);

  /** V1: each trader's rows judged together, before any total (same rule as the single route). */
  const verdictBy = new Map([...by].map(([h, own]) => [h, suspectVerdicts(own)] as const));
  const suspectAt = (h: string, i: number) => verdictBy.get(h)?.[i] ?? null;

  const position = (r: Record<string, unknown>, i: number) => {
    const suspect = suspectAt(String(r.handle), i);
    return {
    chain: r.chain, networkId: Number(r.network_id),
    tokenAddress: r.token_address, symbol: r.symbol,
    isNative: isNative(r.token_key),
    amount: n(r.human_amount),
    ...costBlock(
      costByHandle.get(String(r.handle))?.get(`${Number(r.network_id)}:${r.token_key}`),
      n(r.human_amount), n(r.price)),
    /** §3: the moment the balance was read, not the moment you asked. */
    balanceAt: r.captured_at ? new Date(String(r.captured_at)).toISOString() : null,
    priceUsd: n(r.price),
    /** pegged | token_price_stats | token_prices | token_info | fomo_reported_entry */
    priceSource: (r.price_source as string) ?? null,
    pricedAt: r.priced_at ? new Date(String(r.priced_at)).toISOString() : null,
    drawdownShare: n(r.drawdown_share),
    valueUsd: round(n(r.value)),
    /** null, never 0 — an unpriceable coin is not a worthless one. */
    whyNoPrice: n(r.value) !== null ? null
      : n(r.price) !== null ? "price refused by the valuation ceilings; see priceSuspectReason"
      : "no price for this token in any source we hold",
    priceSuspect: suspect !== null,
    priceSuspectReason: suspect,
    tier: r.source === "chain" ? "verified" : "reported",
    ...sellFlags(r),
    };
  };

  if (v2) {
    return {
      contractVersion: 2,
      ...batchEnvelope(asked, capped, positionsAsOf),
      /* One row per requested id, successes and failures alike. */
      traders: requested.map((req, i) => {
        const h = handles[i];
        const meta = known.get(h);
        if (!meta) {
          return {
            ok: false as const,
            requested: req,
            id: null,
            handle: null,
            error: { code: "not_found", detail: `no trader '${req}' in the directory` },
          };
        }
        const own = by.get(h) ?? [];
        const valued = own.map((r, i) => ({ r, i })).filter(({ r }) => n(r.value) !== null && Number(r.value) > 0);
        const sum = (xs: { r: Record<string, unknown> }[]) => round(xs.reduce((s: number, { r }) => s + Number(r.value), 0))!;
        /*
         * A null total means we could not value ANY of what he holds; zero means he was read
         * and holds nothing. Collapsing the two would turn an unreadable portfolio into an
         * empty one, which is the difference between "we do not know" and "there is nothing".
         */
        const suspect = valued.filter(({ r, i }) => !unsellable(r) && suspectAt(h, i) !== null);
        const sellable = valued.filter(({ r, i }) => !unsellable(r) && suspectAt(h, i) === null);
        const unsellableUsd = sum(valued.filter(({ r }) => unsellable(r)));
        const suspectUsd = sum(suspect);
        const priced = valued.length - suspect.length;
        const totalValueUsd = own.length === 0 ? 0 : priced === 0 ? null : sum(sellable);
        const chains = coverByHandle.get(h) ?? {};
        const partialReason = positionsPartialReason(unsellableUsd > 0, coverageLow(chains), suspect.length > 0);
        return {
          ok: true as const,
          requested: req,
          id: meta.id,
          handle: meta.display_handle,
          positions: own.map(position),
          positionCount: own.length,
          pricedPositionCount: priced,
          suspectPositionCount: suspect.length,
          totalValueUsd,
          /** V2. Priced value in honeypot / unsellable coins, kept OUT of `totalValueUsd`. */
          unsellableUsd,
          /** V1. Priced value under a suspect price, kept OUT of `totalValueUsd`; the rows still show it. */
          suspectUsd,
          ...(partialReason ? { partial: true, partialReason } : {}),
          coverage: { ...cov(priced, own.length), chains },
          /*
           * Every position this trader holds is in this row -- the batch does not page, so a
           * consumer never has to wonder whether it saw all of them. `nextCursor` is null for
           * the same reason, and is present so the field means the same thing here as on the
           * individual route.
           */
          complete: true,
          nextCursor: null,
        };
      }),
    };
  }

  // ---- the pre-version-2 projection, unchanged so existing consumers keep working
  return {
    ...batchEnvelope(asked, capped, positionsAsOf),
    traders: handles.map((h) => {
      const own = by.get(h) ?? [];
      const priced = own.filter((r) => n(r.value) !== null && Number(r.value) > 0);
      return {
        handle: h,
        positions: own.map(position),
        coverage: cov(priced.length, own.length),
      };
    }),
  };
});
