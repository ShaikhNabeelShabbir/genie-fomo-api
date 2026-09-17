import { assertEquals } from "jsr:@std/assert@1";
import { isFomoDoc, num, outcomeOf, price, tradeRow, when } from "../worker/src/jobs/scorecards-core.ts";

/* Cases derived from loaders/load_trades.py: num/price/when/outcome_of and the row tuple in run_once. */

Deno.test("num: finite numbers only; strings, booleans, NaN and null are absent, never zero", () => {
  assertEquals(num(1234), 1234);
  assertEquals(num(0), 0);
  assertEquals(num(-2.5), -2.5);
  assertEquals(num("1,234"), null);
  assertEquals(num("12"), null);
  assertEquals(num(true), null);
  assertEquals(num(NaN), null);
  assertEquals(num(Infinity), null);
  assertEquals(num(null), null);
  assertEquals(num(undefined), null);
});

Deno.test("price: fomo's 0 means unknown, so zero and negatives are null", () => {
  assertEquals(price(0.000123), 0.000123);
  assertEquals(price(0), null);
  assertEquals(price(-1), null);
  assertEquals(price("0.5"), null);
});

Deno.test("when: ISO strings parse, epoch numbers and junk do not", () => {
  assertEquals(when("2026-09-10T00:00:00Z")?.toISOString(), "2026-09-10T00:00:00.000Z");
  assertEquals(when("2026-09-10T02:00:00+02:00")?.toISOString(), "2026-09-10T00:00:00.000Z");
  assertEquals(when(1_757_462_400_000), null);
  assertEquals(when("not a date"), null);
  assertEquals(when(null), null);
});

Deno.test("isFomoDoc: an object whose trades, when present, is a list", () => {
  assertEquals(isFomoDoc({ trades: [] }), true);
  assertEquals(isFomoDoc({ available: false }), true);
  assertEquals(isFomoDoc({ trades: null }), true);
  assertEquals(isFomoDoc({ trades: "x" }), false);
  assertEquals(isFomoDoc([]), false);
  assertEquals(isFomoDoc(null), false);
  assertEquals(isFomoDoc("{}"), false);
});

Deno.test("outcomeOf: the six trade_loads words, with the directory source splitting degraded from unavailable", () => {
  const now = new Date("2026-09-18T06:00:00Z");
  const prev = new Date("2026-09-10T00:00:00Z");
  assertEquals(outcomeOf({ kind: "error", detail: "HTTP 502" }, "fomoapi.io", prev, now), { outcome: "error", detail: "HTTP 502" });
  assertEquals(outcomeOf({ kind: "not_found" }, "fomoapi.io", prev, now), { outcome: "not_found", detail: "HTTP 404" });
  assertEquals(outcomeOf({ kind: "doc", doc: { available: false, trades: [] } }, "fomoapi.io", prev, now), { outcome: "degraded", detail: null });
  assertEquals(outcomeOf({ kind: "doc", doc: { available: false, trades: [] } }, "gmgn.ai", prev, now), { outcome: "unavailable", detail: null });
  assertEquals(outcomeOf({ kind: "doc", doc: { available: false, trades: [] } }, null, prev, now), { outcome: "unavailable", detail: null });
  /* loaded: the document's snapshot advances max(trades.captured_at); no capturedAt means the fetch time. */
  assertEquals(outcomeOf({ kind: "doc", doc: { trades: [{}, {}] } }, "fomoapi.io", prev, now), { outcome: "loaded", detail: "2 trades" });
  assertEquals(outcomeOf({ kind: "doc", doc: { trades: [{}], capturedAt: "2026-09-17T00:00:00Z" } }, "fomoapi.io", null, now), { outcome: "loaded", detail: "1 trades" });
  /* unchanged: a re-served snapshot, or an empty document (nothing written, so nothing advances). */
  assertEquals(outcomeOf({ kind: "doc", doc: { trades: [{}], capturedAt: "2026-09-10T00:00:00Z" } }, "fomoapi.io", prev, now),
    { outcome: "unchanged", detail: "1 trades, snapshot 2026-09-10T00:00:00.000Z not newer" });
  assertEquals(outcomeOf({ kind: "doc", doc: { trades: [{}], capturedAt: "2026-09-07T00:00:00Z" } }, "fomoapi.io", prev, now).outcome, "unchanged");
  assertEquals(outcomeOf({ kind: "doc", doc: {} }, "fomoapi.io", prev, now).outcome, "unchanged");
  assertEquals(outcomeOf({ kind: "doc", doc: { trades: [] } }, "fomoapi.io", null, now).outcome, "unchanged");
});

Deno.test("tradeRow: the python tuple, column for column", () => {
  const captured = new Date("2026-09-17T06:00:00Z");
  const netOf = new Map([["0xabc", 8453]]);
  const row = tradeRow({
    tradeId: "t1", status: "closed", amount: 0,
    token: { address: " 0xABC ", symbol: "PEPE" },
    avgEntryPrice: 0.01, avgExitPrice: 0, realizedPnlUsd: 12.5, unrealizedPnlUsd: null,
    createdAt: "2026-09-01T00:00:00Z", closedAt: "2026-09-02T00:00:00Z",
  }, "alice", netOf, captured);
  assertEquals(row, {
    trade_id: "t1", handle: "alice", network_id: 8453, token_address: "0xABC", token_key: "0xabc",
    token_symbol: "PEPE", status: "closed", amount: 0, avg_entry_price: 0.01, avg_exit_price: null,
    realized_pnl_usd: 12.5, unrealized_pnl_usd: null,
    opened_at: new Date("2026-09-01T00:00:00Z"), closed_at: new Date("2026-09-02T00:00:00Z"), captured_at: captured,
  });
});

Deno.test("tradeRow: no tradeId is no row; an unknown token keeps its address with a null chain", () => {
  const captured = new Date();
  assertEquals(tradeRow({ token: { address: "0xabc" } }, "alice", new Map(), captured), null);
  assertEquals(tradeRow({ tradeId: "" }, "alice", new Map(), captured), null);
  assertEquals(tradeRow("t1", "alice", new Map(), captured), null);
  const row = tradeRow({ tradeId: 7, token: { address: "So1ana" } }, "alice", new Map(), captured);
  assertEquals([row?.trade_id, row?.network_id, row?.token_address, row?.token_key, row?.token_symbol, row?.status],
    ["7", null, "So1ana", "so1ana", null, null]);
  const bare = tradeRow({ tradeId: "t2", token: { address: "   " } }, "alice", new Map(), captured);
  assertEquals([bare?.token_address, bare?.token_key], [null, null]);
});
