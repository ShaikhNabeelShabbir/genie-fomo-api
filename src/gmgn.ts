import { GMGN_KEY, haveGmgn } from "./settings.js";

/**
 * gmgn.ai trader board.
 *
 * gmgn maintains two curated cohorts — wallets it has already classified as smart money
 * or as KOLs — and exposes their recent trades. That curation is the point: our pump.fun
 * board ranks by raw volume and ends up 183 bots out of 200, because volume selects for
 * machines. Here the filtering has been done upstream, so the wallets are plausible
 * traders before we rank anything.
 *
 * Access notes, all learned the hard way:
 *
 *   Auth.   Read-only routes need the X-APIKEY header PLUS `timestamp` and `client_id`
 *           as QUERY params — a real key 401s without them, even though the public demo
 *           key does not. timestamp is validated within ±5s and client_id is a UUID whose
 *           replays are rejected after 7s, so both must be minted per request.
 *           Ed25519 signing is only for trading routes; nothing here needs it.
 *
 *   Rate.   1 request/second, enforced PER IP and not per key. On a shared host that is a
 *           single bucket for every user, so this must never be called per request —
 *           hence the cache, the long TTL, and the deliberate gap between cohort fetches.
 *
 *   Shape.  The endpoints return recent TRADES, not a ranking. `maker` is the wallet, so
 *           we aggregate by it ourselves. `maker_info` carries a real identity for KOLs
 *           (twitter handle, tags), which is the label pump.fun could not give us.
 */

const HOST = "https://openapi.gmgn.ai";
/** Deliberately long: the rate limit is per-IP, so refreshes must be rare. */
const TTL_MS = 15 * 60_000;
/** Their limit is 1 req/s; leave headroom rather than racing it. */
const GAP_MS = 1500;

export const COHORTS = ["smartmoney", "kol"] as const;
export type Cohort = (typeof COHORTS)[number];
export const isCohort = (v: string): v is Cohort => (COHORTS as readonly string[]).includes(v);

export type Row = {
  address: string;
  label: string | null;
  twitter: string | null;
  avatar: string | null;
  tags: string[];
  volumeUsd: number;
  trades: number;
  buys: number;
  sells: number;
  lastSeen: number | null;
};

type Board = { at: number; byCohort: Map<Cohort, Row[]> };

/**
 * Names seen across ALL refreshes, not just the current one.
 *
 * The cohort endpoints return roughly the last 100 trades, so a wallet is only on the
 * board while it is actively trading — "jrus" resolved one minute and 404'd the next.
 * Searching a live feed is therefore useless as a lookup. This map accumulates every
 * identity we have ever seen and never evicts, so a name stays findable after the wallet
 * goes quiet. Keyed by both label and twitter handle, lowercased.
 *
 * In-memory, so it resets on restart and rebuilds as boards refresh. Persisting it would
 * make lookups durable across deploys — worth doing if this becomes load-bearing.
 */
const known = new Map<string, Row>();

function remember(rows: Row[]): void {
  for (const r of rows) {
    if (r.label) known.set(r.label.toLowerCase(), r);
    if (r.twitter) known.set(r.twitter.toLowerCase(), r);
    known.set(r.address.toLowerCase(), r);
  }
}

