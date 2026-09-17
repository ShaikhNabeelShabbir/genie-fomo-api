import { assertEquals } from "jsr:@std/assert@1";
import { DatabaseSync } from "node:sqlite";
import { d1sql, type D1Like, type D1Statement } from "../worker/src/d1.ts";
import { buildAumHistory, refreshAumLive, valueGroup } from "../worker/src/jobs/valuation.ts";

/* The port of aum_history_build / aum_live_refresh (migration 20260918100000). The schema is
   the real worker/d1/migrations/*.sql, run in SQLite, so the SQL is proved, not mocked. */

const HOUR = 3_600_000;
const hourIso = (ms: number): string => new Date(Math.floor(ms / HOUR) * HOUR).toISOString();
const CURRENT_HOUR = hourIso(Date.now());

async function open(): Promise<{ sql: ReturnType<typeof d1sql>; db: DatabaseSync }> {
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
          const st = db.prepare(text);
          const p = params as (string | number | bigint | null | Uint8Array)[];
          if (write) return Promise.resolve({ results: [], meta: { changes: Number(st.run(...p).changes) } });
          return Promise.resolve({ results: st.all(...p) as unknown[], meta: {} });
        },
      });
      return make([]);
    },
    async batch(stmts: D1Statement[]) {
      const out = [];
      for (const s of stmts) out.push(await s.all());
      return out;
    },
  };
  return { sql: d1sql(like), db };
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

Deno.test("buildAumHistory: token_info prices the current hour only", async () => {
  const { sql, db } = await open();
  trader(db, "a");
  token(db, 1, "0xaa");
  run(db, "insert into token_info (network_id, token_key, price_usd) values (1,'0xaa',4)");
  capture(db, "a", 1, "0xaa", new Date(Date.now() - 2 * HOUR).toISOString(), 3);
  await buildAumHistory(sql, "a", hourIso(Date.now() - HOUR), CURRENT_HOUR);
  assertEquals(history(db, "a").map((r) => [r.total_usd, r.reason]), [[null, "no_prices"], [12, null]]);
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

Deno.test("refreshAumLive: upserts aum_live and the current hour of aum_history, with the live ladder", async () => {
  const { sql, db } = await open();
  trader(db, "a");
  trader(db, "b");
  token(db, 1, "0xstats");
  token(db, 1, "0xday");
  run(db, "insert into token_price_stats (network_id, token_key, ath_usd, ath_at, last_usd, last_at, drawdown_share) values (1,'0xstats',9,'2026-09-10T00:00:00.000Z',6,'2026-09-10T00:00:00.000Z',0)");
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
  assertEquals(history(db, "a").map((r) => [r.hour, r.basis, r.total_usd]), [[CURRENT_HOUR, "priced", 24]]);
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
