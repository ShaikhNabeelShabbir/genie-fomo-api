import { sql, n, round } from "../db.ts";
import { get } from "../router.ts";
import { median, cov, money } from "../shared/format.ts";
import { NativePrice } from "../shared/prices.ts";

// ------------------------------------------------ T2, T3, T5-T10, T15-T20

/**
 * The trade rows a scorecard is computed from. One statement, so the bulk route can ask for
 * every trader at once instead of once per trader — measured, 137 traders cost 614ms against
 * 152ms for one, because Postgres groups them in a single pass.
 */
export const scorecardRows = (handles: string[]) => sql`
  select tr.handle,
         tr.trade_id, tr.network_id, tr.token_address, tr.token_key, tr.token_symbol,
         tr.status, tr.amount, tr.avg_entry_price, tr.avg_exit_price,
         tr.realized_pnl_usd, tr.unrealized_pnl_usd, tr.opened_at, tr.closed_at, tr.captured_at,
         /*
          * Supply, preferring the one we read ourselves and falling back to GMGN's.
          *
          * tokens.total_supply comes from load_token_supply.mjs and is null on 5,623 of
          * 13,184 trade pairs; token_info carries a supply for 5,000 of those. Where both
          * exist they agree within 1% on 1,089 of 1,128 tokens, so the fallback is the same
          * quantity from a second source rather than a different quantity.
          *
          * 0 is nulled first: a token cannot have zero supply, so a stored 0 means "not
          * read", and multiplying a price by it would publish an entry market cap of $0.
          *
          * The SOURCE travels with it. An entryMcap built on GMGN's supply is a different
          * claim from one built on a supply we read, and supplySource is what lets a
          * consumer tell them apart.
          */
         coalesce(nullif(tk.total_supply, 0), nullif(ti.total_supply, 0)) as total_supply,
         case when nullif(tk.total_supply, 0) is not null then tk.supply_source
              when nullif(ti.total_supply, 0) is not null then 'gmgn_token_info'
         end as supply_source,
         case when nullif(tk.total_supply, 0) is not null then tk.supply_read_at
              when nullif(ti.total_supply, 0) is not null then ti.fetched_at
         end as supply_read_at,
         -- Axis 5 wants the token's age at entry, which needs its creation time. GMGN carries
         -- it and we already store the whole document, so this is a read rather than a fetch.
         -- 0 means "they did not tell us" and is nulled here, not published as 1970.
         nullif((ti.raw->>'creation_timestamp')::bigint, 0) as token_created_unix
  from trades tr
  left join tokens tk on tk.network_id = tr.network_id and tk.token_key = tr.token_key
  left join token_info ti on ti.network_id = tr.network_id and ti.token_key = tr.token_key
  where tr.handle = any(${handles})`;


/** Dollars for a FEE, which is often a fraction of a cent. See docs/DECISIONS.md#d138 */
export const feeUsd = (v: number | null): number | null =>
  v === null || !Number.isFinite(v) ? null : Number(v.toFixed(6));

/** Fees a trader paid, per window, in dollars. See docs/DECISIONS.md#d139 */
export type FeeWindows = {
  usd: Record<string, number | null>;
  native: { symbol: string; amount: number; chains: number }[];
  txCount: number;
  chainsPriced: number;
  chainsTotal: number;
};

export async function feesFor(
  handles: string[], natives: Map<number, NativePrice>,
): Promise<Map<string, FeeWindows>> {
  const out = new Map<string, FeeWindows>();
  if (!handles.length) return out;
  const rows = await sql`
    select handle, network_id,
           sum(fee_native) filter (where day > (now() at time zone 'utc')::date - 1)  as w24h,
           sum(fee_native) filter (where day > (now() at time zone 'utc')::date - 7)  as w7d,
           sum(fee_native) filter (where day > (now() at time zone 'utc')::date - 30) as w30d,
           sum(fee_native)  as wall,
           sum(tx_count)::int as txs
    from trader_fees_daily
    where handle = any(${handles})
    group by handle, network_id`;

  for (const r of rows) {
    const h = String(r.handle);
    let f = out.get(h);
    if (!f) {
      out.set(h, f = {
        usd: { "24h": null, "7d": null, "30d": null, all: null },
        native: [], txCount: 0, chainsPriced: 0, chainsTotal: 0,
      });
    }
    const nat = natives.get(Number(r.network_id)) ?? null;
    f.txCount += Number(r.txs ?? 0);
    f.chainsTotal++;
    /*
     * Summed by SYMBOL, not by chain. ETH is the native coin of three of our five chains, so
     * a per-chain list showed "ETH" three times and left the reader to add them up -- and to
     * wonder whether the three were the same asset. They are.
     */
    const all = n(r.wall);
    if (all !== null && nat) {
      const hit = f.native.find((x) => x.symbol === nat.symbol);
      if (hit) { hit.amount += all; hit.chains++; }
      else f.native.push({ symbol: nat.symbol, amount: all, chains: 1 });
    }
    /*
     * A chain whose native coin we cannot price contributes NOTHING to the dollar total and
     * is counted in `chainsTotal` but not in `chainsPriced`. Adding zero for it would state
     * that trading there was free.
     */
    if (!nat?.usd) continue;
    f.chainsPriced++;
    for (const [key, col] of [["24h", "w24h"], ["7d", "w7d"], ["30d", "w30d"], ["all", "wall"]] as const) {
      const v = n(r[col]);
      if (v === null) continue;
      f.usd[key] = feeUsd((f.usd[key] ?? 0) + v * nat.usd);
    }
  }
  return out;
}


/** INDIVIDUAL BUYS, so a question about buys can be counted in buys. See docs/DECISIONS.md#d140 */
export type Buy = {
  at: string | null; txHash: string; amount: number;
  costUsd: number | null; priceUsd: number | null;
};


/** EVERY RESOLVED SWAP FOR THESE TRADERS, IN ONE QUERY. See docs/DECISIONS.md#d141 */
export type Swap = {
  handle: string; net: number; tokenKey: string; txHash: string;
  at: string | null; tokenDelta: number; quoteUsd: number | null;
};

export async function swapsFor(handles: string[]): Promise<Map<string, Swap[]>> {
  const out = new Map<string, Swap[]>();
  if (!handles.length) return out;
  const rows = await sql`
    select w.handle, ws.network_id, ws.token_key, ws.tx_hash, ws.block_time,
           ws.token_delta, ws.quote_usd
    from wallet_swaps ws
    join wallets w
      on lower(w.sol_address) = ws.address_key or w.evm_address_key = ws.address_key
    where w.handle = any(${handles})
    order by w.handle, ws.block_time asc`;
  for (const r of rows) {
    const h = String(r.handle);
    let a = out.get(h); if (!a) out.set(h, a = []);
    a.push({
      handle: h, net: Number(r.network_id), tokenKey: String(r.token_key),
      txHash: String(r.tx_hash),
      at: r.block_time ? new Date(String(r.block_time)).toISOString() : null,
      tokenDelta: n(r.token_delta) ?? 0, quoteUsd: n(r.quote_usd),
    });
  }
  return out;
}

