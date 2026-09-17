/**
 * Pure half of the EVM swap resolver (`./swaps.ts`): receipt + transaction body -> the
 * wallet's net legs -> one `wallet_swaps` row, ported one-for-one from
 * `scripts/resolve_evm_swaps_from_receipts.mjs`. No I/O, so `tests/swaps_core_test.ts` runs
 * it under Deno. The script's comments carry the measurements; only the rules are repeated.
 */

export const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** WETH/WBNB `Withdrawal(address,uint256)`: the router unwrapping before paying out coin. */
export const WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";

export interface Log { readonly address?: unknown; readonly topics?: readonly unknown[]; readonly data?: unknown }
export interface Receipt { readonly logs?: readonly Log[] }
export interface TxBody { readonly from?: unknown; readonly value?: unknown }
export interface Quote { readonly symbol: string; readonly usd: number | null }
export interface NativeQuote { readonly key: string; readonly usd: number | null }

/** `[token, raw amount]`, signed from the wallet's side: received > 0, sent < 0. */
export type Leg = readonly [string, bigint];

/** What the wallet did in one transaction, when it is one two-sided trade of its own. */
export type Decoded =
  | { readonly kind: "token"; readonly recv: Leg; readonly sent: Leg }
  | { readonly kind: "native_buy"; readonly recv: Leg; readonly paid: bigint }
  | { readonly kind: "native_sell"; readonly sent: Leg; readonly got: bigint };

export interface SwapRow {
  readonly tokenKey: string;
  readonly tokenDelta: number;
  readonly quoteKey: string;
  readonly quoteDelta: number;
  readonly quoteUsd: number | null;
}

const bigOr = (data: unknown, fallback: bigint | null): bigint | null => {
  try { return BigInt(typeof data === "string" && data !== "0x" ? data : "0x0"); } catch { return fallback; }
};

/** BigInt -> Number, scaled. Exact through the string, so nothing rounds at 2^53. */
export function human(raw: bigint, dec: number): number {
  const s = raw.toString().padStart(dec + 1, "0");
  const whole = s.slice(0, s.length - dec);
  const frac = dec ? s.slice(s.length - dec) : "";
  return Number(frac ? `${whole}.${frac}` : whole);
}

/** Net ERC-20 movement per token for `wallet`, from the receipt's Transfer logs. */
function netLegs(rec: Receipt, wallet: string): Map<string, bigint> {
  const w = wallet.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const net = new Map<string, bigint>();
  for (const l of rec.logs ?? []) {
    const tp = l.topics ?? [];
    if (tp.length < 3 || String(tp[0]).toLowerCase() !== TRANSFER) continue;
    const v = bigOr(l.data, null);
    if (v === null) continue;
    const token = String(l.address).toLowerCase();
    const from = String(tp[1]).slice(-64).toLowerCase(), to = String(tp[2]).slice(-64).toLowerCase();
    if (from === w) net.set(token, (net.get(token) ?? 0n) - v);
    else if (to === w) net.set(token, (net.get(token) ?? 0n) + v);
  }
  return net;
}

/**
 * The receipt carries the logs; the body carries `from` and `value`, the only place a native
 * leg is visible. A sell's proceeds arrive unwrapped, so `Withdrawal.wad` stands in for them.
 * Null: three tokens moved, or none, or the wallet did not sign it. Not one trade.
 */
export function decode(rec: Receipt, body: TxBody | null, wallet: string): Decoded | null {
  const net = netLegs(rec, wallet);
  const received: Leg[] = [...net.entries()].filter(([, v]) => v > 0n);
  const sent: Leg[] = [...net.entries()].filter(([, v]) => v < 0n);
  const isSender = body !== null && String(body.from ?? "").toLowerCase() === wallet.toLowerCase();
  let nativeIn = 0n, nativeOut = 0n;
  if (isSender) {
    nativeIn = bigOr(body.value, 0n) ?? 0n;
    for (const l of rec.logs ?? []) {
      const tp = l.topics ?? [];
      if (!tp.length || String(tp[0]).toLowerCase() !== WITHDRAWAL) continue;
      nativeOut += bigOr(l.data, 0n) ?? 0n;
    }
  }
  if (received.length === 1 && sent.length === 1) return { kind: "token", recv: received[0], sent: sent[0] };
  if (received.length === 1 && sent.length === 0 && nativeIn > 0n) return { kind: "native_buy", recv: received[0], paid: nativeIn };
  if (sent.length === 1 && received.length === 0 && nativeOut > 0n) return { kind: "native_sell", sent: sent[0], got: nativeOut };
  return null;
}

/** Token addresses a decoded trade needs decimals for. */
export function tokensOf(d: Decoded): string[] {
  if (d.kind === "token") return [d.recv[0], d.sent[0]];
  return d.kind === "native_buy" ? [d.recv[0]] : [d.sent[0]];
}

/**
 * Value the trade. A native leg is priced as the chain's WRAPPED native at 1:1; a token
 * trade needs exactly one quote side (the money leg). Null means skipped, never guessed.
 * `decimals` and `quotes` are keyed by token address on this chain.
 */
export function toRow(
  d: Decoded, decimals: ReadonlyMap<string, number>, quotes: ReadonlyMap<string, Quote>, wrapped: NativeQuote | null,
): SwapRow | null {
  if (d.kind === "native_buy") {
    const [inTok, inRaw] = d.recv;
    const inDec = decimals.get(inTok);
    if (inDec === undefined || !wrapped) return null;
    const quoteAmt = human(d.paid, 18);
    return { tokenKey: inTok, tokenDelta: human(inRaw, inDec), quoteKey: wrapped.key, quoteDelta: -quoteAmt,
             quoteUsd: wrapped.usd === null ? null : quoteAmt * wrapped.usd };
  }
  if (d.kind === "native_sell") {
    const [outTok, outRawNeg] = d.sent;
    const outDec = decimals.get(outTok);
    if (outDec === undefined || !wrapped) return null;
    const quoteAmt = human(d.got, 18);
    return { tokenKey: outTok, tokenDelta: -human(-outRawNeg, outDec), quoteKey: wrapped.key, quoteDelta: quoteAmt,
             quoteUsd: wrapped.usd === null ? null : quoteAmt * wrapped.usd };
  }
  const [inTok, inRaw] = d.recv, [outTok, outRawNeg] = d.sent;
  const outRaw = -outRawNeg;
  const inDec = decimals.get(inTok), outDec = decimals.get(outTok);
  if (inDec === undefined || outDec === undefined) return null;
  const inQ = quotes.get(inTok), outQ = quotes.get(outTok);
  if ((inQ && outQ) || (!inQ && !outQ)) return null;
  const buying = outQ !== undefined;
  const q = buying ? outQ : inQ;
  if (q === undefined) return null;
  const tokenAmt = human(buying ? inRaw : outRaw, buying ? inDec : outDec);
  const quoteAmt = human(buying ? outRaw : inRaw, buying ? outDec : inDec);
  return {
    tokenKey: buying ? inTok : outTok, tokenDelta: buying ? tokenAmt : -tokenAmt,
    quoteKey: buying ? outTok : inTok, quoteDelta: buying ? -quoteAmt : quoteAmt,
    quoteUsd: q.usd === null ? null : quoteAmt * q.usd,
  };
}
