import { assertEquals } from "jsr:@std/assert@1";
import { shapeRows } from "../worker/src/helius.ts";

const A = "WatchedA";
const B = "WatchedB";
const watched = new Set([A.toLowerCase(), B.toLowerCase()]);

Deno.test("shapeRows: one row per watched side, SOL under the system address, zero lamports skipped", () => {
  const { rows, skipped } = shapeRows([
    {
      signature: "sig1", timestamp: 1_700_000_000, type: "SWAP", source: "JUPITER",
      tokenTransfers: [
        { fromUserAccount: A, toUserAccount: B, mint: "Mint1", tokenAmount: 2.5 },
        { fromUserAccount: A, toUserAccount: "stranger", tokenAmount: 1 }, // no mint → skipped
      ],
      nativeTransfers: [
        { fromUserAccount: "stranger", toUserAccount: A, amount: 1_500_000_000 },
        { fromUserAccount: A, toUserAccount: B, amount: 0 }, // bookkeeping → skipped
      ],
    },
    { timestamp: "not a number" }, // no signature → skipped
  ], watched);

  assertEquals(skipped, 3);
  assertEquals(rows.map((r) => [r[2], r[4], r[6], r[7]]), [
    ["watcheda", "out", "mint1", 2.5],
    ["watchedb", "in", "mint1", 2.5],
    ["watcheda", "in", "11111111111111111111111111111111", 1.5],
  ]);
  assertEquals(rows[0][3], "2023-11-14T22:13:20.000Z");
  assertEquals(rows[0].slice(8), ["helius-webhook", "SWAP", "JUPITER"]);
});

Deno.test("shapeRows: non-array payloads and junk are tolerated", () => {
  assertEquals(shapeRows(null, watched), { rows: [], skipped: 1 });
  assertEquals(shapeRows({ signature: "s", timestamp: 1 }, watched), { rows: [], skipped: 0 });
});
