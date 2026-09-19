import { assert, assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { getDefaultSql } from "../supabase/functions/api/db.ts";
import { currentHoldings } from "../supabase/functions/_shared/current_holdings.ts";

const SOL = 1399811149;

Deno.test("currentHoldings: the rows of the holdings_current view, reached per (trader, chain) and not per row", async () => {
  const db = await openSchema();
  const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
  for (const h of ["a", "b", "c", "d", "gone"]) run("insert into traders (handle, display_handle, id, listed) values (?,?,?,?)", h, h, `id-${h}`, h === "gone" ? 0 : 1);
  for (const k of ["x", "y", "z"]) for (const net of [1, SOL]) run("insert into tokens (network_id, address, token_key) values (?,?,?)", net, k, k);
  const hold = (h: string, net: number, k: string, at: string, amount: number | null, source: string): void =>
    run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, source) values (?,?,?,?,?,?)", h, net, k, at, amount, source);
  const OLD = "2026-09-18T01:00:00.000Z", NEW = "2026-09-19T01:00:00.000Z", CHAIN1 = "2026-09-19T05:00:00.000Z", CHAIN2 = "2026-09-19T09:00:00.000Z";
  // a: two chain captures on ethereum (only the newer is current), and a coin dropped between them
  hold("a", 1, "x", CHAIN1, 5, "chain"); hold("a", 1, "y", CHAIN1, 7, "chain"); hold("a", 1, "x", CHAIN2, 6, "chain");
  // a on solana: never read on chain, so the newest fomo build stands; the older build does not
  hold("a", SOL, "z", OLD, 1, "fomo"); hold("a", SOL, "z", NEW, 2, "fomo");
  // b: a fomo row on ethereum HIDDEN by a chain capture of the same (trader, chain), even one holding another coin
  hold("b", 1, "x", NEW, 9, "fomo"); hold("b", 1, "y", CHAIN1, 3, "chain");
  // c: a zero and a null amount are rows of the view too; callers filter amounts, the source does not
  hold("c", 1, "x", CHAIN2, 0, "chain"); hold("c", 1, "y", CHAIN2, null, "chain");
  // d: nothing at all. gone: delisted, still a trader, still has holdings
  hold("gone", SOL, "x", CHAIN1, 4, "chain");
  const key = (r: Record<string, unknown>) => `${r.handle}|${r.network_id}|${r.token_key}|${r.captured_at}|${r.human_amount}|${r.source}`;
  const view = (db.prepare("select * from holdings_current").all() as Record<string, unknown>[]).map(key).sort();
  const frag = currentHoldings(getDefaultSql()!);
  const mine = (db.prepare(`select * from ${frag.text} h`).all() as Record<string, unknown>[]).map(key).sort();
  assertEquals(mine, view);
  assertEquals(view.length, 6); // a:x(new capture) a:z(newest fomo) b:y c:x c:y gone:x
  const cols = (q: string) => Object.keys(db.prepare(q).get() as Record<string, unknown>);
  assertEquals(cols(`select * from ${frag.text} h limit 1`), cols("select * from holdings_current limit 1"), "same columns in the same order");
  const plan = (db.prepare(`explain query plan select h.network_id, h.token_key, count(distinct h.handle) from ${frag.text} h where h.human_amount > 0 group by 1, 2`).all() as { detail: string }[]).map((r) => r.detail);
  assert(plan.some((d) => /SEARCH h USING INDEX holdings_source_handle_net_idx \(source=\? AND handle=\? AND network_id=\? AND captured_at=\?\)/.test(d)), plan.join(" | "));
  // The view's whole read is `SEARCH h ... holdings_source_handle_net_idx (source=?)`: every chain row. That line must be gone.
  assert(!plan.some((d) => /holdings_source_handle_net_idx \(source=\?\)$/.test(d) || /^SCAN holdings\b/.test(d)), "no pass over every chain row: " + plan.join(" | "));
  const viewPlan = (db.prepare("explain query plan select network_id, token_key, count(distinct handle) from holdings_current where human_amount > 0 group by 1, 2").all() as { detail: string }[]).map((r) => r.detail);
  assert(viewPlan.some((d) => /holdings_source_handle_net_idx \(source=\?\)$/.test(d)), "the view, read whole, does make that pass (if this stops being true, this helper may no longer be needed): " + viewPlan.join(" | "));
});

Deno.test("currentHoldings cannot be flattened into its caller: a big table to its LEFT still leaves the pair walk whole", async () => {
  /* The shape a skeptic found on 19 Sep 2026: non-aggregate, tokens first. Flattened, tokens ran OUTSIDE the walk: 424 ms -> 28 s. */
  const db = await openSchema();
  const frag = currentHoldings(getDefaultSql()!);
  const plan = (db.prepare(`explain query plan select tk.address, h.handle, h.human_amount from tokens tk join ${frag.text} h on h.network_id = tk.network_id and h.token_key = tk.token_key order by tk.address, h.handle`).all() as { id: number; parent: number; detail: string }[]);
  const lines = plan.map((r) => r.detail);
  const own = lines.findIndex((d) => /^(CO-ROUTINE|MATERIALIZE) /.test(d));
  assert(own >= 0, "the helper runs as its own unit: " + lines.join(" | "));
  const walk = lines.slice(own);
  const iT = walk.findIndex((d) => /^SCAN t\b/.test(d)), iC = walk.findIndex((d) => /^(SCAN|SEARCH) c\b/.test(d)), iH = walk.findIndex((d) => /SEARCH h USING INDEX holdings_source_handle_net_idx \(source=\? AND handle=\? AND network_id=\? AND captured_at=\?\)/.test(d));
  assert(iT >= 0 && iT < iC && iC < iH, "traders, then chains, then the full-key seek, inside the unit: " + lines.join(" | "));
  assert(!walk.slice(0, iH).some((d) => /\btk\b/.test(d)), "the caller's table must not appear inside the walk: " + lines.join(" | "));
});
