import type postgres from "postgres";
import type { Env } from "../env";
import { db, longStatement } from "../db";
import { SOL_MINT, ZERO_ADDRESS } from "../../../supabase/functions/_shared/chain_reads.ts";
import {
  ADDRESSES_PER_CALL, athUpdate, bestPairs, fetchPairs, type Ath, type BestPair,
} from "../../../supabase/functions/_shared/dexscreener.ts";

/**
 * Hourly DexScreener price per held token, on every chain, with a rolling ATH: the Worker half
 * of `.github/workflows/prices.yml`.
 *
 * Ported from `scripts/load_token_prices.mjs` (deleted 17 Sep 2026; the Worker is the only copy). Same SQL, same 30-address batches under
 * the shared per-host throttle; differs only where the platform does — a wall-clock budget
 * (a cron killed mid-write records nothing, stopping early and saying so is better), a
 * failed DexScreener batch is counted rather than fatal, and no `--dry-run`/`--token` flags.
 */

type Sql = postgres.Sql;
interface Target { readonly network_id: number; readonly chain: string; readonly token_key: string; readonly address: string }
interface Hit { readonly t: Target; readonly b: BestPair; readonly source: string }

export interface PricesSummary {
  /** The UTC hour the samples were filed under. */
  readonly hour: string;
  readonly tokens: number;
  readonly priced: number;
  readonly batches: number;
  /** Batches whose DexScreener call or write failed; their tokens get the next hour. */
  readonly failedBatches: number;
  /** Tokens never asked because the budget ran out. Zero means the pass was complete. */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  /** Traders whose aum_live row was revalued at the new prices; null when nothing was priced or the budget was spent. */
  readonly liveRefreshed: number | null;
  readonly elapsedMs: number;
}

/**
 * Every held, non-native token with the chain word DexScreener wants, MOST-HELD FIRST, then
 * stalest first. ~26k tokens are held and one run prices ~20k at the DexScreener pace, so the
 * order decides what an hourly run guarantees: the tokens most balances depend on are always
 * priced this hour; the one-holder dust tail rotates by `token_price_stats.last_at`.
 */
async function targets(sql: Sql): Promise<Target[]> {
  const rows = await sql<{ network_id: string; chain: string; token_key: string; address: string }[]>`
    select h.network_id, ch.name as chain, h.token_key, tk.address
      from holdings_current h
      join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
      join chains ch on ch.network_id = h.network_id
      left join token_price_stats ps on ps.network_id = h.network_id and ps.token_key = h.token_key
     where h.human_amount > 0 and h.token_key not in (${ZERO_ADDRESS}, ${SOL_MINT})
     group by h.network_id, ch.name, h.token_key, tk.address, ps.last_at
     order by count(distinct h.handle) desc, ps.last_at asc nulls first, h.network_id, h.token_key`;
  return rows.map((r) => ({ ...r, network_id: Number(r.network_id) }));
}

/** Previous stats for a chunk, keyed `network_id:token_key`; one select per chunk. */
async function prevStats(sql: Sql, chunk: readonly Target[]): Promise<Map<string, Ath>> {
  const rows = await sql<{ network_id: string; token_key: string; ath_usd: string; ath_at: Date }[]>`
    select s.network_id, s.token_key, s.ath_usd, s.ath_at
      from token_price_stats s
      join unnest(${chunk.map((t) => t.network_id)}::bigint[], ${chunk.map((t) => t.token_key)}::text[])
           as k(network_id, token_key) using (network_id, token_key)`;
  return new Map(rows.map((r) => [`${r.network_id}:${r.token_key}`, { athUsd: Number(r.ath_usd), athAt: new Date(r.ath_at).toISOString() }]));
}

