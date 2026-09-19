import type { Env } from "../env";
import { jobSql, type Sql } from "../sql";
import { ADDRESSES_PER_CALL, bestPairs, fetchPairs } from "../../../supabase/functions/_shared/dexscreener.ts";
import {
  DAY_MS, KLINES_LIMIT, KRAKEN_PAIR, PAIR, type QuoteAsset, bybitList, deadSources, krakenList, parseKlines,
  priceLegsFrom, quoteAssets, seriesStartMs,
} from "./quote_prices-core";

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

interface RobinhoodToken { readonly token_key: string; readonly address: string }

const BINANCE = "https://api.binance.com/api/v3/klines";
/**
 * Binance answers HTTP 403 to every request from this Worker — it refuses Cloudflare's egress, and
 * that single refusal is why native ETH and BNB had no price and why WBNB-quoted swaps had no
 * dollar value (N1 and X2, diagnosed 17 Sep 2026). Bybit serves the same daily candles from the
 * same pair names, and its rows put the open time at index 0 and the close at index 4 exactly as a
 * kline does, so the existing parse reads them unchanged.
 */
const BYBIT = "https://api.bybit.com/v5/market/kline";
/** Bybit's ceiling for one call: 1000 daily candles, about 2.7 years, so one call covers the window. */
const BYBIT_LIMIT = 1000;
/** Pages of KLINES_LIMIT per asset; one in practice, the loop keeps a longer history from silently truncating. */
const MAX_PAGES = 20;
/** Rowids per value_usd update: a slice D1 finishes well inside the 30 s it allows one statement. */
const UPDATE_BATCH = 5_000;
const MAX_UPDATE_BATCHES = 200;
/** How long a quote leg waits for its day's close before the value_usd pass gives it up: a failed exchange read is retried for two days. */
const CLOSE_WAIT_MS = 2 * DAY_MS;
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

/** Daily closes from Binance, paged from `startMs`. */
async function binanceCloses(pair: string, startMs: number): Promise<Map<string, number>> {
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

/** Daily closes from Bybit, one call: the window the callers ask for fits inside `BYBIT_LIMIT`. */
async function bybitCloses(pair: string, startMs: number): Promise<Map<string, number>> {
  const r = await fetch(`${BYBIT}?category=spot&symbol=${pair}&interval=D&start=${startMs}&limit=${BYBIT_LIMIT}`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`bybit HTTP ${r.status} for ${pair}`);
  return new Map(parseKlines(bybitList(await r.json())).byDay);
}

const KRAKEN = "https://api.kraken.com/0/public/OHLC";

/** Daily closes from Kraken: the newest 720 days in one call. It reports a bad pair as HTTP 200 with `error`. */
async function krakenCloses(pair: string, startMs: number): Promise<Map<string, number>> {
  const theirs = KRAKEN_PAIR[pair];
  if (!theirs) throw new Error(`kraken has no pair mapped for ${pair}`);
  const r = await fetch(`${KRAKEN}?pair=${theirs}&interval=1440&since=${Math.floor(startMs / 1000)}`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`kraken HTTP ${r.status} for ${theirs}`);
  const body = await r.json() as { error?: unknown[] };
  if (body.error?.length) throw new Error(`kraken refused ${theirs}: ${String(body.error[0])}`);
  return new Map(parseKlines(krakenList(body)).byDay);
}

const SOURCES: readonly { readonly name: string; readonly closes: (pair: string, startMs: number) => Promise<Map<string, number>> }[] = [
  { name: "binance", closes: binanceCloses }, { name: "bybit", closes: bybitCloses }, { name: "kraken", closes: krakenCloses },
];

/**
 * The first source that answers, in order, and WHICH one: Binance refuses this Worker everywhere,
 * Bybit refuses it from US colos (403 on every run of 19 Sep), Kraken does not. Each refusal is
 * logged once per asset, and the row's `source` names the exchange that actually priced it.
 */
async function dailyCloses(pair: string, startMs: number): Promise<{ closes: Map<string, number>; source: string }> {
  const refusals: string[] = [];
  for (const s of SOURCES) {
    try {
      const closes = await s.closes(pair, startMs);
      if (refusals.length) console.log(`quote_prices: ${pair} priced by ${s.name} after ${refusals.join("; ")}`);
      return { closes, source: s.name };
    } catch (e) {
      refusals.push(e instanceof Error ? e.message : String(e));
    }
  }
  throw new Error(`no source answered for ${pair}: ${refusals.join("; ")}`);
}

/** Fetch and upsert one asset's series. Returns days written; 0 when Binance has nothing for it. */
async function priceAsset(sql: Sql, a: QuoteAsset, pair: string, now: Date): Promise<number> {
  const { closes, source: exchange } = await dailyCloses(pair, seriesStartMs(a.last_day ? new Date(a.last_day) : null, now));
  if (!closes.size) return 0;
  const days = [...closes.keys()], vals = [...closes.values()];
  const source = `${exchange}:${pair}`;
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
 * One pass over both phases within `budgetMs`. Throws when a SOURCE (the exchanges, DexScreener, the
 * value_usd pass) was asked and every call to it failed, so the cron shows as failed rather than quietly pricing nothing.
 */
export async function runQuotePrices(env: Env, budgetMs: number): Promise<QuotePricesSummary> {
  const started = Date.now();
  const left = (): number => budgetMs - (Date.now() - started);
  const sql = jobSql(env);
  try {
    const now = new Date(started);
    let coinsPriced = 0, failedBatches = 0, done = 0, stoppedEarly = false;
    const exchanges = { asked: 0, failed: 0 }, dexscreener = { asked: 0, failed: 0 };
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
      exchanges.asked += 1;
      try {
        const days = await priceAsset(sql, a, pair, now);
        if (days === 0) console.warn(`quote_prices: ${a.symbol} skipped, binance returned nothing`);
      } catch (e) { exchanges.failed += 1; fail(`${a.symbol} closes`, e); }
    }

    /* Phase 1b: value_usd for quote-asset legs, a rowid slice at a time from where the last run stopped. */
    const legs = await priceLegsFrom(sql, UPDATE_BATCH, MAX_UPDATE_BATCHES, new Date(started - CLOSE_WAIT_MS).toISOString(),
      () => left() <= 0, (after, upTo, e) => fail(`value_usd rowids ${after}-${upTo}`, e));
    stoppedEarly ||= legs.stoppedEarly;

    /* Phase 2: today's DexScreener price per unpriced held Robinhood token. */
    const tokens = await robinhoodTargets(sql);
    const day = now.toISOString().slice(0, 10);
    for (let i = 0; i < tokens.length; i += ADDRESSES_PER_CALL) {
      if (left() <= 0) { stoppedEarly = true; break; }
      const chunk = tokens.slice(i, i + ADDRESSES_PER_CALL);
      dexscreener.asked += 1;
      try {
        coinsPriced += await priceRobinhoodBatch(sql, chunk, day);
      } catch (e) { dexscreener.failed += 1; fail(`robinhood batch of ${chunk.length}`, e); }
      done += chunk.length;
    }

    const dead = deadSources({ exchanges, dexscreener, "the value_usd pass": legs });
    if (dead.length) throw new Error(`quote_prices: every call to ${dead.join(" and ")} failed (${legs.priced} transfers priced)`);
    return {
      transfersPriced: legs.priced, coinsPriced, batches: exchanges.asked + dexscreener.asked, failedBatches,
      remaining: assets.length + tokens.length - done,
      stoppedEarly, elapsedMs: Date.now() - started,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
