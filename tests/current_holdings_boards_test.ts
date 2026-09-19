import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { handle } from "../supabase/functions/api/app.ts";
import "../supabase/functions/api/routes.ts";

/*
 * EQUIVALENCE of the one global board statement that took currentHoldings (19 Sep 2026): GET /chains,
 * which carried its own copy of the helper's body as a CTE. The OLD text is that statement verbatim;
 * the NEW text is captured from the live route, so this file cannot drift from the code it vouches for.
 * The /tokens board, its two counts and asOfHoldings() keep their text: they were already driven per
 * (trader, chain), and the plan audit in tests/routes_sql_test.ts holds them to no whole-source pass.
 */

type Row = Record<string, unknown>;

const SOL = 1399811149, ETH = 1, BASE = 8453;
const OLD = "2026-09-18T01:00:00.000Z", NEW = "2026-09-19T01:00:00.000Z"; // fomo builds
const CHAIN1 = "2026-09-19T05:00:00.000Z", CHAIN2 = "2026-09-19T09:00:00.000Z"; // chain captures
const STALE = "2026-09-18T12:00:00.000Z"; // a chain capture older than the newest fomo build

const CHAINS_OLD = `
    with cur as (
      select h.handle, h.network_id, h.token_key, h.value, h.captured_at
        from traders t cross join chains n cross join holdings h
       where h.source = 'chain' and h.handle = t.handle and h.network_id = n.network_id
         and h.captured_at = (select max(h2.captured_at) from holdings h2
                               where h2.source = 'chain' and h2.handle = t.handle
                                 and h2.network_id = n.network_id)
      union all
      select h.handle, h.network_id, h.token_key, h.value, h.captured_at
        from holdings h
       where h.source = 'fomo'
         and h.captured_at = (select captured_at from latest_capture)
         and not exists (select 1 from holdings c
                          where c.source = 'chain' and c.handle = h.handle
                            and c.network_id = h.network_id)
    )
    select c.network_id, c.name, c.history_provider,
           count(*)                                       as positions,
           count(distinct cur.handle)                     as traders,
           count(distinct case when q.token_key is null
                               then cur.token_key end)    as tokens,
           count(case when cur.value > 0 then cur.value end) as priced,
           sum(case when cur.value > 0 then cur.value end)   as total_value,
           max(cur.captured_at)                           as newest
    from cur
    cross join chains c on c.network_id = cur.network_id
    left join quote_assets q on q.network_id = cur.network_id and q.token_key = cur.token_key
    group by c.network_id, c.name, c.history_provider
    order by positions desc`;

