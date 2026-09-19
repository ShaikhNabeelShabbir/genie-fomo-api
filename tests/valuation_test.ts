import { assertEquals } from "jsr:@std/assert@1";
import { DatabaseSync } from "node:sqlite";
import { d1sql, type D1Like, type D1Statement } from "../worker/src/d1.ts";
import { buildAumHistory, latestLiquidity, refreshAumLive, refreshAumLiveUnmoved, valueGroup } from "../worker/src/jobs/valuation.ts";
import { oldestUsableDay } from "../supabase/functions/api/shared/price-ladder.ts";

/* The port of aum_history_build / aum_live_refresh (migration 20260918100000). The schema is
   the real worker/d1/migrations/*.sql, run in SQLite, so the SQL is proved, not mocked. */

const HOUR = 3_600_000;
const hourIso = (ms: number): string => new Date(Math.floor(ms / HOUR) * HOUR).toISOString();
const CURRENT_HOUR = hourIso(Date.now());
const ago = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString();

/** `trips.count` is the round trips to D1: one per statement issued alone, one per `db.batch`. */
async function open(): Promise<{ sql: ReturnType<typeof d1sql>; db: DatabaseSync; trips: { count: number } }> {
  const trips = { count: 0 };
  let batching = false;
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
  for (const f of ["0001_schema.sql", "0002_views.sql"]) {
    db.exec(await Deno.readTextFile(new URL(`../worker/d1/migrations/${f}`, import.meta.url)));
  }
  const like: D1Like = {
    prepare(text: string): D1Statement {
      const write = /^\s*(insert|update|delete|replace)/i.test(text) && !/returning/i.test(text);
      const make = (params: unknown[]): D1Statement => ({
        bind: (...values: unknown[]) => make(values),
        all: () => {
          if (!batching) trips.count += 1;
          const st = db.prepare(text);
          const p = params as (string | number | bigint | null | Uint8Array)[];
          if (write) return Promise.resolve({ results: [], meta: { changes: Number(st.run(...p).changes) } });
          return Promise.resolve({ results: st.all(...p) as unknown[], meta: {} });
        },
      });
      return make([]);
    },
    async batch(stmts: D1Statement[]) {
      trips.count += 1;
      batching = true;
      const out = [];
      try {
        for (const s of stmts) out.push(await s.all());
      } finally {
        batching = false;
      }
      return out;
    },
  };
  return { sql: d1sql(like), db, trips };
}

const run = (db: DatabaseSync, text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);

function trader(db: DatabaseSync, handle: string): void {
  run(db, "insert into traders (handle, display_handle, id) values (?,?,?)", handle, handle, `id-${handle}`);
  run(db, "insert into wallets (handle, evm_address) values (?,?)", handle, `0xW${handle}`);
}

/** A known total_supply is the norm; without one every position trips the concentration rule. */
function token(db: DatabaseSync, net: number, key: string, supply: number | null = 1_000_000): void {
  run(db, "insert into tokens (network_id, address, token_key, total_supply) values (?,?,?,?)", net, key, key, supply);
}

const capture = (db: DatabaseSync, handle: string, net: number, key: string, at: string, amount: number): void =>
  run(db, "insert into holdings (handle, network_id, token_key, captured_at, human_amount, source) values (?,?,?,?,?,'chain')",
    handle, net, key, at, amount);

const history = (db: DatabaseSync, handle: string): Record<string, unknown>[] =>
  db.prepare("select hour, total_usd, suspect_usd, unsellable_usd, priced_positions, total_positions, basis, reason from aum_history where handle = ? order by hour").all(handle) as Record<string, unknown>[];

// ------------------------------------------------------------------ pure rules

Deno.test("valueGroup: no positions is no_holdings, nothing valued", () => {
  assertEquals(valueGroup([]), {
    totalUsd: null, suspectUsd: null, unsellableUsd: null, pricedPositions: 0, totalPositions: 0, reason: "no_holdings",
  });
});

