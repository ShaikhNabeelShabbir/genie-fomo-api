/**
 * Pure half of the EVM swap resolver (`./swaps.ts`): Bitquery's decoded `DEXTrades` rows for
 * one transaction -> the wallet's net legs -> one `wallet_swaps` row. No I/O, so
 * `tests/swaps_core_test.ts` runs it under Deno. The rules are those of the receipt decoder
 * this replaced (`scripts/resolve_evm_swaps_from_receipts.mjs`): only the wallet's own
 * two-sided trade is a swap, a native leg is recorded against the wrapped native, exactly one
 * side is the money leg. Bitquery has already scaled amounts by decimals and marked the coin.
 */
import { ZERO_ADDRESS } from "../../../supabase/functions/_shared/chain_reads.ts";

/**
 * One `EVM.DEXTrades` row as https://docs.bitquery.io/docs/schema/evm/dextrades/ shapes it:
 * `Trade { Buy { Amount Buyer Seller Currency { SmartContract Native } } Sell { ... } }` and
 * `Transaction { Hash From }`. `Buy.Buyer` received `Buy.Currency`, `Buy.Seller` provided it;
 * the `Sell` side mirrors that for the other currency.
 */
export interface Side { readonly Amount?: unknown; readonly Buyer?: unknown; readonly Seller?: unknown; readonly Currency?: unknown }
export interface Trade {
  readonly Transaction?: { readonly Hash?: unknown; readonly From?: unknown };
  readonly Trade?: { readonly Buy?: Side; readonly Sell?: Side };
}
export interface Quote { readonly symbol: string; readonly usd: number | null }
export interface NativeQuote { readonly key: string; readonly usd: number | null }

/** `[token, amount]` in human units, signed from the wallet's side: received > 0, sent < 0. The coin is `ZERO_ADDRESS`. */
export type Leg = readonly [string, number];
/** What the wallet did in one transaction, when it is one two-sided trade of its own. */
export interface Decoded { readonly recv: Leg; readonly sent: Leg }

export interface SwapRow {
  readonly tokenKey: string;
  readonly tokenDelta: number;
  readonly quoteKey: string;
  readonly quoteDelta: number;
  readonly quoteUsd: number | null;
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const lower = (v: unknown): string => typeof v === "string" ? v.toLowerCase() : "";

/** The token a side moved: the coin under `ZERO_ADDRESS` (`Native: true` or `SmartContract: "0x"`, as the balances read), else its contract. */
function tokenOf(side: Side): string | null {
  const cur = side.Currency;
  if (!isRec(cur)) return null;
  if (cur.Native === true || cur.SmartContract === "0x") return ZERO_ADDRESS;
  const c = lower(cur.SmartContract);
  return /^0x[0-9a-f]{40}$/.test(c) ? c : null;
}

const amountOf = (side: Side): number | null => {
  const n = Number(side.Amount);
  return typeof side.Amount === "string" || typeof side.Amount === "number" ? (Number.isFinite(n) && n >= 0 ? n : null) : null;
};

/**
 * Net movement per token for `wallet` across the trades of one transaction. Where Bitquery names
 * the wallet on a side, only those sides count (a maker fill, a direct pool swap); where the
 * router is the named party, the wallet must have signed the transaction and every hop counts,
 * so the intermediate token of a route cancels out. Null: none, or three tokens left, or the
 * wallet is neither named nor the signer. Not one trade of its own.
 */
export function decode(trades: readonly Trade[], wallet: string): Decoded | null {
  const w = wallet.toLowerCase();
  const net = new Map<string, number>(), gross = new Map<string, number>();
  const add = (side: Side | undefined, sign: 1 | -1): void => {
    if (!side) return;
    const tok = tokenOf(side), amt = amountOf(side);
    if (tok === null || amt === null) return;
    net.set(tok, (net.get(tok) ?? 0) + sign * amt);
    gross.set(tok, (gross.get(tok) ?? 0) + amt);
  };
  const named = trades.some((t) => [t.Trade?.Buy, t.Trade?.Sell].some((s) => s && (lower(s.Buyer) === w || lower(s.Seller) === w)));
  for (const t of trades) {
    const buy = t.Trade?.Buy, sell = t.Trade?.Sell;
    if (named) {
      if (buy && lower(buy.Buyer) === w) add(buy, 1);
      if (buy && lower(buy.Seller) === w) add(buy, -1);
      if (sell && lower(sell.Buyer) === w) add(sell, 1);
      if (sell && lower(sell.Seller) === w) add(sell, -1);
    } else if (lower(t.Transaction?.From) === w) {
      add(buy, 1);
      add(sell, -1);
    }
  }
  /* A route's middle token nets to zero up to float noise on the hop amounts. */
  const legs: Leg[] = [...net].filter(([tok, v]) => Math.abs(v) > 1e-9 * (gross.get(tok) ?? 0));
  const received = legs.filter(([, v]) => v > 0), sent = legs.filter(([, v]) => v < 0);
  return received.length === 1 && sent.length === 1 ? { recv: received[0], sent: sent[0] } : null;
}

/**
 * Value the trade. The coin is recorded as the chain's WRAPPED native at 1:1; exactly one side
 * must be a quote (the money leg). Null means skipped, never guessed. `quotes` is keyed by
 * token address on this chain.
 */
export function toRow(d: Decoded, quotes: ReadonlyMap<string, Quote>, wrapped: NativeQuote | null): SwapRow | null {
  const [inTok, inAmt] = d.recv, [outTok, outAmtNeg] = d.sent;
  if ((inTok === ZERO_ADDRESS || outTok === ZERO_ADDRESS) && !wrapped) return null;
  /* The coin is always the money leg, under the wrapped native's key and price. */
  const quoteOf = (tok: string): NativeQuote | null => {
    if (tok === ZERO_ADDRESS) return wrapped;
    const q = quotes.get(tok);
    return q ? { key: tok, usd: q.usd } : null;
  };
  const inQ = quoteOf(inTok), outQ = quoteOf(outTok);
  if ((inQ && outQ) || (!inQ && !outQ)) return null;
  const buying = outQ !== null;
  const q = buying ? outQ : inQ;
  if (q === null) return null;
  const outAmt = -outAmtNeg;
  const tokenAmt = buying ? inAmt : outAmt, quoteAmt = buying ? outAmt : inAmt;
  return {
    tokenKey: buying ? inTok : outTok, tokenDelta: buying ? tokenAmt : -tokenAmt,
    quoteKey: q.key, quoteDelta: buying ? -quoteAmt : quoteAmt,
    quoteUsd: q.usd === null ? null : quoteAmt * q.usd,
  };
}