Deno.test("GET /chains through currentHoldings: the rows and order of its own CTE, and no pass over every chain row", async () => {
  const issued: string[] = [];
  const db = await openSchema((text) => void issued.push(text));
  const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
  const rows = (text: string): Row[] => (db.prepare(text).all() as Row[]).map((r) => ({ ...r }));
  for (const h of ["a", "b", "c", "d", "gone"]) run("insert into traders (handle, display_handle, id, listed) values (?,?,?,?)", h, h, `id-${h}`, h === "gone" ? 0 : 1);
  for (const k of ["x", "y", "z", "usdc"]) for (const net of [ETH, SOL, BASE]) run("insert into tokens (network_id, address, token_key) values (?,?,?)", net, k, k);
  run("insert into quote_assets (network_id, token_key, symbol, pegged_usd) values (?,'usdc','USDC',1)", ETH);
  const hold = (h: string, net: number, k: string, at: string, amount: number | null, value: number | null, source: string): void =>
    run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, value, source) values (?,?,?,?,?,?,?)", h, net, k, at, amount, value, source);
  // a: two chain captures on ethereum (only the newer is current), a coin dropped between them, a quote asset
  hold("a", ETH, "x", CHAIN1, 5, 50, "chain"); hold("a", ETH, "y", CHAIN1, 7, 70, "chain");
  hold("a", ETH, "x", CHAIN2, 6, 60, "chain"); hold("a", ETH, "usdc", CHAIN2, 3, 3, "chain");
  // a on solana: never read on chain, so the newest fomo build stands; the older build does not
  hold("a", SOL, "z", OLD, 1, 10, "fomo"); hold("a", SOL, "z", NEW, 2, 20, "fomo");
  // b: a fomo row on ethereum HIDDEN by a chain capture of the same (trader, chain), even one holding another coin
  hold("b", ETH, "x", NEW, 9, 90, "fomo"); hold("b", ETH, "y", CHAIN1, 3, null, "chain");
  // c: a zero and a null amount are positions too; a value of 0 and a null value are not priced
  hold("c", ETH, "x", CHAIN2, 0, 0, "chain"); hold("c", ETH, "y", CHAIN2, null, null, "chain");
  // d: nothing at all. gone: delisted, still a trader, still counted
  hold("gone", SOL, "x", CHAIN1, 4, 40, "chain");
  // gone on ethereum: a fomo build NEWER than the pair's newest chain capture (production's normal state: daily builds, a ~9 h sweep). The chain row stands, the fomo row stays hidden.
  hold("gone", ETH, "y", STALE, 1, 10, "chain"); hold("gone", ETH, "x", NEW, 1, 10, "fomo");

  const res = await handle(new Request("https://test.local/v2/chains", { headers: { "user-agent": "current-holdings-boards-test/1.0" } }));
  assertEquals(res.status, 200, await res.text());
  const hits = issued.filter((t) => t.includes("as total_value"));
  assertEquals(hits.length, 1, "one statement reads the holdings");
  const now = hits[0];
  assert(!now.includes("with cur as"), "the route no longer carries its own copy of the view body");

  assertEquals(rows(now), rows(CHAINS_OLD));
  assertEquals(rows(CHAINS_OLD).map((r) => [r.name, r.positions, r.traders, r.tokens, r.priced, r.total_value, r.newest]), [
    ["ethereum", 6, 4, 2, 3, 73, CHAIN2], ["solana", 2, 2, 2, 2, 60, CHAIN1],
  ]);
  // The seed must tell the rule from its nearest wrong neighbour: the newest capture taken over BOTH sources, which drops gone's pair.
  const bothSources = now.replace("h2.source = 'chain' and ", "");
  assert(bothSources !== now, "the helper's correlated max no longer reads as this test expects");
  assertNotEquals(rows(bothSources), rows(CHAINS_OLD));
  // A third chain that TIES solana on positions, a newer capture that empties a chain, a chain read that retires a fomo row.
  hold("d", BASE, "x", NEW, 1, null, "fomo"); hold("b", BASE, "y", CHAIN2, 1, 5, "chain");
  assertEquals(rows(now), rows(CHAINS_OLD));
  assertEquals(rows(CHAINS_OLD).map((r) => [r.name, r.positions]), [["ethereum", 6], ["base", 2], ["solana", 2]]);
  hold("gone", SOL, "y", CHAIN2, 0, null, "chain"); hold("a", SOL, "y", CHAIN2, 1, 1, "chain");
  assertEquals(rows(now), rows(CHAINS_OLD));
  assertEquals(rows(CHAINS_OLD).map((r) => [r.name, r.positions, r.total_value]), [["ethereum", 6, 73], ["base", 2, 5], ["solana", 2, 1]]);

  const plan = (db.prepare("explain query plan " + now).all() as { detail: string }[]).map((r) => r.detail);
  assert(plan.some((d) => /SEARCH h USING INDEX holdings_source_handle_net_idx \(source=\? AND handle=\? AND network_id=\? AND captured_at=\?\)/.test(d)), plan.join(" | "));
  assert(!plan.some((d) => /holdings_source_handle_net_idx \(source=\?\)$/.test(d) || /^SCAN (h|holdings)\b/.test(d)), "no pass over every chain row: " + plan.join(" | "));
  // The helper stays the OUTER loop, streamed: without the caller's cross join the planner materialises it behind an automatic index.
  assert(plan.includes("SCAN cur") && !plan.some((d) => /AUTOMATIC|BLOOM FILTER/.test(d)), plan.join(" | "));

  run("delete from holdings");
  assertEquals(rows(now), rows(CHAINS_OLD));
  assertEquals(rows(now), []);
});
