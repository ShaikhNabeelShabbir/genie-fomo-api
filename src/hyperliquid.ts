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

// ------------------------------------------------------- per-trader lookups

const INFO = "https://api.hyperliquid.xyz/info";

async function info(body: Record<string, unknown>): Promise<any> {
  const r = await fetch(INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`hyperliquid HTTP ${r.status}`);
  return r.json();
}

/**
 * Resolve a leaderboard displayName to its address, so callers can use either.
 * Only ~1,400 of 44,590 accounts set one, so this is a convenience, not a real handle
 * system — Hyperliquid's identity IS the address.
 */
export async function resolveHandle(handle: string): Promise<string | null> {
  if (/^0x[0-9a-fA-F]{40}$/.test(handle)) return handle.toLowerCase();
  const board = await leaderboard();
  const needle = handle.trim().toLowerCase();
  for (const rows of board.byWindow.values()) {
    const hit = rows.find((r) => (r.label ?? "").toLowerCase() === needle);
    if (hit) return hit.address;
  }
  return null;
}

/** Live account state: margin and open positions, keyed by the address itself. */
export async function account(address: string, limit: number | null = null) {
  const s = await info({ type: "clearinghouseState", user: address });
  const positions = (s?.assetPositions ?? []).map((p: any) => ({
    coin: p?.position?.coin ?? null,
    size: Number(p?.position?.szi) || 0,
    entryPx: Number(p?.position?.entryPx) || null,
    positionValue: Number(p?.position?.positionValue) || 0,
    unrealizedPnl: Number(p?.position?.unrealizedPnl) || 0,
    leverage: p?.position?.leverage?.value ?? null,
  }));
  return {
    accountValue: Number(s?.marginSummary?.accountValue) || 0,
    totalMarginUsed: Number(s?.marginSummary?.totalMarginUsed) || 0,
    withdrawable: Number(s?.withdrawable) || 0,
    openPositions: positions.length,
    // Largest first, so a ?limit shows the positions that actually matter.
    positions: (limit === null
      ? positions
      : [...positions].sort((a, b) => Math.abs(b.positionValue) - Math.abs(a.positionValue))
          .slice(0, limit)),
  };
}

/** Recent fills. Hyperliquid caps this at 2000 and returns newest-last. */
export async function fills(address: string, limit: number) {
  const rows = (await info({ type: "userFills", user: address })) as any[];
  const list = Array.isArray(rows) ? rows : [];
  return list
    .slice(-limit)
    .reverse()
    .map((f) => ({
      coin: f?.coin ?? null,
      side: f?.side === "B" ? "buy" : f?.side === "A" ? "sell" : (f?.side ?? null),
      dir: f?.dir ?? null,
      price: Number(f?.px) || 0,
      size: Number(f?.sz) || 0,
      fee: Number(f?.fee) || 0,
      closedPnl: Number(f?.closedPnl) || 0,
      time: Number(f?.time) || 0,
      timeIso: f?.time ? new Date(Number(f.time)).toISOString() : null,
      hash: f?.hash ?? null,
    }));
}