/** The quantity-weighted entry price per "net:token", from the buys in one swap list. */
export function chainEntriesFrom(swaps: Swap[]): Map<string, number> {
  const acc = new Map<string, { usd: number; qty: number }>();
  for (const s of swaps) {
    if (s.tokenDelta <= 0 || s.quoteUsd === null) continue;
    const k = `${s.net}:${s.tokenKey}`;
    const a = acc.get(k) ?? { usd: 0, qty: 0 };
    a.usd += Math.abs(s.quoteUsd); a.qty += s.tokenDelta;
    acc.set(k, a);
  }
  const out = new Map<string, number>();
  for (const [k, a] of acc) if (a.qty > 0) out.set(k, a.usd / a.qty);
  return out;
}

/** Realised P&L per closing swap, valued against that token's entry price. */
export function chainExitsFrom(swaps: Swap[], entries: Map<string, number>): number[] {
  const out: number[] = [];
  for (const s of swaps) {
    if (s.tokenDelta >= 0 || s.quoteUsd === null) continue;
    const px = entries.get(`${s.net}:${s.tokenKey}`);
    if (px === undefined) continue;
    out.push(s.quoteUsd + s.tokenDelta * px);
  }
  return out;
}

/** The individual buys, grouped by "net:token", from the same rows. */
export function buysFrom(swaps: Swap[]): Map<string, Buy[]> {
  const out = new Map<string, Buy[]>();
  for (const s of swaps) {
    if (s.tokenDelta <= 0) continue;
    const k = `${s.net}:${s.tokenKey}`;
    let a = out.get(k); if (!a) out.set(k, a = []);
    const cost = s.quoteUsd === null ? null : Math.abs(s.quoteUsd);
    a.push({
      at: s.at, txHash: s.txHash, amount: s.tokenDelta,
      costUsd: cost === null ? null : round(cost),
      priceUsd: cost !== null && s.tokenDelta > 0
        ? Number((cost / s.tokenDelta).toPrecision(12)) : null,
    });
  }
  return out;
}

/** Everything the scorecard computes, over rows already fetched. See docs/DECISIONS.md#d142 */
// deno-lint-ignore no-explicit-any
/** THE BALANCE A TRADER STARTED EACH MONTH WITH — the denominator a monthly return needs. See docs/DECISIONS.md#d143 */
export const START_CAPITAL_WINDOW_DAYS = 7;

export async function monthStartCapital(handles: string[]): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (!handles.length) return out;
  const rows = await sql`
    select distinct on (handle, month)
           handle,
           to_char(date_trunc('month', at at time zone 'utc'), 'YYYY-MM') as month,
           total_usd,
           extract(day from (at at time zone 'utc'))::int as day_of_month
    from aum_samples
    where handle = any(${handles}) and total_usd is not null
    order by handle, month, at asc`;
  for (const r of rows) {
    if (Number(r.day_of_month) > START_CAPITAL_WINDOW_DAYS) continue;
    const h = String(r.handle);
    let m = out.get(h); if (!m) out.set(h, m = new Map());
    m.set(String(r.month), Number(r.total_usd));
  }
  return out;
}

