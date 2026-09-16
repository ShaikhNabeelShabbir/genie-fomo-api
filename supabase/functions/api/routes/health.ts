import { sql, n, round } from "../db.ts";
import { get } from "../router.ts";

// ------------------------------------------------------------------ health

get("/v1/health", async () => {
  /*
   * Exact counts everywhere except `transactions`, which is an estimate and says so.
   *
   * count(*) over transactions is a sequential scan. At 666,895 rows it measured 23.8s and
   * hit the 2min statement timeout once -- on the endpoint whose entire job is to answer
   * quickly whether the service is alive. The planner's own row estimate answers the same
   * question in microseconds.
   *
   * It is reported under `transactions` as before so no consumer breaks, and listed in
   * `estimatedRows` so nobody mistakes it for a counted figure. An approximate number that
   * admits it is approximate is honest; one that does not is the failure this API is
   * organised against.
   */
  /*
   * FOUR SEQUENTIAL AWAITS, DELIBERATELY.
   *
   * Each is a round trip and the queries themselves measure about 150 ms, so running them
   * together looked like free latency. It was not: batched into one Promise.all against a
   * pool of 2, this endpoint stopped answering entirely -- 90 seconds, the route timeout,
   * with every underlying query still returning in 150 ms when run by hand.
   *
   * The cause was not worth chasing on a liveness endpoint. Sequential is 2.4 seconds and
   * works. If this is made concurrent again, test /health specifically after deploying:
   * every other route kept working while this one hung, so a smoke test that skips it passes.
   */
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

  /*
   * Freshness per feed, so "the service is degraded" is distinguishable from "there is
   * nothing". A consumer comparing a stale figure against a fresh one has no way to know
   * which feed lagged unless the service says so.
   *
   * Each row is the newest measurement time for that feed and how many rows stand behind
   * it. `null` means the feed has never run, which is a different statement from zero.
   */
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
  /*
   * HOW MANY TRADERS ARE THEMSELVES STALE.
   *
   * Every feed above can read `current` while individual traders carry week-old figures: a
   * feed's clock is the job's last write, and a job that runs without reaching a trader
   * leaves that trader behind without moving any feed. Fourteen traders were sitting on
   * readings four to seven days old while every feed said `current`, and the only way to find
   * them was to check traders one at a time.
   *
   * So the count is published. It is the number either team would look at to notice the
   * reload has stopped landing, and it measures 168 ms.
   */
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

  /*
   * EVERY FEED SAYS WHETHER IT IS STILL ARRIVING, NOT ONLY WHEN IT LAST DID.
   *
   * `lastRefreshAt` was already here and a consumer could in principle subtract it from the
   * clock -- but nobody did, and the balance readings sat 75 hours old while every answer
   * said `ready`. A date is not a verdict. Each feed now carries its own allowance and the
   * verdict that follows from it, so one call to /health shows which feed stopped.
   *
   * The allowances are the schedules themselves plus one missed run: the daily jobs get 36
   * hours, the trade loader 72 because it is the expensive one and skips runs by design.
   * `state` is `current`, `stale`, or `never` -- and `never` is not `stale`, because a feed
   * that has not run once has a different cause and a different fix.
   */
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
  const staleFeeds = Object.entries(feeds)
    .filter(([, v]) => v.state !== "current").map(([k]) => k).sort();

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
    /**
     * Per-feed freshness AND a verdict on it. A stale feed is visible here before it misleads
     * a screen.
     *
     * `traders` is the directory build, which is what the directory's own `capturedAt`
     * reports. It used to be filled from the trade loader's clock -- two different jobs under
     * one name, so a five-day-old trade load read as a five-day-old directory and the loader
     * itself had no entry at all. `trades` is now its own feed.
     *
     * `aum.lastRefreshAt` is the newest reading's own timestamp; `lastSuccessAt` is when the
     * sampler last wrote one. They differ, and the second is the one that says the job ran.
     */
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
    /**
     * HOW MANY EXTERNAL CALLS A REQUEST CAN COST — no longer flatly zero.
     *
     * It was 0, and the claim was load-bearing: every route answered from Postgres, so a
     * thousand visitors cost what one does. `/traders/:handle/aum` now breaks that on purpose
     * — when its stored reading is past the freshness floor it fetches a live one, which is
     * one call to the sampler and, behind that, a sweep of the trader's wallets.
     *
     * Reported as a range rather than left at 0. A field that quietly stops being true is the
     * exact failure this service is organised against, and it is worth recording that this
     * very field was accidentally DELETED from this response earlier today by the edit that
     * rewrote `capabilities` below — removed from a live deployment with nothing announcing
     * it, which is the fault F9 exists to catch.
     */
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
    /**
     * WHICH CAPABILITIES ARE STILL DELIVERING, by name, judged on evidence.
     *
     * A consumer checks health once and routes thousands of times, so a capability that only
     * reveals itself on the thousandth call is one every consumer discovers the expensive way.
     *
     * THE FIRST VERSION OF THIS BLOCK WAS WRONG, and deploying it is what showed that. It
     * reported whether each provider's KEY was set in this process, which read correctly on a
     * laptop -- where .env is loaded -- and reported all five providers degraded on the
     * deployed function, where none of those keys exists. They are not supposed to: the keys
     * belong to the scheduled loaders, which run in GitHub Actions and never inside this
     * function. `externalCallsPerRequest` is 0 precisely because of that. So key presence here
     * is evidence of nothing, and publishing it as `degraded` was a permanent false alarm on
     * exactly the field a consumer would page on.
     *
     * What CAN be answered from here is the question that actually matters: is this
     * capability's data still arriving? Every provider is judged by the feeds it fills.
     * A capability whose feeds have all gone stale is degraded whatever its key says, and one
     * whose feeds are current is working whatever this process can see.
     */
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