Deno.test("valueGroup: unpriced positions alone are no_prices", () => {
  const v = valueGroup([{ amount: 5, price: null, supply: null, liquidityUsd: null, unsellable: false }]);
  assertEquals([v.totalUsd, v.pricedPositions, v.totalPositions, v.reason], [null, 0, 1, "no_prices"]);
});

Deno.test("valueGroup: an honeypot's worth lands in unsellable_usd, never in the total", () => {
  const v = valueGroup([
    { amount: 10, price: 2, supply: 1e6, liquidityUsd: 1e9, unsellable: true },
    { amount: 10, price: 3, supply: 1e6, liquidityUsd: 1e9, unsellable: false },
  ]);
  assertEquals([v.totalUsd, v.unsellableUsd, v.suspectUsd, v.pricedPositions], [30, 20, null, 1]);
});

Deno.test("valueGroup: a price whose implied cap is absurd is suspect, and alone it is price_suspect", () => {
  const v = valueGroup([{ amount: 1, price: 1000, supply: 1e9, liquidityUsd: 1e12, unsellable: false }]);
  assertEquals([v.totalUsd, v.suspectUsd, v.pricedPositions, v.reason], [null, 1000, 0, "price_suspect"]);
});

Deno.test("valueGroup: no pool behind a big position is suspect (V1d), the rest still totals", () => {
  const v = valueGroup([
    { amount: 1000, price: 5000, supply: 1e6, liquidityUsd: null, unsellable: false },
    { amount: 4, price: 5, supply: 1e6, liquidityUsd: 1e9, unsellable: false },
  ]);
  assertEquals([v.totalUsd, v.suspectUsd, v.pricedPositions, v.reason], [20, 5e6, 1, null]);
});

Deno.test("valueGroup: a few cheap priced rows among many unpriced ones is too_little_priced", () => {
  const rows: Parameters<typeof valueGroup>[0][number][] = [{ amount: 1, price: 3, supply: 1e6, liquidityUsd: 1e6, unsellable: false }];
  for (let i = 0; i < 9; i++) rows.push({ amount: 1, price: null, supply: null, liquidityUsd: null, unsellable: false });
  const v = valueGroup(rows);
  assertEquals([v.totalUsd, v.pricedPositions, v.totalPositions, v.reason], [null, 1, 10, "too_little_priced"]);
});

Deno.test("valueGroup: total_usd is stored unrounded", () => {
  const v = valueGroup([{ amount: 3, price: 0.1, supply: 1e6, liquidityUsd: 1e6, unsellable: false }]);
  assertEquals(v.totalUsd, 0.30000000000000004);
});

// ------------------------------------------------------------------ buildAumHistory

Deno.test("buildAumHistory: one row per hour, bucketed to the hour start", async () => {
  const { sql, db } = await open();
  trader(db, "a");
  const rows = await buildAumHistory(sql, "a", "2026-09-10T03:20:00.000Z", "2026-09-10T05:59:00.000Z");
  assertEquals(rows, 3);
  assertEquals(history(db, "a").map((r) => r.hour), [
    "2026-09-10T03:00:00.000Z", "2026-09-10T04:00:00.000Z", "2026-09-10T05:00:00.000Z",
  ]);
  assertEquals(history(db, "a").map((r) => [r.basis, r.reason]), [["priced", "no_holdings"], ["priced", "no_holdings"], ["priced", "no_holdings"]]);
});

Deno.test("buildAumHistory: a reading inside the hour wins, sampled over rebuilt; other hours are priced", async () => {
  const { sql, db } = await open();
  trader(db, "a");
  token(db, 1, "0xaa");
  capture(db, "a", 1, "0xaa", "2026-09-10T03:10:00.000Z", 10);
  run(db, "insert into token_prices (network_id, token_key, day, usd, source) values (1,'0xaa','2026-09-10',2,'t')");
  for (const [at, basis, total] of [
    ["2026-09-10T03:05:00.000Z", "rebuilt", 900],
    ["2026-09-10T03:40:00.000Z", "sampled", 111],
  ] as const) {
    run(db, "insert into aum_samples (handle, at, total_usd, priced_positions, total_positions, basis, tier) values ('a',?,?,3,4,?,'verified')", at, total, basis);
  }
  await buildAumHistory(sql, "a", "2026-09-10T03:00:00.000Z", "2026-09-10T04:00:00.000Z");
  assertEquals(history(db, "a").map((r) => [r.basis, r.total_usd, r.priced_positions, r.total_positions]), [
    ["reading", 111, 3, 4],
    ["priced", 20, 1, 1],
  ]);
});

