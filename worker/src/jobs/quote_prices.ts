import type { Env } from "../env";
import { jobSql, type Sql } from "../sql";
import { ADDRESSES_PER_CALL, bestPairs, fetchPairs } from "../../../supabase/functions/_shared/dexscreener.ts";
import { DAY_MS, KLINES_LIMIT, PAIR, parseKlines, seriesStartMs } from "./quote_prices-core";

/**
 * Quote-asset and Robinhood-coin pricing into `token_prices`, the Worker half of refresh.yml
 * "Price quote-asset transfers" + "Price Robinhood-chain coins".
 *
 * Phase 1 (T2.1): daily Binance closes for every floating quote asset with a pair in `PAIR`
 * (SOL, wSOL, ETH, WETH, BNB, WBNB), then `transactions.value_usd` for quote-asset legs in
 * batches. `jobs/swaps.ts` reads the same closes to value the money leg of a swap.
 * Phase 2 (R4): today's DexScreener price for every held Robinhood token neither a quote
 * asset nor priced by GMGN (docs/R4_ROBINHOOD_PRICES.md).
 *
 * TWINS OF `scripts/load_quote_prices.mjs` and `scripts/load_robinhood_prices.mjs`: edit all
 * three. Same sources, same batch sizes; differs only where the platform does — a wall-clock
 * budget checked before every unit (one asset, one update batch, one DexScreener call), a
 * failed unit is counted rather than fatal, the `value_usd` update runs in slices D1 finishes
 * inside its 30 s per statement (no `statement_timeout` to raise), the informational
 * "still unpriced" count is not taken, and no `--all`/`--days`/`--limit`/`--token` flags.
 */

interface QuoteAsset { readonly network_id: number; readonly token_key: string; readonly symbol: string; readonly first_day: Date | string | null }
interface RobinhoodToken { readonly token_key: string; readonly address: string }

const BINANCE = "https://api.binance.com/api/v3/klines";
/** Pages of KLINES_LIMIT per asset; one in practice, the loop keeps a longer history from silently truncating. */
const MAX_PAGES = 20;
/** Rows per value_usd update: a slice D1 finishes well inside the 30 s it allows one statement. */
const UPDATE_BATCH = 5_000;
const MAX_UPDATE_BATCHES = 200;
/** Days per token_prices insert: 5 columns x 18 rows = 90 of the 100 parameters D1 binds. */
const PRICE_ROWS = 18;
const ROBINHOOD_NETWORK_ID = 4663;
const ROBINHOOD_CHAIN = "robinhood";
const SOURCE = "dexscreener";

export interface QuotePricesSummary {
  /** `transactions.value_usd` rows filled this run. */
  readonly transfersPriced: number;
  /** Robinhood tokens that had a pool and were written for today. */
  readonly coinsPriced: number;
  /** Source calls attempted: one per quote asset (Binance) plus one per 30 Robinhood tokens (DexScreener). */
  readonly batches: number;
  /** Source calls whose fetch or write failed; their rows get the next run. */
  readonly failedBatches: number;
  /** Quote assets and Robinhood tokens never asked because the budget ran out. Zero means the pass was complete. */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

/**
 * Every floating quote asset with a Binance pair (X2: EVM rows carry no `tx_type`, so a swap
 * count could never admit WBNB/WETH), and from when: the first swap day where one is known,
 * else `seriesStartMs` looks a year back.
 */
const quoteAssets = (sql: Sql) => sql<QuoteAsset[]>`
  select q.network_id, q.token_key, q.symbol, null as first_day
    from quote_assets q
   where q.pegged_usd is null and q.symbol in (${Object.keys(PAIR)})
   order by q.network_id, q.symbol`;
// No join to \`transactions\` for the first swap day: that scan is far too slow for one statement
// (17 Sep). A null first_day makes \`seriesStartMs\` look a year back, one Binance page.

/** Daily closes from Binance, paged from `startMs`. */
async function dailyCloses(pair: string, startMs: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let cursor = startMs;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await fetch(`${BINANCE}?symbol=${pair}&interval=1d&startTime=${cursor}&limit=${KLINES_LIMIT}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`binance HTTP ${r.status} for ${pair}`);
    const closes = parseKlines(await r.json());
    if (closes.count === 0 || closes.lastOpenMs === null) break;
    for (const [day, usd] of closes.byDay) out.set(day, usd);
    if (closes.count < KLINES_LIMIT) break;
    cursor = closes.lastOpenMs + DAY_MS;
  }
  return out;
}

/** Fetch and upsert one asset's series. Returns days written; 0 when Binance has nothing for it. */
async function priceAsset(sql: Sql, a: QuoteAsset, pair: string, now: Date): Promise<number> {
  const closes = await dailyCloses(pair, seriesStartMs(a.first_day ? new Date(a.first_day) : null, now));
  if (!closes.size) return 0;
  const days = [...closes.keys()], vals = [...closes.values()];
  const source = `binance:${pair}`;
  await sql.begin((tx) => {
    for (let i = 0; i < days.length; i += PRICE_ROWS) {
      const part = days.slice(i, i + PRICE_ROWS);
      void tx.unsafe(
        `insert into token_prices (network_id, token_key, day, usd, source)
         values ${part.map(() => "(?,?,?,?,?)").join(",")}
         on conflict (network_id, token_key, day)
         do update set usd = excluded.usd, source = excluded.source,
                       fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        part.flatMap((d, j) => [a.network_id, a.token_key, d, vals[i + j], source]),
      );
    }
    return Promise.resolve();
  });
  return days.length;
}

/**
 * One batch of `transactions.value_usd` for quote-asset legs. Idempotent and resumable: only
 * rows where `value_usd is null`. `value_usd` is a MAGNITUDE like `amount`; direction lives
 * in the `direction` column alone. Returns rows updated.
 */
