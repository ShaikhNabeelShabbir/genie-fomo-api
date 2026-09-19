import { assert, assertEquals } from "jsr:@std/assert@1";
import { DatabaseSync } from "node:sqlite";
import { d1sql, type D1Like, type D1Statement } from "../worker/src/d1.ts";
import { setDefaultSql } from "../supabase/functions/api/db.ts";
import { handle } from "../supabase/functions/api/app.ts";
import { registeredRoutes } from "../supabase/functions/api/router.ts";
import "../supabase/functions/api/routes.ts";

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

const ROSTER = 220; // larger than INCLUDE_PAGE_MAX (200), so a cap is observable, not vacuous
const SOL = 1399811149;
const TOKEN = "0x00000000000000000000000000000000000000aa";
const MINT = "mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function open(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
  const dir = new URL("../worker/d1/migrations/", import.meta.url);
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.name.endsWith(".sql")) files.push(e.name);
  for (const f of files.sort()) db.exec(await Deno.readTextFile(new URL(f, dir)));
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
  setDefaultSql(d1sql(like));
  return db;
}

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

const call = (method: string, path: string, body?: unknown): Promise<Response> =>
  handle(new Request(`https://test.local${path}`, {
    method,
    headers: { "content-type": "application/json", "user-agent": "routes-sql-test/1.0" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));

const db = await open();
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
