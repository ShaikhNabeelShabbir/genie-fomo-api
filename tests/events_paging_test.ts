import { assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { handle } from "../supabase/functions/api/app.ts";
import { encodeCursor } from "../supabase/functions/api/shared/cursor.ts";
import "../supabase/functions/api/routes.ts";

/* One transaction holds several transfer rows, and may touch two watched wallets: all share (at, kind, txHash).
 * 0xty touches ONE address two traders both claim, so only the handle tells its rows apart. */
const db = await openSchema();
const AT = "2026-09-17T10:00:00.000Z", AT2 = "2026-09-17T11:00:00.000Z";
db.exec(`
  insert into traders (handle, display_handle, id) values ('a','A','id-a'), ('b','B','id-b'), ('c','C','id-c'), ('d','D','id-d');
  insert into wallets (handle, evm_address) values ('a','0xA'), ('b','0xB'), ('c','0xS'), ('d','0xS');
  insert into transactions (network_id, tx_hash, address_key, block_time, direction, amount, source, transfer_key) values
    (1,'0xtx','0xa','${AT}','out',1,'t','leg1'), (1,'0xtx','0xa','${AT}','in',2,'t','leg2'),
    (1,'0xtx','0xa','${AT}','in',3,'t','leg3'), (1,'0xtx','0xb','${AT}','in',1,'t','leg1'),
    (1,'0xty','0xs','${AT2}','in',9,'t','leg1');
  insert into wallet_swaps (network_id, tx_hash, address_key, block_time, token_key, token_delta) values
    (1,'0xtx','0xa','${AT}','0xtok',5), (1,'0xtx','0xb','${AT}','0xtok',-5), (1,'0xty','0xs','${AT2}','0xtok',4);`);

type Page = { nextCursor: string | null; events: { kind: string; handle: string; amount?: number }[] };
const page = async (cursor: string | null, limit: number): Promise<Page> => {
  const q = `since=2026-09-17T00:00:00.000Z&limit=${limit}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
  const res = await handle(new Request(`https://test.local/v2/events?${q}`));
  assertEquals(res.status, 200);
  return await res.json() as Page;
};
const label = (e: Page["events"][number]): string => `${e.kind}:${e.handle}:${e.amount ?? ""}`;
const ALL = ["swap:A:", "swap:B:", "transfer:A:1", "transfer:A:2", "transfer:A:3", "transfer:B:1",
  "swap:C:", "swap:D:", "transfer:C:9", "transfer:D:9"];

Deno.test("/events: following nextCursor delivers every leg of a transaction once, at any page size", async () => {
  for (const limit of [1, 2, 3, 5]) {
    const got: string[] = [];
    for (let cursor: string | null = null, i = 0; i < 20; i++) {
      const p = await page(cursor, limit);
      got.push(...p.events.map(label));
      if ((cursor = p.nextCursor) === null) break;
    }
    assertEquals(got, ALL, `limit=${limit}`);
  }
});

Deno.test("/events: a 3-part cursor issued before the fix re-delivers the boundary transaction's legs, and loses none", async () => {
  const p = await page(encodeCursor([AT, "transfer", "0xtx"]), 10);
  assertEquals(p.events.map(label), ALL.slice(2));
});