export async function scorecardBody(
  t: any, rows: any[], tokenLimit: number | null,
  chain?: { entries: Map<string, number>; exits: number[] },
  feeWindows?: FeeWindows | null,
  buys?: Map<string, Buy[]> | null,
  /** month (YYYY-MM) -> the balance he entered it with. See monthStartCapital(). */
  startCapital?: Map<string, number> | null,
) {
  const chainEntry = chain?.entries ?? new Map<string, number>();
  const chainExits = chain?.exits ?? [];
  const fw = feeWindows ?? null;

  /** WHEN THIS TRADER'S RECORD WAS LAST LOADED — the NEWEST row, not the first one. See docs/DECISIONS.md#d144 */
  const loadedAtIso = (() => {
    const times = rows
      .map((r) => (r.captured_at ? Date.parse(String(r.captured_at)) : null))
      .filter((x): x is number => x !== null && Number.isFinite(x));
    return times.length ? new Date(Math.max(...times)).toISOString() : null;
  })();

  const closed = rows.filter((r) => r.status === "closed");
  const realized = closed.map((r) => n(r.realized_pnl_usd)).filter((x): x is number => x !== null);

  const wins = realized.filter((x) => x > 0).length;
  const losses = realized.filter((x) => x < 0).length;
  const breakeven = realized.filter((x) => x === 0).length;
  const winRate = realized.length ? Number((wins / realized.length).toFixed(4)) : null;

  const best = realized.length ? Math.max(...realized) : null;
  const worst = realized.length ? Math.min(...realized) : null;
  // Denominator is GROSS gains. A net total can be zero or negative, which is exactly how
  // a "share of profit" ends up reading 2000%.
  const gains = realized.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const topTradeShare = best !== null && best > 0 && gains > 0
    ? Number((best / gains).toFixed(4)) : null;

  const meanTrade = realized.length ? realized.reduce((a, b) => a + b, 0) / realized.length : null;
  const medTrade = median(realized);
  // Same sign discipline as everywhere else: a mean of -$8,368 over a median of $0.15
  // yields "-56,822x", which is arithmetically true and informationally worthless.
  const meanToMedian = meanTrade !== null && medTrade !== null && meanTrade > 0 && medTrade > 0
    ? Number((meanTrade / medTrade).toFixed(2)) : null;

  // `id` is carried so the caveat below can compare set MEMBERSHIP, not just counts.
  const entryRows = rows
    .map((r) => ({ id: String(r.trade_id), amount: n(r.amount), px: n(r.avg_entry_price) }))
    .filter((r): r is { id: string; amount: number; px: number } =>
      r.amount !== null && r.px !== null && r.px > 0);
  const exitRows = rows
    .map((r) => ({ id: String(r.trade_id), amount: n(r.amount), px: n(r.avg_exit_price) }))
    .filter((r): r is { id: string; amount: number; px: number } =>
      r.amount !== null && r.px !== null && r.px > 0);
  const inCov = cov(entryRows.length, rows.length);
  const outCov = cov(exitRows.length, rows.length);

  /** T3 — return on cost basis, and the derivation matters. See docs/DECISIONS.md#d145 */
  const closedPriced = closed
    .map((r) => {
      const entry = n(r.avg_entry_price);
      const exit = n(r.avg_exit_price);
      const pnl = n(r.realized_pnl_usd);
      if (entry === null || exit === null || pnl === null) return null;
      if (entry <= 0 || exit <= 0 || exit === entry) return null;
      const basis = (pnl * entry) / (exit - entry);
      if (!Number.isFinite(basis) || basis <= 0) return null;
      return { basis, pnl };
    })
    .filter((r): r is { basis: number; pnl: number } => r !== null);
  const basis = closedPriced.reduce((s, r) => s + r.basis, 0);
  const closedPnl = closedPriced.reduce((s, r) => s + r.pnl, 0);

  const betSizes = entryRows.map((r) => r.amount * r.px).filter((x) => x > 0);
  // A median over a handful of rows is not a typical anything. Below a third of the record,
  // fall back to the directory's lifetime volume/trades and SAY which was used.
  let bet: { value: number | null; method: string | null; coverage: ReturnType<typeof cov> };
  if (betSizes.length >= 5 && inCov.share !== null && inCov.share >= 0.33) {
    bet = { value: round(median(betSizes)), method: "entry_price", coverage: inCov };
  } else if (n(t.volume_usd) && n(t.trade_count)) {
    bet = { value: round(n(t.volume_usd)! / n(t.trade_count)!), method: "volume_per_trade", coverage: inCov };
  } else bet = { value: null, method: null, coverage: inCov };

  const ms = (v: unknown) => (v ? Date.parse(String(v)) : null);
  const holds = closed
    .map((r) => ({ a: ms(r.opened_at), b: ms(r.closed_at) }))
    .filter((r): r is { a: number; b: number } => r.a !== null && r.b !== null && r.b >= r.a)
    .map((r) => r.b - r.a);
  const medHold = median(holds);

  const opened = rows.map((r) => ms(r.opened_at)).filter((x): x is number => x !== null);
  const allTimes = [...opened, ...rows.map((r) => ms(r.closed_at)).filter((x): x is number => x !== null)];
  const firstAt = opened.length ? Math.min(...opened) : null;
  const lastAt = allTimes.length ? Math.max(...allTimes) : null;
  const spanDays = firstAt !== null && lastAt !== null ? (lastAt - firstAt) / 86_400_000 : null;

  /** ISSUE-4. See docs/DECISIONS.md#d146 */
  const legQty = (r: Record<string, unknown>): number | null => {
    // The TS twin of the `trade_qty()` SQL function used by K5, deliberately kept in step:
    // the scorecard aggregates in JS and K5 in SQL, and two different answers to "what did
    // they pay to get in" is exactly the incoherence this fixes.
    if (r.status !== "closed") {
      const a = n(r.amount);
      return a !== null && a > 0 ? a : null;
    }
    // On a closed position `amount` is what REMAINS — nothing, it was sold. Weighting by it
    // would repeat BUG-1. Recover the traded quantity from BUG-1's own identity instead:
    // realized pnl = qty x (exit - entry).
    const pnl = n(r.realized_pnl_usd), e = n(r.avg_entry_price), x = n(r.avg_exit_price);
    if (pnl === null || e === null || x === null || x === e) return null;
    const q = pnl / (x - e);
    return Number.isFinite(q) && q > 0 ? q : null;
  };

  type Leg = { sum: number; weight: number; legs: number; weighted: number;
               first: number | null; firstKey: string };
  const emptyLeg = (): Leg => ({ sum: 0, weight: 0, legs: 0, weighted: 0, first: null, firstKey: "" });

  const byTokenMap = new Map<string, {
    symbol: string | null; address: string | null; trades: number; closed: number;
    realizedPnlUsd: number; unrealizedPnlUsd: number;
    entry: Leg; exit: Leg;
    totalSupply: number | null; supplySource: string | null; supplyReadAt: string | null;
    tokenCreatedUnix: number | null; firstOpenedMs: number | null;
    /* When this coin was first and last closed, so a per-coin row carries its own dates. */
    firstClosedMs: number | null; lastClosedMs: number | null;
    chainKey: string;
  }>();
  for (const r of rows) {
    const key = String(r.token_key ?? r.token_symbol ?? "unknown");
    const rec = byTokenMap.get(key) ?? {
      symbol: (r.token_symbol as string) ?? null, address: (r.token_address as string) ?? null,
      trades: 0, closed: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0,
      entry: emptyLeg(), exit: emptyLeg(),
      totalSupply: n(r.total_supply), supplySource: (r.supply_source as string) ?? null,
      supplyReadAt: r.supply_read_at ? new Date(String(r.supply_read_at)).toISOString() : null,
      tokenCreatedUnix: n(r.token_created_unix),
      // Earliest position opened in this token, so age-at-entry can be derived per token.
      firstOpenedMs: null as number | null,
      firstClosedMs: null as number | null, lastClosedMs: null as number | null,
      // Chain AND token, because one token_key can exist on two chains and their prices
      // have nothing to do with each other.
      chainKey: `${r.network_id}:${r.token_key}`,
    };
    rec.trades++;
    if (r.status === "closed") {
      rec.closed++; rec.realizedPnlUsd += n(r.realized_pnl_usd) ?? 0;
      const cms = r.closed_at ? Date.parse(String(r.closed_at)) : NaN;
      if (Number.isFinite(cms)) {
        rec.firstClosedMs = rec.firstClosedMs === null ? cms : Math.min(rec.firstClosedMs, cms);
        rec.lastClosedMs  = rec.lastClosedMs  === null ? cms : Math.max(rec.lastClosedMs, cms);
      }
    }
    else rec.unrealizedPnlUsd += n(r.unrealized_pnl_usd) ?? 0;

    const openedAt = ms(r.opened_at);
    if (openedAt !== null && (rec.firstOpenedMs === null || openedAt < rec.firstOpenedMs)) {
      rec.firstOpenedMs = openedAt;
    }

    const qty = legQty(r);
    // Ordered by open time, tie-broken on trade_id, so `first` does not depend on the order
    // rows happen to arrive in — the previous code took whatever the query yielded first.
    //
    // Compared as a zero-padded epoch, NOT as a stringified Date: postgres.js hands back a
    // Date whose toString is "Wed Apr 10 2026 …", and comparing those lexicographically
    // sorts by weekday name — "Fri Aug" lands before "Wed Apr". Caught by firstEntryPrice
    // returning the wrong leg on a 7-position token.
    const openedMs = ms(r.opened_at);
    const sortKey = `${String(openedMs ?? 9e15).padStart(16, "0")}|${String(r.trade_id)}`;
    // The loader already stores fomo's `0` as NULL, because a $0 entry price implies
    // someone got in for nothing.
    for (const [px, acc] of [[n(r.avg_entry_price), rec.entry], [n(r.avg_exit_price), rec.exit]] as const) {
      if (px === null || px <= 0) continue;
      acc.legs++;
      if (acc.first === null || sortKey < acc.firstKey) { acc.first = px; acc.firstKey = sortKey; }
      if (qty !== null) { acc.sum += px * qty; acc.weight += qty; acc.weighted++; }
    }
    byTokenMap.set(key, rec);
  }

  /** Resolve a leg accumulator to one price plus the method that produced it. See docs/DECISIONS.md#d147 */
  const resolve = (a: Leg) => {
    const method = a.legs === 0 ? null
      : a.legs === 1 ? "single_position"
      : a.weighted === a.legs ? "weighted"
      : a.weighted > 0 ? "weighted_partial"
      : "first_only";
    const value = a.legs === 0 ? null
      : method === "single_position" || method === "first_only" ? a.first
      : a.weight > 0 ? a.sum / a.weight : a.first;
    return { value, method, legs: a.legs, legsWeighted: a.weighted, first: a.first,
             sum: a.sum, weight: a.weight };
  };
  const byToken = [...byTokenMap.values()]
    .map(({ entry, exit, tokenCreatedUnix, firstOpenedMs, firstClosedMs, lastClosedMs, chainKey, ...r }) => {
      const e = resolve(entry), x = resolve(exit);
      /** Axis 5. See docs/DECISIONS.md#d148 */
      const chainPx = e.value === null ? (chainEntry.get(chainKey) ?? null) : null;
      const entryPx = e.value ?? chainPx;
      // 12 significant figures, not a decimal rounding: these prices run to 0.0000101253 and
      // `round(v, 2)` would flatten a real entry to zero. At 12 figures every value that was
      // a single position comes back bit-identical to what it returned before, so the only
      // rows that move are the ones ISSUE-4 is about.
      const px = (v: number | null) => (v === null ? null : Number(v.toPrecision(12)));
      return {
      ...r,
      realizedPnlUsd: round(r.realizedPnlUsd)!,
      unrealizedPnlUsd: round(r.unrealizedPnlUsd)!,
      avgEntryPrice: px(entryPx),
      avgExitPrice: px(x.value),
      /** `reported` = fomo's, `chain` = derived from the wallet's own resolved buys. */
      entryPriceSource: entryPx === null ? null : (e.value !== null ? "reported" : "chain"),
      /** Which of three computations produced the price above, and over how many positions. See docs/DECISIONS.md#d149 */
      entryMethod: e.method,
      entryPositions: e.legs,
      entryPositionsWeighted: e.legsWeighted,
      exitMethod: x.method,
      /** The pre-ISSUE-4 value, kept so anyone reading the old field can reconcile. */
      firstEntryPrice: px(e.first),
      /** When the token itself was created, and how old it was when this trader first opened a posi See docs/DECISIONS.md#d150 */
      tokenCreatedAt: tokenCreatedUnix !== null
        ? new Date(tokenCreatedUnix * 1000).toISOString()
        : null,
      tokenAgeAtEntryDays: tokenCreatedUnix !== null && firstOpenedMs !== null
        ? Number(((firstOpenedMs - tokenCreatedUnix * 1000) / 86_400_000).toFixed(2))
        : null,
      /** When this coin was closed, first and last. See docs/DECISIONS.md#d151 */
      firstClosedAt: firstClosedMs !== null ? new Date(firstClosedMs).toISOString() : null,
      lastClosedAt:  lastClosedMs  !== null ? new Date(lastClosedMs).toISOString()  : null,
      /** Entry expressed as a MARKET CAP, which is how it is read on screen. See docs/DECISIONS.md#d152 */
      avgEntryMarketCapUsd:
        entryPx !== null && r.totalSupply !== null && r.totalSupply > 0
          ? Number((entryPx * r.totalSupply).toPrecision(10))
          : null,
      avgExitMarketCapUsd:
        x.value !== null && r.totalSupply !== null && r.totalSupply > 0
          ? Number((x.value * r.totalSupply).toPrecision(10))
          : null,
      /** DOLLARS IN AND DOLLARS OUT on this coin, which is what "how much a bet" and the profit ban See docs/DECISIONS.md#d153 */
      costUsd: e.legsWeighted > 0 ? round(e.sum) : null,
      proceedsUsd: x.legsWeighted > 0 ? round(x.sum) : null,
      /** The quantity each sum was taken over, so the division can be rechecked. */
      costQuantity: e.legsWeighted > 0 ? e.weight : null,
      proceedsQuantity: x.legsWeighted > 0 ? x.weight : null,
      /** How many of this coin's positions contributed dollars, against how many had a price. */
      costCoverage: cov(e.legsWeighted, e.legs),
      proceedsCoverage: cov(x.legsWeighted, x.legs),
      whyNoCostUsd: e.legsWeighted > 0 ? null
        : (e.legs === 0
          ? "no position in this coin carries an entry price"
          : "entry prices are present but no position has a recoverable quantity"),
      whyNoProceedsUsd: x.legsWeighted > 0 ? null
        : (x.legs === 0
          ? "nothing in this coin has been sold, or no sale carries an exit price"
          : "exit prices are present but no position has a recoverable quantity"),
      /** A REASON BESIDE EVERY NULL ON THIS ROW, from a fixed vocabulary. See docs/DECISIONS.md#d154 */
      /** THE BUYS THEMSELVES, where we hold them. See docs/DECISIONS.md#d155 */
      buys: (() => {
        const list = buys?.get(chainKey) ?? [];
        return list.slice(0, 100).map((b) => ({
          at: b.at, txHash: b.txHash, amount: b.amount,
          costUsd: b.costUsd, priceUsd: b.priceUsd,
          marketCapUsd: b.priceUsd !== null && r.totalSupply !== null && r.totalSupply > 0
            ? Number((b.priceUsd * r.totalSupply).toPrecision(10)) : null,
        }));
      })(),
      buysTotal: (buys?.get(chainKey) ?? []).length,
      fieldReasons: (() => {
        const why: Record<string, string> = {};
        if (entryPx === null) why.avgEntryPrice = "historical_input_missing";
        if (e.legsWeighted === 0) why.costUsd = "historical_input_missing";
        if (x.value === null) {
          // Nothing sold is a different statement from sold-but-unpriced.
          why.avgExitPrice = r.closed === 0 ? "not_applicable" : "historical_input_missing";
        }
        if (x.legsWeighted === 0) {
          why.proceedsUsd = r.closed === 0 ? "not_applicable" : "historical_input_missing";
        }
        if (r.totalSupply === null) why.totalSupply = "source_unavailable";
        if (entryPx === null || r.totalSupply === null || !(r.totalSupply > 0)) {
          why.avgEntryMarketCapUsd = entryPx === null
            ? "historical_input_missing" : "source_unavailable";
        }
        if (x.value === null || r.totalSupply === null || !(r.totalSupply > 0)) {
          why.avgExitMarketCapUsd = x.value === null
            ? (r.closed === 0 ? "not_applicable" : "historical_input_missing")
            : "source_unavailable";
        }
        if (tokenCreatedUnix === null) why.tokenCreatedAt = "source_unavailable";
        if (tokenCreatedUnix === null || firstOpenedMs === null) {
          why.tokenAgeAtEntryDays = tokenCreatedUnix === null
            ? "source_unavailable" : "historical_input_missing";
        }
        /*
         * No individual buys for this coin. `source_unavailable` rather than
         * `historical_input_missing`: the fills happened, and the reason we cannot show them
         * is that no resolver reaches this coin's chain, not that a value went unrecorded.
         */
        if ((buys?.get(chainKey) ?? []).length === 0) why.buys = "source_unavailable";
        if (firstClosedMs === null) why.firstClosedAt = "not_applicable";
        if (lastClosedMs === null) why.lastClosedAt = "not_applicable";
        return why;
      })(),
      };
    })
    .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd ||
                    b.unrealizedPnlUsd - a.unrealizedPnlUsd ||
                    String(a.address).localeCompare(String(b.address)));

  const caveats: string[] = [];
  if (inCov.share !== null && inCov.share < 0.5) {
    caveats.push(`Entry prices are present on only ${entryRows.length} of ${rows.length} trades, ` +
      `so money-in, return % and typical bet size are computed from a minority of the record.`);
  }
  /** Compare the SETS, not their sizes. See docs/DECISIONS.md#d156 */
  const entryIds = new Set(entryRows.map((r) => r.id));
  const exitIds = new Set(exitRows.map((r) => r.id));
  const shared = [...entryIds].filter((id) => exitIds.has(id)).length;
  if (shared < entryIds.size || shared < exitIds.size) {
    caveats.push(`Money-in covers ${entryIds.size} trades and money-out covers ${exitIds.size}, but ` +
      `only ${shared} are the same trade — money-in includes positions still open, which have no ` +
      `exit yet. Subtracting one from the other is NOT a profit figure; use returnPct or /pnl.`);
  }

  let plain: string;
  if (winRate === null) {
    plain = `${rows.length} trades on record, but none are closed yet — there is no win rate to report.`;
  } else {
    const net = realized.reduce((a, b) => a + b, 0);
    // The net travels with the win rate, ALWAYS. 56% wins alongside a net of -$209,204 is
    // the exact shape of misleading headline this API exists to avoid.
    plain = `Closed ${realized.length} trades and made money on ${wins} of them ` +
            `(${Math.round(winRate * 100)}%), for a net of ${money(net)}.`;
    if (topTradeShare !== null && topTradeShare >= 0.5) {
      plain += ` ${Math.round(topTradeShare * 100)}% of the gains came from a single trade.`;
    }
    if (medHold !== null) {
      plain += ` Typically holds for ${medHold / 86_400_000 >= 1
        ? `${(medHold / 86_400_000).toFixed(1)} days` : `${Math.round(medHold / 3_600_000)} hours`}.`;
    }
  }

  /** T4 — profit by window. See docs/DECISIONS.md#d157 */
  /** Computed from `rows`, not from a second query. See docs/DECISIONS.md#d158 */
  const nowMs = Date.now();
  const closedDated = rows.filter((r) =>
    r.status === "closed" && r.closed_at !== null && r.closed_at !== undefined);
  const windowAgg = (sinceMs: number | null, windowKey: string) => {
    const inWindow = sinceMs === null
      ? closedDated
      : closedDated.filter((r) => Date.parse(String(r.closed_at)) > sinceMs);
    // `sum()` skips NULLs and `coalesce(..., 0)` makes an empty window zero — matched here,
    // because a window with no closed trades earned nothing, which is a real 0 and not a
    // missing value.
    const total = inWindow.reduce((acc, r) => acc + (n(r.realized_pnl_usd) ?? 0), 0);

    /** VOLUME THIS WINDOW, MEASURED RATHER THAN REPORTED. See docs/DECISIONS.md#d159 */
    let volume = 0, volumed = 0;
    for (const r of inWindow) {
      const q = legQty(r), e = n(r.avg_entry_price), x = n(r.avg_exit_price);
      if (q === null || e === null || x === null) continue;
      volume += q * e + q * x;
      volumed++;
    }
    return {
      realizedUsd: round(total),
      closedTrades: inWindow.length,
      /** Both legs of each round trip. Null, never 0, when no position carried the inputs. */
      volumeUsd: volumed > 0 ? round(volume) : null,
      volumeCoverage: cov(volumed, inWindow.length),
      whyNoVolume: volumed > 0 ? null
        : (inWindow.length === 0
          ? "no position closed in this window"
          : "no closed position in this window carries an entry price, an exit price and a " +
            "recoverable quantity"),
      /**
       * Fees are NOT deducted from `realizedUsd`, and nothing here can deduct them: no fee
       * or gas figure is stored on any trade or transfer we hold. See `fees` on the response.
       *
       * `feesUsd` is null rather than 0 and always will be until fees are stored: zero would
       * claim this window cost nothing to trade, which is certainly false.
       */
      includesFees: false,
      /**
       * What this window cost to trade. Null, never 0, when we hold no fee for it -- a window
       * with trades in it was never free. `fees` on the response carries the caveat: the
       * dollar figure applies today's native price to a payment made in the past, because no
       * historical native price is stored. The native figure there is the exact one.
       */
      feesUsd: fw ? (fw.usd[windowKey] ?? null) : null,
      feesCoverage: fw ? cov(fw.chainsPriced, fw.chainsTotal) : cov(0, 0),
    };
  };

  /** THE SAME SUM, BROKEN OUT BY DAY. See docs/DECISIONS.md#d160 */
  const dayBuckets = new Map<string, { realizedUsd: number; closedTrades: number }>();
  const since30 = nowMs - 30 * 86_400_000;
  for (const r of closedDated) {
    const ms = Date.parse(String(r.closed_at));
    if (!Number.isFinite(ms) || ms <= since30) continue;
    const day = new Date(ms).toISOString().slice(0, 10);
    const b = dayBuckets.get(day) ?? { realizedUsd: 0, closedTrades: 0 };
    b.realizedUsd += n(r.realized_pnl_usd) ?? 0;
    b.closedTrades++;
    dayBuckets.set(day, b);
  }
  const realizedByDay = [...dayBuckets.entries()]
    .sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([day, v]) => ({ day, realizedUsd: round(v.realizedUsd), closedTrades: v.closedTrades }));

  /** THE SAME GROUPING, BY CALENDAR MONTH, for "worst month" and the bad-days test. See docs/DECISIONS.md#d161 */
  const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7);
  const nowMonth = monthKey(nowMs);
  const firstMonthDate = new Date(nowMs);
  firstMonthDate.setUTCDate(1);
  firstMonthDate.setUTCHours(0, 0, 0, 0);
  firstMonthDate.setUTCMonth(firstMonthDate.getUTCMonth() - 12);
  const since12m = firstMonthDate.getTime();

  const monthBuckets = new Map<string,
    { realizedUsd: number; closedTrades: number; withFigure: number }>();
  for (const r of closedDated) {
    const ms = Date.parse(String(r.closed_at));
    if (!Number.isFinite(ms) || ms < since12m) continue;
    const m = monthKey(ms);
    const b = monthBuckets.get(m) ?? { realizedUsd: 0, closedTrades: 0, withFigure: 0 };
    const pnl = n(r.realized_pnl_usd);
    if (pnl !== null) { b.realizedUsd += pnl; b.withFigure++; }
    b.closedTrades++;
    monthBuckets.set(m, b);
  }
  const realizedByMonth = [...monthBuckets.entries()]
    .sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([month, v]) => ({
      month,
      realizedUsd: v.withFigure === 0 ? null : round(v.realizedUsd),
      closedTrades: v.closedTrades,
      coverage: cov(v.withFigure, v.closedTrades),
      /** False for the month still running, so a part-month is not compared with whole ones. */
      complete: month !== nowMonth,
      /**
       * What a return percentage would need. The balance history reaches thirty days back, so
       * eleven of these twelve months have no capital figure to divide by -- and a percentage
       * computed against a balance we did not measure would be a guess wearing a number.
       * Read `realizedUsd` against `/aum` for the months the history covers.
       */
      startingCapitalUsd: round(startCapital?.get(month) ?? null),
      /** The contract's spelling of the same field. One value, two names, never two answers. */
      startCapitalUsd: round(startCapital?.get(month) ?? null),
      /** The month's realised profit as a share of what he began it with. See docs/DECISIONS.md#d162 */
      returnPct: (() => {
        const cap = startCapital?.get(month) ?? null;
        if (cap === null || !(cap > 0) || v.withFigure === 0) return null;
        return Number(((v.realizedUsd / cap) * 100).toFixed(2));
      })(),
    }));

  /** WHY THESE MONTHS DO NOT SUM TO THE LIFETIME FIGURE. See docs/DECISIONS.md#d163 */
  const monthsRealized = realizedByMonth
    .reduce((a, m) => a + (m.realizedUsd ?? 0), 0);
  const lifetimeRealized = closedDated
    .reduce((a, r) => a + (n(r.realized_pnl_usd) ?? 0), 0);

  const windows = {
    basis: "realized profit only — closed trades, summed by closed_at. Unrealised movement " +
           "is not included; see /pnl for banked versus on paper. Gross of fees: see `fees`.",
    "24h": windowAgg(nowMs - 86_400_000, "24h"),
    "7d":  windowAgg(nowMs - 7 * 86_400_000, "7d"),
    "30d": windowAgg(nowMs - 30 * 86_400_000, "30d"),
    all:   windowAgg(null, "all"),
  };

  return {
    handle: t.display_handle, name: t.name ?? null,
    /** WHERE THESE ROWS CAME FROM — and it is not the same answer for every trader. See docs/DECISIONS.md#d164 */
    source: t.source === "gmgn"
      ? "postgres · trades (folded from GMGN wallet activity)"
      : "postgres · trades (loaded from fomoapi)",
    /** The directory this trader came from, the same value `GET /v1/traders` reports. */
    traderSource: t.source ?? null,
    /**
     * Realised profit per day for the last thirty days, same basis as `realized` below.
     * A day with no closed trade is absent, not zero.
     */
    realizedByDay,
    /**
     * Realised profit per calendar month for the last twelve completed months plus the one in
     * progress. Same basis as `realizedByDay` and as `realized` below: closed trades summed by
     * `closed_at`, unrealised movement excluded. A month with no closed trade is absent.
     */
    realizedByMonth,
    /** What the months above cover, and what they leave out. */
    realizedByMonthBasis: {
      months: realizedByMonth.length,
      from: realizedByMonth[0]?.month ?? null,
      to: realizedByMonth[realizedByMonth.length - 1]?.month ?? null,
      realizedUsd: round(monthsRealized),
      /** Realised profit on closes OLDER than this window; 0 when the record fits inside it. */
      beforeWindowUsd: round(lifetimeRealized - monthsRealized),
      note: "the last twelve completed calendar months plus the one running. A record that " +
            "starts earlier has closes before this window, so these months do not sum to " +
            "windows.all.realizedUsd — `beforeWindowUsd` is exactly that difference.",
    },
    // max(captured_at) over the same rows — identical to the query this replaces, and free.
    asOf: (() => {
      const times = rows.map((r) => (r.captured_at ? Date.parse(String(r.captured_at)) : null))
        .filter((x): x is number => x !== null && Number.isFinite(x));
      return times.length ? new Date(Math.max(...times)).toISOString() : null;
    })(),
    /** WHAT THIS SCORECARD WAS COMPUTED OVER, and whether that is the whole record. See docs/DECISIONS.md#d165 */
    sample: {
      returned: rows.length,
      storedAt: loadedAtIso,
      complete: true,
      capped: false,
      unit: "position",
      positionsStored: rows.length,
      reportedTrades: n(t.trade_count),
      reportedTradesSource: "leaderboard, lifetime, counted as fills",
      /**
       * When the trade load behind these rows ran, and when it is next due. This is the
       * scorecard's half of the freshness contract -- the same question `sampler` answers for
       * the balance series, on the store that actually feeds this route.
       */
      loadedAt: loadedAtIso,
      nextLoadAt: (() => {
        const d = new Date();
        d.setUTCHours(6, 0, 0, 0);
        if (d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString();
      })(),
      note: "no cap is applied: every position stored for this trader is used. `returned` " +
            "counts positions, `reportedTrades` counts fills, and they are not comparable.",
    },
    /*
     * THE SAME FIVE FACTS AT THE LEVEL THE CONTRACT NAMES THEM.
     *
     * Section 7.5 asks for `complete`, `tradesKnown`, `tradesUsed`, `loadedAt` and
     * `nextLoadAt` on the scorecard itself. They are computed once above and read from the
     * same place here, so the two spellings cannot drift apart.
     */
    complete: true,
    tradesKnown: rows.length,
    tradesUsed: rows.length,
    loadedAt: loadedAtIso,
    nextLoadAt: (() => {
      const d = new Date();
      d.setUTCHours(6, 0, 0, 0);
      if (d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString();
    })(),
    /** A VERDICT ON THIS RECORD'S AGE, not just the date it was loaded. See docs/DECISIONS.md#d166 */
    staleness: (() => {
      const t = loadedAtIso ? Date.parse(loadedAtIso) : NaN;
      const ageSeconds = Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
      const staleAfterHours = 72;
      return {
        state: ageSeconds === null
          ? "never"
          : (ageSeconds > staleAfterHours * 3600 ? "stale" : "current"),
        ageSeconds,
        staleAfterHours,
      };
    })(),
    /** FEES, ANSWERED HONESTLY RATHER THAN ASSUMED EITHER WAY. See docs/DECISIONS.md#d167 */
    fees: {
      /**
       * Fees are now MEASURED, and still not deducted. Both facts matter: a consumer that
       * wants "after fees" can subtract `paidUsd` itself, and one that reads `realizedUsd`
       * is not silently given a net figure where it expected a gross one.
       */
      includedInRealized: false,
      paidUsd: fw ? (fw.usd.all ?? null) : null,
      byWindowUsd: fw
        ? { "24h": fw.usd["24h"] ?? null, "7d": fw.usd["7d"] ?? null,
            "30d": fw.usd["30d"] ?? null, all: fw.usd.all ?? null }
        : null,
      /** Exact, in each chain's own coin. This is the measurement; the dollars are derived. */
      paidNative: fw
        ? fw.native.map((x) => ({
            symbol: x.symbol,
            amount: Number(x.amount.toPrecision(12)),
            /** How many chains that coin was paid on — ETH is native to three of our five. */
            chains: x.chains,
          }))
        : [],
      transactions: fw?.txCount ?? 0,
      coverage: fw ? cov(fw.chainsPriced, fw.chainsTotal) : cov(0, 0),
      source: fw
        ? "gas_used x effective_gas_price from the transaction receipt on the EVM chains, " +
          "meta.fee on Solana"
        : null,
      perTradeUsd: null,
      /**
       * WHY THE DOLLARS ARE AN APPROXIMATION AND THE COIN FIGURE IS NOT.
       *
       * A fee is paid once, in the chain's own coin, at a moment. We hold no historical price
       * for those coins, so the dollar figure applies today's rate to a past payment. The
       * native amount is exact and does not move.
       */
      usdBasis: "native fee valued at the current native price, not the price when it was paid",
      why: fw ? null : "no fee has been read for this trader's transactions yet",
      perTradeWhy: "a stored position carries no transaction hash, so a fee cannot be " +
                   "attached to one. Per-trade fees are on /trades, where a row IS a " +
                   "transaction",
    },
    /**
     * VOLUME, both the reported lifetime figure and the measured per-window one.
     *
     * They are different measurements and will not agree: the first is the leaderboard's
     * lifetime number for the trader, the second is what we can prove from the positions we
     * hold. `windows[].volumeUsd` carries the per-window figures with their own coverage.
     */
    volume: {
      reportedLifetimeUsd: n(t.volume_usd),
      reportedSource: "leaderboard, lifetime",
      measuredBasis: "entry leg plus exit leg of every closed position that carries an entry " +
                     "price, an exit price and a recoverable quantity",
      perWindow: "see windows[].volumeUsd and windows[].volumeCoverage",
    },
    winRate, wins, losses, breakeven,
    /** WHAT `winRate` IS A RATE OF — named, not left to be inferred. See docs/DECISIONS.md#d168 */
    winRateBasis: "closed_positions_with_realized_figure",
    winRateCoverage: cov(realized.length, closed.length),
    bestTradeUsd: round(best), worstTradeUsd: round(worst),
    topTradeShare, meanToMedian,
    meanTradeUsd: round(meanTrade), medianTradeUsd: round(medTrade),
    /** Axis 2 — WHICH POPULATION `meanToMedian` above was computed over. See docs/DECISIONS.md#d169 */
    meanToMedianBasis: "per_token",
    /** The same statistic over real EXITS, which is what the spec actually asks for. See docs/DECISIONS.md#d170 */
    perExit: (() => {
      const xs = chainExits.filter((v) => Number.isFinite(v));
      const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
      const med = median(xs);
      return {
        exits: xs.length,
        wins: xs.filter((v) => v > 0).length,
        losses: xs.filter((v) => v < 0).length,
        // Same sign discipline as the per-token figure: a ratio across a sign change is
        // arithmetically true and informationally worthless.
        meanToMedian: xs.length >= 2 && mean !== null && med !== null && mean > 0 && med > 0
          ? Number((mean / med).toFixed(2)) : null,
        meanExitUsd: round(mean), medianExitUsd: round(med),
        clearsSpecBar: xs.length >= 20,
        basis: "one point per resolved on-chain exit, cost basis from the wallet's own " +
               "resolved buys — the granularity the axis formula assumes",
      };
    })(),
    moneyIn: { usd: entryRows.length ? round(entryRows.reduce((s, r) => s + r.amount * r.px, 0)) : null, coverage: inCov },
    moneyOut: { usd: exitRows.length ? round(exitRows.reduce((s, r) => s + r.amount * r.px, 0)) : null, coverage: outCov },
    returnPct: { value: basis > 0 ? Number(((closedPnl / basis) * 100).toFixed(2)) : null,
                 coverage: cov(closedPriced.length, closed.length) },
    typicalBetUsd: bet,
    /** THE SAME VOCABULARY, SUMMARISED FOR THE WHOLE ANSWER. See docs/DECISIONS.md#d171 */
    fieldReasons: (() => {
      const why: Record<string, string> = {};
      const noClosed = closed.length === 0;
      if (winRate === null) why.winRate = noClosed ? "not_applicable" : "historical_input_missing";
      if (medHold === null) {
        why.holdingTime = noClosed ? "not_applicable" : "historical_input_missing";
      }
      if (!entryRows.length) why.moneyIn = "historical_input_missing";
      if (!exitRows.length) {
        why.moneyOut = noClosed ? "not_applicable" : "historical_input_missing";
      }
      if (!(basis > 0)) {
        why.returnPct = noClosed ? "not_applicable" : "historical_input_missing";
      }
      if (bet.value === null) why.typicalBetUsd = "historical_input_missing";
      if (spanDays === null) why.trackRecordDays = "historical_input_missing";
      /** THE SPREAD FIGURES, which go null for two different reasons and said neither. See docs/DECISIONS.md#d172 */
      if (worst === null) {
        why.worstTradeUsd = noClosed ? "not_applicable" : "no_realized_figure";
      }
      if (medTrade === null) {
        why.medianTradeUsd = noClosed ? "not_applicable" : "no_realized_figure";
      }
      if (topTradeShare === null) {
        why.topTradeShare = noClosed
          ? "not_applicable"
          : (realized.length === 0 ? "no_realized_figure" : "no_winning_trade");
      }
      if (best === null) {
        why.bestTradeUsd = noClosed ? "not_applicable" : "no_realized_figure";
      }
      if (meanToMedian === null && realized.length > 0) {
        why.meanToMedian = "sign_discipline_not_both_positive";
      }
      /* Only when no fee has been read for this trader yet -- it is now a loadable fact. */
      if (!fw || fw.chainsPriced === 0) why.feesUsd = "not_yet_calculated";
      why.startCapitalUsd = "historical_input_missing";
      return why;
    })(),
    /** PRD §5 — rhythm, on ONE definition, for every trader whatever source they came from. See docs/DECISIONS.md#d173 */
    measurements: (() => {
      const closedCount = closed.length;
      // Same definition the top-level `tradesPerDay` uses, computed from the same locals.
      const perDay = spanDays !== null && spanDays >= 1
        ? Number((rows.length / spanDays).toFixed(2)) : null;
      const lastTradeIso = lastAt === null ? null : new Date(lastAt).toISOString();
      return {
        tradesPerDay: {
          value: perDay,
          basis: "closed positions per calendar day between first open and last close",
          window: "all recorded history",
          coverage: cov(closedCount, rows.length),
          why: perDay === null ? "no closed positions on record" : null,
        },
        holdTimeDays: {
          value: medHold === null ? null : Number((medHold / 86_400_000).toFixed(3)),
          basis: "median open-to-close duration over finished positions",
          window: "all recorded history",
          /** THE SAME COVERAGE THE FIGURE WAS ACTUALLY COMPUTED OVER. See docs/DECISIONS.md#d174 */
          coverage: cov(holds.length, closedCount),
          why: medHold === null
            ? "no finished position carries both an open and a close time" : null,
        },
        lastTradeAt: {
          value: lastTradeIso,
          basis: "most recent close on record",
          window: "all recorded history",
          why: lastTradeIso === null ? "no closed positions on record" : null,
        },
        asOf: (() => {
          const times = rows.map((r) => (r.captured_at ? Date.parse(String(r.captured_at)) : null))
            .filter((x): x is number => x !== null && Number.isFinite(x));
          return times.length ? new Date(Math.max(...times)).toISOString() : null;
        })(),
      };
    })(),
    holdingTime: {
      medianHours: medHold === null ? null : Number((medHold / 3_600_000).toFixed(2)),
      medianDays: medHold === null ? null : Number((medHold / 86_400_000).toFixed(2)),
      coverage: cov(holds.length, closed.length),
    },
    lastTradeAt: lastAt === null ? null : new Date(lastAt).toISOString(),
    firstTradeAt: firstAt === null ? null : new Date(firstAt).toISOString(),
    trackRecordDays: spanDays === null ? null : Number(spanDays.toFixed(1)),
    tradesPerDay: spanDays !== null && spanDays >= 1 ? Number((rows.length / spanDays).toFixed(2)) : null,
    /**
     * What the per-token averages mean, stated rather than left to be guessed. Two
     * reasonable definitions give different numbers, and the consumer has to label the
     * figure on screen.
     */
    entryBasis: {
      scope: "every position on record for this trader and token, sold ones included",
      sellsReduceIt: false,
      note: "fomoapi supplies one avgEntryPrice per POSITION, already averaged across the " +
            "fills inside it. Where a trader holds several positions in one token we now " +
            "combine them into a quantity-weighted average; each row reports which " +
            "computation it used in `entryMethod` and over how many positions.",
      weighting: "open positions weight by `amount`; closed positions recover quantity from " +
                 "realized pnl / (exit - entry), because `amount` on a closed position is " +
                 "what remains (zero), not what was traded",
      sells: "a sell does not reduce the entry price. This answers what they PAID TO GET IN " +
             "across their whole record, not what their remaining position cost.",
      marketCap: "avgEntryPrice x tokens.total_supply, both returned so the figure can be rechecked",
      previously: "this field was the first entry price seen per token and was not " +
                  "re-averaged; `firstEntryPrice` still carries that value for comparison",
    },
    /** Axis 5's "winrate on hard entries". See docs/DECISIONS.md#d175 */
    smallCapWinRate: (() => {
      const priced = byToken.filter((t) => t.avgEntryMarketCapUsd !== null);
      const small = priced.filter((t) => t.avgEntryMarketCapUsd! < 1_000_000 && t.closed > 0);
      if (!small.length) {
        return {
          value: null,
          threshold: 1_000_000,
          basis: "per token, not per trade — we hold positions, not individual fills",
          coverage: cov(0, byToken.length),
          note: "no token with a known entry market cap under $1M has a closed position",
        };
      }
      const wins = small.filter((t) => t.realizedPnlUsd > 0).length;
      return {
        value: Number((wins / small.length).toFixed(4)),
        wins,
        tokens: small.length,
        threshold: 1_000_000,
        basis: "per token, not per trade — we hold positions, not individual fills",
        // Denominator is tokens we could PRICE, not all tokens: a token with no entry market
        // cap was not judged small or large, and counting it either way would be a guess.
        coverage: cov(priced.length, byToken.length),
      };
    })(),
    windows,
    /** Axis 5's gate, reported rather than assumed. See docs/DECISIONS.md#d176 */
    /** HOW MUCH OF THIS TRADER'S BUYING WE HOLD BUY BY BUY. See docs/DECISIONS.md#d177 */
    buysCoverage: (() => {
      const withBuys = byToken.filter((x) => x.buysTotal > 0);
      const total = byToken.reduce((a, x) => a + x.buysTotal, 0);
      return {
        buys: total,
        coinsWithBuys: withBuys.length,
        coinsTotal: byToken.length,
        share: byToken.length
          ? Number((withBuys.length / byToken.length).toFixed(4)) : null,
        basis: "individual buys resolved from chain swaps. Solana throughout; the four " +
               "Ethereum-style chains only where a transaction shows this wallet both " +
               "sending and receiving a token, which is what a trade the wallet made looks " +
               "like",
        why: total === 0
          ? "no individual buys resolved for this trader — count from avgEntryPrice instead, " +
            "which is one figure per coin"
          : null,
      };
    })(),
    entryPriceCoverage: (() => {
      const withPrice = byToken.filter((t) => t.avgEntryPrice !== null);
      const fromChain = withPrice.filter((t) => t.entryPriceSource === "chain").length;
      const withCap = byToken.filter((t) => t.avgEntryMarketCapUsd !== null).length;
      return {
        tokensPriced: withPrice.length,
        tokensTotal: byToken.length,
        pricedShare: byToken.length ? Number((withPrice.length / byToken.length).toFixed(4)) : null,
        derivedFromChain: fromChain,
        withMarketCap: withCap,
        // Both price AND supply are needed for an entryMcap, so this is the share the axis
        // actually runs on — not the price share, which is always the larger number.
        marketCapShare: byToken.length ? Number((withCap / byToken.length).toFixed(4)) : null,
        clearsSpecBar: byToken.length > 0 && withCap / byToken.length >= 0.7,
      };
    })(),
    tokensTotal: byToken.length,
    /** The same count under the name the consumer's verdict test actually reads. See docs/DECISIONS.md#d178 */
    coinsTotal: byToken.length,
    /** OMITTED, NOT EMPTIED, when the caller asked for no coins. See docs/DECISIONS.md#d179 */
    ...(tokenLimit === 0
      ? {}
      : { byToken: tokenLimit === null ? byToken : byToken.slice(0, tokenLimit) }),
    plain, caveats,
  };
}
