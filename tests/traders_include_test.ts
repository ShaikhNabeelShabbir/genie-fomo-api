import { assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { handle } from "../supabase/functions/api/app.ts";
import "../supabase/functions/api/routes.ts";

const db = await openSchema();
db.exec("insert into builds (captured_at, window_label, trader_count, holding_count) values ('2026-09-19T01:00:00.000Z','30d',30,0)");
for (let i = 0; i < 30; i++) db.prepare("insert into traders (handle, display_handle, id) values (?,?,?)").run(`new${i}`, `New${i}`, `id-${i}`);

const list = (q: string): Promise<Response> => handle(new Request(`https://test.local/v2/traders?${q}`));

Deno.test("/traders: a trader with no stored trades is scorecard null on a narrow page, not a 503 that says retry for ever", async () => {
  /* The 01:00 directory job adds a trader hours before the scorecard loader reaches him. */
  for (const q of ["q=new7&include=scorecard", "limit=1&include=pnl,scorecard", "limit=24&include=scorecard"]) {
    const res = await list(q);
    assertEquals(res.status, 200, q);
    const body = await res.json() as { entries: { included: { scorecard: unknown } }[] };
    assertEquals(body.entries.every((e) => e.included.scorecard === null), true, q);
  }
});

Deno.test("/traders: a whole page of 25 or more with nothing for a requested include is still a fault, said loudly", async () => {
  const original = console.error;
  console.error = () => undefined; // the app logs every 5xx
  try {
    const res = await list("limit=25&include=scorecard");
    const body = await res.json();
    assertEquals([res.status, body.error.code, body.error.blocks], [503, "include_unavailable", ["scorecard"]]);
  } finally {
    console.error = original;
  }
});
