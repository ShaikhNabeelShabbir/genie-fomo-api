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
      byCohort.set(c, aggregate(await fetchCohort(c, chain)));
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
