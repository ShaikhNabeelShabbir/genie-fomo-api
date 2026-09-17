import { assertEquals } from "jsr:@std/assert@1";
import { ZERO_ADDRESS } from "../supabase/functions/_shared/chain_reads.ts";
import { decode, toRow, type Trade } from "../worker/src/jobs/swaps-core.ts";

/* The rules of the receipt decoder this replaced, over Bitquery `EVM.DEXTrades` rows
   (https://docs.bitquery.io/docs/schema/evm/dextrades/): only the wallet's own two-sided
   trade is a swap; the coin is recorded against the wrapped native. */

const W = "0xabcdef0000000000000000000000000000000001";
const ROUTER = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";
const TOK = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USDT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WBNB = "0xcccccccccccccccccccccccccccccccccccccccc";
const OTHER = "0xdddddddddddddddddddddddddddddddddddddddd";
const HASH = "0xabc";

const erc = (c: string) => ({ SmartContract: c.toUpperCase(), Native: false });
const coin = { SmartContract: "0x", Native: true };
/** One trade: `taker` bought `buy` of `buyCur` from `maker`, paying `sell` of `sellCur`. */
const trade = (from: string, taker: string, maker: string, buyCur: unknown, buy: string, sellCur: unknown, sell: string): Trade => ({
  Transaction: { Hash: HASH, From: from },
  Trade: {
    Buy: { Amount: buy, Buyer: taker, Seller: maker, Currency: buyCur },
    Sell: { Amount: sell, Buyer: maker, Seller: taker, Currency: sellCur },
  },
});

const quotes = new Map([[USDT, { symbol: "USDT", usd: 1 }]]);
const wrapped = { key: WBNB, usd: 600 };

Deno.test("decode: the wallet named as taker nets its own sides; contracts are lower-cased", () => {
  assertEquals(decode([trade(W, W, POOL, erc(TOK), "15", erc(USDT), "50")], W), { recv: [TOK, 15], sent: [USDT, -50] });
});

Deno.test("decode: a route through the router nets every hop when the wallet signed; the middle token cancels", () => {
  const hops = [
    trade(W, ROUTER, POOL, erc(WBNB), "0.1", erc(USDT), "60"),
    trade(W, ROUTER, POOL, erc(TOK), "1000", erc(WBNB), "0.1"),
  ];
  assertEquals(decode(hops, W), { recv: [TOK, 1000], sent: [USDT, -60] });
});

Deno.test("decode: someone else's transaction is not the wallet's trade", () => {
  assertEquals(decode([trade(OTHER, ROUTER, POOL, erc(TOK), "1", erc(USDT), "1")], W), null);
  assertEquals(decode([], W), null);
});

Deno.test("decode: the wallet as maker is the selling side; three tokens or bad amounts are not one trade", () => {
  assertEquals(decode([trade(OTHER, OTHER, W, erc(TOK), "5", erc(USDT), "10")], W), { recv: [USDT, 10], sent: [TOK, -5] });
  const three = [trade(W, W, POOL, erc(TOK), "1", erc(USDT), "1"), trade(W, W, POOL, erc(OTHER), "1", erc(USDT), "1")];
  assertEquals(decode(three, W), null);
  assertEquals(decode([trade(W, W, POOL, erc(TOK), "abc", erc(USDT), "1")], W), null);
  assertEquals(decode([trade(W, W, POOL, { SmartContract: "nope" }, "1", erc(USDT), "1")], W), null);
});

Deno.test("decode: the coin lands under the zero-address sentinel", () => {
  assertEquals(decode([trade(W, W, POOL, erc(TOK), "1", coin, "0.5")], W), { recv: [TOK, 1], sent: [ZERO_ADDRESS, -0.5] });
  const only0x = { SmartContract: "0x" };
  assertEquals(decode([trade(W, W, POOL, only0x, "2", erc(TOK), "1")], W), { recv: [ZERO_ADDRESS, 2], sent: [TOK, -1] });
});

Deno.test("toRow: buy paid in a stablecoin is valued from the money leg; a sell flips the signs", () => {
  const buy = decode([trade(W, W, POOL, erc(TOK), "15", erc(USDT), "50")], W)!;
  assertEquals(toRow(buy, quotes, wrapped), { tokenKey: TOK, tokenDelta: 15, quoteKey: USDT, quoteDelta: -50, quoteUsd: 50 });
  const sell = decode([trade(W, W, POOL, erc(USDT), "50", erc(TOK), "15")], W)!;
  assertEquals(toRow(sell, quotes, wrapped), { tokenKey: TOK, tokenDelta: -15, quoteKey: USDT, quoteDelta: 50, quoteUsd: 50 });
});

Deno.test("toRow: two quotes or no quote is skipped", () => {
  const both = decode([trade(W, W, POOL, erc(WBNB), "1", erc(USDT), "1")], W)!;
  assertEquals(toRow(both, new Map([...quotes, [WBNB, { symbol: "WBNB", usd: 600 }]]), wrapped), null);
  const none = decode([trade(W, W, POOL, erc(TOK), "1", erc(OTHER), "1")], W)!;
  assertEquals(toRow(none, quotes, wrapped), null);
});

Deno.test("toRow: the coin is recorded against the wrapped native; unpriced wrapped gives null usd; no wrapped skips", () => {
  const buy = decode([trade(W, W, POOL, erc(TOK), "1", coin, "0.5")], W)!;
  assertEquals(toRow(buy, quotes, wrapped), { tokenKey: TOK, tokenDelta: 1, quoteKey: WBNB, quoteDelta: -0.5, quoteUsd: 300 });
  const sell = decode([trade(W, W, POOL, coin, "1", erc(TOK), "1")], W)!;
  assertEquals(toRow(sell, quotes, { key: WBNB, usd: null }), { tokenKey: TOK, tokenDelta: -1, quoteKey: WBNB, quoteDelta: 1, quoteUsd: null });
  assertEquals(toRow(sell, quotes, null), null);
});
