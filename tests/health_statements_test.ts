import { assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { refreshHealthSnapshot } from "../supabase/functions/api/routes/health.ts";

/*
 * F13 (19 Sep 2026): the snapshot job's statements were rewritten to seek, not walk. These are the
 * statements as they were, VERBATIM; the published figures must not move on any of the seeded edges.
 */
const OLD = {
  COUNTS: `
    select (select count(*) from traders where listed = 1)       as traders,
           (select count(*) from traders where listed = 0)       as delisted,
           (select count(*) from holdings_current)               as holdings,
           (select count(*) from tokens)                         as tokens,
           (select count(*) from trades)                         as trades,
           -- SQLite has no planner row estimate, so transactions is now COUNTED like the
           -- rest; estimatedRows is empty because nothing on this route is an estimate.
           (select count(*) from transactions)                   as transactions,
           (select count(distinct handle) from wallets)          as wallets,
           (select count(distinct captured_at) from holdings)    as generations`,
  FEEDS: `
    select (select max(captured_at) from trades)                         as trades_at,
           (select max(block_time)  from wallet_swaps)                   as swaps_at,
           (select max(captured_at) from holdings)                       as holdings_at,
           (select max(block_time)  from transactions)                   as transactions_at,
           (select max(fetched_at)  from token_info)                     as token_info_at,
           -- The hourly prices job stamps last_at; DexScreener refused it for two days and no feed said so.
           (select max(last_at)     from token_price_stats)              as prices_at,
           (select max(at)          from aum_samples)                    as sampler_at,
           (select max(sampled_at)  from aum_samples
              where basis = 'sampled')                                   as sampler_run_at,
           -- X3 (v5 fixes): the balance clock is what BUILDS the hours now, not the retired
           -- sampler. feeds.aum read aum_samples, whose newest row is 17 Sep 06:00, while
           -- aum_history and aum_live went on writing every hour after it -- so /health
           -- contradicted the data it describes. The sampler's own clocks stay, named for it.
           (select max(computed_at) from aum_history)                     as aum_built_at,
           (select max(hour)        from aum_history
              where total_usd is not null)                               as aum_at,
           (select max(at)          from aum_live)                        as aum_live_at,
           (select max(last_seen_at) from wallets)                       as wallets_at,
           (select count(*) from aum_history)                             as aum_rows,
           (select count(distinct handle) from aum_history)               as aum_traders`,
  STALE: `
    with newest as (
      select handle, max(case when total_usd is not null then at end) as reading_at
      from aum_samples group by handle
    ), loads as (
      select handle, max(captured_at) as scorecard_at from trades group by handle
    ), live as (
      select handle, at from aum_live
    ), attempts as (
      -- distinct on (handle) ... order by handle, attempted_at desc.
      select handle, outcome from (
        select handle, outcome,
               row_number() over (partition by handle order by attempted_at desc) as rn
        from trade_loads) where rn = 1
    )
    select
      -- A2 (v5 fixes): a trader nobody watched kept a six-hour-old live figure while
      -- /health said nothing about it. This is the count to watch, beside the readings.
      -- A trader with no wallet on record can never carry a balance, so counting them here
      -- would leave liveNever permanently non-zero and looking like a defect.
      count(case when v.at is null
                  and exists (select 1 from wallets w where w.handle = t.handle
                                and (w.sol_address is not null or w.evm_address is not null))
                 then 1 end)                                              as live_never,
      count(case when v.at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours') then 1 end) as live_stale,
      cast(round(max((julianday('now') - julianday(v.at)) * 24.0)) as integer)
                                                                          as oldest_live_h,
      count(case when n.reading_at is null then 1 end)                    as no_reading,
      count(case when n.reading_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-36 hours') then 1 end) as reading_stale,
      count(case when l.scorecard_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-72 hours')
                  and t.source = 'fomoapi.io' then 1 end)                 as scorecard_stale,
      -- 'is not' is SQLite's null-safe comparison, i.e. is distinct from.
      count(case when l.scorecard_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-72 hours')
                  and t.source is not 'fomoapi.io' then 1 end)            as scorecard_stale_gmgn,
      count(case when l.scorecard_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-72 hours')
                  and t.source = 'fomoapi.io'
                  and a.outcome is not 'loaded' then 1 end)               as scorecard_load_failed,
      count(case when l.scorecard_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-72 hours')
                  and t.source = 'fomoapi.io' and a.handle is null then 1 end)
                                                                          as scorecard_never_attempted,
      -- extract(epoch from (now() - t)) / 3600.0 is a julianday difference in hours;
      -- the ::int rounded, so round() keeps the figure rather than truncating it.
      cast(round(max((julianday('now') - julianday(n.reading_at)) * 24.0)) as integer)
                                                                          as oldest_reading_h,
      cast(round(max((julianday('now') - julianday(l.scorecard_at)) * 24.0)) as integer)
                                                                          as oldest_scorecard_h
    from traders t left join newest n using (handle) left join loads l using (handle)
      left join live v using (handle) left join attempts a using (handle)
    where t.listed = 1`,
  TOKEN_INFO: `
    select count(*) as held,
           count(case when i.fetched_at is null then 1 end) as never_fetched,
           count(case when i.fetched_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-48 hours') then 1 end) as stale
    from (select distinct network_id, token_key from holdings_current where human_amount > 0) h
    left join token_info i on i.network_id = h.network_id and i.token_key = h.token_key`,
  MEASURABLE: `
    select count(*) as traders,
           (select count(distinct handle) from trades where status = 'closed')
             as measurable
    from traders`,
  CHAINS: `
    /*
     * One grouped pass per block so each chain is one range on aum_chain_samples_net_at_idx
     * (network_id, at desc) where basis = 'sampled'; the history counts come from
     * trader_chain_history, the one definition knownChainsFor also reads, aggregated once
     * for all chains. The two Postgres laterals became these joins.
     */
    select c.name,
           coalesce(r.accepted_36h, 0) as accepted_36h,
           coalesce(r.failed_24h, 0)   as failed_24h,
           a.newest_accepted_at,
           coalesce(h.ready, 0)        as hist_ready,
           coalesce(h.warming, 0)      as hist_warming,
           coalesce(h.none, 0)         as hist_none
    from chains c
    left join (
      select s.network_id,
             count(case when s.total_usd is not null
                         and s.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-36 hours') then 1 end) as accepted_36h,
             count(case when s.reason is not null
                         and s.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours') then 1 end) as failed_24h
      from aum_chain_samples s
      where s.basis = 'sampled'
        and s.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-36 hours')
      group by s.network_id) r on r.network_id = c.network_id
    left join (
      select s.network_id, s.at as newest_accepted_at,
             row_number() over (partition by s.network_id order by s.at desc) as rn
      from aum_chain_samples s
      where s.basis = 'sampled' and s.total_usd is not null) a
      on a.network_id = c.network_id and a.rn = 1
    left join (
      select network_id,
             count(case when history_state = 'ready'   then 1 end) as ready,
             count(case when history_state = 'warming' then 1 end) as warming,
             count(case when history_state = 'none'    then 1 end) as none
      from trader_chain_history group by network_id) h on h.network_id = c.network_id
    order by c.name`,
} as const;

const SOL = 1399811149;
const db = await openSchema();
/* One instant for every seeded timestamp: a parent and its child row must carry the same `at`. */
const NOW = Date.now();
const ago = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();
const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
const old = (text: string): Record<string, unknown>[] => db.prepare(text).all() as Record<string, unknown>[];

function seed(): void {
  db.exec("insert into builds (captured_at, window_label, trader_count, holding_count) values ('2026-09-19T01:00:00.000Z','30d',0,0)");
  for (const [h, listed, source] of [["a", 1, "fomoapi.io"], ["b", 1, "fomoapi.io"], ["c", 0, "fomoapi.io"], ["d", 1, "gmgn"], ["e", 1, "fomoapi.io"], ["f", 1, "fomoapi.io"]] as const) {
    run("insert into traders (handle, display_handle, id, listed, source) values (?,?,?,?,?)", h, h, `id-${h}`, listed, source);
  }
  run("insert into wallets (handle, evm_address) values ('a','0xA'), ('b','0xB')");
  for (let k = 0; k < 8; k++) for (const net of [1, 56, SOL]) run("insert into tokens (network_id, address, token_key) values (?,?,?)", net, `tok${k}`, `tok${k}`);
  const hold = (h: string, net: number, k: number, at: string, amount: number | null, source: string): void =>
    run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, source) values (?,?,?,?,?,?)", h, net, `tok${k}`, at, amount, source);
  const [G1, G2, G3] = [ago(30), ago(20), ago(10)];
  /* a: three captures on ethereum, the newest SMALLER than the one before and holding a zero and a null; one on solana. */
  for (const k of [0, 1, 2, 3]) hold("a", 1, k, G1, 5, "chain");
  for (const k of [0, 1, 2, 3, 4]) hold("a", 1, k, G2, 5, "chain");
  hold("a", 1, 0, G3, 5, "chain"); hold("a", 1, 1, G3, 0, "chain"); hold("a", 1, 2, G3, null, "chain");
  hold("a", SOL, 5, G2, 7, "chain");
  /* b: fomo rows in two builds (only the newest counts) on ethereum; on bsc a chain read wins over the fomo rows. */
  for (const k of [0, 6]) hold("b", 1, k, G1, 3, "fomo");
  for (const k of [0, 6, 7]) hold("b", 1, k, G2, 3, "fomo");
  hold("b", 56, 1, G2, 3, "fomo"); hold("b", 56, 2, G1, 9, "chain");
  /* c is delisted and still holds; e holds only dust the view counts as a row and not as a position. */
  hold("c", 1, 3, G3, 2, "chain"); hold("e", 56, 4, G3, 0, "chain");
  run("insert into token_info (network_id, token_key, fetched_at) values (1,'tok0',?), (1,'tok6',?), (56,'tok2',?)", ago(1), ago(100), ago(47));

  const trade = (id: string, h: string, net: number | null, status: string, capturedHoursAgo: number): void =>
    run("insert into trades (trade_id, handle, network_id, token_key, status, captured_at) values (?,?,?,?,?,?)", id, h, net, "tok0", status, ago(capturedHoursAgo));
  trade("1", "a", 1, "closed", 100.25); trade("2", "a", 56, "open", 200.25); trade("3", "b", 1, "closed", 90.25);
  trade("4", "d", 56, "open", 80.25); trade("5", "d", null, "open", 85.25); trade("6", "e", 1, "open", 1); trade("7", "c", 1, "closed", 300.25);
  trade("8", "f", SOL, "open", 95.25); // stale and never attempted, beside b: the two counts differ from the attempted one
  run("insert into trade_loads (handle, attempted_at, outcome) values ('a',?,'loaded'), ('a',?,'error'), ('d',?,'loaded'), ('ghost',?,'error')", ago(50), ago(2), ago(3), ago(1));

  const sample = (h: string, hoursAgo: number, basis: string, net: number, usd: number | null): void => {
    run("insert or ignore into aum_samples (handle, at, total_usd, refused_reason, basis, tier) values (?,?,?,?,?,'verified')", h, ago(hoursAgo), usd, usd === null ? "no_prices" : null, basis);
    run("insert into aum_chain_samples (handle, at, basis, network_id, total_usd, reason) values (?,?,?,?,?,?)", h, ago(hoursAgo), basis, net, usd, usd === null ? "no_prices" : null);
  };
  sample("a", 40.25, "sampled", 1, 10); sample("a", 12.25, "sampled", 1, 11); sample("a", 3.25, "sampled", 1, null); // ready; the newest is refused
  sample("b", 50.25, "sampled", 56, 10);                                                                          // warming
  sample("b", 30.25, "rebuilt", SOL, 10); sample("b", 29.25, "rebuilt", SOL, 10);                                 // ready, and never "accepted"
  sample("d", 6.25, "sampled", 1, null);                                                                          // a refusal is no evidence
  for (const [h, hoursAgo] of [["a", 0.25], ["a", 5], ["b", 3.25]] as const) {
    run("insert into aum_history (handle, hour, total_usd, basis) values (?,?,?,'priced')", h, ago(hoursAgo), 10);
  }
  run("insert into aum_live (handle, at, total_usd, source) values ('a',?,1,'build'), ('d',?,1,'build')", ago(0.25), ago(7.25));
}

