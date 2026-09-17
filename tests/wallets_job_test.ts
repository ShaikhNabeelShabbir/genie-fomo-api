import { assertEquals } from "jsr:@std/assert@1";
import { accountKeys, DENY, DUST_SOL, MIN_SOL, resolveCase } from "../worker/src/jobs/wallets-core.ts";

// Expected values mirror scripts/link_wallets.mjs (the twin).

const res = {
  result: {
    transaction: { message: { accountKeys: [{ pubkey: "AbC123", signer: true }, "DeF456", { nope: 1 }] } },
    meta: { loadedAddresses: { writable: ["GhI789"], readonly: ["JkL012", 7] } },
  },
};

Deno.test("accountKeys: static keys (object or string), then loaded writable and readonly", () => {
  assertEquals(accountKeys(res), ["AbC123", "DeF456", "GhI789", "JkL012"]);
  assertEquals(accountKeys(null), []);
  assertEquals(accountKeys({ result: null }), []);
  assertEquals(accountKeys({ result: { transaction: {} } }), []);
});

Deno.test("resolveCase: case-preserved spelling of a lowercased key, null when absent", () => {
  assertEquals(resolveCase(res, "abc123"), "AbC123");
  assertEquals(resolveCase(res, "jkl012"), "JkL012");
  assertEquals(resolveCase(res, "zzz"), null);
  assertEquals(resolveCase(undefined, "abc123"), null);
});

Deno.test("constants: DENY is lowercased to match transactions.counterparty; thresholds as the script", () => {
  assertEquals(DENY.length, 10);
  assertEquals(DENY.every((a) => a === a.toLowerCase()), true);
  assertEquals(DENY[0], "11111111111111111111111111111111");
  assertEquals([DUST_SOL, MIN_SOL], [0.003, 0.05]);
});
