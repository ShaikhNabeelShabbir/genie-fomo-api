import { assertEquals } from "jsr:@std/assert@1";
import type { DatabaseSync } from "node:sqlite";
import { openSchema } from "./_sqlite_harness.ts";
import { getDefaultSql } from "../supabase/functions/api/db.ts";
import {
  DAY_MS, deadSources, legSlices, legsCursor, newestRowid, priceLegsFrom, quoteAssets, saveLegsCursor, seriesStartMs,
} from "../worker/src/jobs/quote_prices-core.ts";

const SOLANA = 1399811149;
const USDC = "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v";
const SOL = "11111111111111111111111111111111";
const BATCH = 5_000;

/** The pick as shipped until 19 Sep 2026, verbatim but for the bound limit. */
const SHIPPED = `
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
                      limit ${BATCH})
       and exists (select 1 from quote_assets q
                    where q.network_id = transactions.network_id and q.token_key = transactions.token_key
                      and (q.pegged_usd is not null
                           or exists (select 1 from token_prices p
                                       where p.network_id = q.network_id and p.token_key = q.token_key
                                         and p.day = substr(transactions.block_time, 1, 10))))`;

const legWriter = (db: DatabaseSync) => {
  const st = db.prepare(`insert into transactions (network_id, tx_hash, address_key, transfer_key, block_time, token_key, amount, source, tx_type)
                         values (${SOLANA}, ?, 'wallet', ?, ?, ?, ?, 'helius', ?)`);
  let n = 0;
  return (token: string, amount: number, blockTime: string, txType: string | null = "SWAP"): string => {
    const hash = `tx${++n}`;
    st.run(hash, token, blockTime, token, amount, txType);
    return hash;
  };
};
const valueOf = (db: DatabaseSync, hash: string): number | null =>
  (db.prepare("select value_usd from transactions where tx_hash = ?").get(hash) as { value_usd: number | null }).value_usd;

/** Phase 1b exactly as `runQuotePrices` calls it. Returns rows priced; a failing slice fails the test. */
const pass = async (since: string, size = BATCH): Promise<number> =>
  (await priceLegsFrom(getDefaultSql()!, size, 200, since, () => false, (_after, _upTo, e) => { throw e; })).priced;

Deno.test("value_usd pass: quote legs behind 5,001 legs nothing can price are reached; the shipped pick priced none", async () => {
  const db = await openSchema();
  const leg = legWriter(db);
  const since = new Date(Date.now() - 2 * DAY_MS).toISOString();
  db.prepare("insert into token_prices (network_id, token_key, day, usd, source) values (?,?,?,?,?)").run(SOLANA, SOL, "2026-09-01", 200, "kraken:SOLUSDT");
  for (let i = 0; i < BATCH + 1; i++) leg(`memecoin${i % 7}`, 1000, "2026-09-01T10:00:00.000Z");
  const usdc = leg(USDC, 25, "2026-09-01T10:00:00.000Z");
  const sol = leg(SOL, 1.5, "2026-09-01T23:59:59.000Z");
  const solNoClose = leg(SOL, 2, "2025-01-01T00:00:00.000Z");             // history behind the stored series
  const untyped = leg(USDC, 9, "2026-09-01T10:00:00.000Z", null);        // not tagged SWAP: never this pass's row

  assertEquals(Number(db.prepare(SHIPPED).run().changes), 0, "the shipped pick is full of memecoin legs");
  assertEquals(valueOf(db, usdc), null);

  assertEquals(await pass(since), 2);
  assertEquals(valueOf(db, usdc), 25);
  assertEquals(valueOf(db, sol), 300);
  assertEquals(valueOf(db, solNoClose), null, "no close is absent, never zero");
  assertEquals(valueOf(db, untyped), null);
  assertEquals(db.prepare("select count(*) as n from transactions where value_usd is not null").get(), { n: 2 });
  assertEquals(await legsCursor(getDefaultSql()!), await newestRowid(getDefaultSql()!), "an old leg with no close does not hold the place");

  const next = leg(USDC, 4, "2026-09-02T00:00:01.000Z");
  assertEquals(legSlices(await legsCursor(getDefaultSql()!), await newestRowid(getDefaultSql()!), BATCH, 200).length, 1, "the next run reads only what is new");
  assertEquals(await pass(since), 1);
  assertEquals(valueOf(db, next), 4);
  assertEquals(await pass(since), 0);
});

