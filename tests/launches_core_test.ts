import { assertEquals } from "jsr:@std/assert@1";
import { accountData, fromBase64, rpcError, signatures } from "../worker/src/jobs/launches-core.ts";

/* Reply shapes load_token_launch.mjs reads by hand: getAccountInfo (base64) and getSignaturesForAddress. */

Deno.test("rpcError: only an error envelope is an error, and it is trimmed to 80 chars", () => {
  assertEquals(rpcError({ jsonrpc: "2.0", result: null }), null);
  assertEquals(rpcError({ error: { code: -32602, message: "Invalid param" } }), "Invalid param");
  assertEquals(rpcError({ error: {} }), "rpc error");
  assertEquals(rpcError({ error: { message: "x".repeat(100) } })?.length, 80);
  assertEquals(rpcError("nope"), null);
});

Deno.test("accountData: the base64 blob, or null when the account does not exist", () => {
  assertEquals(accountData({ result: { value: { data: ["AAEC", "base64"] } } }), "AAEC");
  assertEquals(accountData({ result: { value: null } }), null);
  assertEquals(accountData({ result: { value: { data: "AAEC" } } }), null);
  assertEquals(accountData(undefined), null);
  assertEquals([...fromBase64("AAEC")], [0, 1, 2]);
});

Deno.test("signatures: the result list with malformed entries dropped, in order", () => {
  const j = { result: [{ signature: "a", blockTime: 1758067200 }, { signature: "b", blockTime: null }, { nope: 1 }, "x"] };
  assertEquals(signatures(j), [{ signature: "a", blockTime: 1758067200 }, { signature: "b", blockTime: null }]);
  assertEquals(signatures({ result: null }), []);
  assertEquals(signatures({ error: { message: "boom" } }), []);
});