Deno.test("health: the statements rewritten to seek publish exactly what the ones that walked did", async () => {
  seed();
  const [c] = old(OLD.COUNTS), [f] = old(OLD.FEEDS), [st] = old(OLD.STALE), [ti] = old(OLD.TOKEN_INFO), [m] = old(OLD.MEASURABLE);
  const chains = old(OLD.CHAINS);
  const body = JSON.parse((await refreshHealthSnapshot()).body);

  /* The edges are really there: the view's count, the distinct held coins, and one chain in every history state. */
  assertEquals([c.holdings, c.generations, ti.held, ti.never_fetched, ti.stale, m.measurable, f.aum_traders], [10, 3, 6, 3, 1, 3, 2]);
  assertEquals(body.rows, Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number(v)])));
  assertEquals(body.feeds.aum.traders, Number(f.aum_traders));
  assertEquals(
    [body.feeds.tokenInfo.heldCoins, body.feeds.tokenInfo.heldCoinsNeverRead, body.feeds.tokenInfo.heldCoinsStale],
    [Number(ti.held), Number(ti.never_fetched), Number(ti.stale)]);
  assertEquals(body.measurements.withClosedTrades, Number(m.measurable));
  const s = body.staleTraders;
  assertEquals(
    [s.liveNever, s.liveStale, s.oldestLiveHours, s.noReading, s.readingStale, s.scorecardStale, s.scorecardStaleGmgn,
      s.scorecardLoadFailed, s.scorecardNeverAttempted, s.oldestReadingHours, s.oldestScorecardHours],
    [st.live_never, st.live_stale, st.oldest_live_h, st.no_reading, st.reading_stale, st.scorecard_stale, st.scorecard_stale_gmgn,
      st.scorecard_load_failed, st.scorecard_never_attempted, st.oldest_reading_h, st.oldest_scorecard_h]);
  assertEquals([s.scorecardStale, s.scorecardLoadFailed, s.scorecardNeverAttempted, s.scorecardStaleGmgn], [3, 3, 2, 1]);
  assertEquals(body.feeds.aum.chains, Object.fromEntries(chains.map((r) => [String(r.name), {
    accepted36h: Number(r.accepted_36h), failed24h: Number(r.failed_24h),
    newestAcceptedAt: r.newest_accepted_at ? new Date(String(r.newest_accepted_at)).toISOString() : null,
    historyState: { ready: Number(r.hist_ready), warming: Number(r.hist_warming), none: Number(r.hist_none) },
  }])));
  assertEquals(body.feeds.aum.chains.ethereum.historyState, { ready: 1, warming: 0, none: 3 });
  assertEquals(body.feeds.aum.chains.bsc.historyState, { ready: 0, warming: 1, none: 2 });
});
