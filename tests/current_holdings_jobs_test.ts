import { assert, assertEquals } from "jsr:@std/assert@1";
import type { DatabaseSync } from "node:sqlite";
import { openSchema } from "./_sqlite_harness.ts";
import { getDefaultSql } from "../supabase/functions/api/db.ts";
import type { Sql } from "../worker/src/d1.ts";
import { SOL_MINT, ZERO_ADDRESS } from "../supabase/functions/_shared/chain_reads.ts";
import { infoTargets, supplyTargets } from "../worker/src/jobs/tokens-core.ts";
import { priceTargets } from "../worker/src/jobs/prices-core.ts";
import { robinhoodTargets } from "../worker/src/jobs/quote_prices-core.ts";
import { launchTargets } from "../worker/src/jobs/launches-core.ts";

/**
 * Five job statements read every current holding through `currentHoldings` instead of the
 * `holdings_current` view (19 Sep 2026). Each test runs the statement AS SHIPPED BEFORE, verbatim
 * but for `?` where the template bound a value, beside the new code path over one seed, and asserts
 * the same rows in the same order; then that the pass over every chain row ever captured is gone.
 */

const ETH = 1, SOL = 1399811149, RH = 4663;
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"; // a seeded quote asset
const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

type Param = string | number | null;
type Row = Record<string, unknown>;

/** What the view costs read whole: every chain row ever captured, to keep the newest capture of each pair. */
const WHOLE_SOURCE = /holdings_source_handle_net_idx \(source=\?\)$/;
const PAIR_SEEK = "SEARCH h USING INDEX holdings_source_handle_net_idx (source=? AND handle=? AND network_id=? AND captured_at=?)";
const TOKEN_SEEK = "SEARCH tk USING INDEX sqlite_autoindex_tokens_1 (network_id=? AND token_key=?)";
const CHAIN_SEEK = "SEARCH ch USING INTEGER PRIMARY KEY (rowid=?)";

interface Seeded { readonly db: DatabaseSync; readonly sql: Sql; readonly prepared: string[] }