/** How many identities the process has accumulated so far. */
export const knownCount = () => new Set([...known.values()].map((r) => r.address)).size;
let cache: Board | null = null;
let inflight: Promise<Board> | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchCohort(cohort: Cohort, chain: string): Promise<any[]> {
  // Minted per request: the server rejects a stale timestamp or a replayed client_id.
  const qs = new URLSearchParams({
    chain,
    timestamp: String(Math.floor(Date.now() / 1000)),
    client_id: crypto.randomUUID(),
  });
  const r = await fetch(`${HOST}/v1/user/${cohort}?${qs}`, {
    headers: { "X-APIKEY": GMGN_KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await r.json().catch(() => null)) as any;
  if (!r.ok || j?.code === 429) {
    throw new Error(
      j?.error === "RATE_LIMIT_EXCEEDED"
        ? "gmgn rate limit (1 req/s, per IP)"
        : `gmgn HTTP ${r.status}${j?.message ? `: ${j.message}` : ""}`,
    );
  }
  if (j?.code !== 0) throw new Error(String(j?.message ?? "gmgn error").slice(0, 160));
  return j?.data?.list ?? [];
}

/** Trades -> one row per wallet. */
function aggregate(list: any[]): Row[] {
  const by = new Map<string, Row>();
  for (const t of list) {
    const address = t?.maker;
    if (!address) continue;
    const info = t?.maker_info ?? {};
    const row = by.get(address) ?? {
      address,
      // KOLs carry a real twitter identity; smart-money rows usually carry only tags.
      label: info.twitter_name || info.name || info.twitter_username || null,
      twitter: info.twitter_username || null,
      avatar: info.avatar || null,
      tags: Array.isArray(info.tags) ? info.tags : [],
      volumeUsd: 0,
      trades: 0,
      buys: 0,
      sells: 0,
      lastSeen: null,
    };
    row.volumeUsd += Number(t?.amount_usd) || 0;
    row.trades += 1;
    if (t?.side === "buy") row.buys += 1;
    else if (t?.side === "sell") row.sells += 1;
    const ts = Number(t?.timestamp) || 0;
    if (ts && (row.lastSeen === null || ts > row.lastSeen)) row.lastSeen = ts;
    by.set(address, row);
  }
  return [...by.values()].sort((a, b) => b.volumeUsd - a.volumeUsd);
}

async function load(chain: string): Promise<Board> {
  const byCohort = new Map<Cohort, Row[]>();
  for (const [i, c] of COHORTS.entries()) {
    if (i) await sleep(GAP_MS);   // stay under 1 req/s
    try {
      const rows = aggregate(await fetchCohort(c, chain));
      remember(rows);          // grow the directory before the snapshot is discarded
      byCohort.set(c, rows);
    } catch (e) {
      // One cohort failing must not lose the other — a 429 on the second call is common.
      byCohort.set(c, cache?.byCohort.get(c) ?? []);
      if (!cache) throw e;
    }
  }
  return { at: Date.now(), byCohort };
}

/** Cached board. Concurrent callers share one refresh — the rate limit is unforgiving. */
export async function leaderboard(chain = "sol"): Promise<Board> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  if (!haveGmgn()) throw new Error("GMGN_API_KEY is not set");
  if (!inflight) {
    inflight = load(chain)
      .then((fresh) => (cache = fresh))
      .finally(() => {
        inflight = null;
      });
  }
  try {
    return await inflight;
  } catch (e) {
    if (cache) return cache;   // stale board beats a 502 for a ranking
    throw e;
  }
}

// ------------------------------------------------------- per-trader lookups

/** Shared request builder: X-APIKEY header + per-request timestamp/client_id in the query. */
async function get(path: string, params: Record<string, string | number>): Promise<any> {
  if (!haveGmgn()) throw new Error("GMGN_API_KEY is not set");
  const qs = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    timestamp: String(Math.floor(Date.now() / 1000)),
    client_id: crypto.randomUUID(),
  });
  const r = await fetch(`${HOST}${path}?${qs}`, {
    headers: { "X-APIKEY": GMGN_KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await r.json().catch(() => null)) as any;
  if (j?.error === "RATE_LIMIT_EXCEEDED") throw new Error("gmgn rate limit (1 req/s, per IP)");
  if (!r.ok) throw new Error(`gmgn HTTP ${r.status}`);
  if (j?.code !== 0) throw new Error(String(j?.message ?? "gmgn error").slice(0, 160));
  return j?.data;
}

/**
 * Wallet performance. This is the one endpoint across all four platforms that returns
 * realized PnL already computed — the accounting we would otherwise have to build.
 */
export async function walletStats(address: string, chain: string, period = "7d") {
  const d = await get("/v1/user/wallet_stats", { chain, wallet_address: address, period });
  return {
    address: d?.wallet_address ?? address,
    period,
    nativeBalance: Number(d?.native_balance) || 0,
    realizedProfit: Number(d?.realized_profit) || 0,
    realizedProfitPct: Number(d?.realized_profit_pnl) || 0,
    buys: Number(d?.buy) || 0,
    sells: Number(d?.sell) || 0,
    boughtCost: Number(d?.bought_cost) || 0,
    soldIncome: Number(d?.sold_income) || 0,
    totalCost: Number(d?.total_cost) || 0,
    lastActive: Number(d?.last_timestamp) || null,
  };
}

/** Recent buys/sells for a wallet, newest first. */
export async function walletActivity(address: string, chain: string, limit: number) {
  const d = await get("/v1/user/wallet_activity", { chain, wallet_address: address, limit });
  return (d?.activities ?? []).slice(0, limit).map((a: any) => ({
    time: Number(a?.timestamp) || 0,
    timeIso: a?.timestamp ? new Date(Number(a.timestamp) * 1000).toISOString() : null,
    side: a?.event_type ?? null,
    token: a?.token?.symbol ?? null,
    mint: a?.token?.address ?? a?.quote_address ?? null,
    amount: Number(a?.token_amount) || 0,
    amountUsd: Number(a?.cost_usd) || 0,
    priceUsd: Number(a?.price_usd) || 0,
    launchpad: a?.launchpad ?? a?.launchpad_platform ?? null,
    signature: a?.tx_hash ?? null,
  }));
}

/**
 * Accept a name as well as an address.
 *
 * gmgn has no handle system — the wallet address is the identity — but the curated
 * cohorts carry `label` and `twitter` for the wallets they track, so those are usable as
 * lookup keys. Matches either, case-insensitively, across both cohorts. Returns null for
 * a name nobody on the board answers to, which the route turns into a 404 rather than
 * passing a non-address through to gmgn and getting "invalid wallet address".
 *
 * Only wallets currently on a cohort board can be found this way — it is a convenience
 * over the cached board, not a directory.
 */
export async function resolveHandle(handle: string, chain = "sol"): Promise<string | null> {
  const h = handle.trim();
  // Solana addresses are base58 and 32-44 chars; anything else is treated as a name.
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(h)) return h;
  const needle = h.toLowerCase().replace(/^@/, "");
  // Refresh first so a brand-new name can be picked up, then search everything ever seen.
  await leaderboard(chain).catch(() => null);
  return known.get(needle)?.address ?? null;
}

/** Identity for one wallet, taken from whichever cohort already knows it. */
export async function profile(address: string, chain = "sol"): Promise<Row | null> {
  await leaderboard(chain).catch(() => null);
  return known.get(address.toLowerCase()) ?? null;
}
