import { assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { getDefaultSql } from "../supabase/functions/api/db.ts";
import {
  type CoinSink, type InfoTarget, RELAY_BATCH_MAX, applyRelayResults, parseRelayResults, readCoins,
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
  assertEquals(applied, { stored: 1, missed: 1, flipped: 1, unknown: 1 });
  const info = db.prepare("select symbol, price_usd, is_honeypot, honeypot_since is not null as flagged, fetched_at is not null as read, security_fetched_at is not null as sec from token_info where token_key = '0xaa'").get() as Record<string, unknown>;
  assertEquals(info, { symbol: "AA", price_usd: 2.5, is_honeypot: 1, flagged: 1, read: 1, sec: 1 });
  assertEquals((db.prepare("select count(*) as n from token_info").get() as { n: number }).n, 1, "the coin we hold no tokens row for wrote nothing");
  assertEquals((db.prepare("select detail from token_info_misses where token_key = '0xbb'").get() as { detail: string }).detail, "token not found");
  // storeInfo tells a first flip by its millisecond stamp; reads are 1.1 s apart in life, so give the test its own millisecond.
  await new Promise((r) => setTimeout(r, 5));
  const again = await applyRelayResults(sql, parseRelayResults({ results: [{ network_id: 1, token_key: "0xaa", chain: "ethereum", info: { symbol: "AA2" }, security: null }] }).ok);
  assertEquals(again, { stored: 1, missed: 0, flipped: 0, unknown: 0 }, "a second read updates; the first flip is not counted twice");
  const kept = db.prepare("select symbol, is_honeypot from token_info where token_key = '0xaa'").get() as Record<string, unknown>;
  assertEquals(kept, { symbol: "AA2", is_honeypot: 1 }, "a read without its security half leaves yesterday's security standing");
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
