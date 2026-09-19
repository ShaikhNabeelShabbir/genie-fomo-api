import { assert, assertEquals } from "jsr:@std/assert@1";
import type { DatabaseSync } from "node:sqlite";
import { openSchema } from "./_sqlite_harness.ts";
import { handle } from "../supabase/functions/api/app.ts";
import "../supabase/functions/api/routes.ts";
import { sql } from "../supabase/functions/api/db.ts";
import { asOfHoldings } from "../supabase/functions/api/shared/asof.ts";
import { latestLoad, monthStartCapital, START_CAPITAL_WINDOW_DAYS } from "../supabase/functions/api/shared/scorecard-core.ts";

/*
 * EQUIVALENCE of the statements the traders family rewrote on 19 Sep 2026 to stop reading whole
 * tables. Each test seeds the edge cases, runs the OLD statement text verbatim and the NEW code
 * path against the same rows, and asserts they answer the same.
 */

type Cell = string | number | null;
type Plain = Record<string, unknown>;
const SOL = 1399811149;
const TOKEN = "0x00000000000000000000000000000000000000aa";

const runner = (db: DatabaseSync) => (text: string, ...p: Cell[]): void => void db.prepare(text).run(...p);
const old = (db: DatabaseSync, text: string, ...p: Cell[]): Plain[] =>
  (db.prepare(text).all(...p) as Plain[]).map((r) => ({ ...r }));
const iso = (v: unknown): string | null => v ? new Date(String(v)).toISOString() : null;
const getJson = async (path: string): Promise<Plain> => {
  const res = await handle(new Request(`https://test.local${path}`, { headers: { "user-agent": "plans-traders-test/1.0" } }));
  const text = await res.text();
  assertEquals(res.status, 200, `${path} -> ${text.slice(0, 200)}`);
  return JSON.parse(text) as Plain;
};
const trader = (db: DatabaseSync, h: string): void =>
  runner(db)("insert into traders (handle, display_handle, id) values (?,?,?)", h, h.toUpperCase(), `id-${h}`);

const OLD_LATEST_LOAD = `
  left join (
    select handle, attempted_at as load_attempted_at, outcome as load_outcome,
           row_number() over (partition by handle order by attempted_at desc) as rn
    from trade_loads) ld on ld.handle = t.handle and ld.rn = 1`;

Deno.test("latestLoad() joins the newest trade_loads row per trader, as the row_number() window did", async () => {
  const db = await openSchema();
  const run = runner(db);
  for (const h of ["a", "b", "c"]) trader(db, h);
  run("insert into trade_loads (handle, attempted_at, outcome) values ('a','2026-09-01T00:00:00.000Z','loaded')");
  run("insert into trade_loads (handle, attempted_at, outcome) values ('a','2026-09-03T00:00:00.000Z','error')"); // the newest
  run("insert into trade_loads (handle, attempted_at, outcome) values ('a','2026-09-02T00:00:00.000Z','unchanged')");
  run("insert into trade_loads (handle, attempted_at, outcome) values ('b','2026-08-01T00:00:00.000Z','degraded')");
  // 'c' was never loaded: the join must keep him, with nulls.
  const expected = old(db, `select t.handle, ld.load_attempted_at, ld.load_outcome from traders t ${OLD_LATEST_LOAD} order by t.handle`);
  const got = [...await sql`select t.handle, ld.load_attempted_at, ld.load_outcome from traders t ${latestLoad()} order by t.handle`]
    .map((r: Plain) => ({ ...r }));
  assertEquals(got, expected);
  assertEquals(expected.map((r) => r.load_outcome), ["error", "degraded", null]);
});

const OLD_LIST = (extra: string): string => `
  select t.handle, t.id, t.display_handle, t.name, t.avatar, t.last_seen_at, t.source,
         s.rank, s.pnl_usd, s.volume_usd, s.followers, s.trade_count, s.captured_at,
         ld.load_attempted_at, ld.load_outcome,
         case
           when ? = '' then 0
           when lower(t.display_handle) = ? or lower(coalesce(t.name,'')) = ? then 0
           when lower(t.display_handle) like ? or lower(coalesce(t.name,'')) like ? then 1
           else 2
         end as score
  from traders t
  left join trader_stats_current s using (handle) ${OLD_LATEST_LOAD}
  where (? or t.listed)
    and (? = '' or lower(t.display_handle) like ?
                   or lower(coalesce(t.name,'')) like ?)
    ${extra}
  order by score, s.rank asc nulls last, t.handle`;
