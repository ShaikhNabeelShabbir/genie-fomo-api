/**
 * Per-trade profit and loss.
 *
 * Three passes over a wallet's history:
 *
 *   1. GROUP     transfers sharing a tx_hash are one event. Net each contract inside it,
 *                so a router refund or a multi-hop route collapses to what actually left
 *                and what actually arrived.
 *   2. CLASSIFY  one token in + one known token out = a BUY; the mirror is a SELL. See
 *                the table in `classify`.
 *   3. REPLAY    walk the events OLDEST FIRST carrying a position per token — `qty` and a
 *                `cost` pool. A sell takes its share out of the pool:
 *
 *                    avgCost  = cost / qty
 *                    basis    = avgCost * qtySold
 *                    realized = proceeds - basis - fees
 *
 *                and leaves the rest behind for the next sell.
 *
 * Order is the whole game. PnL is not a property of a transaction — it only exists
 * relative to purchases that came before, which is why this cannot run over the
 * newest-first slice that /transactions returns.
 *
 * Where the answer is unknowable it is reported as null with a reason. A sell whose
 * purchase predates the fetched window has NO basis; defaulting that to zero would book
 * the entire proceeds as profit, which is how dashboards end up with impossible numbers.
 */

import type { Transfer } from "./transactions.js";
import { asQuote, quoteValueUsd, warmAssetPrices } from "./prices.js";
import type { QuoteMatch } from "./prices.js";

export type TradeKind =
  | "buy" | "sell" | "swap" | "conversion" | "transfer_in" | "transfer_out" | "complex";

export type Leg = { symbol: string; contract: string; amount: number };

export type Trade = {
  tx_hash: string;
  chain: string;
  time: number;
  time_iso: string | null;
  kind: TradeKind;
  /** The token whose position moves. Null for `complex`. */
  base: Leg | null;
  /** What was paid or received. Null when nothing identifiable was on the other side. */
  quote: Leg | null;
  value_usd: number | null;
  /** USD per base token, derived from the quote leg. */
  price_usd: number | null;
  priced_via: string | null;
  fee_usd: number | null;
  explorer_url: string | null;
  source?: string;

  // ---- filled in by the replay
  avg_cost_usd?: number | null;
  basis_usd?: number | null;
  proceeds_usd?: number | null;
  realized_pnl_usd: number | null;
  roi_pct: number | null;
  pnl_status: "computed" | "not_applicable" | "unavailable";
  pnl_reason?: string;
};

export type Position = {
  chain: string;
  contract: string;
  symbol: string;
  qty: number;
  /**
   * The slice of `qty` that arrived with a known purchase price. Tokens that turned up as
   * a plain transfer add to `qty` but not to this, so they can never be sold at a $0 basis
   * and booked as pure profit.
   */
  qty_priced: number;
  cost_usd: number;
  avg_cost_usd: number | null;
  price_usd: number | null;
  value_usd: number | null;
  unrealized_pnl_usd: number | null;
  /** Buys we could not value — anything derived from this pool understates cost. */
  unpriced_buys: number;
  /** Tokens that arrived with no purchase (airdrop, or a transfer from another wallet). */
  zero_basis_inflows: number;
};

const DUST = 1e-12;
const key = (chain: string, contract: string) => `${chain}:${(contract || "").toLowerCase()}`;

// ------------------------------------------------------------------------- group

type Netted = { symbol: string; contract: string; net: number };

