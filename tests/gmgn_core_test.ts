import { assertEquals } from "jsr:@std/assert@1";
import { blank, clean, fold, group, handleFor, newTraders, num, walletFrom } from "../worker/src/jobs/gmgn-core.ts";

/* Cases derived from scripts/load_gmgn_traders.mjs (blank, handleFor, group) and scripts/load_gmgn_trades.mjs (clean, num, fold). */

Deno.test("blank: empty and whitespace strings are missing; null is never a value", () => {
  assertEquals(blank(""), null);
  assertEquals(blank("  "), null);
  assertEquals(blank(null), null);
  assertEquals(blank(7), null);
  assertEquals(blank("alice"), "alice");
});

Deno.test("clean: strips real and escaped NUL bytes; an emptied symbol is null", () => {
  assertEquals(clean("ab\u0000c"), "abc");
  assertEquals(clean("x\\u0000"), "x");
  assertEquals(clean("\u0000"), null);
  assertEquals(clean(12), null);
});

Deno.test("num: numbers and numeric strings; null, empty and booleans are absent, never 0", () => {
  assertEquals(num("12.5"), 12.5);
  assertEquals(num(0), 0);
  assertEquals(num(null), null);
  assertEquals(num(""), null);
  assertEquals(num(true), null);
  assertEquals(num("abc"), null);
});

Deno.test("walletFrom: maker required; empty twitter is missing; name falls back", () => {
  assertEquals(walletFrom({ maker_info: {} }, "sol"), null);
  const w = walletFrom({ maker: "So1", maker_info: { twitter_username: "", twitter_name: "", name: "N", tags: ["kol", 3] } }, "sol");
  assertEquals(w, { chain: "sol", wallet: "So1", twitter: null, name: "N", avatar: null, tags: ["kol"] });
});

Deno.test("group: one twitter handle is one person across chains; wallets without one stay separate", () => {
  const rows = [
    { chain: "sol", wallet: "S1", twitter: "Ann", name: null, avatar: null, tags: ["kol"] },
    { chain: "eth", wallet: "0xE1", twitter: "ann", name: "Ann Q", avatar: "a.png", tags: ["smart"] },
    { chain: "bsc", wallet: "0xB1", twitter: null, name: null, avatar: null, tags: [] },
  ];
  const people = group(rows);
  assertEquals(people.length, 2);
  assertEquals(people[0], { twitter: "Ann", name: "Ann Q", avatar: "a.png", tags: ["kol", "smart"], wallets: [{ chain: "sol", wallet: "S1" }, { chain: "eth", wallet: "0xE1" }] });
  assertEquals(people[1].wallets, [{ chain: "bsc", wallet: "0xB1" }]);
});

Deno.test("handleFor: twitter when free, gmgn_ prefix when taken, wallet prefix without one", () => {
  const p = { twitter: "Ann.X", name: null, avatar: null, tags: [], wallets: [{ chain: "sol", wallet: "ABCDEFGHIJKLMNOP" }] };
  assertEquals(handleFor(p, new Set()), "annx");
  assertEquals(handleFor(p, new Set(["annx"])), "gmgn_annx");
  assertEquals(handleFor({ ...p, twitter: null }, new Set()), "gmgn_abcdefghij");
});

Deno.test("newTraders: skips a person every handle rule already places in the directory; does not mutate `existing`", () => {
  const existing = new Set(["bob", "gmgn_bob", "gmgn_s1"]);
  const rows = newTraders([
    { twitter: "bob", name: null, avatar: null, tags: [], wallets: [{ chain: "sol", wallet: "S1" }] },
    { twitter: "cat", name: "Cat", avatar: null, tags: ["kol", "smart"], wallets: [{ chain: "eth", wallet: "0xE" }, { chain: "sol", wallet: "S2" }] },
  ], existing);
  assertEquals(rows, [{ handle: "cat", display_handle: "cat", name: "Cat", avatar: null, bio: "kol, smart", twitter: "cat", sol: "S2", evm: "0xE" }]);
  assertEquals(existing.size, 3);
});

Deno.test("fold: buys and sells aggregate to one position per token; transfers ignored; closed at 99% sold", () => {
  const tok = { address: "AbC", symbol: "T", total_supply: "1000" };
  const acts = [
    { event_type: "buy", token: tok, token_amount: "100", cost_usd: "50", timestamp: 1000 },
    { event_type: "buy", token: { address: "abc" }, token_amount: "100", cost_usd: "150", timestamp: 900 },
    { event_type: "transferIn", token: tok, token_amount: "999" },
    { type: "sell", token: tok, token_amount: "199", cost_usd: "400", buy_cost_usd: "199", timestamp: 2000 },
    { event_type: "sell", token: { address: "" }, token_amount: "1" },
    "junk",
  ];
  const [p] = fold(acts, 56);
  assertEquals(fold(acts, 56).length, 1);
  assertEquals(p.network_id, 56);
  assertEquals(p.token_key, "abc");
  assertEquals(p.token_address, "AbC");
  assertEquals(p.status, "closed");
  assertEquals(p.amount, 200);
  assertEquals(p.avg_entry_price, 1);
  assertEquals(p.avg_exit_price, 400 / 199);
  assertEquals(p.realized_pnl_usd, 201);
  assertEquals(p.opened_at, new Date(900_000).toISOString());
  assertEquals(p.closed_at, new Date(2_000_000).toISOString());
  assertEquals(p.total_supply, 1000);
});

Deno.test("fold: an open position with no priced buy has null prices and no realized pnl", () => {
  const [p] = fold([
    { event_type: "buy", token: { address: "X" }, token_amount: "10" },
    { event_type: "sell", token: { address: "x" }, token_amount: "1", cost_usd: "5" },
  ], 1);
  assertEquals(p.status, "open");
  assertEquals(p.amount, 10);
  assertEquals(p.avg_entry_price, null);
  assertEquals(p.avg_exit_price, 5);
  assertEquals(p.realized_pnl_usd, null);
  assertEquals(p.opened_at, null);
  assertEquals(p.closed_at, null);
});
