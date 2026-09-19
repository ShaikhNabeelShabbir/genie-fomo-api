import { ttlCache, urlKey } from "../shared/cache.ts";
import { sql, n, round } from "../db.ts";
import { cfg } from "../config.ts";
import { get, post } from "../router.ts";
import { notFound, badRequest, ApiError, includeUnavailable } from "../errors.ts";
import { asOfHoldings } from "../shared/asof.ts";
import { intParam, numParam, sortParam, nonEmpty } from "../shared/params.ts";
import { bool, money } from "../shared/format.ts";
import { nativePrices } from "../shared/prices.ts";
import { KnownChain, knownChainsFor } from "../shared/chains.ts";
import { resolveTrader } from "../shared/traders.ts";
import { encodeCursor, resumeAfter } from "../shared/cursor.ts";
import { trustHoldings, trustBody } from "../shared/trust-core.ts";
import { linkedBody, linkedRows, walletRows, walletsBody } from "../shared/wallets-core.ts";
import { scorecardRows, FeeWindows, feesFor, Swap, swapsFor, chainEntriesFrom, chainExitsFrom, monthStartCapital, scorecardBody, latestLoad } from "../shared/scorecard-core.ts";
import { pnlAgg, pnlBody } from "../shared/pnl-core.ts";

get("/v1/traders/:handle/trust", async ({ handle }) => {
  const [t] = await sql`
    select t.handle, t.display_handle, t.name, s.pnl_usd, s.volume_usd, s.trade_count
    from traders t left join trader_stats_current s using (handle)
    where t.handle = ${await resolveTrader(handle)}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);
  const [h, asOf] = await Promise.all([
    trustHoldings([t.handle as string]).then((r: Record<string, unknown>[]) => r[0]),
    asOfHoldings(),
  ]);
  return trustBody(t, h, asOf);
});


const INCLUDES = ["pnl", "scorecard", "wallets", "trust"] as const;
/**
 * A page that asks for includes is bounded; the plain list is NOT (the consumer's hourly
 * directory sync is `?limit=500`, one call — docs/consumer/Field_Contracts.md §0). The bound is
 * about cost, not binds: each include is one statement over the whole page, and the scorecard
 * one returns every trade of every trader on it.
 */
const INCLUDE_PAGE_MAX = 200;
/** The page a request with `include` gets when it names no `limit`. */
const INCLUDE_PAGE_DEFAULT = 100;
/** Below this, a page where nobody has trades is a search or a trader added last night, not a fault (D097). */
const INCLUDE_FAULT_MIN_PAGE = 25;
type Include = typeof INCLUDES[number];

/*
 * The plain list is the same for every caller and is what the app falls back to when the includes
 * fail (its report of 18 Sep, ask 4.2: "keep it serving while the database is down"). Through the
 * cache an isolate that has answered it once keeps answering it — expired — when D1 throws or stalls.
 * Pages WITH includes are not cached: 1 MB bodies, per-page keys, and wallets must not be stale.
 */
const plainList = ttlCache<unknown>(60_000);

get("/v1/traders", (_p, url) =>
  (url.searchParams.get("include") ?? "").trim()
    ? listTraders(url)
    : plainList(urlKey(url), () => listTraders(url)));

async function listTraders(url: URL): Promise<unknown> {
  const q = (url.searchParams.get("q") ?? "").trim().replace(/^@/, "").toLowerCase();
  const asked = intParam(url, "limit", { min: 1, fallback: null });
  const offset = intParam(url, "offset", { min: 0, fallback: 0 }) ?? 0;

  // Unknown values are rejected rather than ignored, for the same reason BUG-3 made
  // `?limit=abc` a 400: silently dropping a parameter the caller believed in is how you get
  // a consumer who thinks they have data they do not.
  const includeRaw = (url.searchParams.get("include") ?? "").trim();
  const include: Include[] = [];
  if (includeRaw) {
    for (const part of includeRaw.split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!(INCLUDES as readonly string[]).includes(part)) {
        throw badRequest(`unknown include '${part}'`, { valid: INCLUDES });
      }
      if (!include.includes(part as Include)) include.push(part as Include);
    }
  }
  /*
   * With includes: INCLUDE_PAGE_DEFAULT when no limit is named, never more than INCLUDE_PAGE_MAX.
   * `?include=…` with no limit meant every include over all 448 traders — and answered 500 for as
   * long as the D1 port existed, so no consumer can be depending on it. `total` and `nextCursor`
   * say there is more.
   */
  const limit = include.length ? Math.min(asked ?? INCLUDE_PAGE_DEFAULT, INCLUDE_PAGE_MAX) : asked;

  /**
   * Incremental sync. Without it a consumer re-pulls the whole directory every hour forever;
   * with it an hourly job moves only what actually changed, which is what keeps this fixed as
   * the directory grows rather than just making today's sync fast.
   */
  /** DELISTED TRADERS ARE NOT LISTED, and are still answerable by name. See docs/DECISIONS.md#d093 */
  const includeDelisted = url.searchParams.get("includeDelisted") === "true";

  const sinceRaw = url.searchParams.get("updatedSince");
  let sinceMs: number | null = null;
  if (sinceRaw) {
    sinceMs = Date.parse(sinceRaw);
    if (!Number.isFinite(sinceMs)) {
      throw badRequest("updatedSince must be an ISO-8601 timestamp", { got: sinceRaw });
    }
  }

  // Ranked by the leaderboard's own `rank`, and search scores exact > prefix > substring so
  // it matches the Node implementation rather than relying on Postgres text ranking.
  /** T1.5. See docs/DECISIONS.md#d094 */
  const TRADER_SORTS = ["rank", "pnl", "volume", "trades", "followers", "updated"] as const;
  const sort = sortParam(url, TRADER_SORTS, "rank", ["rank"]);
  const minPnl = numParam(url, "minPnl"), maxPnl = numParam(url, "maxPnl");
  const minVolume = numParam(url, "minVolume"), maxVolume = numParam(url, "maxVolume");
  const minTrades = numParam(url, "minTrades");
  const minFollowers = numParam(url, "minFollowers");

  const dir = sort.desc ? sql`desc` : sql`asc`;
  const sortCol = sort.key === "rank"
    ? sql`s.rank`
    : sort.key === "pnl"
    ? sql`s.pnl_usd`
    : sort.key === "volume"
    ? sql`s.volume_usd`
    : sort.key === "trades"
    ? sql`s.trade_count`
    : sort.key === "followers"
    ? sql`s.followers`
    : sql`s.captured_at`;

  /* The build row is independent of the list, so the two share one round trip. */
  // `= {}`: a database with no build yet answers `window: null`, not a TypeError.
  const [rows, [{ window_label, captured } = {} as Record<string, unknown>]] = await Promise.all([sql`
    select t.handle, t.id, t.display_handle, t.name, t.avatar, t.last_seen_at, t.source,
           s.rank, s.pnl_usd, s.volume_usd, s.followers, s.trade_count, s.captured_at,
           ld.load_attempted_at, ld.load_outcome,
           case
             when ${q} = '' then 0
             when lower(t.display_handle) = ${q} or lower(coalesce(t.name,'')) = ${q} then 0
             when lower(t.display_handle) like ${q + "%"} or lower(coalesce(t.name,'')) like ${q + "%"} then 1
             else 2
           end as score
    from traders t
    -- The newest stats row by two seeks on (handle, captured_at): joined to every trader, the
    -- trader_stats_current view windows all of trader_stats before the join can narrow it.
    -- The unary + keeps traders the outer loop: a range filter on s makes this an inner join,
    -- which the planner would otherwise drive from a scan of trader_stats.
    left join trader_stats s on s.handle = +t.handle
     and s.captured_at = (select max(captured_at) from trader_stats where handle = t.handle)
    ${latestLoad()}
    where (${includeDelisted} or t.listed)
      and (${q} = '' or lower(t.display_handle) like ${"%" + q + "%"}
                     or lower(coalesce(t.name,'')) like ${"%" + q + "%"})
      ${minPnl === null ? sql`` : sql`and s.pnl_usd >= ${minPnl}`}
      ${maxPnl === null ? sql`` : sql`and s.pnl_usd <= ${maxPnl}`}
      ${minVolume === null ? sql`` : sql`and s.volume_usd >= ${minVolume}`}
      ${maxVolume === null ? sql`` : sql`and s.volume_usd <= ${maxVolume}`}
      ${minTrades === null ? sql`` : sql`and s.trade_count >= ${minTrades}`}
      ${minFollowers === null ? sql`` : sql`and s.followers >= ${minFollowers}`}
    -- Search relevance outranks the chosen metric: when a caller passes a query they want
    -- matches first, and a best-match trader buried under the highest-volume one is not a
    -- search result. With no query every row scores 0 and this term drops out.
    --
    -- Handle is the tiebreak, and it is not cosmetic: 37 of 137 traders have no stats row,
    -- so rank is NULL for all of them and they tied as one undifferentiated block. The
    -- order within that block was whatever the planner produced, which meant an offset
    -- could already skip or repeat rows across two calls. A cursor over a non-total order
    -- would do the same thing silently, so it stays on the end of EVERY sort, unreversed.
    order by score, ${sortCol} ${dir} nulls last, t.handle`, sql`
    select window_label, cast(strftime('%s', captured_at) as integer) as captured
    from builds order by captured_at desc limit 1`]);

  /** A range filter over a nullable column drops rows where the value is UNKNOWN, not just rows… See docs/DECISIONS.md#d095 */
  const anyFilter = [minPnl, maxPnl, minVolume, maxVolume, minTrades, minFollowers]
    .some((v) => v !== null);
  const unratedCount = anyFilter
    ? Number(
      (await sql`
        select count(*) as n from traders t
        where not exists (select 1 from trader_stats s where s.handle = t.handle)`)[0].n,
    )
    : 0;

  /** Applied before paging, so `offset` walks the filtered set rather than the full board. See docs/DECISIONS.md#d096 */
  const visible = sinceMs === null ? rows : rows.filter((r: Record<string, unknown>) =>
    r.captured_at === null || r.captured_at === undefined ||
    Date.parse(String(r.captured_at)) > sinceMs!);

  /**
   * A cursor wins over an offset when both are sent: the caller who supplies a cursor is
   * mid-sync, and quietly honouring a stale default offset instead would corrupt exactly the
   * flow the cursor exists to protect.
   */
  const cursor = url.searchParams.get("cursor");
  const start = cursor
    ? resumeAfter(visible, cursor, (r: Record<string, unknown>) => String(r.handle))
    : offset;
  const page = limit === null ? visible.slice(start) : visible.slice(start, start + limit);
  const last = page[page.length - 1];
  const nextCursor = last && start + page.length < visible.length
    ? encodeCursor([String(last.handle)])
    : null;

  /**
   * One query per include, for the whole page, all in flight together.
   *
   * `any($handles)` is what makes this a bulk route rather than a loop wearing one's coat.
   */
  const handles = page.map((r: Record<string, unknown>) => r.handle as string);
  const wantsScorecard = include.includes("scorecard");
  /* Every read below is independent of the others, so they overlap: each awaited alone cost a round trip to D1. */
  const [pnlRows, scRows, wRows, trRows, swapBy, holdingsAsOf, knownChainsBy, feesBy, startCapBy] = handles.length
    ? await Promise.all([
      include.includes("pnl") ? pnlAgg(handles) : Promise.resolve([]),
      wantsScorecard ? scorecardRows(handles) : Promise.resolve([]),
      include.includes("wallets") ? walletRows(handles) : Promise.resolve([]),
      include.includes("trust") ? trustHoldings(handles) : Promise.resolve([]),
      // Axes 5 and 2. One query for every swap on the page, from which the entry price, the
      // exit P&L and the individual buys are all derived -- see `swapsFor`.
      wantsScorecard ? swapsFor(handles) : Promise.resolve(new Map<string, Swap[]>()),
      // One global value shared by every trader's trust block, fetched once.
      include.includes("trust") ? asOfHoldings() : Promise.resolve(null),
      /** One query for the page, not one per trader — same rule as every other include. */
      include.includes("wallets") ? knownChainsFor(handles) : Promise.resolve(new Map<string, KnownChain[]>()),
      /** Same rule for fees: one read of the daily buckets for the whole page. */
      wantsScorecard ? nativePrices().then((nat) => feesFor(handles, nat)) : Promise.resolve(new Map<string, FeeWindows>()),
      /** Month-start balances for the whole page in ONE query, not one per trader. */
      wantsScorecard ? monthStartCapital(handles) : Promise.resolve(new Map<string, Map<string, number>>()),
    ])
    : [[], [], [], [], new Map<string, Swap[]>(), null, new Map<string, KnownChain[]>(),
      new Map<string, FeeWindows>(), new Map<string, Map<string, number>>()];

  // deno-lint-ignore no-explicit-any
  const byHandle = <T extends { handle: unknown }>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of list) {
      const k = String(r.handle);
      const cur = m.get(k);
      if (cur) cur.push(r); else m.set(k, [r]);
    }
    return m;
  };
  // deno-lint-ignore no-explicit-any
  const pnlBy = byHandle(pnlRows as any[]);
  // deno-lint-ignore no-explicit-any
  const scBy = byHandle(scRows as any[]);
  // deno-lint-ignore no-explicit-any
  const wBy = byHandle(wRows as any[]);
  // deno-lint-ignore no-explicit-any
  const trBy = byHandle(trRows as any[]);
  /** A requested include that produced NOTHING is a failure, not an empty truth. See docs/DECISIONS.md#d097 */
  if (page.length >= INCLUDE_FAULT_MIN_PAGE) {
    const empty: string[] = [];
    if (include.includes("wallets") && wRows.length === 0) empty.push("wallets");
    if (include.includes("pnl") && pnlRows.length === 0) empty.push("pnl");
    if (include.includes("scorecard") && scRows.length === 0) empty.push("scorecard");
    if (empty.length) throw includeUnavailable(empty);
  }


  /** Sub-resources are nested under `included`, NOT spread onto the entry. See docs/DECISIONS.md#d098 */
  // deno-lint-ignore no-explicit-any
  const attach = async (r: any) => {
    const h = String(r.handle);
    const out: Record<string, unknown> = {};
    if (include.includes("pnl")) out.pnl = pnlBody(r, pnlBy.get(h)?.[0]);
    if (include.includes("wallets")) {
      const w = wBy.get(h)?.[0];
      out.wallets = w ? walletsBody(w, knownChainsBy.get(h) ?? []) : null;
    }
    if (include.includes("trust")) out.trust = trustBody(r, trBy.get(h)?.[0], holdingsAsOf);
    if (include.includes("scorecard")) {
      const rows = scBy.get(h) ?? [];
      /**
       * `tokens: 0` on purpose. `byToken[]` is 98% of a scorecard's bytes — 185KB against
       * 3KB without it — so 137 full scorecards would be a 24MB response. `tokensTotal`
       * still reports the real count, so a consumer knows what is there and can fetch the
       * single-trader route for the tokens of whoever they care about.
       */
      out.scorecard = rows.length
        ? await scorecardBody(r, rows, 0, {
            entries: chainEntriesFrom(swapBy.get(h) ?? []),
            exits: chainExitsFrom(swapBy.get(h) ?? [],
                                  chainEntriesFrom(swapBy.get(h) ?? [])),
          }, feesBy.get(h) ?? null, null, startCapBy.get(h) ?? null)
        : null;
    }
    return out;
  };

  const extras = include.length ? await Promise.all(page.map(attach)) : [];

  return {
    board: "traders",
    window: window_label ?? null,
    /** ISO-8601, not the epoch integer this used to be. See docs/DECISIONS.md#d099 */
    capturedAt: captured ? new Date(Number(captured) * 1000).toISOString() : null,
    /** @deprecated The epoch form. Read `capturedAt`; this is here so old parsers survive. */
    capturedAtEpoch: captured ? Number(captured) : null,
    count: page.length,
    ...(include.length
      ? {
        include,
        includeNote: "each sub-resource comes from one set-based query for the whole page " +
          "and appears under `entries[].included`. It is nested rather than spread because " +
          "`entries[].pnl` is fomo's reported figure while `included.pnl` is computed from " +
          "stored trades, and the two must not share a key. `included.scorecard.byToken` is " +
          "empty here (see its `tokensTotal`); /traders/:handle/scorecard serves it in full.",
      }
      : {}),
    ...(sinceMs !== null
      ? {
        updatedSince: new Date(sinceMs).toISOString(),
        matched: visible.length,
        updatedSinceNote: "traders with no recorded refresh time are always returned — " +
          "unknown freshness cannot prove nothing changed, and silently omitting them " +
          "would hide them from every incremental sync",
      }
      : {}),
    // Present only when something was cut. A `total` equal to `count` says nothing and the
    // Node route omits it, so emitting it unconditionally is a difference, not a courtesy.
    ...(page.length < visible.length ? { total: visible.length } : {}),
    /**
     * `null` means this is the last page. Feed it back as `?cursor=` to continue; do not
     * mix it with `?offset=`, and do not build one by hand.
     */
    nextCursor,
    ...(anyFilter
      ? {
        filters: {
          applied: Object.fromEntries(
            Object.entries({ minPnl, maxPnl, minVolume, maxVolume, minTrades, minFollowers })
              .filter(([, v]) => v !== null),
          ),
          excludedForMissingValue: unratedCount,
          note: unratedCount > 0
            ? `${unratedCount} trader(s) have no stats row, so no range filter can evaluate ` +
              `them and they are absent from this result — that is not the same as failing ` +
              `the filter`
            : "every trader has a stats row, so nothing was excluded for a missing value",
        },
      }
      : {}),
    ...(url.searchParams.has("orderBy") || url.searchParams.has("direction")
      ? { orderBy: sort.key, direction: sort.desc ? "desc" : "asc" }
      : {}),
    entries: page.map((r: Record<string, unknown>, i: number) => ({
      rank: r.rank ?? null,
      // Ours, generated once, never reissued. `handle` comes from fomo and is theirs to
      // change; anything keying rows on it loses the trader the day they rename.
      id: r.id,
      // Per-trader freshness. The envelope's `capturedAt` covers the whole board, so it
      // cannot distinguish a trader refreshed a minute ago from one refreshed yesterday.
      updatedAt: r.captured_at ? new Date(String(r.captured_at)).toISOString() : null,
      lastSeenAt: r.last_seen_at ? new Date(String(r.last_seen_at)).toISOString() : null,
      handle: r.display_handle,
      label: r.name ?? null,
      // Empty string is not a URL. The column stores '' where fomo gave nothing, and the
      // Node route passes it through `nonEmpty`, so this has to as well.
      avatarUrl: nonEmpty(r.avatar as string | null),
      /** WHERE THIS TRADER CAME FROM. See docs/DECISIONS.md#d100 */
      source: r.source ?? null,
      pnl: n(r.pnl_usd),
      volume: n(r.volume_usd),
      followers: r.followers ?? null,
      numTrades: r.trade_count ?? null,
      memberCount: null, marketCap: null, price: null, liquidity: null,
      ...(include.length ? { included: extras[i] } : {}),
    })),
  };
}

// ------------------------------------------------------------ one trader

/**
 * A single trader, without picking a sub-resource first.
 *
 * `/v1/traders/:handle` returned 404 because only the sub-routes existed — the natural
 * first URL anyone tries was the one thing missing. This is a summary plus links, so the
 * response says what else can be asked about them rather than leaving it to be guessed.
 */
get("/v1/traders/:handle", async ({ handle }, url) => {
  const h = await resolveTrader(handle);
  const [t] = await sql`
    select t.handle, t.id, t.display_handle, t.name, t.avatar, t.bio, t.twitter, t.verified,
           t.listed, t.delisted_at, t.delisted_reason,
           t.last_seen_at, t.source, s.captured_at,
           s.rank, s.pnl_usd, s.volume_usd, s.trade_count, s.followers,
           w.evm_address, w.sol_address
    from traders t
    left join trader_stats_current s using (handle)
    left join wallets w using (handle)
    where t.handle = ${h}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const addrs = [t.evm_address, t.sol_address]
    .filter((a): a is string => !!a).map((a) => a.toLowerCase());
  const [[act], daily] = addrs.length
    ? await Promise.all([walletActivity(addrs), dailyTradeCounts(addrs)])
    : [[undefined], []];

  const [c] = await sql`
    select (select count(*) from holdings_current where handle = ${h})  as positions,
           (select count(*) from trades   where handle = ${h})          as trades,
           (select count(*) from transactions
             where address_key in (${[t.evm_address, t.sol_address]
               .filter((a): a is string => !!a).map((a) => a.toLowerCase())})) as transfers`;

  return {
    // Stable across a fomo rename; `handle` is not guaranteed to be.
    id: t.id,
    handle: t.display_handle,
    name: t.name ?? null,
    rank: t.rank ?? null,
    verified: !!t.verified,
    /** IS THIS TRADER STILL ON THE BOARD, and if not, why. See docs/DECISIONS.md#d101 */
    listed: bool(t.listed) !== false,
    ...(bool(t.listed) === false
      ? {
        delisted: {
          at: t.delisted_at ? new Date(String(t.delisted_at)).toISOString() : null,
          reason: (t.delisted_reason as string) ?? null,
          note: "removed from the directory listing, not from the database",
        },
      }
      : {}),
    /** Which directory this trader came from. See the note on `source` in `GET /v1/traders`. */
    source: t.source ?? null,
    updatedAt: t.captured_at ? new Date(String(t.captured_at)).toISOString() : null,
    /**
     * The same value as `updatedAt`, under the name every other route uses for it. Both are
     * kept: `updatedAt` is what consumers already read here, `asOf` is what they read
     * everywhere else, and a profile should not be the one route that spells it differently.
     */
    asOf: t.captured_at ? new Date(String(t.captured_at)).toISOString() : null,
    bio: nonEmpty(t.bio as string | null),
    profilePicture: nonEmpty(t.avatar as string | null),
    twitter: nonEmpty(t.twitter as string | null),
    // REPORTED figures, straight from the leaderboard. 44 of 100 traders claim a profit
    // larger than their entire lifetime volume — see /trust before trusting these.
    reported: {
      pnlUsd: n(t.pnl_usd), volumeUsd: n(t.volume_usd),
      trades: t.trade_count ?? null, followers: t.followers ?? null,
    },
    wallets: { evm: t.evm_address ?? null, solana: t.sol_address ?? null },
    /**
     * T1.2. What these wallets have actually done on chain, as opposed to what fomo reports.
     *
     * This sits beside `reported` deliberately: `reported.numTrades` is fomo's count and
     * `onChain.transactions` is ours, from transfers we ingested ourselves. They will not
     * match — different definitions, different windows — and seeing both is the point.
     */
    onChain: act
      ? {
        transactions: Number(act.transactions),
        /** O1. Chains present in `transactions` for these wallets; all-zeros elsewhere means "not covered". */
        /* json_group_array returns JSON text; a null chain (no chains row) is dropped here. */
        chainsCovered: (JSON.parse(String(act.chains_covered ?? "[]")) as unknown[])
          .filter((c): c is string => typeof c === "string"),
        transfers: Number(act.transfers),
        inbound: Number(act.inbound),
        outbound: Number(act.outbound),
        /**
         * W2 (v5 fixes, 17 Sep 2026). `swaps` IS GONE; THESE TWO REPLACE IT.
         *
         * It counted every transfer leg the provider labelled SWAP that this wallet appears
         * in — so one trade counted several times, AND a trade someone else made counted too
         * whenever this wallet merely received tokens inside it. Measured on a random sample,
         * 5 in 6 of a wallet's swap appearances are that. One trader read 1,260 here while
         * `/trades` returned six, and nothing said the two counted different things.
         *
         * `swapsAppearedIn` is the upper bound: distinct transactions labelled SWAP that
         * touched this wallet at all. `ownSwaps` is what we RESOLVED as his own trade, the
         * same store `/traders/:handle/trades` serves, and it is the honest trade count.
         */
        swapsAppearedIn: Number(act.swaps_appeared_in),
        ownSwaps: Number(act.own_swaps ?? 0),
        tokensTouched: Number(act.tokens_touched),
        activeDays: Number(act.active_days),
        /**
         * Axis 6. 1.0 = the same number of trades every active day; toward 0 = it all
         * happened in a burst. `null` under two active days, where the measure has nothing
         * to compare.
         */
        evenness: evennessOf(daily.map((d: Record<string, unknown>) => Number(d.trades))),
        tradesPerActiveDay: daily.length
          ? Number((daily.reduce((a: number, d: Record<string, unknown>) => a + Number(d.trades), 0) / daily.length).toFixed(2))
          : null,
        /**
         * The series the evenness came from, so it can be recomputed or replotted — behind
         * `?dailyTrades=true` because it grows with a wallet's lifetime (59 rows here, and
         * unbounded for an old one) while almost every caller only wants the coefficient.
         * The 306ms group-by runs either way; this is about payload, not time.
         */
        ...(url.searchParams.get("dailyTrades") === "true"
          ? {
            dailyTrades: daily.map((d: Record<string, unknown>) => ({
          // postgres.js returns a Date, whose toString is "Fri Jul 03 2026 …" — slicing that
          // yields "Fri Jul 03", not a date. Same trap that put firstEntryPrice on the wrong
          // leg earlier; formatted through toISOString instead.
              day: new Date(String(d.day)).toISOString().slice(0, 10),
              trades: Number(d.trades),
            })),
          }
          : { dailyTradesAvailable: daily.length }),
        firstSeenAt: act.first_at ? new Date(String(act.first_at)).toISOString() : null,
        lastActiveAt: act.last_at ? new Date(String(act.last_at)).toISOString() : null,
        tier: "verified",
        source: "d1 · transactions (helius webhook)",
        note: "counted from transfers we ingested, not from fomo's figures — and only from " +
              "the date on-chain ingestion began, so these are floors for older wallets",
      }
      : null,
    stored: {
      positions: Number(c.positions), trades: Number(c.trades), transfers: Number(c.transfers),
    },
    links: {
      pnl: `/v1/traders/${t.display_handle}/pnl`,
      scorecard: `/v1/traders/${t.display_handle}/scorecard`,
      portfolio: `/v1/traders/${t.display_handle}/portfolio`,
      positions: `/v1/traders/${t.display_handle}/positions`,
      trust: `/v1/traders/${t.display_handle}/trust`,
      wallets: `/v1/traders/${t.display_handle}/wallets`,
      transactions: `/v1/traders/${t.display_handle}/transactions`,
      events: `/v1/events?handle=${t.display_handle}`,
    },
  };
});


