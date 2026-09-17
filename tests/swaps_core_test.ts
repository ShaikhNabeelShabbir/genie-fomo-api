import { assertEquals } from "jsr:@std/assert@1";
import { SOL_MINT, ZERO_ADDRESS } from "../supabase/functions/_shared/chain_reads.ts";
import { decode, priceQuote, type Quote, solanaDecode, solanaDecodeEnhanced, toRow, type Trade } from "../worker/src/jobs/swaps-core.ts";

/* The rules of the scripts this replaced, over Bitquery `EVM.DEXTrades` rows
   (https://docs.bitquery.io/docs/schema/evm/dextrades/) and Helius `getTransaction` results:
   only the wallet's own two-sided trade is a swap; the coin is recorded against the wrapped
   native (EVM) or SOL_MINT (Solana); the money leg is priced peg -> daily close -> market. */

const W = "0xabcdef0000000000000000000000000000000001";
const ROUTER = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";
const TOK = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USDT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WBNB = "0xcccccccccccccccccccccccccccccccccccccccc";
const OTHER = "0xdddddddddddddddddddddddddddddddddddddddd";
const HASH = "0xabc";
const AT = new Date("2026-09-10T12:00:00Z");

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
const quote = (symbol: string, pegged: number | null, closes: [string, number][] = [], market: number | null = null): Quote =>
  ({ symbol, pegged, closes: new Map(closes), market });

const quotes = new Map([[USDT, quote("USDT", 1)]]);
const wrapped = { key: WBNB, quote: quote("WBNB", null, [], 600) };

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

Deno.test("priceQuote: the peg wins; else the latest close on or before the day within 7 days; else market; else null", () => {
  assertEquals(priceQuote(quote("USDT", 1, [["2026-09-10", 0.9]], 2), AT), { usd: 1, source: "money_side_pegged" });
  const closes: [string, number][] = [["2026-09-03", 100], ["2026-09-08", 108], ["2026-09-11", 111]];
  assertEquals(priceQuote(quote("WBNB", null, closes, 600), AT), { usd: 108, source: "money_side_daily_close" });
  assertEquals(priceQuote(quote("WBNB", null, [["2026-09-10", 110]], 600), AT), { usd: 110, source: "money_side_daily_close" });
  /* 3 Sep is the 8th day back from 10 Sep: outside the lookback, so the market price stands in. */
  assertEquals(priceQuote(quote("WBNB", null, [["2026-09-03", 100]], 600), AT), { usd: 600, source: "money_side_market" });
  assertEquals(priceQuote(quote("WBNB", null, [["2026-09-04", 104]], 600), AT), { usd: 104, source: "money_side_daily_close" });
  assertEquals(priceQuote(quote("WBNB", null), AT), null);
});

Deno.test("toRow: buy paid in a stablecoin is valued from the money leg, signed like quoteDelta; a sell flips the signs", () => {
  const buy = decode([trade(W, W, POOL, erc(TOK), "15", erc(USDT), "50")], W)!;
  assertEquals(toRow(buy, quotes, wrapped, AT), { tokenKey: TOK, tokenDelta: 15, quoteKey: USDT, quoteDelta: -50, quoteUsd: -50, quoteSource: "money_side_pegged" });
  const sell = decode([trade(W, W, POOL, erc(USDT), "50", erc(TOK), "15")], W)!;
  assertEquals(toRow(sell, quotes, wrapped, AT), { tokenKey: TOK, tokenDelta: -15, quoteKey: USDT, quoteDelta: 50, quoteUsd: 50, quoteSource: "money_side_pegged" });
});

Deno.test("toRow: two quotes or no quote is skipped", () => {
  const both = decode([trade(W, W, POOL, erc(WBNB), "1", erc(USDT), "1")], W)!;
  assertEquals(toRow(both, new Map([...quotes, [WBNB, wrapped.quote]]), wrapped, AT), null);
  const none = decode([trade(W, W, POOL, erc(TOK), "1", erc(OTHER), "1")], W)!;
  assertEquals(toRow(none, quotes, wrapped, AT), null);
});

