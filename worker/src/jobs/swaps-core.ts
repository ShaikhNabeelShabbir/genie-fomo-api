/**
 * Pure half of the swap resolver (`./swaps.ts`): Bitquery's decoded `DEXTrades` rows (EVM) or
 * a Helius parsed transaction (Solana) for one transaction -> the wallet's net legs -> one
 * `wallet_swaps` row. No I/O, so `tests/swaps_core_test.ts` runs it under Deno. The rules are
 * those of the scripts this replaced (`resolve_evm_swaps_from_receipts.mjs`,
 * `resolve_wallet_swaps.mjs`): only the wallet's own two-sided trade is a swap, a native leg
 * is recorded against the wrapped native (EVM) or `SOL_MINT` (Solana), exactly one side is
 * the money leg, and that leg is priced peg -> daily close -> market, never guessed.
 */
import { SOL_MINT, ZERO_ADDRESS } from "../../../supabase/functions/_shared/chain_reads.ts";

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
/** Which arm of the price ladder valued the money leg; the words are the published `trades[].valueSource`. */
export type QuoteSource = "money_side_pegged" | "money_side_daily_close" | "money_side_market";
export interface Quote {
  readonly symbol: string;
  readonly pegged: number | null;
  /** `token_prices` daily closes, UTC day -> usd. */
  readonly closes: ReadonlyMap<string, number>;
  /** The portfolio's current price, the last resort. */
  readonly market: number | null;
}
export interface NativeQuote { readonly key: string; readonly quote: Quote }
export interface PricedQuote { readonly usd: number; readonly source: QuoteSource }

/** `[token, amount]` in human units, signed from the wallet's side: received > 0, sent < 0. The coin is `ZERO_ADDRESS`. */
export type Leg = readonly [string, number];
/** What the wallet did in one transaction, when it is one two-sided trade of its own. */
export interface Decoded { readonly recv: Leg; readonly sent: Leg }

export interface SwapRow {
  readonly tokenKey: string;
  readonly tokenDelta: number;
  readonly quoteKey: string;
  readonly quoteDelta: number;
  /** `quoteDelta` x the unit price, so it carries the sign (`/scorecard` sums it as net cash). */
  readonly quoteUsd: number | null;
  readonly quoteSource: QuoteSource | null;
}

const DAY_MS = 86_400_000;
/** A daily close stands in up to this many days after its day; older is not that block's price. */
export const CLOSE_LOOKBACK_DAYS = 7;

