import { assert, assertEquals } from "jsr:@std/assert@1";
import { DatabaseSync } from "node:sqlite";
import { openSchema } from "./_sqlite_harness.ts";
import { handle } from "../supabase/functions/api/app.ts";
import "../supabase/functions/api/routes.ts";

/*
 * EQUIVALENCE of the statements the tokens family rewrote on 19 Sep 2026 so that they seek instead
 * of reading a table whole (tests/routes_sql_test.ts holds the plan audit that says they now do).
 * Each test runs the OLD statement (as the route issued it before, SQL comments removed) and the
 * NEW one over the same seed and asserts the rows are equal. The NEW text is never copied here: it
 * is captured from the live route, so this file cannot drift from the code it vouches for.
 */

type Param = string | number | null;
type Row = Record<string, unknown>;

const SOL = 1399811149;
const ADDRESS = "0x00000000000000000000000000000000000000AA"; // mixed case: the routes lower it
const TOKEN = ADDRESS.toLowerCase();
const OTHER = "0x00000000000000000000000000000000000000bb";
const USDC = "0x00000000000000000000000000000000000000cc";
const TIED = "0x00000000000000000000000000000000000000dd";
const CROSS = "0x00000000000000000000000000000000000000ee";
const MINT = "mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const F_OLD = "2026-09-10T00:00:00.000Z", F_NEW = "2026-09-12T00:00:00.000Z"; // fomo builds
const C_OLD = "2026-09-11T00:00:00.000Z", C_NEW = "2026-09-13T00:00:00.000Z"; // chain captures

const ISSUED: string[] = [];
const db = await openSchema((text) => void ISSUED.push(text));
const run = (text: string, ...p: Param[]): void => void db.prepare(text).run(...p);
const rows = (text: string, ...p: Param[]): Row[] => (db.prepare(text).all(...p) as Row[]).map((r) => ({ ...r }));
const sorted = (list: Row[]): string[] => list.map((r) => JSON.stringify(r)).sort();

