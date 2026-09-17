import { assertEquals } from "jsr:@std/assert@1";
import { readBatch, readBitqueryFees, solanaFee } from "../worker/src/jobs/fees-core.ts";

/* Solana cases derived from scripts/load_transaction_fees.mjs; the EVM cases are one Bitquery
   `EVM.Transactions` reply (https://docs.bitquery.io/docs/usecases/mempool-transaction-fee/). */

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

Deno.test("readBatch: ids index the signatures sent; null or fee-less results are missing; unknown ids are ignored", () => {
  const reply = [
    { id: 0, result: { meta: { fee: 5000 } } },
    { id: 1, result: null },
    { id: 7, result: { meta: { fee: 5000 } } },
    { id: 2, result: { meta: {} } },
  ];
  assertEquals(readBatch(reply, ["s1", "s2", "s3"]), { fees: [{ hash: "s1", fee: "0.000005" }], missing: 2 });
});

Deno.test("readBatch: a non-array reply is a refusal, not an empty answer", () => {
  assertEquals(readBatch({ jsonrpc: "2.0", error: { message: "maximum 10 calls in 1 batch" } }, ["s1"]), null);
  assertEquals(readBatch(null, ["s1"]), null);
  assertEquals(readBatch([], ["s1"]), { fees: [], missing: 0 });
});

const HASHES = ["0xAAA1", "0xbbb2", "0xccc3", "0xddd4", "0xeee5"];
/** One reply: SenderFee for A, Cost only for B, a stray hash, C twice, D with junk, E absent. */
const reply = {
  EVM: {
    Transactions: [
      { Transaction: { Hash: "0xaaa1", Cost: "0.001" }, Fee: { SenderFee: "0.000021" } },
      { Transaction: { Hash: "0xbbb2", Cost: 0.0005 }, Fee: null },
      { Transaction: { Hash: "0xffff", Cost: "9" }, Fee: { SenderFee: "9" } },
      { Transaction: { Hash: "0xccc3", Cost: "1" }, Fee: { SenderFee: "1" } },
      { Transaction: { Hash: "0xccc3", Cost: "2" }, Fee: { SenderFee: "2" } },
      { Transaction: { Hash: "0xddd4", Cost: "-1" }, Fee: { SenderFee: "1e-5" } },
    ],
  },
};

Deno.test("readBitqueryFees: SenderFee first, Cost as the fallback; hashes match case-insensitively and keep the sent spelling", () => {
  assertEquals(readBitqueryFees(reply, HASHES), {
    fees: [{ hash: "0xAAA1", fee: "0.000021" }, { hash: "0xbbb2", fee: "0.0005" }, { hash: "0xccc3", fee: "1" }],
    missing: 2,
  });
});

Deno.test("readBitqueryFees: a hash never asked for is never trusted; a non-decimal fee is absent, never zero", () => {
  const { fees } = readBitqueryFees(reply, HASHES)!;
  assertEquals(fees.some((f) => f.hash === "0xffff" || f.hash === "0xddd4"), false);
});

Deno.test("readBitqueryFees: a reply without the Transactions list is a refusal; an empty list is all missing", () => {
  assertEquals(readBitqueryFees({ EVM: {} }, HASHES), null);
  assertEquals(readBitqueryFees(undefined, HASHES), null);
  assertEquals(readBitqueryFees({ EVM: { Transactions: [] } }, ["0xa"]), { fees: [], missing: 1 });
});
