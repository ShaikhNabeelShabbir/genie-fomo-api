import { assert, assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { d1sql, type D1Like, type D1Statement } from "../worker/src/d1.ts";
import { setDefaultSql } from "../supabase/functions/api/db.ts";
import { handle } from "../supabase/functions/api/app.ts";
import "../supabase/functions/api/routes.ts";

/*
 * EQUIVALENCE of every statement the aum-misc family rewrote for the plan audit (19 Sep 2026).
 * Each test runs the OLD statement text verbatim beside what the route issues NOW — captured from
 * the real request path with its bound parameters — and asserts the rows are equal, then changes
 * the data and asserts it again. The statements are inline in their routes, so they are captured
 * rather than imported; a marker (a column alias only that statement has) finds each one.
 */

type Row = Record<string, unknown>;
type Bind = string | number | null;
type Issued = { text: string; params: Bind[]; rows: Row[] };

const issued: Issued[] = [];
const db = await openSchema();
const plain = (rows: unknown[]): Row[] => rows.map((r) => ({ ...(r as Row) }));
const old = (text: string, ...params: Bind[]): Row[] => plain(db.prepare(text).all(...params));
const run = (text: string, ...params: Bind[]): void => void db.prepare(text).run(...params);

/** The harness's adapter again, keeping the parameters and the rows of every read. */
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
        issued.push({ text, params: p, rows: [...rows] }); // a copy: the shim hangs `count` on the array it is given
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

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Row; issued: Issued[] }> => {
  issued.length = 0;
  const res = await handle(new Request(`https://test.local${path}`, {
    method,
    headers: { "content-type": "application/json", "user-agent": "plans-aum-misc-test/1.0" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json() as Row, issued: [...issued] };
};
const theOne = (list: Issued[], marker: string): Issued => {
  const hits = list.filter((s) => s.text.includes(marker));
  assertEquals(hits.length, 1, `exactly one statement carries '${marker}'`);
  return hits[0];
};
/** The captured statement again, against the data as it is NOW. */
const again = (s: Issued, params: Bind[] = s.params): Row[] => plain(db.prepare(s.text).all(...params));
/** The plan audit sweeps neither a rollup step nor a read of one whole build, so these two are held here. */
const planOf = (s: Issued): string[] => (db.prepare("explain query plan " + s.text).all() as { detail: string }[]).map((p) => p.detail);
const byHandle = (rows: Row[]): Row[] => [...rows].sort((x, y) => String(x.handle).localeCompare(String(y.handle)));

// ------------------------------------------------------------------ seed

const SOL = 1399811149, ETH = 1, BASE = 8453;
const TOK = "0x00000000000000000000000000000000000000aa";
const TOK2 = "0x00000000000000000000000000000000000000bb";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // a quote asset: not counted in `tokens`
const MINT = "mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BTOK = "0x00000000000000000000000000000000000000cc";
const uuid = (digit: number): string => `${digit}`.repeat(8) + "-1111-4111-8111-111111111111";
const ID_A = uuid(1);

/* a: two chains read on chain, plus fomo rows; b: fomo only; c: one chain, nothing held; d: a stale build only; e: no rows at all. */
for (const [i, [h, display]] of [["a", "Alpha"], ["b", "Bravo"], ["c", "Charlie"], ["d", "Delta"], ["e", "Echo"]].entries()) {
  run("insert into traders (handle, display_handle, id) values (?,?,?)", h, display, uuid(i + 1));
}
run("insert into wallets (handle, evm_address, sol_address) values ('a','0xwa','SolA')");
run("insert into wallets (handle, evm_address, sol_address) values ('b','0xwb',null)");
for (const [net, key] of [[ETH, TOK], [ETH, TOK2], [ETH, USDC], [SOL, MINT], [BASE, BTOK]] as [number, string][]) {
  run("insert into tokens (network_id, address, token_key) values (?,?,?)", net, key, key);
}
const hold = (h: string, net: number, key: string, at: string, amount: number | null, value: number | null, source: string): void =>
  run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, value, source) values (?,?,?,?,?,?,?)",
    h, net, key, at, amount, value, source);
const F1 = "2026-09-10T00:00:00.000Z", F2 = "2026-09-12T00:00:00.000Z"; // fomo builds: F2 is the newest
const C1 = "2026-09-11T06:00:00.000Z", C2 = "2026-09-13T06:00:00.000Z"; // chain captures: older, newer
hold("a", ETH, TOK, C1, 5, 5, "chain");      // older capture: superseded
hold("a", ETH, TOK2, C1, 9, 9, "chain");     // held then, gone in the newer capture
hold("a", ETH, TOK, C2, 10, 10, "chain");
hold("a", ETH, USDC, C2, 3, 3, "chain");     // quote asset
hold("a", SOL, MINT, C1, 7, null, "chain");  // no price: null, never zero
hold("a", ETH, TOK2, F2, 1, 1, "fomo");      // (a, ethereum) was read on chain: fomo loses
hold("a", BASE, BTOK, F2, 2, 0, "fomo");     // never read on chain: fomo fills; a value of 0 is not priced
hold("b", ETH, TOK, F1, 4, 4, "fomo");       // an older build
hold("b", ETH, TOK, F2, 6, 6, "fomo");
hold("b", ETH, TOK2, F2, null, 2, "fomo");   // amount unknown
hold("c", SOL, MINT, C1, 0, null, "chain");  // read on chain, nothing held
hold("d", ETH, TOK, F1, 8, 8, "fomo");       // only in a stale build
const trade = (id: string, h: string, net: number | null, status: string, realized: number | null, entry: number | null, closedAt: string | null): void =>
  run(`insert into trades (trade_id, handle, network_id, token_address, token_key, token_symbol, status, amount,
         avg_entry_price, realized_pnl_usd, opened_at, closed_at, captured_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, h, net, TOK, TOK, "AA", status, 1, entry, realized, "2026-06-01T00:00:00.000Z", closedAt, F2);
trade("1", "a", ETH, "closed", 10, 1, "2026-06-02T00:00:00.000Z");
trade("2", "a", ETH, "closed", null, 1, "2026-07-02T00:00:00.000Z");
trade("3", "a", SOL, "closed", -4, null, "2026-08-02T00:00:00.000Z");
trade("4", "b", null, "closed", 3, 2, "2026-08-02T00:00:00.000Z"); // chain never established
trade("5", "b", BASE, "open", null, 2, null);

// ------------------------------------------------------------------ /aum: the sampler gauge

const SAMPLER_OLD = `
    select max(at) as last_at, max(sampled_at) as last_success
    from aum_samples where basis = 'sampled'`;
const sample = (h: string, at: string, usd: number | null, basis: string, sampledAt: string): void =>
  run("insert into aum_samples (handle, at, total_usd, basis, tier, sampled_at) values (?,?,?,?,'verified',?)", h, at, usd, basis, sampledAt);

Deno.test("the sampler gauge: two index-ordered maxima answer what the one aggregate did", async () => {
  /* First, with no samples at all: a row of nulls, not no row. The route's first call is the one that reads it. */
  const first = await call("GET", "/v2/traders/a/aum?live=false");
  assertEquals(first.status, 200);
  const gauge = theOne(first.issued, "as last_success");
  assertEquals(gauge.rows, old(SAMPLER_OLD));
  assertEquals(gauge.rows, [{ last_at: null, last_success: null }]);

  sample("a", "2026-09-01T00:00:00.000Z", 10, "sampled", "2026-09-01T00:00:05.000Z");
  sample("a", "2026-09-01T01:00:00.000Z", null, "sampled", "2026-09-01T01:00:05.000Z"); // refused: null, newest `at`
  sample("b", "2026-09-01T00:30:00.000Z", null, "sampled", "2026-09-01T01:00:05.000Z"); // a tie on sampled_at
  sample("c", "2026-09-05T00:00:00.000Z", 12, "rebuilt", "2026-09-06T00:00:00.000Z");   // rebuilt, and newer than every sampled row
  assertEquals(again(gauge), old(SAMPLER_OLD));
  assertEquals(again(gauge), [{ last_at: "2026-09-01T01:00:00.000Z", last_success: "2026-09-01T01:00:05.000Z" }]);

  /* `at` and `sampled_at` peak on different rows. */
  sample("b", "2026-08-01T00:00:00.000Z", 1, "sampled", "2026-09-02T00:00:00.000Z");
  assertEquals(again(gauge), old(SAMPLER_OLD));
  assertEquals(again(gauge)[0].last_success, "2026-09-02T00:00:00.000Z");
});

// ------------------------------------------------------------------ /aum: chain presence, and the directory rows

const presenceOld = (handles: string[]): Row[] => old(`
    select handle, count(distinct network_id) as chains,
           max(network_id = ?)  as on_solana,
           max(network_id <> ?) as on_evm
    from holdings_current where handle in (${handles.map(() => "?").join(", ")}) and human_amount > 0
    group by handle`, SOL, SOL, ...handles);

Deno.test("chain presence is not asked: knownChains holds every chain it named, and coverage says what it did", async () => {
  const ids = ["a", "b", "c", "d", "e"];
  const coverageNow = async (): Promise<void> => {
    const got = await call("POST", "/v2/traders/aum", { ids: [...ids, "ghost"] });
    assertEquals(got.status, 200);
    assert(!got.issued.some((s) => s.text.includes("as on_solana")), "one statement fewer per call");
    const presence = new Map(presenceOld(ids).map((r) => [r.handle, r]));
    for (const row of (got.json.traders as { ok: boolean; handle: string; aum: Row }[]).filter((r) => r.ok)) {
      const h = row.handle[0].toLowerCase();
      const known = row.aum.knownChains as { networkId: number; hasPositions: boolean }[];
      const p = presence.get(h);
      /* The old rule verbatim: the chain list when there is one, else presence — which never had a row then. */
      const wallets = known.length
        ? (known.some((c) => c.networkId !== SOL) ? 1 : 0) + (known.some((c) => c.networkId === SOL) ? 1 : 0)
        : (p?.on_evm ? 1 : 0) + (p?.on_solana ? 1 : 0);
      const coverage = row.aum.coverage as { totalWallets: number; totalChains: number };
      assertEquals([coverage.totalWallets, coverage.totalChains], [wallets, known.length], h);
      assertEquals(known.filter((c) => c.hasPositions).length, Number(p?.chains ?? 0), `${h}: every chain presence counted is a known chain`);
    }
  };
  await coverageNow();
  /* a: ethereum + solana + base (fomo fills base); b: ethereum from fomo; c holds nothing; d's build is stale; e has no rows. */
  assertEquals(byHandle(presenceOld(ids)), [
    { handle: "a", chains: 3, on_solana: 1, on_evm: 1 },
    { handle: "b", chains: 1, on_solana: 0, on_evm: 1 },
  ]);
  /* A chain read of (b, ethereum) lands and holds nothing: presence loses b, and so does hasPositions. */
  hold("b", ETH, TOK, C2, 0, null, "chain");
  assertEquals(presenceOld(ids).some((r) => r.handle === "b"), false);
  await coverageNow();
  run("delete from holdings where handle = 'b' and source = 'chain'");
});

Deno.test("the batch takes its directory rows from batchIds and answers the ids and handles the two lookups did", async () => {
  /* A handle, a display handle in another case, a stable id, an id nobody has, a handle nobody has. */
  const ids = ["a", "BRAVO", `trd_${uuid(3)}`, uuid(9), "ghost"];
  const got = await call("POST", "/v2/traders/aum", { ids });
  assertEquals(got.status, 200);
  const present = ["a", "b", "c"];
  const marks = present.map(() => "?").join(", ");
  const display = new Map(old(`select handle, display_handle from traders where handle in (${marks})`, ...present).map((r) => [r.handle, r.display_handle]));
  const idBy = new Map(old(`select handle, id from traders where handle in (${marks})`, ...present).map((r) => [r.handle, r.id ? String(r.id) : null]));
  const rows = got.json.traders as { ok: boolean; requested: string; id: string | null; handle: string | null }[];
  assertEquals(rows.map((r) => [r.requested, r.ok, r.handle, r.id]), [
    ["a", true, display.get("a"), idBy.get("a")],
    ["BRAVO", true, display.get("b"), idBy.get("b")],
    [ids[2], true, display.get("c"), idBy.get("c")],
    [ids[3], false, null, null],
    ["ghost", false, null, null],
  ]);
  assertEquals([rows[0].handle, rows[0].id, rows[2].handle, rows[2].id], ["Alpha", ID_A, "Charlie", uuid(3)]);
  /* The point of the change: the directory is not read again once batchIds has resolved the ids. */
  const lookups = got.issued.filter((s) => /from traders\b/.test(s.text));
  assert(lookups.every((s) => !/select handle, (display_handle|id) from traders/.test(s.text)), lookups.map((s) => s.text).join("\n"));

  const single = await call("GET", "/v2/traders/Alpha/aum?live=false");
  assertEquals([single.status, single.json.handle], [200, rows[0].handle]);
});

// ------------------------------------------------------------------ /chains

const CHAINS_OLD = `
    select c.network_id, c.name, c.history_provider,
           count(*)                                     as positions,
           count(distinct h.handle)                     as traders,
           count(distinct case when q.token_key is null
                               then h.token_key end)    as tokens,
           count(case when h.value > 0 then h.value end) as priced,
           sum(case when h.value > 0 then h.value end)   as total_value
    from chains c
    join holdings_current h on h.network_id = c.network_id
    left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    group by c.network_id, c.name, c.history_provider
    order by positions desc`;
const CHAINS_OLD_TOTAL = "select count(*) as total from holdings_current";
const CHAINS_OLD_ASOF = "select max(captured_at) as at from holdings_current";

/** What the route derives from the new rows, beside what the three old statements said. */
const chainsNow = (rows: Row[]): { rows: Row[]; total: number; asOf: unknown } => ({
  rows: rows.map(({ newest: _newest, ...rest }) => rest),
  total: rows.reduce((sum, r) => sum + Number(r.positions), 0),
  asOf: rows.map((r) => r.newest).sort().at(-1) ?? null,
});
const chainsOld = (): { rows: Row[]; total: number; asOf: unknown } => ({
  rows: old(CHAINS_OLD), total: Number(old(CHAINS_OLD_TOTAL)[0].total), asOf: old(CHAINS_OLD_ASOF)[0].at,
});

Deno.test("/chains reads holdings_current once, driven per (trader, chain), and answers what three passes of the view did", async () => {
  const expected = chainsOld();
  const got = await call("GET", "/v2/chains");
  assertEquals(got.status, 200);
  const stmt = theOne(got.issued, "as total_value");
  assertEquals(chainsNow(stmt.rows), expected);
  /* ethereum: a's newer capture (2) + b's newest build (2); base: a's fomo row; solana: a's and c's chain rows. */
  assertEquals(expected.rows.map((r) => [r.name, r.positions, r.traders, r.tokens, r.priced, r.total_value]), [
    ["ethereum", 4, 2, 2, 4, 21], ["solana", 2, 2, 1, 0, null], ["base", 1, 1, 1, 0, null],
  ]);
  assertEquals(got.issued.filter((s) => /holdings/.test(s.text)).length, 1, "one pass, not three");

  /* The body says the same as the old statements: count, newest capture, order and figures. */
  assertEquals([got.json.totalPositions, got.json.asOf], [expected.total, new Date(String(expected.asOf)).toISOString()]);
  assertEquals(
    (got.json.entries as { networkId: number; positions: number; traders: number; tokens: number; totalValueUsd: number | null }[])
      .map((e) => [e.networkId, e.positions, e.traders, e.tokens, e.totalValueUsd]),
    expected.rows.map((r) => [r.network_id, r.positions, r.traders, r.tokens, r.priced ? r.total_value : null]));

  /* A tie on positions, a newer chain capture that empties a chain, and a chain read that retires fomo rows. */
  hold("c", BASE, BTOK, C2, 1, 1, "chain");
  hold("b", ETH, TOK2, C2, 1, null, "chain");
  assertEquals(chainsNow(again(stmt)), chainsOld());
  assertEquals(chainsOld().total, 7);
  run("delete from holdings");
  assertEquals(chainsNow(again(stmt)), chainsOld());
  assertEquals(chainsOld(), { rows: [], total: 0, asOf: null });
});

// ------------------------------------------------------------------ /fields

const FIELDS_OLD = `
    with sc as (
      select t.handle,
        count(case when t.status = 'closed' then 1 end) as closed,
        count(case when t.status = 'closed' and t.realized_pnl_usd is not null then 1 end) as realized,
        count(case when t.avg_entry_price is not null and t.avg_entry_price > 0 then 1 end) as entry_px,
        count(distinct case when t.status = 'closed' then strftime('%Y-%m', t.closed_at) end) as months,
        count(case when t.status not in ('closed', 'closed_by_balance') and t.unrealized_pnl_usd is not null then 1 end) as unreal
      from trades t group by t.handle),
    w as (select handle from wallets where evm_address is not null or sol_address is not null),
    a as (select handle, count(case when total_usd is not null then 1 end) as pts
          from aum_samples group by handle)
    select
      (select count(*) from traders)                                as traders,
      (select count(*) from w)                                      as with_wallet,
      (select count(*) from sc where closed > 0)                    as with_closed,
      (select count(*) from sc where realized > 0)                  as with_realized,
      (select count(*) from sc where closed > 0 and realized = closed) as realized_complete,
      (select count(*) from sc where entry_px > 0)                  as with_entry_px,
      (select count(*) from sc where entry_px >= 20)                as entry_px_20,
      (select count(*) from sc where months >= 3)                   as months_3,
      (select count(*) from sc where unreal > 0)                    as with_unrealized,
      (select count(*) from a where pts > 0)                        as with_reading`;

Deno.test("/fields counts the traders with a figured reading by seeking each one, and every fill rate is unchanged", async () => {
  const got = await call("GET", "/v2/fields");
  assertEquals(got.status, 200);
  const stmt = theOne(got.issued, "as with_reading");
  assertEquals(stmt.rows, old(FIELDS_OLD));
  /* a has a figure beside a refusal, b (by now) one figure, c a rebuilt figure; d and e have no reading. */
  assertEquals([stmt.rows[0].with_reading, stmt.rows[0].traders, stmt.rows[0].months_3], [3, 5, 1]);

  run("delete from aum_samples where total_usd is not null and handle <> 'c'"); // a and b: refusals only
  assertEquals(again(stmt), old(FIELDS_OLD));
  assertEquals(again(stmt)[0].with_reading, 1);
  run("delete from aum_samples");
  assertEquals(again(stmt), old(FIELDS_OLD));
  assertEquals(again(stmt)[0].with_reading, 0);
});

// ------------------------------------------------------------------ /aum/history: the rollups

const historyOld = (view: string, handles: string[]): string => `
        select handle, at, total_usd, high_usd, low_usd, valued_hours from (
          select handle, bucket as at, total_usd, high_usd, low_usd, valued_hours,
                 row_number() over (partition by handle order by bucket desc) as rn
          from ${view}
          where handle in (${handles.map(() => "?").join(", ")})
            and bucket <= ?
            and (? is null or bucket >= ?)
        ) x where rn <= ?
        order by handle, at`;
const VIEWS: [string, string][] = [["1d", "aum_history_daily"], ["1w", "aum_history_weekly"], ["1mo", "aum_history_monthly"]];

/** The route also reads the close's counts, and binds the publish floor and an hour bound ahead of the view's four. */
const asTheViewDid = (rows: Row[]): Row[] => rows.map(({ priced_positions: _p, total_positions: _t, ...rest }) => rest);
const viewParams = (s: Issued, handles: string[]): Bind[] => [...handles, ...s.params.slice(-4)];

Deno.test("a rollup step reads the asked handles' hours, and answers what the whole-table rollup view did", async () => {
  /* Every hour here is fully priced, so the view is right; tests/aum_fixes_test.ts pins the hours where it is not. */
  const hour = (h: string, at: string, usd: number | null): void =>
    run("insert into aum_history (handle, hour, total_usd, priced_positions, total_positions, basis) values (?,?,?,1,1,'priced')", h, at, usd);
  hour("a", "2026-08-30T22:00:00.000Z", 5);    // a Sunday: the week before
  hour("a", "2026-08-31T23:00:00.000Z", 20);   // Monday, still August
  hour("a", "2026-09-01T00:00:00.000Z", 30);
  hour("a", "2026-09-01T03:00:00.000Z", 30);   // a tie for the day's high
  hour("a", "2026-09-01T05:00:00.000Z", null); // the day's LAST hour is not valued: the close is 03:00's
  hour("a", "2026-09-02T00:00:00.000Z", null); // a day with no valued hour at all
  hour("b", "2026-09-01T00:00:00.000Z", 7);
  hour("c", "2026-09-01T00:00:00.000Z", 99);   // never asked for: must not leak in
  const range = "from=2026-08-01T00:00:00.000Z&to=2026-09-10T00:00:00.000Z";

  for (const [step, view] of VIEWS) {
    for (const limit of [2000, 1]) {
      const got = await call("GET", `/v2/traders/a/aum/history?step=${step}&limit=${limit}&${range}`);
      assertEquals(got.status, 200);
      const stmt = theOne(got.issued, "as valued_hours");
      assert(!stmt.text.includes(view), "the view is no longer read");
      assert(planOf(stmt).some((d) => d.startsWith("SEARCH aum_history") && d.includes("(handle=?")), planOf(stmt).join("\n"));
      assert(!planOf(stmt).some((d) => d.startsWith("SCAN aum_history")), planOf(stmt).join("\n"));
      assertEquals(asTheViewDid(stmt.rows), old(historyOld(view, ["a"]), ...viewParams(stmt, ["a"])), `${step} limit=${limit}`);
      assert(stmt.rows.length > 0);
    }
    /* The batch: two traders with hours, one with none, one unknown; and an open-ended range. */
    for (const body of [{ from: "2026-08-01T00:00:00.000Z", to: "2026-09-10T00:00:00.000Z" }, { window: "all" }]) {
      const got = await call("POST", "/v2/traders/aum/history", { ids: ["a", "b", "e", "ghost"], step, ...body });
      assertEquals(got.status, 200);
      const stmt = theOne(got.issued, "as valued_hours");
      assertEquals(asTheViewDid(stmt.rows), old(historyOld(view, ["a", "b", "e", "ghost"]), ...viewParams(stmt, ["a", "b", "e", "ghost"])), `${step} batch`);
      assertEquals(new Set(stmt.rows.map((r) => r.handle)), new Set(["a", "b"]));
    }
  }
  /* The daily close, high and low, spelled out once. */
  const day = old(historyOld("aum_history_daily", ["a"]), "a", "2026-09-10T00:00:00.000Z", null, null, 2000);
  assertEquals(day.map((r) => [r.at, r.total_usd, r.high_usd, r.low_usd, r.valued_hours]), [
    ["2026-08-30T00:00:00.000Z", 5, 5, 5, 1], ["2026-08-31T00:00:00.000Z", 20, 20, 20, 1],
    ["2026-09-01T00:00:00.000Z", 30, 30, 30, 2], ["2026-09-02T00:00:00.000Z", null, null, null, 0],
  ]);
});
