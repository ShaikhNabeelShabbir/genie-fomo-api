import { sql, n, round } from "../db.ts";
import { get } from "../router.ts";
import { notFound, badRequest } from "../errors.ts";
import { asOfHoldings, asOfToken } from "../shared/asof.ts";
import { intParam, numParam, sortParam, nonEmpty } from "../shared/params.ts";
import { bool, cov, fromJson, money } from "../shared/format.ts";
import { chainWhere } from "../shared/chains.ts";
import { encodeCursor, resumeAfter } from "../shared/cursor.ts";
import { ledgerBody } from "../shared/creators-core.ts";
import { exitTimingScoreFrom } from "../shared/scorecard-core.ts";

// ------------------------------------------------------- K1/K3/K4/K9 board

get("/v1/tokens", async (_p, url) => {
  const chainQ = (url.searchParams.get("chain") ?? "").trim().toLowerCase() || null;
  const net = await chainWhere(chainQ);
  const minHolders = intParam(url, "minHolders", { min: 1, fallback: 1 }) ?? 1;

  /** T1.5. See docs/DECISIONS.md#d080 */
  // T3d adds three: a board that carries market cap and liquidity but cannot sort on them is
  // only half a board. `chainHolders` is GMGN's count across every holder, distinct from
  // `holders`, which counts the leaders WE track.
  const TOKEN_SORTS = [
    "holders", "value", "priced", "marketCap", "liquidity", "chainHolders",
    "smartWallets", "renownedWallets",
  ] as const;
  const tokenSort = sortParam(url, TOKEN_SORTS, "holders");
  const tokenDir = tokenSort.desc ? sql`desc` : sql`asc`;
  const tokenSortCol = tokenSort.key === "holders"
    ? sql`count(distinct h.handle)`
    : tokenSort.key === "priced"
    ? sql`count(case when h.value > 0 then h.value end)`
    : tokenSort.key === "marketCap"
    ? sql`max(ti.market_cap_usd)`
    : tokenSort.key === "liquidity"
    ? sql`max(ti.liquidity_usd)`
    : tokenSort.key === "chainHolders"
    ? sql`max(ti.holder_count)`
    : tokenSort.key === "smartWallets"
    ? sql`max(cast(json_extract(ti.raw, '$.wallet_tags_stat.smart_wallets') as integer))`
    : tokenSort.key === "renownedWallets"
    ? sql`max(cast(json_extract(ti.raw, '$.wallet_tags_stat.renowned_wallets') as integer))`
    : sql`coalesce(sum(case when h.value > 0 then h.value end), 0)`;
  const minValue = numParam(url, "minValue"), maxValue = numParam(url, "maxValue");
  const minMarketCap = numParam(url, "minMarketCap"), maxMarketCap = numParam(url, "maxMarketCap");
  const minLiquidity = numParam(url, "minLiquidity");

  /** T3a. See docs/DECISIONS.md#d081 */
  const excludeHoneypots = url.searchParams.get("excludeHoneypots") === "true";


  const [{ traders: traderCount }] = await sql`select count(*) as traders from traders`;

  // Quote assets are excluded and it is NOT optional: 85 of 100 leaders "hold" USDC, so
  // leaving them in makes the top of the board the currency rather than a trade.
  const rows = await sql`
    select h.network_id, c.name as chain, tk.address,
           max(ti.price_usd)      as price_usd,
           max(ti.market_cap_usd) as market_cap_usd,
           max(ti.liquidity_usd)  as liquidity_usd,
           max(ti.holder_count)   as holder_count,
           max(ti.logo_url)       as logo_url,
           max(ti.fetched_at)     as info_fetched_at,
           -- T3e on the board. Only the two tags worth scanning a list by; the rest are on
           -- the token detail route with the cap disclosure attached.
           max(cast(json_extract(ti.raw, '$.wallet_tags_stat.smart_wallets') as integer))    as smart_wallets,
           max(cast(json_extract(ti.raw, '$.wallet_tags_stat.renowned_wallets') as integer)) as renowned_wallets,
           -- T3a on the board. A honeypot flag is worthless on a detail page nobody opens
           -- before acting; it has to be visible where the scanning happens.
           -- bool_or over 0/1 columns is max(), which ignores the NULL = not assessed rows.
           max(ti.is_honeypot)          as is_honeypot,
           max(ti.can_not_sell)         as can_not_sell,
           max(ti.sell_tax)             as sell_tax,
           max(ti.rug_ratio)            as rug_ratio,
           max(ti.security_fetched_at)  as security_fetched_at,
           -- Launch metadata (docs/LAUNCH_METADATA.md): the two words worth scanning by.
           max(tk.launchpad)            as launchpad,
           max(tk.graduated)            as graduated,
           count(distinct h.handle)                   as holders,
           sum(case when h.value > 0 then h.value end) as total_value,
           count(case when h.value > 0 then h.value end) as priced,
           -- Biggest position first: who has conviction, not who sorted first. Unpriced
           -- counts as 0 (matching the Node path), and ties break on rank because JS sort
           -- is stable and the directory is ordered by rank.
           json_group_array(h.handle order by coalesce(h.value, 0) desc, st.rank nulls last) as handles
    from holdings_current h
    join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    join chains c on c.network_id = h.network_id
    /*
     * LEFT, because this was silently hiding a third of the directory.
     *
     * An inner join here dropped every trader with no leaderboard-stats row -- which is all
     * 144 fomo-sourced traders, none of whom have one. The visible effect was that a token
     * held by 105 real traders answered "no leader holds it", and 5,244 tokens held by
     * someone were invisible on these routes entirely. Nothing in the response needs a stats
     * row: st.rank is only a tiebreak in the ordering below, and it already sorts nulls
     * last. A holder is a holder whether or not the leaderboard has scored them.
     */
    left join trader_stats_current st on st.handle = h.handle
    left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    left join token_info ti on ti.network_id = h.network_id and ti.token_key = h.token_key
    where q.token_key is null ${net === null ? sql`` : sql`and h.network_id = ${net}`}
    group by h.network_id, c.name, tk.address
    having count(distinct h.handle) >= ${minHolders}
      ${minValue === null ? sql`` : sql`and coalesce(sum(case when h.value > 0 then h.value end), 0) >= ${minValue}`}
      ${maxValue === null ? sql`` : sql`and coalesce(sum(case when h.value > 0 then h.value end), 0) <= ${maxValue}`}
      ${minMarketCap === null ? sql`` : sql`and max(ti.market_cap_usd) >= ${minMarketCap}`}
      ${maxMarketCap === null ? sql`` : sql`and max(ti.market_cap_usd) <= ${maxMarketCap}`}
      ${minLiquidity === null ? sql`` : sql`and max(ti.liquidity_usd) >= ${minLiquidity}`}
      ${
    !excludeHoneypots ? sql`` : sql`and coalesce(max(ti.is_honeypot), 0) = 0
                                    and coalesce(max(ti.can_not_sell), 0) = 0`
  }
    -- Address is the tiebreak, and it matters: hundreds of tokens tie on holder count with
    -- no price, so without it the board order is whatever the planner produced. It stays on
    -- the end of every sort, unreversed, because T1.4's cursors resume through a total order.
    order by ${tokenSortCol} ${tokenDir} nulls last,
             lower(tk.address), h.network_id`;

  const [{ total_tokens }] = await sql`
    select count(*) as total_tokens from (
      select 1 from holdings_current h
      left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
      where q.token_key is null ${net === null ? sql`` : sql`and h.network_id = ${net}`}
      group by h.network_id, h.token_key) x`;

  const [ex] = await sql`
    -- count(distinct (a, b)) has no SQLite row-value form; the pair is keyed as text.
    select count(distinct h.network_id || ':' || h.token_key) as tokens, count(*) as positions
    from holdings_current h
    join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    ${net === null ? sql`` : sql`where h.network_id = ${net}`}`;

  // display_handle, not the lowercased key — the board is read by people.
  const disp = new Map<string, string>();
  for (const r of await sql`select handle, display_handle from traders`) {
    disp.set(r.handle as string, r.display_handle as string);
  }

  const limit = intParam(url, "limit", { min: 1, fallback: null });
  const cursor = url.searchParams.get("cursor");
  // A token is identified by chain + address: the same address exists on several chains and
  // the board carries one row per pair, so the address alone would be an ambiguous anchor.
  const start = cursor
    ? resumeAfter(rows, cursor, (r: Record<string, unknown>) => `${r.network_id}:${String(r.address).toLowerCase()}`)
    : 0;
  const page = limit === null ? rows.slice(start) : rows.slice(start, start + limit);
  const lastRow = page[page.length - 1];
  const nextCursor = lastRow && start + page.length < rows.length
    ? encodeCursor([`${lastRow.network_id}:${String(lastRow.address).toLowerCase()}`])
    : null;

  return {
    board: "tokens",
    chain: chainQ ?? "all",
    asOf: await asOfHoldings(),
    traders: Number(traderCount),
    count: page.length,
    ranked: rows.length,
    // Every non-quote token on the board, BEFORE minHolders trims it. Reporting the
    // filtered count here would make the filter invisible.
    totalTokens: Number(total_tokens),
    minHolders,
    excludedQuoteAssets: { tokens: Number(ex.tokens), positions: Number(ex.positions) },
    nextCursor,
    ...([minValue, maxValue, minMarketCap, maxMarketCap, minLiquidity].some((v) => v !== null)
      ? {
        filters: Object.fromEntries(
          Object.entries({ minValue, maxValue, minMarketCap, maxMarketCap, minLiquidity })
            .filter(([, v]) => v !== null),
        ),
        // A market-cap or liquidity filter can only judge a token we have fetched. One that
        // has not been is absent from the result, which is not the same as failing the test.
        ...(minMarketCap !== null || maxMarketCap !== null || minLiquidity !== null
          ? {
            filtersNote: "market cap and liquidity come from GMGN; a token not yet fetched " +
              "cannot be evaluated and is excluded rather than counted as zero",
          }
          : {}),
      }
      : {}),
    ...(url.searchParams.has("orderBy") || url.searchParams.has("direction")
      ? { orderBy: tokenSort.key, direction: tokenSort.desc ? "desc" : "asc" }
      : {}),
    entries: page.map((r: Record<string, unknown>, i: number) => ({
      // Rank is the position on the WHOLE board, not within this page. It was `i + 1`, which
      // was correct only while the board could not be paged past the first slice — page two
      // would have restarted the ranking at 1 and quietly reported the 51st token as first.
      rank: start + i + 1,
      tokenAddress: r.address,
      networkId: Number(r.network_id),
      chain: r.chain,
      holders: Number(r.holders),
      /** G2. GMGN's logo, else DexScreener's pair image; null when neither source has one. */
      logoUrl: (r.logo_url as string | null) ?? null,
      /**
       * T3d. GMGN's chain-wide figures, flat on the board row because that is where a
       * consumer scans them. `tier` says whose numbers these are; the token detail route
       * carries the full block plus supply and concentration.
       */
      priceUsd: n(r.price_usd),
      marketCapUsd: round(n(r.market_cap_usd)),
      liquidityUsd: round(n(r.liquidity_usd)),
      chainHolderCount: r.holder_count === null ? null : Number(r.holder_count),
      /**
       * GMGN's own classification of the holders. Capped at 1000 like every wallet tag — a
       * value of exactly 1000 means "at least 1000". The detail route carries the full set
       * and names which tags are capped.
       */
      smartWallets: r.smart_wallets === null ? null : Number(r.smart_wallets),
      renownedWallets: r.renowned_wallets === null ? null : Number(r.renowned_wallets),
      /**
       * T3a. The risk signal, on the row.
       *
       * `null` is "not assessed", never "safe" — it is null on every Solana token, where
       * GMGN does not evaluate honeypot behaviour. `/tokens/:address` carries the full block
       * with the per-chain applicable checks.
       */
      isHoneypot: r.is_honeypot === null ? null : Boolean(r.is_honeypot),
      sellBlocked: r.can_not_sell === null ? null : Boolean(r.can_not_sell),
      sellTax: n(r.sell_tax),
      rugRatio: n(r.rug_ratio),
      securityChecked: !!r.security_fetched_at,
      /** Launch metadata on the row; the detail route carries the curve and timestamps. */
      launchpad: r.launchpad ?? null,
      graduated: r.graduated === null || r.graduated === undefined ? null : Boolean(r.graduated),
      fundamentalsTier: r.info_fetched_at ? "third_party" : null,
      holderShare: Number((Number(r.holders) / Number(traderCount)).toFixed(4)),
      totalValueUsd: Number(r.priced) ? round(n(r.total_value)) : null,
      holderHandles: [...new Set(fromJson<string[]>(r.handles) ?? [])].map((h) => disp.get(h) ?? h),
      // Crowding is REPORTED, never recommended: 34 of 150 traders once held the same
      // honeypot. Consensus can mean a good call or a coordinated pump, and this number
      // cannot tell them apart.
      plain: Number(r.holders) === 1
        ? `Only 1 of ${traderCount} leaders holds this.`
        : `${r.holders} of ${traderCount} leaders hold this.`,
    })),
  };
});

