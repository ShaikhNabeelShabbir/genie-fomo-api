import { assertEquals } from "jsr:@std/assert@1";
import { askable, positionRows, sliceSize, tradedKey } from "../worker/src/jobs/balances-core.ts";
import { SOLANA_NETWORK_ID } from "../supabase/functions/_shared/chain_reads.ts";

const chains = [
  { network_id: SOLANA_NETWORK_ID, name: "solana", rpc: "https://helius" },
  { network_id: 56, name: "bsc", rpc: "https://bsc" },
  { network_id: 8453, name: "base", rpc: "https://base" },
];
const traded = new Map([[tradedKey("a", 56), [{ token_key: "0xabc", address: "0xAbC" }]]]);

Deno.test("sliceSize: env value or the default", () => {
  assertEquals(sliceSize(undefined), 25);
  assertEquals(sliceSize("40"), 40);
  assertEquals(sliceSize("0"), 25);
  assertEquals(sliceSize("x"), 25);
});

Deno.test("askable: solana needs the sol wallet, an EVM chain needs the wallet and traded tokens", () => {
  const both = { handle: "a", sol_address: "So1", evm_address: "0x1" };
  assertEquals(askable(both, chains, traded).map((c) => c.name), ["solana", "bsc"]);
  assertEquals(askable({ ...both, sol_address: null }, chains, traded).map((c) => c.name), ["bsc"]);
  assertEquals(askable({ ...both, evm_address: null }, chains, traded).map((c) => c.name), ["solana"]);
  assertEquals(askable({ handle: "b", sol_address: null, evm_address: "0x2" }, chains, traded), []);
});

Deno.test("positionRows: key lowercased, address kept as the chain spells it", () => {
  assertEquals(positionRows("a", 56, [{ address: "0xAbC", amount: "1.5" }]), [
    { handle: "a", network_id: 56, token_key: "0xabc", address: "0xAbC", amount: "1.5" },
  ]);
});
