/**
 * Pure half of the scorecard refresh (`./scorecards.ts`): the coercions, the `trade_loads`
 * outcome and the fomoapi-trade-to-row mapper, ported one-for-one from `loaders/load_trades.py`.
 * No imports and no I/O, so `tests/scorecards_core_test.ts` runs it under Deno.
 */

export type Outcome = "loaded" | "unchanged" | "unavailable" | "degraded" | "not_found" | "error";
export interface Load { readonly outcome: Outcome; readonly detail: string | null }

/** fomo's `/v2/users/:handle/trades` envelope; `available: false` is its degraded answer. */
export interface FomoDoc {
  readonly available?: unknown;
  readonly capturedAt?: unknown;
  readonly trades?: readonly unknown[] | null;
}

/** One trader's fetch. `not_found` is HTTP 404; `error` is transport or non-2xx after the retry. */
export type Fetched =
  | { readonly kind: "error"; readonly detail: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "doc"; readonly doc: FomoDoc };

/** One `trades` row, keyed by column so postgres.js can spread it into the insert. */
export interface TradeRow {
  readonly trade_id: string;
  readonly handle: string;
  readonly network_id: number | null;
  readonly token_address: string | null;
  readonly token_key: string | null;
  readonly token_symbol: string | null;
  readonly status: string | null;
  readonly amount: number | null;
  readonly avg_entry_price: number | null;
  readonly avg_exit_price: number | null;
  readonly realized_pnl_usd: number | null;
  readonly unrealized_pnl_usd: number | null;
  readonly opened_at: Date | null;
  readonly closed_at: Date | null;
  readonly captured_at: Date;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** A document is an object whose `trades`, when present, is a list. Anything else is malformed. */
export const isFomoDoc = (v: unknown): v is FomoDoc =>
  isRecord(v) && (v.trades === undefined || v.trades === null || Array.isArray(v.trades));

/** A number, or null. Strings and booleans are never numbers; never a coerced zero. */
export const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** A price, or null: fomo sends `avgEntryPrice: 0` for "unknown", and zero means absent here. */
export const price = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};

/** An ISO-8601 string as a Date, or null. Epoch numbers are not accepted (the python never did). */
export const when = (v: unknown): Date | null => {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** The snapshot time the rows of a document carry: fomo's `capturedAt`, else the fetch time. */
export const capturedOf = (doc: FomoDoc, now: Date): Date => when(doc.capturedAt) ?? now;

/**
 * The `trade_loads` row for one fetch. See the table comment in migration 20260917140000.
 * `prev` is the trader's `max(trades.captured_at)` before this fetch: a document whose
 * snapshot does not advance it (re-served, or empty so nothing is written) is `unchanged`.
 */
export function outcomeOf(f: Fetched, source: string | null, prev: Date | null, now: Date): Load {
  if (f.kind === "error") return { outcome: "error", detail: f.detail };
  if (f.kind === "not_found") return { outcome: "not_found", detail: "HTTP 404" };
  if (f.doc.available === false) {
    /* fomo answers {available:false} both when it sheds load and for anyone outside its leaderboard; the directory source tells the two apart. */
    return { outcome: source === "fomoapi.io" ? "degraded" : "unavailable", detail: null };
  }
  const n = f.doc.trades?.length ?? 0;
  const captured = capturedOf(f.doc, now);
  const advanced = n > 0 && (prev === null || captured.getTime() > prev.getTime());
  return advanced
    ? { outcome: "loaded", detail: `${n} trades` }
    : { outcome: "unchanged", detail: `${n} trades, snapshot ${captured.toISOString()} not newer` };
}

/**
 * One fomoapi trade as a `trades` row, or null when it has no `tradeId`. `netOf` is
 * token_key -> network_id from `tokens`: the trades feed carries no networkId.
 */
export function tradeRow(
  t: unknown, handle: string, netOf: ReadonlyMap<string, number>, captured: Date,
): TradeRow | null {
  if (!isRecord(t)) return null;
  const tradeId = str(t.tradeId) ?? (typeof t.tradeId === "number" && t.tradeId ? String(t.tradeId) : null);
  if (tradeId === null) return null;
  const tok = isRecord(t.token) ? t.token : {};
  const addr = (typeof tok.address === "string" ? tok.address.trim() : "") || null;
  const key = addr ? addr.toLowerCase() : null;
  return {
    trade_id: tradeId,
    handle,
    network_id: key ? netOf.get(key) ?? null : null,
    token_address: addr,
    token_key: key,
    token_symbol: str(tok.symbol),
    status: str(t.status),
    amount: num(t.amount),
    avg_entry_price: price(t.avgEntryPrice),
    avg_exit_price: price(t.avgExitPrice),
    realized_pnl_usd: num(t.realizedPnlUsd),
    unrealized_pnl_usd: num(t.unrealizedPnlUsd),
    opened_at: when(t.createdAt),
    closed_at: when(t.closedAt),
    captured_at: captured,
  };
}