Deno.test("value_usd pass: a recent leg whose close has not arrived holds the place, and is priced when it does", async () => {
  const db = await openSchema();
  const leg = legWriter(db);
  const now = new Date();
  const since = new Date(now.getTime() - 2 * DAY_MS).toISOString();
  leg(SOL, 5, now.toISOString(), null);                                  // untyped: never this pass's row, so it must not hold the place
  leg("memecoin", 1000, now.toISOString());
  const sol = leg(SOL, 2, now.toISOString());
  const usdc = leg(USDC, 7, now.toISOString());
  const later = leg(USDC, 8, now.toISOString());

  // One rowid a slice, so the legs behind the waiting one are in LATER slices: priced, and the place not moved past it.
  assertEquals(await pass(since, 1), 2);
  assertEquals([valueOf(db, usdc), valueOf(db, later)], [7, 8], "legs behind the waiting one are still priced");
  assertEquals(valueOf(db, sol), null);
  assertEquals(await legsCursor(getDefaultSql()!), 2, "the place stops before the SOL leg, past the untyped one");

  db.prepare("insert into token_prices (network_id, token_key, day, usd, source) values (?,?,?,?,?)").run(SOLANA, SOL, now.toISOString().slice(0, 10), 150, "kraken:SOLUSDT");
  assertEquals(await pass(since), 1);
  assertEquals(valueOf(db, sol), 300);
  assertEquals(await legsCursor(getDefaultSql()!), 5);
});

Deno.test("value_usd pass: a place past the newest rowid restarts the walk; a slice that fails keeps the place and is named dead; out of time asks nothing", async () => {
  const db = await openSchema();
  const sql = getDefaultSql()!;
  const leg = legWriter(db);
  const usdc = leg(USDC, 3, "2026-09-01T10:00:00.000Z");
  const since = new Date(Date.now() - 2 * DAY_MS).toISOString();
  await saveLegsCursor(sql, 1_290_000);                                  // a re-import renumbered the rowids under it

  assertEquals(await priceLegsFrom(sql, BATCH, 200, since, () => true, () => undefined), { priced: 0, asked: 0, failed: 0, stoppedEarly: true });
  assertEquals(await pass(since), 1, "it used to pass nothing for ever");
  assertEquals(valueOf(db, usdc), 3);
  assertEquals(await legsCursor(sql), 1);

  leg(USDC, 4, "2026-09-01T10:00:00.000Z");
  db.exec("alter table quote_assets rename to quote_assets_gone");        // the update cannot run
  const failures: string[] = [];
  const legs = await priceLegsFrom(sql, BATCH, 200, since, () => false, (after, upTo) => failures.push(`${after}-${upTo}`));
  assertEquals(legs, { priced: 0, asked: 1, failed: 1, stoppedEarly: false });
  assertEquals(failures, ["1-2"]);
  assertEquals(await legsCursor(sql), 1, "the place is kept before the slice that failed");
  assertEquals(deadSources({ exchanges: { asked: 6, failed: 0 }, "the value_usd pass": legs }), ["the value_usd pass"]);
});

Deno.test("legSlices: (after, upTo] slices from the cursor to the newest rowid, capped", () => {
  assertEquals(legSlices(0, 12_000, 5_000, 200), [[0, 5_000], [5_000, 10_000], [10_000, 12_000]]);
  assertEquals(legSlices(12_000, 12_000, 5_000, 200), []);
  assertEquals(legSlices(20_000, 12_000, 5_000, 200), []);
  assertEquals(legSlices(0, 12_000, 5_000, 2), [[0, 5_000], [5_000, 10_000]]);
});

Deno.test("quoteAssets: each floating asset with its newest stored day, so a fetch starts there and not a year back", async () => {
  const db = await openSchema();
  const put = db.prepare("insert into token_prices (network_id, token_key, day, usd, source) values (?,?,?,?,?)");
  for (const day of ["2026-09-17", "2026-09-19", "2026-09-18"]) put.run(SOLANA, SOL, day, 200, "kraken:SOLUSDT");
  const assets = await quoteAssets(getDefaultSql()!);
  assertEquals(assets.length, 10);
  assertEquals(assets.some((a) => a.symbol === "USDC"), false, "a pegged asset has no series");
  const byKey = new Map(assets.map((a) => [`${a.network_id}:${a.symbol}`, a.last_day]));
  assertEquals(byKey.get(`${SOLANA}:SOL`), "2026-09-19");
  assertEquals(byKey.get(`${SOLANA}:wSOL`), null);
  const now = new Date("2026-09-19T12:50:00Z");
  assertEquals(seriesStartMs(new Date("2026-09-19"), now), Date.UTC(2026, 8, 18), "two days an hour, not 366");
});

Deno.test("deadSources: a source is judged alone, so a healthy one cannot hide a dead one", () => {
  assertEquals(deadSources({ exchanges: { asked: 10, failed: 0 }, dexscreener: { asked: 4, failed: 4 } }), ["dexscreener"]);
  assertEquals(deadSources({ exchanges: { asked: 10, failed: 9 }, dexscreener: { asked: 0, failed: 0 } }), []);
});
