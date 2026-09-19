import { assert, assertEquals } from "jsr:@std/assert@1";
import type { DatabaseSync } from "node:sqlite";
import { openSchema } from "./_sqlite_harness.ts";
import { ACCEPTED_WHOLE_READS } from "./accepted_whole_reads.ts";
import { handle } from "../supabase/functions/api/app.ts";
import { registeredRoutes } from "../supabase/functions/api/router.ts";
import "../supabase/functions/api/routes.ts";
import { knownChainsFor } from "../supabase/functions/api/shared/chains.ts";

/*
 * EVERY ROUTE'S SQL, EXECUTED — through the real app, the real shim and the real D1 migrations
 * in SQLite. Written after the 19 Sep 2026 outage, which two defects caused and no test could
 * see, because every other test of a route exercises a pure body-builder:
 *   - /traders?include=…&limit=100 bound 101 and 200 parameters against D1's 100 (no test used a
 *     page above 10);
 *   - /portfolio selected `ps.last_usd` from a table it never joined, and failed on every call
 *     for two days.
 * A route that reaches the database and gets a SQL error answers 5xx here, and this file fails.
 */

/** Every statement the sweep issued, and the routes that issued it — read by the plan audit at the end. */
const SEEN = new Map<string, Set<string>>();
const ROUTE = { now: "seed" };
const ROSTER = 220; // larger than INCLUDE_PAGE_MAX (200), so a cap is observable, not vacuous
const SOL = 1399811149;
const TOKEN = "0x00000000000000000000000000000000000000aa";
const MINT = "mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function seed(db: DatabaseSync): void {
  const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
  const now = new Date().toISOString();
  const has = (table: string): boolean =>
    db.prepare("select count(*) n from " + table).get() !== undefined;
  if (!(db.prepare("select count(*) n from chains").get() as { n: number }).n) {
    run("insert into chains (network_id, name, native_symbol) values (1,'ethereum','ETH')");
    run("insert into chains (network_id, name, native_symbol) values (?,'solana','SOL')", SOL);
  }
  has("chains");
  run("insert into builds (captured_at, window_label, trader_count, holding_count) values (?,?,?,?)", now, "24h", ROSTER, ROSTER);
  run("insert into tokens (network_id, address, token_key, total_supply) values (1,?,?,1000000)", TOKEN, TOKEN);
  run("insert into tokens (network_id, address, token_key, total_supply) values (?,?,?,1000000)", SOL, MINT, MINT);
  run("insert into token_info (network_id, token_key, price_usd, liquidity_usd, total_supply) values (1,?,2,1000000,1000000)", TOKEN);
  run("insert into token_prices (network_id, token_key, day, usd, source) values (1,?,?,2,'t')", TOKEN, now.slice(0, 10));
  for (let i = 0; i < ROSTER; i++) {
    const h = `t${i}`;
    run("insert into traders (handle, display_handle, id) values (?,?,?)", h, `T${i}`, `id-${i}`);
    run("insert into wallets (handle, evm_address, sol_address) values (?,?,?)", h, `0xw${i}`, `Sol${i}`);
    run("insert into trader_stats (handle, captured_at, rank, pnl_usd, volume_usd, trade_count, followers) values (?,?,?,?,?,?,?)",
      h, now, i + 1, 1000 - i, 5000, 10, 3);
    run(`insert into trades (trade_id, handle, network_id, token_address, token_key, token_symbol, status, amount,
           avg_entry_price, avg_exit_price, realized_pnl_usd, opened_at, closed_at, captured_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `tr-${i}`, h, 1, TOKEN, TOKEN, "AA", "closed", 10, 1, 2, 10, "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z", now);
    run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, source) values (?,?,?,?,?,'chain')",
      h, 1, TOKEN, now, 5);
  }
}

/** Parameters a route REQUIRES; without them it answers 400 before reaching its SQL. */
const REQUIRED: Record<string, string> = { "/flow": "?since=2026-09-01T00:00:00.000Z" };
const fill = (pattern: string): string => {
  const path = pattern.replace("/v1/", "/v2/").replace(":handle", "t1").replace(":address", TOKEN);
  const extra = Object.entries(REQUIRED).find(([suffix]) => path.endsWith(suffix));
  return path + (extra ? extra[1] : "");
};

const call = (method: string, path: string, body?: unknown): Promise<Response> => {
  ROUTE.now = `${method} ${path.replace(/\?.*/, "").replace("/v2/", "/")}`;
  return handle(new Request(`https://test.local${path}`, {
    method,
    headers: { "content-type": "application/json", "user-agent": "routes-sql-test/1.0" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
};

const db = await openSchema((text) => (SEEN.get(text) ?? SEEN.set(text, new Set()).get(text)!).add(ROUTE.now));
seed(db);

Deno.test("every registered route executes its SQL against the real schema without a server error", async () => {
  const failures: string[] = [];
  const ids = Array.from({ length: 50 }, (_v, i) => `t${i}`);
  for (const r of registeredRoutes()) {
    if (r.method === "POST" && r.pattern.endsWith("/wallets")) continue; // the one route that writes
    const path = fill(r.pattern);
    const body = r.method !== "POST" ? undefined
      : r.pattern.includes("/tokens/") ? { addresses: [TOKEN] }
      : { ids, since: "2026-09-01T00:00:00.000Z" };
    const res = await call(r.method, path, body);
    if (res.status === 400) failures.push(`${r.method} ${path} -> 400: the sweep never reached this route's SQL`);
    if (res.status >= 500) {
      const text = await res.text();
      // `include_unavailable` and friends are deliberate 503s about DATA; a SQL fault is not.
      if (!/include_unavailable|not_configured/.test(text)) failures.push(`${r.method} ${path} -> ${res.status} ${text.slice(0, 160)}`);
    } else {
      await res.body?.cancel();
    }
  }
  assertEquals(failures, []);
});

Deno.test("the trader list serves every include at the largest page, and with no limit at all", async () => {
  /* 19 Sep: limit=100 bound 101 (knownChainsFor) and 200 (scorecardRows); no limit bound 448. */
  for (const q of [
    "include=wallets,scorecard&limit=100&offset=0",
    "include=pnl,scorecard,wallets,trust&limit=200",
    "include=wallets,scorecard,pnl,trust",
  ]) {
    const res = await call("GET", `/v2/traders?${q}`);
    const bodyText = await res.text();
    assertEquals(res.status, 200, `${q} -> ${bodyText.slice(0, 200)}`);
    const d = JSON.parse(bodyText) as {
      count: number; total?: number; nextCursor: string | null; entries: { included?: Record<string, unknown> }[];
    };
    /* limit=100 -> 100; limit=200 -> 200; NO limit with includes -> the default page of 100. */
    assertEquals(d.count, q.includes("limit=200") ? 200 : 100, q);
    assertEquals(d.total, ROSTER, "a truncated page must say how many there are");
    assert(d.nextCursor !== null, "and how to get the rest");
    assert(d.entries.every((e) => e.included && "wallets" in e.included && "scorecard" in e.included),
      "every trader must carry its wallets and its scorecard");
  }
});

Deno.test("only a page WITH includes is bounded; the plain list still serves the whole directory", async () => {
  /* The consumer's hourly directory sync is `?limit=500`, one call (Field_Contracts.md §0). */
  const plain = await (await call("GET", "/v2/traders?limit=500")).json() as { count: number };
  assertEquals(plain.count, ROSTER);
  const all = await (await call("GET", "/v2/traders")).json() as { count: number };
  assertEquals(all.count, ROSTER);
  const bounded = await (await call("GET", "/v2/traders?include=wallets&limit=100000")).json() as { count: number };
  assertEquals(bounded.count, 200);
});

Deno.test("/trades at its default and maximum page sizes does not overflow on fee hashes", async () => {
  const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
  const key = String((db.prepare("select evm_address_key k from wallets where handle = 't1'").get() as { k: string }).k);
  for (let i = 0; i < 520; i++) {
    run(`insert into wallet_swaps (network_id, tx_hash, address_key, block_time, token_key, token_delta, quote_usd)
         values (1,?,?,?,?,?,?)`, `0xhash${i}`, key, new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(), TOKEN, 1, -2);
  }
  for (const q of ["", "?limit=100", "?limit=500"]) {
    const res = await call("GET", `/v2/traders/t1/trades${q}`);
    const text = await res.text();
    assertEquals(res.status, 200, `/trades${q} -> ${text.slice(0, 200)}`);
  }
});

Deno.test("knownChainsFor answers exactly what the trader_chain_history view does, without reading the view", async () => {
  const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
  const sample = (h: string, at: string, usd: number | null): void => {
    run("insert into aum_samples (handle, at, total_usd, basis, tier) values (?,?,?,'sampled','verified')", h, at, usd);
    run("insert into aum_chain_samples (handle, at, basis, network_id, total_usd) values (?,?,'sampled',?,?)", h, at, SOL, usd);
  };
  sample("t1", "2026-09-01T00:00:00.000Z", 10); sample("t1", "2026-09-01T01:00:00.000Z", 11); sample("t1", "2026-09-01T02:00:00.000Z", 12); // ready
  sample("t2", "2026-09-01T00:00:00.000Z", 10); // warming
  sample("t3", "2026-09-01T00:00:00.000Z", null); // a refused sample is no evidence of the chain
  const asked = ["t1", "t2", "t3", "t4", "nobody"];
  const view = db.prepare(`select h.handle, h.chain, h.network_id, h.positions, h.history_state
    from trader_chain_history h where h.handle in ('t1','t2','t3','t4','nobody') order by h.handle, h.chain`).all() as Record<string, unknown>[];
  const expected = view.map((r) => `${r.handle}|${r.chain}|${r.network_id}|${Number(r.positions) > 0}|${r.history_state}`);
  const got = [...(await knownChainsFor(asked)).entries()]
    .flatMap(([h, list]) => list.map((c) => `${h}|${c.chain}|${c.networkId}|${c.hasPositions}|${c.historyState}`));
  assertEquals(got, expected);
  assert(expected.includes(`t1|solana|${SOL}|false|ready`) && expected.includes(`t2|solana|${SOL}|false|warming`));
  assert(!expected.some((e) => e.startsWith("t3|solana")));
});

/*
 * THE PLAN AUDIT. D1 bills CPU per statement, has no statistics and no planner hints, and runs one
 * statement at a time — so a request that reads a whole table is an outage waiting for traffic
 * (19 Sep 2026: one page of wallets aggregated all of `trades`). Local SQLite plans the same way
 * D1 does (neither has ANALYZE data), so every statement the sweep issued is EXPLAINed here and a
 * whole-table read must be on the list below, with the reason it is tolerable. Shrink the list;
 * do not grow it without measuring the table.
 */
const SMALL_TABLES = new Set(["chains", "builds", "quote_assets", "traders", "wallets", "linked_wallets", "creators"]);
const LOW_CARDINALITY = /^\((?:(?:source|network_id|basis|status|tx_type|tier|direction)=\?(?: AND )?)+\)$/;
/** `latest_capture` is max(captured_at) on (source, captured_at desc): one seek, though the plan line reads like a range. */
const ONE_SEEK = new Set(["SEARCH holdings USING COVERING INDEX holdings_source_capture_idx (source=?)"]);
Deno.test("no route reads a whole table unless the read is on the accepted list", () => {
  const tables = new Set((db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((r) => r.name));
  const viewSql = (db.prepare("select sql from sqlite_master where type = 'view'").all() as { sql: string }[]).map((r) => r.sql).join(" ");
  const indexTable = new Map((db.prepare("select name, tbl_name from sqlite_master where type = 'index'").all() as { name: string; tbl_name: string }[])
    .map((r) => [r.name, r.tbl_name]));
  const NOT_AN_ALIAS = /^(on|where|left|join|group|order|using|cross|inner|limit|union|indexed)$/i;
  /** alias -> every relation it names, in the statement or in a view the planner may have flattened into it. */
  const aliases = (text: string): Map<string, Set<string>> => {
    const m = new Map<string, Set<string>>();
    for (const x of text.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/gi)) {
      const alias = x[2] && !NOT_AN_ALIAS.test(x[2]) ? x[2] : x[1];
      (m.get(alias) ?? m.set(alias, new Set()).get(alias)!).add(x[1]);
    }
    return m;
  };
  const found = new Set<string>();
  for (const [text, routes] of SEEN) {
    if (/^\s*(insert|update|delete|replace)/i.test(text)) continue;
    const plan = db.prepare("explain query plan " + text).all() as { detail: string }[];
    /* The statement's OWN binding of an alias wins; view SQL is consulted only for aliases it does not define
       (a view flattened into it). Mixing the two blamed `transactions t` in a view for a scan of `traders t`. */
    const own = aliases(text), fromViews = aliases(viewSql);
    const names = new Map([...fromViews, ...own]);
    for (const { detail } of plan) {
      const step = /^(SCAN|SEARCH) ([a-z_0-9]+)(?: USING (?:COVERING )?INDEX (\S+)(?: (\(.*\)))?)?/i.exec(detail);
      if (!step || ONE_SEEK.has(detail)) continue;
      const whole = step[1] === "SCAN" || (step[4] !== undefined && LOW_CARDINALITY.test(step[4]));
      if (!whole) continue;
      const candidates = step[3] && indexTable.has(step[3]) ? [indexTable.get(step[3])!] : [...(names.get(step[2]) ?? [step[2]])];
      for (const table of candidates) {
        if (!tables.has(table) || SMALL_TABLES.has(table)) continue;
        for (const r of routes) if (r !== "seed") found.add(`${r} | ${table}`);
      }
    }
  }
  const unexpected = [...found].filter((k) => !(k in ACCEPTED_WHOLE_READS)).sort();
  const stale = Object.keys(ACCEPTED_WHOLE_READS).filter((k) => !found.has(k)).sort();
  assertEquals({ unexpected, stale }, { unexpected: [], stale: [] });
});