Deno.test("buildAumHistory: the latest chain capture before the hour ends is the one valued", async () => {
  const { sql, db } = await open();
  trader(db, "a");
  token(db, 1, "0xaa");
  capture(db, "a", 1, "0xaa", "2026-09-10T03:10:00.000Z", 10);
  capture(db, "a", 1, "0xaa", "2026-09-10T04:50:00.000Z", 70);
  run(db, "insert into token_prices (network_id, token_key, day, usd, source) values (1,'0xaa','2026-09-10',1,'t')");
  await buildAumHistory(sql, "a", "2026-09-10T02:00:00.000Z", "2026-09-10T05:00:00.000Z");
  assertEquals(history(db, "a").map((r) => [r.hour, r.total_usd]), [
    ["2026-09-10T02:00:00.000Z", null],
    ["2026-09-10T03:00:00.000Z", 10],
    ["2026-09-10T04:00:00.000Z", 70],
    ["2026-09-10T05:00:00.000Z", 70],
  ]);
  assertEquals(history(db, "a")[0].reason, "no_holdings");
});

Deno.test("buildAumHistory: ladder is peg, then hourly within 24 h, then that day's close", async () => {
  const { sql, db } = await open();
  trader(db, "a");
  for (const k of ["0xpeg", "0xhour", "0xday", "0xstale"]) token(db, 1, k);
  run(db, "insert into quote_assets (network_id, token_key, symbol, pegged_usd) values (1,'0xpeg','P',1)");
  // A peg wins even with an hourly sample and a daily close sitting beside it.
  run(db, "insert into token_price_hourly (network_id, token_key, hour, usd, source) values (1,'0xpeg','2026-09-10T03:00:00.000Z',99,'t')");
  run(db, "insert into token_price_hourly (network_id, token_key, hour, usd, source) values (1,'0xhour','2026-09-10T02:00:00.000Z',7,'t')");
  run(db, "insert into token_prices (network_id, token_key, day, usd, source) values (1,'0xhour','2026-09-10',3,'t')");
  run(db, "insert into token_prices (network_id, token_key, day, usd, source) values (1,'0xday','2026-09-10',5,'t')");
  // 25 h before the hour: too stale for rung 2, and no daily close, so the row stays unpriced.
  run(db, "insert into token_price_hourly (network_id, token_key, hour, usd, source) values (1,'0xstale','2026-09-09T02:00:00.000Z',50,'t')");
  for (const k of ["0xpeg", "0xhour", "0xday", "0xstale"]) capture(db, "a", 1, k, "2026-09-10T02:30:00.000Z", 1);
  await buildAumHistory(sql, "a", "2026-09-10T03:00:00.000Z", "2026-09-10T03:00:00.000Z");
  // 1 (peg) + 7 (hourly) + 5 (daily) = 13, and 0xstale unpriced.
  assertEquals(history(db, "a").map((r) => [r.total_usd, r.priced_positions, r.total_positions]), [[13, 3, 4]]);
});

Deno.test("buildAumHistory: token_info prices NO hour, not even the current one (V1d)", async () => {
  /*
   * This test asserted the opposite until 17 Sep 2026, and the behaviour it locked in was the
   * bug: `token_info.price_usd` is GMGN's CURRENT price with no time attached, so pricing the
   * current hour with it made an hour's value depend on when it was built. Both hours below
   * hold the same coin and neither has a dated price, so neither may be valued.
   */
  const { sql, db } = await open();
  trader(db, "a");
  token(db, 1, "0xaa");
  run(db, "insert into token_info (network_id, token_key, price_usd) values (1,'0xaa',4)");
  capture(db, "a", 1, "0xaa", new Date(Date.now() - 2 * HOUR).toISOString(), 3);
  await buildAumHistory(sql, "a", hourIso(Date.now() - HOUR), CURRENT_HOUR);
  assertEquals(history(db, "a").map((r) => [r.total_usd, r.reason]), [[null, "no_prices"], [null, "no_prices"]]);
});

