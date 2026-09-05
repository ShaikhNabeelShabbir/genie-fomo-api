import { sql, n, round } from "./db.ts";

/**
 * When the underlying data was measured.
 *
 * Every money figure this API returns carries one. A dollar amount with no age goes stale
 * silently and a consumer cannot tell a fresh total from yesterday's — which is the whole
 * point of the field, so it is computed once here rather than per route.
 */
export const asOfHoldings = async (): Promise<string | null> => {
  const [r] = await sql`select max(captured_at) as at from holdings`;
  return r?.at ? new Date(String(r.at)).toISOString() : null;
};
export const asOfTrades = async (): Promise<string | null> => {
  const [r] = await sql`select max(captured_at) as at from trades`;
  return r?.at ? new Date(String(r.at)).toISOString() : null;
};

/** '' is not a value. The columns store empty strings where fomo gave nothing. */
const nonEmpty = (v: string | null | undefined): string | null =>
  v && v.trim() ? v.trim() : null;
import { get } from "./router.ts";
import { notFound, badRequest } from "./errors.ts";

/**
 * PARAMETERS.md routes, served from Postgres.
 *
 * Two rules carry over from the Express implementation and are the reason several of these
 * queries look more careful than they need to:
 *
 *   A MISSING PRICE IS NOT ZERO.  `value` is nullable and 1,688 of 2,038 rows have none.
 *   SQL's `sum()` skips nulls, which is what we want — but `count(*)` does not, so every
 *   ratio here names the column it counts rather than counting rows.
 *
 *   A RATIO SHIPS WITH ITS DENOMINATOR.  A concentration of 97% computed over 44% of a
 *   portfolio is not a fact about the portfolio, so `coverage` travels with every figure.
 */

const chainWhere = async (chain: string | null) => {
  if (!chain) return null;
  const [row] = await sql`select network_id from chains where name = ${chain.toLowerCase()}`;
  if (!row) throw badRequest(`unknown chain '${chain}'`);
  return Number(row.network_id);
};

// ------------------------------------------------------------- C1/C2/C4/C5

get("/v1/chains", async () => {
  const rows = await sql`
    select c.network_id, c.name, c.history_provider,
           count(h.*)                                   as positions,
           count(distinct h.handle)                     as traders,
           count(distinct h.token_key) filter (
             where q.token_key is null)                 as tokens,
           count(h.value) filter (where h.value > 0)    as priced,
           sum(h.value)   filter (where h.value > 0)    as total_value
    from chains c
    join holdings_current h on h.network_id = c.network_id
    left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    group by c.network_id, c.name, c.history_provider
    order by positions desc`;

  const [{ traders: traderCount }] = await sql`select count(*)::int as traders from traders`;
  const [{ total }] = await sql`select count(*)::int as total from holdings_current`;

  /**
   * C3 — realized profit per chain.
   *
   * Previously marked unavailable because the source gives one `pnl` per trader and
   * splitting it would mean inventing an attribution. That is still true of the LEADERBOARD
   * figure — but per-trade records carry their own chain, so this attributes nothing: it
   * sums realized P&L over trades that already know where they happened.
   *
   * `unattributed` is published rather than folded in. 26 closed trades still have no chain,
   * and a breakdown that silently absorbed them would misstate every row.
   */
  const profit = await sql`
    select t.network_id,
           count(*) filter (where t.status = 'closed')::int as closed,
           coalesce(sum(t.realized_pnl_usd) filter (where t.status = 'closed'), 0) as realized
    from trades t group by t.network_id`;
  const byNet = new Map(profit.filter((r) => r.network_id !== null)
    .map((r) => [Number(r.network_id), r]));
  const orphan = profit.find((r) => r.network_id === null);

  const top = rows[0];
  return {
    board: "chains",
    asOf: await asOfHoldings(),
    traders: Number(traderCount),
    totalPositions: Number(total),
    count: rows.length,
    // Never folded into a chain row: attributing it would misstate whichever row absorbed it.
    unattributedRealized: orphan
      ? { closedTrades: Number(orphan.closed), pnlUsd: round(n(orphan.realized)),
          note: "closed trades whose chain could not be established" }
      : null,
    plain: top
      ? `${top.traders} of ${traderCount} leaders trade ${top.name}, which carries ` +
        `${top.positions} of ${total} positions on the board.`
      : "No positions in the directory.",
    entries: rows.map((r) => {
      const positions = Number(r.positions);
      const priced = Number(r.priced);
      const pricedShare = positions ? Number((priced / positions).toFixed(4)) : null;
      const name = r.name as string;
      return {
        networkId: Number(r.network_id),
        chain: name,
        traders: Number(r.traders),
        traderShare: Number((Number(r.traders) / Number(traderCount)).toFixed(4)),
        positions,
        tokens: Number(r.tokens),
        totalValueUsd: priced ? round(n(r.total_value)) : null,
        coverage: { pricedPositions: priced, unpricedPositions: positions - priced, pricedShare },
        // Lead with the caveat when the money figure rests on a minority of the rows.
        plain: pricedShare !== null && pricedShare < 0.5
          ? `${r.traders} of ${traderCount} leaders trade ${name}, but only ${priced} of ` +
            `${positions} positions there have a usable price — the value figure is partial.`
          : `${r.traders} of ${traderCount} leaders trade ${name}, across ${positions} positions.`,
        // C3
        realized: (() => {
          const p = byNet.get(Number(r.network_id));
          return {
            closedTrades: p ? Number(p.closed) : 0,
            pnlUsd: p ? round(n(p.realized)) : null,
            basis: "sum of realized_pnl_usd over closed trades recorded on this chain",
          };
        })(),
        historyCoverage: {
          available: !!r.history_provider,
          via: r.history_provider ?? null,
          // Blockscout needs no key at all, which is worth saying out loud: it is the only
          // free history we have on Robinhood.
          note: r.history_provider === "blockscout" ? "keyless" : null,
        },
        // Free and keyless on all five chains, so a position SIZE is always checkable even
        // where the transaction history behind it is not.
        balanceVerifiable: true,
      };
    }),
  };
});

// ------------------------------------------------------------- T11/T13/T14

