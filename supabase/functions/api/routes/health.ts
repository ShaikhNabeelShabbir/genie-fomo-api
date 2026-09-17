import { sql, n, round } from "../db.ts";
import { cfg } from "../config.ts";
import { get, requestVersion } from "../router.ts";

// ------------------------------------------------------------------ health

/** The body is the same for every caller, so one isolate computes it at most every 30 s. */
const HEALTH_CACHE_MS = 30_000;
let healthCache: { at: number; body: Record<string, unknown> } | null = null;

get("/v1/health", async (_p, url) => {
  const now = Date.now();
  const hit = healthCache && now - healthCache.at < HEALTH_CACHE_MS ? healthCache : null;
  const body = hit?.body ?? await healthBody();
  if (!hit) healthCache = { at: now, body };
  return {
    status: "ok",
    /** Which contract answered: `v1` on Supabase, `v2` on the Cloudflare Worker (same routes). */
    apiVersion: requestVersion(url.pathname),
    /** Whether this answer was computed for this call; `cacheAgeSeconds` says how old it is. */
    cached: hit !== null,
    cacheAgeSeconds: hit ? Math.round((now - hit.at) / 1000) : 0,
    ...body,
  };
});

async function healthBody(): Promise<Record<string, unknown>> {
  /** Exact counts throughout: SQLite has no planner estimate to substitute. See docs/DECISIONS.md#d063 */
  /** FOUR SEQUENTIAL AWAITS, DELIBERATELY. See docs/DECISIONS.md#d064 */
  const [c] = await sql`
    select (select count(*) from traders where listed = 1)       as traders,
           (select count(*) from traders where listed = 0)       as delisted,
           (select count(*) from holdings_current)               as holdings,
           (select count(*) from tokens)                         as tokens,
           (select count(*) from trades)                         as trades,
           -- SQLite has no planner row estimate, so transactions is now COUNTED like the
           -- rest; estimatedRows is empty because nothing on this route is an estimate.
           (select count(*) from transactions)                   as transactions,
           (select count(distinct handle) from wallets)          as wallets,
           (select count(distinct captured_at) from holdings)    as generations`;
  const [b] = await sql`
    select captured_at, window_label from builds order by captured_at desc limit 1`;

  /** Freshness per feed, so "the service is degraded" is distinguishable from "there is nothing… See docs/DECISIONS.md#d065 */
  const [f] = await sql`
    select (select max(captured_at) from trades)                         as trades_at,
           (select max(block_time)  from wallet_swaps)                   as swaps_at,
           (select max(captured_at) from holdings)                       as holdings_at,
           (select max(block_time)  from transactions)                   as transactions_at,
           (select max(fetched_at)  from token_info)                     as token_info_at,
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
           (select count(distinct handle) from aum_history)               as aum_traders`;
  /** HOW MANY TRADERS ARE THEMSELVES STALE. See docs/DECISIONS.md#d066 */
  const [st] = await sql`
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
      count(case when v.at is null then 1 end)                            as live_never,
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
    where t.listed = 1`;

  /* Kept from the concurrent attempt: a correlated EXISTS per trader, replaced by one count. */
  const [m] = await sql`
    select count(*) as traders,
           (select count(distinct handle) from trades where status = 'closed')
             as measurable
    from traders`;

  /** PER-CHAIN SAMPLER HEALTH, so "bsc stopped answering on the 14th" needs no sweep. */
  const chainRows = await sql`
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
    order by c.name`;
  const histOf = (r: Record<string, unknown>) => ({
    ready: Number(r.hist_ready), warming: Number(r.hist_warming), none: Number(r.hist_none),
  });
  const sumHist = (k: "ready" | "warming" | "none") =>
    chainRows.reduce((acc: number, r: Record<string, unknown>) => acc + histOf(r)[k], 0);

  const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);

  /** EVERY FEED SAYS WHETHER IT IS STILL ARRIVING, NOT ONLY WHEN IT LAST DID. See docs/DECISIONS.md#d067 */
  const nowMs = Date.now();
  const feed = (at: unknown, staleAfterHours: number, extra: Record<string, unknown> = {}) => {
    const t = at ? Date.parse(String(at)) : NaN;
    const ageSeconds = Number.isFinite(t) ? Math.round((nowMs - t) / 1000) : null;
    return {
      lastRefreshAt: iso(at),
      rowCount: null,
      ageSeconds,
      staleAfterHours,
      state: ageSeconds === null
        ? "never"
        : (ageSeconds > staleAfterHours * 3600 ? "stale" : "current"),
      ...extra,
    };
  };

  const feeds = {
    traders:      feed(b?.captured_at ?? null, 36),
    trades:       feed(f.trades_at, 72, { description: "fomoapi trade records, load time" }),
    /** X1b. The wallet's own resolved swaps (`wallet_swaps`, what /trades and /events?kind=swap read): newest block time. */
    swaps:        feed(f.swaps_at, 6, { description: "on-chain swaps resolved from the wallet's transactions, newest block time" }),
    wallets:      feed(f.wallets_at, 36),
    positions:    feed(f.holdings_at, 36),
    transactions: feed(f.transactions_at, 36),
    tokenInfo:    feed(f.token_info_at, 24 * 14),
    /**
     * X3. The clock is the newest hour `aum_history` carries a figure for. The hourly sampler
     * that used to write this feed was unscheduled on 17 Sep 2026 and its last reading is
     * 06:00 that day; `sampler` below keeps its clocks so nobody reads them as the live ones.
     */
    aum:          feed(f.aum_at, 36, {
                    rowCount: Number(f.aum_rows),
                    traders: Number(f.aum_traders),
                    newestReadingAt: iso(f.aum_at),
                    lastBuiltAt: iso(f.aum_built_at),
                    newestLiveAt: iso(f.aum_live_at),
                    description: "hours BUILT from stored holdings and prices (aum_history); `now` from aum_live",
                    sampler: {
                      retired: true,
                      retiredAt: "2026-09-17T03:52:00.000Z",
                      newestReadingAt: iso(f.sampler_at),
                      lastRunAt: iso(f.sampler_run_at),
                      note: "the hourly sampler was unscheduled on 17 Sep 2026; these clocks do not move",
                    },
                    /** A1. Trader-chains by `knownChains[].historyState`, summed over chains. */
                    historyState: { ready: sumHist("ready"), warming: sumHist("warming"), none: sumHist("none") },
                    /** accepted = a chain row with a figure; failed = one carrying a reason. */
                    chains: Object.fromEntries(chainRows.map((r: Record<string, unknown>) => [String(r.name), {
                      accepted36h: Number(r.accepted_36h),
                      failed24h: Number(r.failed_24h),
                      newestAcceptedAt: iso(r.newest_accepted_at),
                      historyState: histOf(r),
                    }])),
                  }),
  };
  /**
   * T2. A feed is stale when its clock is old OR any trader is past the feed's own
   * `staleAfterHours`. The `trades` clock moves whenever anyone loads, so 16 traders sat
   * 221 h old under `dataState: current`; `scorecards` names them (count and age are in
   * `staleTraders.scorecardStale` / `oldestScorecardHours`).
   */
  const staleFeeds = Object.entries(feeds)
    .filter(([, v]) => v.state !== "current").map(([k]) => k)
    .concat(Number(st?.scorecard_stale ?? 0) > 0 ? ["scorecards"] : []).sort();

  /*
   * The share of traders carrying a usable rhythm figure (§5) is fetched above, with the
   * rest. It used to run a correlated EXISTS over `trades` once per trader; counting the
   * distinct handles that have a closed trade answers the same question without the
   * per-row subquery.
   */

  // The store follows the runtime: v1 still answers from the frozen Supabase Postgres, v2 from
  // Cloudflare D1 (17 Sep 2026). Saying "postgres" on v2 misnamed the database to every consumer.
  const onDeno = Boolean((globalThis as { Deno?: unknown }).Deno);
  return {
    runtime: onDeno ? "supabase edge function (deno)" : "cloudflare worker",
    source: onDeno ? "postgres" : "cloudflare d1",
    build: { capturedAt: b?.captured_at ?? null, window: b?.window_label ?? null },
    /** Per-feed freshness AND a verdict on it. See docs/DECISIONS.md#d068 */
    feeds,
    /**
     * `status` stays `ok` while the service answers, because that is what it has always meant
     * and a consumer checks it for liveness. Whether the DATA is still arriving is a separate
     * question with a separate field, and `staleFeeds` names the ones that stopped, so nobody
     * has to read seven dates to find out.
     */
    dataState: staleFeeds.length ? "degraded" : "current",
    staleFeeds,
    /**
     * PER-TRADER STALENESS, which no feed clock can express.
     *
     * A feed reports when its job last wrote anything. A trader the job did not reach keeps
     * his old figures and moves no feed, so `feeds` can read `current` across the board while
     * traders carry week-old readings. These counts are the ones to watch.
     */
    staleTraders: {
      /** A2. Traders whose live figure (`/aum/now`) is older than an hour, and the oldest of them. */
      liveStale: Number(st?.live_stale ?? 0),
      liveStaleAfterHours: 1,
      liveNever: Number(st?.live_never ?? 0),
      oldestLiveHours: st?.oldest_live_h === null || st?.oldest_live_h === undefined
        ? null : Number(st.oldest_live_h),
      readingStale: Number(st?.reading_stale ?? 0),
      readingStaleAfterHours: 36,
      noReading: Number(st?.no_reading ?? 0),
      oldestReadingHours: st?.oldest_reading_h === null || st?.oldest_reading_h === undefined
        ? null : Number(st.oldest_reading_h),
      /** Stale is judged on `trades.captured_at`, the same column the scorecards loader targets; fomoapi.io traders only. */
      scorecardStale: Number(st?.scorecard_stale ?? 0),
      /** Stale traders the fomoapi loader does not own (`source` gmgn); the nightly gmgn job refreshes them. */
      scorecardStaleGmgn: Number(st?.scorecard_stale_gmgn ?? 0),
      scorecardStaleAfterHours: 72,
      /** T1. Of the stale, how many the loader's last attempt did not bring back — a never-attempted trader counts. */
      scorecardLoadFailed: Number(st?.scorecard_load_failed ?? 0),
      /** Of the stale, how many have no `trade_loads` row at all: the loader never asked. */
      scorecardNeverAttempted: Number(st?.scorecard_never_attempted ?? 0),
      oldestScorecardHours: st?.oldest_scorecard_h === null || st?.oldest_scorecard_h === undefined
        ? null : Number(st.oldest_scorecard_h),
      of: Number(c.traders),
    },
    measurements: {
      traders: Number(m.traders),
      withClosedTrades: Number(m.measurable),
      share: Number(m.traders) ? Number((Number(m.measurable) / Number(m.traders)).toFixed(4)) : null,
    },
    rows: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number(v)])),
    /**
     * TRADERS THE SOURCE NO LONGER CARRIES, taken off the board and kept in the database.
     *
     * `rows.traders` counts the LISTED ones, which is what the directory serves and what every
     * coverage figure here is measured against. These four are excluded from it and still
     * answer by name, so a consumer reconciling an older copy can tell "dropped" from "gone".
     */
    delistedTraders: {
      count: Number(c.delisted ?? 0),
      reason: "absent_from_source",
      note: "not deleted — their holdings, trades and history are intact, and the flag " +
            "reverses if the source lists them again. Ask for them with ?includeDelisted=true",
    },
    /** Which entries in `rows` are planner estimates rather than counted: none, on SQLite. */
    estimatedRows: [] as string[],
    /** HOW MANY EXTERNAL CALLS A REQUEST CAN COST — no longer flatly zero. See docs/DECISIONS.md#d069 */
    externalCallsPerRequest: {
      typical: 0,
      max: 1,
      note: "0 on every route except /traders/:handle/aum, which fetches a live reading when " +
            "the stored one is past the freshness floor. Pass ?live=false to forbid it",
      liveAum: {
        enabled: (cfg("AUM_SAMPLE_URL") ?? "").trim() !== "" &&
                 (cfg("AUM_SAMPLE_SECRET") ?? "").trim() !== "",
        freshnessFloorMinutes: Number(cfg("AUM_LIVE_AFTER_MINUTES") ?? 5),
      },
    },
    /** WHICH CAPABILITIES ARE STILL DELIVERING, by name, judged on evidence. See docs/DECISIONS.md#d070 */
    capabilities: (() => {
      type FeedName = keyof typeof feeds;
      const caps: { name: string; supplies: FeedName[]; key: string }[] = [
        { name: "solana history and balances", key: "HELIUS_SOLANA_KEY",
          supplies: ["transactions", "positions", "aum"] },
        { name: "evm history", key: "BITQUERY_KEY", supplies: ["transactions"] },
        { name: "evm address resolution", key: "BITQUERY_KEY", supplies: ["wallets"] },
        { name: "trader directory and trades", key: "FOMOAPI_KEY", supplies: ["traders", "trades"] },
        { name: "gmgn directory", key: "GMGN_API_KEY", supplies: ["traders"] },
      ];
      const judged = caps.map((c) => {
        const states = c.supplies.map((f) => feeds[f].state);
        /* Any feed still arriving means the loader ran; only all-stale is a stopped capability. */
        const state = states.includes("current")
          ? "current"
          : (states.every((x) => x === "never") ? "never" : "stale");
        return {
          name: c.name,
          state,
          /** The feeds this capability fills — check them in `feeds` for dates. */
          supplies: c.supplies,
          staleFeeds: c.supplies.filter((f) => feeds[f].state !== "current"),
          /**
           * Presence of the key IN THIS PROCESS, which is normally false and is not a fault.
           * The loaders hold these keys and run elsewhere. Never the value, only presence.
           */
          keyInThisProcess: (cfg(c.key) ?? "").trim().length > 0,
        };
      });
      return {
        /** Capabilities whose data has stopped arriving. Empty is the healthy state. */
        degraded: judged.filter((x) => x.state !== "current").map((x) => x.name),
        providers: judged,
        basis: "judged on whether each capability's feeds are still arriving, not on key " +
               "presence — the keys belong to the scheduled loaders and this function holds " +
               "none of them by design",
      };
    })(),
  };
}
