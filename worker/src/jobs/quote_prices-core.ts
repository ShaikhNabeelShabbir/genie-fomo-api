/**
 * Pure half of the quote-price loader (`jobs/quote_prices.ts`): the Binance pair map and the
 * klines parse, twins of `scripts/load_quote_prices.mjs`, and the job's statements, which take
 * `sql` so tests/quote_prices_test.ts and tests/quote_prices_sql_test.ts can run them.
 */
import type { Sql } from "../d1.ts";
import { currentHoldings } from "../../../supabase/functions/_shared/current_holdings.ts";

export const DAY_MS = 86_400_000;
/** Binance returns at most this many candles a call; ~2.7 years of days. */
export const KLINES_LIMIT = 1000;

/** Quote symbol -> exchange pair. Binance and Bybit spell these the same, so one map serves both.
 *  Symbols absent here cannot be priced and are reported. */
export const PAIR: Readonly<Record<string, string>> = {
  SOL: "SOLUSDT",
  wSOL: "SOLUSDT",
  WETH: "ETHUSDT",
  ETH: "ETHUSDT",
  WBNB: "BNBUSDT",
  BNB: "BNBUSDT",
};

/**
 * Bybit wraps its candles in `result.list`; each row is
 * `[startMs, open, high, low, close, volume, turnover]`, so index 0 and index 4 mean exactly what
 * they mean in a Binance kline and `parseKlines` reads it unchanged. Anything else is an empty page.
 */
export function bybitList(body: unknown): unknown[] {
  const result = typeof body === "object" && body !== null ? (body as { result?: unknown }).result : undefined;
  const list = typeof result === "object" && result !== null ? (result as { list?: unknown }).list : undefined;
  return Array.isArray(list) ? list : [];
}

/** Kraken's USD pair for each exchange pair above. It answers from the US, where Binance and (since 19 Sep 2026) Bybit refuse this Worker's egress with 403. USD, not USDT: within a few basis points on a daily close. */
export const KRAKEN_PAIR: Readonly<Record<string, string>> = { SOLUSDT: "SOLUSD", ETHUSDT: "ETHUSD", BNBUSDT: "BNBUSD" };

/**
 * Kraken keys `result` by ITS OWN name for the pair (ETHUSD comes back as XETHZUSD) beside a `last`
 * cursor, and stamps candles in SECONDS. Rows are otherwise kline-shaped (close at index 4), so the
 * open time is scaled to milliseconds and `parseKlines` reads the rest unchanged.
 */
export function krakenList(body: unknown): unknown[] {
  const result = typeof body === "object" && body !== null ? (body as { result?: unknown }).result : undefined;
  if (typeof result !== "object" || result === null) return [];
  const rows = Object.entries(result).find(([k, v]) => k !== "last" && Array.isArray(v))?.[1];
  return Array.isArray(rows) ? rows.map((r: unknown) => (Array.isArray(r) ? [Number(r[0]) * 1000, ...r.slice(1)] : r)) : [];
}

export interface Closes {
  /** UTC day -> close, in candle order. */
  readonly byDay: ReadonlyMap<string, number>;
  /** Open time of the last candle, or null when the page was empty. */
  readonly lastOpenMs: number | null;
  readonly count: number;
}

/**
 * Daily closes out of one klines page. `close` (index 4) rather than a mid: a daily close is
 * the figure every other source publishes, so ours can be checked. Malformed rows are skipped.
 */
export function parseKlines(body: unknown): Closes {
  const byDay = new Map<string, number>();
  let lastOpenMs: number | null = null, count = 0;
  for (const k of Array.isArray(body) ? body : []) {
    if (!Array.isArray(k)) continue;
    count += 1;
    const open = Number(k[0]), close = Number(k[4]);
    if (!Number.isFinite(open)) continue;
    lastOpenMs = open;
    if (Number.isFinite(close)) byDay.set(new Date(open).toISOString().slice(0, 10), close);
  }
  return { byDay, lastOpenMs, count };
}