get("/v1/traders/:handle/portfolio", async ({ handle }, url) => {
  const [t] = await sql`
    select handle, display_handle, name from traders where handle = ${handle.toLowerCase()}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const asOf = await asOfHoldings();

  /**
   * Per-chain breakdown of what the total actually covers.
   *
   * "Which chains are in this number" is not a nicety here: only Solana carries prices in
   * the current snapshot, so a cross-chain-looking AUM is in practice a Solana figure.
   * Saying so per chain is the difference between a total and a total that misleads.
   */
  const byChain = await sql`
    select c.name as chain, h.network_id,
           count(*)::int                              as positions,
           count(h.value) filter (where h.value > 0)::int as priced,
           sum(h.value)   filter (where h.value > 0)  as value
    from holdings_current h join chains c using (network_id)
    where h.handle = ${t.handle}
    group by c.name, h.network_id
    order by positions desc`;

  /**
   * Is a particular coin inside this total, or outside it?
   *
   * The consuming screen shows AUM beside one coin's row, where "their whole portfolio" and
   * "their whole portfolio excluding this coin" are different statements. Rather than make
   * them subtract — and get it wrong when the position is unpriced — the route answers it.
   */
  const tokenQ = (url.searchParams.get("token") ?? "").trim().toLowerCase() || null;
  let includesToken: Record<string, unknown> | null = null;
  if (tokenQ) {
    const rows = await sql`
      select tk.address, h.network_id, c.name as chain, h.value
      from holdings_current h
      join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
      join chains c on c.network_id = h.network_id
      where h.handle = ${t.handle} and h.token_key = ${tokenQ}`;
    const priced = rows.filter((r) => (n(r.value) ?? 0) > 0);
    includesToken = {
      tokenAddress: rows[0]?.address ?? tokenQ,
      held: rows.length > 0,
      // Held but unpriced means it is in the portfolio and NOT in the total — the case
      // most likely to be read wrongly if we only returned a boolean.
      inTotal: priced.length > 0,
      valueUsd: priced.length ? round(priced.reduce((a, r) => a + (n(r.value) ?? 0), 0)) : null,
      chains: [...new Set(rows.map((r) => r.chain))],
      note: rows.length === 0 ? "this trader does not hold that token"
        : priced.length === 0 ? "held, but unpriced — it is NOT part of totalValueUsd"
        : "held and priced — it IS part of totalValueUsd",
    };
  }

  const [r] = await sql`
    select count(*)::int                                as positions,
           count(value) filter (where value > 0)::int   as priced,
           sum(value)   filter (where value > 0)        as total,
           max(value)   filter (where value > 0)        as top_value,
           sum(value)   filter (where value > 0 and q.token_key is not null) as cash
    from holdings_current h
    left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    where h.handle = ${t.handle}`;

  const positions = Number(r.positions);
  const priced = Number(r.priced);
  const total = n(r.total);
  const top = n(r.top_value);
  const cash = n(r.cash) ?? 0;

  const chainCoverage = byChain.map((r) => ({
    chain: r.chain,
    networkId: Number(r.network_id),
    positions: Number(r.positions),
    priced: Number(r.priced),
    valueUsd: Number(r.priced) ? round(n(r.value)) : null,
  }));

  const base = {
    handle: t.display_handle,
    name: t.name ?? null,
    // The measurement time of every money figure below.
    asOf,
    positions,
    concentration: null as number | null,
    topPosition: null as unknown,
    totalValueUsd: null as number | null,
    cashShare: null as number | null,
    coverage: {
      pricedPositions: priced,
      unpricedPositions: positions - priced,
      pricedShare: positions ? Number((priced / positions).toFixed(4)) : null,
    },
    byChain: chainCoverage,
    ...(includesToken ? { includesToken } : {}),
    partial: positions > 0 && priced / positions < 0.5,
    plain: positions === 0
      ? "No positions on record."
      : "Holds positions, but none of them have a usable price — we cannot say how concentrated this is.",
  };
  if (!priced || total === null || top === null || total <= 0) return base;

  const [tp] = await sql`
    select tk.address, h.network_id, h.value
    from holdings_current h
    join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    where h.handle = ${t.handle} and h.value > 0
    order by h.value desc limit 1`;

  const share = top / total;
  const pct = Math.round(share * 100);
  const unpriced = positions - priced;

  // The sentence exists because the ratio alone misleads: "118 positions" reads as
  // diversified when 98% of the money is in one of them.
  let plain: string;
  if (priced === 1) plain = "Everything is in a single coin — there is nothing to spread the risk.";
  else if (pct >= 90) plain = `Holds ${positions} coins, but ${pct}% of the money is in just one of them.`;
  else if (pct >= 50) plain = `Holds ${positions} coins, with ${pct}% of the money in the biggest one.`;
  else plain = `Holds ${positions} coins, spread fairly evenly — the biggest is ${pct}% of the money.`;

  // When most of the portfolio has no price, the caveat has to LEAD — a trailing footnote
  // would let a 98% figure stand on a fraction of the evidence.
  if (priced / positions < 0.5) {
    plain = `Only ${priced} of ${positions} positions have a usable price, so this is a ` +
            `partial picture. Of what we can see, ${pct}% sits in one coin.`;
  } else if (unpriced > 0) {
    plain += ` (${unpriced} position${unpriced === 1 ? "" : "s"} had no price and are excluded.)`;
  }

  return {
    ...base,
    concentration: Number(share.toFixed(4)),
    topPosition: tp
      ? { tokenAddress: tp.address, networkId: Number(tp.network_id), valueUsd: round(n(tp.value)) }
      : null,
    totalValueUsd: round(total),
    cashShare: Number((cash / total).toFixed(4)),
    plain,
  };
});

// ------------------------------------------------------------------- trust

get("/v1/traders/:handle/trust", async ({ handle }) => {
  const [t] = await sql`
    select t.handle, t.display_handle, t.name, s.pnl_usd, s.volume_usd, s.trade_count
    from traders t left join trader_stats_current s using (handle)
    where t.handle = ${handle.toLowerCase()}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const [h] = await sql`
    select count(*)::int as positions,
           count(value) filter (where value > 0)::int as priced,
           coalesce(sum(value) filter (where value > 0), 0) as holdings_value
    from holdings_current where handle = ${t.handle}`;

  const pnl = n(t.pnl_usd), volume = n(t.volume_usd), trades = n(t.trade_count);
  const holdingsValue = n(h.holdings_value) ?? 0;
  const positions = Number(h.positions), priced = Number(h.priced);

  const flags: { code: string; severity: string; plain: string }[] = [];
  const pnlToVolume = pnl !== null && volume !== null && volume > 0
    ? Number((pnl / volume).toFixed(2)) : null;
  const pnlToHoldings = pnl !== null && holdingsValue > 0
    ? Number((pnl / holdingsValue).toFixed(2)) : null;

  const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
  if (pnlToVolume !== null && pnlToVolume > 1) {
    flags.push({ code: "pnl_exceeds_volume", severity: "warn",
      plain: `Reported profit (${usd(pnl!)}) is larger than everything they have ever traded ` +
             `(${usd(volume!)}). That cannot come from trading alone.` });
  }
  if (pnlToHoldings !== null && pnlToHoldings > 10) {
    flags.push({ code: "pnl_exceeds_holdings", severity: "warn",
      plain: `Reported profit is ${Math.round(pnlToHoldings)}x the value of everything they ` +
             `currently hold — the money is not visible in the portfolio.` });
  }
  if (trades !== null && trades < 10) {
    flags.push({ code: "too_few_trades", severity: "warn",
      plain: `Only ${trades} trade${trades === 1 ? "" : "s"} on record — far too few to tell skill from luck.` });
  }
  if (positions > 0 && priced / positions < 0.5) {
    flags.push({ code: "partial_pricing", severity: "info",
      plain: `Only ${priced} of ${positions} positions have a usable price, so portfolio figures are incomplete.` });
  }

  const verdict = flags.some((f) => f.code === "pnl_exceeds_volume") ? "implausible"
    : flags.some((f) => f.code === "pnl_exceeds_holdings") ? "unverified"
    : flags.some((f) => f.code === "too_few_trades") ? "insufficient" : "ok";

  return {
    handle: t.display_handle, name: t.name ?? null,
    reportedPnlUsd: pnl, volumeUsd: volume,
    flags, pnlToVolume, pnlToHoldings, trades, verdict,
    plain: verdict === "implausible"
      ? "The reported profit does not reconcile with this trader's own trading volume. Treat it as unproven."
      : verdict === "unverified"
      ? "The reported profit is far larger than the portfolio we can see, so we cannot corroborate it."
      : verdict === "insufficient"
      ? "There is not enough trading history here to judge skill."
      : "Nothing in the numbers contradicts itself.",
  };
});