/** T1.2. See docs/DECISIONS.md#d102 */
/** Axis 6's evenness input: how many trades on each active day. See docs/DECISIONS.md#d103 */
const dailyTradeCounts = (addrs: string[]) => sql`
  -- date_trunc('day', t)::date is the date half of the ISO text.
  select substr(block_time, 1, 10) as day, count(*) as trades
  from transactions
  where address_key in (${addrs}) and block_time is not null
  group by 1 order by 1`;

/** Gini over trades-per-day, expressed as evenness (1 − gini). See docs/DECISIONS.md#d104 */
function evennessOf(counts: number[]): number | null {
  const xs = counts.filter((x) => x > 0).sort((a, b) => a - b);
  const n = xs.length;
  if (n < 2) return null;
  const total = xs.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let weighted = 0;
  for (let i = 0; i < n; i++) weighted += (i + 1) * xs[i];
  const gini = (2 * weighted) / (n * total) - (n + 1) / n;
  return Number((1 - Math.max(0, Math.min(1, gini))).toFixed(4));
}

const walletActivity = (addrs: string[]) => sql`
  select count(*)                                                  as transfers,
         count(case when direction = 'in'  then 1 end)             as inbound,
         count(case when direction = 'out' then 1 end)             as outbound,
         -- W2 (v5 fixes): DISTINCT transactions, not transfer legs. 'swaps' counted legs, so
         -- one swap contributing four transfers counted four times.
         count(distinct case when tx_type = 'SWAP' then tx_hash end) as swaps_appeared_in,
         count(distinct tx_hash)                                   as transactions,
         count(distinct substr(block_time, 1, 10))                 as active_days,
         count(distinct token_key)                                 as tokens_touched,
         min(block_time)                                           as first_at,
         max(block_time)                                           as last_at,
         -- O1: which chains the counts above actually cover.
         json_group_array(distinct c.name) as chains_covered,
         -- W2: the wallet's OWN resolved trades, the store /trades reads.
         (select count(*) from wallet_swaps ws where ws.address_key in (${addrs})) as own_swaps
  from transactions x left join chains c using (network_id)
  where x.address_key in (${addrs})`;