/** Collapse one tx_hash into what genuinely left and arrived, netting per contract. */
function netLegs(rows: Transfer[]): { received: Netted[]; given: Netted[] } {
  const acc = new Map<string, { symbol: string; contract: string; net: number; gross: number }>();
  for (const r of rows) {
    const amt = Number(r.amount);
    if (!Number.isFinite(amt) || amt === 0) continue;
    const k = (r.contract || r.token || "").toLowerCase();
    const cur = acc.get(k) ?? { symbol: r.token, contract: r.contract, net: 0, gross: 0 };
    cur.net += r.side === "in" ? amt : -amt;
    cur.gross += Math.abs(amt);
    // Solana rows carry a truncated mint as `token`; prefer any real symbol we see.
    if (!cur.symbol && r.token) cur.symbol = r.token;
    acc.set(k, cur);
  }

  const received: Netted[] = [];
  const given: Netted[] = [];
  for (const v of acc.values()) {
    // Ignore residue from a round trip through a router: net is a rounding artefact of gross.
    if (Math.abs(v.net) <= DUST || Math.abs(v.net) < v.gross * 1e-9) continue;
    (v.net > 0 ? received : given).push({ symbol: v.symbol, contract: v.contract, net: Math.abs(v.net) });
  }
  // Largest leg first, so `base` is the meaningful token when a dust leg tags along.
  received.sort((a, b) => b.net - a.net);
  given.sort((a, b) => b.net - a.net);
  return { received, given };
}

// ---------------------------------------------------------------------- classify

type Classified = {
  kind: TradeKind;
  base: Leg | null;
  quote: Leg | null;
  quoteMatch: QuoteMatch | null;
};

/**
 *   out KNOWN + in X    -> BUY of X          value comes from the known leg
 *   out X   + in KNOWN  -> SELL of X         value comes from the known leg
 *   out X   + in Y      -> SWAP              no price; basis carries from X to Y
 *   both known          -> CONVERSION        USDC<->WETH, not a position trade
 *   in only             -> TRANSFER_IN       arrives with no cost
 *   out only            -> TRANSFER_OUT      leaves at cost, realises nothing
 */
function classify(chain: string, received: Netted[], given: Netted[]): Classified {
  const leg = (n: Netted): Leg => ({ symbol: n.symbol, contract: n.contract, amount: n.net });

  if (received.length === 1 && given.length === 1) {
    const [inN] = received;
    const [outN] = given;
    const inQ = asQuote(chain, inN.contract, inN.symbol);
    const outQ = asQuote(chain, outN.contract, outN.symbol);

    if (outQ && !inQ) return { kind: "buy", base: leg(inN), quote: leg(outN), quoteMatch: outQ };
    if (inQ && !outQ) return { kind: "sell", base: leg(outN), quote: leg(inN), quoteMatch: inQ };
    if (inQ && outQ) return { kind: "conversion", base: leg(outN), quote: leg(inN), quoteMatch: inQ };
    return { kind: "swap", base: leg(inN), quote: leg(outN), quoteMatch: null };
  }

  if (received.length === 1 && given.length === 0) {
    return { kind: "transfer_in", base: leg(received[0]), quote: null, quoteMatch: null };
  }
  if (received.length === 0 && given.length === 1) {
    return { kind: "transfer_out", base: leg(given[0]), quote: null, quoteMatch: null };
  }
  return { kind: "complex", base: null, quote: null, quoteMatch: null };
}

// ------------------------------------------------------------------------ build

