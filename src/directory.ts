import fs from "node:fs";
import { WALLETS_FILE } from "./settings.js";
import { db, haveDb } from "./db.js";

export type Holding = {
  tokenAddress?: string;
  networkId?: number;
  humanAmount?: number;
  /** Current USD price, used to mark open positions in the PnL replay. */
  price?: number;
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
  /** Wallets resolved by an independent third party (see `src`). Deliberately separate
   *  from evm/sol, which mean "the wallet fomo provisioned" and hold none of the
   *  positions. Used to corroborate our own resolution, never as an answer on its own. */
  src_evm?: string;
  src_sol?: string;
  /** Which third party produced src_evm/src_sol, e.g. "fomoapi.io". */
  src?: string;
  pnl?: number;
  volume?: number;
  trades?: number;
  followers?: number;
  verified?: boolean;
  avatar?: string;
  bio?: string;
  twitter?: string;
  holdings?: Holding[];
};

let mtime = 0;
let traders: Trader[] = [];
let byHandle = new Map<string, Trader>();
let generatedAt: number | undefined;
let windowLabel: string | undefined;

/**
 * Where the directory comes from.
 *
 * `db` when a connection string is present, `file` otherwise — and DIRECTORY_SOURCE
 * overrides both. The override is not a convenience: it is what makes the two sources
 * diffable, so a schema bug that quietly changes a number shows up as a difference rather
 * than as the new truth.
 */
export type Source = "db" | "file";
export const source = (): Source => {
  const forced = (process.env.DIRECTORY_SOURCE ?? "").trim().toLowerCase();
  if (forced === "file" || forced === "db") return forced;
  return haveDb() ? "db" : "file";
};

/** How long a database snapshot is served before a refresh is attempted. */
const DB_TTL_MS = 5 * 60_000;
let dbLoadedAt = 0;
let refreshing: Promise<void> | null = null;

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

/**
 * Load the newest generation from Postgres into the file loader's shape.
 *
 * Three joins reproduce what the JSON carried: identity from `traders`, the per-build
 * leaderboard figures from `trader_stats_current`, and positions from `holdings_current`
 * (which is the newest `captured_at` only — history stays in `holdings` for K2).
 *
 * `evm`/`sol` come back as empty strings on purpose. They are fomo's provisioned wallets,
 * empty for all 100 traders and holding none of the positions; the addresses that matter
 * are `src_evm`/`src_sol`. Keeping the empty fields preserves the shape every route and
 * `publicTrader()` already expects.
 */
export async function refreshFromDb(): Promise<void> {
  const pool = db();
  const [people, positions, build] = await Promise.all([
    pool.query(`
      select t.handle, t.display_handle, t.name, t.avatar, t.bio, t.twitter, t.verified, t.source,
             s.rank, s.pnl_usd, s.volume_usd, s.trade_count, s.followers,
             w.evm_address, w.sol_address,
             extract(epoch from s.captured_at)::bigint as captured
      from traders t
      left join trader_stats_current s on s.handle = t.handle
      left join wallets w on w.handle = t.handle
      order by s.rank nulls last, t.handle
    `),
    pool.query(`
      select h.handle, tk.address as token_address, h.network_id,
             h.human_amount, h.price, h.value
      from holdings_current h
      join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    `),
    pool.query(`select window_label from builds order by captured_at desc limit 1`),
  ]);

  const byTrader = new Map<string, Holding[]>();
  for (const r of positions.rows) {
    const list = byTrader.get(r.handle) ?? [];
    list.push({
      tokenAddress: r.token_address,
      networkId: Number(r.network_id),
      // pg returns `numeric` as a string to avoid precision loss. Everything downstream
      // does arithmetic on these, so they are converted once here rather than in each
      // consumer — and a null stays null, never a coerced 0.
      humanAmount: r.human_amount === null ? undefined : Number(r.human_amount),
      price: r.price === null ? undefined : Number(r.price),
      value: r.value === null ? undefined : Number(r.value),
    });
    byTrader.set(r.handle, list);
  }

  const rows: Trader[] = people.rows.map((r) => ({
    handle: r.display_handle,
    name: r.name ?? "",
    rank: r.rank ?? undefined,
    evm: "",
    sol: "",
    src_evm: r.evm_address ?? undefined,
    src_sol: r.sol_address ?? undefined,
    src: r.source ?? undefined,
    pnl: r.pnl_usd === null ? undefined : Number(r.pnl_usd),
    volume: r.volume_usd === null ? undefined : Number(r.volume_usd),
    trades: r.trade_count ?? undefined,
    followers: r.followers ?? undefined,
    verified: !!r.verified,
    avatar: r.avatar ?? undefined,
    bio: r.bio ?? undefined,
    twitter: r.twitter ?? undefined,
    holdings: byTrader.get(r.handle) ?? [],
  }));

  if (!rows.length) throw new Error("database returned no traders");

  traders = rows;
  byHandle = new Map(rows.filter((t) => t.handle).map((t) => [t.handle.toLowerCase(), t]));
  generatedAt = people.rows[0]?.captured ? Number(people.rows[0].captured) : undefined;
  windowLabel = build.rows[0]?.window_label ?? undefined;
  dbLoadedAt = Date.now();
}

/**
 * Refresh in the background when the cache is stale.
 *
 * `all()` and `get()` are synchronous and every caller depends on that, so a stale snapshot
 * is served while the next one loads. A failed refresh keeps the old data rather than
 * emptying the directory — a stale board beats a broken one.
 */
function maybeRefresh(): void {
  if (source() !== "db") return;
  if (refreshing || Date.now() - dbLoadedAt < DB_TTL_MS) return;
  refreshing = refreshFromDb()
    .catch((e) => console.error(`directory refresh failed, serving previous: ${e.message}`))
    .finally(() => {
      refreshing = null;
    });
}

/** Load once at boot so the first request is not served an empty directory. */
export async function init(): Promise<Source> {
  const src = source();
  if (src === "db") await refreshFromDb();
  else reloadIfChanged();
  return src;
}

export function all(): Trader[] {
  if (source() === "db") {
    maybeRefresh();
    return traders;
  }
  reloadIfChanged();
  return traders;
}

export function get(handle: string): Trader | undefined {
  if (source() === "db") maybeRefresh();
  else reloadIfChanged();
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
  const src = source();
  if (src === "db") maybeRefresh();
  else reloadIfChanged();
  return {
    source: src,
    file: src === "db" ? "postgres" : WALLETS_FILE,
    traders: traders.length,
    window: windowLabel,
    generated_at: generatedAt,
    loaded_at: Math.floor(Date.now() / 1000),
  };
}