/** Wallets, each with its FAMILY and the chains it has actually been seen on. See docs/DECISIONS.md#d105 */
/** A3 — accept a wallet for a trader we already list. See docs/DECISIONS.md#d106 */
const walletSubmitSecret = () => (cfg("WALLET_SUBMIT_SECRET") ?? "").trim();
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
/** base58, no 0/O/I/l. Solana addresses are 32-44 of these. */
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;


post("/v1/traders/:handle/wallets", async ({ handle }, _url, body) => {
  /*
   * A write is not open the way the reads are. Unset means misconfigured, and refusing is the
   * safe reading of that -- an open write route is worse than an absent one.
   */
  if (!walletSubmitSecret()) {
    throw new ApiError(503, "not_configured",
      "wallet submission is not enabled on this deployment", {});
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (String(b.secret ?? "") !== walletSubmitSecret()) {
    throw new ApiError(401, "unauthorized", "a valid `secret` is required to submit a wallet", {});
  }

  const h = await resolveTrader(handle);
  const [t] = await sql`select handle, display_handle from traders where handle = ${h}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const evm = typeof b.evmAddress === "string" ? b.evmAddress.trim() : null;
  const sol = typeof b.solanaAddress === "string" ? b.solanaAddress.trim() : null;
  if (!evm && !sol) {
    throw badRequest("send `evmAddress`, `solanaAddress`, or both", { parameter: "evmAddress" });
  }
  if (evm && !EVM_RE.test(evm)) {
    throw new ApiError(400, "invalid_address",
      `'${evm}' is not a 20-byte hex address`, { parameter: "evmAddress" });
  }
  if (sol && !SOL_RE.test(sol)) {
    throw new ApiError(400, "invalid_address",
      `'${sol}' is not a base58 Solana address`, { parameter: "solanaAddress" });
  }

  /** IS THIS ADDRESS ALREADY SOMEBODY ELSE'S? See docs/DECISIONS.md#d107 */
  const clashes = await sql`
    select handle, display_handle,
           case when lower(evm_address) = ${evm ? evm.toLowerCase() : null} then 'evm' else 'solana' end as family
    from wallets w join traders using (handle)
    where handle <> ${h}
      and (lower(evm_address) = ${evm ? evm.toLowerCase() : null}
           or sol_address = ${sol})`;
  if (clashes.length) {
    const c = clashes[0];
    throw new ApiError(409, "address_in_use",
      `that address is already on record for '${c.display_handle}'`,
      { heldBy: String(c.display_handle), family: String(c.family) });
  }

  const [existing] = await sql`
    select evm_address, sol_address from wallets where handle = ${h}`;
  if (evm && existing?.evm_address) {
    throw new ApiError(409, "already_on_record",
      "this trader already has an EVM address; it is not overwritten by a submission",
      { family: "evm", current: String(existing.evm_address) });
  }
  if (sol && existing?.sol_address) {
    throw new ApiError(409, "already_on_record",
      "this trader already has a Solana address; it is not overwritten by a submission",
      { family: "solana", current: String(existing.sol_address) });
  }

  /*
   * `source: "submitted"` and `confidence: "reported"`, never `verified`. `verified_at` stays
   * null because nothing here proved the address belongs to this person -- it was asserted.
   * The distinction travels with every figure the address later produces.
   */
  await sql`
    -- evm_address_key / sol_address_key are generated stored columns here: SQLite refuses
    -- both an insert into them and an update of them, and follows evm_address / sol_address.
    insert into wallets (handle, evm_address, evm_source, evm_confidence,
                         sol_address, sol_source, sol_confidence,
                         first_seen_at, last_seen_at)
    values (${h},
            ${evm}, ${evm ? "submitted" : null}, ${evm ? "reported" : null},
            ${sol}, ${sol ? "submitted" : null}, ${sol ? "reported" : null},
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    on conflict (handle) do update set
      evm_address     = coalesce(wallets.evm_address, excluded.evm_address),
      evm_source      = coalesce(wallets.evm_source, excluded.evm_source),
      evm_confidence  = coalesce(wallets.evm_confidence, excluded.evm_confidence),
      sol_address     = coalesce(wallets.sol_address, excluded.sol_address),
      sol_source      = coalesce(wallets.sol_source, excluded.sol_source),
      sol_confidence  = coalesce(wallets.sol_confidence, excluded.sol_confidence),
      last_seen_at    = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

  const [now] = await sql`
    select evm_address, sol_address, evm_source, sol_source, evm_confidence, sol_confidence
    from wallets where handle = ${h}`;

  return {
    handle: t.display_handle,
    accepted: { evmAddress: evm, solanaAddress: sol },
    onRecord: {
      evmAddress: now?.evm_address ?? null,
      solanaAddress: now?.sol_address ?? null,
      evmSource: now?.evm_source ?? null,
      solanaSource: now?.sol_source ?? null,
      evmConfidence: now?.evm_confidence ?? null,
      solanaConfidence: now?.sol_confidence ?? null,
    },
    /**
     * WHEN THIS TURNS INTO A BALANCE. The sampler picks a trader up by age, so a new wallet
     * is read on the next rotation; asking for his AUM reads it immediately, because that
     * route fetches live when the stored reading is stale and there is no stored reading yet.
     */
    pricing: {
      state: "pending_first_read",
      readsOn: `/v1/traders/${t.display_handle}/aum`,
      note: "the next balance read prices it; ask for his aum to force one now",
    },
    tier: "reported",
    plain: "Accepted as a claim, not a verified fact — stored with source 'submitted' and " +
           "confidence 'reported', so every figure derived from it says so.",
  };
});

get("/v1/traders/:handle/wallets", async ({ handle }) => {
  const h = await resolveTrader(handle);
  const [t] = await walletRows([h]);
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const [presence, knownBy, linked] = await Promise.all([
    sql`select chain, network_id, trades_seen, last_active_at
        from wallet_chain_presence where handle = ${h} order by trades_seen desc`,
    knownChainsFor([h]),
    linkedRows(h),
  ]);

  const seen = presence.map((p: any) => ({
    chain: p.chain as string,
    networkId: Number(p.network_id),
    tradesSeen: Number(p.trades_seen),
    lastActiveAt: p.last_active_at ? new Date(String(p.last_active_at)).toISOString() : null,
  }));
  const SOLANA = 1399811149;

  const wallets = [];
  if (t.sol_address) {
    wallets.push({
      address: t.sol_address as string,
      family: "solana",
      source: t.sol_source ?? null,
      chains: seen.filter((c: { networkId: number }) => c.networkId === SOLANA),
    });
  }
  if (t.evm_address) {
    wallets.push({
      address: t.evm_address as string,
      family: "evm",
      source: t.evm_source ?? null,
      chains: seen.filter((c: { networkId: number }) => c.networkId !== SOLANA),
    });
  }

  return {
    ...walletsBody(t, knownBy.get(h) ?? []),
    /** The stable key. See docs/DECISIONS.md#d108 */
    id: t.id ?? null,
    /** Which directory this trader came from. See `GET /v1/traders`. */
    source: t.source ?? null,
    /** When this wallet record was last confirmed. See the note on `asOf` in the aum route. */
    asOf: t.last_seen_at ? new Date(String(t.last_seen_at)).toISOString() : null,
    /** When the display handle last changed; a consumer can notice a rename. */
    handleChangedAt: t.handle_changed_at
      ? new Date(String(t.handle_changed_at)).toISOString() : null,
    /**
     * `[]` for a trader we hold no wallet for -- 3 of 435 today. An empty list is the
     * correct answer to "which wallets", not an error: they are registered, we simply
     * have no address.
     */
    wallets,
    /** Gap 5b. Wallets he funded from a known one; `[]` when none has been linked. */
    linked: linked.map(linkedBody),
    /** A wallet with no observed chain says so rather than implying it is idle. */
    presence: wallets.every((w) => w.chains.length === 0) && wallets.length
      ? "not_yet_scanned" : "observed",
  };
});