async function seeded(): Promise<Seeded> {
  const prepared: string[] = [];
  const db = await openSchema((text) => prepared.push(text));
  const run = (text: string, ...p: Param[]): void => void db.prepare(text).run(...p);
  // d holds nothing; gone is delisted, still a trader, still holds.
  for (const h of ["a", "b", "c", "d", "gone"]) run("insert into traders (handle, display_handle, id, listed) values (?,?,?,?)", h, h, `id-${h}`, h === "gone" ? 0 : 1);
  const token = (net: number, key: string, supply: number | null, readAt: string | null, graduated: number | null): void =>
    run("insert into tokens (network_id, address, token_key, total_supply, launch_read_at, graduated) values (?,?,?,?,?,?)", net, key, key, supply, readAt, graduated);
  for (const k of ["x", "y", "w", "t1", "t0", WETH]) token(ETH, k, null, null, null); // the migrations seed each EVM native
  token(ETH, "z", 1e9, null, null);                 // supply already known: never a supply target
  token(SOL, "x", null, null, null);                // never read for a launch
  token(SOL, "y", null, null, null);                // held on ethereum only: the chain filter must refuse it
  token(SOL, "z", null, ago(2), 0);                 // read, still on its curve
  token(SOL, "m", null, ago(3), 1);                 // graduated: done
  token(SOL, "l1", null, null, null);               // only in a superseded fomo build
  token(SOL, "l2", null, null, null);               // not held, moved last week
  token(SOL, "l3", null, null, null);               // not held, moved 45 days ago
  token(SOL, SOL_MINT, null, null, null);
  for (const k of ["x", "r1", "r2", "r3"]) token(RH, k, null, null, null);

  const hold = (h: string, net: number, k: string, at: string, amount: number | null, price: number | null, source: string): void =>
    run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, price, source) values (?,?,?,?,?,?,?)", h, net, k, at, amount, price, source);
  const OLD = ago(2), NEW = ago(1), CHAIN1 = ago(0.5), CHAIN2 = ago(0.2);
  // a on ethereum: TWO chain captures, only the newer is current. w (priced to lead the supply list) and y were dropped between them.
  hold("a", ETH, "x", CHAIN1, 5, 2, "chain"); hold("a", ETH, "y", CHAIN1, 7, 1, "chain"); hold("a", ETH, "w", CHAIN1, 1, 1e6, "chain");
  hold("a", ETH, "x", CHAIN2, 6, 2, "chain"); hold("a", ETH, "z", CHAIN2, 3, 4, "chain");
  // a on solana: never read on chain, so the newest fomo build stands and the older one (with l1) does not.
  hold("a", SOL, "z", OLD, 1, 1, "fomo"); hold("a", SOL, "l1", OLD, 1, 1, "fomo");
  hold("a", SOL, "z", NEW, 2, 1, "fomo"); hold("a", SOL, "m", NEW, 3, 5, "fomo");
  // b on ethereum: a fomo row HIDDEN by a chain capture of the same (trader, chain), even one holding another coin.
  hold("b", ETH, "x", NEW, 9, 100, "fomo"); hold("b", ETH, "y", CHAIN1, 3, 1, "chain");
  // b on robinhood: r3 only in the superseded capture.
  hold("b", RH, "r3", CHAIN1, 1, 1, "chain"); hold("b", RH, "r1", CHAIN2, 4, null, "chain"); hold("b", RH, "r2", CHAIN2, 2, 3, "chain");
  // c: a ZERO and a NULL amount are rows too (statements filter amounts, the source does not); a quote asset and both natives.
  hold("c", ETH, "x", CHAIN2, 0, 2, "chain"); hold("c", ETH, "y", CHAIN2, null, null, "chain");
  hold("c", ETH, WETH, CHAIN2, 1.5, 2000, "chain"); hold("c", ETH, ZERO_ADDRESS, CHAIN2, 2, 2000, "chain");
  hold("c", SOL, SOL_MINT, CHAIN2, 10, 150, "chain"); hold("c", SOL, "m", CHAIN2, 1, 5, "chain");
  hold("c", RH, "r1", NEW, 1, null, "fomo"); hold("c", RH, "x", NEW, 2, null, "fomo");
  hold("gone", SOL, "x", CHAIN1, 4, 1, "chain"); hold("gone", RH, "r1", CHAIN1, 7, null, "chain");

  const info = (net: number, k: string, fetchedAt: string, price: number | null): void =>
    run("insert into token_info (network_id, token_key, source, fetched_at, security_fetched_at, price_usd) values (?,?,'gmgn',?,?,?)", net, k, fetchedAt, fetchedAt, price);
  info(ETH, "x", ago(9), 2); info(ETH, "y", ago(0.1), 1); info(SOL, "x", ago(3), 1);
  info(RH, "r2", ago(0.1), 3); info(RH, "x", ago(2), null); // x: GMGN answered without a price, so Robinhood pricing still wants it
  const miss = (net: number, k: string, at: string): void => run("insert into token_info_misses (network_id, token_key, missed_at) values (?,?,?)", net, k, at);
  miss(SOL, "z", ago(1)); miss(SOL, "m", ago(8));
  const stat = (net: number, k: string, at: string): void =>
    run("insert into token_price_stats (network_id, token_key, ath_usd, ath_at, last_usd, last_at, drawdown_share) values (?,?,1,?,1,?,0)", net, k, at, at);
  stat(ETH, "x", ago(1)); stat(ETH, "z", ago(2)); stat(RH, "r1", ago(0.5));
  const trade = (k: string, entry: number): void =>
    run("insert into trades (trade_id, handle, network_id, token_key, avg_entry_price, captured_at) values (?,?,?,?,?,?)", `tr-${k}`, "d", ETH, k, entry, NEW);
  trade("t1", 0.5); trade("t0", 0); // traded with an entry price: wants a supply though nobody holds it; without one: does not
  const move = (k: string, at: string): void =>
    run("insert into transactions (network_id, tx_hash, address_key, transfer_key, block_time, token_key, source) values (?,?,?,?,?,?,'t')", SOL, `tx-${k}`, "w", "k", at, k);
  move("l2", ago(7)); move("l3", ago(45));
  return { db, sql: getDefaultSql()!, prepared };
}

/** The shipped text and the new code path answer the same rows in the same order; returns them. */
async function same(s: Seeded, shipped: string, params: readonly Param[], issue: (sql: Sql) => PromiseLike<readonly object[]>): Promise<Row[]> {
  const before = s.db.prepare(shipped).all(...params) as Row[];
  const after = await issue(s.sql);
  assertEquals(after.map((r) => ({ ...r })), before.map((r) => ({ ...r })));
  const plan = (text: string): string[] => (s.db.prepare(`explain query plan ${text}`).all(...params) as { detail: string }[]).map((r) => r.detail);
  const mine = plan(s.prepared.at(-1)!);
  assert(plan(shipped).some((d) => WHOLE_SOURCE.test(d)), "the shipped statement does pass over every chain row (if not, this adoption bought nothing)");
  assert(!mine.some((d) => WHOLE_SOURCE.test(d) || /^SCAN (holdings|h2|c2)\b/.test(d)), `no pass over every chain row: ${mine.join(" | ")}`);
  assert(mine.includes(PAIR_SEEK), `the newest capture is sought per (trader, chain): ${mine.join(" | ")}`);
  return before;
}