// ----------------------------------------------------------- the board

get("/v1/traders", async (_p, url) => {
  const q = (url.searchParams.get("q") ?? "").trim().replace(/^@/, "").toLowerCase();
  const askedLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(askedLimit) && askedLimit >= 1 ? Math.floor(askedLimit) : null;
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

  // Ranked by the leaderboard's own `rank`, and search scores exact > prefix > substring so
  // it matches the Node implementation rather than relying on Postgres text ranking.
  const rows = await sql`
    select t.handle, t.id, t.display_handle, t.name, t.avatar, t.last_seen_at,
           s.rank, s.pnl_usd, s.volume_usd, s.followers, s.trade_count, s.captured_at,
           case
             when ${q} = '' then 0
             when lower(t.display_handle) = ${q} or lower(coalesce(t.name,'')) = ${q} then 0
             when lower(t.display_handle) like ${q + "%"} or lower(coalesce(t.name,'')) like ${q + "%"} then 1
             else 2
           end as score
    from traders t
    left join trader_stats_current s using (handle)
    where ${q} = '' or lower(t.display_handle) like ${"%" + q + "%"}
                    or lower(coalesce(t.name,'')) like ${"%" + q + "%"}
    order by score, s.rank nulls last`;

  const [{ window_label, captured }] = await sql`
    select window_label, extract(epoch from captured_at)::bigint as captured
    from builds order by captured_at desc limit 1`;

  const page = limit === null ? rows.slice(offset) : rows.slice(offset, offset + limit);
  return {
    board: "traders",
    window: window_label ?? null,
    capturedAt: captured ? Number(captured) : null,
    count: page.length,
    // Present only when something was cut. A `total` equal to `count` says nothing and the
    // Node route omits it, so emitting it unconditionally is a difference, not a courtesy.
    ...(page.length < rows.length ? { total: rows.length } : {}),
    entries: page.map((r) => ({
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
      pnl: n(r.pnl_usd),
      volume: n(r.volume_usd),
      followers: r.followers ?? null,
      numTrades: r.trade_count ?? null,
      memberCount: null, marketCap: null, price: null, liquidity: null,
    })),
  };
});

// ------------------------------------------------------------ one trader

/**
 * A single trader, without picking a sub-resource first.
 *
 * `/v1/traders/:handle` returned 404 because only the sub-routes existed — the natural
 * first URL anyone tries was the one thing missing. This is a summary plus links, so the
 * response says what else can be asked about them rather than leaving it to be guessed.
 */
get("/v1/traders/:handle", async ({ handle }) => {
  const h = handle.toLowerCase();
  const [t] = await sql`
    select t.handle, t.id, t.display_handle, t.name, t.avatar, t.bio, t.twitter, t.verified,
           t.last_seen_at, s.captured_at,
           s.rank, s.pnl_usd, s.volume_usd, s.trade_count, s.followers,
           w.evm_address, w.sol_address
    from traders t
    left join trader_stats_current s using (handle)
    left join wallets w using (handle)
    where t.handle = ${h}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const [c] = await sql`
    select (select count(*) from holdings_current where handle = ${h})  as positions,
           (select count(*) from trades   where handle = ${h})          as trades,
           (select count(*) from transactions
             where address_key = any(${[t.evm_address, t.sol_address]
               .filter((a): a is string => !!a).map((a) => a.toLowerCase())})) as transfers`;

  return {
    // Stable across a fomo rename; `handle` is not guaranteed to be.
    id: t.id,
    handle: t.display_handle,
    name: t.name ?? null,
    rank: t.rank ?? null,
    verified: !!t.verified,
    updatedAt: t.captured_at ? new Date(String(t.captured_at)).toISOString() : null,
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
    },
  };
});

// ---------------------------------------------------------- T12 positions

get("/v1/traders/:handle/positions", async ({ handle }, url) => {
  const [t] = await sql`
    select handle, display_handle, name from traders where handle = ${handle.toLowerCase()}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const rows = await sql`
    select tk.address, h.network_id, c.name as chain, h.human_amount, h.price, h.value,
           (q.token_key is not null) as is_quote
    from holdings_current h
    join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    join chains c on c.network_id = h.network_id
    left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    where h.handle = ${t.handle}
    -- Priced rows first, descending. Unpriced rows TRAIL rather than being dropped: they
    -- are real holdings we simply cannot value, and hiding them would misstate the count.
    -- Address breaks the tie among the unpriced, which would otherwise be arbitrary.
    order by (case when h.value > 0 then h.value else null end) desc nulls last,
             lower(tk.address)`;

  const total = rows.reduce((s, r) => s + ((n(r.value) ?? 0) > 0 ? n(r.value)! : 0), 0);
  const all = rows.map((r) => {
    const v = (n(r.value) ?? 0) > 0 ? n(r.value) : null;
    return {
      tokenAddress: r.address,
      networkId: Number(r.network_id),
      chain: r.chain,
      amount: n(r.human_amount) ?? 0,
      priceUsd: n(r.price),
      // null, never 0 — 0 would imply we checked and found the position worthless.
      valueUsd: v === null ? null : round(v),
      share: v !== null && total > 0 ? Number((v / total).toFixed(4)) : null,
      isQuoteAsset: !!r.is_quote,
    };
  });

  const filtered = url.searchParams.get("includeQuote") === "false"
    ? all.filter((r) => !r.isQuoteAsset) : all;
  const askedLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(askedLimit) && askedLimit >= 1 ? Math.floor(askedLimit) : null;
  const page = limit === null ? filtered : filtered.slice(0, limit);
  const priced = all.filter((r) => r.valueUsd !== null).length;

  return {
    handle: t.display_handle,
    name: t.name ?? null,
    asOf: await asOfHoldings(),
    count: page.length,
    positions: filtered.length,
    totalValueUsd: total > 0 ? round(total) : null,
    coverage: { pricedPositions: priced, unpricedPositions: all.length - priced },
    entries: page,
  };
});

