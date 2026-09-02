/**
 * Hyperliquid leaderboard.
 *
 * Unlike fomo, nothing here needs resolving: the leaderboard publishes `ethAddress`
 * directly, along with pnl, roi and volume over four windows. There is no provisioned
 * wallet hiding the real one, so the fingerprinting in resolvers.ts does not apply.
 *
 * Two things shape this module:
 *
 *   Size.  The feed is ~36MB / 44,590 rows and parsing it costs ~121MB of heap — a real
 *          cost on a 512MB instance. So we parse once per TTL, keep only the top CAP rows
 *          per window, and let the rest be collected. Steady-state memory is a few
 *          thousand small objects; only the refresh spikes.
 *
 *   Order. Rows arrive roughly by account value, NOT by performance, so each window has
 *          to be sorted independently.
 *
 * Caveat worth knowing: these addresses live on Hyperliquid's own L1. They are EVM-shaped
 * but are NOT queryable through the chains in settings.ts — per-trader fills come from
 * Hyperliquid's own /info endpoint.
 */

const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const TTL_MS = 10 * 60_000;
/** Rows retained per window. Far beyond any sane page size, small enough to stay cheap. */
const CAP = 500;

export const WINDOWS = ["day", "week", "month", "allTime"] as const;
export type Window = (typeof WINDOWS)[number];

export type Row = {
  address: string;
  label: string | null;
  accountValue: number;
  pnl: number;
  roi: number;
  volume: number;
};

type Cache = { at: number; total: number; byWindow: Map<Window, Row[]> };
let cache: Cache | null = null;
let inflight: Promise<Cache> | null = null;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function load(): Promise<Cache> {
  const r = await fetch(LEADERBOARD_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`Hyperliquid leaderboard HTTP ${r.status}`);

  const doc = (await r.json()) as { leaderboardRows?: unknown[] };
  const rows = doc?.leaderboardRows;
  if (!Array.isArray(rows) || !rows.length) throw new Error("leaderboard returned no rows");

  const byWindow = new Map<Window, Row[]>();
  for (const w of WINDOWS) {
    const mapped: Row[] = [];
    for (const raw of rows as any[]) {
      const address = raw?.ethAddress;
      if (!address) continue;
      // windowPerformances is [[name, {pnl, roi, vlm}], ...] — not keyed by name.
      const perf = (raw.windowPerformances as [string, any][] | undefined)
        ?.find(([name]) => name === w)?.[1];
      if (!perf) continue;
      mapped.push({
        address,
        label: raw.displayName ?? null,
        accountValue: num(raw.accountValue),
        pnl: num(perf.pnl),
        roi: num(perf.roi),
        volume: num(perf.vlm),
      });
    }
    mapped.sort((a, b) => b.pnl - a.pnl);
    byWindow.set(w, mapped.slice(0, CAP));
  }

  return { at: Date.now(), total: rows.length, byWindow };
}

/** Cached leaderboard. Concurrent callers share one refresh rather than each parsing 36MB. */
export async function leaderboard(): Promise<Cache> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  if (!inflight) {
    inflight = load()
      .then((fresh) => {
        cache = fresh;
        return fresh;
      })
      .finally(() => {
        inflight = null;
      });
  }
  try {
    return await inflight;
  } catch (e) {
    // A stale board beats a 502 — the data is a ranking, not a balance.
    if (cache) return cache;
    throw e;
  }
}

export const isWindow = (v: string): v is Window => (WINDOWS as readonly string[]).includes(v);