const planOfLast = (s: Seeded, params: readonly Param[]): string[] =>
  (s.db.prepare(`explain query plan ${s.prepared.at(-1)!}`).all(...params) as { detail: string }[]).map((r) => r.detail);

/**
 * The outer order is h, then tokens, then chains, and it is STATED: SQLite 3.51 moves a plain "join chains" ahead of h and
 * drains h into an automatic index, while this build (3.53) does not, so the plan alone cannot tell the two texts apart.
 */
function assertStatedOrder(s: Seeded, params: readonly Param[]): void {
  assert(/cross join tokens tk[^;]*cross join chains ch/.test(s.prepared.at(-1)!), "both joins are cross joins: the order is stated, not hoped");
  const plan = planOfLast(s, params);
  assert(plan.indexOf(TOKEN_SEEK) >= 0 && plan.indexOf(CHAIN_SEEK) > plan.indexOf(TOKEN_SEEK), `tokens then chains, each sought per holding: ${plan.join(" | ")}`);
  assert(!plan.some((d) => /AUTOMATIC/.test(d)), `no automatic index: ${plan.join(" | ")}`);
}

const SHIPPED_QUEUE = `
  select network_id, token_key, address, chain from (
    select due.*,
           row_number() over (order by holders desc, waited, token_key) as by_held,
           row_number() over (order by waited, holders desc, token_key) as by_wait
      from (
    select h.network_id, h.token_key, tk.address, ch.name as chain,
           count(distinct h.handle) as holders,
           max(coalesce(ti.fetched_at, ''), coalesce(ms.missed_at, '')) as waited
      from holdings_current h
      join tokens tk  on tk.network_id = h.network_id and tk.token_key = h.token_key
      join chains ch  on ch.network_id = h.network_id
      left join quote_assets q
        on q.network_id = h.network_id and q.token_key = h.token_key
      left join token_info ti
        on ti.network_id = h.network_id and ti.token_key = h.token_key
      left join token_info_misses ms
        on ms.network_id = h.network_id and ms.token_key = h.token_key
     where q.token_key is null
       -- Either half being stale is reason to refetch: security has its own timestamp.
       and (ti.fetched_at is null or ti.security_fetched_at is null
            or ti.fetched_at < strftime('%Y-%m-%dT%H:%M:%fZ','now',?)
            or ti.security_fetched_at < strftime('%Y-%m-%dT%H:%M:%fZ','now',?))
       and (ms.missed_at is null or ms.missed_at < strftime('%Y-%m-%dT%H:%M:%fZ','now',?))
     group by h.network_id, h.token_key, tk.address, ch.name, ti.fetched_at, ms.missed_at
      ) due)
   order by min(2 * by_held - 1, 2 * by_wait)`;

Deno.test("tokens infoTargets: the GMGN queue is the shipped queue, place for place", async () => {
  const s = await seeded();
  const rows = await same(s, SHIPPED_QUEUE, ["-20 hours", "-20 hours", "-7 days"], (sql) => infoTargets(sql, "-20 hours", "-7 days"));
  // Odd places by holders (r1 3, x 2, m 2), even places by longest since asked (z never). Not y or r2 (fresh), WETH or a
  // native (quote assets), solana z (GMGN had nothing yesterday), w/r3/l1 (superseded captures).
  assertEquals(rows.map((r) => `${r.chain}:${r.token_key}`), ["robinhood:r1", "ethereum:x", "ethereum:z", "solana:m", "solana:x", "robinhood:x"]);
  assertStatedOrder(s, ["x", "x", "x"]);
});

const SHIPPED_SUPPLY = `
    select tk.network_id, tk.address, tk.token_key
    from tokens tk
    left join (select network_id, token_key, max(human_amount * price) as held
                 from holdings_current group by network_id, token_key) hv
      on hv.network_id = tk.network_id and hv.token_key = tk.token_key
    where tk.total_supply is null
      and (hv.token_key is not null
           or exists (select 1 from trades t
                      where t.network_id = tk.network_id and t.token_key = tk.token_key
                        and t.avg_entry_price > 0))
    order by hv.held desc, tk.network_id, tk.address
    limit ?`;