// ------------------------------------------------------------ token detail

get("/v1/tokens/:address", async ({ address }, url) => {
  const chainQ = (url.searchParams.get("chain") ?? "").trim().toLowerCase() || null;
  const net = await chainWhere(chainQ);
  const key = address.toLowerCase();

  const rows = await sql`
    select h.network_id, c.name as chain, tk.address, t.display_handle, h.human_amount, h.value,
           -- Launch metadata (docs/LAUNCH_METADATA.md), one on-chain read per Solana mint.
           tk.created_at as launch_created_at, tk.launchpad, tk.curve_progress, tk.graduated, tk.launch_read_at,
           ti.price_usd, ti.liquidity_usd, ti.market_cap_usd, ti.total_supply,
           ti.circulating_supply, ti.holder_count, ti.top_10_holder_rate,
           ti.symbol as gmgn_symbol, ti.source as info_source, ti.fetched_at as info_fetched_at, ti.logo_url,
           -- T3b/T3c/T3e. Specific paths rather than the whole ti.raw document: this query
           -- returns one row per holder, so selecting all of it would ship the same ~10KB
           -- JSON once per holder — 70+ copies of an identical value on a widely-held token.
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
           -- Gap 5a. The nightly dev ledger for this token's creator (null columns: no row yet).
           cr.launches, cr.best_peak_mcap_usd, cr.best_token_key, cr.still_holding_count,
           cr.sold_count, cr.honeypot_count, cr.last_launch_at,
           -- T3a. Contract safety. Which of these are meaningful depends on the chain, and
           -- the loader has already nulled the ones that do not apply rather than storing
           -- GMGN's false for a check that chain does not have.
           ti.is_honeypot, ti.buy_tax, ti.sell_tax, ti.is_open_source, ti.is_renounced,
           ti.renounced_mint, ti.renounced_freeze, ti.rug_ratio, ti.burn_ratio,
           ti.is_blacklisted, ti.can_not_sell, ti.security_fetched_at, ti.honeypot_since,
           -- Gap 1: hourly DexScreener sample with a rolling ATH (scripts/load_token_prices.mjs).
           ps.last_usd as ps_usd, ps.last_at as ps_at, ps.ath_usd, ps.ath_at, ps.drawdown_share, ps.source as ps_source
    from holdings_current h
    join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    join chains c on c.network_id = h.network_id
    join traders t on t.handle = h.handle
    /*
     * LEFT, because this was silently hiding a third of the directory.
     *
     * An inner join here dropped every trader with no leaderboard-stats row -- which is all
     * 144 fomo-sourced traders, none of whom have one. The visible effect was that a token
     * held by 105 real traders answered "no leader holds it", and 5,244 tokens held by
     * someone were invisible on these routes entirely. Nothing in the response needs a stats
     * row: st.rank is only a tiebreak in the ordering below, and it already sorts nulls
     * last. A holder is a holder whether or not the leaderboard has scored them.
     */
    left join trader_stats_current st on st.handle = h.handle
    left join token_info ti
      on ti.network_id = h.network_id and ti.token_key = h.token_key
    left join token_price_stats ps
      on ps.network_id = h.network_id and ps.token_key = h.token_key
    left join token_creators tc
      on tc.network_id = h.network_id and tc.token_key = h.token_key
    left join creators cr
      on cr.network_id = tc.network_id and cr.creator_address_key = tc.creator_address_key
    where h.token_key = ${key} ${net === null ? sql`` : sql`and h.network_id = ${net}`}
    order by (case when h.value > 0 then h.value else null end) desc nulls last,
             t.display_handle`;

  if (!rows.length) {
    throw notFound(`no leader holds '${address}'${chainQ ? ` on ${chainQ}` : ""}`);
  }
  const [{ traders: traderCount }] = await sql`select count(*) as traders from traders`;
  /**
   * C3, Cabal Trader. Tracked traders with any trade in the coin, per chain, and how many
   * remain once wallets linked to another trader (linked_wallets) are collapsed. A trader is
   * dependent when one of his wallets is another trader's linked address.
   */
  const cohortRows: { network_id: number; holders: number; independent: number }[] = await sql`
    select tr.network_id, count(distinct tr.handle) as holders,
           count(distinct case when not exists (
             select 1 from wallets w join linked_wallets lw
               on lw.address_key in (w.evm_address_key, w.sol_address_key)
             where w.handle = tr.handle and lw.handle <> tr.handle) then tr.handle end) as independent
    from trades tr
    where tr.token_key = ${key} ${net === null ? sql`` : sql`and tr.network_id = ${net}`}
    group by 1`;
  const cohort = new Map(cohortRows.map((c) => [Number(c.network_id), { holders: c.holders, independent: c.independent }]));

  // A token address can exist on more than one chain, so without ?chain= every match is
  // returned rather than one being picked silently.
  const byNet = new Map<number, (typeof rows)[number][]>();
  for (const r of rows) {
    const k = Number(r.network_id);
    byNet.set(k, [...(byNet.get(k) ?? []), r]);
  }

  return {
    tokenAddress: address,
    asOf: await asOfHoldings(),
    chains: byNet.size,
    entries: [...byNet.values()].map((group) => {
      const holders = new Set(group.map((g) => g.display_handle)).size;
      const priced = group.filter((g) => (n(g.value) ?? 0) > 0);
      const total = priced.reduce((s, g) => s + (n(g.value) ?? 0), 0);
      return {
        tokenAddress: group[0].address,
        networkId: Number(group[0].network_id),
        chain: group[0].chain,
        /** G2. GMGN's logo, else DexScreener's pair image; null when neither source has one. */
        logoUrl: (group[0].logo_url as string | null) ?? null,
        holders,
        holderShare: Number((holders / Number(traderCount)).toFixed(4)),
        totalValueUsd: priced.length ? round(total) : null,
        /** T3d. See docs/DECISIONS.md#d082 */
        fundamentals: group[0].info_fetched_at
          ? {
            priceUsd: n(group[0].price_usd),
            liquidityUsd: round(n(group[0].liquidity_usd)),
            marketCapUsd: round(n(group[0].market_cap_usd)),
            totalSupply: n(group[0].total_supply),
            circulatingSupply: n(group[0].circulating_supply),
            holderCount: group[0].holder_count === null ? null : Number(group[0].holder_count),
            /**
             * GMGN's concentration across ALL chain holders. Deliberately named differently
             * from `leaderConcentration` above, which is the share among the leaders we
             * track. Same shape, same plausible range, different denominators — for our
             * top-ranked token they read 0.1974 and 0.4234.
             */
            top10HolderRate: n(group[0].top_10_holder_rate),
            tier: "third_party",
            source: group[0].info_source ?? "gmgn",
            fetchedAt: new Date(String(group[0].info_fetched_at)).toISOString(),
          }
          : null,
        /** What the leaders' holdings would be worth at GMGN's price. See docs/DECISIONS.md#d083 */
        estimatedValueUsd: n(group[0].price_usd) !== null
          ? round(group.reduce((acc, g) => acc + (n(g.human_amount) ?? 0), 0) * n(group[0].price_usd)!)
          : null,
        estimatedValueBasis: n(group[0].price_usd) !== null
          ? "sum(holdings.amount) x GMGN price — third-party, not our stored value"
          : null,
        /** Gap 1. Latest hourly sample and the ATH since we started sampling; null fields, never 0, when unknown. */
        price: {
          usd: n(group[0].ps_usd),
          asOf: group[0].ps_at ? new Date(String(group[0].ps_at)).toISOString() : null,
          athUsd: n(group[0].ath_usd),
          athAt: group[0].ath_at ? new Date(String(group[0].ath_at)).toISOString() : null,
          drawdownShare: n(group[0].drawdown_share),
          source: (group[0].ps_source as string | null) ?? null,
        },
        /** C3. `holders` here is by trades, not by the holdings snapshot `holders` above. */
        cohort: (() => {
          const c = cohort.get(Number(group[0].network_id)) ?? { holders: 0, independent: 0 };
          return { ...c, linkedGroups: c.holders - c.independent };
        })(),
        /** T3a. See docs/DECISIONS.md#d084 */
        security: group[0].security_fetched_at
          ? (() => {
            const b = bool;
            const isSol = Number(group[0].network_id) === 1399811149;
            const flags: string[] = [];
            if (b(group[0].is_honeypot) === true) flags.push("honeypot");
            if (b(group[0].can_not_sell) === true) flags.push("sell_blocked");
            if (b(group[0].is_blacklisted) === true) flags.push("blacklist_function");
            if ((n(group[0].buy_tax) ?? 0) > 0.1) flags.push("high_buy_tax");
            if ((n(group[0].sell_tax) ?? 0) > 0.1) flags.push("high_sell_tax");
            if ((n(group[0].rug_ratio) ?? 0) > 0.3) flags.push("high_rug_ratio");
            if (isSol && b(group[0].renounced_mint) === false) flags.push("mint_not_renounced");
            if (isSol && b(group[0].renounced_freeze) === false) flags.push("freeze_not_renounced");
            if (!isSol && b(group[0].is_renounced) === false) flags.push("owner_not_renounced");
            return {
              canSell: b(group[0].is_honeypot) === null
                ? null
                : !(b(group[0].is_honeypot) === true || b(group[0].can_not_sell) === true),
              isHoneypot: b(group[0].is_honeypot),
              /** C3. First nightly read that flagged it (honeypot or sell-blocked); never cleared. */
              honeypotSince: group[0].honeypot_since ? new Date(String(group[0].honeypot_since)).toISOString() : null,
              buyTax: n(group[0].buy_tax),
              sellTax: n(group[0].sell_tax),
              isOpenSource: b(group[0].is_open_source),
              ownerRenounced: b(group[0].is_renounced),
              mintRenounced: b(group[0].renounced_mint),
              freezeRenounced: b(group[0].renounced_freeze),
              rugRatio: n(group[0].rug_ratio),
              burnRatio: n(group[0].burn_ratio),
              blacklistFunction: b(group[0].is_blacklisted),
              /**
               * What this chain can even be asked. GMGN assesses honeypot, source and owner
               * renouncement on EVM only; mint and freeze authority are Solana-only. Naming
               * the applicable set stops an absent field reading as a failed check.
               */
              applicableChecks: isSol
                ? ["mintRenounced", "freezeRenounced", "buyTax", "sellTax", "rugRatio", "burnRatio"]
                : ["isHoneypot", "isOpenSource", "ownerRenounced", "buyTax", "sellTax",
                   "blacklistFunction", "rugRatio", "burnRatio"],
              flags,
              verdict: flags.includes("honeypot") || flags.includes("sell_blocked")
                ? "cannot_sell"
                : flags.length
                ? "caution"
                : "no_flags_raised",
              // "No flags raised" is not "safe", and the wording says so. We checked what
              // GMGN checks; a contract can be hostile in ways none of them cover.
              note: "flags are what GMGN's checks caught. Nothing raised is not proof of " +
                    "safety, and null means a check does not apply on this chain — never " +
                    "that it passed.",
              tier: "third_party",
              source: group[0].info_source ?? "gmgn",
              fetchedAt: new Date(String(group[0].security_fetched_at)).toISOString(),
            };
          })()
          : null,
        /**
         * Launch metadata, from the chain (docs/LAUNCH_METADATA.md). Every field is null
         * until the loader has read the mint; `launchpad` null AFTER a read (readAt set)
         * means no pump.fun curve exists for it. Solana only today.
         */
        launch: {
          createdAt: group[0].launch_created_at ? new Date(String(group[0].launch_created_at)).toISOString() : null,
          launchpad: group[0].launchpad ?? null,
          curveProgress: n(group[0].curve_progress),
          graduated: group[0].graduated === null || group[0].graduated === undefined ? null : Boolean(group[0].graduated),
          readAt: group[0].launch_read_at ? new Date(String(group[0].launch_read_at)).toISOString() : null,
        },
        /** T3b. See docs/DECISIONS.md#d085 */
        chainConcentration: group[0].info_fetched_at
          ? {
            holderCount: group[0].holder_count === null ? null : Number(group[0].holder_count),
            top10HolderRate: n(group[0].top_10_holder_rate),
            devTeamHoldRate: n(group[0].dev_team_hold_rate),
            creatorHoldRate: n(group[0].creator_hold_rate),
            freshWalletRate: n(group[0].fresh_wallet_rate),
            sniperHoldRate: n(group[0].sniper_hold_rate),
            botDegenRate: n(group[0].bot_degen_rate),
            basis: "share of supply across all chain holders — NOT the tracked-leader share " +
                   "in leaderConcentration, which has a different denominator",
            tier: "third_party",
            source: group[0].info_source ?? "gmgn",
          }
          : null,
        /** T3e. See docs/DECISIONS.md#d086 */
        walletTags: (() => {
          const w = fromJson<Record<string, unknown>>(group[0].wallet_tags);
          if (!w) return null;
          const CAP = 1000;
          const val = (k: string) => {
            const x = n(w[k]);
            return x === null ? null : Math.trunc(x);
          };
          const tags = {
            smart: val("smart_wallets"),
            renowned: val("renowned_wallets"),
            sniper: val("sniper_wallets"),
            bundler: val("bundler_wallets"),
            whale: val("whale_wallets"),
            fresh: val("fresh_wallets"),
            ratTrader: val("rat_trader_wallets"),
            top: val("top_wallets"),
            creator: val("creator_wallets"),
          };
          const capped = Object.entries(tags)
            .filter(([, v]) => v !== null && v >= CAP).map(([k]) => k);
          return {
            ...tags,
            capped: capped.length > 0,
            cappedTags: capped,
            note: capped.length
              ? `GMGN caps these counts at ${CAP}. ${capped.join(", ")} read exactly ${CAP}, ` +
                `which means AT LEAST ${CAP} and not that many exactly.`
              : `GMGN caps these counts at ${CAP}; none of this token's tags reached it.`,
            tier: "third_party",
            source: group[0].info_source ?? "gmgn",
          };
        })(),
        /**
         * T3c. Who launched it and what they did next.
         *
         * `creatorStatus` is blank on 185 of 1,095 tokens and is reported as `null` there —
         * "we were not told" is a different claim from "the creator still holds", and only
         * one of them is evidence.
         */
        creator: group[0].info_fetched_at &&
            (nonEmpty(group[0].creator_address as string | null) ||
             nonEmpty(group[0].creator_status as string | null) ||
             nonEmpty(group[0].cto_flag as string | null))
          ? {
            /**
             * Blank on 104 of 1,095 tokens (9.5%). Gating the whole block on it — as the
             * first version did — threw away a known `creator_close` and community-takeover
             * flag for every one of them. An unknown address is one missing field, not a
             * reason to withhold what we do know.
             */
            address: nonEmpty(group[0].creator_address as string | null),
            // creator_hold / creator_close. Empty string means unknown, never "sold".
            status: nonEmpty(group[0].creator_status as string | null),
            stillHolding: group[0].creator_status === "creator_hold"
              ? true
              : group[0].creator_status === "creator_close"
              ? false
              : null,
            // 0/1 as a string. Community takeover — the original dev walked away and holders
            // took it over, which is a very different thing from a dev who never left.
            communityTakeover: group[0].cto_flag === null || group[0].cto_flag === ""
              ? null
              : String(group[0].cto_flag) === "1",
            tokensLaunched: n(group[0].creator_open_count),
            /** The creator's best previous launch — null when there is not one. See docs/DECISIONS.md#d087 */
            bestPreviousToken: (() => {
              const a = fromJson<Record<string, unknown>>(group[0].creator_ath);
              if (!a) return null;
              const symbol = nonEmpty(a.symbol as string | null);
              const address = nonEmpty(a.ath_token as string | null);
              const peak = n(a.ath_mc);
              if (!symbol && !address) return null;
              return {
                symbol,
                address,
                peakMarketCapUsd: peak !== null && peak > 0 ? round(peak) : null,
              };
            })(),
            /** Gap 5a. Across every launch we hold info for; null until the nightly ledger has a row. */
            ledger: ledgerBody(group[0]),
            tier: "third_party",
            source: group[0].info_source ?? "gmgn",
          }
          : null,
        /** T1.3. See docs/DECISIONS.md#d088 */
        leaderConcentration: (() => {
          /** Computed from AMOUNTS, not values — and that is not a shortcut, it is exact. See docs/DECISIONS.md#d089 */
          const amounts = group.map((g) => n(g.human_amount) ?? 0).filter((a) => a > 0);
          const totalAmount = amounts.reduce((a, b) => a + b, 0);
          if (!amounts.length || totalAmount <= 0) return null;
          const perHandle = new Map<string, number>();
          for (const g of group) {
            const amt = n(g.human_amount) ?? 0;
            if (amt <= 0) continue;
            const h = String(g.display_handle);
            perHandle.set(h, (perHandle.get(h) ?? 0) + amt);
          }
          const vals = [...perHandle.values()].sort((a, b) => b - a);
          const share = (k: number) =>
            Number((vals.slice(0, k).reduce((a, b) => a + b, 0) / totalAmount).toFixed(4));
          return {
            top1: share(1),
            // null, not a smaller-k answer: "the top 3 of 2 holders" is the whole set, and
            // reporting 1.0 there would read as extreme concentration rather than too few
            // holders to say.
            top3: vals.length >= 3 ? share(3) : null,
            top10: vals.length >= 10 ? share(10) : null,
            leaders: vals.length,
            basis: "share of the token AMOUNT held by the tracked leaders, summed per leader. " +
                   "Price-independent: every holder holds the same token, so a price would " +
                   "cancel out of the ratio. NOT chain-wide supply concentration — compare " +
                   "fundamentals.top10HolderRate, which has a different denominator.",
            coverage: cov(amounts.length, group.length),
          };
        })(),
        holderHandles: group.map((g) => g.display_handle),
        holders_detail: group.map((g) => ({
          handle: g.display_handle,
          amount: n(g.human_amount) ?? 0,
          valueUsd: (n(g.value) ?? 0) > 0 ? round(n(g.value)) : null,
        })),
        plain: holders === 1
          ? `Only 1 of ${traderCount} leaders holds this.`
          : `${holders} of ${traderCount} leaders hold this.`,
      };
    }),
  };
});


