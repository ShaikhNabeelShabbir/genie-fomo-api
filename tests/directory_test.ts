import { assertEquals } from "jsr:@std/assert@1";
import {
  SOLANA_NETWORK_ID, holdingRows, mergePositions, parseBalances, parseLeaderboard, parseOpenTrades,
  rejectBuild, statsRow, tokenRows, traderRow, walletRow,
} from "../worker/src/jobs/directory-core.ts";

/* Cases derived from loaders/build_directory_fomoapi.py (build, open_positions, validate) and loaders/load_to_db.py (shape). */

const entry = (over: Record<string, unknown> = {}) => ({
  handle: "TheVeeman", displayName: "Vee", rank: 3, wallets: { evm: "0xABC", solana: "So1ana" },
  pnlUsd: 12.5, volumeUsd: 100, trades: 7, followers: 9, avatar: "a.png", verified: true, ...over,
});

Deno.test("parseLeaderboard: fields map as the builder's entries; missing figures are 0 as `or 0` made them", () => {
  const [e] = parseLeaderboard({ traders: [entry({ pnlUsd: null, trades: undefined, wallets: null, displayName: "" })] }, 100);
  assertEquals(e, {
    handle: "TheVeeman", name: "TheVeeman", rank: 3, srcEvm: "", srcSol: "", pnl: 0, volume: 100,
    trades: 0, followers: 9, avatar: "a.png", verified: true,
  });
});

Deno.test("parseLeaderboard: evm lowercased, solana case kept, rank falls back to position, nameless rows dropped, topN honoured", () => {
  const out = parseLeaderboard({ traders: [entry({ rank: null }), { handle: "" }, entry({ handle: "b" }), entry({ handle: "c" })] }, 3);
  assertEquals(out.map((e) => [e.handle, e.rank]), [["TheVeeman", 1], ["b", 3]]);
  assertEquals(out[0].srcEvm, "0xabc");
  assertEquals(out[0].srcSol, "So1ana");
  assertEquals(parseLeaderboard(null, 100), []);
});

Deno.test("parseOpenTrades: open, addressed, positive-amount rows only; entry price is null when absent", () => {
  const doc = { trades: [
    { status: "open", token: { address: "0xA" }, amount: 5, avgEntryPrice: 1.5 },
    { status: "closed", token: { address: "0xB" }, amount: 5 },
    { status: "open", token: {}, amount: 5 },
    { status: "open", token: { address: "0xC" }, amount: 0 },
    { status: "open", token: { address: "0xD" }, amount: "7" },
    { status: "open", token: { address: "Sol1" }, amount: 2 },
  ] };
  assertEquals(parseOpenTrades(doc), [{ address: "0xA", amount: 5, price: 1.5 }, { address: "Sol1", amount: 2, price: null }]);
  assertEquals(parseOpenTrades({ trades: null }), []);
});

Deno.test("parseBalances: Solana only, a 0x is skipped, value stays null when unpriced", () => {
  const doc = { holdings: [
    { token: { address: "Mint1" }, amount: 3, priceUsd: 2, valueUsd: 6 },
    { token: { address: "0xA" }, amount: 3 },
    { token: { address: "Mint2" }, amount: 1 },
  ] };
  assertEquals(parseBalances(doc), [
    { tokenAddress: "Mint1", networkId: SOLANA_NETWORK_ID, humanAmount: 3, price: 2, value: 6 },
    { tokenAddress: "Mint2", networkId: SOLANA_NETWORK_ID, humanAmount: 1, price: null, value: null },
  ]);
});

Deno.test("mergePositions: one row per (token, chain), /balances wins for Solana, EVM emitted once per detected chain", () => {
  const out = mergePositions(
    [{ address: "0xA", amount: 5, price: 1, networks: [8453, 56] }, { address: "Mint1", amount: 9, price: 4, networks: [SOLANA_NETWORK_ID] }],
    [{ tokenAddress: "Mint1", networkId: SOLANA_NETWORK_ID, humanAmount: 3, price: 2, value: 6 }],
  );
  assertEquals(out.map((p) => [p.networkId, p.tokenAddress, p.humanAmount]), [[8453, "0xA", 5], [56, "0xA", 5], [SOLANA_NETWORK_ID, "Mint1", 3]]);
});

Deno.test("rejectBuild: empty, under half addressed, or shrinking past 20% is refused", () => {
  const board = (n: number, addressed: (i: number) => boolean) =>
    parseLeaderboard({ traders: Array.from({ length: n }, (_, i) => entry({ handle: `h${i}`, wallets: addressed(i) ? { evm: "0x1" } : undefined })) }, 100);
  const ok = board(10, () => true);
  assertEquals(rejectBuild([], null), "leaderboard returned no traders");
  assertEquals(rejectBuild(ok, null), null);
  assertEquals(rejectBuild(ok, 12), null);
  assertEquals(rejectBuild(ok, 13)?.startsWith("got 10 traders but the previous build has 13"), true);
  assertEquals(rejectBuild(board(10, (i) => i >= 5), null), null);
  assertEquals(rejectBuild(board(10, (i) => i >= 6), null)?.startsWith("only 4/10"), true);
});

Deno.test("rows: handle lowercased for the key, display kept; wallet row null without an address; token case kept once", () => {
  const [e] = parseLeaderboard({ traders: [entry()] }, 100);
  const at = new Date("2026-09-17T06:00:00Z");
  assertEquals(traderRow(e), { handle: "theveeman", display_handle: "TheVeeman", name: "Vee", avatar: "a.png", bio: "", twitter: "", verified: true, source: "fomoapi.io" });
  assertEquals(statsRow(e, at), { handle: "theveeman", captured_at: at, rank: 3, pnl_usd: 12.5, volume_usd: 100, trade_count: 7, followers: 9 });
  assertEquals(walletRow(e), { handle: "theveeman", evm_address: "0xabc", evm_source: "fomoapi.io", sol_address: "So1ana", sol_source: "fomoapi.io" });
  assertEquals(walletRow(parseLeaderboard({ traders: [entry({ wallets: { evm: " " } })] }, 100)[0]), null);
  const positions = [
    { tokenAddress: "Mint1", networkId: SOLANA_NETWORK_ID, humanAmount: 3, price: null, value: null },
    { tokenAddress: "mint1", networkId: SOLANA_NETWORK_ID, humanAmount: 4, price: 1, value: 4 },
  ];
  assertEquals(tokenRows(positions), [{ network_id: SOLANA_NETWORK_ID, address: "Mint1" }]);
  assertEquals(holdingRows("theveeman", at, positions)[1], { handle: "theveeman", network_id: SOLANA_NETWORK_ID, token_key: "mint1", captured_at: at, human_amount: 4, price: 1, value: 4 });
});