const priceTransactionsBatch = async (sql: Sql): Promise<number> => {
  // The Postgres `update … from quote_assets left join token_prices` became one scalar subquery
  // per rung (peg, then that day's close) with an `exists` guard, so a row nothing can price is
  // left untouched and does not count as written. `ctid` -> `rowid`.
  const res = await sql`
    update transactions
       set value_usd = amount * coalesce(
             (select q.pegged_usd from quote_assets q
               where q.network_id = transactions.network_id and q.token_key = transactions.token_key),
             (select p.usd from token_prices p
               where p.network_id = transactions.network_id and p.token_key = transactions.token_key
                 and p.day = substr(transactions.block_time, 1, 10)))
     where value_usd is null
       and rowid in (select rowid from transactions
                      where value_usd is null and tx_type = 'SWAP'
                      limit ${UPDATE_BATCH})
       and exists (select 1 from quote_assets q
                    where q.network_id = transactions.network_id and q.token_key = transactions.token_key
                      and (q.pegged_usd is not null
                           or exists (select 1 from token_prices p
                                       where p.network_id = q.network_id and p.token_key = q.token_key
                                         and p.day = substr(transactions.block_time, 1, 10))))`;
  return res.count;
};

/**
 * Held Robinhood tokens that are not a quote asset and that GMGN (`token_info`) carries no price for.
 * `holdings_current` is a view over every capture, so this is the run's one broad read; one chain
 * keeps it small.
 */
const robinhoodTargets = (sql: Sql) => sql<RobinhoodToken[]>`
  select distinct h.token_key, tk.address
    from holdings_current h
    join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    left join token_info ti on ti.network_id = h.network_id and ti.token_key = h.token_key
   where h.network_id = ${ROBINHOOD_NETWORK_ID} and q.token_key is null and ti.price_usd is null
   order by h.token_key`;

/** Price one DexScreener batch and write today's row per token that has a pool. Returns tokens priced. */
async function priceRobinhoodBatch(sql: Sql, chunk: readonly RobinhoodToken[], day: string): Promise<number> {
  const best = bestPairs(await fetchPairs(ROBINHOOD_CHAIN, chunk.map((t) => t.address)));
  const hits = chunk.flatMap((t) => {
    const b = best.get(t.address.toLowerCase());
    return b ? [{ t, b }] : [];
  });
  if (!hits.length) return 0;
  await sql.begin((tx) => {
    for (const { t, b } of hits) {
      void tx`
        insert into token_prices (network_id, token_key, day, usd, source)
        values (${ROBINHOOD_NETWORK_ID}, ${t.token_key}, ${day}, ${b.usd}, ${`${SOURCE}:${b.dex}`})
        on conflict (network_id, token_key, day)
        do update set usd = excluded.usd, source = excluded.source,
                      fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
    }
    return Promise.resolve();
  });
  return hits.length;
}

/**
 * One pass over both phases within `budgetMs`. Throws only when source calls were attempted
 * and every one failed, so the cron shows as failed rather than quietly pricing nothing.
 */
export async function runQuotePrices(env: Env, budgetMs: number): Promise<QuotePricesSummary> {
  const started = Date.now();
  const left = (): number => budgetMs - (Date.now() - started);
  const sql = jobSql(env);
  try {
    const now = new Date(started);
    let transfersPriced = 0, coinsPriced = 0, batches = 0, failedBatches = 0, done = 0, stoppedEarly = false;
    const fail = (what: string, e: unknown): void => {
      failedBatches += 1;
      console.error(`quote_prices: ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
    };

    /* Phase 1a: daily closes per floating quote asset. */
    const assets = await quoteAssets(sql);
    for (const a of assets) {
      if (left() <= 0) { stoppedEarly = true; break; }
      done += 1;
      const pair = PAIR[a.symbol];
      if (!pair) { console.warn(`quote_prices: ${a.symbol} skipped, no Binance pair mapped`); continue; }
      batches += 1;
      try {
        const days = await priceAsset(sql, a, pair, now);
        if (days === 0) console.warn(`quote_prices: ${a.symbol} skipped, binance returned nothing`);
      } catch (e) { fail(`${a.symbol} closes`, e); }
    }

    /* Phase 1b: value_usd for quote-asset legs, in batches until one updates nothing. */
    for (let i = 0; i < MAX_UPDATE_BATCHES && !stoppedEarly; i++) {
      if (left() <= 0) { stoppedEarly = true; break; }
      try {
        const n = await priceTransactionsBatch(sql);
        if (n === 0) break;
        transfersPriced += n;
      } catch (e) { fail(`value_usd batch ${i + 1}`, e); break; }
    }

    /* Phase 2: today's DexScreener price per unpriced held Robinhood token. */
    const tokens = await robinhoodTargets(sql);
    const day = now.toISOString().slice(0, 10);
    for (let i = 0; i < tokens.length; i += ADDRESSES_PER_CALL) {
      if (left() <= 0) { stoppedEarly = true; break; }
      const chunk = tokens.slice(i, i + ADDRESSES_PER_CALL);
      batches += 1;
      try {
        coinsPriced += await priceRobinhoodBatch(sql, chunk, day);
      } catch (e) { fail(`robinhood batch of ${chunk.length}`, e); }
      done += chunk.length;
    }

    if (batches > 0 && failedBatches === batches) throw new Error(`quote_prices: all ${batches} source calls failed`);
    return {
      transfersPriced, coinsPriced, batches, failedBatches,
      remaining: assets.length + tokens.length - done,
      stoppedEarly, elapsedMs: Date.now() - started,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