/** The money leg's unit price at `at`: the peg, else the latest daily close on or before that day within the lookback, else the market price. Null: unpriced. */
export function priceQuote(q: Quote, at: Date): PricedQuote | null {
  if (q.pegged !== null) return { usd: q.pegged, source: "money_side_pegged" };
  for (let back = 0; back < CLOSE_LOOKBACK_DAYS; back++) {
    const usd = q.closes.get(new Date(at.getTime() - back * DAY_MS).toISOString().slice(0, 10));
    if (usd !== undefined) return { usd, source: "money_side_daily_close" };
  }
  return q.market === null ? null : { usd: q.market, source: "money_side_market" };
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
 * Value the trade at `at`. The coin is recorded as the chain's WRAPPED native at 1:1; exactly
 * one side must be a quote (the money leg). Null means skipped, never guessed. `quotes` is
 * keyed by token address on this chain.
 */
export function toRow(d: Decoded, quotes: ReadonlyMap<string, Quote>, wrapped: NativeQuote | null, at: Date): SwapRow | null {
  const [inTok, inAmt] = d.recv, [outTok, outAmtNeg] = d.sent;
  if ((inTok === ZERO_ADDRESS || outTok === ZERO_ADDRESS) && !wrapped) return null;
  /* The coin is always the money leg, under the wrapped native's key and price. */
  const quoteOf = (tok: string): NativeQuote | null => {
    if (tok === ZERO_ADDRESS) return wrapped;
    const q = quotes.get(tok);
    return q ? { key: tok, quote: q } : null;
  };
  const inQ = quoteOf(inTok), outQ = quoteOf(outTok);
  if ((inQ && outQ) || (!inQ && !outQ)) return null;
  const buying = outQ !== null;
  const q = buying ? outQ : inQ;
  if (q === null) return null;
  const outAmt = -outAmtNeg;
  const tokenAmt = buying ? inAmt : outAmt, quoteAmt = buying ? outAmt : inAmt;
  const quoteDelta = buying ? -quoteAmt : quoteAmt;
  const px = priceQuote(q.quote, at);
  return {
    tokenKey: buying ? inTok : outTok, tokenDelta: buying ? tokenAmt : -tokenAmt,
    quoteKey: q.key, quoteDelta,
    quoteUsd: px === null ? null : quoteDelta * px.usd,
    quoteSource: px === null ? null : px.source,
  };
}

/**
 * The wallet's net position change in one Solana transaction, from a Helius `getTransaction`
 * (jsonParsed) result: every mint whose balance moved for `owner` (pre/post token balances),
 * plus native SOL under `SOL_MINT` when the wallet is an account of the transaction. Immune to
 * how a router shuffled funds internally. Keys are lower-cased to match `tokens.token_key`, so
 * `owner` compares case-insensitively too. Dust below 1e-12 (1e-7 SOL: a lamport of rent is
 * not a leg) is discarded. Null: not one two-sided trade of the wallet's own.
 */
export function solanaDecode(tx: unknown, owner: string): Decoded | null {
  if (!isRec(tx) || !isRec(tx.meta)) return null;
  const m = tx.meta, w = owner.toLowerCase();
  const balances = (v: unknown): Map<string, number> => {
    const out = new Map<string, number>();
    for (const b of Array.isArray(v) ? v : []) {
      if (!isRec(b) || lower(b.owner) !== w || typeof b.mint !== "string") continue;
      const ui = isRec(b.uiTokenAmount) ? Number(b.uiTokenAmount.uiAmount ?? 0) : 0;
      out.set(b.mint.toLowerCase(), Number.isFinite(ui) ? ui : 0);
    }
    return out;
  };
  const pre = balances(m.preTokenBalances), post = balances(m.postTokenBalances);
  const net = new Map<string, number>();
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const d = (post.get(mint) ?? 0) - (pre.get(mint) ?? 0);
    if (Math.abs(d) > 1e-12) net.set(mint, d);
  }
  const message = isRec(tx.transaction) && isRec(tx.transaction.message) ? tx.transaction.message : null;
  const keys = (Array.isArray(message?.accountKeys) ? message.accountKeys : []).map((k: unknown) => lower(isRec(k) ? k.pubkey : k));
  const i = keys.indexOf(w);
  if (i >= 0) {
    /* Fees are paid by whoever submitted (a relayer for these traders), so a native change is real movement, not gas. */
    const before = Array.isArray(m.preBalances) ? Number(m.preBalances[i]) : NaN;
    const after = Array.isArray(m.postBalances) ? Number(m.postBalances[i]) : NaN;
    const d = Number.isFinite(before) && Number.isFinite(after) ? (after - before) / 1e9 : 0;
    if (Math.abs(d) > 1e-7) net.set(SOL_MINT, (net.get(SOL_MINT) ?? 0) + d);
  }
  return twoSided(net);
}

/** One two-sided trade: exactly one mint received and one sent. */
function twoSided(net: ReadonlyMap<string, number>): Decoded | null {
  const received = [...net].filter(([, v]) => v > 0), sent = [...net].filter(([, v]) => v < 0);
  return received.length === 1 && sent.length === 1 ? { recv: received[0], sent: sent[0] } : null;
}

/**
 * `solanaDecode` over a Helius Enhanced Transactions reply (`POST /v0/transactions`, per
 * https://www.helius.dev/docs/api-reference/enhanced-transactions/gettransactions): the same
 * net change per mint, from every `accountData[].tokenBalanceChanges[]` whose `userAccount` is
 * the wallet (`rawTokenAmount { tokenAmount, decimals }` is the signed raw delta), and native
 * SOL from the wallet's own `accountData[]` entry's `nativeBalanceChange` (lamports). Same keys,
 * dust and rent rules, so both decoders give one row for one transaction.
 */
export function solanaDecodeEnhanced(parsed: unknown, owner: string): Decoded | null {
  if (!isRec(parsed) || !Array.isArray(parsed.accountData)) return null;
  const w = owner.toLowerCase();
  const net = new Map<string, number>();
  for (const a of parsed.accountData) {
    if (!isRec(a)) continue;
    for (const c of Array.isArray(a.tokenBalanceChanges) ? a.tokenBalanceChanges : []) {
      if (!isRec(c) || lower(c.userAccount) !== w || typeof c.mint !== "string" || !isRec(c.rawTokenAmount)) continue;
      const raw = Number(c.rawTokenAmount.tokenAmount), dec = Number(c.rawTokenAmount.decimals);
      const d = Number.isFinite(raw) && Number.isFinite(dec) ? raw / 10 ** dec : 0;
      const mint = c.mint.toLowerCase();
      net.set(mint, (net.get(mint) ?? 0) + d);
    }
    if (lower(a.account) === w) {
      /* Fees are paid by whoever submitted (a relayer for these traders), so a native change is real movement, not gas. */
      const d = Number(a.nativeBalanceChange) / 1e9;
      if (Number.isFinite(d) && Math.abs(d) > 1e-7) net.set(SOL_MINT, (net.get(SOL_MINT) ?? 0) + d);
    }
  }
  for (const [mint, d] of net) if (Math.abs(d) <= 1e-12) net.delete(mint);
  return twoSided(net);
}