Deno.test("toRow: the coin is recorded against the wrapped native at the block day's close, else market; unpriced gives null usd; no wrapped skips", () => {
  const buy = decode([trade(W, W, POOL, erc(TOK), "1", coin, "0.5")], W)!;
  const dated = { key: WBNB, quote: quote("WBNB", null, [["2026-09-09", 500]], 600) };
  assertEquals(toRow(buy, quotes, dated, AT), { tokenKey: TOK, tokenDelta: 1, quoteKey: WBNB, quoteDelta: -0.5, quoteUsd: -250, quoteSource: "money_side_daily_close" });
  assertEquals(toRow(buy, quotes, wrapped, AT), { tokenKey: TOK, tokenDelta: 1, quoteKey: WBNB, quoteDelta: -0.5, quoteUsd: -300, quoteSource: "money_side_market" });
  const sell = decode([trade(W, W, POOL, coin, "1", erc(TOK), "1")], W)!;
  assertEquals(toRow(sell, quotes, { key: WBNB, quote: quote("WBNB", null) }, AT), { tokenKey: TOK, tokenDelta: -1, quoteKey: WBNB, quoteDelta: 1, quoteUsd: null, quoteSource: null });
  assertEquals(toRow(sell, quotes, null, AT), null);
});

/* Solana: the cases `scripts/resolve_wallet_swaps.mjs` documented. */
const OWNER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const bal = (owner: string, mint: string, uiAmount: number | null) => ({ owner, mint, uiTokenAmount: { uiAmount } });
/** A Helius `getTransaction` result: the owner's token balances before and after, plus native lamports per account key. */
const solTx = (pre: unknown[], post: unknown[], keys: string[] = [], preLamports: number[] = [], postLamports: number[] = []) => ({
  meta: { preTokenBalances: pre, postTokenBalances: post, preBalances: preLamports, postBalances: postLamports },
  transaction: { message: { accountKeys: keys.map((pubkey) => ({ pubkey })) } },
});
const solQuotes = new Map([[USDC.toLowerCase(), quote("USDC", 1)], [SOL_MINT, quote("SOL", null, [["2026-09-10", 200]])]]);

Deno.test("solanaDecode: the owner's net change per mint, keys lower-cased, owner matched case-insensitively", () => {
  const tx = solTx([bal(OWNER, MINT, 0), bal(OWNER, USDC, 100)], [bal(OWNER, MINT, 1000), bal(OWNER, USDC, 40)]);
  assertEquals(solanaDecode(tx, OWNER.toLowerCase()), { recv: [MINT.toLowerCase(), 1000], sent: [USDC.toLowerCase(), -60] });
  assertEquals(toRow(solanaDecode(tx, OWNER.toLowerCase())!, solQuotes, null, AT),
    { tokenKey: MINT.toLowerCase(), tokenDelta: 1000, quoteKey: USDC.toLowerCase(), quoteDelta: -60, quoteUsd: -60, quoteSource: "money_side_pegged" });
});

Deno.test("solanaDecode: native SOL is a leg when the owner is an account of the transaction; a lamport of rent is not", () => {
  const tx = solTx([bal(OWNER, MINT, 5)], [bal(OWNER, MINT, 0)], ["relayer", OWNER], [1e9, 1e9], [0.9e9, 1.5e9]);
  assertEquals(solanaDecode(tx, OWNER), { recv: [SOL_MINT, 0.5], sent: [MINT.toLowerCase(), -5] });
  assertEquals(toRow(solanaDecode(tx, OWNER)!, solQuotes, null, AT),
    { tokenKey: MINT.toLowerCase(), tokenDelta: -5, quoteKey: SOL_MINT, quoteDelta: 0.5, quoteUsd: 100, quoteSource: "money_side_daily_close" });
  const rent = solTx([bal(OWNER, MINT, 0)], [bal(OWNER, MINT, 5)], [OWNER], [1e9], [1e9 - 5]);
  assertEquals(solanaDecode(rent, OWNER), null);
});

Deno.test("solanaDecode: someone else's swap into the wallet, a same-sign touch of two mints, or three mints is not the wallet's trade", () => {
  /* The measured case: 57 of 60 SWAP-tagged rows moved only one of the wallet's balances. */
  assertEquals(solanaDecode(solTx([bal(OWNER, MINT, 0)], [bal(OWNER, MINT, 10)]), OWNER), null);
  assertEquals(solanaDecode(solTx([bal("someone", MINT, 0), bal("someone", USDC, 9)], [bal("someone", MINT, 1), bal("someone", USDC, 0)]), OWNER), null);
  assertEquals(solanaDecode(solTx([], [bal(OWNER, MINT, 1), bal(OWNER, USDC, 1)]), OWNER), null);
  const three = solTx([bal(OWNER, MINT, 0), bal(OWNER, USDC, 10)], [bal(OWNER, MINT, 1), bal(OWNER, USDC, 0), bal(OWNER, "Other", 3)]);
  assertEquals(solanaDecode(three, OWNER), null);
  assertEquals(solanaDecode(null, OWNER), null);
  assertEquals(solanaDecode({ meta: null }, OWNER), null);
});

