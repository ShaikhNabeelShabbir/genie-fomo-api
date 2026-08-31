import fs from "node:fs";
import { WALLETS_FILE } from "./settings.js";

export type Holding = {
  tokenAddress?: string;
  networkId?: number;
  humanAmount?: number;
  value?: number;
  pnl?: number;
  imageUrl?: string | null;
};

export type Trader = {
  handle: string;
  name: string;
  rank?: number;
  evm?: string;
  sol?: string;
  pnl?: number;
  volume?: number;
  trades?: number;
  followers?: number;
  verified?: boolean;
  holdings?: Holding[];
};

let mtime = 0;
let traders: Trader[] = [];
let byHandle = new Map<string, Trader>();
let generatedAt: number | undefined;
let windowLabel: string | undefined;

/** Re-reads when the file changes, so a pipeline run is picked up without a restart. */
function reloadIfChanged(): void {
  if (!fs.existsSync(WALLETS_FILE)) {
    traders = [];
    byHandle = new Map();
    return;
  }
  const m = fs.statSync(WALLETS_FILE).mtimeMs;
  if (m === mtime && traders.length) return;

  const doc = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
  mtime = m;
  traders = (doc.traders ?? []) as Trader[];
  generatedAt = doc.generated_at;
  windowLabel = doc.window;
  byHandle = new Map(traders.filter((t) => t.handle).map((t) => [t.handle.toLowerCase(), t]));
}

export function all(): Trader[] {
  reloadIfChanged();
  return traders;
}

export function get(handle: string): Trader | undefined {
  reloadIfChanged();
  return byHandle.get(handle.trim().replace(/^@/, "").toLowerCase());
}

export function search(q: string, limit = 25, offset = 0): { rows: Trader[]; total: number } {
  let rows = all();
  if (q.trim()) {
    const needle = q.trim().replace(/^@/, "").toLowerCase();
    const scored: { score: number; t: Trader }[] = [];
    for (const t of rows) {
      const h = (t.handle ?? "").toLowerCase();
      const n = (t.name ?? "").toLowerCase();
      if (h === needle || n === needle) scored.push({ score: 0, t });
      else if (h.startsWith(needle) || n.startsWith(needle)) scored.push({ score: 1, t });
      else if (h.includes(needle) || n.includes(needle)) scored.push({ score: 2, t });
    }
    scored.sort((a, b) => a.score - b.score || (a.t.rank ?? 9999) - (b.t.rank ?? 9999));
    rows = scored.map((s) => s.t);
  }
  return { rows: rows.slice(offset, offset + limit), total: rows.length };
}

export function meta() {
  reloadIfChanged();
  return {
    file: WALLETS_FILE,
    traders: traders.length,
    window: windowLabel,
    generated_at: generatedAt,
    loaded_at: Math.floor(Date.now() / 1000),
  };
}