Deno.test("buildAumHistory: honeypot and suspect value sit beside the total, never in it", async () => {
  const { sql, db } = await open();
  trader(db, "a");
  token(db, 1, "0xgood");
  token(db, 1, "0xtrap");
  token(db, 1, "0xabsurd", 1e9);
  run(db, "insert into token_info (network_id, token_key, is_honeypot, liquidity_usd) values (1,'0xtrap',1,1000000000)");
  run(db, "insert into token_info (network_id, token_key, liquidity_usd) values (1,'0xgood',1000000000)");
  run(db, "insert into token_info (network_id, token_key, liquidity_usd) values (1,'0xabsurd',1000000000000)");
  for (const [k, usd] of [["0xgood", 2], ["0xtrap", 3], ["0xabsurd", 1000]] as const) {
    run(db, "insert into token_prices (network_id, token_key, day, usd, source) values (1,?,'2026-09-10',?,'t')", k, usd);
    capture(db, "a", 1, k, "2026-09-10T02:30:00.000Z", 1);
  }
  await buildAumHistory(sql, "a", "2026-09-10T03:00:00.000Z", "2026-09-10T03:00:00.000Z");
  assertEquals(history(db, "a").map((r) => [r.total_usd, r.suspect_usd, r.unsellable_usd, r.priced_positions, r.total_positions]),
    [[2, 1000, 3, 1, 3]]);
});

Deno.test("buildAumHistory: nothing but suspect value reads price_suspect, and the row is rewritten in place", async () => {
  const { sql, db } = await open();
  trader(db, "a");
  token(db, 1, "0xabsurd", 1e9);
  run(db, "insert into token_prices (network_id, token_key, day, usd, source) values (1,'0xabsurd','2026-09-10',1000,'t')");
  capture(db, "a", 1, "0xabsurd", "2026-09-10T02:30:00.000Z", 1);
  await buildAumHistory(sql, "a", "2026-09-10T03:00:00.000Z", "2026-09-10T03:00:00.000Z");
  await buildAumHistory(sql, "a", "2026-09-10T03:00:00.000Z", "2026-09-10T03:00:00.000Z");
  assertEquals(history(db, "a").map((r) => [r.reason, r.suspect_usd]), [["price_suspect", 1000]]);
});

// ------------------------------------------------------------------ refreshAumLive

Deno.test("refreshAumLive: upserts aum_live with the live ladder, and writes NO hour of aum_history", async () => {
  const { sql, db } = await open();
  trader(db, "a");
  trader(db, "b");
  token(db, 1, "0xstats");
  token(db, 1, "0xday");
  run(db, "insert into token_price_stats (network_id, token_key, ath_usd, ath_at, last_usd, last_at, drawdown_share) values (1,'0xstats',9,'2026-09-10T00:00:00.000Z',6,?,0)", ago(1));
  run(db, "insert into token_prices (network_id, token_key, day, usd, source) values (1,'0xstats',?,99,'t')", CURRENT_HOUR.slice(0, 10));
  run(db, "insert into token_prices (network_id, token_key, day, usd, source) values (1,'0xday',?,4,'t')", CURRENT_HOUR.slice(0, 10));
  capture(db, "a", 1, "0xstats", "2026-09-10T02:30:00.000Z", 2);
  capture(db, "a", 1, "0xday", "2026-09-10T02:30:00.000Z", 3);
  const n = await refreshAumLive(sql, ["a", "b"], "webhook");
  assertEquals(n, 2);
  assertEquals(db.prepare("select handle, total_usd, priced_positions, reason, source from aum_live order by handle").all(), [
    { handle: "a", total_usd: 24, priced_positions: 2, reason: null, source: "webhook" },
    { handle: "b", total_usd: null, priced_positions: 0, reason: "no_holdings", source: "webhook" },
  ]);
  /* cron CRON-04: the live ladder ends on GMGN's price; an hour of history is the builder's alone (V1d). */
  assertEquals(history(db, "a"), []);
});

