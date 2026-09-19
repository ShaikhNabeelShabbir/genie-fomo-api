import { assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { getDefaultSql } from "../supabase/functions/api/db.ts";
import {
  type CoinSink, type InfoTarget, RELAY_BATCH_MAX, applyRelayResults, gmgnData, missesAfterFirstStore, parseRelayResults, readCoins,
} from "../worker/src/jobs/tokens-core.ts";

const SECURITY = { is_honeypot: true, is_open_source: null, is_renounced: null, renounced_mint: null, renounced_freeze: null, is_blacklisted: null, can_not_sell: false, buy_tax: 0.01, sell_tax: null, rug_ratio: null, burn_ratio: null };

Deno.test("parseRelayResults: what arrives from outside is checked field by field before it becomes rows", () => {
  const good = { network_id: 1, token_key: "0xaa", chain: "ethereum", info: { symbol: "AA" }, security: SECURITY };
  const miss = { network_id: 1, token_key: "0xbb", chain: "ethereum", nothing: "token not found" };
  const { ok, rejected } = parseRelayResults({ results: [
    good, miss,
    { ...good, chain: "dogechain" },                               // a chain GMGN's map does not know
    { ...good, network_id: "1" },                                  // a string where an integer belongs
    { ...good, token_key: "x".repeat(101) },
    { ...good, info: "not a document" },
    { ...good, security: { ...SECURITY, is_honeypot: "yes" } },    // a flag that is not a boolean
    { ...good, security: { ...SECURITY, buy_tax: Infinity } },
    "not an object",
  ] });
  assertEquals(ok.length, 2);
  assertEquals(rejected.map((r) => r.index), [2, 3, 4, 5, 6, 7, 8]);
  assertEquals(parseRelayResults({ results: [{ ...good, security: null }] }).ok.length, 1, "a coin read without its security half is still a read");
  assertEquals(parseRelayResults(null).rejected[0].why, "body must be { results: [...] }");
  assertEquals(parseRelayResults({ results: Array.from({ length: RELAY_BATCH_MAX + 1 }, () => good) }).ok.length, 0, "an oversized batch is refused whole");
});

Deno.test("applyRelayResults: the Worker writes what was read elsewhere, with the job's own statements, and creates no coin", async () => {
  const db = await openSchema();
  const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
  run("insert into tokens (network_id, address, token_key) values (1,'0xAA','0xaa')");
  run("insert into tokens (network_id, address, token_key) values (1,'0xBB','0xbb')");
  const sql = getDefaultSql()!;
  const applied = await applyRelayResults(sql, parseRelayResults({ results: [
    { network_id: 1, token_key: "0xaa", chain: "ethereum", info: { symbol: "AA", name: "Alpha", price: { price: "2.5" }, holder_count: 12 }, security: SECURITY },
    { network_id: 1, token_key: "0xbb", chain: "ethereum", nothing: "token not found" },
    { network_id: 1, token_key: "0xnot_ours", chain: "ethereum", info: { symbol: "ZZ" }, security: null },
  ] }).ok);
  assertEquals(applied, { stored: 1, missed: 1, flipped: 1, unknown: 1, failed: 0 });
  const info = db.prepare("select symbol, price_usd, is_honeypot, honeypot_since is not null as flagged, fetched_at is not null as read, security_fetched_at is not null as sec from token_info where token_key = '0xaa'").get() as Record<string, unknown>;
  assertEquals(info, { symbol: "AA", price_usd: 2.5, is_honeypot: 1, flagged: 1, read: 1, sec: 1 });
  assertEquals((db.prepare("select count(*) as n from token_info").get() as { n: number }).n, 1, "the coin we hold no tokens row for wrote nothing");
  assertEquals((db.prepare("select detail from token_info_misses where token_key = '0xbb'").get() as { detail: string }).detail, "token not found");
  // storeInfo tells a first flip by its millisecond stamp; reads are 1.1 s apart in life, so give the test its own millisecond.
  await new Promise((r) => setTimeout(r, 5));
  const again = await applyRelayResults(sql, parseRelayResults({ results: [{ network_id: 1, token_key: "0xaa", chain: "ethereum", info: { symbol: "AA2" }, security: null }] }).ok);
  assertEquals(again, { stored: 1, missed: 0, flipped: 0, unknown: 0, failed: 0 }, "a second read updates; the first flip is not counted twice");
  const kept = db.prepare("select symbol, is_honeypot, honeypot_since is not null as flagged from token_info where token_key = '0xaa'").get() as Record<string, unknown>;
  assertEquals(kept, { symbol: "AA2", is_honeypot: 1, flagged: 1 }, "a read without its security half leaves yesterday's security, and its first-flip stamp, standing");
  // The chain is OURS to say: a Solana-normalised block must not land on an Ethereum coin because the body said 'solana'.
  const wrongChain = await applyRelayResults(sql, parseRelayResults({ results: [{ network_id: 1, token_key: "0xaa", chain: "solana", info: { symbol: "EVIL" }, security: null }] }).ok);
  assertEquals(wrongChain, { stored: 0, missed: 0, flipped: 0, unknown: 1, failed: 0 });
  assertEquals((db.prepare("select symbol from token_info where token_key = '0xaa'").get() as { symbol: string }).symbol, "AA2");
});

Deno.test("readCoins: the one loop both readers run — a good read is stored, 'nothing' is a miss, five refusals end the run", async () => {
  const target = (k: string, chain = "solana"): InfoTarget => ({ network_id: 1, token_key: k, address: k, chain });
  const stored: string[] = [], missed: string[] = [];
  const sink: CoinSink = { store: (t) => { stored.push(t.token_key); return Promise.resolve(false); }, miss: (t, d) => { missed.push(`${t.token_key}:${d}`); return Promise.resolve(); } };
  const original = globalThis.fetch, logs = [console.error, console.warn, console.log];
  console.error = console.warn = console.log = () => undefined;
  const answers: Record<string, () => Response> = {
    good: () => Response.json({ code: 0, data: { symbol: "G" } }),
    unknown: () => Response.json({ code: 40004, message: "token not found" }),
    refused: () => new Response("rate limited", { status: 429 }),
  };
  globalThis.fetch = ((input: string | URL | Request) => Promise.resolve(answers[new URL(String(input)).searchParams.get("address")!.split("-")[0]]())) as typeof fetch;
  try {
    const mixed = await readCoins([target("good-1"), target("unknown-1"), target("x", "dogechain"), target("good-2")], "k", () => false, sink, 0);
    assertEquals([stored, missed], [["good-1", "good-2"], ["unknown-1:token not found"]]);
    assertEquals(mixed, { attempted: 4, ok: 2, errored: 0, unresolved: 2, remaining: 0, flipped: 0 });
    const refused = await readCoins(Array.from({ length: 9 }, (_v, i) => target(`refused-${i}`)), "k", () => false, sink, 0);
    assertEquals([refused.attempted, refused.errored, refused.remaining, refused.ok], [5, 5, 4, 0], "it stops at five and says how many it never asked");
  } finally {
    globalThis.fetch = original;
    [console.error, console.warn, console.log] = logs;
  }
});

Deno.test("what is not a document is not stored: an empty one, one with no symbol, name or price, a security block of nulls", () => {
  const nulls = Object.fromEntries(Object.keys(SECURITY).map((k) => [k, null]));
  const base = { network_id: 1, token_key: "0xaa", chain: "ethereum" };
  assertEquals(parseRelayResults({ results: [{ ...base, info: {}, security: null }] }).rejected.length, 1, "{} would write a row of NULLs over a good one");
  assertEquals(parseRelayResults({ results: [{ ...base, info: { unrelated: true }, security: null }] }).rejected.length, 1);
  const [kept] = parseRelayResults({ results: [{ ...base, info: { symbol: "AA" }, security: nulls }] }).ok;
  assertEquals("info" in kept ? kept.security : "miss", null, "a block of nulls is no block: yesterday's honeypot flag must stand");
  let threw = "";
  try { gmgnData(true, 200, { code: 0, data: {} }); } catch (e) { threw = (e as Error).message; }
  assertEquals(threw, "empty document");
  assertEquals(parseRelayResults({ results: [{ ...base, chain: "constructor", info: { symbol: "AA" }, security: null }] }).rejected.length, 1, "own names only");
});

Deno.test("missesAfterFirstStore: 'GMGN has nothing' is believed only in a run that also stored a real document", async () => {
  const target = (k: string): InfoTarget => ({ network_id: 1, token_key: k, address: k, chain: "solana" });
  const log: string[] = [];
  const inner: CoinSink = { store: (t) => { log.push(`store:${t.token_key}`); return Promise.resolve(true); }, miss: (t, d) => { log.push(`miss:${t.token_key}:${d}`); return Promise.resolve(); } };
  /* A reader-side fault: EVERY coin answers "nothing". Nothing may be parked, and the run can say what it withheld. */
  const broken = missesAfterFirstStore(inner);
  for (const k of ["a", "b", "c"]) await broken.sink.miss(target(k), "HTTP 400");
  assertEquals([log, broken.held().map((m) => m.t.token_key)], [[], ["a", "b", "c"]]);
  /* A healthy run: two unknown coins at the head, then a real document. The misses are real and are recorded, in order, after it. */
  const healthy = missesAfterFirstStore(inner);
  await healthy.sink.miss(target("u1"), "token not found");
  await healthy.sink.miss(target("u2"), "token not found");
  assertEquals(await healthy.sink.store(target("good"), { symbol: "G" }, null), true, "the inner sink's answer is passed through");
  await healthy.sink.miss(target("u3"), "token not found");
  assertEquals(log, ["store:good", "miss:u1:token not found", "miss:u2:token not found", "miss:u3:token not found"]);
  assertEquals(healthy.held().length, 0);
});

Deno.test("readCoins: a refusal streak is broken by a good read, the budget ends it, and one unstorable coin does not", async () => {
  const target = (k: string): InfoTarget => ({ network_id: 1, token_key: k, address: k, chain: "solana" });
  const original = globalThis.fetch, logs = [console.error, console.warn, console.log];
  console.error = console.warn = console.log = () => undefined;
  globalThis.fetch = ((input: string | URL | Request) => {
    const kind = new URL(String(input)).searchParams.get("address")!.split("-")[0];
    return Promise.resolve(kind === "refused" ? new Response("no", { status: 429 }) : Response.json({ code: 0, data: { symbol: "G" } }));
  }) as typeof fetch;
  const ok: CoinSink = { store: () => Promise.resolve(false), miss: () => Promise.resolve() };
  try {
    const nine = [...[0, 1, 2, 3].map((i) => target(`refused-${i}`)), target("good-0"), ...[4, 5, 6, 7].map((i) => target(`refused-${i}`))];
    assertEquals((await readCoins(nine, "k", () => false, ok, 0)).attempted, 9, "four, a good read, four: never five in a row");
    let asked = 0;
    const budget = await readCoins([target("good-1"), target("good-2"), target("good-3")], "k", () => asked++ >= 2, ok, 0);
    assertEquals([budget.attempted, budget.remaining], [2, 1]);
    const failing: CoinSink = { store: (t) => (t.token_key === "good-bad" ? Promise.reject(new Error("D1_ERROR")) : Promise.resolve(false)), miss: () => Promise.resolve() };
    const carried = await readCoins([target("good-bad"), target("good-fine")], "k", () => false, failing, 0);
    assertEquals([carried.errored, carried.ok, carried.attempted], [1, 1, 2]);
  } finally {
    globalThis.fetch = original;
    [console.error, console.warn, console.log] = logs;
  }
});