function seed(): void {
  // a..g hold the token one way or another; e holds and trades nothing of it.
  for (const h of ["a", "b", "c", "d", "e", "f", "g", "p", "q", "r", "w", "x", "y"]) {
    run("insert into traders (handle, display_handle, id) values (?,?,?)", h, h.toUpperCase(), `id-${h}`);
  }
  // o shares p's DISPLAY handle (the gmgn loader names a trader by his twitter), so the two can tie.
  run("insert into traders (handle, display_handle, id) values ('o','P','id-o')");
  run("insert into wallets (handle, evm_address) values ('a','0xA1'), ('b','0xB1')");
  // b's wallet is a's linked address, so b is not independent in the cohort count.
  run("insert into linked_wallets (handle, network_id, address_key, linked_from_address_key, link_kind) values ('a',1,'0xb1','0xa1','funded_by')");
  const token = (net: number, address: string): void =>
    run("insert into tokens (network_id, address, token_key, launchpad, graduated) values (?,?,?,null,null)", net, address, address.toLowerCase());
  token(1, ADDRESS); token(56, ADDRESS); token(1, OTHER); token(1, USDC); token(1, TIED); token(SOL, MINT);
  token(1, CROSS); token(56, CROSS);
  run("insert into quote_assets (network_id, token_key, symbol, pegged_usd) values (1,?,'USDC',1)", USDC);
  run("insert into token_info (network_id, token_key, price_usd, liquidity_usd, market_cap_usd) values (1,?,2,1000,5000)", TOKEN);
  run("insert into token_price_stats (network_id, token_key, ath_usd, ath_at, last_usd, last_at, drawdown_share) values (1,?,6,?,4,?,0.33)", TOKEN, C_OLD, C_NEW);

  // The newest stats row decides the rank: a's older row would sort him first, c and d have none.
  const stat = (h: string, at: string, rank: number): void =>
    run("insert into trader_stats (handle, captured_at, rank) values (?,?,?)", h, at, rank);
  stat("a", C_OLD, 0); stat("a", C_NEW, 2); stat("g", C_NEW, 1); stat("b", C_NEW, 3);

  const hold = (h: string, net: number, key: string, at: string, value: number | null, source: string): void =>
    run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, value, source) values (?,?,?,?,1,?,?)", h, net, key, at, value, source);
  hold("a", 1, TOKEN, C_OLD, 10, "chain");   // an older capture: not current
  hold("a", 1, TOKEN, C_NEW, 20, "chain");
  hold("a", 1, USDC, C_NEW, 100, "chain");   // a quote asset
  hold("a", 1, TOKEN, F_NEW, 99, "fomo");    // chain wins on (a, ethereum)
  hold("a", SOL, MINT, F_NEW, 30, "fomo");   // never read on chain there: the fomo build stands
  hold("b", 1, TOKEN, C_NEW, null, "chain"); // unpriced: null stays null
  hold("b", 56, TOKEN, C_OLD, 5, "chain");   // second chain, whose newest capture is the OLDER time
  hold("c", 1, TOKEN, C_NEW, 20, "chain");   // ties a and g on value
  hold("g", 1, TOKEN, C_NEW, 20, "chain");
  hold("d", 1, TOKEN, F_OLD, 7, "fomo");     // an older build: not current
  hold("d", 1, TOKEN, F_NEW, 8, "fomo");
  hold("f", 1, TOKEN, C_OLD, 1, "chain");    // f's newer capture no longer holds it
  hold("f", 1, OTHER, C_NEW, 1, "chain");
  // A FULL tie (unpriced, no stats row): the view emitted chain reads by handle, then the fomo build as
  // stored, so y, x, w and neither handle order nor any other. x is stored before w on purpose.
  hold("y", 1, TIED, C_NEW, null, "chain");
  hold("x", 1, TIED, F_NEW, null, "fomo");
  hold("w", 1, TIED, F_NEW, null, "fomo");
  // ONE trader tied ACROSS two chains, which decides which chain's entry the coin page lists first.
  // bsc is stored before ethereum every time, so neither storage order nor network order alone is right.
  hold("p", 56, CROSS, C_NEW, 20, "chain");   hold("p", 1, CROSS, C_NEW, 20, "chain");  // both read on chain
  hold("q", 1, CROSS, F_NEW, null, "fomo");   hold("q", 56, CROSS, C_NEW, null, "chain"); // one of each
  hold("r", 56, CROSS, F_NEW, 7, "fomo");     hold("r", 1, CROSS, F_NEW, 7, "fomo");    // both from the build
  // o ties p under the same display handle and is stored after him; his amount of 2 tells the two rows apart.
  run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, value, source) values ('o',56,?,?,2,20,'chain')", CROSS, C_NEW);

  const trade = (id: string, h: string, net: number | null, key: string, status: string, entry: number | null,
    exit: number | null, realized: number | null, unrealized: number | null, opened: string | null, closed: string | null): void =>
    run(`insert into trades (trade_id, handle, network_id, token_address, token_key, status, amount, avg_entry_price,
           avg_exit_price, realized_pnl_usd, unrealized_pnl_usd, opened_at, closed_at, captured_at)
         values (?,?,?,?,?,?,5,?,?,?,?,?,?,?)`, id, h, net, key, key, status, entry, exit, realized, unrealized, opened, closed, C_NEW);
  trade("t1", "a", 1, TOKEN, "closed", 1, 2, 10, null, "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z");
  trade("t2", "a", 1, TOKEN, "open", 1.5, null, null, 3, "2026-09-03T00:00:00.000Z", null);
  trade("t3", "a", 1, TOKEN, "closed_by_balance", null, null, null, 2, null, null);
  trade("t4", "b", 56, TOKEN, "closed", 2, 1, -4, null, "2026-09-01T00:00:00.000Z", "2026-09-04T00:00:00.000Z");
  trade("t5", "c", null, TOKEN, "closed", null, 3, 1, null, null, "2026-09-05T00:00:00.000Z"); // no network at all
  trade("t6", "g", 42161, TOKEN, "closed", 1, 1, 0, null, "2026-09-01T00:00:00.000Z", "2026-09-06T00:00:00.000Z"); // a network chains does not list
  trade("t7", "a", 1, OTHER, "closed", 1, 4, 6, null, "2026-09-01T00:00:00.000Z", "2026-09-07T00:00:00.000Z");
  trade("t8", "e", 1, OTHER, "closed", 1, 2, 1, null, "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"); // never traded the token
  trade("t9", "a", 1, OTHER, "open", 1, 9, null, 3, "2026-08-01T00:00:00.000Z", null); // an OPEN leg with a partial-exit price: no exit

  const price = (net: number, key: string, hour: string, usd: number, liquidity: number | null): void =>
    run("insert into token_price_hourly (network_id, token_key, hour, usd, liquidity_usd, source) values (?,?,?,?,?,'t')", net, key, hour, usd, liquidity);
  // Two weeks, two months, several hours in one day; MINT has no price at all.
  price(1, TOKEN, "2026-08-30T22:00:00.000Z", 1, null);
  price(1, TOKEN, "2026-08-31T01:00:00.000Z", 3, 10);
  price(1, TOKEN, "2026-08-31T05:00:00.000Z", 2, 11);
  price(1, TOKEN, "2026-09-01T00:00:00.000Z", 5, 12);
  price(1, TOKEN, "2026-09-01T23:00:00.000Z", 4, null);
  price(1, TOKEN, "2026-09-02T12:00:00.000Z", 6, 13);
  price(56, TOKEN, "2026-09-01T10:00:00.000Z", 9, 1);
  price(56, TOKEN, "2026-09-01T11:00:00.000Z", 8, 2);
  price(1, OTHER, "2026-09-01T10:00:00.000Z", 100, 3); // not asked for: must not leak in
}
seed();