Deno.test("tokens supplyTargets: the most valuable held position first, and the slice cuts the same rows", async () => {
  const s = await seeded();
  const rows = await same(s, SHIPPED_SUPPLY, [400], (sql) => supplyTargets(sql, 400));
  // w's 1,000,000 sits in a superseded capture and b's 900 of x is hidden by b's chain read: neither leads.
  // A null value (unpriced, or a null amount) sorts after every figure; t1 is traded, not held.
  assertEquals(rows.map((r) => `${r.network_id}:${r.token_key}`), [
    `${ETH}:${ZERO_ADDRESS}`, `${ETH}:${WETH}`, `${SOL}:${SOL_MINT}`, `${SOL}:m`, `${ETH}:x`, `${RH}:r2`, `${SOL}:x`, `${ETH}:y`, `${SOL}:z`,
    `${ETH}:t1`, `${RH}:r1`, `${RH}:x`,
  ]);
  await same(s, SHIPPED_SUPPLY, [5], (sql) => supplyTargets(sql, 5));
});

const SHIPPED_PRICES = `
    select h.network_id, ch.name as chain, h.token_key, tk.address
      from holdings_current h
      join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
      join chains ch on ch.network_id = h.network_id
      left join token_price_stats ps on ps.network_id = h.network_id and ps.token_key = h.token_key
     where h.human_amount > 0 and h.token_key not in (?, ?)
     group by h.network_id, ch.name, h.token_key, tk.address, ps.last_at
     order by count(distinct h.handle) desc, ps.last_at asc, h.network_id, h.token_key`;

Deno.test("prices priceTargets: most-held first, then stalest, exactly as shipped", async () => {
  const s = await seeded();
  const rows = await same(s, SHIPPED_PRICES, [ZERO_ADDRESS, SOL_MINT], (sql) => priceTargets(sql));
  // r1 has three holders, m two. Among one-holder coins the never-sampled lead, then the oldest sample.
  // c's zero and null amounts hold nothing, and neither native is priced here.
  assertEquals(rows.map((r) => `${r.chain}:${r.token_key}`), [
    "robinhood:r1", "solana:m", `ethereum:${WETH}`, "ethereum:y", "robinhood:r2", "robinhood:x", "solana:x", "solana:z", "ethereum:z", "ethereum:x",
  ]);
  assertStatedOrder(s, ["x", "x"]);
});

const SHIPPED_ROBINHOOD = `
  select distinct h.token_key, tk.address
    from holdings_current h
    join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    left join token_info ti on ti.network_id = h.network_id and ti.token_key = h.token_key
   where h.network_id = ? and q.token_key is null and ti.price_usd is null
   order by h.token_key`;

Deno.test("quote_prices robinhoodTargets: one chain's held, unpriced coins, and only that chain's pairs are asked", async () => {
  const s = await seeded();
  const rows = await same(s, SHIPPED_ROBINHOOD, [RH], (sql) => robinhoodTargets(sql, RH));
  assertEquals(rows.map((r) => r.token_key), ["r1", "x"]); // not r2 (GMGN prices it), not r3 (superseded capture)
  const plan = planOfLast(s, [RH]);
  assert(plan.includes(TOKEN_SEEK), "tokens is sought per holding");
  // The helper is not flattened (limit -1), so the chain filter stays outside it: all 2,240 pairs are walked, by seek. 26 ms at production size.
  assert(plan.includes("SEARCH h USING INDEX holdings_source_handle_net_idx (source=? AND handle=? AND network_id=? AND captured_at=?)"), `holdings are reached per pair, by the full key: ${plan.join(" | ")}`);
  await same(s, SHIPPED_ROBINHOOD, [56], (sql) => robinhoodTargets(sql, 56)); // a chain nobody holds on: no rows, both ways
});

const SHIPPED_LAUNCHES = `
  select tk.address, tk.token_key, tk.created_at
    from tokens tk
   where tk.network_id = ?
     and (tk.launch_read_at is null or tk.graduated = 0)
     and (tk.token_key in (select token_key from holdings_current where network_id = ?)
          or tk.token_key in (select token_key from transactions
                               where network_id = ?
                                 and block_time > strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')))
   order by tk.launch_read_at, tk.address`;

Deno.test("launches launchTargets: held or recently moved on one chain, stalest first, exactly as shipped", async () => {
  const s = await seeded();
  const rows = await same(s, SHIPPED_LAUNCHES, [SOL, SOL, SOL], (sql) => launchTargets(sql, SOL));
  // Never read first (by address), then z on its curve. Not m (graduated), y (held on ethereum only), l1 (superseded build), l3 (moved 45 days ago).
  assertEquals(rows.map((r) => r.token_key), [SOL_MINT, "l2", "x", "z"]);
  const plan = planOfLast(s, [SOL, SOL, SOL]);
  // The helper is not flattened (limit -1), so the chain filter stays outside it: all 2,240 pairs are walked, by seek. 26 ms at production size.
  assert(plan.includes("SEARCH h USING INDEX holdings_source_handle_net_idx (source=? AND handle=? AND network_id=? AND captured_at=?)"), `holdings are reached per pair, by the full key: ${plan.join(" | ")}`);
});
