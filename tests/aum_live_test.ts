import { assertEquals } from "jsr:@std/assert@1";
import { addressKeys, shapeRows } from "../worker/src/helius.ts";

/* aum_live (17 Sep 2026): the webhook revalues the traders whose wallets a delivery touched.
   The SQL (aum_live_refresh) lives in migration 20260918030000; only the key grouping is pure. */

const A = "WatchedA";
const B = "WatchedB";
const watched = new Set([A.toLowerCase(), B.toLowerCase()]);

Deno.test("addressKeys: distinct lowercased wallet keys, first-seen order", () => {
  const { rows } = shapeRows([{
    signature: "s", timestamp: 1,
    nativeTransfers: [
      { fromUserAccount: A, toUserAccount: B, amount: 1 },
      { fromUserAccount: B, toUserAccount: A, amount: 2 },
      { fromUserAccount: "stranger", toUserAccount: A, amount: 3 },
    ],
  }], watched);
  assertEquals(rows.length, 5);
  assertEquals(addressKeys(rows), ["watcheda", "watchedb"]);
});

Deno.test("addressKeys: no rows, no keys", () => {
  assertEquals(addressKeys([]), []);
});