Deno.test("solanaDecode: dust below 1e-12 is not a leg; a null uiAmount reads as zero", () => {
  const tx = solTx([bal(OWNER, MINT, null), bal(OWNER, USDC, 1)], [bal(OWNER, MINT, 3), bal(OWNER, USDC, 1 - 1e-13)]);
  assertEquals(solanaDecode(tx, OWNER), null);
});

/* The same four cases in the Enhanced Transactions shape (`POST /v0/transactions`): a signed raw delta per (owner, mint), lamports per account. */
const chg = (userAccount: string, mint: string, tokenAmount: string, decimals = 6) => ({ userAccount, tokenAccount: `${userAccount}-${mint}`, mint, rawTokenAmount: { tokenAmount, decimals } });
/** One parsed transaction: `changes` under the token accounts, `native` as `[account, lamports]` entries. */
const parsed = (changes: unknown[], native: [string, number][] = []) => ({
  signature: "sig", type: "SWAP", feePayer: "relayer",
  accountData: [
    ...native.map(([account, nativeBalanceChange]) => ({ account, nativeBalanceChange, tokenBalanceChanges: [] })),
    ...changes.map((c) => ({ account: (c as { tokenAccount: string }).tokenAccount, nativeBalanceChange: 0, tokenBalanceChanges: [c] })),
  ],
});

Deno.test("solanaDecodeEnhanced: the owner's net change per mint, keys lower-cased, owner matched case-insensitively", () => {
  const tx = parsed([chg(OWNER, MINT, "1000000000"), chg(OWNER, USDC, "-60000000")]);
  assertEquals(solanaDecodeEnhanced(tx, OWNER.toLowerCase()), { recv: [MINT.toLowerCase(), 1000], sent: [USDC.toLowerCase(), -60] });
  assertEquals(toRow(solanaDecodeEnhanced(tx, OWNER.toLowerCase())!, solQuotes, null, AT),
    { tokenKey: MINT.toLowerCase(), tokenDelta: 1000, quoteKey: USDC.toLowerCase(), quoteDelta: -60, quoteUsd: -60, quoteSource: "money_side_pegged" });
});

Deno.test("solanaDecodeEnhanced: native SOL is a leg from the owner's own account entry; a lamport of rent is not", () => {
  const tx = parsed([chg(OWNER, MINT, "-5000000")], [["relayer", -0.1e9], [OWNER, 0.5e9]]);
  assertEquals(solanaDecodeEnhanced(tx, OWNER), { recv: [SOL_MINT, 0.5], sent: [MINT.toLowerCase(), -5] });
  assertEquals(toRow(solanaDecodeEnhanced(tx, OWNER)!, solQuotes, null, AT),
    { tokenKey: MINT.toLowerCase(), tokenDelta: -5, quoteKey: SOL_MINT, quoteDelta: 0.5, quoteUsd: 100, quoteSource: "money_side_daily_close" });
  assertEquals(solanaDecodeEnhanced(parsed([chg(OWNER, MINT, "5000000")], [[OWNER, -5]]), OWNER), null);
});

Deno.test("solanaDecodeEnhanced: someone else's swap into the wallet, a same-sign touch of two mints, three mints, or a dropped signature is not the wallet's trade", () => {
  assertEquals(solanaDecodeEnhanced(parsed([chg(OWNER, MINT, "10000000")]), OWNER), null);
  assertEquals(solanaDecodeEnhanced(parsed([chg("someone", MINT, "1000000"), chg("someone", USDC, "-9000000")]), OWNER), null);
  assertEquals(solanaDecodeEnhanced(parsed([chg(OWNER, MINT, "1000000"), chg(OWNER, USDC, "1000000")]), OWNER), null);
  assertEquals(solanaDecodeEnhanced(parsed([chg(OWNER, MINT, "1000000"), chg(OWNER, USDC, "-10000000"), chg(OWNER, "Other", "3000000")]), OWNER), null);
  assertEquals(solanaDecodeEnhanced(undefined, OWNER), null);
  assertEquals(solanaDecodeEnhanced({ signature: "sig", accountData: null }, OWNER), null);
});

Deno.test("solanaDecodeEnhanced: dust below 1e-12 is not a leg; two token accounts of one mint sum", () => {
  assertEquals(solanaDecodeEnhanced(parsed([chg(OWNER, MINT, "3000000"), chg(OWNER, USDC, "-100", 15)]), OWNER), null);
  const split = parsed([chg(OWNER, MINT, "3000000"), chg(OWNER, MINT, "-1000000"), chg(OWNER, USDC, "-4000000")]);
  assertEquals(solanaDecodeEnhanced(split, OWNER), { recv: [MINT.toLowerCase(), 2], sent: [USDC.toLowerCase(), -4] });
});
