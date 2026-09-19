import { assert, assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { getDefaultSql } from "../supabase/functions/api/db.ts";
import { currentHoldings } from "../supabase/functions/_shared/current_holdings.ts";
import { refreshHealthSnapshot } from "../supabase/functions/api/routes/health.ts";

/*
 * The snapshot job reads every current holding three times: the row count, the held coins' GMGN
 * staleness, and the per-chain history states. Each statement, AS THE JOB ISSUES IT, is held row
 * for row to itself over the holdings_current VIEW, and its plan must not make the view's pass over
 * every chain row ever captured. tests/health_statements_test.ts holds the published figures to the
 * view-era statements verbatim; this file holds the statements themselves, and their plans.
 */
const SOL = 1399811149;
const MARKS = ["as generations", "as never_fetched", "as hist_ready"] as const;

Deno.test("health: the three reads of every current holding answer as the view does, without its whole-source pass", async () => {
  const issued: string[] = [];
  const db = await openSchema((text) => issued.push(text));
  const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
  const ago = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();
  for (const [h, listed] of [["a", 1], ["b", 1], ["none", 1], ["gone", 0]] as const) {
    run("insert into traders (handle, display_handle, id, listed) values (?,?,?,?)", h, h, `id-${h}`, listed);
  }
  for (const k of ["x", "y", "z"]) for (const net of [1, 56, SOL]) run("insert into tokens (network_id, address, token_key) values (?,?,?)", net, k, k);
  const hold = (h: string, net: number, k: string, at: string, amount: number | null, source: string): void =>
    run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, source) values (?,?,?,?,?,?)", h, net, k, at, amount, source);
  const [G1, G2, G3] = [ago(30), ago(20), ago(10)];
  // a: two captures on ethereum, the newer one SMALLER and carrying a zero and a null; a second chain
  for (const k of ["x", "y", "z"]) hold("a", 1, k, G1, 5, "chain");
  hold("a", 1, "x", G3, 0, "chain"); hold("a", 1, "y", G3, null, "chain");
  hold("a", SOL, "z", G2, 7, "chain");
  // b: a fomo row on bsc HIDDEN by a chain capture of the same (trader, chain); on ethereum only the newest fomo build stands
  hold("b", 56, "x", G2, 3, "fomo"); hold("b", 56, "y", G1, 9, "chain");
  hold("b", 1, "x", G1, 3, "fomo"); hold("b", 1, "z", G2, 3, "fomo");
  // none: a trader with nothing. gone: delisted, and still holds
  hold("gone", SOL, "x", G3, 4, "chain");
  // two pairs with NO other evidence of history, so a leaked row would add a chain to the counts:
  // a sold out of bsc (the older capture is not a position), and gone's fomo row on ethereum is hidden by a chain read of dust
  hold("a", 56, "x", G1, 5, "chain"); hold("a", 56, "x", G3, 0, "chain");
  hold("gone", 1, "x", G1, 0, "chain"); hold("gone", 1, "y", G2, 2, "fomo");
  run("insert into token_info (network_id, token_key, fetched_at) values (1,'z',?), (56,'y',?)", ago(1), ago(100));
  // history evidence beside the holdings: a is ready on ethereum by samples alone, b is warming on bsc, a trade on a chain nobody holds
  for (const [h, net, hoursAgo] of [["a", 1, 40], ["a", 1, 12], ["b", 56, 50]] as const) {
    const at = ago(hoursAgo); // a chain sample and its parent carry the same instant
    run("insert into aum_samples (handle, at, total_usd, basis, tier) values (?,?,10,'sampled','verified')", h, at);
    run("insert into aum_chain_samples (handle, at, basis, network_id, total_usd) values (?,?,'sampled',?,10)", h, at, net);
  }
  run("insert into trades (trade_id, handle, network_id, token_key, status, captured_at) values ('1','none',56,'x','open',?)", ago(5));

  await refreshHealthSnapshot();
  const source = currentHoldings(getDefaultSql()!).text;
  const all = (text: string): Record<string, unknown>[] => db.prepare(text).all() as Record<string, unknown>[];
  const plan = (text: string): string[] => (db.prepare(`explain query plan ${text}`).all() as { detail: string }[]).map((r) => r.detail);
  const wholePass = (d: string): boolean => /holdings_source_handle_net_idx \(source=\?\)$/.test(d) || /^SCAN holdings\b/.test(d);

  for (const mark of MARKS) {
    const [now, ...more] = issued.filter((t) => t.includes(mark) && t.includes(source));
    assert(now !== undefined && more.length === 0, `exactly one statement carries "${mark}" and the shared source`);
    const overView = now.replace(source, "holdings_current");
    assert(!overView.includes("cross join holdings"), "the reference reads the view and nothing else");
    assertEquals(all(now), all(overView), mark); // the chains statement orders by name, so order is held too
    assert(plan(now).some((d) => /holdings_source_handle_net_idx \(source=\? AND handle=\? AND network_id=\? AND captured_at=\?\)/.test(d)), plan(now).join(" | "));
    assert(!plan(now).some(wholePass), `no pass over every chain row: ${plan(now).join(" | ")}`);
    assert(plan(overView).some(wholePass), `the view, read whole, does make that pass: ${plan(overView).join(" | ")}`);
  }

  /* The edges are really there: the view's row count, the distinct held coins, and every history state. */
  const [counts] = all(issued.find((t) => t.includes(MARKS[0]))!);
  const [info] = all(issued.find((t) => t.includes(MARKS[1]))!);
  assertEquals([counts.holdings, info.held, info.never_fetched, info.stale], [8, 4, 2, 1]);
  const hist = Object.fromEntries(all(issued.find((t) => t.includes(MARKS[2]))!).map((r) => [String(r.name), [r.hist_ready, r.hist_warming, r.hist_none]]));
  assertEquals([hist.ethereum, hist.bsc, hist.solana], [[1, 0, 1], [0, 1, 1], [0, 0, 2]]);
});
