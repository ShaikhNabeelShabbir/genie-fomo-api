import { assertEquals } from "jsr:@std/assert@1";
import { askable, failedInARow, positionRows, sliceSize } from "../worker/src/jobs/balances-core.ts";
import { SOLANA_NETWORK_ID } from "../supabase/functions/_shared/chain_reads.ts";

const chains = [
  { network_id: SOLANA_NETWORK_ID, name: "solana", rpc: "https://helius" },
  { network_id: 56, name: "bsc", rpc: "https://bsc" },
  { network_id: 8453, name: "base", rpc: "https://base" },
];

Deno.test("sliceSize: env value or the default", () => {
  assertEquals(sliceSize(undefined), 25);
  assertEquals(sliceSize("40"), 40);
  assertEquals(sliceSize("0"), 25);
  assertEquals(sliceSize("x"), 25);
});

Deno.test("askable: solana needs the sol wallet, every EVM chain needs the evm wallet", () => {
  const both = { handle: "a", sol_address: "So1", evm_address: "0x1" };
  assertEquals(askable(both, chains).map((c) => c.name), ["solana", "bsc", "base"]);
  assertEquals(askable({ ...both, sol_address: null }, chains).map((c) => c.name), ["bsc", "base"]);
  assertEquals(askable({ ...both, evm_address: null }, chains).map((c) => c.name), ["solana"]);
  assertEquals(askable({ handle: "b", sol_address: null, evm_address: null }, chains), []);
});

Deno.test("positionRows: key lowercased, address kept as the chain spells it", () => {
  assertEquals(positionRows("a", 56, [{ address: "0xAbC", amount: "1.5" }]), [
    { handle: "a", network_id: 56, token_key: "0xabc", address: "0xAbC", amount: "1.5" },
  ]);
});

Deno.test("failedInARow: a source counts the traders it answered nothing for; any answer resets it, not being asked leaves it", () => {
  const [solana, bsc, base] = chains;
  const none = { helius: 0, bitquery: 0 };
  // Helius refuses, Bitquery answers one of its two chains: only Helius counts.
  assertEquals(failedInARow(none, [solana, bsc, base], [false, false, true]), { helius: 1, bitquery: 0 });
  // An EVM-only trader says nothing about Helius; every EVM chain failing is one more for Bitquery.
  assertEquals(failedInARow({ helius: 4, bitquery: 2 }, [bsc, base], [false, false]), { helius: 4, bitquery: 3 });
  assertEquals(failedInARow({ helius: 4, bitquery: 2 }, [solana], [true]), { helius: 0, bitquery: 2 });
  // A Solana-only trader reached after Solana was left out is asked nothing: the count stays where it stopped.
  assertEquals(failedInARow({ helius: 5, bitquery: 0 }, [], []), { helius: 5, bitquery: 0 });
});
