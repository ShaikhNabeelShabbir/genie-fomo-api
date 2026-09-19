import type { Env } from "../env";
import { jobSql, type Sql } from "../sql";
import { REFUSALS_IN_A_ROW } from "../../../supabase/functions/_shared/settings.ts";
import {
  ADDRESSES_PER_CALL, afterRefusal, athUpdate, bestPairs, fetchPairs, isRefusal, rankedBatches, refusalWaitMs, type Ath, type BestPair,
} from "../../../supabase/functions/_shared/dexscreener.ts";
import { type Target, priceTargets } from "./prices-core";

/**
 * Hourly DexScreener price per held token, on every chain, with a rolling ATH: the Worker half
 * of `.github/workflows/prices.yml`.
 *
 * Ported from `scripts/load_token_prices.mjs` (deleted 17 Sep 2026; the Worker is the only copy). Same figures, same 30-address batches under
 * the shared per-host throttle; differs only where the platform does — a wall-clock budget
 * (a cron killed mid-write records nothing, stopping early and saying so is better), a
 * failed DexScreener batch is counted rather than fatal, and no `--dry-run`/`--token` flags.
 */

interface Hit { readonly t: Target; readonly b: BestPair; readonly source: string }

/** Rows per multi-row insert: D1 binds at most 100 parameters a statement. 6 columns x 15 = 90. */
const HOURLY_ROWS = 15;
/** 8 columns x 11 = 88 parameters. */
const STATS_ROWS = 11;

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

/** The targets in the order they are priced (`priceTargets`, in the core so a test can run it). */
async function targets(sql: Sql): Promise<Target[]> {
  const rows = await priceTargets(sql);
  return rows.map((r) => ({ ...r, network_id: Number(r.network_id) }));
}

/** Previous stats for a chunk, keyed `network_id:token_key`; one select per chunk (one chain). */
async function prevStats(sql: Sql, chunk: readonly Target[]): Promise<Map<string, Ath>> {
  const networkId = chunk[0].network_id;
  const rows = await sql<{ token_key: string; ath_usd: number; ath_at: string }[]>`
    select token_key, ath_usd, ath_at
      from token_price_stats
     where network_id = ${networkId} and token_key in (${chunk.map((t) => t.token_key)})`;
  return new Map(rows.map((r) => [`${networkId}:${r.token_key}`, { athUsd: Number(r.ath_usd), athAt: new Date(r.ath_at).toISOString() }]));
}

/** Every write of one batch as ONE D1 batch: the two upserts in slices, then the logo fills. */
async function writeChunk(sql: Sql, hour: string, priced: readonly Hit[], prev: Map<string, Ath>): Promise<void> {
  const stats = priced.map((p) => athUpdate(prev.get(`${p.t.network_id}:${p.t.token_key}`) ?? null, { usd: p.b.usd, at: hour }));
  // G2: fill a missing logo from the pair; GMGN's own (tokens job) is never overwritten.
  const withLogo = priced.filter((p) => p.b.logo !== null);
  await sql.begin((tx) => {
    for (let i = 0; i < priced.length; i += HOURLY_ROWS) {
      const part = priced.slice(i, i + HOURLY_ROWS);
      void tx.unsafe(
        `insert into token_price_hourly (network_id, token_key, hour, usd, liquidity_usd, source)
         values ${part.map(() => "(?,?,?,?,?,?)").join(",")}
         on conflict (network_id, token_key, hour) do update
           set usd = excluded.usd, liquidity_usd = excluded.liquidity_usd, source = excluded.source`,
        part.flatMap((p) => [p.t.network_id, p.t.token_key, hour, p.b.usd, p.b.liquidity, p.source]),
      );
    }
    for (let i = 0; i < priced.length; i += STATS_ROWS) {
      const part = priced.slice(i, i + STATS_ROWS);
      void tx.unsafe(
        `insert into token_price_stats (network_id, token_key, ath_usd, ath_at, last_usd, last_at, drawdown_share, source)
         values ${part.map(() => "(?,?,?,?,?,?,?,?)").join(",")}
         on conflict (network_id, token_key) do update
           set ath_usd = excluded.ath_usd, ath_at = excluded.ath_at, last_usd = excluded.last_usd, last_at = excluded.last_at,
               drawdown_share = excluded.drawdown_share, source = excluded.source,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        part.flatMap((p, j) => [
          p.t.network_id, p.t.token_key, stats[i + j].athUsd, stats[i + j].athAt,
          p.b.usd, hour, stats[i + j].drawdownShare, p.source,
        ]),
      );
    }
    for (const p of withLogo) {
      void tx`update token_info set logo_url = ${p.b.logo}
               where network_id = ${p.t.network_id} and token_key = ${p.t.token_key} and logo_url is null`;
    }
    return Promise.resolve();
  });
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
  const sql = jobSql(env);
  try {
    const list = await targets(sql);
    const hour = new Date(Math.floor(started / 3_600_000) * 3_600_000).toISOString();
    let priced = 0, done = 0, attempted = 0, failedBatches = 0, stoppedEarly = false, refusedInARow = 0, pauses = 0;
    for (const chunk of rankedBatches(list, ADDRESSES_PER_CALL)) {
      if (Date.now() - started > budgetMs) { stoppedEarly = true; break; }
      attempted += 1;
      try {
        priced += await priceBatch(sql, hour, chunk);
        refusedInARow = 0;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        failedBatches += 1;
        console.error(`prices: ${chunk[0].chain} batch of ${chunk.length} failed: ${message}`);
        // 1,027 of 1,052 batches were refused with 429 every hour from 17 Sep 12:00 UTC, each one
        // asked anyway: a thousand error lines an hour, and a ban that never had a quiet hour to lapse in.
        refusedInARow = isRefusal(message) ? refusedInARow + 1 : 0;
        /*
         * Wait and try again before giving the hour up (19 Sep 2026): stopping at the first run of
         * refusals lost 12:17 and 13:17 whole, and a price older than 24 h now prices nothing, so a
         * day of lost hours would blank every position. At most 20 refused calls an hour this way.
         */
        const next = afterRefusal(refusedInARow, pauses, REFUSALS_IN_A_ROW);
        const waitMs = refusalWaitMs(message);
        if (next === "stop" || (next === "pause" && Date.now() - started + waitMs > budgetMs)) {
          console.error(`prices: DexScreener refused ${refusedInARow} batches in a row after ${pauses} wait(s); leaving the rest of this hour`);
          stoppedEarly = true;
          done += chunk.length;
          break;
        }
        if (next === "pause") {
          pauses += 1;
          refusedInARow = 0;
          console.warn(`prices: DexScreener refused ${REFUSALS_IN_A_ROW} batches in a row; waiting ${waitMs / 1000} s as it asked (wait ${pauses})`);
          await new Promise((r) => setTimeout(r, waitMs));
        }
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