/** transfers -> priced, classified trades, oldest first. */
export async function buildTrades(transfers: Transfer[]): Promise<Trade[]> {
  const groups = new Map<string, Transfer[]>();
  for (const t of transfers) {
    const k = `${t.chain}:${t.tx_hash}`;
    const g = groups.get(k);
    if (g) g.push(t);
    else groups.set(k, [t]);
  }

  // Pass one: classify everything, and collect which major prices the valuation will need.
  type Draft = { rows: Transfer[]; c: Classified };
  const drafts: Draft[] = [];
  const needed: { asset: string; time: number }[] = [];

  for (const rows of groups.values()) {
    const head = rows[0];
    const { received, given } = netLegs(rows);
    const c = classify(head.chain, received, given);
    drafts.push({ rows, c });
    if (c.quoteMatch?.kind === "asset" && c.quoteMatch.asset) {
      needed.push({ asset: c.quoteMatch.asset, time: head.time });
    }
    // Gas is denominated in the chain's native token.
    const nativeAsset = head.chain === "solana" ? "SOL" : head.chain === "bsc" ? "BNB" : "ETH";
    if (rows.some((r) => r.gas_native)) needed.push({ asset: nativeAsset, time: head.time });
  }

  await warmAssetPrices(needed);

  // Pass two: attach dollar values (cache is warm, so these resolve without new requests).
  const trades: Trade[] = [];
  for (const { rows, c } of drafts) {
    const head = rows[0];
    let value: number | null = null;
    let via: string | null = null;

    if (c.quoteMatch && c.quote) {
      value = await quoteValueUsd(c.quoteMatch, c.quote.amount, head.time);
      if (value !== null) {
        via = `quote_leg:${c.quoteMatch.symbol}` + (c.quoteMatch.via === "symbol" ? ":by_symbol" : "");
      }
    }

    const gasNative = rows.reduce((s, r) => s + (r.gas_native ?? 0), 0);
    let fee: number | null = null;
    if (gasNative > 0) {
      const asset = head.chain === "solana" ? "SOL" : head.chain === "bsc" ? "BNB" : "ETH";
      fee = await quoteValueUsd({ symbol: asset, kind: "asset", asset, via: "address" },
        gasNative, head.time);
    }

    trades.push({
      tx_hash: head.tx_hash,
      chain: head.chain,
      time: head.time,
      time_iso: head.time_iso,
      kind: c.kind,
      base: c.base,
      quote: c.quote,
      value_usd: value,
      price_usd: value !== null && c.base && c.base.amount > 0 ? value / c.base.amount : null,
      priced_via: via,
      fee_usd: fee,
      explorer_url: head.explorer_url,
      ...(head.source ? { source: head.source } : {}),
      realized_pnl_usd: null,
      roi_pct: null,
      pnl_status: "not_applicable",
    });
  }

  // OLDEST FIRST — the replay depends on it.
  trades.sort((a, b) => a.time - b.time || a.tx_hash.localeCompare(b.tx_hash));
  return trades;
}

// ----------------------------------------------------------------------- replay

export type ReplayResult = { trades: Trade[]; positions: Position[] };

/**
 * Walk the trades forward, carrying `qty` and `cost` per token, and settle each sell.
 * `marks` maps a lowercased contract to its current USD price, for the open positions.
 */