async function writeChunk(sql: Sql, hour: string, priced: readonly Hit[], prev: Map<string, Ath>): Promise<void> {
  const col = <T>(f: (p: Hit) => T): T[] => priced.map(f);
  await sql`
    insert into token_price_hourly (network_id, token_key, hour, usd, liquidity_usd, source)
    select * from unnest(${col((p) => p.t.network_id)}::bigint[], ${col((p) => p.t.token_key)}::text[], ${col(() => hour)}::timestamptz[],
                        ${col((p) => p.b.usd)}::numeric[], ${col((p) => p.b.liquidity)}::numeric[], ${col((p) => p.source)}::text[])
    on conflict (network_id, token_key, hour) do update
      set usd = excluded.usd, liquidity_usd = excluded.liquidity_usd, source = excluded.source`;
  const stats = priced.map((p) => athUpdate(prev.get(`${p.t.network_id}:${p.t.token_key}`) ?? null, { usd: p.b.usd, at: hour }));
  await sql`
    insert into token_price_stats (network_id, token_key, ath_usd, ath_at, last_usd, last_at, drawdown_share, source)
    select * from unnest(${col((p) => p.t.network_id)}::bigint[], ${col((p) => p.t.token_key)}::text[],
                        ${stats.map((s) => s.athUsd)}::numeric[], ${stats.map((s) => s.athAt)}::timestamptz[],
                        ${col((p) => p.b.usd)}::numeric[], ${col(() => hour)}::timestamptz[],
                        ${stats.map((s) => s.drawdownShare)}::numeric[], ${col((p) => p.source)}::text[])
    on conflict (network_id, token_key) do update
      set ath_usd = excluded.ath_usd, ath_at = excluded.ath_at, last_usd = excluded.last_usd, last_at = excluded.last_at,
          drawdown_share = excluded.drawdown_share, source = excluded.source, updated_at = now()`;
  // G2: fill a missing logo from the pair; GMGN's own (tokens job) is never overwritten.
  const withLogo = priced.filter((p) => p.b.logo !== null);
  if (withLogo.length === 0) return;
  await sql`
    update token_info ti set logo_url = v.logo
      from unnest(${withLogo.map((p) => p.t.network_id)}::bigint[], ${withLogo.map((p) => p.t.token_key)}::text[],
                  ${withLogo.map((p) => p.b.logo)}::text[]) as v(network_id, token_key, logo)
     where ti.network_id = v.network_id and ti.token_key = v.token_key and ti.logo_url is null`;
}

/** DexScreener's endpoint is per chain, so a batch never mixes chains. */
function batches(list: readonly Target[]): Target[][] {
  const byChain = new Map<string, Target[]>();
  for (const t of list) byChain.set(t.chain, [...(byChain.get(t.chain) ?? []), t]);
  return [...byChain.values()].flatMap((tokens) =>
    Array.from({ length: Math.ceil(tokens.length / ADDRESSES_PER_CALL) }, (_, i) => tokens.slice(i * ADDRESSES_PER_CALL, (i + 1) * ADDRESSES_PER_CALL)));
}

/** Price one batch and write it. Returns how many tokens had a pool. */
async function priceBatch(sql: Sql, hour: string, chunk: readonly Target[]): Promise<number> {
  const best = bestPairs(await fetchPairs(chunk[0].chain, chunk.map((t) => t.address)));
  const hits: Hit[] = [];
  for (const t of chunk) {
    const b = best.get(t.address.toLowerCase());
    if (b) hits.push({ t, b, source: `dexscreener:${b.dex}` });
  }
  if (hits.length) await writeChunk(sql, hour, hits, await prevStats(sql, chunk));
  return hits.length;
}

/**
 * One pass over every held token, within `budgetMs` of wall clock. Throws only when nothing
 * could be done (the token list failed, or every batch did), so the cron shows as failed.
 */
export async function runPrices(env: Env, budgetMs: number): Promise<PricesSummary> {
  const started = Date.now();
  const sql = db(env);
  try {
    const list = await targets(sql);
    const hour = new Date(Math.floor(started / 3_600_000) * 3_600_000).toISOString();
    let priced = 0, done = 0, attempted = 0, failedBatches = 0, stoppedEarly = false;
    for (const chunk of batches(list)) {
      if (Date.now() - started > budgetMs) { stoppedEarly = true; break; }
      attempted += 1;
      try {
        priced += await priceBatch(sql, hour, chunk);
      } catch (e) {
        failedBatches += 1;
        console.error(`prices: ${chunk[0].chain} batch of ${chunk.length} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      done += chunk.length;
    }
    if (attempted > 0 && failedBatches === attempted) throw new Error(`prices: all ${attempted} batches failed`);
    // New prices move every trader's current AUM, but a whole-roster `aum_live_refresh` after
    // every price run (450 x holdings_live) hammered the database on 17 Sep 2026. The :25 build
    // revalues anyone older than an hour and the minute cron revalues traders whose wallet moved;
    // the summary keeps the field (null) so dashboards need not change.
    const liveRefreshed: number | null = null;
    return { hour, tokens: list.length, priced, batches: attempted, failedBatches, remaining: list.length - done, stoppedEarly, liveRefreshed, elapsedMs: Date.now() - started };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