Deno.test("refreshAumLive: a price past its rung's age prices nothing, and the aged token_info row still flags", async () => {
  /* claims F5: 50-hour-old stats and a 9-day-old GMGN price were summed into aum_live as 2 of 2 priced. */
  const { sql, db } = await open();
  trader(db, "a");
  for (const k of ["0xoldstats", "0xoldinfo", "0xclose", "0xfresh", "0xtrap", "0xweek", "0xpastweek"]) {
    token(db, 1, k);
    capture(db, "a", 1, k, "2026-09-10T02:30:00.000Z", 1);
  }
  const stats = (k: string, usd: number, hoursAgo: number): void =>
    run(db, "insert into token_price_stats (network_id, token_key, ath_usd, ath_at, last_usd, last_at, drawdown_share) values (1,?,9,?,?,?,0)", k, ago(hoursAgo), usd, ago(hoursAgo));
  const info = (k: string, usd: number, hoursAgo: number, honeypot: number): void =>
    run(db, "insert into token_info (network_id, token_key, price_usd, total_supply, is_honeypot, fetched_at) values (1,?,?,1e6,?,?)", k, usd, honeypot, ago(hoursAgo));
  stats("0xoldstats", 500, 50);
  info("0xoldinfo", 200, 9 * 24, 0);
  stats("0xclose", 500, 50); // aged out, so the rung below it prices the coin
  run(db, "insert into token_prices (network_id, token_key, day, usd, source) values (1,'0xclose',?,3,'t')", CURRENT_HOUR.slice(0, 10));
  stats("0xfresh", 5, 23);
  info("0xtrap", 0, 9 * 24, 1); // the ROW must survive its price: it is what says unsellable
  stats("0xtrap", 7, 1);
  /* The daily rung is the ladder's own day: `day > now - 7` here left out a close /positions still priced. */
  const oldest = oldestUsableDay(new Date());
  const close = (k: string, day: string, usd: number): void =>
    run(db, "insert into token_prices (network_id, token_key, day, usd, source) values (1,?,?,?,'t')", k, day, usd);
  close("0xweek", oldest, 11);
  close("0xpastweek", new Date(Date.parse(oldest) - 24 * HOUR).toISOString().slice(0, 10), 13);

  await refreshAumLive(sql, ["a"], "webhook");
  assertEquals(db.prepare("select total_usd, unsellable_usd, priced_positions, total_positions, reason from aum_live").all(),
    [{ total_usd: 19, unsellable_usd: 7, priced_positions: 3, total_positions: 7, reason: null }]);
});

Deno.test("round trips: a chunk's independent reads go out as one batch (load F9)", async () => {
  /* D1 is one statement at a time and ~0.25 s a round trip: the builder was 11 a trader-hour, the flush 9. */
  const { sql, db, trips } = await open();
  trader(db, "a");
  for (const k of ["0xaa", "0xbb"]) {
    token(db, 1, k);
    capture(db, "a", 1, k, "2026-09-10T02:30:00.000Z", 1);
  }
  await buildAumHistory(sql, "a", "2026-09-10T03:00:00.000Z", "2026-09-10T03:00:00.000Z");
  assertEquals(trips.count, 5, "plan reads, holdings, facts, ladder, write");
  trips.count = 0;
  await refreshAumLive(sql, ["a"], "webhook");
  assertEquals(trips.count, 5, "targets, balances, facts, daily close, write");
});

