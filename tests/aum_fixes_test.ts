import { assert, assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { d1sql, type D1Like, type D1Statement } from "../worker/src/d1.ts";
import { setDefaultSql } from "../supabase/functions/api/db.ts";
import { handle } from "../supabase/functions/api/app.ts";
import "../supabase/functions/api/routes.ts";

/*
 * The audit fixes of 19 Sep 2026 on /aum and /aum/history, each pinned through the real request path:
 *   F4      a rollup bucket counts the hours the hourly step publishes (the views count every stored total)
 *   AF-2    a bounded window bounds the hours read, and drops nothing
 *   CVC-01  /aum stops promising the sampler retired on 17 Sep
 *   AF-1    the batch's floored reads seek on (handle, at); two statements a call are gone
 *   AF-4    a scorecard month starts from aum_history (the function itself: tests/plans_traders_test.ts)
 * Where a statement was only re-planned, its OLD text runs verbatim beside what the route issues now.
 */

type Row = Record<string, unknown>;
type Bind = string | number | null;
type Issued = { text: string; params: Bind[]; rows: Row[] };

const issued: Issued[] = [];
const db = await openSchema();
const plain = (rows: unknown[]): Row[] => rows.map((r) => ({ ...(r as Row) }));
const old = (text: string, ...params: Bind[]): Row[] => plain(db.prepare(text).all(...params));
const run = (text: string, ...params: Bind[]): void => void db.prepare(text).run(...params);

/** The harness's adapter again, keeping the text, parameters and rows of every read. */
const recording: D1Like = {
  prepare(text: string): D1Statement {
    const make = (params: unknown[]): D1Statement => ({
      bind: (...values: unknown[]) => make(values),
      all: () => {
        const st = db.prepare(text);
        const p = params as Bind[];
        if (/^\s*(insert|update|delete|replace)/i.test(text)) {
          return Promise.resolve({ results: [], meta: { changes: Number(st.run(...p).changes) } });
        }
        const rows = plain(st.all(...p));
        issued.push({ text, params: p, rows: [...rows] });
        return Promise.resolve({ results: rows, meta: {} });
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
setDefaultSql(d1sql(recording));

const call = async (method: string, path: string, body?: unknown): Promise<{ json: Row; issued: Issued[] }> => {
  issued.length = 0;
  const res = await handle(new Request(`https://test.local${path}`, {
    method,
    headers: { "content-type": "application/json", "user-agent": "aum-fixes-test/1.0" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  assertEquals(res.status, 200, `${method} ${path} -> ${text.slice(0, 200)}`);
  return { json: JSON.parse(text) as Row, issued: [...issued] };
};
const theOne = (list: Issued[], marker: string): Issued => {
  const hits = list.filter((s) => s.text.includes(marker));
  assertEquals(hits.length, 1, `exactly one statement carries '${marker}'`);
  return hits[0];
};
const planOf = (text: string): string[] => (db.prepare("explain query plan " + text).all() as { detail: string }[]).map((p) => p.detail);
const pick = (rows: Row[], keys: string[]): Row[] => rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));

for (const [i, h] of ["s", "v", "w", "x", "m"].entries()) {
  run("insert into traders (handle, display_handle, id) values (?,?,?)", h, h.toUpperCase(), `${i + 1}`.repeat(8) + "-1111-4111-8111-111111111111");
}

// ------------------------------------------------------------------ F4 and AF-2: /aum/history rollups

type HistoryPoint = {
  at: string; totalUsd: number | null; highUsd?: number | null; lowUsd?: number | null; valuedHours?: number;
  pricedShare?: number | null; partial?: boolean; partialUsd?: number | null;
};
const hour = (at: string, usd: number | null, priced: number, total: number, basis = "priced"): void =>
  run("insert into aum_history (handle, hour, total_usd, priced_positions, total_positions, basis) values ('s',?,?,?,?,?)", at, usd, priced, total, basis);
const hh = (h: number): string => String(h).padStart(2, "0");
/* Thu 10 Sep: 397397's sawtooth — every third hour, and the day's LAST, is a 2-of-289 fragment. */
for (let h = 0; h < 24; h++) {
  if (h % 3 === 2) hour(`2026-09-10T${hh(h)}:00:00.000Z`, 43780.82, 2, 289);
  else hour(`2026-09-10T${hh(h)}:00:00.000Z`, 351321.95, 217, 279);
}
/* Fri 11: nothing but fragments. Sat 12: closes on a partial hour. Sun 13: the rounding edge, and a reading without counts. */
for (let h = 0; h < 3; h++) hour(`2026-09-11T${hh(h)}:00:00.000Z`, 43780.82, 2, 289);
hour("2026-09-12T08:00:00.000Z", 351321.95, 217, 279);
hour("2026-09-12T09:00:00.000Z", 1685.57, 30, 279);
hour("2026-09-13T09:00:00.000Z", 77, 565, 11301); // 0.049995 publishes as 0.05: pricedShare() rounds before it compares
hour("2026-09-13T10:00:00.000Z", 500, 0, 0, "reading"); // no counts: the hourly step withholds it
const RANGE = "from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z";
const history = async (query: string): Promise<{ points: HistoryPoint[]; latest: { totalUsd: number } | null; stmt: Issued }> => {
  const got = await call("GET", `/v2/traders/s/aum/history?${query}`);
  return { points: got.json.points as HistoryPoint[], latest: got.json.latest as { totalUsd: number } | null,
           stmt: theOne(got.issued, "from aum_history\n") };
};

Deno.test("F4: a rollup bucket counts exactly the hours the hourly step publishes, and its close carries their coverage", async () => {
  const hourly = (await history(`step=1h&${RANGE}`)).points;
  const published = hourly.filter((p) => p.totalUsd !== null);
  assertEquals(published.length, 16 + 2 + 1);

  const daily = await history(`step=1d&${RANGE}`);
  assertEquals(daily.points, [
    /* The close is the newest PUBLISHED hour (22:00), not the 23:00 fragment; the low is no longer the fragment. */
    { at: "2026-09-10T00:00:00.000Z", totalUsd: 351321.95, highUsd: 351321.95, lowUsd: 351321.95, valuedHours: 16,
      pricedShare: 0.7778, partial: false, partialUsd: null },
    { at: "2026-09-11T00:00:00.000Z", totalUsd: null, highUsd: null, lowUsd: null, valuedHours: 0,
      pricedShare: null, partial: false, partialUsd: null },
    { at: "2026-09-12T00:00:00.000Z", totalUsd: 1685.57, highUsd: 351321.95, lowUsd: 1685.57, valuedHours: 2,
      pricedShare: 0.1075, partial: true, partialUsd: null },
    { at: "2026-09-13T00:00:00.000Z", totalUsd: 77, highUsd: 77, lowUsd: 77, valuedHours: 1,
      pricedShare: 0.05, partial: true, partialUsd: null },
  ]);
  assertEquals(daily.latest?.totalUsd, 77);
  /* What the view — and this route until today — said of the 10th: the withheld fragment as the day's close and low. */
  assertEquals(old("select total_usd, low_usd, valued_hours from aum_history_daily where handle = 's' and bucket = '2026-09-10T00:00:00.000Z'"),
    [{ total_usd: 43780.82, low_usd: 43780.82, valued_hours: 24 }]);

  for (const step of ["1d", "1w", "1mo"]) {
    const points = (await history(`step=${step}&${RANGE}`)).points;
    assertEquals(points.reduce((sum, p) => sum + Number(p.valuedHours), 0), published.length, step);
    assertEquals(points.at(-1)?.totalUsd, 77, step);
  }
});

Deno.test("AF-2: a bounded window is a seek bound on the hours read, and drops nothing the unbounded read kept", async () => {
  /* Each `from` cuts a day, a week or a month in two: the bucket it cuts is one the range drops either way. */
  const kept: Record<string, number> = {};
  for (const from of ["2026-09-10T01:00:00.000Z", "2026-09-05T01:00:00.000Z", "2026-08-15T00:00:00.000Z"]) {
    for (const step of ["1d", "1w", "1mo"]) {
      const { stmt } = await history(`step=${step}&from=${from}&to=2026-09-30T00:00:00.000Z`);
      assert(planOf(stmt.text).some((d) => d.startsWith("SEARCH aum_history") && d.includes("(handle=? AND hour>?)")), planOf(stmt.text).join("\n"));
      const bound = stmt.params.indexOf(from);
      assertEquals(stmt.rows, old(stmt.text.replace("and hour >= ?", ""), ...stmt.params.filter((_p, i) => i !== bound)), `${step} from ${from}`);
      kept[`${step} ${from.slice(5, 10)}`] = stmt.rows.length;
    }
  }
  assertEquals(kept, {
    "1d 09-10": 3, "1w 09-10": 0, "1mo 09-10": 0,
    "1d 09-05": 4, "1w 09-05": 1, "1mo 09-05": 0,
    "1d 08-15": 4, "1w 08-15": 1, "1mo 08-15": 1,
  });
  const open = (await call("GET", "/v2/traders/s/aum/history?window=all")).issued;
  assert(!theOne(open, "from aum_history\n").text.includes("hour >="), "window=all has no lower bound to seek from");
});

// ------------------------------------------------------------------ CVC-01 and AF-1: /aum

const H = 3_600_000, DAY = 24 * H, NOW = Date.now();
const at = (ms: number): string => new Date(Math.floor(ms / H) * H).toISOString();
const ETH = 1, BSC = 56, BASE = 8453, ROBINHOOD = 4663, SOL = 1399811149;
const sample = (h: string, when: string, usd: number | null, basis: string): void =>
  run(`insert into aum_samples (handle, at, total_usd, priced_positions, total_positions, value_share, basis, tier, sampled_at, chains_answered, chains_expected)
       values (?,?,?,9,10,0.9,?,'verified',?,1,1)`, h, when, usd, basis, when);
const chainSample = (h: string, when: string, basis: string, net: number, usd: number | null, reason: string | null = null): void =>
  run("insert into aum_chain_samples (handle, at, basis, network_id, total_usd, priced_share, reason) values (?,?,?,?,?,0.9,?)", h, when, basis, net, usd, reason);
/* w's newest moment has a rebuilt twin, stored FIRST: the sampled row is the newest point, as the stored order always decided. */
const NEWEST = at(NOW - 3 * DAY);
sample("w", NEWEST, 5, "rebuilt");
chainSample("w", NEWEST, "rebuilt", ETH, 5);
/* v, w: a sampled series that began nine days ago and froze three days ago — what every trader's looks like since 17 Sep. */
for (const h of ["v", "w"]) {
  for (let d = 9; d >= 3; d--) {
    sample(h, at(NOW - d * DAY), 1000 + d, "sampled");
    chainSample(h, at(NOW - d * DAY), "sampled", ETH, 1000 + d);
  }
}
/* w's newest point: ties stored against both network and name order, and its one positive total stored LAST. */
chainSample("w", NEWEST, "sampled", SOL, null, "no_prices");
chainSample("w", NEWEST, "sampled", BSC, 0);
chainSample("w", NEWEST, "sampled", BASE, null, "service_timeout");
run("update aum_chain_samples set total_usd = 0 where handle = 'w' and at = ? and basis = 'sampled' and network_id = ?", NEWEST, ETH);
chainSample("w", NEWEST, "sampled", ROBINHOOD, 7);
/* v's newest point: two distinct positive totals, the smaller (ethereum, 1003) stored first. */
chainSample("v", NEWEST, "sampled", BSC, 2000);
chainSample("w", at(NOW - 4 * DAY), "sampled", SOL, 70);
/* x: read once, long ago, and refused since. */
sample("x", at(NOW - 40 * DAY), 9, "sampled");
sample("x", at(NOW - 5 * DAY), null, "sampled");

Deno.test("CVC-01: /aum does not promise the retired sampler — no warming, no next run, and the true word is `stale`", async () => {
  const single = (await call("GET", "/v2/traders/v/aum?window=1m&live=false")).json;
  const batch = ((await call("POST", "/v2/traders/aum", { ids: ["v"], window: "1m" })).json.traders as { aum: Row }[])[0].aum;
  for (const body of [single, batch]) {
    /* The series began inside the window, which used to read `warming` with tomorrow 06:00 UTC as the next run. */
    assertEquals((body.drawing as Row).reason, "short_coverage");
    assertEquals(body.status, "stale");
    const progress = body.progress as Row, sampler = body.sampler as Row;
    assertEquals([progress.warming, progress.nextRunAt, sampler.nextExpectedAt, sampler.state], [false, null, null, "stale"]);
  }
});

const U = `(select jh.value as handle, jl.value as lo
                from json_each(?) jh
                join json_each(?) jl on jl.key = jh.key) u`;
const ROWS_OLD = `
        select s.handle, s.at, s.total_usd, s.refused_reason, s.priced_positions, s.total_positions,
               s.value_share, s.basis, s.tier, s.chains_answered, s.chains_expected
        from aum_samples s
        join ${U}
          on u.handle = s.handle and s.at >= u.lo
        order by s.handle, s.at asc`;
const ROWS_CHAIN_OLD = `
        select a.handle, a.at, a.total_usd, a.reason as refused_reason,
               null as priced_positions, null as total_positions,
               a.priced_share as value_share, a.basis, s.tier,
               null as chains_answered, null as chains_expected
        from aum_chain_samples a
        join aum_samples s
          on s.handle = a.handle and s.at = a.at and s.basis = a.basis
        join ${U}
          on u.handle = a.handle and a.at >= u.lo
        where a.network_id = ?
        order by a.handle, a.at asc`;
const ALL_CHAIN_OLD = `
        select a.handle, a.at, a.basis, c.name as chain, a.total_usd
        from aum_chain_samples a
        join chains c using (network_id)
        join ${U}
          on u.handle = a.handle and a.at >= u.lo
        order by a.handle, a.at asc`;
const NEWEST_SPLIT_OLD = `
        select a.handle, c.name as chain, a.network_id, a.total_usd, a.priced_share, a.reason
        from aum_chain_samples a
        join chains c using (network_id)
        join (select jh.value as handle, ja.value as at, jb.value as basis
                from json_each(?) jh
                join json_each(?) ja on ja.key = jh.key
                join json_each(?) jb on jb.key = jh.key) u
          on u.handle = a.handle and u.at = a.at and u.basis = a.basis
        order by a.handle, a.total_usd desc nulls last`;

Deno.test("AF-1: the floored reads seek on (handle, at) and answer what the table-first joins did", async () => {
  const ids = ["v", "w", "x", "m", "ghost"];
  for (const window of ["1d", "1w", "1m", "all"]) {
    const got = (await call("POST", "/v2/traders/aum", { ids, window })).issued;
    const rows = theOne(got, "s.chains_answered"), split = theOne(got, "c.name as chain, a.total_usd");
    assertEquals(rows.rows, old(ROWS_OLD, ...rows.params), window);
    assertEquals(pick(split.rows, ["handle", "at", "basis", "chain", "total_usd"]), old(ALL_CHAIN_OLD, ...split.params), window);
    assert(planOf(rows.text).some((d) => d.includes("aum_samples_handle_at_idx (handle=? AND at>?)")), planOf(rows.text).join("\n"));
    assert(planOf(split.text).some((d) => d.startsWith("SEARCH a ") && d.includes("(handle=? AND at>?)")), planOf(split.text).join("\n"));

    const one = (await call("POST", "/v2/traders/aum", { ids, window, chain: "ethereum" })).issued;
    const chainRows = theOne(one, "null as chains_expected");
    assertEquals(chainRows.rows, old(ROWS_CHAIN_OLD, ...chainRows.params), `${window} chain=ethereum`);
    assert(planOf(chainRows.text).some((d) => d.startsWith("SEARCH a ") && d.includes("at>?")), planOf(chainRows.text).join("\n"));
  }
  assert((await call("POST", "/v2/traders/aum", { ids, window: "1d" })).issued.length > 0);
});

Deno.test("AF-1: the newest point's chain split comes out of the read already made, in the order its own statement gave", async () => {
  for (const body of [{ window: "1w" }, { window: "all" }, { window: "1w", chain: "ethereum" }]) {
    const got = await call("POST", "/v2/traders/aum", { ids: ["v", "w", "x", "m"], ...body });
    const rows = theOne(got.issued, "chain" in body ? "null as chains_expected" : "s.chains_answered").rows;
    const newest = new Map(rows.map((r) => [String(r.handle), r])); // ascending, so the last row of a handle wins
    const triples = [...newest.values()];
    const expected = old(NEWEST_SPLIT_OLD, JSON.stringify(triples.map((r) => r.handle)), JSON.stringify(triples.map((r) => r.at)),
      JSON.stringify(triples.map((r) => r.basis)));
    const served = (got.json.traders as { handle: string; aum: { chains: { chain: string; networkId: number; totalUsd: number | null; pricedShare: number | null }[] } }[])
      .flatMap((t) => t.aum.chains.map((c) => ({ handle: t.handle.toLowerCase(), chain: c.chain, network_id: c.networkId, total_usd: c.totalUsd, priced_share: c.pricedShare })));
    assertEquals(served, pick(expected, ["handle", "chain", "network_id", "total_usd", "priced_share"]), JSON.stringify(body));
    assert(!got.issued.some((s) => s.text.includes("ja.value as at")), "the split has no statement of its own");
  }
  /* Spelled out, largest first: v's two positives were stored smallest first; w's positive was stored last, then two zeros and two nulls, each pair as stored; the rebuilt twin stays out. */
  const [v, w] = (await call("POST", "/v2/traders/aum", { ids: ["v", "w"] })).json.traders as { aum: { chains: { chain: string; totalUsd: number | null }[] } }[];
  assertEquals(v.aum.chains.map((c) => [c.chain, c.totalUsd]), [["bsc", 2000], ["ethereum", 1003]]);
  assertEquals(w.aum.chains.map((c) => [c.chain, c.totalUsd]), [["robinhood", 7], ["ethereum", 0], ["bsc", 0], ["solana", null], ["base", null]]);
});

Deno.test("AF-1: a batch call is five reads and the rate-limit write, where it was seven reads", async () => {
  await call("POST", "/v2/traders/aum", { ids: ["v"] }); // the isolate's first call also fills the native-price and sampler caches
  const got = await call("POST", "/v2/traders/aum", { ids: ["v", "w", "x", "m"], window: "1m" });
  assertEquals(got.issued.length, 5, got.issued.map((s) => s.text.trim().slice(0, 60)).join("\n"));
  /* Asked by id, as the app asks, the id lookup is one read more: 7 statements a call with the write, where it was 9. */
  const byId = await call("POST", "/v2/traders/aum", { ids: ["22222222-1111-4111-8111-111111111111"], window: "1m" });
  assertEquals([(byId.json.traders as { handle: string }[])[0].handle, byId.issued.length], ["V", 6]);
});

// ------------------------------------------------------------------ AF-4: the scorecard's month start

Deno.test("AF-4: a month with built hours and no sample has a start capital and a return", async () => {
  const now = new Date();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  run("insert into aum_history (handle, hour, total_usd, priced_positions, total_positions, basis) values ('m',?,2000,3,4,'priced')", `${lastMonth}-01T00:00:00.000Z`);
  run(`insert into trades (trade_id, handle, network_id, token_address, token_key, token_symbol, status, amount,
         avg_entry_price, realized_pnl_usd, opened_at, closed_at, captured_at) values ('m1','m',1,'0xaa','0xaa','AA','closed',1,1,-500,?,?,?)`,
    `${lastMonth}-02T00:00:00.000Z`, `${lastMonth}-03T00:00:00.000Z`, now.toISOString());
  const months = (await call("GET", "/v2/traders/m/scorecard")).json.realizedByMonth as Row[];
  assertEquals(pick(months, ["month", "startCapitalUsd", "startingCapitalUsd", "returnPct"]),
    [{ month: lastMonth, startCapitalUsd: 2000, startingCapitalUsd: 2000, returnPct: -25 }]);
});
