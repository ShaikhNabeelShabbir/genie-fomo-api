import { assertEquals } from "jsr:@std/assert@1";
import { NETWORK_OF, chunk, dedupe, pickWebhook, providerOf, toRows, webhooksOf } from "../worker/src/jobs/transfers-core.ts";
import type { Transfer } from "../supabase/functions/_shared/transactions.ts";

// Expected values mirror scripts/backfill_transactions.mjs and scripts/register_webhook.mjs.

const SOL = "11111111111111111111111111111111";
const w = { handle: "unipcs", evm_address: "0xABC", sol_address: "So1Wallet" };
const base: Transfer = {
  chain: "solana", tx_hash: "sig1", time: 1_700_000_000, time_iso: null, token: "mint…1234",
  contract: "MintAddr1", amount: 5, side: "in", from: "Other", to: "So1Wallet", explorer_url: null,
  type: "SWAP", source: "JUPITER",
};

Deno.test("NETWORK_OF: solana plus every EVM chain by name", () => {
  assertEquals(NETWORK_OF.get("solana"), 1399811149);
  assertEquals(NETWORK_OF.get("ethereum"), 1);
  assertEquals(NETWORK_OF.get("robinhood"), 4663);
  assertEquals(providerOf("solana"), "helius");
  assertEquals(providerOf("base"), "bitquery");
  assertEquals(providerOf("ethereum"), "bitquery");
  assertEquals(providerOf("robinhood"), "bitquery");
});

Deno.test("toRows: solana row keys on the sol wallet, counterparty is the other end of the leg, time from seconds", () => {
  assertEquals(toRows(w, [base]), [[
    1399811149, "sig1", "so1wallet", "2023-11-14T22:13:20.000Z", "in", "other", "mintaddr1", "mint…1234", 5, "helius", "SWAP", "JUPITER",
  ]]);
  const out = toRows(w, [{ ...base, side: "out", from: "So1Wallet", to: "Other" }]);
  assertEquals(out[0][5], "other");
});

Deno.test("toRows: a native leg is stored under SOL's quote_assets key; evm rows key on the evm wallet", () => {
  const native = toRows(w, [{ ...base, contract: "native", token: "SOL" }]);
  assertEquals(native[0][6], SOL);
  const evm = toRows(w, [{ ...base, chain: "ethereum", tx_hash: "0xh", time_iso: "2026-01-01T00:00:00.000Z", type: undefined, source: undefined }]);
  assertEquals(evm[0].slice(0, 4), [1, "0xh", "0xabc", "2026-01-01T00:00:00.000Z"]);
  assertEquals(evm[0].slice(9), ["bitquery", null, null]);
});

Deno.test("toRows: skips an unknown chain, a missing hash, and a chain the wallet has no address on", () => {
  assertEquals(toRows(w, [{ ...base, chain: "tron" }]), []);
  assertEquals(toRows(w, [{ ...base, tx_hash: "" }]), []);
  assertEquals(toRows({ ...w, sol_address: null }, [base]), []);
  assertEquals(toRows(w, [{ ...base, amount: null }])[0][8], null);
});

Deno.test("dedupe: collapses rows identical on the digest fields, keeps the rest", () => {
  const rows = toRows(w, [base, { ...base, token: "renamed" }, { ...base, amount: 6 }, { ...base, tx_hash: "sig2" }]);
  assertEquals(dedupe(rows).map((r) => [r[1], r[8]]), [["sig1", 5], ["sig1", 6], ["sig2", 5]]);
});

Deno.test("chunk: splits under the bind-parameter ceiling", () => {
  assertEquals(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assertEquals(chunk([], 2), []);
});

Deno.test("webhooksOf / pickWebhook: ours by URL, else the first, else null", () => {
  const list = webhooksOf([{ webhookID: "a", webhookURL: "https://x/1" }, { webhookID: "b", webhookURL: "https://x/2" }, { bad: true }, null]);
  assertEquals(list.length, 2);
  assertEquals(pickWebhook(list, "https://x/2")?.webhookID, "b");
  assertEquals(pickWebhook(list, "https://x/9")?.webhookID, "a");
  assertEquals(pickWebhook([], "https://x/9"), null);
  assertEquals(webhooksOf({ not: "an array" }), []);
});
