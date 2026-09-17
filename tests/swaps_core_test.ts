import { assertEquals } from "jsr:@std/assert@1";
import { TRANSFER, WITHDRAWAL, decode, human, toRow, tokensOf, type Log } from "../worker/src/jobs/swaps-core.ts";

/* The rules of scripts/resolve_evm_swaps_from_receipts.mjs: only the wallet's own two-sided
   trade is a swap; a native leg comes from the body's `value` or the router's Withdrawal. */

const W = "0xabcdef0000000000000000000000000000000001";
const OTHER = "0x1111111111111111111111111111111111111111";
const TOK = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USDT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WBNB = "0xcccccccccccccccccccccccccccccccccccccccc";
const topic = (a: string): string => "0x" + a.slice(2).padStart(64, "0");
const hex = (v: bigint): string => "0x" + v.toString(16);
const transfer = (token: string, from: string, to: string, v: bigint): Log =>
  ({ address: token, topics: [TRANSFER, topic(from), topic(to)], data: hex(v) });
const withdrawal = (v: bigint): Log => ({ address: WBNB, topics: [WITHDRAWAL, topic(OTHER)], data: hex(v) });

const decimals = new Map([[TOK, 9], [USDT, 18]]);
const quotes = new Map([[USDT, { symbol: "USDT", usd: 1 }]]);
const wrapped = { key: WBNB, usd: 600 };

Deno.test("human: exact scaling through the string", () => {
  assertEquals(human(1_500_000_000n, 9), 1.5);
  assertEquals(human(7n, 0), 7);
  assertEquals(human(123n, 18), 1.23e-16);
});

Deno.test("decode: token-for-token, netted per token", () => {
  const rec = { logs: [transfer(USDT, W, OTHER, 50n), transfer(TOK, OTHER, W, 10n), transfer(TOK, OTHER, W, 5n)] };
  assertEquals(decode(rec, { from: W, value: "0x0" }, W), { kind: "token", recv: [TOK, 15n], sent: [USDT, -50n] });
});

Deno.test("decode: a one-sided receipt is someone else's trade", () => {
  assertEquals(decode({ logs: [transfer(TOK, OTHER, W, 10n)] }, { from: OTHER, value: "0x0" }, W), null);
  assertEquals(decode({ logs: [transfer(TOK, OTHER, W, 10n)] }, null, W), null);
});

Deno.test("decode: native buy needs the wallet to have signed and paid value", () => {
  const rec = { logs: [transfer(TOK, OTHER, W, 10n)] };
  assertEquals(decode(rec, { from: W.toUpperCase(), value: hex(2n * 10n ** 18n) }, W), { kind: "native_buy", recv: [TOK, 10n], paid: 2n * 10n ** 18n });
  assertEquals(decode(rec, { from: W, value: "0x0" }, W), null);
});

Deno.test("decode: native sell sums the router's Withdrawal events", () => {
  const rec = { logs: [transfer(TOK, W, OTHER, 10n), withdrawal(10n ** 18n), withdrawal(5n * 10n ** 17n)] };
  assertEquals(decode(rec, { from: W, value: "0x0" }, W), { kind: "native_sell", sent: [TOK, -10n], got: 15n * 10n ** 17n });
});

Deno.test("decode: three tokens moved is not one trade; bad log data is skipped", () => {
  const three = { logs: [transfer(USDT, W, OTHER, 1n), transfer(TOK, OTHER, W, 1n), transfer(WBNB, OTHER, W, 1n)] };
  assertEquals(decode(three, { from: W, value: "0x0" }, W), null);
  const bad = { logs: [transfer(USDT, W, OTHER, 1n), { address: TOK, topics: [TRANSFER, topic(OTHER), topic(W)], data: "zz" }] };
  assertEquals(decode(bad, null, W), null);
});

Deno.test("toRow: buy paid in a stablecoin is valued from the money leg", () => {
  const d = decode({ logs: [transfer(USDT, W, OTHER, 50n * 10n ** 18n), transfer(TOK, OTHER, W, 15n * 10n ** 9n)] }, null, W)!;
  assertEquals(tokensOf(d), [TOK, USDT]);
  assertEquals(toRow(d, decimals, quotes, wrapped), { tokenKey: TOK, tokenDelta: 15, quoteKey: USDT, quoteDelta: -50, quoteUsd: 50 });
});

Deno.test("toRow: sell into a stablecoin flips the signs", () => {
  const d = decode({ logs: [transfer(TOK, W, OTHER, 15n * 10n ** 9n), transfer(USDT, OTHER, W, 50n * 10n ** 18n)] }, null, W)!;
  assertEquals(toRow(d, decimals, quotes, wrapped), { tokenKey: TOK, tokenDelta: -15, quoteKey: USDT, quoteDelta: 50, quoteUsd: 50 });
});

Deno.test("toRow: two quotes or no quote, or unknown decimals, is skipped", () => {
  const both = decode({ logs: [transfer(USDT, W, OTHER, 1n), transfer(WBNB, OTHER, W, 1n)] }, null, W)!;
  assertEquals(toRow(both, new Map([[USDT, 18], [WBNB, 18]]), new Map([...quotes, [WBNB, { symbol: "WBNB", usd: 600 }]]), wrapped), null);
  const none = decode({ logs: [transfer(TOK, W, OTHER, 1n), transfer(WBNB, OTHER, W, 1n)] }, null, W)!;
  assertEquals(toRow(none, new Map([[TOK, 9], [WBNB, 18]]), quotes, wrapped), null);
  const d = decode({ logs: [transfer(USDT, W, OTHER, 1n), transfer(TOK, OTHER, W, 1n)] }, null, W)!;
  assertEquals(toRow(d, new Map([[USDT, 18]]), quotes, wrapped), null);
});

Deno.test("toRow: native legs are recorded against the wrapped native; unpriced wrapped gives null usd", () => {
  const buy = decode({ logs: [transfer(TOK, OTHER, W, 10n ** 9n)] }, { from: W, value: hex(5n * 10n ** 17n) }, W)!;
  assertEquals(toRow(buy, decimals, quotes, wrapped), { tokenKey: TOK, tokenDelta: 1, quoteKey: WBNB, quoteDelta: -0.5, quoteUsd: 300 });
  const sell = decode({ logs: [transfer(TOK, W, OTHER, 10n ** 9n), withdrawal(10n ** 18n)] }, { from: W, value: "0x0" }, W)!;
  assertEquals(toRow(sell, decimals, quotes, { key: WBNB, usd: null }), { tokenKey: TOK, tokenDelta: -1, quoteKey: WBNB, quoteDelta: 1, quoteUsd: null });
  assertEquals(toRow(sell, decimals, quotes, null), null);
});