// ------------------------------------------------------- K1/K3/K4/K9 board

get("/v1/tokens", async (_p, url) => {
  const chainQ = (url.searchParams.get("chain") ?? "").trim().toLowerCase() || null;
  const net = await chainWhere(chainQ);
  const askedMin = Number(url.searchParams.get("minHolders"));
  const minHolders = Number.isFinite(askedMin) && askedMin >= 1 ? Math.floor(askedMin) : 1;

  const [{ traders: traderCount }] = await sql`select count(*)::int as traders from traders`;

  // Quote assets are excluded and it is NOT optional: 85 of 100 leaders "hold" USDC, so
  // leaving them in makes the top of the board the currency rather than a trade.
  const rows = await sql`
    select h.network_id, c.name as chain, tk.address,
           count(distinct h.handle)::int              as holders,
           sum(h.value) filter (where h.value > 0)    as total_value,
           count(h.value) filter (where h.value > 0)::int as priced,
           -- Biggest position first: who has conviction, not who sorted first. Unpriced
           -- counts as 0 (matching the Node path), and ties break on rank because JS sort
           -- is stable and the directory is ordered by rank.
           array_agg(h.handle order by coalesce(h.value, 0) desc, st.rank nulls last) as handles
    from holdings_current h
    join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    join chains c on c.network_id = h.network_id
    join trader_stats_current st on st.handle = h.handle
    left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    where q.token_key is null ${net === null ? sql`` : sql`and h.network_id = ${net}`}
    group by h.network_id, c.name, tk.address
    having count(distinct h.handle) >= ${minHolders}
    -- Address is the tiebreak, and it matters: hundreds of tokens tie on holder count with
    -- no price, so without it the board order is whatever the planner produced.
    order by holders desc, coalesce(sum(h.value) filter (where h.value > 0), 0) desc,
             lower(tk.address), h.network_id`;

  const [{ total_tokens }] = await sql`
    select count(*)::int as total_tokens from (
      select 1 from holdings_current h
      left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
      where q.token_key is null ${net === null ? sql`` : sql`and h.network_id = ${net}`}
      group by h.network_id, h.token_key) x`;

  const [ex] = await sql`
    select count(distinct (h.network_id, h.token_key))::int as tokens, count(*)::int as positions
    from holdings_current h
    join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    ${net === null ? sql`` : sql`where h.network_id = ${net}`}`;

  // display_handle, not the lowercased key — the board is read by people.
  const disp = new Map<string, string>();
  for (const r of await sql`select handle, display_handle from traders`) {
    disp.set(r.handle as string, r.display_handle as string);
  }

  const askedLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(askedLimit) && askedLimit >= 1 ? Math.floor(askedLimit) : null;
  const page = limit === null ? rows : rows.slice(0, limit);

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
    entries: page.map((r, i) => ({
      rank: i + 1,
      tokenAddress: r.address,
      networkId: Number(r.network_id),
      chain: r.chain,
      holders: Number(r.holders),
      holderShare: Number((Number(r.holders) / Number(traderCount)).toFixed(4)),
      totalValueUsd: Number(r.priced) ? round(n(r.total_value)) : null,
      holderHandles: [...new Set(r.handles as string[])].map((h) => disp.get(h) ?? h),
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
    select h.network_id, c.name as chain, tk.address, t.display_handle, h.human_amount, h.value
    from holdings_current h
    join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    join chains c on c.network_id = h.network_id
    join traders t on t.handle = h.handle
    join trader_stats_current st on st.handle = h.handle
    where h.token_key = ${key} ${net === null ? sql`` : sql`and h.network_id = ${net}`}
    order by (case when h.value > 0 then h.value else null end) desc nulls last,
             t.display_handle`;

  if (!rows.length) {
    throw notFound(`no leader holds '${address}'${chainQ ? ` on ${chainQ}` : ""}`);
  }
  const [{ traders: traderCount }] = await sql`select count(*)::int as traders from traders`;

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
        holders,
        holderShare: Number((holders / Number(traderCount)).toFixed(4)),
        totalValueUsd: priced.length ? round(total) : null,
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

// ============================================================================
// The three below are NOT ports. The Express versions call fomoapi live on every
// request; these read the `trades` table the loader fills once a day. That is the
// whole point of the migration — and it is what turns K5-K8 from a 25-holder,
// 45-second fan-out into a query over all 896 rankable tokens.
// ============================================================================

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const cov = (of: number, total: number) => ({
  of, total, share: total ? Number((of / total).toFixed(4)) : null,
});
const money = (v: number) =>
  `${v < 0 ? "-" : ""}$${Math.abs(Math.round(v)).toLocaleString("en-US")}`;

// ------------------------------------------------ T2, T3, T5-T10, T15-T20

get("/v1/traders/:handle/scorecard", async ({ handle }, url) => {
  const [t] = await sql`
    select t.handle, t.display_handle, t.name, s.volume_usd, s.trade_count
    from traders t left join trader_stats_current s using (handle)
    where t.handle = ${handle.toLowerCase()}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const rows = await sql`
    select tr.trade_id, tr.network_id, tr.token_address, tr.token_key, tr.token_symbol,
           tr.status, tr.amount, tr.avg_entry_price, tr.avg_exit_price,
           tr.realized_pnl_usd, tr.unrealized_pnl_usd, tr.opened_at, tr.closed_at, tr.captured_at,
           tk.total_supply, tk.supply_source, tk.supply_read_at
    from trades tr
    left join tokens tk on tk.network_id = tr.network_id and tk.token_key = tr.token_key
    where tr.handle = ${t.handle}`;

  if (!rows.length) throw notFound(`no stored trades for '${t.handle}'`);

  const closed = rows.filter((r) => r.status === "closed");
  const realized = closed.map((r) => n(r.realized_pnl_usd)).filter((x): x is number => x !== null);

  const wins = realized.filter((x) => x > 0).length;
  const losses = realized.filter((x) => x < 0).length;
  const breakeven = realized.filter((x) => x === 0).length;
  const winRate = realized.length ? Number((wins / realized.length).toFixed(4)) : null;

  const best = realized.length ? Math.max(...realized) : null;
  const worst = realized.length ? Math.min(...realized) : null;
  // Denominator is GROSS gains. A net total can be zero or negative, which is exactly how
  // a "share of profit" ends up reading 2000%.
  const gains = realized.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const topTradeShare = best !== null && best > 0 && gains > 0
    ? Number((best / gains).toFixed(4)) : null;

  const meanTrade = realized.length ? realized.reduce((a, b) => a + b, 0) / realized.length : null;
  const medTrade = median(realized);
  // Same sign discipline as everywhere else: a mean of -$8,368 over a median of $0.15
  // yields "-56,822x", which is arithmetically true and informationally worthless.
  const meanToMedian = meanTrade !== null && medTrade !== null && meanTrade > 0 && medTrade > 0
    ? Number((meanTrade / medTrade).toFixed(2)) : null;

  const entryRows = rows
    .map((r) => ({ amount: n(r.amount), px: n(r.avg_entry_price) }))
    .filter((r): r is { amount: number; px: number } => r.amount !== null && r.px !== null && r.px > 0);
  const exitRows = rows
    .map((r) => ({ amount: n(r.amount), px: n(r.avg_exit_price) }))
    .filter((r): r is { amount: number; px: number } => r.amount !== null && r.px !== null && r.px > 0);
  const inCov = cov(entryRows.length, rows.length);
  const outCov = cov(exitRows.length, rows.length);

  const closedPriced = closed
    .map((r) => ({ amount: n(r.amount), px: n(r.avg_entry_price), pnl: n(r.realized_pnl_usd) }))
    .filter((r): r is { amount: number; px: number; pnl: number } =>
      r.amount !== null && r.px !== null && r.px > 0 && r.pnl !== null);
  const basis = closedPriced.reduce((s, r) => s + r.amount * r.px, 0);
  const closedPnl = closedPriced.reduce((s, r) => s + r.pnl, 0);

  const betSizes = entryRows.map((r) => r.amount * r.px).filter((x) => x > 0);
  // A median over a handful of rows is not a typical anything. Below a third of the record,
  // fall back to the directory's lifetime volume/trades and SAY which was used.
  let bet: { value: number | null; method: string | null; coverage: ReturnType<typeof cov> };
  if (betSizes.length >= 5 && inCov.share !== null && inCov.share >= 0.33) {
    bet = { value: round(median(betSizes)), method: "entry_price", coverage: inCov };
  } else if (n(t.volume_usd) && n(t.trade_count)) {
    bet = { value: round(n(t.volume_usd)! / n(t.trade_count)!), method: "volume_per_trade", coverage: inCov };
  } else bet = { value: null, method: null, coverage: inCov };

  const ms = (v: unknown) => (v ? Date.parse(String(v)) : null);
  const holds = closed
    .map((r) => ({ a: ms(r.opened_at), b: ms(r.closed_at) }))
    .filter((r): r is { a: number; b: number } => r.a !== null && r.b !== null && r.b >= r.a)
    .map((r) => r.b - r.a);
  const medHold = median(holds);

  const opened = rows.map((r) => ms(r.opened_at)).filter((x): x is number => x !== null);
  const allTimes = [...opened, ...rows.map((r) => ms(r.closed_at)).filter((x): x is number => x !== null)];
  const firstAt = opened.length ? Math.min(...opened) : null;
  const lastAt = allTimes.length ? Math.max(...allTimes) : null;
  const spanDays = firstAt !== null && lastAt !== null ? (lastAt - firstAt) / 86_400_000 : null;

  const byTokenMap = new Map<string, {
    symbol: string | null; address: string | null; trades: number; closed: number;
    realizedPnlUsd: number; unrealizedPnlUsd: number;
    avgEntryPrice: number | null; avgExitPrice: number | null;
    totalSupply: number | null; supplySource: string | null; supplyReadAt: string | null;
  }>();
  for (const r of rows) {
    const key = String(r.token_key ?? r.token_symbol ?? "unknown");
    const rec = byTokenMap.get(key) ?? {
      symbol: (r.token_symbol as string) ?? null, address: (r.token_address as string) ?? null,
      trades: 0, closed: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0,
      avgEntryPrice: null, avgExitPrice: null,
      totalSupply: n(r.total_supply), supplySource: (r.supply_source as string) ?? null,
      supplyReadAt: r.supply_read_at ? new Date(String(r.supply_read_at)).toISOString() : null,
    };
    rec.trades++;
    if (r.status === "closed") { rec.closed++; rec.realizedPnlUsd += n(r.realized_pnl_usd) ?? 0; }
    else rec.unrealizedPnlUsd += n(r.unrealized_pnl_usd) ?? 0;
    // The loader already stores fomo's `0` as NULL, because a $0 entry price implies
    // someone got in for nothing.
    if (rec.avgEntryPrice === null) rec.avgEntryPrice = n(r.avg_entry_price);
    if (rec.avgExitPrice === null) rec.avgExitPrice = n(r.avg_exit_price);
    byTokenMap.set(key, rec);
  }
  const byToken = [...byTokenMap.values()]
    .map((r) => ({
      ...r,
      realizedPnlUsd: round(r.realizedPnlUsd)!,
      unrealizedPnlUsd: round(r.unrealizedPnlUsd)!,
      /**
       * Entry expressed as a MARKET CAP, which is how it is read on screen.
       *
       * null — never 0 — when either the price or the supply is unknown. A trader whose
       * entry we cannot establish must not appear to have got in for nothing.
       *
       * `supply` and `supplyReadAt` travel with it deliberately: supply on these tokens
       * moves (one was measured drifting 12.45% in a day), so publishing only the cap would
       * make our number and a consumer's recomputation disagree with no way to tell which
       * was right. Sending the multiplier we used makes them reconcilable.
       */
      avgEntryMarketCapUsd:
        r.avgEntryPrice !== null && r.totalSupply !== null && r.totalSupply > 0
          ? Number((r.avgEntryPrice * r.totalSupply).toPrecision(10))
          : null,
      avgExitMarketCapUsd:
        r.avgExitPrice !== null && r.totalSupply !== null && r.totalSupply > 0
          ? Number((r.avgExitPrice * r.totalSupply).toPrecision(10))
          : null,
    }))
    .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd ||
                    b.unrealizedPnlUsd - a.unrealizedPnlUsd ||
                    String(a.address).localeCompare(String(b.address)));

  const caveats: string[] = [];
  if (inCov.share !== null && inCov.share < 0.5) {
    caveats.push(`Entry prices are present on only ${entryRows.length} of ${rows.length} trades, ` +
      `so money-in, return % and typical bet size are computed from a minority of the record.`);
  }
  if (entryRows.length !== exitRows.length) {
    caveats.push(`Money-in covers ${entryRows.length} trades and money-out covers ${exitRows.length} ` +
      `— different subsets of the record. The difference between them is NOT a profit figure.`);
  }

  let plain: string;
  if (winRate === null) {
    plain = `${rows.length} trades on record, but none are closed yet — there is no win rate to report.`;
  } else {
    const net = realized.reduce((a, b) => a + b, 0);
    // The net travels with the win rate, ALWAYS. 56% wins alongside a net of -$209,204 is
    // the exact shape of misleading headline this API exists to avoid.
    plain = `Closed ${realized.length} trades and made money on ${wins} of them ` +
            `(${Math.round(winRate * 100)}%), for a net of ${money(net)}.`;
    if (topTradeShare !== null && topTradeShare >= 0.5) {
      plain += ` ${Math.round(topTradeShare * 100)}% of the gains came from a single trade.`;
    }
    if (medHold !== null) {
      plain += ` Typically holds for ${medHold / 86_400_000 >= 1
        ? `${(medHold / 86_400_000).toFixed(1)} days` : `${Math.round(medHold / 3_600_000)} hours`}.`;
    }
  }

  /**
   * T4 — profit by window.
   *
   * Previously marked unavailable because the leaderboard gives one lifetime `pnl` per
   * trader with nothing to slice it by. Storing per-trade history changed that: every
   * closed trade carries `closed_at`, so a window is a WHERE clause.
   *
   * This is REALIZED profit only — money actually taken off the table in that period.
   * Including unrealised movement would need historical prices we do not store, and given
   * T1 exists precisely to separate banked from on-paper, realized-only is the more
   * truthful reading anyway. `basis` says so in the response rather than leaving it implied.
   */
  const [w] = await sql`
    select coalesce(sum(realized_pnl_usd) filter (where closed_at > now() - interval '24 hours'), 0) as d1,
           count(*) filter (where closed_at > now() - interval '24 hours')::int  as n1,
           coalesce(sum(realized_pnl_usd) filter (where closed_at > now() - interval '7 days'), 0)   as d7,
           count(*) filter (where closed_at > now() - interval '7 days')::int    as n7,
           coalesce(sum(realized_pnl_usd) filter (where closed_at > now() - interval '30 days'), 0)  as d30,
           count(*) filter (where closed_at > now() - interval '30 days')::int   as n30,
           coalesce(sum(realized_pnl_usd), 0) as all_time,
           count(*)::int as n_all
    from trades where handle = ${t.handle} and status = 'closed' and closed_at is not null`;

  const windows = {
    basis: "realized profit only — closed trades, summed by closed_at. Unrealised movement " +
           "is not included; see /pnl for banked versus on paper.",
    "24h": { realizedUsd: round(n(w.d1)), closedTrades: Number(w.n1) },
    "7d":  { realizedUsd: round(n(w.d7)), closedTrades: Number(w.n7) },
    "30d": { realizedUsd: round(n(w.d30)), closedTrades: Number(w.n30) },
    all:   { realizedUsd: round(n(w.all_time)), closedTrades: Number(w.n_all) },
  };

  const askedTokens = Number(url.searchParams.get("tokens"));
  const tokenLimit = Number.isFinite(askedTokens) && askedTokens >= 1 ? Math.floor(askedTokens) : null;

  return {
    handle: t.display_handle, name: t.name ?? null,
    source: "postgres · trades (loaded from fomoapi)",
    asOf: await asOfTrades(),
    sample: { returned: rows.length, storedAt: rows[0]?.captured_at ?? null },
    winRate, wins, losses, breakeven,
    bestTradeUsd: round(best), worstTradeUsd: round(worst),
    topTradeShare, meanToMedian,
    meanTradeUsd: round(meanTrade), medianTradeUsd: round(medTrade),
    moneyIn: { usd: entryRows.length ? round(entryRows.reduce((s, r) => s + r.amount * r.px, 0)) : null, coverage: inCov },
    moneyOut: { usd: exitRows.length ? round(exitRows.reduce((s, r) => s + r.amount * r.px, 0)) : null, coverage: outCov },
    returnPct: { value: basis > 0 ? Number(((closedPnl / basis) * 100).toFixed(2)) : null,
                 coverage: cov(closedPriced.length, closed.length) },
    typicalBetUsd: bet,
    holdingTime: {
      medianHours: medHold === null ? null : Number((medHold / 3_600_000).toFixed(2)),
      medianDays: medHold === null ? null : Number((medHold / 86_400_000).toFixed(2)),
      coverage: cov(holds.length, closed.length),
    },
    lastTradeAt: lastAt === null ? null : new Date(lastAt).toISOString(),
    firstTradeAt: firstAt === null ? null : new Date(firstAt).toISOString(),
    trackRecordDays: spanDays === null ? null : Number(spanDays.toFixed(1)),
    tradesPerDay: spanDays !== null && spanDays >= 1 ? Number((rows.length / spanDays).toFixed(2)) : null,
    /**
     * What the per-token averages mean, stated rather than left to be guessed. Two
     * reasonable definitions give different numbers, and the consumer has to label the
     * figure on screen.
     */
    entryBasis: {
      scope: "all buys on record for this trader and token",
      sellsReduceIt: false,
      note: "fomoapi supplies one avgEntryPrice per trade; we surface the first non-zero " +
            "value per token and do not re-average across trades. A sell does not change it.",
      marketCap: "avgEntryPrice x tokens.total_supply, both returned so the figure can be rechecked",
    },
    windows,
    tokensTotal: byToken.length,
    byToken: tokenLimit === null ? byToken : byToken.slice(0, tokenLimit),
    plain, caveats,
  };
});

// ------------------------------------------------------------ K5-K8 (SQL)

get("/v1/tokens/:address/activity", async ({ address }, url) => {
  const chainQ = (url.searchParams.get("chain") ?? "").trim().toLowerCase() || null;
  const net = await chainWhere(chainQ);
  const key = address.toLowerCase();

  const holders = await sql`
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
  const per = await sql`
    select t.display_handle as handle,
           count(*)::int                                          as trades,
           count(*) filter (where tr.status = 'closed')::int       as closed,
           coalesce(sum(tr.realized_pnl_usd)
                    filter (where tr.status = 'closed'), 0)        as realized,
           coalesce(sum(tr.unrealized_pnl_usd)
                    filter (where tr.status <> 'closed'), 0)       as unrealized,
           min(tr.avg_entry_price) filter (where tr.avg_entry_price > 0) as entry,
           min(tr.avg_exit_price)  filter (where tr.avg_exit_price  > 0) as exit,
           min(tr.opened_at)                                       as first_buy,
           max(tr.closed_at)                                       as last_sell
    from trades tr join traders t on t.handle = tr.handle
    where tr.token_key = ${key}
    group by t.display_handle
    order by realized desc, t.display_handle`;

  const withClosed = per.filter((r) => Number(r.closed) > 0);
  const winners = withClosed.filter((r) => (n(r.realized) ?? 0) > 0).length;
  const losers = withClosed.filter((r) => (n(r.realized) ?? 0) < 0).length;
  const entries = per.map((r) => n(r.entry)).filter((x): x is number => x !== null && x > 0);

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
    asOf: await asOfTrades(),
    totalValueUsd: priced.length ? round(priced.reduce((s, h) => s + (n(h.value) ?? 0), 0)) : null,
    source: "postgres · trades",
    /**
     * Two different populations, kept apart on purpose.
     *
     * `holdersNow` is who holds it in the current snapshot. `withTradeRecord` is everyone
     * who has ever traded it — which can be LARGER, because traders who sold out entirely
     * no longer hold it but very much have a record. The Express route conflated them
     * under one "sampled" count, which read as nonsense (30 of 12).
     *
     * `capped` and `failed` are gone: there is no sample and no fan-out to fail.
     */
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
    },
    flow: { opened, closed: closedTotal, verdict: flow },
    realizedPnlUsd: round(per.reduce((s, r) => s + (n(r.realized) ?? 0), 0)),
    unrealizedPnlUsd: round(per.reduce((s, r) => s + (n(r.unrealized) ?? 0), 0)),
    perHolder: per.map((r) => ({
      handle: r.handle, trades: Number(r.trades), closed: Number(r.closed),
      realizedPnlUsd: round(n(r.realized)), unrealizedPnlUsd: round(n(r.unrealized)),
      avgEntryPrice: n(r.entry), avgExitPrice: n(r.exit),
      firstBuyAt: r.first_buy ?? null, lastSellAt: r.last_sell ?? null,
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

  const rows = await sql`
    with a as (select network_id, token_key, array_agg(handle) as handles
               from holdings where captured_at = ${from} group by 1,2),
         b as (select network_id, token_key, array_agg(handle) as handles
               from holdings where captured_at = ${to} group by 1,2)
    select coalesce(a.network_id, b.network_id) as network_id,
           coalesce(a.token_key, b.token_key)   as token_key,
           coalesce(array_length(b.handles,1),0) as holders,
           coalesce(array_length(a.handles,1),0) as previous_holders,
           coalesce(b.handles,'{}') as now_handles, coalesce(a.handles,'{}') as before_handles
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
  for (const r of await sql`select network_id, token_key, address from tokens`) {
    addrs.set(`${r.network_id}:${r.token_key}`, r.address as string);
  }

  const moved = rows.flatMap((r) => {
    const now = new Set(r.now_handles as string[]);
    const before = new Set(r.before_handles as string[]);
    const gained = [...now].filter((h) => !before.has(h));
    const lost = [...before].filter((h) => !now.has(h));
    if (!gained.length && !lost.length) return [];
    const net = Number(r.network_id);
    const change = Number(r.holders) - Number(r.previous_holders);
    return [{
      tokenAddress: addrs.get(`${net}:${r.token_key}`) ?? r.token_key,
      networkId: net, chain: chains.get(net) ?? String(net),
      holders: Number(r.holders), previousHolders: Number(r.previous_holders), change,
      gained: gained.map((h) => disp.get(h) ?? h), lost: lost.map((h) => disp.get(h) ?? h),
      isNew: Number(r.previous_holders) === 0,
      plain: Number(r.previous_holders) === 0
        ? `New — ${r.holders} leader${Number(r.holders) === 1 ? "" : "s"} opened a position since the last snapshot.`
        : change > 0 ? `+${change} holders (${r.previous_holders} to ${r.holders}).`
        : change < 0 ? `${change} holders (${r.previous_holders} to ${r.holders}).`
        : `Same holder count, but ${gained.length} in and ${lost.length} out.`,
    }];
  }).sort((a, b) => b.change - a.change || b.holders - a.holders ||
                    a.tokenAddress.localeCompare(b.tokenAddress));

  const filtered = dir === "in" ? moved.filter((r) => r.change > 0)
    : dir === "out" ? moved.filter((r) => r.change < 0) : moved;
  const askedLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(askedLimit) && askedLimit >= 1 ? Math.floor(askedLimit) : null;

  return {
    board: "momentum", available: true, snapshots: gens.length,
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

// --------------------------------------------------- transactions, from the DB

get("/v1/traders/:handle/transactions", async ({ handle }, url) => {
  const [t] = await sql`
    select t.handle, t.display_handle, t.name, w.evm_address, w.sol_address
    from traders t left join wallets w using (handle)
    where t.handle = ${handle.toLowerCase()}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const chainQ = (url.searchParams.get("chain") ?? "").trim().toLowerCase() || null;
  const net = await chainWhere(chainQ);
  const askedLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(askedLimit) && askedLimit >= 1 ? Math.min(Math.floor(askedLimit), 500) : 50;

  const keys = [t.evm_address, t.sol_address]
    .filter((a): a is string => !!a).map((a) => a.toLowerCase());
  if (!keys.length) {
    return {
      handle: t.display_handle, name: t.name ?? null,
      wallets: { evm: null, solana: null },
      count: 0, transfers: [],
      plain: "No wallet address on record for this trader, so there is nothing to look up.",
    };
  }

  /**
   * ?kind=swap returns only rows a provider classified as a swap.
   *
   * The review's sharpest point was that an inbound transfer is not a purchase — it is just
   * as likely a self-transfer between the trader's own wallets. `tx_type` now carries the
   * provider's own classification, so "show me actual trades" is finally answerable rather
   * than being left to the caller to guess at.
   *
   * Rows ingested before that column existed have tx_type NULL and are EXCLUDED from a
   * ?kind filter — absent, not assumed. Unfiltered requests still return everything.
   */
  const kind = (url.searchParams.get("kind") ?? "").trim().toLowerCase() || null;
  if (kind && !["swap", "transfer"].includes(kind)) {
    throw badRequest(`unknown kind '${kind}' — use 'swap' or 'transfer'`);
  }

  const rows = await sql`
    select tx.network_id, c.name as chain, tx.tx_hash, tx.block_time, tx.direction,
           tx.counterparty, tx.token_key, tx.token_symbol, tx.amount, tx.source,
           tx.tx_type, tx.tx_source
    from transactions tx join chains c using (network_id)
    where tx.address_key = any(${keys})
      ${net === null ? sql`` : sql`and tx.network_id = ${net}`}
      ${kind === null ? sql`` : sql`and upper(tx.tx_type) = ${kind.toUpperCase()}`}
    order by tx.block_time desc nulls last, tx.tx_hash
    limit ${limit}`;

  // What the store actually holds for this trader, so "no rows" can be told apart from
  // "we never fetched this chain". A count of zero with a populated store is a real
  // finding; a count of zero with an empty store is a gap in ingestion.
  const [stored] = await sql`
    select count(*)::int as total, max(block_time) as newest, min(block_time) as oldest
    from transactions where address_key = any(${keys})`;

  return {
    handle: t.display_handle,
    name: t.name ?? null,
    wallets: { evm: t.evm_address ?? null, solana: t.sol_address ?? null },
    source: "postgres · transactions",
    asOf: stored.newest ? new Date(String(stored.newest)).toISOString() : null,
    /**
     * What this feed is, said plainly, because it is easy to mistake for something else.
     *
     * These are TRANSFERS, not trades. An incoming transfer is not a purchase — it is
     * just as likely someone moving coins between their own wallets, and most rows come
     * back `side: "in"` for exactly that reason. There is no USD value or price on a row
     * because the providers do not give one and we will not invent it.
     *
     * For buy/sell with P&L and entry/exit prices, use /traders/:handle/scorecard, which
     * reads fomo's trade records rather than raw chain movement.
     */
    feed: "transfers",
    caveats: {
      notTrades: "an inbound transfer is commonly a self-transfer between the trader's own " +
                 "wallets, not a purchase. Use ?kind=swap for rows a provider classified as " +
                 "an actual trade, and read `kind` on each row.",
      noUsdValue: "providers do not return a USD value or price per transfer, so none is published",
      limitIsTotal: "limit caps the whole result set, not per chain",
      forTrades: "/traders/" + t.display_handle + "/scorecard",
    },
    stored: {
      total: Number(stored.total),
      newest: stored.newest ?? null,
      oldest: stored.oldest ?? null,
    },
    count: rows.length,
    limit,
    kindFilter: kind ?? "all",
    transfers: rows.map((r) => ({
      chain: r.chain,
      networkId: Number(r.network_id),
      tx_hash: r.tx_hash,
      time: r.block_time ?? null,
      side: r.direction ?? null,
      // Null where no trade record has taught us the symbol yet; the contract is always
      // present, so a consumer always has something to key on.
      token: r.token_symbol ?? null,
      contract: r.token_key ?? null,
      amount: n(r.amount),
      counterparty: r.counterparty ?? null,
      source: r.source,
      // The provider's classification. A SWAP is a trade; a TRANSFER very often is not.
      // NULL on rows ingested before this was captured — absent, not "unknown".
      kind: r.tx_type ?? null,
      protocol: r.tx_source ?? null,
    })),
    plain: Number(stored.total) === 0
      ? "Nothing stored for this trader's wallets yet — the backfill has not covered them."
      : `${stored.total.toLocaleString()} transfers stored; showing the ${rows.length} most recent.`,
  };
});

// ------------------------------------------------------------------ health

get("/v1/health", async () => {
  const [c] = await sql`
    select (select count(*) from traders)                        as traders,
           (select count(*) from holdings_current)               as holdings,
           (select count(*) from tokens)                         as tokens,
           (select count(*) from trades)                         as trades,
           (select count(*) from transactions)                   as transactions,
           (select count(distinct handle) from wallets)          as wallets,
           (select count(distinct captured_at) from holdings)    as generations`;
  const [b] = await sql`
    select captured_at, window_label from builds order by captured_at desc limit 1`;

  return {
    status: "ok",
    runtime: "supabase edge function (deno)",
    source: "postgres",
    build: { capturedAt: b?.captured_at ?? null, window: b?.window_label ?? null },
    rows: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number(v)])),
    // Every route here answers from Postgres. Nothing in the request path calls fomoapi,
    // Helius, Bitquery or Etherscan — those keys belong to the scheduled loaders.
    externalCallsPerRequest: 0,
  };
});

// ----------------------------------------------------------------- wallets

get("/v1/traders/:handle/wallets", async ({ handle }) => {
  const [t] = await sql`
    select t.handle, t.display_handle, t.name, t.bio, t.avatar, t.twitter,
           w.evm_address, w.sol_address, w.evm_source, w.sol_source,
           w.evm_confidence, w.sol_confidence
    from traders t left join wallets w using (handle)
    where t.handle = ${handle.toLowerCase()}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  // Shape-checked before publishing. fomo's own evm/sol fields are empty for all 100
  // traders; these come from fomoapi's resolution and are REPORTED, not verified — see
  // PARAMETERS.md section 5. Verification writes into the *_confidence columns.
  const ok = (a: string | null) =>
    !!a && (/^0x[0-9a-fA-F]{40}$/.test(a.trim()) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a.trim()));
  const bad = [t.evm_address, t.sol_address].filter((a) => a && !ok(a as string)).length;

  return {
    handle: t.display_handle,
    name: t.name ?? null,
    bio: nonEmpty(t.bio as string | null),
    banner: null,
    profilePicture: nonEmpty(t.avatar as string | null),
    twitter: nonEmpty(t.twitter as string | null),
    solanaAddress: ok(t.sol_address as string) ? t.sol_address : null,
    evmAddress: ok(t.evm_address as string) ? t.evm_address : null,
    source: t.evm_source ?? t.sol_source ?? null,
    tier: (t.evm_confidence || t.sol_confidence) ? "verified" : "reported",
    confidence: { evm: t.evm_confidence ?? null, solana: t.sol_confidence ?? null },
    ...(bad ? { warning: `${bad} stored address(es) are malformed and were withheld` } : {}),
  };
});

// ------------------------------------------------------ T1 banked vs on paper

get("/v1/traders/:handle/pnl", async ({ handle }) => {
  const [t] = await sql`
    select handle, display_handle, name from traders where handle = ${handle.toLowerCase()}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const [r] = await sql`
    select count(*) filter (where status = 'closed')::int  as closed,
           count(*) filter (where status <> 'closed')::int as open,
           coalesce(sum(realized_pnl_usd)   filter (where status = 'closed'), 0)  as realized,
           coalesce(sum(unrealized_pnl_usd) filter (where status <> 'closed'), 0) as unrealized,
           max(captured_at) as captured
    from trades where handle = ${t.handle}`;

  const closed = Number(r.closed), open = Number(r.open);
  const realized = n(r.realized) ?? 0, unrealized = n(r.unrealized) ?? 0;
  const any = closed + open > 0;

  /**
   * Sign discipline. A naive `total !== 0` guard lets realized -$8,000 and unrealized
   * -$2,000 render as "80% banked" for a trader who LOST $10,000. A share is emitted only
   * when both sides are positive; every other case gets the dollar figures and no ratio.
   */
  const share = any && realized > 0 && unrealized > 0
    ? Number((realized / (realized + unrealized)).toFixed(4)) : null;

  let plain: string;
  if (!any) plain = "No trades on record for this trader.";
  else if (share !== null) {
    plain = `Cashed out ${money(realized)} across ${closed} closed trades. ` +
            `${money(unrealized)} is still on paper in ${open} open position${open === 1 ? "" : "s"} ` +
            `— ${Math.round(share * 100)}% of the total is actually banked.`;
  } else if (realized > 0) {
    plain = `Cashed out ${money(realized)} across ${closed} closed trades, and is currently down ` +
            `${money(Math.abs(unrealized))} on open positions.`;
  } else if (unrealized > 0) {
    plain = `${money(unrealized)} of gains are on paper only — nothing has been banked yet ` +
            `across ${closed} closed trades.`;
  } else {
    plain = `Down ${money(Math.abs(realized))} on closed trades and ` +
            `${money(Math.abs(unrealized))} on open ones.`;
  }

  return {
    handle: t.display_handle, name: t.name ?? null,
    source: "postgres · trades",
    bankedUsd: any ? round(realized) : null,
    closedTrades: closed,
    onPaperUsd: any ? round(unrealized) : null,
    openPositions: open,
    realizedShare: share,
    capturedAt: r.captured ?? null,
    plain,
  };
});
