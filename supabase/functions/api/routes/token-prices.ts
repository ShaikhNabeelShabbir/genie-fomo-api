import { sql, n } from "../db.ts";
import { get, post } from "../router.ts";
import { ApiError, badRequest, notFound } from "../errors.ts";
import { chainWhere } from "../shared/chains.ts";
import { intParam, nonEmpty } from "../shared/params.ts";
import { BATCH_MAX } from "../shared/batch.ts";
import { type SeriesQuery, type SeriesStep, seriesQuery } from "../shared/series-rules.ts";

/**
 * Token price history, served from tables the hourly job fills (token_price_hourly, and the
 * daily/weekly/monthly candle views of migration 20260918020000). Nothing is fetched live and
 * nothing is back-filled from `token_prices`: an hour with no sample is simply absent.
 */

/** Points per token per call. Stated in the answer; a longer span at a fine step is truncated. */
export const MAX_POINTS = 2000;

type TokenRow = {
  network_id: number; token_key: string; address: string; chain: string; symbol: string | null;
  last_usd: string | null; last_at: Date | null; ath_usd: string | null; ath_at: Date | null;
};

type PointRow = {
  network_id: number; token_key: string; at: Date; usd: string; liquidity_usd: string | null;
  open_usd: string | null; high_usd: string | null; low_usd: string | null; hours: number | null;
};

type Pair = { network_id: number; token_key: string };
type Point = {
  at: string; usd: number | null; openUsd?: number | null; highUsd?: number | null;
  lowUsd?: number | null; hours?: number | null; liquidityUsd?: number | null;
};

const iso = (v: Date | string | null): string | null => (v ? new Date(String(v)).toISOString() : null);
const pairKey = (p: Pair): string => `${p.network_id}:${p.token_key}`;

/** Every (chain, token) row an address list resolves to, with the latest and the high. */
const resolveTokens = (keys: string[], net: number | null): Promise<TokenRow[]> => sql<TokenRow[]>`
  select t.network_id, t.token_key, t.address, c.name as chain, t.symbol,
         ps.last_usd, ps.last_at, ps.ath_usd, ps.ath_at
    from tokens t
    join chains c on c.network_id = t.network_id
    left join token_price_stats ps on ps.network_id = t.network_id and ps.token_key = t.token_key
   where t.token_key in (${keys}) ${net === null ? sql`` : sql`and t.network_id = ${net}`}
   order by t.token_key, t.network_id`;

/** Built per request: `sql` is the per-request client, so nothing may touch it at module load. */
const view = (step: Exclude<SeriesStep, "1h">) =>
  step === "1d" ? sql`token_price_daily` : step === "1w" ? sql`token_price_weekly` : sql`token_price_monthly`;

/** One query for every token: the newest `limit` points per pair, ascending in the answer. */
async function seriesFor(pairs: Pair[], q: SeriesQuery, limit: number): Promise<Map<string, Point[]>> {
  const out = new Map<string, Point[]>(pairs.map((p) => [pairKey(p), []]));
  if (!pairs.length) return out;
  const nets = pairs.map((p) => p.network_id);
  const keys = pairs.map((p) => p.token_key);
  /*
   * The pairwise unnest(nets, keys) is two json_each runs joined on the array index (the shim
   * binds a non-IN array as JSON text), and the per-pair cross join lateral (... limit n) is
   * row_number() <= n over the same ordering. The outer order by is new: the lateral emitted
   * each pair's rows newest-first and the loop below unshifts them into ascending order, so
   * that order is now stated rather than inherited from the plan.
   */
  const rows = q.step === "1h"
    ? await sql<PointRow[]>`
        select w.network_id, w.token_key, p.at, p.usd, p.liquidity_usd,
               null as open_usd, null as high_usd, null as low_usd, null as hours
          from (select jn.value as network_id, jk.value as token_key
                  from json_each(${nets}) jn
                  join json_each(${keys}) jk on jk.key = jn.key) w
          join (
            select h.network_id, h.token_key, h.hour as at, h.usd, h.liquidity_usd,
                   row_number() over (
                     partition by h.network_id, h.token_key order by h.hour desc) as rn
              from token_price_hourly h
             where h.token_key in (select value from json_each(${keys}))
               and h.hour <= ${q.to} ${q.from === null ? sql`` : sql`and h.hour >= ${q.from}`}) p
            on p.network_id = w.network_id and p.token_key = w.token_key and p.rn <= ${limit}
         order by w.network_id, w.token_key, p.at desc`
    : await sql<PointRow[]>`
        select w.network_id, w.token_key, p.at, p.usd, null as liquidity_usd,
               p.open_usd, p.high_usd, p.low_usd, p.hours
          from (select jn.value as network_id, jk.value as token_key
                  from json_each(${nets}) jn
                  join json_each(${keys}) jk on jk.key = jn.key) w
          join (
            select v.network_id, v.token_key, v.bucket as at, v.close_usd as usd,
                   v.open_usd, v.high_usd, v.low_usd, v.hours,
                   row_number() over (
                     partition by v.network_id, v.token_key order by v.bucket desc) as rn
              from ${view(q.step)} v
             where v.token_key in (select value from json_each(${keys}))
               and v.bucket <= ${q.to} ${q.from === null ? sql`` : sql`and v.bucket >= ${q.from}`}) p
            on p.network_id = w.network_id and p.token_key = w.token_key and p.rn <= ${limit}
         order by w.network_id, w.token_key, p.at desc`;
  for (const r of rows) {
    const point: Point = q.step === "1h"
      ? { at: iso(r.at) ?? "", usd: n(r.usd), liquidityUsd: n(r.liquidity_usd) }
      : { at: iso(r.at) ?? "", usd: n(r.usd), openUsd: n(r.open_usd), highUsd: n(r.high_usd), lowUsd: n(r.low_usd), hours: r.hours };
    out.get(pairKey({ network_id: Number(r.network_id), token_key: r.token_key }))?.unshift(point);
  }
  return out;
}