export function replay(trades: Trade[], marks: Map<string, number> = new Map()): ReplayResult {
  const book = new Map<string, Position>();

  const posFor = (chain: string, leg: Leg): Position => {
    const k = key(chain, leg.contract);
    let p = book.get(k);
    if (!p) {
      p = {
        chain, contract: leg.contract, symbol: leg.symbol,
        qty: 0, qty_priced: 0, cost_usd: 0, avg_cost_usd: null,
        price_usd: null, value_usd: null, unrealized_pnl_usd: null,
        unpriced_buys: 0, zero_basis_inflows: 0,
      };
      book.set(k, p);
    }
    if (!p.symbol && leg.symbol) p.symbol = leg.symbol;
    return p;
  };

  // Average cost is over the PAID-FOR quantity only. Dividing by total qty would dilute
  // the basis every time an airdrop landed, quietly inflating the next sell's profit.
  const avgOf = (p: Position) => (p.qty_priced > DUST ? p.cost_usd / p.qty_priced : null);

  for (const t of trades) {
    if (!t.base) continue;
    const p = posFor(t.chain, t.base);
    const fee = t.fee_usd ?? 0;

    switch (t.kind) {
      case "buy": {
        p.qty += t.base.amount;
        if (t.value_usd === null) {
          p.unpriced_buys += 1;
          t.pnl_status = "not_applicable";
          t.pnl_reason = "buy_unpriced";
        } else {
          // Gas on a buy is part of what the position cost.
          p.cost_usd += t.value_usd + fee;
          p.qty_priced += t.base.amount;
        }
        t.avg_cost_usd = avgOf(p);
        break;
      }

      case "sell": {
        const avg = avgOf(p);
        t.proceeds_usd = t.value_usd;
        t.avg_cost_usd = avg;

        if (t.value_usd === null) {
          t.pnl_status = "unavailable";
          t.pnl_reason = "proceeds_unpriced";
        } else if (avg === null || p.qty_priced <= DUST) {
          // Nothing here was bought inside the window we fetched — the tokens either
          // predate it or arrived as a transfer. Either way there is no basis, and
          // assuming zero would report the whole proceeds as profit.
          t.pnl_status = "unavailable";
          t.pnl_reason = p.zero_basis_inflows > 0 ? "no_purchase_on_record" : "basis_not_in_window";
        } else {
          // Settle only the quantity we actually hold a basis for, and take the matching
          // share of the proceeds, so a partly-covered sell is scaled rather than inflated.
          const covered = Math.min(t.base.amount, p.qty_priced);
          const share = covered / t.base.amount;
          const basis = avg * covered;
          const proceeds = t.value_usd * share;
          const pnl = proceeds - basis - fee * share;
          t.basis_usd = round(basis);
          t.proceeds_usd = round(proceeds);
          t.realized_pnl_usd = round(pnl);
          t.roi_pct = basis > 0 ? round((pnl / basis) * 100, 2) : null;
          t.pnl_status = "computed";
          if (covered < t.base.amount - DUST) t.pnl_reason = "partial_basis";
          else if (p.unpriced_buys > 0) t.pnl_reason = "basis_incomplete";
          p.cost_usd -= basis;
          p.qty_priced = Math.max(0, p.qty_priced - covered);
        }
        p.qty = Math.max(0, p.qty - t.base.amount);
        if (p.qty <= DUST) { p.cost_usd = 0; p.qty_priced = 0; }
        break;
      }

      case "swap": {
        // Token -> token with no priceable leg. Carry the basis across instead of guessing
        // a price: nothing is realised here, and the full PnL surfaces when the received
        // token is eventually sold for something we can value.
        const outLeg = t.quote;
        if (!outLeg) break;
        const from = posFor(t.chain, outLeg);
        const avg = avgOf(from);
        let carried = 0;
        if (avg !== null) {
          const covered = Math.min(outLeg.amount, from.qty_priced);
          carried = avg * covered;
          from.cost_usd -= carried;
          from.qty_priced = Math.max(0, from.qty_priced - covered);
        }
        from.qty = Math.max(0, from.qty - outLeg.amount);
        if (from.qty <= DUST) { from.cost_usd = 0; from.qty_priced = 0; }

        p.qty += t.base.amount;
        p.cost_usd += carried;
        if (carried > 0) p.qty_priced += t.base.amount;
        else p.unpriced_buys += 1;
        t.avg_cost_usd = avgOf(p);
        t.pnl_status = "not_applicable";
        t.pnl_reason = "basis_carried";
        break;
      }

      case "transfer_in": {
        // No purchase, so no cost. Could be an airdrop or the trader's own second wallet;
        // either way the pool must not pretend it paid for these.
        p.qty += t.base.amount;
        p.zero_basis_inflows += 1;
        t.pnl_reason = "zero_basis_inflow";
        break;
      }

      case "transfer_out": {
        // Leaves at cost. Treating this as a sale would book a fake total loss.
        const avg = avgOf(p);
        if (avg !== null) {
          const covered = Math.min(t.base.amount, p.qty_priced);
          p.cost_usd -= avg * covered;
          p.qty_priced = Math.max(0, p.qty_priced - covered);
        }
        p.qty = Math.max(0, p.qty - t.base.amount);
        if (p.qty <= DUST) { p.cost_usd = 0; p.qty_priced = 0; }
        t.pnl_reason = "moved_at_cost";
        break;
      }

      default:
        break; // conversion / complex touch no tracked position
    }
  }

  const positions: Position[] = [];
  for (const p of book.values()) {
    if (p.qty <= DUST) continue;
    p.avg_cost_usd = p.qty_priced > DUST ? p.cost_usd / p.qty_priced : null;
    const mark = marks.get((p.contract || "").toLowerCase()) ?? null;
    p.price_usd = mark;
    p.value_usd = mark === null ? null : p.qty * mark;
    // Only the paid-for slice has a gain; tokens that arrived free are held at no basis
    // and are reported as quantity, not as profit.
    p.unrealized_pnl_usd =
      mark === null || p.qty_priced <= DUST ? null : p.qty_priced * mark - p.cost_usd;
    positions.push(p);
  }
  // Positions we paid for lead; zero-basis dust (airdrops, spam) sinks to the bottom.
  positions.sort((a, b) =>
    Number(b.qty_priced > DUST) - Number(a.qty_priced > DUST) ||
    (b.value_usd ?? 0) - (a.value_usd ?? 0));

  return { trades, positions };
}

