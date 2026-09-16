import { sql, n, round } from "../db.ts";
import { get } from "../router.ts";

// ------------------------------------------------------------------ health

get("/v1/health", async () => {
  /** Exact counts everywhere except `transactions`, which is an estimate and says so. See docs/DECISIONS.md#d063 */
  /** FOUR SEQUENTIAL AWAITS, DELIBERATELY. See docs/DECISIONS.md#d064 */
  const [c] = await sql`
    select (select count(*) from traders where listed)           as traders,
           (select count(*) from traders where not listed)       as delisted,
           (select count(*) from holdings_current)               as holdings,
           (select count(*) from tokens)                         as tokens,
           (select count(*) from trades)                         as trades,
           (select greatest(reltuples, 0)::bigint from pg_class
             where oid = 'public.transactions'::regclass)        as transactions,
           (select count(distinct handle) from wallets)          as wallets,
           (select count(distinct captured_at) from holdings)    as generations`;
  const [b] = await sql`
    select captured_at, window_label from builds order by captured_at desc limit 1`;

  /** Freshness per feed, so "the service is degraded" is distinguishable from "there is nothing… See docs/DECISIONS.md#d065 */
  const [f] = await sql`
    select (select max(captured_at) from trades)                         as trades_at,
           (select max(captured_at) from holdings)                       as holdings_at,
           (select max(block_time)  from transactions)                   as transactions_at,
           (select max(fetched_at)  from token_info)                     as token_info_at,
           (select max(at)          from aum_samples)                    as aum_at,
           (select max(sampled_at)  from aum_samples
              where basis = 'sampled')                                   as aum_success_at,
           (select max(last_seen_at) from wallets)                       as wallets_at,
           (select count(*) from aum_samples)::int                       as aum_rows,
           (select count(distinct handle) from aum_samples)::int         as aum_traders`;
  /** HOW MANY TRADERS ARE THEMSELVES STALE. See docs/DECISIONS.md#d066 */
  const [st] = await sql`
    with newest as (
      select handle, max(at) filter (where total_usd is not null) as reading_at
      from aum_samples group by handle
    ), loads as (
      select handle, max(captured_at) as scorecard_at from trades group by handle
    )
    select
      count(*) filter (where n.reading_at is null)::int                       as no_reading,
      count(*) filter (where n.reading_at < now() - interval '36 hours')::int as reading_stale,
      count(*) filter (where l.scorecard_at < now() - interval '72 hours')::int
                                                                             as scorecard_stale,
      max(extract(epoch from (now() - n.reading_at)) / 3600.0)::int           as oldest_reading_h,
      max(extract(epoch from (now() - l.scorecard_at)) / 3600.0)::int         as oldest_scorecard_h
    from newest n full join loads l using (handle)`;

  /* Kept from the concurrent attempt: a correlated EXISTS per trader, replaced by one count. */
  const [m] = await sql`
    select count(*)::int as traders,
           (select count(distinct handle) from trades where status = 'closed')::int
             as measurable
    from traders`;

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
    trades:       feed(f.trades_at, 72),
    wallets:      feed(f.wallets_at, 36),
    positions:    feed(f.holdings_at, 36),
    transactions: feed(f.transactions_at, 36),
    tokenInfo:    feed(f.token_info_at, 24 * 14),
    aum:          feed(f.aum_success_at ?? f.aum_at, 36, {
                    rowCount: Number(f.aum_rows),
                    traders: Number(f.aum_traders),
                    newestReadingAt: iso(f.aum_at),
                    lastSuccessAt: iso(f.aum_success_at),
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

  return {
    status: "ok",
    runtime: "supabase edge function (deno)",
    source: "postgres",
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
      readingStale: Number(st?.reading_stale ?? 0),
      readingStaleAfterHours: 36,
      noReading: Number(st?.no_reading ?? 0),
      oldestReadingHours: st?.oldest_reading_h === null || st?.oldest_reading_h === undefined
        ? null : Number(st.oldest_reading_h),
      scorecardStale: Number(st?.scorecard_stale ?? 0),
      scorecardStaleAfterHours: 72,
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
    /** Which entries in `rows` are planner estimates rather than counted. */
    estimatedRows: ["transactions"],
    /** HOW MANY EXTERNAL CALLS A REQUEST CAN COST — no longer flatly zero. See docs/DECISIONS.md#d069 */
    externalCallsPerRequest: {
      typical: 0,
      max: 1,
      note: "0 on every route except /traders/:handle/aum, which fetches a live reading when " +
            "the stored one is past the freshness floor. Pass ?live=false to forbid it",
      liveAum: {
        enabled: (Deno.env.get("AUM_SAMPLE_URL") ?? "").trim() !== "" &&
                 (Deno.env.get("AUM_SAMPLE_SECRET") ?? "").trim() !== "",
        freshnessFloorMinutes: Number(Deno.env.get("AUM_LIVE_AFTER_MINUTES") ?? 5),
      },
    },
    /** WHICH CAPABILITIES ARE STILL DELIVERING, by name, judged on evidence. See docs/DECISIONS.md#d070 */
    capabilities: (() => {
      type FeedName = keyof typeof feeds;
      const caps: { name: string; supplies: FeedName[]; key: string }[] = [
        { name: "solana history and balances", key: "HELIUS_SOLANA_KEY",
          supplies: ["transactions", "positions", "aum"] },
        { name: "evm history", key: "ETHERSCAN_KEY", supplies: ["transactions"] },
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
          keyInThisProcess: (Deno.env.get(c.key) ?? "").trim().length > 0,
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
});
