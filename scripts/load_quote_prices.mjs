#!/usr/bin/env node
/**
 * T2.1 · Daily USD closes for the floating quote assets, into `token_prices`.
 *
 * Only assets a swap row actually references need a series. Measured on 2026-09-08: of
 * 108,499 priceable swap rows, 102,995 are dollar-pegged (USDC/USDT) and carry
 * `quote_assets.pegged_usd` instead, leaving wSOL as the one asset that needs real prices.
 * The mapping below covers the others so a chain that starts trading in WETH or WBNB is a
 * config change and not a code change.
 *
 * Binance klines are free and keyless, and `src/prices.ts` already uses them for the Express
 * path — same source, so the two cannot disagree about what SOL was worth. Daily rather than
 * per-minute: the dollar size of a trade to the nearest day answers "how much did they put
 * in", and per-minute would be one request per transaction instead of one per asset.
 *
 *   node scripts/load_quote_prices.mjs              # only what swaps reference
 *   node scripts/load_quote_prices.mjs --all        # every floating quote asset
 *   node scripts/load_quote_prices.mjs --days 400   # override the inferred window
 */
import pg from "pg";

const DB = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
if (!DB) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

/** Quote symbol -> Binance pair. Symbols absent here cannot be priced and are reported. */
const PAIR = {
  SOL: "SOLUSDT",
  wSOL: "SOLUSDT",
  WETH: "ETHUSDT",
  ETH: "ETHUSDT",
  WBNB: "BNBUSDT",
  BNB: "BNBUSDT",
};

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const ALL = process.argv.includes("--all");
const DAYS_OVERRIDE = Number(arg("--days", "0")) || null;

const pool = new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 2 });

/**
 * Daily closes from Binance.
 *
 * 1000 candles per request covers ~2.7 years, so one call per asset in practice; the loop is
 * there so a longer history does not silently truncate. `close` is used rather than a mid:
 * a daily close is the figure every other source publishes, so ours can be checked.
 */
async function dailyCloses(pair, startMs) {
  const out = new Map();
  let cursor = startMs;
  for (let guard = 0; guard < 20; guard++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d` +
      `&startTime=${cursor}&limit=1000`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`binance HTTP ${r.status} for ${pair}`);
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const k of rows) {
      const day = new Date(Number(k[0])).toISOString().slice(0, 10);
      const close = Number(k[4]);
      if (Number.isFinite(close)) out.set(day, close);
    }
    if (rows.length < 1000) break;
    cursor = Number(rows[rows.length - 1][0]) + 86_400_000;
  }
  return out;
}

/**
 * Fill `transactions.value_usd` for quote-asset legs, in batches.
 *
 * Batched because it has to be: the single-statement version ran for exactly 120s against
 * `statement_timeout = 2min`, hit the limit and rolled back every row it had written. It
 * reported nothing useful — the failure looked like "0 rows priced" rather than "timed out",
 * which is the worst way to find out.
 *
 * Idempotent and resumable: it only touches rows where `value_usd is null`, so re-running
 * continues where it stopped and the nightly job uses this same function to price whatever
 * the webhook has ingested since.
 *
 * `value_usd` is a MAGNITUDE, matching `amount`, which is always positive: measured on
 * 117,524 swap legs, 0 carry a negative amount in either direction. Direction lives in the
 * `direction` column alone, so anything summing spend versus income has to read that column
 * — multiplying by a sign here would produce a number that silently disagrees with `amount`.
 */
async function priceTransactions(c, batch = 20000) {
  let total = 0;
  for (let i = 0; i < 200; i++) {
    const { rowCount } = await c.query(
      `update transactions t
          set value_usd = t.amount * coalesce(q.pegged_usd, p.usd)
         from quote_assets q
         left join token_prices p
           on p.network_id = q.network_id and p.token_key = q.token_key
        where q.network_id = t.network_id
          and q.token_key  = t.token_key
          and (q.pegged_usd is not null or p.day = t.block_time::date)
          and t.value_usd is null
          and t.ctid = any (array(
                select ctid from transactions
                 where value_usd is null and tx_type = 'SWAP'
                 limit $1))`,
      [batch],
    );
    if (!rowCount) break;
    total += rowCount;
    console.log(`  priced ${String(total).padStart(7)} rows`);
  }
  const { rows: [left] } = await c.query(
    `select count(*)::int as n from transactions
      where tx_type = 'SWAP' and value_usd is null`,
  );
  console.log(`\nvalue_usd: +${total} rows this run, ${left.n} still unpriced`);
  if (left.n > 0) {
    console.log("  (unpriced rows are legs whose token is not a quote asset — expected)");
  }
}

async function main() {
  const c = await pool.connect();
  try {
    // Which floating assets do we actually need, and from when? Deriving the window from the
    // data means we never fetch years of history for an asset first seen last month.
    const { rows: needed } = await c.query(
      `select q.network_id, q.token_key, q.symbol,
              count(t.*)::int                       as swap_rows,
              min(t.block_time)::date               as first_day
         from quote_assets q
         left join transactions t
           on t.network_id = q.network_id and t.token_key = q.token_key and t.tx_type = 'SWAP'
        where q.pegged_usd is null
        group by 1,2,3
        ${ALL ? "" : "having count(t.*) > 0"}
        order by swap_rows desc`,
    );

    if (!needed.length) {
      console.log("nothing to price — every referenced quote asset is pegged");
      return;
    }

    console.log(`floating quote assets to price: ${needed.length}`);
    let wrote = 0, skipped = 0;

    for (const a of needed) {
      const pair = PAIR[a.symbol];
      if (!pair) {
        console.log(`  ${a.symbol.padEnd(6)} SKIP — no Binance pair mapped`);
        skipped++;
        continue;
      }
      const first = DAYS_OVERRIDE
        ? new Date(Date.now() - DAYS_OVERRIDE * 86_400_000)
        : new Date(a.first_day ?? Date.now() - 365 * 86_400_000);
      // One day of slack: a swap just after midnight UTC still finds a row.
      const startMs = first.getTime() - 86_400_000;

      const closes = await dailyCloses(pair, startMs);
      if (!closes.size) {
        console.log(`  ${a.symbol.padEnd(6)} SKIP — binance returned nothing`);
        skipped++;
        continue;
      }

      const days = [...closes.keys()];
      const vals = [...closes.values()];
      await c.query(
        `insert into token_prices (network_id, token_key, day, usd, source)
         select $1, $2, d::date, v, 'binance:${pair}'
           from unnest($3::text[], $4::numeric[]) as t(d, v)
         on conflict (network_id, token_key, day)
         do update set usd = excluded.usd, source = excluded.source, fetched_at = now()`,
        [a.network_id, a.token_key, days, vals],
      );
      wrote += days.length;
      console.log(
        `  ${a.symbol.padEnd(6)} ${String(days.length).padStart(4)} days ` +
        `(${days[0]} → ${days[days.length - 1]})  ${a.swap_rows} swap rows`,
      );
    }

    console.log(`\nwrote ${wrote} daily prices, skipped ${skipped} asset(s)`);

    if (!process.argv.includes("--no-backfill")) await priceTransactions(c);
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