const NO_QUERY: Cell[] = ["", "", "", "%", "%", 0, "", "%%", "%%"];

Deno.test("GET /traders ranks and rates every trader as trader_stats_current did", async () => {
  const seen: string[] = [];
  const db = await openSchema((text) => void seen.push(text));
  const run = runner(db);
  run("insert into builds (captured_at, window_label, trader_count, holding_count) values ('2026-09-10T00:00:00.000Z','24h',5,0)");
  for (const h of ["a", "b", "c", "d", "gone"]) trader(db, h);
  run("update traders set listed = 0 where handle = 'gone'");
  const stat = (h: string, at: string, rank: number | null, pnl: number | null): void =>
    run("insert into trader_stats (handle, captured_at, rank, pnl_usd, volume_usd, trade_count, followers) values (?,?,?,?,?,?,?)", h, at, rank, pnl, pnl === null ? null : Math.abs(pnl), rank, rank);
  stat("a", "2026-09-09T00:00:00.000Z", 1, 900); // an older capture that ranked him first
  stat("a", "2026-09-10T00:00:00.000Z", 3, -50); // the newer one is the one that counts
  stat("b", "2026-09-10T00:00:00.000Z", 2, 500);
  stat("c", "2026-09-10T00:00:00.000Z", null, null); // a stats row with no rank and no pnl
  stat("gone", "2026-09-10T00:00:00.000Z", 1, 5);
  // 'd' has no stats row at all: listed last, and counted as unrated by a range filter.
  run("insert into trade_loads (handle, attempted_at, outcome) values ('b','2026-09-10T01:00:00.000Z','loaded')");

  const shape = (rows: Plain[]): unknown[] =>
    rows.map((r) => [r.display_handle, r.rank ?? null, r.pnl_usd ?? null, r.volume_usd ?? null, r.followers ?? null, r.trade_count ?? null, iso(r.captured_at)]);
  const entries = (body: Plain): unknown[] =>
    (body.entries as Plain[]).map((e) => [e.handle, e.rank, e.pnl, e.volume, e.followers, e.numTrades, e.updatedAt]);

  assertEquals(entries(await getJson("/v2/traders")), shape(old(db, OLD_LIST(""), ...NO_QUERY)));
  assertEquals(entries(await getJson("/v2/traders")).map((e) => (e as unknown[])[0]), ["B", "A", "C", "D"]);

  const [unrated] = old(db, `
        select count(*) as n from traders t
        left join trader_stats_current s using (handle) where s.handle is null`);
  assertEquals(unrated.n, 1);
  // minPnl=600 and minVolume=600 are met only by a's OLDER capture, which must not count.
  const FILTERS: [string, string, number, string[]][] = [
    ["minPnl=-100", "and s.pnl_usd >= ?", -100, ["B", "A"]], ["minPnl=600", "and s.pnl_usd >= ?", 600, []],
    ["maxPnl=100", "and s.pnl_usd <= ?", 100, ["A"]], ["minVolume=600", "and s.volume_usd >= ?", 600, []],
    ["maxVolume=100", "and s.volume_usd <= ?", 100, ["A"]], ["minTrades=3", "and s.trade_count >= ?", 3, ["A"]],
    ["minFollowers=2", "and s.followers >= ?", 2, ["B", "A"]],
  ];
  for (const [query, extra, value, want] of FILTERS) {
    const filtered = await getJson(`/v2/traders?${query}`);
    assertEquals(entries(filtered), shape(old(db, OLD_LIST(extra), ...NO_QUERY, value)), query);
    assertEquals(entries(filtered).map((e) => (e as unknown[])[0]), want, query);
    assertEquals((filtered.filters as Plain).excludedForMissingValue, unrated.n, query);
  }
  // A range filter makes the stats join an inner join: traders must stay the outer loop, never a scan of trader_stats.
  const lists = [...new Set(seen.filter((text) => text.includes("left join trader_stats s")))];
  assertEquals(lists.length, 1 + new Set(FILTERS.map((f) => f[1])).size);
  for (const text of lists) {
    const plan = (db.prepare("explain query plan " + text).all() as { detail: string }[]).map((p) => p.detail);
    assert(plan.some((d) => d.startsWith("SCAN t")) && !plan.some((d) => /^SCAN (s|trader_stats)\b/.test(d)), plan.join(" | "));
  }
});