/** Where a fetch starts: the newest day already stored (a year back when none is), minus one day so yesterday's close is rewritten once it is final. */
export function seriesStartMs(lastDay: Date | null, now: Date): number {
  const from = lastDay ?? new Date(now.getTime() - 365 * DAY_MS);
  return from.getTime() - DAY_MS;
}

export interface Tally { readonly asked: number; readonly failed: number }

/** Sources that were asked and never answered. Each is judged alone: summed, one healthy source hid a dead one and the cron stayed green. */
export const deadSources = (tally: Readonly<Record<string, Tally>>): string[] =>
  Object.entries(tally).filter(([, t]) => t.asked > 0 && t.failed === t.asked).map(([name]) => name);

export interface QuoteAsset { readonly network_id: number; readonly token_key: string; readonly symbol: string; readonly last_day: string | null }

/**
 * Every floating quote asset with a pair (X2: EVM rows carry no `tx_type`, so a swap count could
 * never admit WBNB/WETH), and the newest day already stored for it: one seek on token_prices' key.
 * It used to select a null first day, so every hour re-fetched and rewrote a year of closes per asset.
 */
export const quoteAssets = (sql: Sql) => sql<QuoteAsset[]>`
  select q.network_id, q.token_key, q.symbol,
         (select max(p.day) from token_prices p
           where p.network_id = q.network_id and p.token_key = q.token_key) as last_day
    from quote_assets q
   where q.pegged_usd is null and q.symbol in (${Object.keys(PAIR)})
   order by q.network_id, q.symbol`;

/** The `job_cursors` row of the value_usd pass: the last `transactions.rowid` it has been over. */
const LEGS_CURSOR = "quote_prices.value_usd";

export const legsCursor = async (sql: Sql): Promise<number> =>
  (await sql<{ position: number }[]>`select position from job_cursors where job = ${LEGS_CURSOR}`)[0]?.position ?? 0;

export const saveLegsCursor = (sql: Sql, position: number) => sql`
  insert into job_cursors (job, position, updated_at) values (${LEGS_CURSOR}, ${position}, ${new Date().toISOString()})
  on conflict (job) do update set position = excluded.position, updated_at = excluded.updated_at`;

export const newestRowid = async (sql: Sql): Promise<number> =>
  (await sql<{ hi: number | null }[]>`select max(rowid) as hi from transactions`)[0]?.hi ?? 0;

/** The `(after, upTo]` rowid slices one run walks from `cursor` to `newest`: `size` rowids each, at most `max` of them. */
export const legSlices = (cursor: number, newest: number, size: number, max: number): (readonly [number, number])[] =>
  Array.from({ length: Math.min(max, Math.max(0, Math.ceil((newest - cursor) / size))) }, (_, i) =>
    [cursor + i * size, Math.min(cursor + (i + 1) * size, newest)] as const);

/**
 * `transactions.value_usd` for the quote-asset SWAP legs with `after < rowid <= upTo`. Idempotent:
 * only rows where `value_usd is null`. `value_usd` is a MAGNITUDE like `amount`; direction lives
 * in the `direction` column alone. Returns rows updated.
 *
 * It used to pick "the first 5,000 unpriced SWAP legs", which the memecoin side of every swap
 * fills for good: 0 rows an hour since the D1 cut-over. A rowid range is a seek on
 * transactions_type_idx (tx_type, rowid) and passes an unpriceable leg once.
 */
