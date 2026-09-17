import { assertEquals } from "jsr:@std/assert@1";
import { evmFee, readBatch, solanaFee } from "../worker/src/jobs/fees-core.ts";

/* Cases derived from scripts/load_transaction_fees.mjs: evmFee, the lamport scaling and the batch reader. */

Deno.test("evmFee: gasUsed x effectiveGasPrice, exact, scaled to 18 decimals with trailing zeros dropped", () => {
  // 21000 gas x 1 gwei = 0.000021 ETH
  assertEquals(evmFee({ gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00" }), "0.000021");
  // 1 gas x 1 wei = 1e-18
  assertEquals(evmFee({ gasUsed: "0x1", effectiveGasPrice: "0x1" }), "0.000000000000000001");
  // exactly 1 ETH: no fractional part at all
  assertEquals(evmFee({ gasUsed: "0xde0b6b3a7640000", effectiveGasPrice: "0x1" }), "1");
  assertEquals(evmFee({ gasUsed: "0x0", effectiveGasPrice: "0x1" }), "0");
});

Deno.test("evmFee: a receipt without string gas fields is absent, never zero", () => {
  assertEquals(evmFee({ gasUsed: 21000, effectiveGasPrice: "0x1" }), null);
  assertEquals(evmFee({ gasUsed: "0x5208" }), null);
  assertEquals(evmFee({ gasUsed: "nope", effectiveGasPrice: "0x1" }), null);
  assertEquals(evmFee(null), null);
  assertEquals(evmFee("0x5208"), null);
});

Deno.test("solanaFee: meta.fee lamports scaled to SOL, kept as a string", () => {
  assertEquals(solanaFee({ meta: { fee: 5000 } }), "0.000005");
  assertEquals(solanaFee({ meta: { fee: 1_000_000_000 } }), "1");
  assertEquals(solanaFee({ meta: { fee: 1_234_567_890 } }), "1.23456789");
  assertEquals(solanaFee({ meta: { fee: 0 } }), "0");
  assertEquals(solanaFee({ meta: { fee: "5000" } }), null);
  assertEquals(solanaFee({ meta: {} }), null);
  assertEquals(solanaFee({}), null);
  assertEquals(solanaFee(null), null);
});

Deno.test("readBatch: ids index the hashes sent; null results are missing; unknown ids are ignored", () => {
  const hashes = ["0xa", "0xb", "0xc"];
  const reply = [
    { id: 0, result: { gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00" } },
    { id: 1, result: null },
    { id: 7, result: { gasUsed: "0x5208", effectiveGasPrice: "0x1" } },
    { id: 2, result: { gasUsed: "0x1", effectiveGasPrice: "0x1" } },
  ];
  assertEquals(readBatch(reply, hashes, "evm"), {
    fees: [{ hash: "0xa", fee: "0.000021" }, { hash: "0xc", fee: "0.000000000000000001" }],
    missing: 1,
  });
});

Deno.test("readBatch: solana reads meta.fee; a result without one is missing", () => {
  const reply = [{ id: 0, result: { meta: { fee: 5000 } } }, { id: 1, result: { meta: {} } }];
  assertEquals(readBatch(reply, ["s1", "s2"], "solana"), { fees: [{ hash: "s1", fee: "0.000005" }], missing: 1 });
});

Deno.test("readBatch: a non-array reply is a refusal, not an empty answer", () => {
  assertEquals(readBatch({ jsonrpc: "2.0", error: { message: "maximum 10 calls in 1 batch" } }, ["0xa"], "evm"), null);
  assertEquals(readBatch(null, ["0xa"], "evm"), null);
  assertEquals(readBatch([], ["0xa"], "evm"), { fees: [], missing: 0 });
});