/*
 * AF-4 (19 Sep 2026). The old statement read `aum_samples`, which nothing has written since the
 * sampler was retired on 17 Sep, so every month from October had no start. There is no old text to
 * equal: this pins the published meaning over `aum_history`, the series v2 does write.
 */
Deno.test("monthStartCapital() is the first well-covered hour of a month's first days in aum_history, and reads no sample", async () => {
  const db = await openSchema();
  const run = runner(db);
  const handles = ["a", "b", "c", "d", "e", "f", "g", "p"];
  for (const h of [...handles, "offpage"]) trader(db, h);
  /* The scorecard's months run to the one we are in, so the seed is dated from the clock. */
  const now = new Date();
  const month = (back: number): string => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)).toISOString().slice(0, 7);
  const hour = (h: string, at: string, usd: number | null, priced: number, total: number, basis = "priced"): void =>
    run("insert into aum_history (handle, hour, total_usd, priced_positions, total_positions, basis) values (?,?,?,?,?,?)", h, at, usd, priced, total, basis);
  const M1 = month(1), M12 = month(12), M13 = month(13);
  // a: the month opens on a 2-of-289 fragment and an unvalued hour; the first WELL-COVERED hour is the start
  hour("a", `${M1}-01T00:00:00.000Z`, 43780.82, 2, 289);
  hour("a", `${M1}-01T01:00:00.000Z`, null, 0, 289);
  hour("a", `${M1}-01T02:00:00.000Z`, 351321.95, 217, 279);
  hour("a", `${M1}-01T03:00:00.000Z`, 360000, 217, 279);
  hour("a", `${M12}-01T00:00:00.000Z`, null, 217, 279); // price_suspect: well covered and unvalued, so the floor alone would stop here
  hour("a", `${M12}-03T05:00:00.000Z`, 111, 1, 1); // the oldest of the scorecard's thirteen months
  hour("a", `${M13}-03T05:00:00.000Z`, 999, 1, 1); // one month older: never asked for
  // b: first covered on the 8th, outside the window; c: the last hour of the 7th is inside it
  hour("b", `${M1}-08T00:00:00.000Z`, 400, 1, 1);
  hour("c", `${M1}-07T23:00:00.000Z`, 600, 3, 4);
  // d: only unvalued hours; e: no rows at all; p: between the floors is a partial figure, not a balance
  hour("d", `${M1}-01T00:00:00.000Z`, null, 0, 5);
  hour("p", `${M1}-02T00:00:00.000Z`, 1685.57, 30, 279);
  // f: a sampled reading folded in without counts (0 of 0) is a measurement, and exactly a quarter is covered
  hour("f", `${M1}-02T06:00:00.000Z`, 800, 0, 0, "reading");
  hour("f", `${month(2)}-01T00:00:00.000Z`, 700, 1, 4);
  // g: only the retired sampler has him — the October shape, inverted: nothing is read from aum_samples
  run("insert into aum_samples (handle, at, total_usd, basis, tier) values ('g',?,42,'sampled','verified')", `${M1}-01T00:00:00.000Z`);
  hour("offpage", `${M1}-01T00:00:00.000Z`, 9, 1, 1);

  assertEquals(await monthStartCapital([...handles, "nobody"]), new Map([
    ["a", new Map([[M12, 111], [M1, 351321.95]])],
    ["c", new Map([[M1, 600]])],
    ["f", new Map([[month(2), 700], [M1, 800]])],
  ]));
  assertEquals(START_CAPITAL_WINDOW_DAYS, 7);
  assertEquals(await monthStartCapital([]), new Map());
});