export const priceLegs = async (sql: Sql, after: number, upTo: number): Promise<number> => {
  // The Postgres update-from-join became one scalar subquery per rung (peg, then that day's close)
  // with an exists guard, so a row nothing can price is left untouched and does not count as written.
  const res = await sql`
    update transactions
       set value_usd = amount * coalesce(
             (select q.pegged_usd from quote_assets q
               where q.network_id = transactions.network_id and q.token_key = transactions.token_key),
             (select p.usd from token_prices p
               where p.network_id = transactions.network_id and p.token_key = transactions.token_key
                 and p.day = substr(transactions.block_time, 1, 10)))
     where tx_type = 'SWAP' and rowid > ${after} and rowid <= ${upTo}
       and value_usd is null
       and exists (select 1 from quote_assets q
                    where q.network_id = transactions.network_id and q.token_key = transactions.token_key
                      and (q.pegged_usd is not null
                           or exists (select 1 from token_prices p
                                       where p.network_id = q.network_id and p.token_key = q.token_key
                                         and p.day = substr(transactions.block_time, 1, 10))))`;
  return res.count;
};

/**
 * The lowest rowid in the slice of a floating quote leg left unpriced although it moved after
 * `since`: its day's close may still arrive, so the cursor must stop before it. Null when none
 * waits. An older leg with no close (history behind the stored series) is passed for good.
 */
export const firstWaitingLeg = async (sql: Sql, after: number, upTo: number, since: string): Promise<number | null> =>
  (await sql<{ rid: number | null }[]>`
    select min(t.rowid) as rid
      from transactions t
     where t.tx_type = 'SWAP' and t.rowid > ${after} and t.rowid <= ${upTo}
       and t.value_usd is null and t.block_time > ${since}
       and exists (select 1 from quote_assets q
                    where q.network_id = t.network_id and q.token_key = t.token_key and q.pegged_usd is null)`)[0]?.rid ?? null;

export interface LegsPass extends Tally { readonly priced: number; readonly stoppedEarly: boolean }

/**
 * The value_usd pass: every slice from the stored place to the newest rowid is priced, and the
 * place moves up to the first recent leg still waiting for its close (slices past it are priced,
 * the place stays). A slice that throws ends the pass with the place before it, and counts as
 * `failed` so `deadSources` turns a pass that cannot start red. A place PAST the newest rowid means
 * the table was rebuilt (rowids do not survive a re-import): the walk restarts, which is idempotent,
 * where it used to pass nothing for ever.
 */
export async function priceLegsFrom(
  sql: Sql, size: number, max: number, since: string, outOfTime: () => boolean,
  onFailure: (after: number, upTo: number, e: unknown) => void,
): Promise<LegsPass> {
  const newest = await newestRowid(sql), place = await legsCursor(sql);
  let priced = 0, asked = 0, failed = 0, stoppedEarly = false, keepPlace = true;
  for (const [after, upTo] of legSlices(place > newest ? 0 : place, newest, size, max)) {
    if (outOfTime()) { stoppedEarly = true; break; }
    asked += 1;
    try {
      priced += await priceLegs(sql, after, upTo);
      if (!keepPlace) continue;
      // A recent leg whose day has no close YET is offered again: the place is kept only up to the first one.
      const waiting = await firstWaitingLeg(sql, after, upTo, since);
      await saveLegsCursor(sql, waiting === null ? upTo : waiting - 1);
      keepPlace = waiting === null;
    } catch (e) { failed += 1; onFailure(after, upTo, e); break; }
  }
  return { priced, asked, failed, stoppedEarly };
}

export interface RobinhoodToken { readonly token_key: string; readonly address: string }

/**
 * Held tokens of one chain (Robinhood) that are not a quote asset and that GMGN (`token_info`)
 * carries no price for. The chain filter reaches inside the source, so only that chain's pairs are asked.
 */
export const robinhoodTargets = (sql: Sql, net: number) => sql<RobinhoodToken[]>`
  select distinct h.token_key, tk.address
    from ${currentHoldings(sql)} h
    -- cross join states the order: the small derived table tempts the planner to read the chain's tokens whole instead.
    cross join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    left join token_info ti on ti.network_id = h.network_id and ti.token_key = h.token_key
   where h.network_id = ${net} and q.token_key is null and ti.price_usd is null
   order by h.token_key`;