// -------------------------------------------------------------------- aggregate

export type Performance = ReturnType<typeof summarise>;

/** The scorecard. Realised and unrealised stay separate on purpose — see `realized_share`. */
export function summarise(trades: Trade[], positions: Position[]) {
  const settled = trades.filter((t) => t.pnl_status === "computed" && t.realized_pnl_usd !== null);
  const pnls = settled.map((t) => t.realized_pnl_usd as number).sort((a, b) => a - b);

  const realized = pnls.reduce((s, v) => s + v, 0);
  const marked = positions.filter((p) => p.unrealized_pnl_usd !== null);
  const unrealized = marked.reduce((s, p) => s + (p.unrealized_pnl_usd as number), 0);
  const total = realized + unrealized;

  const wins = pnls.filter((v) => v > 0).length;
  const median = pnls.length
    ? pnls.length % 2
      ? pnls[(pnls.length - 1) / 2]
      : (pnls[pnls.length / 2 - 1] + pnls[pnls.length / 2]) / 2
    : null;

  const byValue = [...marked].sort(
    (a, b) => Math.abs(b.unrealized_pnl_usd as number) - Math.abs(a.unrealized_pnl_usd as number),
  );
  const topShare = unrealized !== 0 && byValue.length
    ? (byValue[0].unrealized_pnl_usd as number) / unrealized
    : null;

  const kinds: Record<string, number> = {};
  for (const t of trades) kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;

  return {
    basis_method: "average_cost" as const,
    realized_pnl_usd: round(realized),
    unrealized_pnl_usd: marked.length ? round(unrealized) : null,
    total_pnl_usd: marked.length ? round(total) : null,
    /** Share of profit actually banked. Low means the headline is an unsold mark. */
    realized_share: marked.length && total !== 0 ? round(realized / total, 4) : null,
    closed_trades: settled.length,
    win_rate: settled.length ? round(wins / settled.length, 4) : null,
    mean_trade_usd: settled.length ? round(realized / settled.length) : null,
    /** Show beside the mean: mean >> median means one lucky trade carries everything. */
    median_trade_usd: median === null ? null : round(median),
    best_trade_usd: pnls.length ? round(pnls[pnls.length - 1]) : null,
    worst_trade_usd: pnls.length ? round(pnls[0]) : null,
    top_position_share: topShare === null ? null : round(topShare, 4),
    /** Positions with a purchase on record — the ones an unrealised number can be built on. */
    open_positions: positions.filter((p) => p.qty_priced > 1e-12).length,
    /** Tokens sitting in the wallet that were never bought: airdrops, spam, inbound transfers. */
    zero_basis_positions: positions.filter((p) => p.qty_priced <= 1e-12).length,
    coverage: {
      events: trades.length,
      by_kind: kinds,
      priced_trades: trades.filter((t) => t.value_usd !== null).length,
      unpriced_trades: trades.filter(
        (t) => t.value_usd === null && (t.kind === "buy" || t.kind === "sell" || t.kind === "swap"),
      ).length,
      sells_without_basis: trades.filter((t) => t.pnl_reason === "basis_not_in_window").length,
      positions_unmarked: positions.filter((p) => p.price_usd === null).length,
      history_from: trades.length ? trades[0].time_iso : null,
      history_to: trades.length ? trades[trades.length - 1].time_iso : null,
    },
  };
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