Deno.test("monthStartCapital() seeks each (trader, month) by the aum_history key", async () => {
  const seen: string[] = [];
  const db = await openSchema((text) => seen.push(text));
  await monthStartCapital(["a"]);
  const plan = (db.prepare("explain query plan " + seen.find((t) => t.includes("from aum_history a"))!).all() as { detail: string }[]).map((r) => r.detail);
  assert(plan.includes("SEARCH a USING INDEX sqlite_autoindex_aum_history_1 (handle=? AND hour>? AND hour<?)"), plan.join("\n"));
  assert(!plan.some((d) => d.startsWith("SCAN a")), plan.join("\n"));
});

Deno.test("asOfHoldings() with no handle answers max(captured_at) of holdings_current without reading the view", async () => {
  const db = await openSchema();
  const run = runner(db);
  for (const h of ["a", "b"]) trader(db, h);
  run("insert into tokens (network_id, address, token_key) values (1,?,?)", TOKEN, TOKEN);
  run("insert into tokens (network_id, address, token_key) values (?,?,?)", SOL, TOKEN, TOKEN);
  const hold = (h: string, net: number, at: string, source: string): void =>
    run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, source) values (?,?,?,?,1,?)", h, net, TOKEN, at, source);
  const same = async (why: string, want: string | null): Promise<void> => {
    const [r] = old(db, "select max(captured_at) as at from holdings_current");
    assertEquals(await asOfHoldings(), iso(r.at), why);
    assertEquals(iso(r.at), want, why);
  };
  await same("no holdings at all", null);
  hold("a", 1, "2026-09-05T00:00:00.000Z", "fomo"); hold("b", SOL, "2026-09-05T00:00:00.000Z", "fomo");
  await same("a fomo build alone", "2026-09-05T00:00:00.000Z");
  hold("a", 1, "2026-09-01T00:00:00.000Z", "chain");
  await same("the build is newer and still fills (b, solana)", "2026-09-05T00:00:00.000Z");
  hold("b", SOL, "2026-09-02T00:00:00.000Z", "chain");
  await same("the build is newer but fills nothing: every pair was read on chain", "2026-09-02T00:00:00.000Z");
  hold("a", 1, "2026-09-07T00:00:00.000Z", "fomo"); hold("a", SOL, "2026-09-07T00:00:00.000Z", "fomo");
  await same("a newer build fills (a, solana), a second chain for the same trader", "2026-09-07T00:00:00.000Z");
  hold("a", 1, "2026-09-08T00:00:00.000Z", "chain");
  await same("an older and a newer chain capture of one pair; chain is newest", "2026-09-08T00:00:00.000Z");
});

