import { BITQUERY_KEY, haveBitquery } from "./settings.js";

/**
 * pump.fun trader leaderboard, via Bitquery's Solana DEX index.
 *
 * Like Hyperliquid and unlike fomo, nothing needs resolving: every trade carries
 * `Transaction.Signer`, which IS the trader's wallet. There is no provisioned address to
 * see through, so resolvers.ts does not apply here either.
 *
 * Why Bitquery rather than pump.fun directly:
 *   - pump.fun's frontend API only exposes /coins. No trades, no balances, no ranking.
 *   - The alternative is indexing the pump programs off the Solana firehose yourself,
 *     which is a data pipeline, not an integration.
 *   - Bitquery has already indexed it and will aggregate server-side, so ranking 200
 *     traders costs one request instead of millions of transactions.
 *
 * Two limits worth knowing, both surfaced in the response rather than hidden:
 *
 *   Coverage.  The `realtime` dataset our plan allows reaches back only ~12 hours
 *              (measured: earliest block 2026-09-01T23:08 when built). So this is a
 *              "who is trading now" board, NOT a 7d or 30d ranking. `coverageFrom` says
 *              exactly how far back the data goes. Longer windows need Bitquery archive.
 *
 *   Outliers.  Raw volume ranking surfaces nonsense — one wallet showed 3 trades and
 *              $94M of volume, which is a mispriced token or a wash, not a trader. Hence
 *              minTrades, defaulted to something that filters the obvious noise.
 */

const ENDPOINT = "https://streaming.bitquery.io/graphql";
const PROTOCOLS = ["pump", "pump_amm"] as const;   // bonding curve + post-graduation AMM
const TTL_MS = 10 * 60_000;
/** Rows pulled per refresh. Aggregation is server-side, so this is one request. */
const FETCH = 200;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

export type Row = { address: string; volumeUsd: number; trades: number };

/**
 * A pump.fun profile, or the absence of one.
 *
 * `registered` matters more than `label`. pump.fun auto-assigns an adjective-noun-number
 * handle to every wallet it sees, so a username alone proves nothing — the top trader's
 * "lateotter25358" comes with is_pump_user:false and no username update, i.e. nobody ever
 * claimed that account. `registered` separates a chosen identity from a placeholder.
 */
export type Profile = {
  label: string | null;
  registered: boolean;
  followers: number | null;
  twitter: string | null;
};
type Board = { at: number; coverageFrom: string | null; rows: Row[] };

let cache: Board | null = null;
let inflight: Promise<Board> | null = null;

async function gql(query: string): Promise<any> {
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${BITQUERY_KEY}` },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(90_000),
  });
  const j = (await r.json()) as { errors?: { message?: string }[]; data?: any };
  if (j?.errors) {
    const msg = String(j.errors[0]?.message ?? "bitquery error");
    throw new Error(/points limit|quota/i.test(msg) ? "Bitquery quota reached" : msg.slice(0, 200));
  }
  return j?.data;
}

async function load(): Promise<Board> {
  const list = PROTOCOLS.map((p) => `"${p}"`).join(",");

  // One aggregation request: group by signer, sum USD, count trades.
  const data = await gql(`{
    Solana {
      DEXTrades(
        limit: {count: ${FETCH}}
        orderBy: {descendingByField: "volumeUsd"}
        where: {Trade: {Dex: {ProtocolName: {in: [${list}]}}}}
      ) {
        Transaction { Signer }
        volumeUsd: sum(of: Trade_Buy_AmountInUSD)
        trades: count
      }
    }
  }`);

  const rows: Row[] = (data?.Solana?.DEXTrades ?? [])
    .map((r: any) => ({
      address: r?.Transaction?.Signer ?? "",
      volumeUsd: Number(r?.volumeUsd) || 0,
      trades: Number(r?.trades) || 0,
    }))
    .filter((r: Row) => r.address);

  // Cheap second call so the response can state its own coverage honestly rather than
  // implying the board spans longer than the dataset actually holds.
  let coverageFrom: string | null = null;
  try {
    const edge = await gql(
      `{ Solana { DEXTrades(limit: {count: 1}, orderBy: {ascending: Block_Time}) { Block { Time } } } }`,
    );
    coverageFrom = edge?.Solana?.DEXTrades?.[0]?.Block?.Time ?? null;
  } catch {
    /* coverage is informational — never fail the board for it */
  }

  return { at: Date.now(), coverageFrom, rows };
}

/** Cached board. Concurrent callers share one refresh — Bitquery bills per request. */
export async function leaderboard(): Promise<Board> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  if (!haveBitquery()) throw new Error("BITQUERY_KEY is not set");
  if (!inflight) {
    inflight = load()
      .then((fresh) => (cache = fresh))
      .finally(() => {
        inflight = null;
      });
  }
  try {
    return await inflight;
  } catch (e) {
    // A stale board beats a 502 when the quota runs out mid-day — this is a ranking.
    if (cache) return cache;
    throw e;
  }
}

/**
 * Address -> profile. Usernames change rarely, so this is cached for the process lifetime
 * rather than per board refresh, and only the page actually being served is resolved —
 * ?limit=2 costs two lookups, not two hundred.
 */
const profiles = new Map<string, Profile>();
const NO_PROFILE: Profile = { label: null, registered: false, followers: null, twitter: null };

async function fetchProfile(address: string): Promise<Profile> {
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/users/${address}`, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return NO_PROFILE;   // 404 simply means no profile exists
    const u = (await r.json()) as any;
    return {
      label: u?.username ?? null,
      registered: Boolean(u?.is_pump_user),
      followers: typeof u?.followers === "number" ? u.followers : null,
      twitter: u?.x_username ?? null,
    };
  } catch {
    return NO_PROFILE;   // the profile API is unofficial — never fail a board over it
  }
}

/** Resolve profiles for one page, in bounded parallel, reusing anything already known. */
export async function resolveProfiles(addresses: string[]): Promise<Map<string, Profile>> {
  const missing = [...new Set(addresses)].filter((a) => !profiles.has(a));
  const CONCURRENCY = 8;
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = missing.slice(i, i + CONCURRENCY);
    const got = await Promise.all(batch.map(fetchProfile));
    batch.forEach((a, j) => profiles.set(a, got[j]));
  }
  return new Map(addresses.map((a) => [a, profiles.get(a) ?? NO_PROFILE]));
}

export const PROTOCOL_NAMES = PROTOCOLS;