const tokenBlock = (t: TokenRow, points: Point[]) => ({
  address: t.address,
  chain: t.chain,
  symbol: nonEmpty(t.symbol),
  points,
  count: points.length,
  latest: t.last_at && t.last_usd !== null ? { at: iso(t.last_at), usd: n(t.last_usd) } : null,
});

const chainParam = (url: URL): string | null =>
  (url.searchParams.get("chain") ?? "").trim().toLowerCase() || null;

/** Group resolved rows by the key they answer, so an address on several chains is visible. */
const byKey = (rows: TokenRow[]): Map<string, TokenRow[]> => {
  const m = new Map<string, TokenRow[]>();
  for (const r of rows) m.set(r.token_key, [...(m.get(r.token_key) ?? []), r]);
  return m;
};

// ---------------------------------------------------------------- GET /tokens/:address/prices

get("/v1/tokens/:address/prices", async ({ address }, url) => {
  const chainQ = chainParam(url);
  const net = await chainWhere(chainQ);
  const q = seriesQuery(Object.fromEntries(url.searchParams), new Date());
  const limit = intParam(url, "limit", { min: 1, max: MAX_POINTS, fallback: MAX_POINTS }) ?? MAX_POINTS;

  const rows = await resolveTokens([address.toLowerCase()], net);
  if (!rows.length) throw notFound(`no token '${address}' on record${chainQ ? ` on ${chainQ}` : ""}`);
  if (rows.length > 1) {
    throw badRequest(`'${address}' exists on ${rows.length} chains — pass ?chain= to pick one`,
      { parameter: "chain", chains: rows.map((r) => r.chain) });
  }
  const [t] = rows;
  const series = await seriesFor([t], q, limit);
  const points = series.get(pairKey(t)) ?? [];
  return {
    ...tokenBlock(t, points),
    step: q.step, window: q.window, from: q.from, to: q.to,
    limit, truncated: points.length === limit,
    ath: t.ath_at && t.ath_usd !== null ? { usd: n(t.ath_usd), at: iso(t.ath_at) } : null,
    asOf: iso(t.last_at),
    links: {
      token: `/v1/tokens/${t.address}?chain=${t.chain}`,
      activity: `/v1/tokens/${t.address}/activity?chain=${t.chain}`,
    },
  };
});

// ---------------------------------------------------------------- POST /tokens/prices

/** `addresses` from a batch body: a non-empty list, at most BATCH_MAX, no address twice. */
function batchAddresses(body: unknown): string[] {
  const addresses = (body as { addresses?: unknown })?.addresses;
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw badRequest("body must be { \"addresses\": [...] } with at least one address", { parameter: "addresses" });
  }
  if (addresses.length > BATCH_MAX) {
    throw badRequest(
      `at most ${BATCH_MAX} addresses per call — got ${addresses.length}; split the list rather than ` +
      `relying on truncation`,
      { parameter: "addresses" });
  }
  const wanted = addresses.map(String);
  const seen = new Set<string>();
  for (const a of wanted) {
    const k = a.trim().toLowerCase();
    if (seen.has(k)) {
      throw new ApiError(400, "duplicate_identifier",
        `'${a}' appears more than once — every address must be distinct`, { parameter: "addresses" });
    }
    seen.add(k);
  }
  return wanted;
}

post("/v1/tokens/prices", async (_params, _url, body) => {
  const b = (body ?? {}) as { chain?: unknown; step?: unknown; window?: unknown; from?: unknown; to?: unknown };
  const requested = batchAddresses(body);
  const chainQ = nonEmpty(b.chain === undefined || b.chain === null ? null : String(b.chain))?.toLowerCase() ?? null;
  const net = await chainWhere(chainQ);
  const q = seriesQuery(b, new Date());

  const grouped = byKey(await resolveTokens(requested.map((a) => a.trim().toLowerCase()), net));
  const resolved = [...grouped.values()].filter((g) => g.length === 1).map((g) => g[0]);
  const series = await seriesFor(resolved, q, MAX_POINTS);

  const tokens = requested.map((req) => {
    const group = grouped.get(req.trim().toLowerCase()) ?? [];
    if (!group.length) {
      return { ok: false as const, requested: req, error: "not_found",
               detail: `no token '${req}' on record${chainQ ? ` on ${chainQ}` : ""}` };
    }
    if (group.length > 1) {
      return { ok: false as const, requested: req, error: "ambiguous_chain",
               detail: `'${req}' exists on ${group.length} chains — pass chain to pick one`,
               chains: group.map((r) => r.chain) };
    }
    const [t] = group;
    return { ok: true as const, requested: req, ...tokenBlock(t, series.get(pairKey(t)) ?? []) };
  });

  const asOfMs = resolved.map((t) => (t.last_at ? Date.parse(String(t.last_at)) : NaN)).filter(Number.isFinite);
  return {
    limit: BATCH_MAX,
    asked: requested.length,
    step: q.step, window: q.window, from: q.from, to: q.to,
    pointsLimit: MAX_POINTS,
    tokens,
    asOf: asOfMs.length ? new Date(Math.max(...asOfMs)).toISOString() : null,
  };
});