Deno.test("/scorecard and /pnl count a wallet's SWAP transactions as the statements that read every wallet's did", async () => {
  const db = await openSchema();
  const run = runner(db);
  for (const h of ["x", "y", "quiet"]) trader(db, h);
  run("insert into wallets (handle, evm_address, sol_address) values ('x','0xAbC','SolX')");
  run("insert into wallets (handle, evm_address, sol_address) values ('y',null,'SolY')");
  run("insert into wallets (handle, evm_address, sol_address) values ('quiet','0xQuiet','SolQuiet')");
  run("insert into tokens (network_id, address, token_key) values (1,?,?)", TOKEN, TOKEN);
  run("insert into tokens (network_id, address, token_key) values (?,?,?)", SOL, TOKEN, TOKEN);
  const tx = (net: number, hash: string, addr: string, key: string, type: string | null): void =>
    run("insert into transactions (network_id, tx_hash, address_key, transfer_key, source, tx_type) values (?,?,?,?,'t',?)", net, hash, addr, key, type);
  tx(SOL, "s1", "solx", "k1", "SWAP"); tx(SOL, "s1", "solx", "k2", "SWAP"); // two legs, one swap
  tx(SOL, "s2", "solx", "k1", "SWAP");
  tx(SOL, "s3", "solx", "k1", "TRANSFER"); tx(SOL, "s4", "solx", "k1", null); // not swaps
  tx(1, "s1", "0xabc", "k1", "SWAP"); // the same hash on a second chain is a second swap for /scorecard, none for /pnl
  tx(1, "e2", "0xabc", "k1", "SWAP");
  tx(1, "e9", "solx", "k1", "SWAP"); // the Solana key on an EVM chain: a swap for /scorecard, none for /pnl
  tx(SOL, "s9", "soly", "k1", "SWAP"); // another trader's
  for (const h of ["x", "quiet"]) {
    run(`insert into trades (trade_id, handle, network_id, token_address, token_key, token_symbol, status, amount, captured_at)
         values (?,?,1,?,?,'AA','closed',1,'2026-09-02T00:00:00.000Z')`, `tr-${h}`, h, TOKEN, TOKEN);
    run(`insert into wallet_swaps (network_id, tx_hash, address_key, block_time, token_key, token_delta, quote_usd)
         values (?,?,?,'2026-09-01T00:00:00.000Z',?,1,-2)`, SOL, `w-${h}`, h === "x" ? "solx" : "solquiet", TOKEN);
  }
  const OLD_SCORECARD = `select count(*) as n from (
              select network_id, tx_hash from transactions
              where address_key in (?, ?) and tx_type = 'SWAP'
              group by network_id, tx_hash) g`;
  const OLD_PNL = `select count(*) as n from (
              select tx_hash from transactions
               where network_id = 1399811149 and tx_type = 'SWAP'
                 and address_key in (?) group by tx_hash) x`;
  for (const [h, sol, evm, scorecard, pnl] of [["x", "solx", "0xabc", 5, 2], ["quiet", "solquiet", "0xquiet", 0, 0]] as const) {
    const sc = await getJson(`/v2/traders/${h}/scorecard`);
    const total = ((sc.onChain as Plain).coverage as Plain).total;
    assertEquals(total, old(db, OLD_SCORECARD, sol, evm)[0].n);
    assertEquals(total, scorecard);
    const p = await getJson(`/v2/traders/${h}/pnl`);
    const seen = ((p.chainDerived as Plain).coverage as Plain).total;
    assertEquals(seen, old(db, OLD_PNL, sol)[0].n);
    assertEquals(seen, pnl);
  }
});

Deno.test("the plain trader list keeps answering from its last good copy when the database stops; a page with includes does not pretend to", async () => {
  const { handle } = await import("../supabase/functions/api/app.ts");
  const { getDefaultSql, setDefaultSql } = await import("../supabase/functions/api/db.ts");
  const ask = (path: string): Promise<Response> => handle(new Request(`https://test.local${path}`));
  const db = await openSchema(); // no build row on purpose: the list must answer `window: null`, not crash
  for (const h of ["a", "b", "c"]) db.prepare("insert into traders (handle, display_handle, id) values (?,?,?)").run(h, h, `id-${h}`);
  const good = await ask("/v2/traders?limit=3&cacheProbe=1");
  assertEquals(good.status, 200);
  const first = await good.json();
  const previous = getDefaultSql();
  // Lazy, as the real client is: a fragment that is never awaited must not reject into the void.
  const down = () => ({ then: (r: unknown, j: unknown) => Promise.reject(new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.")).then(r as never, j as never) });
  const broken = Object.assign(down, { unsafe: down, begin: down, end: () => Promise.resolve() });
  setDefaultSql(broken as never);
  const original = console.error;
  console.error = () => undefined;
  try {
    const again = await ask("/v2/traders?limit=3&cacheProbe=1");
    assertEquals(again.status, 200, "the list the app falls back on must survive the outage it is the fallback for");
    assertEquals((await again.json()).entries, first.entries);
    const withIncludes = await ask("/v2/traders?include=wallets&limit=3");
    assertEquals([withIncludes.status, (await withIncludes.json()).error.retryAfterSeconds], [503, 15]);
  } finally {
    console.error = original;
    setDefaultSql(previous);
  }
});