/** Calls the route and returns the ONE statement it issued that contains `marker`. */
async function issued(path: string, marker: string, status = 200, body?: unknown): Promise<string> {
  const before = ISSUED.length;
  const res = await handle(new Request(`https://test.local/v2${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "user-agent": "plans-tokens-test/1.0" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  assertEquals(res.status, status, `${path} -> ${text.slice(0, 200)}`);
  const hits = ISSUED.slice(before).filter((t) => t.includes(marker));
  assertEquals(hits.length, 1, `'${marker}' matched ${hits.length} statements of ${path}`);
  return hits[0];
}

// ------------------------------------------------------------------ GET /tokens/:address

const OLD_DETAIL = (chain: string): string => `
    select h.network_id, c.name as chain, tk.address, t.display_handle, h.human_amount, h.value,
           tk.created_at as launch_created_at, tk.launchpad, tk.curve_progress, tk.graduated, tk.launch_read_at,
           ti.price_usd, ti.liquidity_usd, ti.market_cap_usd, ti.total_supply,
           ti.circulating_supply, ti.holder_count, ti.top_10_holder_rate,
           ti.symbol as gmgn_symbol, ti.source as info_source, ti.fetched_at as info_fetched_at, ti.logo_url,
           json_extract(ti.raw, '$.stat.dev_team_hold_rate')     as dev_team_hold_rate,
           json_extract(ti.raw, '$.stat.creator_hold_rate')      as creator_hold_rate,
           json_extract(ti.raw, '$.stat.fresh_wallet_rate')      as fresh_wallet_rate,
           json_extract(ti.raw, '$.stat.top70_sniper_hold_rate') as sniper_hold_rate,
           json_extract(ti.raw, '$.stat.bot_degen_rate')         as bot_degen_rate,
           json_extract(ti.raw, '$.wallet_tags_stat')            as wallet_tags,
           json_extract(ti.raw, '$.dev.creator_address')         as creator_address,
           json_extract(ti.raw, '$.dev.creator_token_status')    as creator_status,
           json_extract(ti.raw, '$.dev.cto_flag')                as cto_flag,
           json_extract(ti.raw, '$.dev.creator_open_count')      as creator_open_count,
           json_extract(ti.raw, '$.dev.ath_token_info')          as creator_ath,
           cr.launches, cr.best_peak_mcap_usd, cr.best_token_key, cr.still_holding_count,
           cr.sold_count, cr.honeypot_count, cr.last_launch_at,
           ti.is_honeypot, ti.buy_tax, ti.sell_tax, ti.is_open_source, ti.is_renounced,
           ti.renounced_mint, ti.renounced_freeze, ti.rug_ratio, ti.burn_ratio,
           ti.is_blacklisted, ti.can_not_sell, ti.security_fetched_at, ti.honeypot_since,
           ps.last_usd as ps_usd, ps.last_at as ps_at, ps.ath_usd, ps.ath_at, ps.drawdown_share, ps.source as ps_source
    from holdings_current h
    join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    join chains c on c.network_id = h.network_id
    join traders t on t.handle = h.handle
    left join trader_stats_current st on st.handle = h.handle
    left join token_info ti
      on ti.network_id = h.network_id and ti.token_key = h.token_key
    left join token_price_stats ps
      on ps.network_id = h.network_id and ps.token_key = h.token_key
    left join token_creators tc
      on tc.network_id = h.network_id and tc.token_key = h.token_key
    left join creators cr
      on cr.network_id = tc.network_id and cr.creator_address_key = tc.creator_address_key
    where h.token_key = ? ${chain}
    order by (case when h.value > 0 then h.value else null end) desc nulls last,
             t.display_handle`;

const OLD_COHORT = (chain: string): string => `
    select tr.network_id, count(distinct tr.handle) as holders,
           count(distinct case when not exists (
             select 1 from wallets w join linked_wallets lw
               on lw.address_key in (w.evm_address_key, w.sol_address_key)
             where w.handle = tr.handle and lw.handle <> tr.handle) then tr.handle end) as independent
    from trades tr
    where tr.token_key = ? ${chain}
    group by 1`;

Deno.test("GET /tokens/:address: the holder rows and the cohort, sought through the token, equal the view's", async () => {
  const main = await issued(`/tokens/${ADDRESS}`, "tk.curve_progress");
  const expected = rows(OLD_DETAIL(""), TOKEN);
  assertEquals(rows(main, TOKEN), expected);
  // a's newer capture, b twice (two chains, one unpriced), c, g, and d from the fomo build; never f, never an older capture.
  assertEquals(expected.map((r) => `${r.chain}:${r.display_handle}:${r.value}`),
    ["ethereum:A:20", "ethereum:C:20", "ethereum:G:20", "ethereum:D:8", "bsc:B:5", "ethereum:B:null"]);

  // Ties across two chains, and between two traders under one display handle: the ROW order is the order
  // of the answer's entries. Chain reads by handle then network (o, then p), then the fomo build as stored.
  const crossed = rows(OLD_DETAIL(""), CROSS);
  assertEquals(rows(main, CROSS), crossed);
  assertEquals(crossed.map((r) => `${r.chain}:${r.display_handle}:${r.human_amount}`),
    ["bsc:P:2", "ethereum:P:1", "bsc:P:1", "bsc:R:1", "ethereum:R:1", "bsc:Q:1", "ethereum:Q:1"]);

  const cohort = await issued(`/tokens/${ADDRESS}`, "as independent");
  const oldCohort = rows(OLD_COHORT(""), TOKEN);
  assertEquals(sorted(rows(cohort, TOKEN)), sorted(oldCohort));
  // Trades with no network, and on a network chains does not list, are still counted.
  assertEquals(sorted(oldCohort.map((r) => ({ n: r.network_id }))), sorted([{ n: null }, { n: 1 }, { n: 56 }, { n: 42161 }]));

  const mainOn = await issued(`/tokens/${ADDRESS}?chain=bsc`, "tk.curve_progress");
  assertEquals(rows(mainOn, TOKEN, 56), rows(OLD_DETAIL("and h.network_id = ?"), TOKEN, 56));
  const cohortOn = await issued(`/tokens/${ADDRESS}?chain=bsc`, "as independent");
  assertEquals(rows(cohortOn, TOKEN, 56), rows(OLD_COHORT("and tr.network_id = ?"), TOKEN, 56));

  // A token nobody holds now (f dropped OTHER's sibling; nobody holds this key): no rows either way.
  assertEquals(rows(main, "0xnobody"), rows(OLD_DETAIL(""), "0xnobody"));
  await issued(`/tokens/0xnobody`, "tk.curve_progress", 404);
});

// ------------------------------------------------------------------ GET /tokens/:address/activity

const QTY = `case
               when tr.status = 'open' and tr.amount > 0 then tr.amount
               when tr.status = 'closed'
                    and tr.realized_pnl_usd is not null
                    and tr.avg_entry_price is not null
                    and tr.avg_exit_price is not null
                    and tr.avg_exit_price <> tr.avg_entry_price
                    and tr.realized_pnl_usd / (tr.avg_exit_price - tr.avg_entry_price) > 0
                 then tr.realized_pnl_usd / (tr.avg_exit_price - tr.avg_entry_price)
               else null
             end as qty`;

const OLD_HOLDERS = (chain: string): string => `
    select t.display_handle, h.network_id, h.value
    from holdings_current h join traders t on t.handle = h.handle
    where h.token_key = ? ${chain}`;

const OLD_PER = `
    with legs as (
      select t.display_handle as handle, tr.status, tr.trade_id,
             tr.realized_pnl_usd, tr.unrealized_pnl_usd,
             tr.avg_entry_price, tr.avg_exit_price, tr.opened_at, tr.closed_at,
             ${QTY},
             row_number() over (
               partition by t.display_handle
               order by (case when tr.avg_entry_price > 0 then 0 else 1 end),
                        tr.opened_at nulls last, tr.trade_id) as entry_rn,
             row_number() over (
               partition by t.display_handle
               order by (case when tr.avg_exit_price > 0 then 0 else 1 end),
                        tr.opened_at nulls last, tr.trade_id) as exit_rn
      from trades tr join traders t on t.handle = tr.handle
      where tr.token_key = ?
    )
    select handle,
           count(*)                                                as trades,
           count(case when status = 'closed' then 1 end)            as closed,
           coalesce(sum(case when status = 'closed'
                             then realized_pnl_usd end), 0)         as realized,
           coalesce(sum(case when status not in ('closed', 'closed_by_balance')
                             then unrealized_pnl_usd end), 0)       as unrealized,
           coalesce(
             sum(case when avg_entry_price > 0 and qty is not null
                      then avg_entry_price * qty end)
               / nullif(sum(case when avg_entry_price > 0 and qty is not null
                                 then qty end), 0),
             max(case when entry_rn = 1 and avg_entry_price > 0 then avg_entry_price end)
           )                                                        as entry,
           coalesce(
             sum(case when avg_exit_price > 0 and qty is not null
                      then avg_exit_price * qty end)
               / nullif(sum(case when avg_exit_price > 0 and qty is not null
                                 then qty end), 0),
             max(case when exit_rn = 1 and avg_exit_price > 0 then avg_exit_price end)
           )                                                        as exit,
           count(case when avg_entry_price > 0 then 1 end)           as entry_positions,
           count(case when avg_entry_price > 0
                       and qty is not null then 1 end)               as entry_positions_weighted,
           min(opened_at)                                           as first_buy,
           max(closed_at)                                           as last_sell
    from legs
    group by handle
    order by realized desc, handle`;

const OLD_TIMING = (marks: string): string => `
    with legs as (
      select t.display_handle as handle, tr.network_id, tr.token_key,
             tr.avg_exit_price, tr.opened_at, tr.trade_id,
             ${QTY},
             row_number() over (
               partition by t.display_handle, tr.network_id, tr.token_key
               order by (case when tr.avg_exit_price > 0 then 0 else 1 end),
                        tr.opened_at nulls last, tr.trade_id) as exit_rn
      from trades tr join traders t on t.handle = tr.handle
      where t.display_handle in (${marks}) and tr.status = 'closed')
    select l.handle, ti.price_usd as current,
           coalesce(
             sum(case when avg_exit_price > 0 and qty is not null
                      then avg_exit_price * qty end)
               / nullif(sum(case when avg_exit_price > 0 and qty is not null
                                 then qty end), 0),
             max(case when exit_rn = 1 and avg_exit_price > 0 then avg_exit_price end)
           ) as exit
    from legs l
    left join token_info ti on ti.network_id = l.network_id and ti.token_key = l.token_key
    group by l.handle, l.network_id, l.token_key, ti.price_usd`;

Deno.test("GET /tokens/:address/activity: holders, per-trader legs and exit timing equal the old statements'", async () => {
  const path = `/tokens/${ADDRESS}/activity?chain=ethereum`;
  const holders = await issued(path, "select t.display_handle, h.network_id, h.value");
  assertEquals(rows(holders, TOKEN, 1), rows(OLD_HOLDERS("and h.network_id = ?"), TOKEN, 1));
  // Without ?chain= the route stops at 400 (two chains), after the same holders statement.
  const everywhere = await issued(`/tokens/${ADDRESS}/activity`, "select t.display_handle, h.network_id, h.value", 400);
  assertEquals(rows(everywhere, TOKEN), rows(OLD_HOLDERS(""), TOKEN));
  assertEquals(rows(everywhere, TOKEN).length, 6);
  // In the view's ORDER too (the route adds the values up in it): o before p, ethereum before bsc, then the build as stored.
  assertEquals(rows(everywhere, CROSS), rows(OLD_HOLDERS(""), CROSS));
  assertEquals(rows(OLD_HOLDERS(""), CROSS).map((r) => `${r.display_handle}@${r.network_id}`),
    ["P@56", "P@1", "P@56", "Q@56", "Q@1", "R@56", "R@1"]);

  const per = await issued(path, "as entry_positions_weighted");
  const oldPer = rows(OLD_PER, TOKEN);
  assertEquals(rows(per, TOKEN), oldPer);
  // Every trader who traded it on ANY network, null and unlisted included; e never did.
  assertEquals(oldPer.map((r) => r.handle), ["A", "C", "G", "B"]);

  const timing = await issued(path, "as exit_rn\n      -- From the few traders asked for");
  const handles = oldPer.map((r) => String(r.handle));
  const marks = handles.map(() => "?").join(", ");
  assert(timing.includes(`in (${marks})`), "the captured statement binds one parameter per trader");
  const oldTiming = rows(OLD_TIMING(marks), ...handles);
  assertEquals(sorted(rows(timing, ...handles)), sorted(oldTiming));
  // ALL of a's closed coins (the token and OTHER), none of e's, and the open leg is no exit.
  assertEquals(sorted(oldTiming.map((r) => ({ h: r.handle }))), sorted([{ h: "A" }, { h: "A" }, { h: "B" }, { h: "C" }, { h: "G" }]));
});

// ------------------------------------------------------------------ GET /tokens (the board)

const OLD_BOARD = (chain: string): string => `
    select h.network_id, c.name as chain, tk.address,
           max(ti.price_usd)      as price_usd,
           max(ti.market_cap_usd) as market_cap_usd,
           max(ti.liquidity_usd)  as liquidity_usd,
           max(ti.holder_count)   as holder_count,
           max(ti.logo_url)       as logo_url,
           max(ti.fetched_at)     as info_fetched_at,
           max(cast(json_extract(ti.raw, '$.wallet_tags_stat.smart_wallets') as integer))    as smart_wallets,
           max(cast(json_extract(ti.raw, '$.wallet_tags_stat.renowned_wallets') as integer)) as renowned_wallets,
           max(ti.is_honeypot)          as is_honeypot,
           max(ti.can_not_sell)         as can_not_sell,
           max(ti.sell_tax)             as sell_tax,
           max(ti.rug_ratio)            as rug_ratio,
           max(ti.security_fetched_at)  as security_fetched_at,
           max(tk.launchpad)            as launchpad,
           max(tk.graduated)            as graduated,
           count(distinct h.handle)                   as holders,
           sum(case when h.value > 0 then h.value end) as total_value,
           count(case when h.value > 0 then h.value end) as priced,
           json_group_array(h.handle order by coalesce(h.value, 0) desc, st.rank nulls last) as handles
    from holdings_current h
    join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    join chains c on c.network_id = h.network_id
    left join trader_stats_current st on st.handle = h.handle
    left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    left join token_info ti on ti.network_id = h.network_id and ti.token_key = h.token_key
    where q.token_key is null ${chain}
    group by h.network_id, c.name, tk.address
    having count(distinct h.handle) >= ?
    order by count(distinct h.handle) desc nulls last,
             lower(tk.address), h.network_id`;

const OLD_TOTAL = (chain: string): string => `
    select count(*) as total_tokens from (
      select 1 from holdings_current h
      left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
      where q.token_key is null ${chain}
      group by h.network_id, h.token_key) x`;

const OLD_EXCLUDED = (chain: string): string => `
    select count(distinct h.network_id || ':' || h.token_key) as tokens, count(*) as positions
    from holdings_current h
    join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    ${chain}`;

Deno.test("GET /tokens: the board, its total and its excluded quote assets equal the view's, rank tiebreak included", async () => {
  // A query string of its own: the board is cached per URL for 60 s.
  const path = "/tokens?minHolders=1&limit=499";
  const board = await issued(path, "json_group_array");
  const expected = rows(OLD_BOARD(""), 1);
  assertEquals(rows(board, 1), expected);
  // g, a, c tie on value: g's rank 1, then a by his NEWEST rank (2, not the older 0), then c with no stats row.
  assertEquals(expected.find((r) => r.network_id === 1 && r.address === ADDRESS)?.handles, '["g","a","c","d","b"]');
  assertEquals(expected.find((r) => r.address === TIED)?.handles, '["y","x","w"]'); // a full tie, in the view's order
  assertEquals(rows(board, 2), rows(OLD_BOARD(""), 2)); // minHolders trims

  const pathOn = "/tokens?minHolders=1&limit=499&chain=ethereum";
  assertEquals(rows(await issued(pathOn, "json_group_array"), 1, 1), rows(OLD_BOARD("and h.network_id = ?"), 1, 1));

  assertEquals(rows(await issued("/tokens?minHolders=1&limit=498", "as total_tokens")), rows(OLD_TOTAL("")));
  assertEquals(rows(await issued("/tokens?minHolders=1&limit=498&chain=bsc", "as total_tokens"), 56), rows(OLD_TOTAL("and h.network_id = ?"), 56));
  assertEquals(rows(await issued("/tokens?minHolders=1&limit=497", "as positions")), rows(OLD_EXCLUDED("")));
  assertEquals(rows(OLD_EXCLUDED("")), [{ tokens: 1, positions: 1 }]);
  assertEquals(rows(await issued("/tokens?minHolders=1&limit=497&chain=ethereum", "as positions"), 1), rows(OLD_EXCLUDED("where h.network_id = ?"), 1));
});

// ------------------------------------------------------------------ GET /tokens/momentum

const OLD_GENS = "select distinct captured_at from holdings order by captured_at desc limit 2";

Deno.test("GET /tokens/momentum: the two newest generations, with none, one and many", async () => {
  const gens = await issued("/tokens/momentum?limit=499", "captured_at is not null");
  assertEquals(rows(gens), rows(OLD_GENS));
  assertEquals(rows(OLD_GENS), [{ captured_at: C_NEW }, { captured_at: F_NEW }]);
  for (const captures of [[], [C_NEW, C_NEW, C_NEW], [C_OLD, C_NEW, C_OLD]]) {
    const small = new DatabaseSync(":memory:");
    small.exec("create table holdings (captured_at text not null)");
    for (const at of captures) small.prepare("insert into holdings values (?)").run(at);
    assertEquals(small.prepare(gens).all().map((r) => ({ ...r })), small.prepare(OLD_GENS).all().map((r) => ({ ...r })));
    small.close();
  }
});

// ------------------------------------------------------------------ /tokens/:address/prices, POST /tokens/prices

const OLD_RESOLVE = (marks: string, chain: string): string => `
  select t.network_id, t.token_key, t.address, c.name as chain, t.symbol,
         ps.last_usd, ps.last_at, ps.ath_usd, ps.ath_at
    from tokens t
    join chains c on c.network_id = t.network_id
    left join token_price_stats ps on ps.network_id = t.network_id and ps.token_key = t.token_key
   where t.token_key in (${marks}) ${chain}
   order by t.token_key, t.network_id`;

const OLD_HOURLY = (from: string): string => `
        select w.network_id, w.token_key, p.at, p.usd, p.liquidity_usd,
               null as open_usd, null as high_usd, null as low_usd, null as hours
          from (select jn.value as network_id, jk.value as token_key
                  from json_each(?) jn
                  join json_each(?) jk on jk.key = jn.key) w
          join (
            select h.network_id, h.token_key, h.hour as at, h.usd, h.liquidity_usd,
                   row_number() over (
                     partition by h.network_id, h.token_key order by h.hour desc) as rn
              from token_price_hourly h
             where h.token_key in (select value from json_each(?))
               and h.hour <= ? ${from}) p
            on p.network_id = w.network_id and p.token_key = w.token_key and p.rn <= ?
         order by w.network_id, w.token_key, p.at desc`;

const OLD_CANDLES = (view: string, from: string): string => `
        select w.network_id, w.token_key, p.at, p.usd, null as liquidity_usd,
               p.open_usd, p.high_usd, p.low_usd, p.hours
          from (select jn.value as network_id, jk.value as token_key
                  from json_each(?) jn
                  join json_each(?) jk on jk.key = jn.key) w
          join (
            select v.network_id, v.token_key, v.bucket as at, v.close_usd as usd,
                   v.open_usd, v.high_usd, v.low_usd, v.hours,
                   row_number() over (
                     partition by v.network_id, v.token_key order by v.bucket desc) as rn
              from ${view} v
             where v.token_key in (select value from json_each(?))
               and v.bucket <= ? ${from}) p
            on p.network_id = w.network_id and p.token_key = w.token_key and p.rn <= ?
         order by w.network_id, w.token_key, p.at desc`;

Deno.test("token prices: tokens resolved through the chains, and every step's series, equal the old statements'", async () => {
  const FROM = "2026-08-31T00:00:00.000Z", TO = "2026-09-30T00:00:00.000Z";
  const range = `from=${FROM}&to=${TO}`;

  const two = await issued("/tokens/prices", "cross join tokens t", 200, { addresses: [ADDRESS, MINT] });
  for (const keys of [[TOKEN, MINT], [TOKEN, "0xnobody"], ["0xnobody", "0xnothing"]]) {
    assertEquals(rows(two, ...keys), rows(OLD_RESOLVE("?, ?", ""), ...keys));
  }
  assertEquals(rows(two, TOKEN, MINT).map((r) => r.chain), ["ethereum", "bsc", "solana"]); // one address, two chains
  const one = await issued(`/tokens/${ADDRESS}/prices?chain=bsc&${range}`, "cross join tokens t");
  assertEquals(rows(one, TOKEN, 56), rows(OLD_RESOLVE("?", "and t.network_id = ?"), TOKEN, 56));

  // Three pairs at once: two chains of one address, and a mint with no price at all.
  const nets = JSON.stringify([1, 56, SOL]), keys = JSON.stringify([TOKEN, TOKEN, MINT]);
  const base = `/tokens/${ADDRESS}/prices?chain=ethereum`;
  // Both ends are inclusive, so some bounds land ON a stored hour and ON a bucket start (a day, a Monday, a first).
  const BOUNDS = [[FROM, TO], ["2026-09-01T00:00:00.000Z", "2026-09-01T23:00:00.000Z"],
    ["2026-08-24T00:00:00.000Z", "2026-08-31T00:00:00.000Z"], ["2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"]];
  const onBound = new Set<string>();
  const same = (step: string, text: string, old: string, limit: number): void => {
    for (const [from, to] of BOUNDS) {
      const expected = rows(old, nets, keys, keys, to, from, limit);
      assertEquals(rows(text, nets, keys, to, from, limit), expected, `${step} ${from}..${to} limit ${limit}`);
      for (const r of expected) {
        if (r.at === from) onBound.add(`${step} from`);
        if (r.at === to) onBound.add(`${step} to`);
      }
    }
  };
  for (const limit of [2000, 2, 1]) {
    const hourly = await issued(`${base}&step=1h&${range}`, "null as open_usd");
    same("1h", hourly, OLD_HOURLY("and h.hour >= ?"), limit);
    const unbounded = await issued(`${base}&step=1h&window=all&to=${TO}`, "null as open_usd");
    assertEquals(rows(unbounded, nets, keys, TO, limit), rows(OLD_HOURLY(""), nets, keys, keys, TO, limit));

    for (const [step, view] of [["1d", "token_price_daily"], ["1w", "token_price_weekly"], ["1mo", "token_price_monthly"]]) {
      const candles = await issued(`${base}&step=${step}&${range}`, "as rn_asc");
      same(step, candles, OLD_CANDLES(view, "and v.bucket >= ?"), limit);
      const all = await issued(`${base}&step=${step}&window=all&to=${TO}`, "as rn_asc");
      assertEquals(rows(all, nets, keys, TO, limit), rows(OLD_CANDLES(view, ""), nets, keys, keys, TO, limit), `${step} all limit ${limit}`);
    }
  }
  // Nor are the bounds: every step answered a point sitting exactly on its lower bound and one exactly on its upper.
  assertEquals([...onBound].sort(), ["1d from", "1d to", "1h from", "1h to", "1mo from", "1mo to", "1w from", "1w to"]);
  // The seed is not vacuous: a day with two hours has an open, a close, a high and a low of its own.
  const day = rows(OLD_CANDLES("token_price_daily", ""), nets, keys, keys, TO, 2000)
    .find((r) => r.network_id === 1 && r.at === "2026-08-31T00:00:00.000Z");
  assertEquals([day?.open_usd, day?.usd, day?.high_usd, day?.low_usd, day?.hours], [3, 2, 3, 2, 2]);
});
