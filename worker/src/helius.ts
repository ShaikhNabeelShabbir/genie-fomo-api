/** Helius webhook receiver — the live half of the transaction feed. See docs/DECISIONS.md#d196 */
const SOLANA = 1399811149;
/**
 * SOL as it appears in `quote_assets` — the system program address. Native lamport movements
 * carry no mint of their own, so they are recorded under this key to be priceable.
 */
const SOL_MINT = "11111111111111111111111111111111";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === "object" && v !== null ? (v as Rec) : {});
const recs = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const lower = (v: unknown): string => String(v ?? "").toLowerCase();
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export type Cell = string | number | null;
export type Row = [number, string, string, string, Cell, Cell, Cell, Cell, string, Cell, Cell];

/** Rows for every watched side of every transfer in a Helius payload. Pure. */
export function shapeRows(
  events: unknown,
  watched: ReadonlySet<string>,
): { rows: Row[]; skipped: number } {
  const rows: Row[] = [];
  let skipped = 0;

  for (const ev of Array.isArray(events) ? events.map(rec) : [rec(events)]) {
    const sig = str(ev.signature);
    const ts = num(ev.timestamp);
    if (!sig || ts === null) { skipped++; continue; }
    const at = new Date(ts * 1000).toISOString();
    const tail: [string, Cell, Cell] = ["helius-webhook", str(ev.type), str(ev.source)];

    for (const t of recs(ev.tokenTransfers)) {
      const from = lower(t.fromUserAccount);
      const to = lower(t.toUserAccount);
      const mint = t.mint ? lower(t.mint) : null;
      const amount = num(t.tokenAmount);
      if (!mint) { skipped++; continue; }

      // A transfer between two wallets we both watch is TWO rows, one per side — the same
      // event seen from each trader's perspective. Collapsing it would lose one of them.
      for (const [mine, other, dir] of [[from, to, "out"], [to, from, "in"]] as const) {
        if (!watched.has(mine)) continue;
        rows.push([SOLANA, sig, mine, at, dir, other || null, mint, amount, ...tail]);
      }
    }

    /** The native SOL side of a swap. See docs/DECISIONS.md#d197 */
    for (const t of recs(ev.nativeTransfers)) {
      const from = lower(t.fromUserAccount);
      const to = lower(t.toUserAccount);
      const lamports = num(t.amount);
      // Zero-value entries are bookkeeping, not movement. No other threshold is applied:
      // picking one would silently drop small but real trades, and the Express path
      // deliberately filters on zero alone.
      if (lamports === null || lamports === 0) { skipped++; continue; }

      for (const [mine, other, dir] of [[from, to, "out"], [to, from, "in"]] as const) {
        if (!watched.has(mine)) continue;
        rows.push([SOLANA, sig, mine, at, dir, other || null, SOL_MINT, lamports / 1e9, ...tail]);
      }
    }
  }
  return { rows, skipped };
}