// ------------------------------------------------------------ K5-K8 (SQL)

get("/v1/tokens/:address/activity", async ({ address }, url) => {
  const chainQ = (url.searchParams.get("chain") ?? "").trim().toLowerCase() || null;
  const net = await chainWhere(chainQ);
  const key = address.toLowerCase();

  const holders: Record<string, unknown>[] = await sql`
    select t.display_handle, h.network_id, h.value
    from holdings_current h join traders t on t.handle = h.handle
    where h.token_key = ${key} ${net === null ? sql`` : sql`and h.network_id = ${net}`}`;
  if (!holders.length) {
    throw notFound(`no leader holds '${address}'${chainQ ? ` on ${chainQ}` : ""}`);
  }
  const nets = new Set(holders.map((h) => Number(h.network_id)));
  if (nets.size > 1) {
    throw badRequest(`'${address}' exists on ${nets.size} chains — pass ?chain= to pick one`);
  }

  // No fan-out, no per-holder API call, no 25-holder cap: every trader who has ever traded
  // this token, from one query.
  /** ISSUE-4, the K5 half. See docs/DECISIONS.md#d090 */
  const per: Record<string, unknown>[] = await sql`
    with legs as (
      select t.display_handle as handle, tr.status, tr.trade_id,
             tr.realized_pnl_usd, tr.unrealized_pnl_usd,
             tr.avg_entry_price, tr.avg_exit_price, tr.opened_at, tr.closed_at,
             -- trade_qty() is gone with Postgres (worker/d1/SCHEMA_MAP.md): the case is
             -- inlined here, and its TS twin is legQty in shared/scorecard-core.ts.
             case
               when tr.status = 'open' and tr.amount > 0 then tr.amount
               when tr.status = 'closed'
                    and tr.realized_pnl_usd is not null
                    and tr.avg_entry_price is not null
                    and tr.avg_exit_price is not null
                    and tr.avg_exit_price <> tr.avg_entry_price
                    and tr.realized_pnl_usd / (tr.avg_exit_price - tr.avg_entry_price) > 0
                 then tr.realized_pnl_usd / (tr.avg_exit_price - tr.avg_entry_price)
               else null
             end as qty,
             -- (array_agg(px order by opened_at nulls last, trade_id) filter (where px > 0))[1]
             -- is the first PRICED leg: the unpriced ones are ordered behind, then rn = 1.
             row_number() over (
               partition by t.display_handle
               order by (case when tr.avg_entry_price > 0 then 0 else 1 end),
                        tr.opened_at nulls last, tr.trade_id) as entry_rn,
             row_number() over (
               partition by t.display_handle
               order by (case when tr.avg_exit_price > 0 then 0 else 1 end),
                        tr.opened_at nulls last, tr.trade_id) as exit_rn
      from trades tr join traders t on t.handle = tr.handle
      where tr.token_key = ${key}
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

  /** C5. Each seller's exit-timing score over ALL his closed coins, same rule as the scorecard. */
  const timing = new Map<string, { exitPrice: number | null; currentPrice: number | null }[]>();
  for (const r of await sql`
    with legs as (
      select t.display_handle as handle, tr.network_id, tr.token_key,
             tr.avg_exit_price, tr.opened_at, tr.trade_id,
             -- trade_qty() is gone with Postgres (worker/d1/SCHEMA_MAP.md): the case is
             -- inlined here, and its TS twin is legQty in shared/scorecard-core.ts.
             case
               when tr.status = 'open' and tr.amount > 0 then tr.amount
               when tr.status = 'closed'
                    and tr.realized_pnl_usd is not null
                    and tr.avg_entry_price is not null
                    and tr.avg_exit_price is not null
                    and tr.avg_exit_price <> tr.avg_entry_price
                    and tr.realized_pnl_usd / (tr.avg_exit_price - tr.avg_entry_price) > 0
                 then tr.realized_pnl_usd / (tr.avg_exit_price - tr.avg_entry_price)
               else null
             end as qty,
             row_number() over (
               partition by t.display_handle, tr.network_id, tr.token_key
               order by (case when tr.avg_exit_price > 0 then 0 else 1 end),
                        tr.opened_at nulls last, tr.trade_id) as exit_rn
      from trades tr join traders t on t.handle = tr.handle
      where t.display_handle in (${per.map((r) => String(r.handle))}) and tr.status = 'closed')
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
    group by l.handle, l.network_id, l.token_key, ti.price_usd`) {
    const h = String(r.handle);
    timing.set(h, [...(timing.get(h) ?? []), { exitPrice: n(r.exit), currentPrice: n(r.current) }]);
  }

  const withClosed = per.filter((r) => Number(r.closed) > 0);
  const winners = withClosed.filter((r) => (n(r.realized) ?? 0) > 0).length;
  const losers = withClosed.filter((r) => (n(r.realized) ?? 0) < 0).length;
  const entries = per.map((r) => n(r.entry)).filter((x): x is number => x !== null && x > 0);
  // How much of the crowd figure rests on a real average rather than a single position or a
  // fallback — reported rather than left for a consumer to assume.
  const multiPosition = per.filter((r) => Number(r.entry_positions) > 1).length;
  const fullyWeighted = per.filter((r) =>
    Number(r.entry_positions) > 0 &&
    Number(r.entry_positions_weighted) === Number(r.entry_positions)).length;

  const opened = per.reduce((s, r) => s + (Number(r.trades) - Number(r.closed)), 0);
  const closedTotal = per.reduce((s, r) => s + Number(r.closed), 0);
  const flow = !per.length ? "unknown"
    : closedTotal === 0 ? "accumulating"
    : opened === 0 ? "distributing"
    : opened > closedTotal * 2 ? "accumulating"
    : closedTotal > opened * 2 ? "distributing" : "mixed";

  // null, NOT false, when nobody who holds it has a trade record. "Nobody has ever sold
  // this" and "we have no evidence either way" are different claims and only one of them
  // is a honeypot signal.
  const everSold = per.length ? withClosed.length > 0 : null;
  const holderCount = new Set(holders.map((h) => h.display_handle)).size;
  const priced = holders.filter((h) => (n(h.value) ?? 0) > 0);

  const traded = new Set(per.map((r) => r.handle as string));
  const noRecord = [...new Set(holders.map((h) => h.display_handle as string))]
    .filter((h) => !traded.has(h)).length;

  const caveats: string[] = [];
  if (noRecord > 0) {
    caveats.push(`${noRecord} of the ${holderCount} current holders have no trade record for this ` +
      `token, so their behaviour is unknown.`);
  }
  if (per.length > holderCount) {
    caveats.push(`${per.length - holderCount} trader(s) have a record for this token but no longer ` +
      `hold it — they are counted in the exit figures and not in the holder count.`);
  }

  return {
    tokenAddress: address,
    networkId: [...nets][0],
    chain: (await sql`select name from chains where network_id = ${[...nets][0]}`)[0]?.name ?? null,
    holdersInDirectory: holderCount,
    asOf: await asOfToken(key),
    totalValueUsd: priced.length ? round(priced.reduce((s, h) => s + (n(h.value) ?? 0), 0)) : null,
    source: "postgres · trades",
    /** Two different populations, kept apart on purpose. See docs/DECISIONS.md#d091 */
    coverage: {
      holdersNow: holderCount,
      withTradeRecord: per.length,
      holdersNowWithNoRecord: noRecord,
    },
    everSold,
    holdersWhoSold: withClosed.length,
    holdersStillHolding: per.length - withClosed.length,
    winRate: withClosed.length ? Number((winners / withClosed.length).toFixed(4)) : null,
    winners, losers,
    crowdAvgEntryPrice: {
      value: entries.length ? Number((entries.reduce((a, b) => a + b, 0) / entries.length).toPrecision(8)) : null,
      coverage: cov(entries.length, per.length),
      /** One trader, one vote — deliberately NOT weighted by position size. See docs/DECISIONS.md#d092 */
      method: "unweighted mean across holders of each holder's quantity-weighted entry",
      holdersMultiPosition: multiPosition,
      holdersFullyWeighted: fullyWeighted,
    },
    flow: { opened, closed: closedTotal, verdict: flow },
    realizedPnlUsd: round(per.reduce((s, r) => s + (n(r.realized) ?? 0), 0)),
    unrealizedPnlUsd: round(per.reduce((s, r) => s + (n(r.unrealized) ?? 0), 0)),
    perHolder: per.map((r) => ({
      handle: r.handle, trades: Number(r.trades), closed: Number(r.closed),
      realizedPnlUsd: round(n(r.realized)), unrealizedPnlUsd: round(n(r.unrealized)),
      avgEntryPrice: n(r.entry), avgExitPrice: n(r.exit),
      entryPositions: Number(r.entry_positions),
      entryPositionsWeighted: Number(r.entry_positions_weighted),
      firstBuyAt: r.first_buy ?? null, lastSellAt: r.last_sell ?? null,
      /** C5: this trader's exit-timing score across every coin he has closed, not this coin alone. */
      exitTimingScore: exitTimingScoreFrom(timing.get(String(r.handle)) ?? []),
    })),
    plain: !per.length
      ? "None of the holders have a trade record for this token, so we cannot say what they have done with it."
      : withClosed.length === 0
      ? `Not one of the ${per.length} holder${per.length === 1 ? "" : "s"} with a trade record for this ` +
        `token has ever closed a position in it. Every gain shown against it is on paper.`
      : `Of the ${per.length} holder${per.length === 1 ? "" : "s"} with a trade record for this token, ` +
        `${withClosed.length} ${withClosed.length === 1 ? "has" : "have"} sold at least part of the ` +
        `position and ${winners} came out ahead.`,
    caveats,
  };
});

// -------------------------------------------------------------- K2 (SQL)

get("/v1/tokens/momentum", async (_p, url) => {
  // Validate the input BEFORE checking whether there is data. Otherwise a typo is silently
  // accepted whenever the archive happens to be too short to answer, so the same bad
  // request 400s or 200s depending on how much history exists.
  const dir = (url.searchParams.get("direction") ?? "").trim().toLowerCase();
  if (dir && dir !== "in" && dir !== "out") {
    throw badRequest(`unknown direction '${dir}' — use 'in' or 'out'`);
  }

  // K2 is the one parameter that is not a function of the current snapshot. It falls out
  // of `captured_at` being part of the holdings primary key — no archive files, no
  // ephemeral disk, just the two most recent generations joined against each other.
  const gens = await sql`
    select distinct captured_at from holdings order by captured_at desc limit 2`;
  if (gens.length < 2) {
    return {
      board: "momentum", available: false, snapshots: gens.length,
      from: null, to: null, spanHours: null, direction: "all", moved: 0, count: 0, entries: [],
      // "nothing moved" and "we have no baseline" must never render identically.
      plain: `Momentum needs two generations to compare and we have ${gens.length}. ` +
             `Each run of the loader adds one.`,
    };
  }
  const [to, from] = [gens[0].captured_at, gens[1].captured_at];

  type MomentumRow = {
    network_id: number; token_key: string; holders: number; previous_holders: number;
    now_handles: string[]; before_handles: string[];
  };
  const rows: MomentumRow[] = await sql`
    with a as (select network_id, token_key, json_group_array(handle) as handles
               from holdings where captured_at = ${from} group by 1,2),
         b as (select network_id, token_key, json_group_array(handle) as handles
               from holdings where captured_at = ${to} group by 1,2)
    select coalesce(a.network_id, b.network_id) as network_id,
           coalesce(a.token_key, b.token_key)   as token_key,
           coalesce(json_array_length(b.handles),0) as holders,
           coalesce(json_array_length(a.handles),0) as previous_holders,
           coalesce(b.handles,'[]') as now_handles, coalesce(a.handles,'[]') as before_handles
    from a full outer join b using (network_id, token_key)`;

  const disp = new Map<string, string>();
  for (const r of await sql`select handle, display_handle from traders`) {
    disp.set(r.handle as string, r.display_handle as string);
  }
  const chains = new Map<number, string>();
  for (const r of await sql`select network_id, name from chains`) {
    chains.set(Number(r.network_id), r.name as string);
  }
  const addrs = new Map<string, string>();
  const logos = new Map<string, string | null>();
  for (const r of await sql`
    select tk.network_id, tk.token_key, tk.address, ti.logo_url
      from tokens tk left join token_info ti on ti.network_id = tk.network_id and ti.token_key = tk.token_key`) {
    addrs.set(`${r.network_id}:${r.token_key}`, r.address as string);
    logos.set(`${r.network_id}:${r.token_key}`, (r.logo_url as string | null) ?? null);
  }

  const moved = rows.flatMap((r) => {
    const now = new Set(fromJson<string[]>(r.now_handles) ?? []);
    const before = new Set(fromJson<string[]>(r.before_handles) ?? []);
    const gained = [...now].filter((h) => !before.has(h));
    const lost = [...before].filter((h) => !now.has(h));
    if (!gained.length && !lost.length) return [];
    const net = Number(r.network_id);
    const change = Number(r.holders) - Number(r.previous_holders);
    return [{
      tokenAddress: addrs.get(`${net}:${r.token_key}`) ?? r.token_key,
      networkId: net, chain: chains.get(net) ?? String(net),
      logoUrl: logos.get(`${net}:${r.token_key}`) ?? null,
      holders: Number(r.holders), previousHolders: Number(r.previous_holders), change,
      gained: gained.map((h) => disp.get(h) ?? h), lost: lost.map((h) => disp.get(h) ?? h),
      isNew: Number(r.previous_holders) === 0,
      /**
       * A token with no previous snapshot did not necessarily get BOUGHT — it may simply be
       * the first time the loader saw it. Those are indistinguishable from here, so the
       * sentence states what is observed (it is present now) rather than asserting a
       * purchase the data cannot establish. "Opened a position" is reserved for rows with
       * a previous holder count to compare against.
       */
      plain: Number(r.previous_holders) === 0
        ? `First seen in this snapshot — ${r.holders} leader${Number(r.holders) === 1 ? "" : "s"} hold it. ` +
          `Whether they just bought it or it is newly tracked cannot be told apart from one snapshot.`
        : change > 0 ? `+${change} holders (${r.previous_holders} to ${r.holders}).`
        : change < 0 ? `${change} holders (${r.previous_holders} to ${r.holders}).`
        : `Same holder count, but ${gained.length} in and ${lost.length} out.`,
    }];
  }).sort((a, b) => b.change - a.change || b.holders - a.holders ||
                    a.tokenAddress.localeCompare(b.tokenAddress));

  const filtered = dir === "in" ? moved.filter((r) => r.change > 0)
    : dir === "out" ? moved.filter((r) => r.change < 0) : moved;
  const limit = intParam(url, "limit", { min: 1, fallback: null });

  return {
    board: "momentum", available: true, snapshots: gens.length,
    /** The newer of the two snapshots compared -- this board is as recent as that reading. */
    asOf: to ? new Date(String(to)).toISOString() : null,
    from, to,
    spanHours: Number(((Date.parse(String(to)) - Date.parse(String(from))) / 3_600_000).toFixed(1)),
    direction: dir || "all",
    moved: filtered.length,
    count: (limit === null ? filtered : filtered.slice(0, limit)).length,
    entries: limit === null ? filtered : filtered.slice(0, limit),
    plain: filtered.length
      ? `${moved.filter((r) => r.change > 0).length} tokens gained holders and ` +
        `${moved.filter((r) => r.change < 0).length} lost them since the previous snapshot.`
      : "No holder changes between the two most recent generations.",
  };
});

// ------------------------------------------------------------ dev ledger (gap 5a)

get("/v1/creators/:address", async ({ address }, url) => {
  const chainQ = (url.searchParams.get("chain") ?? "").trim().toLowerCase() || null;
  const net = await chainWhere(chainQ);
  const key = address.toLowerCase();

  // One EVM address is the same creator on every EVM chain, so without ?chain= the ledger
  // sums across networks; (network, token) pairs are distinct, so launches do not double.
  const [ledger] = await sql`
    select sum(launches) as launches,
           max(best_peak_mcap_usd) as best_peak_mcap_usd,
           -- (array_agg(k order by mcap desc nulls last))[1]: DESC already sorts NULL last.
           max(case when rn = 1 then best_token_key end) as best_token_key,
           sum(still_holding_count) as still_holding_count,
           sum(sold_count) as sold_count,
           sum(honeypot_count) as honeypot_count,
           max(last_launch_at) as last_launch_at,
           max(updated_at) as updated_at
    from (
      select creator_address_key, launches, best_peak_mcap_usd, best_token_key,
             still_holding_count, sold_count, honeypot_count, last_launch_at, updated_at,
             row_number() over (order by best_peak_mcap_usd desc) as rn
      from creators
      where creator_address_key = ${key} ${net === null ? sql`` : sql`and network_id = ${net}`})
    group by creator_address_key`;
  if (!ledger) {
    throw notFound(`no creator '${address}' on record${chainQ ? ` on ${chainQ}` : ""}`);
  }

  const tokens = await sql`
    select c.name as chain, tk.address, ti.symbol, tc.creator_status, ti.is_honeypot,
           ti.market_cap_usd
    from token_creators tc
    join tokens tk on tk.network_id = tc.network_id and tk.token_key = tc.token_key
    join chains c on c.network_id = tc.network_id
    left join token_info ti on ti.network_id = tc.network_id and ti.token_key = tc.token_key
    where tc.creator_address_key = ${key} ${net === null ? sql`` : sql`and tc.network_id = ${net}`}
    order by ti.market_cap_usd desc nulls last, tk.address`;

  return {
    creator: address,
    /** When the nightly ledger last rebuilt this creator. */
    asOf: ledger.updated_at ? new Date(String(ledger.updated_at)).toISOString() : null,
    ledger: ledgerBody(ledger),
    tokens: tokens.map((t: Record<string, unknown>) => ({
      chain: t.chain as string,
      tokenAddress: t.address as string,
      symbol: nonEmpty(t.symbol as string | null),
      // creator_hold / creator_close as GMGN said it; null when it did not say.
      status: (t.creator_status as string | null) ?? null,
      isHoneypot: t.is_honeypot === null ? null : Boolean(t.is_honeypot),
      marketCapUsd: round(n(t.market_cap_usd)),
    })),
    tier: "third_party",
    source: "gmgn",
  };
});
