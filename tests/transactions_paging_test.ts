import { assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { handle } from "../supabase/functions/api/app.ts";
import { encodeCursor } from "../supabase/functions/api/shared/cursor.ts";
import "../supabase/functions/api/routes.ts";

const db = await openSchema();
db.exec(`
  insert into traders (handle, display_handle, id) values ('a','A','id-a');
  insert into wallets (handle, evm_address) values ('a','0xA');
  insert into transactions (network_id, tx_hash, address_key, block_time, direction, amount, source, transfer_key) values
    (1,'0x1','0xa','2026-09-12T10:00:00.000Z','in',1,'t','k'), (1,'0x2','0xa','2026-09-11T10:00:00.000Z','in',2,'t','k'),
    (1,'0x3','0xa','2026-09-10T10:00:00.000Z','in',3,'t','k'),
    (1,'0x4','0xa',null,'in',4,'t','k'), (1,'0x5','0xa',null,'in',5,'t','k'), (1,'0x6','0xa',null,'in',6,'t','k');
  insert into wallet_swaps (network_id, tx_hash, address_key, block_time, token_key, token_delta) values
    (1,'0xs1','0xa','2026-09-10T10:00:00.000Z','0xtok',1), (1,'0xs2','0xa','2026-09-11T10:00:00.000Z','0xtok',1),
    (1,'0xs3','0xa','2026-09-12T10:00:00.000Z','0xtok',1);`);

const get = (path: string): Promise<Response> => handle(new Request(`https://test.local/v2/traders/a/${path}`));

Deno.test("/transactions: a page that ends on an undated row is a 200 with a cursor, and paging reaches every row once", async () => {
  /* block_time is nullable and sorts last; the cursor was built with new Date("null") and answered 500. */
  for (const limit of [1, 2, 4, 5]) {
    const got: number[] = [];
    for (let cursor: string | null = null, i = 0; i < 10; i++) {
      const res = await get(`transactions?money=false&limit=${limit}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
      assertEquals(res.status, 200, `limit=${limit} page ${i}`);
      const body = await res.json() as { nextCursor: string | null; transfers: { amount: number }[] };
      got.push(...body.transfers.map((t) => t.amount));
      if ((cursor = body.nextCursor) === null) break;
    }
    assertEquals(got, [1, 2, 3, 4, 5, 6], `limit=${limit}`);
  }
});

Deno.test("/trades: since and until are instants, and a bad bound, chain or cursor is a 400, not a 200 with the wrong rows", async () => {
  const hashes = async (q: string): Promise<string[]> => {
    const res = await get(`trades?${q}`);
    assertEquals(res.status, 200, q);
    return ((await res.json()) as { trades: { txHash: string }[] }).trades.map((t) => t.txHash);
  };
  /* 15:30+05:30 is 10:00Z: compared as text it dropped the swap AT 10:00Z. */
  assertEquals(await hashes(`since=${encodeURIComponent("2026-09-11T15:30:00+05:30")}`), ["0xs3", "0xs2"]);
  assertEquals(await hashes("until=2026-09-11"), ["0xs1"]);
  for (const q of ["since=yesterday", "since=1789000000000", "until=garbage", "chain=bogus",
    `cursor=${encodeCursor([1, 2])}`, `cursor=${encodeCursor(["2026-09-11T10:00:00.000Z", "0x2", 1, "0xa", "k"])}`]) {
    const res = await get(`trades?${q}`);
    assertEquals([res.status, (await res.json()).error.code], [400, "bad_request"], q);
  }
  assertEquals(await hashes(`cursor=${encodeCursor(["2026-09-12T10:00:00.000Z", "0xs3"])}`), ["0xs2", "0xs1"]);
});