Deno.test("latestLiquidity: the rows the window it replaced kept, by seek", async () => {
  /** loadFacts' liquidity statement until 19 Sep 2026, verbatim (its values as parameters). */
  const OLD = `
        select token_key, liquidity_usd from (
          select token_key, liquidity_usd, row_number() over (partition by token_key order by hour desc) as rn
            from token_price_hourly where network_id = ? and token_key in (?, ?, ?, ?)
        ) where rn = 1`;
  const { sql, db } = await open();
  const sample = (net: number, k: string, hour: string, liq: number | null): void =>
    run(db, "insert into token_price_hourly (network_id, token_key, hour, usd, liquidity_usd, source) values (?,?,?,1,?,'t')", net, k, hour, liq);
  sample(1, "0xa", "2026-09-10T01:00:00.000Z", 10);
  sample(1, "0xa", "2026-09-10T03:00:00.000Z", 30);
  sample(1, "0xa", "2026-09-10T02:00:00.000Z", 20);
  sample(1, "0xnull", "2026-09-10T01:00:00.000Z", 10);
  sample(1, "0xnull", "2026-09-10T02:00:00.000Z", null); // the NEWEST sample wins even when it holds no figure
  sample(8453, "0xa", "2026-09-10T09:00:00.000Z", 99);   // another chain's sample of the same key
  sample(1, "0xunasked", "2026-09-10T01:00:00.000Z", 1);
  const keys = ["0xa", "0xnull", "0xnone", "not-in-tokens"];
  const sorted = (rows: readonly Record<string, unknown>[]): unknown[][] =>
    rows.map((r) => [r.token_key, r.liquidity_usd]).sort();
  /* loadFacts reads a null figure exactly as it reads no row, so the figures are what must agree. */
  const figures = (rows: readonly Record<string, unknown>[]): unknown[][] => sorted(rows).filter(([, liq]) => liq !== null);
  const was = db.prepare(OLD).all(1, ...keys) as Record<string, unknown>[];
  const now = await latestLiquidity(sql, 1, keys);
  assertEquals(sorted(was), [["0xa", 30], ["0xnull", null]]);
  assertEquals(sorted(now), [["0xa", 30], ["0xnone", null], ["0xnull", null], ["not-in-tokens", null]]);
  assertEquals(figures(now), figures(was));
  const plan = (db.prepare(`explain query plan ${latestLiquidity(sql, 1, keys).text}`).all(1, "[]") as { detail: string }[]).map((r) => r.detail);
  assertEquals(plan.filter((d) => d.includes("token_price_hourly")).every((d) => d.startsWith("SEARCH p USING")), true, plan.join("\n"));
});

Deno.test("refreshAumLive: a null handle list means every trader with a wallet; olderThanHours skips fresh rows", async () => {
  const { sql, db } = await open();
  trader(db, "a");
  trader(db, "b");
  run(db, "insert into traders (handle, display_handle, id) values ('nowallet','nowallet','id-nw')");
  assertEquals(await refreshAumLive(sql, null, "build"), 2);
  run(db, "update aum_live set at = ? where handle = 'a'", new Date().toISOString());
  run(db, "update aum_live set at = ? where handle = 'b'", new Date(Date.now() - 5 * HOUR).toISOString());
  assertEquals(await refreshAumLive(sql, null, "build", 1), 1);
  assertEquals(db.prepare("select handle from aum_live where source = 'build' order by handle").all().length, 2);
});

Deno.test("buildAumHistory: V1d — an hour is valued the same whenever it is built", async () => {
  /*
   * The ladder used to end with GMGN's `token_info.price_usd` when the hour being built was
   * the hour we were in. That made the value depend on WHEN we computed it: on 17 Sep cupseyy's
   * 07:00 priced 5,082 positions and read $2.5B when built at 07:33, while 08:00-10:00 rebuilt
   * later priced 187 and read $1,686. Only timestamped rungs may price a past hour.
   */
  const { sql, db } = await open();
  trader(db, "a");
  token(db, 1, "0xaa");
  capture(db, "a", 1, "0xaa", "2026-09-10T03:10:00.000Z", 10);
  /* GMGN carries an absurd current price and no timestamp; nothing else prices this token. */
  run(db, "insert into token_info (network_id, token_key, price_usd, total_supply) values (1,'0xaa',28160,1e9)");

  const thisHour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
  await buildAumHistory(sql, "a", thisHour, thisHour);
  const [current] = history(db, "a");
  assertEquals([current.total_usd, current.priced_positions, current.reason],
    [null, 0, "no_prices"], "the CURRENT hour must not borrow an untimestamped price either");

  /* The same holdings with a dated close: priced, and priced identically whenever built. */
  run(db, "insert into token_prices (network_id, token_key, day, usd, source) values (1,'0xaa','2026-09-10',2,'t')");
  await buildAumHistory(sql, "a", "2026-09-10T03:00:00.000Z", "2026-09-10T03:00:00.000Z");
  const dated = history(db, "a").find((r) => r.hour === "2026-09-10T03:00:00.000Z");
  assertEquals([dated?.total_usd, dated?.priced_positions], [20, 1]);
});

