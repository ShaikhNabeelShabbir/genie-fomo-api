import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { scorecardBody, scorecardRows } from "../supabase/functions/api/shared/scorecard-core.ts";

/*
 * AF-3 (19 Sep 2026). scorecardRows recounts, for every coin on the page, how many traders ever traded
 * it (the co join: 40-50% of the statement), and the roster page passes tokens: 0. This pins what makes
 * dropping that join from the list SAFE: co_holders reaches byToken[].coHolders and nothing else.
 */
const db = await openSchema();
db.exec(`
  insert into traders (handle, display_handle, id) values ('a','A','id-a'), ('b','B','id-b');
  insert into tokens (network_id, address, token_key, total_supply) values (1,'0xaa','0xaa',1000000), (1,'0xbb','0xbb',1000000);
  insert into trades (trade_id, handle, network_id, token_address, token_key, token_symbol, status, amount,
                      avg_entry_price, avg_exit_price, realized_pnl_usd, opened_at, closed_at, captured_at) values
    ('1','a',1,'0xaa','0xaa','AA','closed',10,1,2,10,'2026-09-01T00:00:00.000Z','2026-09-02T00:00:00.000Z','2026-09-18T00:00:00.000Z'),
    ('2','a',1,'0xbb','0xbb','BB','open',5,1,null,null,'2026-09-03T00:00:00.000Z',null,'2026-09-18T00:00:00.000Z'),
    ('3','b',1,'0xaa','0xaa','AA','closed',10,1,3,20,'2026-09-01T00:00:00.000Z','2026-09-02T00:00:00.000Z','2026-09-18T00:00:00.000Z');`);

Deno.test("list scorecard: with tokens 0 the body is the same whether co_holders was counted or not", async () => {
  const rows = (await scorecardRows(["a"])) as Record<string, unknown>[];
  assertEquals(rows.map((r) => r.co_holders).sort(), [0, 1], "the seed really has a coin another trader holds");
  const uncounted = rows.map((r) => ({ ...r, co_holders: null }));
  const t = { handle: "a", display_handle: "A" };
  const clock = Date.now;
  Date.now = () => Date.parse("2026-09-19T12:00:00.000Z"); // the body carries ages; both must be built at one instant
  try {
    assertEquals(await scorecardBody(t, uncounted, 0), await scorecardBody(t, rows, 0));
    /* Not vacuous: the single-trader route serves byToken, and there the count is published. */
    const full = await scorecardBody(t, rows, null), blind = await scorecardBody(t, uncounted, null);
    assertNotEquals(blind, full);
    assert("byToken" in full && (full.byToken as { coHolders: number | null }[]).some((c) => c.coHolders === 1));
  } finally {
    Date.now = clock;
  }
});