// ------------------------------------------------------- refreshAumLiveUnmoved (A2)

const SOL = 1399811149;

/** A Solana wallet whose balance was read, then moved by a transfer the roll-forward picks up. */
function movedOnSolana(db: DatabaseSync, handle: string): void {
  run(db, "update wallets set sol_address = ? where handle = ?", `S${handle}`, handle);
  /* `sol_address_key` is a generated column; the transfer must carry whatever it derives. */
  const key = String((db.prepare("select sol_address_key k from wallets where handle = ?").get(handle) as { k: string }).k);
  run(db, "insert into tokens (network_id, address, token_key, total_supply) values (?,?,?,?)",
    SOL, "soltok", "soltok", 1_000_000);
  run(db, "insert into token_prices (network_id, token_key, day, usd, source) values (?,?,?,?,'t')",
    SOL, "soltok", CURRENT_HOUR.slice(0, 10), 2);
  run(db, "insert into holdings (handle, network_id, token_key, captured_at, human_amount, source) values (?,?,?,?,?,'chain')",
    handle, SOL, "soltok", "2026-09-10T02:30:00.000Z", 10);
  /* +5 tokens in, after the capture: holdings_live sees 15, holdings_current still 10. */
  run(db, `insert into transactions
             (network_id, tx_hash, address_key, transfer_key, block_time, direction, token_key, amount, source)
           values (?,?,?,?,?,'in',?,?,'t')`,
    SOL, "tx1", key, "k1", "2026-09-10T03:00:00.000Z", "soltok", 5);
}

Deno.test("refreshAumLiveUnmoved: values the balance as READ, where refreshAumLive rolls it forward", async () => {
  const { sql, db } = await open();
  trader(db, "a");
  movedOnSolana(db, "a");

  await refreshAumLive(sql, ["a"], "webhook");
  const rolled = db.prepare("select total_usd from aum_live where handle = 'a'").get();
  assertEquals(rolled?.total_usd, 30, "15 tokens x $2: the transfer after the read counts");

  await refreshAumLiveUnmoved(sql, ["a"], "build");
  const asRead = db.prepare("select total_usd from aum_live where handle = 'a'").get();
  assertEquals(asRead?.total_usd, 20, "10 tokens x $2: no roll-forward, which is the cheap path");
});

Deno.test("refreshAumLiveUnmoved: agrees with refreshAumLive when nothing moved", async () => {
  /*
   * The whole premise of A2's cheap path: for a trader nothing has marked as moved, the
   * roll-forward can only add zero, so the two must produce the identical figure.
   */
  const { sql, db } = await open();
  trader(db, "a");
  token(db, 1, "0xday");
  run(db, "insert into token_prices (network_id, token_key, day, usd, source) values (1,'0xday',?,4,'t')",
    CURRENT_HOUR.slice(0, 10));
  capture(db, "a", 1, "0xday", "2026-09-10T02:30:00.000Z", 3);

  await refreshAumLive(sql, ["a"], "webhook");
  const rolled = db.prepare("select total_usd, priced_positions from aum_live where handle = 'a'").get();
  await refreshAumLiveUnmoved(sql, ["a"], "build");
  const asRead = db.prepare("select total_usd, priced_positions from aum_live where handle = 'a'").get();
  assertEquals([asRead?.total_usd, asRead?.priced_positions], [rolled?.total_usd, rolled?.priced_positions]);
  assertEquals(asRead?.total_usd, 12);
});
