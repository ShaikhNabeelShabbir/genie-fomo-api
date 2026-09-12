import { sql, n, round } from "./db.ts";
import { includeUnavailable } from "./errors.ts";

/**
 * When the underlying data was measured.
 *
 * Every money figure this API returns carries one. A dollar amount with no age goes stale
 * silently and a consumer cannot tell a fresh total from yesterday's — which is the whole
 * point of the field, so it is computed once here rather than per route.
 */
export const asOfHoldings = async (handle?: string): Promise<string | null> => {
  const [r] = handle
    ? await sql`select max(captured_at) as at from holdings_current where handle = ${handle}`
    : await sql`select max(captured_at) as at from holdings_current`;
  return r?.at ? new Date(String(r.at)).toISOString() : null;
};
/**
 * When THIS trader's trade records were measured — not the board's.
 *
 * The unscoped version reported `max(captured_at)` across all 114 traders, so a trader last
 * refreshed two days ago still showed today's timestamp on their own page. That is exactly
 * the failure the consuming team reported against /v1/traders ("we cannot tell a trader
 * refreshed a minute ago from one refreshed a day ago"), which was fixed there with a
 * per-trader `updatedAt` and then quietly reintroduced here.
 *
 * Passing no handle keeps the board-wide value, which is the right answer only for
 * board-wide questions.
 */
export const asOfTrades = async (handle?: string): Promise<string | null> => {
  const [r] = handle
    ? await sql`select max(captured_at) as at from trades where handle = ${handle}`
    : await sql`select max(captured_at) as at from trades`;
  return r?.at ? new Date(String(r.at)).toISOString() : null;
};

/** Freshness of the trade records behind one token, for the K5-K8 route. */
export const asOfToken = async (tokenKey: string): Promise<string | null> => {
  const [r] = await sql`select max(captured_at) as at from trades where token_key = ${tokenKey}`;
  return r?.at ? new Date(String(r.at)).toISOString() : null;
};


/**
 * Read an integer query parameter, or reject it.
 *
 * The old pattern was `Number(url.searchParams.get("limit"))` guarded by `isFinite`, which
 * silently treated anything unparseable as "not supplied" — so `?limit=abc` returned 200 and
 * the whole list, and `?offset=abc` was ignored. A typo produced a full table scan and a
 * confidently wrong page rather than an error naming the mistake.
 *
 * Absent still means the default: `?limit=` omitted returns everything, which is documented.
 * PRESENT-but-invalid is what now fails, because that is a caller error and silence hides it.
 */
function intParam(
  url: URL,
  name: string,
  opts: { min?: number; max?: number; fallback: number | null },
): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return opts.fallback;

  const v = Number(raw);
  const min = opts.min ?? 0;
  if (!Number.isFinite(v) || !Number.isInteger(v)) {
    throw badRequest(`'${name}' must be a whole number — got '${raw}'`, { parameter: name });
  }
  if (v < min) {
    throw badRequest(`'${name}' must be at least ${min} — got ${v}`, { parameter: name });
  }
  return opts.max !== undefined ? Math.min(v, opts.max) : v;
}

/**
 * T1.5. A decimal bound, for range filters over money columns.
 *
 * Separate from `intParam` because P&L and volume are `numeric` and a caller filtering on
 * `minPnl=1000.50` should not be told it must be a whole number. Same strictness otherwise:
 * BUG-3 established that a parameter we cannot parse is a 400, never a silent default, since
 * an ignored filter returns MORE rows than asked for and looks like data rather than an error.
 */
function numParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    throw badRequest(`'${name}' must be a number — got '${raw}'`, { parameter: name });
  }
  return v;
}

/**
 * Resolve `?orderBy=` against a whitelist.
 *
 * The value never reaches SQL. It selects a pre-written fragment, so an unknown key is a 400
 * naming the valid set rather than anything that could reach the planner.
 *
 * Ordering direction applies ONLY to the chosen column. Every sort keeps its existing
 * tiebreak, unreversed, because T1.4's cursors resume through a total order — a sort that
 * ties would make pagination skip and repeat rows again, which is the bug that item existed
 * to fix.
 */
function sortParam(
  url: URL,
  allowed: readonly string[],
  fallback: string,
  /** Per-key default direction. A key absent here defaults to descending. */
  ascByDefault: readonly string[] = [],
): { key: string; desc: boolean } {
  const raw = (url.searchParams.get("orderBy") ?? "").trim();
  const key = raw === "" ? fallback : raw;
  if (!allowed.includes(key)) {
    throw badRequest(`unknown orderBy '${raw}'`, { parameter: "orderBy", valid: allowed });
  }
  const dirRaw = (url.searchParams.get("direction") ?? "").trim().toLowerCase();
  if (dirRaw !== "" && dirRaw !== "asc" && dirRaw !== "desc") {
    throw badRequest(`direction must be 'asc' or 'desc' — got '${dirRaw}'`,
      { parameter: "direction" });
  }
  // Most metrics descend by default because "most" is the interesting end. Rank is the
  // exception and has to be declared, not inferred: rank 1 is the BEST trader, so defaulting
  // it to descending would put the worst of the board first.
  if (dirRaw === "") return { key, desc: !ascByDefault.includes(key) };
  return { key, desc: dirRaw === "desc" };
}

/** '' is not a value. The columns store empty strings where fomo gave nothing. */
const nonEmpty = (v: string | null | undefined): string | null =>
  v && v.trim() ? v.trim() : null;
import { get, post } from "./router.ts";
import { notFound, badRequest, ApiError } from "./errors.ts";

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
            /**
             * A chain can show `pricedShare: 0` and a dollar profit at the same time, and
             * that looks like a contradiction unless the response says where each number
             * comes from. Profit is fomo's REPORTED trade records; pricing is the holdings
             * snapshot. Different sources, different completeness — so the tier is stated
             * rather than left to be inferred.
             */
            tier: "reported",
            source: "fomoapi trade records",
            note: "independent of this chain's price coverage — see coverage.pricedShare, " +
                  "which describes the holdings snapshot, not these trades",
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
    select handle, display_handle, name from traders where handle = ${await resolveTrader(handle)}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const asOf = await asOfHoldings(t.handle as string);

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

/** Holdings aggregate per trader, grouped so the bulk route needs one statement. */
const trustHoldings = (handles: string[]) => sql`
  select handle,
         count(*)::int as positions,
         count(value) filter (where value > 0)::int as priced,
         coalesce(sum(value) filter (where value > 0), 0) as holdings_value,
         max(captured_at) as as_of
  from holdings_current where handle = any(${handles}) group by handle`;

/**
 * Shared by the single and bulk routes. As with `pnlBody`, `group by` yields no row for a
 * trader with no holdings where the ungrouped query yielded one row of zeros, so a missing
 * row is treated as zeros.
 */
/**
 * `asOf` is the board-wide fallback, used only for a trader with no holdings row at all —
 * `trustHoldings` carries each trader's own `as_of` and that is what wins.
 *
 * It stopped being safe to share one value the moment chain-read balances landed. Every
 * fomo row is stamped with one nightly build time, but a chain snapshot is stamped when we
 * read it, so a single global max would put today's timestamp on a trader whose numbers
 * came from yesterday's fomo build — the exact complaint the consuming team raised against
 * /v1/traders, fixed there with a per-trader `updatedAt`.
 */
// deno-lint-ignore no-explicit-any
function trustBody(t: any, h: any | undefined, asOf: string | null) {
  const pnl = n(t.pnl_usd), volume = n(t.volume_usd), trades = n(t.trade_count);
  const holdingsValue = (h ? n(h.holdings_value) : 0) ?? 0;
  const positions = Number(h?.positions ?? 0), priced = Number(h?.priced ?? 0);

  const flags: { code: string; severity: string; plain: string }[] = [];
  const pnlToVolume = pnl !== null && volume !== null && volume > 0
    ? Number((pnl / volume).toFixed(2)) : null;
  const pnlToHoldings = pnl !== null && holdingsValue > 0
    ? Number((pnl / holdingsValue).toFixed(2)) : null;

  const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
  const pricedShare = positions > 0 ? priced / positions : null;

  /**
   * The two "exceeds" flags look alike and are not.
   *
   * pnl_exceeds_volume divides fomo's REPORTED profit by fomo's REPORTED volume. Both sides
   * are their own figures, stored verbatim, so a ratio above 1 is a contradiction inside
   * their data and nothing to do with our coverage. It stays.
   *
   * pnl_exceeds_holdings divides that same reported profit by OUR sum of priced positions —
   * and for `ogle` that is 6 of 48 positions. "2,364x everything they hold" was 2,364x an
   * eighth of what they hold. A denominator we know is partial cannot support a claim about
   * the whole, so the flag is withheld below the same 0.5 floor the rest of the API uses,
   * and a note explains why instead.
   *
   * The wording changed too. "That cannot come from trading alone" is a conclusion; the
   * response now states the arithmetic and leaves the conclusion to the reader.
   */
  if (pnlToVolume !== null && pnlToVolume > 1) {
    flags.push({ code: "pnl_exceeds_volume", severity: "warn",
      plain: `fomo reports ${usd(pnl!)} of profit on ${usd(volume!)} of lifetime volume — ` +
             `a ratio of ${pnlToVolume}x. Both figures are fomo's own, so they disagree with ` +
             `each other regardless of what we hold.` });
  }
  if (pnlToHoldings !== null && pnlToHoldings > 10 && (pricedShare ?? 0) >= 0.5) {
    flags.push({ code: "pnl_exceeds_holdings", severity: "warn",
      plain: `Reported profit is ${Math.round(pnlToHoldings)}x the value of everything they ` +
             `currently hold (${priced} of ${positions} positions priced) — the money is not ` +
             `visible in the portfolio.` });
  } else if (pnlToHoldings !== null && pnlToHoldings > 10) {
    flags.push({ code: "holdings_coverage_too_low", severity: "info",
      plain: `Reported profit is ${Math.round(pnlToHoldings)}x our valuation of their holdings, ` +
             `but only ${priced} of ${positions} positions have a price — too little of the ` +
             `portfolio is visible to draw a conclusion from that ratio.` });
  }
  if (trades !== null && trades < 10) {
    flags.push({ code: "too_few_trades", severity: "warn",
      plain: `Only ${trades} trade${trades === 1 ? "" : "s"} on record — far too few to tell skill from luck.` });
  }
  if (positions > 0 && priced / positions < 0.5) {
    flags.push({ code: "partial_pricing", severity: "info",
      plain: `Only ${priced} of ${positions} positions have a usable price, so portfolio figures are incomplete.` });
  }

  /**
   * `self_contradictory` replaces `implausible`. The old word passed judgement on the
   * TRADER; the new one describes the NUMBERS, which is all the data supports — two figures
   * fomo published that cannot both be right.
   */
  const verdict = flags.some((f) => f.code === "pnl_exceeds_volume") ? "self_contradictory"
    : flags.some((f) => f.code === "pnl_exceeds_holdings") ? "unverified"
    : flags.some((f) => f.code === "holdings_coverage_too_low") ? "unverifiable"
    : flags.some((f) => f.code === "too_few_trades") ? "insufficient" : "ok";

  return {
    handle: t.display_handle, name: t.name ?? null,
    // Every money figure carries its measurement time; these are derived from the holdings
    // snapshot, so they age with it — this trader's own, not the board's.
    asOf: h?.as_of ? new Date(String(h.as_of)).toISOString() : asOf,
    reportedPnlUsd: pnl, volumeUsd: volume,
    flags, pnlToVolume, pnlToHoldings, trades, verdict,
    // What each denominator was, so a consumer can weigh the verdict rather than take it.
    basis: {
      pnlToVolume: { numerator: "fomo reported pnl", denominator: "fomo reported volume",
                     bothReported: true },
      pnlToHoldings: { numerator: "fomo reported pnl", denominator: "our sum of priced positions",
                       pricedPositions: priced, totalPositions: positions,
                       pricedShare: pricedShare === null ? null : Number(pricedShare.toFixed(4)) },
    },
    plain: verdict === "self_contradictory"
      ? "fomo's own profit and volume figures for this trader do not reconcile with each other."
      : verdict === "unverified"
      ? "The reported profit is far larger than the portfolio we can see, so we cannot corroborate it."
      : verdict === "unverifiable"
      ? "Too little of this trader's portfolio has a price for us to say anything about the reported profit."
      : verdict === "insufficient"
      ? "There is not enough trading history here to judge skill."
      : "Nothing in the numbers contradicts itself.",
  };
}

get("/v1/traders/:handle/trust", async ({ handle }) => {
  const [t] = await sql`
    select t.handle, t.display_handle, t.name, s.pnl_usd, s.volume_usd, s.trade_count
    from traders t left join trader_stats_current s using (handle)
    where t.handle = ${await resolveTrader(handle)}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);
  const [h, asOf] = await Promise.all([
    trustHoldings([t.handle as string]).then((r) => r[0]),
    asOfHoldings(),
  ]);
  return trustBody(t, h, asOf);
});

// ----------------------------------------------------------- the board

/**
 * ISSUE-8. Sub-resources that `/v1/traders?include=` can inline.
 *
 * The reported problem: a consumer mirroring the directory needed 137 traders x 7 sub-routes,
 * ~960 calls, ~30 minutes sequentially. Per-call latency was the symptom; the call COUNT was
 * the cause, and no amount of shaving 2s down divides 960 into something comfortable.
 *
 * Each include is served by ONE set-based query for the whole page, never a loop — measured,
 * 137 traders aggregate in 614ms against 152ms for a single trader, because Postgres does it
 * in one pass. A bulk route that loops would have moved the N+1 server-side and made things
 * worse.
 */
/**
 * T1.4. Cursor pagination.
 *
 * `?offset=` addresses rows by POSITION, which is only correct if the list does not move
 * between calls. Ours moves: the board refreshes nightly and the Helius webhook appends
 * transactions continuously. A row inserted before your offset shifts everything down, so
 * page 2 repeats a row page 1 already gave you; a row removed shifts up and page 2 skips one.
 * Neither is visible to the caller — the sync just ends up wrong.
 *
 * A cursor names WHERE YOU WERE instead of HOW FAR IN. `offset` is kept working, because
 * removing a published parameter to fix a bug nobody reported would break consumers who are
 * fine today; new syncs should use the cursor.
 *
 * The payload is not secret and not signed — it is the sort key, base64url so it survives a
 * query string and so nobody is tempted to hand-assemble one. Tampering yields a 400, never
 * a wrong page.
 */
const encodeCursor = (parts: (string | number | null)[]): string =>
  btoa(JSON.stringify(parts)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const decodeCursor = (raw: string): (string | number | null)[] => {
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const out = JSON.parse(atob(b64 + "=".repeat((4 - b64.length % 4) % 4)));
    if (!Array.isArray(out)) throw new Error("not an array");
    return out;
  } catch {
    throw badRequest("cursor is malformed — use the nextCursor from a previous response, unmodified",
      { parameter: "cursor" });
  }
};

/**
 * Resume a JS-paged list after the row a cursor names.
 *
 * The board routes fetch the whole ordered list and slice it, so the cursor identifies the
 * anchor ROW rather than encoding a comparable key: resuming at "the row after this one" is
 * exact, and it cannot disagree with the SQL ordering the way a re-implemented comparator
 * could.
 *
 * If the anchor is gone — the nightly refresh dropped that trader or token — we say so
 * instead of guessing. Silently restarting from the top would hand back rows the caller
 * already has and look like duplicates in their data.
 */
const resumeAfter = <T>(rows: T[], cursor: string | null, id: (r: T) => string): number => {
  if (!cursor) return 0;
  const want = JSON.stringify(decodeCursor(cursor));
  const i = rows.findIndex((r) => JSON.stringify([id(r)]) === want);
  if (i < 0) {
    throw badRequest(
      "cursor no longer matches any row — the list changed since it was issued; restart without a cursor",
      { parameter: "cursor" });
  }
  return i + 1;
};

const INCLUDES = ["pnl", "scorecard", "wallets", "trust"] as const;
type Include = typeof INCLUDES[number];

get("/v1/traders", async (_p, url) => {
  const q = (url.searchParams.get("q") ?? "").trim().replace(/^@/, "").toLowerCase();
  const limit = intParam(url, "limit", { min: 1, fallback: null });
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

  /**
   * Incremental sync. Without it a consumer re-pulls the whole directory every hour forever;
   * with it an hourly job moves only what actually changed, which is what keeps this fixed as
   * the directory grows rather than just making today's sync fast.
   */
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
  /**
   * T1.5. Sorting and range filters.
   *
   * Every option here is a column we already hold. GMGN exposes ~19 range filters on its
   * trending board over metrics we do not have at all (`bundler_rate`, `insider_rate`,
   * `top70_sniper_hold_rate`); this is deliberately the subset we can answer honestly rather
   * than a claim of parity.
   */
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
    where (${q} = '' or lower(t.display_handle) like ${"%" + q + "%"}
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
    order by score, ${sortCol} ${dir} nulls last, t.handle`;

  const [{ window_label, captured }] = await sql`
    select window_label, extract(epoch from captured_at)::bigint as captured
    from builds order by captured_at desc limit 1`;

  /**
   * A range filter over a nullable column drops rows where the value is UNKNOWN, not just
   * rows that fail the test — 44 of 144 traders have no stats row, so even `minPnl` at
   * negative infinity returns 100. That is correct SQL and completely invisible to a caller,
   * who reasonably reads a short list as "few traders qualify" rather than "a third of the
   * board could not be tested".
   *
   * So when a filter is active we say how many rows it could not evaluate. Costs one cheap
   * count, and only when it is relevant.
   */
  const anyFilter = [minPnl, maxPnl, minVolume, maxVolume, minTrades, minFollowers]
    .some((v) => v !== null);
  const unratedCount = anyFilter
    ? Number(
      (await sql`
        select count(*)::int as n from traders t
        left join trader_stats_current s using (handle) where s.handle is null`)[0].n,
    )
    : 0;

  /**
   * Applied before paging, so `offset` walks the filtered set rather than the full board.
   *
   * A trader with NO `captured_at` is included, not excluded. 37 of 137 have no stats row, so
   * filtering them out would make them permanently invisible to every incremental sync —
   * a consumer would never learn they exist and would never be told anything was missing.
   * Unknown freshness cannot prove absence of change, so the safe answer is to send them and
   * let the consumer over-write identical data.
   */
  const visible = sinceMs === null ? rows : rows.filter((r) =>
    r.captured_at === null || r.captured_at === undefined ||
    Date.parse(String(r.captured_at)) > sinceMs!);

  /**
   * A cursor wins over an offset when both are sent: the caller who supplies a cursor is
   * mid-sync, and quietly honouring a stale default offset instead would corrupt exactly the
   * flow the cursor exists to protect.
   */
  const cursor = url.searchParams.get("cursor");
  const start = cursor
    ? resumeAfter(visible, cursor, (r) => String(r.handle))
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
  const handles = page.map((r) => r.handle as string);
  const wantsScorecard = include.includes("scorecard");
  const [pnlRows, scRows, wRows, trRows, ceRows, xeRows] = handles.length
    ? await Promise.all([
      include.includes("pnl") ? pnlAgg(handles) : Promise.resolve([]),
      wantsScorecard ? scorecardRows(handles) : Promise.resolve([]),
      include.includes("wallets") ? walletRows(handles) : Promise.resolve([]),
      include.includes("trust") ? trustHoldings(handles) : Promise.resolve([]),
      // Axes 5 and 2. Set-based like every other include, so the bulk route stays one
      // statement per resource rather than a loop wearing one's coat.
      wantsScorecard ? chainEntryRows(handles) : Promise.resolve([]),
      wantsScorecard ? chainExitRows(handles) : Promise.resolve([]),
    ])
    : [[], [], [], [], [], []];

  // One global value shared by every trader's trust block, fetched once.
  const holdingsAsOf = include.includes("trust") ? await asOfHoldings() : null;

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
  /*
   * A requested include that produced NOTHING is a failure, not an empty truth.
   *
   * These queries can resolve to zero rows without throwing -- a degraded pool, a statement
   * that timed out and came back empty -- and the response would still be 200 with the block
   * silently absent on every row. That is what cost a consumer their watch list: they asked
   * for wallets, got 435 traders and no wallets, and believed it.
   *
   * 432 of 435 traders have a wallet and every trader has trades, so on a non-empty page a
   * requested include yielding zero rows is a fault every time. Fail loudly instead.
   */
  if (page.length) {
    const empty: string[] = [];
    if (include.includes("wallets") && wRows.length === 0) empty.push("wallets");
    if (include.includes("pnl") && pnlRows.length === 0) empty.push("pnl");
    if (include.includes("scorecard") && scRows.length === 0) empty.push("scorecard");
    if (empty.length) throw includeUnavailable(empty);
  }

  // deno-lint-ignore no-explicit-any
  const ceBy = byHandle(ceRows as any[]);
  // deno-lint-ignore no-explicit-any
  const xeBy = byHandle(xeRows as any[]);

  /**
   * Sub-resources are nested under `included`, NOT spread onto the entry.
   *
   * `entry.pnl` already exists and is fomo's REPORTED figure; the `pnl` sub-resource is the
   * one we compute from stored trades. Spreading would have silently replaced one with the
   * other under the same key — the exact reported-versus-verified conflation this API keeps
   * apart everywhere else. Nesting also means a future include can never collide with a
   * board field.
   */
  // deno-lint-ignore no-explicit-any
  const attach = async (r: any) => {
    const h = String(r.handle);
    const out: Record<string, unknown> = {};
    if (include.includes("pnl")) out.pnl = pnlBody(r, pnlBy.get(h)?.[0]);
    if (include.includes("wallets")) {
      const w = wBy.get(h)?.[0];
      out.wallets = w ? walletsBody(w) : null;
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
            entries: new Map((ceBy.get(h) ?? []).map((c: any) =>
              [`${c.network_id}:${c.token_key}`, Number(c.chain_entry_price)])),
            exits: (xeBy.get(h) ?? []).map((x: any) => Number(x.exit_pnl_usd)),
          })
        : null;
    }
    return out;
  };

  const extras = include.length ? await Promise.all(page.map(attach)) : [];

  return {
    board: "traders",
    window: window_label ?? null,
    capturedAt: captured ? Number(captured) : null,
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
    entries: page.map((r, i) => ({
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
      ...(include.length ? { included: extras[i] } : {}),
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
get("/v1/traders/:handle", async ({ handle }, url) => {
  const h = await resolveTrader(handle);
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

  const addrs = [t.evm_address, t.sol_address]
    .filter((a): a is string => !!a).map((a) => a.toLowerCase());
  const [[act], daily] = addrs.length
    ? await Promise.all([walletActivity(addrs), dailyTradeCounts(addrs)])
    : [[undefined], []];

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
        transfers: Number(act.transfers),
        inbound: Number(act.inbound),
        outbound: Number(act.outbound),
        swaps: Number(act.swaps),
        tokensTouched: Number(act.tokens_touched),
        activeDays: Number(act.active_days),
        /**
         * Axis 6. 1.0 = the same number of trades every active day; toward 0 = it all
         * happened in a burst. `null` under two active days, where the measure has nothing
         * to compare.
         */
        evenness: evennessOf(daily.map((d) => Number(d.trades))),
        tradesPerActiveDay: daily.length
          ? Number((daily.reduce((a, d) => a + Number(d.trades), 0) / daily.length).toFixed(2))
          : null,
        /**
         * The series the evenness came from, so it can be recomputed or replotted — behind
         * `?dailyTrades=true` because it grows with a wallet's lifetime (59 rows here, and
         * unbounded for an old one) while almost every caller only wants the coefficient.
         * The 306ms group-by runs either way; this is about payload, not time.
         */
        ...(url.searchParams.get("dailyTrades") === "true"
          ? {
            dailyTrades: daily.map((d) => ({
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
        source: "postgres · transactions (helius webhook)",
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
    },
  };
});

// ---------------------------------------------------------- T12 positions

/**
 * T1.1. When a wallet first received a token, last sent it, and last did anything.
 *
 * READ, NOT COMPUTED. This used to aggregate the wallet's whole transaction history on every
 * request. For our busiest wallet that is 66,773 rows and about 9 seconds of CPU -- per view
 * -- which put GET /traders/:id/positions past its 15-second budget and returned 503 to the
 * traders people most want to look at. A covering index cut the disk reads a hundredfold and
 * left the CPU cost untouched, because the work was the wrong shape rather than merely slow.
 *
 * These values change only when new transactions arrive, so the nightly loader derives them
 * once into position_timing and the route reads them by index. See
 * scripts/refresh_position_timing.mjs.
 *
 * Both of a trader's wallets go in one `any()` rather than a query each, so a trader costs
 * one round-trip regardless of how many chains they use.
 */
const positionTiming = (addrs: string[]) => sql`
  select network_id, token_key, start_at, end_at, last_at
  from position_timing
  where address_key = any(${addrs})`;

/**
 * T1.2. On-chain activity counters for a set of wallets.
 *
 * GMGN publishes `buys_{window}` / `sells_{window}` / `swaps_{window}` per token; this is the
 * per-WALLET equivalent, which is what our routes are organised around. Same source and same
 * index as T1.1, so it costs one round-trip and no new table.
 *
 * `activeDays` counts distinct UTC days with any movement — not the span between first and
 * last. A wallet that traded twice a year apart has 2 active days, not 365, and the two
 * readings support very different conclusions about whether someone is actually trading.
 */
/**
 * Axis 6's evenness input: how many trades on each active day.
 *
 * Returned as a series rather than a single number so a consumer can compute gini, burstiness
 * or anything else from the same rows — one histogram answers several questions, and a lone
 * coefficient answers exactly one. `evenness` is also computed server-side below for callers
 * who just want the figure.
 */
const dailyTradeCounts = (addrs: string[]) => sql`
  select date_trunc('day', block_time)::date as day, count(*)::int as trades
  from transactions
  where address_key = any(${addrs}) and block_time is not null
  group by 1 order by 1`;

/**
 * Gini over trades-per-day, expressed as evenness (1 − gini).
 *
 * 1.0 means every active day carried the same number of trades; 0 approaches all activity in
 * a single day. Days with NO trades are deliberately excluded — the spec defines `activeDays`
 * as days with at least one trade, so including silent days would measure how long we have
 * been watching rather than how evenly they trade.
 *
 * `null` below two active days: a gini over one point is 0, which would read as "perfectly
 * concentrated" when it actually means "nothing to compare".
 */
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
  select count(*)::int                                             as transfers,
         count(*) filter (where direction = 'in')::int             as inbound,
         count(*) filter (where direction = 'out')::int            as outbound,
         count(*) filter (where tx_type = 'SWAP')::int             as swaps,
         count(distinct tx_hash)::int                              as transactions,
         count(distinct date_trunc('day', block_time))::int        as active_days,
         count(distinct token_key)::int                            as tokens_touched,
         min(block_time)                                           as first_at,
         max(block_time)                                           as last_at
  from transactions
  where address_key = any(${addrs})`;

get("/v1/traders/:handle/positions", async ({ handle }, url) => {
  const [t] = await sql`
    select t.handle, t.display_handle, t.name, w.evm_address, w.sol_address
    from traders t left join wallets w using (handle)
    where t.handle = ${await resolveTrader(handle)}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const addrs = [t.evm_address, t.sol_address]
    .filter((a): a is string => !!a).map((a) => a.toLowerCase());

  const rows = await sql`
    select tk.address, h.network_id, h.token_key, c.name as chain, h.human_amount, h.price, h.value,
           -- PRD §3: a price is only judgeable if it says where it came from and when it
           -- was true. A live quote and a three-week-old reported entry are both usable and
           -- are not the same claim.
           h.price_source, h.priced_at, h.captured_at, h.source as balance_source,
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

  const timing = addrs.length ? await positionTiming(addrs) : [];

  /**
   * The floor under every timestamp on this page, derived in memory from `timing`.
   *
   * This was `select min(block_time) from transactions`. `block_time` leads no index, so that
   * planned as a Parallel Seq Scan over 384k rows — 7.9s measured — on every request, to
   * produce one constant. The earliest row we hold for THIS trader answers the same question
   * for this response and costs nothing, since the rows are already here.
   */
  const observedFrom = timing
    .map((r) => (r.start_at ? Date.parse(String(r.start_at)) : null))
    .filter((x): x is number => x !== null && Number.isFinite(x));
  const historyFrom = observedFrom.length
    ? new Date(Math.min(...observedFrom)).toISOString() : null;
  const timeBy = new Map<string, Record<string, unknown>>();
  for (const r of timing) timeBy.set(`${r.network_id}:${r.token_key}`, r);
  const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);

  const total = rows.reduce((s, r) => s + ((n(r.value) ?? 0) > 0 ? n(r.value)! : 0), 0);
  const all = rows.map((r) => {
    const tm = timeBy.get(`${r.network_id}:${r.token_key}`);
    const v = (n(r.value) ?? 0) > 0 ? n(r.value) : null;
    return {
      tokenAddress: r.address,
      networkId: Number(r.network_id),
      chain: r.chain,
      amount: n(r.human_amount) ?? 0,
      /**
       * PRD §3. When the balance was read, and whether we read it or were told it.
       *
       * `verified` means we called the chain; `reported` means a build said so. Those two
       * disagreed by more than a tenth on ten of twelve traders, so which one you are
       * holding is not a detail.
       */
      balanceAt: r.captured_at ? new Date(String(r.captured_at)).toISOString() : null,
      tier: r.balance_source === "chain" ? "verified" : "reported",
      priceUsd: n(r.price),
      /** pegged_usd | gmgn_token_info | token_prices_daily | fomo_reported_entry | wallet_swap_derived */
      priceSource: (r.price_source as string) ?? null,
      /** When that price was true. A reported entry price can be weeks old and says so. */
      pricedAt: r.priced_at ? new Date(String(r.priced_at)).toISOString() : null,
      // null, never 0 — 0 would imply we checked and found the position worthless.
      valueUsd: v === null ? null : round(v),
      /** Why there is no value, rather than an unexplained null. */
      whyNoPrice: v === null ? "no price for this token in any source we hold" : null,
      share: v !== null && total > 0 ? Number((v / total).toFixed(4)) : null,
      isQuoteAsset: !!r.is_quote,
      /**
       * T1.1. First time we saw this token arrive, last time we saw any leave, and the last
       * movement of either kind. `null` means no on-chain record — which for a position
       * opened before ingestion began is the honest answer, not a claim that nothing
       * happened. Compare against `chainHistory.observedFrom` in the envelope.
       */
      startHoldingAt: iso(tm?.start_at),
      endHoldingAt: iso(tm?.end_at),
      lastActiveAt: iso(tm?.last_at),
    };
  });

  const filtered = url.searchParams.get("includeQuote") === "false"
    ? all.filter((r) => !r.isQuoteAsset) : all;
  /*
   * PAGED, AND HONEST ABOUT IT. This route used to return the first `limit` rows with nothing
   * saying more existed -- so 50 of unipcs' 521 positions looked exactly like his whole
   * portfolio, and a `cursor` parameter was accepted and silently ignored. The PRD forbids
   * precisely that: "Paged or capped assets are visibly incomplete and never presented as the
   * entire portfolio."
   *
   * The cursor names the last row returned, not an offset, so inserting or removing a
   * position between pages cannot skip or repeat one. Identity is (chain, token address) --
   * never the symbol, which is display metadata two different coins can share.
   */
  const limit = intParam(url, "limit", { min: 1, max: 500, fallback: null });
  const cursor = url.searchParams.get("cursor");
  const rowId = (r: { chain: string; tokenAddress: string | null }) =>
    `${r.chain}:${String(r.tokenAddress ?? "").toLowerCase()}`;
  const from = cursor ? resumeAfter(filtered, cursor, rowId) : 0;
  const page = limit === null ? filtered.slice(from) : filtered.slice(from, from + limit);
  const last = page.length ? page[page.length - 1] : null;
  const more = from + page.length < filtered.length;
  const priced = all.filter((r) => r.valueUsd !== null).length;

  return {
    handle: t.display_handle,
    name: t.name ?? null,
    // This trader's snapshot, not the board's — chain-read rows and fomo builds are
    // stamped at different times, so a global max would misdate one of them.
    asOf: await asOfHoldings(t.handle as string),
    count: page.length,
    positions: filtered.length,
    /** What was asked for, so a short page is legible as a page rather than a total. */
    limit,
    /**
     * Null when this page is the end of the list. Pass it back as `?cursor=` for the next
     * page; it names the row you stopped on, so the sequence survives the list changing
     * underneath you.
     */
    nextCursor: more && last ? encodeCursor([rowId(last)]) : null,
    /** False whenever rows remain. A consumer must not call a `false` page a portfolio. */
    complete: !more,
    totalValueUsd: total > 0 ? round(total) : null,
    coverage: { pricedPositions: priced, unpricedPositions: all.length - priced },
    /**
     * T1.1. The boundary every `startHoldingAt` on this page has to be read against.
     *
     * We began ingesting transactions on this date; trades on record predate it. A position
     * whose `startHoldingAt` equals this timestamp was very likely opened EARLIER and simply
     * first observed here — which is a different statement from "opened here", and only the
     * caller can tell which matters to them.
     */
    chainHistory: {
      observedFrom: historyFrom,
      note: "on-chain timing is a FLOOR, not a first event. Ingestion began part-way through " +
            "this trader's history, so a position opened earlier shows the first movement we " +
            "saw, not the first that happened. `observedFrom` is the earliest we hold for " +
            "this trader; positions without timing predate it or never moved on chain.",
      positionsWithTiming: all.filter((r) => r.startHoldingAt !== null).length,
      positionsWithoutTiming: all.filter((r) => r.startHoldingAt === null).length,
    },
    entries: page,
  };
});

// ------------------------------------------------------- K1/K3/K4/K9 board

get("/v1/tokens", async (_p, url) => {
  const chainQ = (url.searchParams.get("chain") ?? "").trim().toLowerCase() || null;
  const net = await chainWhere(chainQ);
  const minHolders = intParam(url, "minHolders", { min: 1, fallback: 1 }) ?? 1;

  /**
   * T1.5. Board sorting and value filters.
   *
   * `value` uses the same coalesce-to-0 the ordering already used, so an unpriced token sorts
   * and filters as 0 here rather than dropping out. That is a filtering convenience and NOT a
   * claim it is worth nothing — `totalValueUsd` in the response stays `null` for those rows,
   * which is the figure a consumer actually reads.
   */
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
    ? sql`count(h.value) filter (where h.value > 0)`
    : tokenSort.key === "marketCap"
    ? sql`max(ti.market_cap_usd)`
    : tokenSort.key === "liquidity"
    ? sql`max(ti.liquidity_usd)`
    : tokenSort.key === "chainHolders"
    ? sql`max(ti.holder_count)`
    : tokenSort.key === "smartWallets"
    ? sql`max((ti.raw->'wallet_tags_stat'->>'smart_wallets')::int)`
    : tokenSort.key === "renownedWallets"
    ? sql`max((ti.raw->'wallet_tags_stat'->>'renowned_wallets')::int)`
    : sql`coalesce(sum(h.value) filter (where h.value > 0), 0)`;
  const minValue = numParam(url, "minValue"), maxValue = numParam(url, "maxValue");
  const minMarketCap = numParam(url, "minMarketCap"), maxMarketCap = numParam(url, "maxMarketCap");
  const minLiquidity = numParam(url, "minLiquidity");

  /**
   * T3a. `?excludeHoneypots=true` drops tokens GMGN flags as unsellable.
   *
   * Opt-in rather than the default: silently removing rows would misstate the board — a
   * consumer counting the tokens their leaders hold would get a different number with no
   * indication why. It also only removes tokens PROVEN unsellable; a Solana token, where the
   * check does not run, is never dropped for failing a test that was never applied.
   */
  const excludeHoneypots = url.searchParams.get("excludeHoneypots") === "true";


  const [{ traders: traderCount }] = await sql`select count(*)::int as traders from traders`;

  // Quote assets are excluded and it is NOT optional: 85 of 100 leaders "hold" USDC, so
  // leaving them in makes the top of the board the currency rather than a trade.
  const rows = await sql`
    select h.network_id, c.name as chain, tk.address,
           max(ti.price_usd)      as price_usd,
           max(ti.market_cap_usd) as market_cap_usd,
           max(ti.liquidity_usd)  as liquidity_usd,
           max(ti.holder_count)   as holder_count,
           max(ti.fetched_at)     as info_fetched_at,
           -- T3e on the board. Only the two tags worth scanning a list by; the rest are on
           -- the token detail route with the cap disclosure attached.
           max((ti.raw->'wallet_tags_stat'->>'smart_wallets')::int)    as smart_wallets,
           max((ti.raw->'wallet_tags_stat'->>'renowned_wallets')::int) as renowned_wallets,
           -- T3a on the board. A honeypot flag is worthless on a detail page nobody opens
           -- before acting; it has to be visible where the scanning happens.
           bool_or(ti.is_honeypot)      as is_honeypot,
           bool_or(ti.can_not_sell)     as can_not_sell,
           max(ti.sell_tax)             as sell_tax,
           max(ti.rug_ratio)            as rug_ratio,
           max(ti.security_fetched_at)  as security_fetched_at,
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
      ${minValue === null ? sql`` : sql`and coalesce(sum(h.value) filter (where h.value > 0), 0) >= ${minValue}`}
      ${maxValue === null ? sql`` : sql`and coalesce(sum(h.value) filter (where h.value > 0), 0) <= ${maxValue}`}
      ${minMarketCap === null ? sql`` : sql`and max(ti.market_cap_usd) >= ${minMarketCap}`}
      ${maxMarketCap === null ? sql`` : sql`and max(ti.market_cap_usd) <= ${maxMarketCap}`}
      ${minLiquidity === null ? sql`` : sql`and max(ti.liquidity_usd) >= ${minLiquidity}`}
      ${
    !excludeHoneypots ? sql`` : sql`and coalesce(bool_or(ti.is_honeypot), false) = false
                                    and coalesce(bool_or(ti.can_not_sell), false) = false`
  }
    -- Address is the tiebreak, and it matters: hundreds of tokens tie on holder count with
    -- no price, so without it the board order is whatever the planner produced. It stays on
    -- the end of every sort, unreversed, because T1.4's cursors resume through a total order.
    order by ${tokenSortCol} ${tokenDir} nulls last,
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

  const limit = intParam(url, "limit", { min: 1, fallback: null });
  const cursor = url.searchParams.get("cursor");
  // A token is identified by chain + address: the same address exists on several chains and
  // the board carries one row per pair, so the address alone would be an ambiguous anchor.
  const start = cursor
    ? resumeAfter(rows, cursor, (r) => `${r.network_id}:${String(r.address).toLowerCase()}`)
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
    entries: page.map((r, i) => ({
      // Rank is the position on the WHOLE board, not within this page. It was `i + 1`, which
      // was correct only while the board could not be paged past the first slice — page two
      // would have restarted the ranking at 1 and quietly reported the 51st token as first.
      rank: start + i + 1,
      tokenAddress: r.address,
      networkId: Number(r.network_id),
      chain: r.chain,
      holders: Number(r.holders),
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
      fundamentalsTier: r.info_fetched_at ? "third_party" : null,
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
    select h.network_id, c.name as chain, tk.address, t.display_handle, h.human_amount, h.value,
           ti.price_usd, ti.liquidity_usd, ti.market_cap_usd, ti.total_supply,
           ti.circulating_supply, ti.holder_count, ti.top_10_holder_rate,
           ti.symbol as gmgn_symbol, ti.source as info_source, ti.fetched_at as info_fetched_at,
           -- T3b/T3c/T3e. Specific paths rather than the whole ti.raw document: this query
           -- returns one row per holder, so selecting all of it would ship the same ~10KB
           -- JSON once per holder — 70+ copies of an identical value on a widely-held token.
           ti.raw->'stat'->>'dev_team_hold_rate'          as dev_team_hold_rate,
           ti.raw->'stat'->>'creator_hold_rate'           as creator_hold_rate,
           ti.raw->'stat'->>'fresh_wallet_rate'           as fresh_wallet_rate,
           ti.raw->'stat'->>'top70_sniper_hold_rate'      as sniper_hold_rate,
           ti.raw->'stat'->>'bot_degen_rate'              as bot_degen_rate,
           ti.raw->'wallet_tags_stat'                     as wallet_tags,
           ti.raw->'dev'->>'creator_address'              as creator_address,
           ti.raw->'dev'->>'creator_token_status'         as creator_status,
           ti.raw->'dev'->>'cto_flag'                     as cto_flag,
           ti.raw->'dev'->>'creator_open_count'           as creator_open_count,
           ti.raw->'dev'->'ath_token_info'                as creator_ath,
           -- T3a. Contract safety. Which of these are meaningful depends on the chain, and
           -- the loader has already nulled the ones that do not apply rather than storing
           -- GMGN's false for a check that chain does not have.
           ti.is_honeypot, ti.buy_tax, ti.sell_tax, ti.is_open_source, ti.is_renounced,
           ti.renounced_mint, ti.renounced_freeze, ti.rug_ratio, ti.burn_ratio,
           ti.is_blacklisted, ti.can_not_sell, ti.security_fetched_at
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
        /**
         * T3d. Chain-wide facts about the token, from GMGN — NOT computed by us.
         *
         * They describe every holder and every pool; we observe 137 traders and could not
         * derive any of this from our own rows. It therefore arrives wearing `tier` and
         * `source`, like every other borrowed figure in this API, so it stays
         * distinguishable from the numbers we stand behind. That separation is the one thing
         * we have that GMGN does not, and quietly blending the two would spend it.
         *
         * `null` when the token has not been fetched yet — the loader covers held tokens and
         * a newly-held one waits for the next nightly pass.
         */
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
        /**
         * What the leaders' holdings would be worth at GMGN's price.
         *
         * Separate from `totalValueUsd`, never a replacement for it: that figure is what we
         * stored, this one is arithmetic on someone else's price. 64.7% of holdings carry no
         * price of our own, so without this the honest answer for two thirds of the board is
         * `null` — but a borrowed answer must not be able to pass as our own.
         */
        estimatedValueUsd: n(group[0].price_usd) !== null
          ? round(group.reduce((acc, g) => acc + (n(g.human_amount) ?? 0), 0) * n(group[0].price_usd)!)
          : null,
        estimatedValueBasis: n(group[0].price_usd) !== null
          ? "sum(holdings.amount) x GMGN price — third-party, not our stored value"
          : null,
        /**
         * T3a. Can you actually sell it, and who controls the contract?
         *
         * This closes the one place where our silence was dangerous: the API ranks tokens by
         * how many tracked leaders hold them and, until now, said nothing about whether the
         * contract permits selling. A crowd of leaders in a honeypot looked identical to a
         * crowd in a good token. 14 of the tokens on this board are confirmed honeypots.
         *
         * **Every field is three-valued and `null` never means safe.** `isHoneypot: null` is
         * "not assessed on this chain" — always so on Solana, where GMGN does not evaluate it
         * — and reading that as `false` is exactly the mistake this shape prevents.
         * `applicableChecks` names what could be judged here, so an absent field is visibly
         * out of scope rather than silently missing.
         */
        security: group[0].security_fetched_at
          ? (() => {
            const b = (v: unknown) => (v === null || v === undefined ? null : Boolean(v));
            const isSol = Number(group[0].network_id) === 1399811149;
            const flags: string[] = [];
            if (group[0].is_honeypot === true) flags.push("honeypot");
            if (group[0].can_not_sell === true) flags.push("sell_blocked");
            if (group[0].is_blacklisted === true) flags.push("blacklist_function");
            if ((n(group[0].buy_tax) ?? 0) > 0.1) flags.push("high_buy_tax");
            if ((n(group[0].sell_tax) ?? 0) > 0.1) flags.push("high_sell_tax");
            if ((n(group[0].rug_ratio) ?? 0) > 0.3) flags.push("high_rug_ratio");
            if (isSol && group[0].renounced_mint === false) flags.push("mint_not_renounced");
            if (isSol && group[0].renounced_freeze === false) flags.push("freeze_not_renounced");
            if (!isSol && group[0].is_renounced === false) flags.push("owner_not_renounced");
            return {
              canSell: group[0].is_honeypot === null
                ? null
                : !(group[0].is_honeypot === true || group[0].can_not_sell === true),
              isHoneypot: b(group[0].is_honeypot),
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
         * T3b. Concentration across EVERY holder on chain, from GMGN.
         *
         * The counterpart to `leaderConcentration` above, and the reason that one was never
         * allowed to be called `top_10_holder_rate`: ours is the share among the leaders we
         * track, this is the share of supply across the whole holder base. On a typical
         * token they read 0.592 and 0.197. Both are useful; neither substitutes for the
         * other, and the pair is more informative than either alone.
         */
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
        /**
         * T3e. How GMGN classifies the token's holders.
         *
         * Every count is CAPPED AT 1000 and the cap is invisible in the raw figure. Measured
         * over 1,095 tokens: the distribution runs 0, 1, 2, 3 … then piles up at exactly 1000
         * — 450 tokens on `fresh`, 271 on `bundler`, 29 on `whale` — with not one token above
         * it on any tag. A smooth distribution ending in a hard spike at a round number with
         * nothing beyond is a truncation, not a count, so a tag reading 1000 means "at least
         * 1000" and the response says which tags are in that state rather than leaving a
         * reader to infer a precise-looking number that is not one.
         */
        walletTags: (() => {
          const w = group[0].wallet_tags as Record<string, unknown> | null;
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
            /**
             * The creator's best previous launch — null when there is not one.
             *
             * GMGN returns the object PRESENT BUT EMPTY for creators with no prior token:
             * blank symbol, blank address, ath_mc of 0. Passing that through published
             * `peakMarketCapUsd: 0`, which reads as "their best token peaked at nothing"
             * rather than "they have no previous token". Emitted only when there is a real
             * one, and the cap follows the same rule — never 0 for unknown.
             */
            bestPreviousToken: (() => {
              const a = group[0].creator_ath as Record<string, unknown> | null;
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
            tier: "third_party",
            source: group[0].info_source ?? "gmgn",
          }
          : null,
        /**
         * T1.3. Concentration among the leaders WE TRACK — deliberately not named
         * `top_10_holder_rate`.
         *
         * GMGN's field of that name is supply across every holder on chain. This one is the
         * share of value among the handful of tracked traders holding this token. For our
         * top-ranked token those two read 0.1974 and 0.4234 — same shape, same plausible
         * magnitude, completely different denominators. Giving ours GMGN's name would make
         * the two silently interchangeable, and the day both appear in one response the
         * mistake becomes permanent.
         *
         * Value is summed PER HANDLE first: a trader holding the same token in two wallets
         * is one leader, and counting their rows separately would understate concentration.
         */
        leaderConcentration: (() => {
          /**
           * Computed from AMOUNTS, not values — and that is not a shortcut, it is exact.
           *
           * Every holder here holds the same token at the same price, so in
           * `sum(top N amount x price) / sum(all amount x price)` the price cancels out
           * entirely. The ratio is identical either way.
           *
           * It used to be computed from `value`, which needed a price and therefore returned
           * `null` for 63% of the board — 689 of 1,095 tokens — for no arithmetic reason at
           * all. Amounts are on every holding, so this now answers for every token, and it
           * stays a figure about OUR leaders with nothing borrowed in it.
           */
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

/**
 * The trade rows a scorecard is computed from. One statement, so the bulk route can ask for
 * every trader at once instead of once per trader — measured, 137 traders cost 614ms against
 * 152ms for one, because Postgres groups them in a single pass.
 */
const scorecardRows = (handles: string[]) => sql`
  select tr.handle,
         tr.trade_id, tr.network_id, tr.token_address, tr.token_key, tr.token_symbol,
         tr.status, tr.amount, tr.avg_entry_price, tr.avg_exit_price,
         tr.realized_pnl_usd, tr.unrealized_pnl_usd, tr.opened_at, tr.closed_at, tr.captured_at,
         /*
          * Supply, preferring the one we read ourselves and falling back to GMGN's.
          *
          * tokens.total_supply comes from load_token_supply.mjs and is null on 5,623 of
          * 13,184 trade pairs; token_info carries a supply for 5,000 of those. Where both
          * exist they agree within 1% on 1,089 of 1,128 tokens, so the fallback is the same
          * quantity from a second source rather than a different quantity.
          *
          * 0 is nulled first: a token cannot have zero supply, so a stored 0 means "not
          * read", and multiplying a price by it would publish an entry market cap of $0.
          *
          * The SOURCE travels with it. An entryMcap built on GMGN's supply is a different
          * claim from one built on a supply we read, and supplySource is what lets a
          * consumer tell them apart.
          */
         coalesce(nullif(tk.total_supply, 0), nullif(ti.total_supply, 0)) as total_supply,
         case when nullif(tk.total_supply, 0) is not null then tk.supply_source
              when nullif(ti.total_supply, 0) is not null then 'gmgn_token_info'
         end as supply_source,
         case when nullif(tk.total_supply, 0) is not null then tk.supply_read_at
              when nullif(ti.total_supply, 0) is not null then ti.fetched_at
         end as supply_read_at,
         -- Axis 5 wants the token's age at entry, which needs its creation time. GMGN carries
         -- it and we already store the whole document, so this is a read rather than a fetch.
         -- 0 means "they did not tell us" and is nulled here, not published as 1970.
         nullif((ti.raw->>'creation_timestamp')::bigint, 0) as token_created_unix
  from trades tr
  left join tokens tk on tk.network_id = tr.network_id and tk.token_key = tr.token_key
  left join token_info ti on ti.network_id = tr.network_id and ti.token_key = tr.token_key
  where tr.handle = any(${handles})`;

/**
 * Axis 5 — an entry price WE derived, for pairs fomo does not price.
 *
 * fomo leaves `avg_entry_price` null on 7,280 of 13,184 trader-token pairs, which is what
 * holds Axis 5 below its own coverage bar. Where the wallet's own on-chain buys have been
 * resolved, the entry price is arithmetic on them: dollars paid divided by tokens received.
 *
 * This is a fallback, never an override. fomo's figure wins when it exists, so turning this
 * on cannot move a number that already had a source.
 */
const chainEntryRows = (handles: string[]) => sql`
  select w.handle, ws.network_id, ws.token_key,
         sum(abs(ws.quote_usd)) / nullif(sum(ws.token_delta), 0) as chain_entry_price,
         count(*)::int as buys
  from wallet_swaps ws
  join wallets w on lower(w.sol_address) = ws.address_key or w.evm_address_key = ws.address_key
  where w.handle = any(${handles}) and ws.token_delta > 0 and ws.quote_usd is not null
  group by 1, 2, 3
  having sum(ws.token_delta) > 0`;

/**
 * Axis 2 — one row per EXIT, which is the granularity the spec's formula actually assumes.
 *
 * The spec computes `meanToMedian` over per-exit P&L: one data point each time the trader
 * sells. We serve per-position aggregates, so our version is a statistic across TOKENS. Both
 * compute cleanly and they are different numbers — the failure this codebase is organised
 * against, because nothing in the output says which you got.
 *
 * Each resolved sell gives a real exit: proceeds minus what that quantity cost, using the
 * wallet's own average entry from its own resolved buys. `token_delta` is negative on a
 * sell, so the subtraction is an addition.
 *
 * Only a position with BOTH sides resolved qualifies. Selling something we never saw bought
 * has no cost basis, and inventing one would be the whole problem in miniature.
 */
const chainExitRows = (handles: string[]) => sql`
  with buys as (
    select w.handle, ws.network_id, ws.token_key,
           sum(abs(ws.quote_usd)) / nullif(sum(ws.token_delta), 0) as entry_px
    from wallet_swaps ws
    join wallets w on lower(w.sol_address) = ws.address_key or w.evm_address_key = ws.address_key
    where w.handle = any(${handles}) and ws.token_delta > 0 and ws.quote_usd is not null
    group by 1, 2, 3
    having sum(ws.token_delta) > 0
  )
  select w.handle, ws.quote_usd + ws.token_delta * b.entry_px as exit_pnl_usd
  from wallet_swaps ws
  join wallets w on lower(w.sol_address) = ws.address_key or w.evm_address_key = ws.address_key
  join buys b on b.handle = w.handle and b.network_id = ws.network_id and b.token_key = ws.token_key
  where w.handle = any(${handles}) and ws.token_delta < 0 and ws.quote_usd is not null`;

/**
 * Everything the scorecard computes, over rows already fetched.
 *
 * Split out for ISSUE-8 so `/traders?include=scorecard` runs THIS function rather than a
 * second implementation of it. A bulk route that re-derives its own summary drifts from the
 * single-trader route the first time either is edited; sharing the code path makes the two
 * identical by construction rather than by test.
 */
// deno-lint-ignore no-explicit-any
async function scorecardBody(
  t: any, rows: any[], tokenLimit: number | null,
  chain?: { entries: Map<string, number>; exits: number[] },
) {
  const chainEntry = chain?.entries ?? new Map<string, number>();
  const chainExits = chain?.exits ?? [];

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

  // `id` is carried so the caveat below can compare set MEMBERSHIP, not just counts.
  const entryRows = rows
    .map((r) => ({ id: String(r.trade_id), amount: n(r.amount), px: n(r.avg_entry_price) }))
    .filter((r): r is { id: string; amount: number; px: number } =>
      r.amount !== null && r.px !== null && r.px > 0);
  const exitRows = rows
    .map((r) => ({ id: String(r.trade_id), amount: n(r.amount), px: n(r.avg_exit_price) }))
    .filter((r): r is { id: string; amount: number; px: number } =>
      r.amount !== null && r.px !== null && r.px > 0);
  const inCov = cov(entryRows.length, rows.length);
  const outCov = cov(exitRows.length, rows.length);

  /**
   * T3 — return on cost basis, and the derivation matters.
   *
   * This previously computed basis as `amount x avgEntryPrice` over closed trades and was
   * wrong by ~10^17. `amount` on a CLOSED trade is what REMAINS in the position — nothing,
   * because it was sold. Measured: 2,378 of 3,220 closed trades have amount exactly 0, and
   * 2,866 have a basis under $1 against a realized P&L over $100. Dividing real dollars by
   * dust produced numbers like 877,995,983,169,868,200.
   *
   * fomo never reports the quantity originally bought, so the basis cannot be read directly.
   * It can be DERIVED, because for a position closed at avgExitPrice:
   *
   *     pnl   = qty x (exit - entry)          ->   qty   = pnl / (exit - entry)
   *     basis = qty x entry                   ->   basis = pnl x entry / (exit - entry)
   *
   * The quantity cancels, so no position size is needed. Summing basis and pnl across trades
   * then gives a MONEY-WEIGHTED return — a $1M trade counts more than a $10 one, which an
   * average of per-trade percentages would not.
   *
   * Trades where the derivation cannot hold are dropped rather than approximated: exit equal
   * to entry (a zero divisor), and the 29 of 3,176 whose implied basis is negative — that
   * means pnl and the price move disagree in sign, so the trade is not a simple long and the
   * formula does not describe it.
   */
  const closedPriced = closed
    .map((r) => {
      const entry = n(r.avg_entry_price);
      const exit = n(r.avg_exit_price);
      const pnl = n(r.realized_pnl_usd);
      if (entry === null || exit === null || pnl === null) return null;
      if (entry <= 0 || exit <= 0 || exit === entry) return null;
      const basis = (pnl * entry) / (exit - entry);
      if (!Number.isFinite(basis) || basis <= 0) return null;
      return { basis, pnl };
    })
    .filter((r): r is { basis: number; pnl: number } => r !== null);
  const basis = closedPriced.reduce((s, r) => s + r.basis, 0);
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

  /**
   * ISSUE-4. `avgEntryPrice` used to be the FIRST entry price seen for a token, never
   * re-averaged across a trader's several positions in it — while the field name, the T17
   * doc row and K5's `crowdAvgEntryPrice` all said "average".
   *
   * A fomo "trade" is a POSITION, not a fill (one row opened 2026-04-24 and closed
   * 2026-08-31 carrying a single `avgEntryPrice`), so fomo has already averaged within it.
   * That is why the field is not simply renamed `firstEntryPrice`: on 9,886 of 10,205
   * trader-token pairs there is exactly one position and the value already IS an average.
   * Renaming would mislabel 96.9% of rows to fix 3.1%. The defect is only the failure to
   * combine ACROSS positions — where it bites, it bites hard: median 38.5% off the weighted
   * figure, 71% of them off by more than 10%.
   */
  const legQty = (r: Record<string, unknown>): number | null => {
    // The TS twin of the `trade_qty()` SQL function used by K5, deliberately kept in step:
    // the scorecard aggregates in JS and K5 in SQL, and two different answers to "what did
    // they pay to get in" is exactly the incoherence this fixes.
    if (r.status !== "closed") {
      const a = n(r.amount);
      return a !== null && a > 0 ? a : null;
    }
    // On a closed position `amount` is what REMAINS — nothing, it was sold. Weighting by it
    // would repeat BUG-1. Recover the traded quantity from BUG-1's own identity instead:
    // realized pnl = qty x (exit - entry).
    const pnl = n(r.realized_pnl_usd), e = n(r.avg_entry_price), x = n(r.avg_exit_price);
    if (pnl === null || e === null || x === null || x === e) return null;
    const q = pnl / (x - e);
    return Number.isFinite(q) && q > 0 ? q : null;
  };

  type Leg = { sum: number; weight: number; legs: number; weighted: number;
               first: number | null; firstKey: string };
  const emptyLeg = (): Leg => ({ sum: 0, weight: 0, legs: 0, weighted: 0, first: null, firstKey: "" });

  const byTokenMap = new Map<string, {
    symbol: string | null; address: string | null; trades: number; closed: number;
    realizedPnlUsd: number; unrealizedPnlUsd: number;
    entry: Leg; exit: Leg;
    totalSupply: number | null; supplySource: string | null; supplyReadAt: string | null;
    tokenCreatedUnix: number | null; firstOpenedMs: number | null;
    /* When this coin was first and last closed, so a per-coin row carries its own dates. */
    firstClosedMs: number | null; lastClosedMs: number | null;
    chainKey: string;
  }>();
  for (const r of rows) {
    const key = String(r.token_key ?? r.token_symbol ?? "unknown");
    const rec = byTokenMap.get(key) ?? {
      symbol: (r.token_symbol as string) ?? null, address: (r.token_address as string) ?? null,
      trades: 0, closed: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0,
      entry: emptyLeg(), exit: emptyLeg(),
      totalSupply: n(r.total_supply), supplySource: (r.supply_source as string) ?? null,
      supplyReadAt: r.supply_read_at ? new Date(String(r.supply_read_at)).toISOString() : null,
      tokenCreatedUnix: n(r.token_created_unix),
      // Earliest position opened in this token, so age-at-entry can be derived per token.
      firstOpenedMs: null as number | null,
      firstClosedMs: null as number | null, lastClosedMs: null as number | null,
      // Chain AND token, because one token_key can exist on two chains and their prices
      // have nothing to do with each other.
      chainKey: `${r.network_id}:${r.token_key}`,
    };
    rec.trades++;
    if (r.status === "closed") {
      rec.closed++; rec.realizedPnlUsd += n(r.realized_pnl_usd) ?? 0;
      const cms = r.closed_at ? Date.parse(String(r.closed_at)) : NaN;
      if (Number.isFinite(cms)) {
        rec.firstClosedMs = rec.firstClosedMs === null ? cms : Math.min(rec.firstClosedMs, cms);
        rec.lastClosedMs  = rec.lastClosedMs  === null ? cms : Math.max(rec.lastClosedMs, cms);
      }
    }
    else rec.unrealizedPnlUsd += n(r.unrealized_pnl_usd) ?? 0;

    const openedAt = ms(r.opened_at);
    if (openedAt !== null && (rec.firstOpenedMs === null || openedAt < rec.firstOpenedMs)) {
      rec.firstOpenedMs = openedAt;
    }

    const qty = legQty(r);
    // Ordered by open time, tie-broken on trade_id, so `first` does not depend on the order
    // rows happen to arrive in — the previous code took whatever the query yielded first.
    //
    // Compared as a zero-padded epoch, NOT as a stringified Date: postgres.js hands back a
    // Date whose toString is "Wed Apr 10 2026 …", and comparing those lexicographically
    // sorts by weekday name — "Fri Aug" lands before "Wed Apr". Caught by firstEntryPrice
    // returning the wrong leg on a 7-position token.
    const openedMs = ms(r.opened_at);
    const sortKey = `${String(openedMs ?? 9e15).padStart(16, "0")}|${String(r.trade_id)}`;
    // The loader already stores fomo's `0` as NULL, because a $0 entry price implies
    // someone got in for nothing.
    for (const [px, acc] of [[n(r.avg_entry_price), rec.entry], [n(r.avg_exit_price), rec.exit]] as const) {
      if (px === null || px <= 0) continue;
      acc.legs++;
      if (acc.first === null || sortKey < acc.firstKey) { acc.first = px; acc.firstKey = sortKey; }
      if (qty !== null) { acc.sum += px * qty; acc.weight += qty; acc.weighted++; }
    }
    byTokenMap.set(key, rec);
  }

  /**
   * Resolve a leg accumulator to one price plus the method that produced it.
   *
   * The method travels with the number because three different computations hide behind one
   * field, and a consumer cannot otherwise tell a genuine weighted average from a single
   * position's value from a fallback. `weighted_partial` is the honest name for an average
   * over the legs that had a weight when some did not — 14 of 319 positions.
   */
  const resolve = (a: Leg) => {
    const method = a.legs === 0 ? null
      : a.legs === 1 ? "single_position"
      : a.weighted === a.legs ? "weighted"
      : a.weighted > 0 ? "weighted_partial"
      : "first_only";
    const value = a.legs === 0 ? null
      : method === "single_position" || method === "first_only" ? a.first
      : a.weight > 0 ? a.sum / a.weight : a.first;
    return { value, method, legs: a.legs, legsWeighted: a.weighted, first: a.first };
  };
  const byToken = [...byTokenMap.values()]
    .map(({ entry, exit, tokenCreatedUnix, firstOpenedMs, firstClosedMs, lastClosedMs, chainKey, ...r }) => {
      const e = resolve(entry), x = resolve(exit);
      /**
       * Axis 5. fomo prices only 45% of trader-token pairs, and the unpriced ones are what
       * keeps the axis below its own coverage bar. Where we resolved the wallet's own buys
       * on chain, the entry price is arithmetic on them.
       *
       * A FALLBACK, never an override — `e.value` wins whenever it exists, so this cannot
       * move a number that already had a source. `entryPriceSource` says which you got,
       * because a price we derived and a price fomo reported are different kinds of claim
       * and a consumer weighing them needs to know which is which.
       */
      const chainPx = e.value === null ? (chainEntry.get(chainKey) ?? null) : null;
      const entryPx = e.value ?? chainPx;
      // 12 significant figures, not a decimal rounding: these prices run to 0.0000101253 and
      // `round(v, 2)` would flatten a real entry to zero. At 12 figures every value that was
      // a single position comes back bit-identical to what it returned before, so the only
      // rows that move are the ones ISSUE-4 is about.
      const px = (v: number | null) => (v === null ? null : Number(v.toPrecision(12)));
      return {
      ...r,
      realizedPnlUsd: round(r.realizedPnlUsd)!,
      unrealizedPnlUsd: round(r.unrealizedPnlUsd)!,
      avgEntryPrice: px(entryPx),
      avgExitPrice: px(x.value),
      /** `reported` = fomo's, `chain` = derived from the wallet's own resolved buys. */
      entryPriceSource: entryPx === null ? null : (e.value !== null ? "reported" : "chain"),
      /**
       * Which of three computations produced the price above, and over how many positions.
       *
       * Without this a consumer cannot tell a genuine weighted average from a lone
       * position's value from a fallback, and all three used to arrive under one name.
       *   single_position  - one position in this token; fomo already averaged inside it
       *   weighted         - averaged across positions, every leg weighted
       *   weighted_partial - some legs had no recoverable quantity and are excluded
       *   first_only       - no leg had a weight; the earliest value is returned
       */
      entryMethod: e.method,
      entryPositions: e.legs,
      entryPositionsWeighted: e.legsWeighted,
      exitMethod: x.method,
      /** The pre-ISSUE-4 value, kept so anyone reading the old field can reconcile. */
      firstEntryPrice: px(e.first),
      /**
       * When the token itself was created, and how old it was when this trader first opened a
       * position in it. Buying something four hours old is a different act from buying it four
       * months old, and only the second number expresses that.
       *
       * `null` on either when GMGN has no creation time for the token (about 9% of them) or
       * when we hold no open date — never 0, which would read as "created at the epoch".
       */
      tokenCreatedAt: tokenCreatedUnix !== null
        ? new Date(tokenCreatedUnix * 1000).toISOString()
        : null,
      tokenAgeAtEntryDays: tokenCreatedUnix !== null && firstOpenedMs !== null
        ? Number(((firstOpenedMs - tokenCreatedUnix * 1000) / 86_400_000).toFixed(2))
        : null,
      /**
       * When this coin was closed, first and last.
       *
       * The realised figure on this row was always summed by close date, and the row carried
       * no date to go with it -- the only dates here were about the coin, not the trading.
       * Null while nothing in this coin has closed yet, which is a different state from
       * closed at the epoch.
       */
      firstClosedAt: firstClosedMs !== null ? new Date(firstClosedMs).toISOString() : null,
      lastClosedAt:  lastClosedMs  !== null ? new Date(lastClosedMs).toISOString()  : null,
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
        entryPx !== null && r.totalSupply !== null && r.totalSupply > 0
          ? Number((entryPx * r.totalSupply).toPrecision(10))
          : null,
      avgExitMarketCapUsd:
        x.value !== null && r.totalSupply !== null && r.totalSupply > 0
          ? Number((x.value * r.totalSupply).toPrecision(10))
          : null,
      };
    })
    .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd ||
                    b.unrealizedPnlUsd - a.unrealizedPnlUsd ||
                    String(a.address).localeCompare(String(b.address)));

  const caveats: string[] = [];
  if (inCov.share !== null && inCov.share < 0.5) {
    caveats.push(`Entry prices are present on only ${entryRows.length} of ${rows.length} trades, ` +
      `so money-in, return % and typical bet size are computed from a minority of the record.`);
  }
  /**
   * Compare the SETS, not their sizes.
   *
   * This previously fired only when the two counts differed, which missed the case that
   * actually misleads: `ether_monk` has 42 entry prices and 42 exit prices — equal counts,
   * different trades, because 22 of the entry-priced ones are still open and so cannot have
   * an exit. A reader saw "$3.19M in, $0.4M out" and reasonably concluded a large loss; that
   * trader's closed trades are in fact +$916,699. Equal cardinality is not overlap.
   */
  const entryIds = new Set(entryRows.map((r) => r.id));
  const exitIds = new Set(exitRows.map((r) => r.id));
  const shared = [...entryIds].filter((id) => exitIds.has(id)).length;
  if (shared < entryIds.size || shared < exitIds.size) {
    caveats.push(`Money-in covers ${entryIds.size} trades and money-out covers ${exitIds.size}, but ` +
      `only ${shared} are the same trade — money-in includes positions still open, which have no ` +
      `exit yet. Subtracting one from the other is NOT a profit figure; use returnPct or /pnl.`);
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
  /**
   * Computed from `rows`, not from a second query.
   *
   * This used to be its own round-trip per trader. Every input it needs — status, closed_at,
   * realized_pnl_usd — is already in `rows`, so the query was fetching data we were holding.
   * Dropping it takes the single-trader route from 3 database trips to 1, and it is what
   * lets `/traders?include=scorecard` serve 137 traders without 137 extra queries.
   *
   * The SQL used `now()` (database clock) and this uses the function's; both are UTC and the
   * boundary is a moving 24h/7d/30d window, so a few milliseconds of skew cannot change a
   * bucket that any consumer could observe.
   */
  const nowMs = Date.now();
  const closedDated = rows.filter((r) =>
    r.status === "closed" && r.closed_at !== null && r.closed_at !== undefined);
  const windowAgg = (sinceMs: number | null) => {
    const inWindow = sinceMs === null
      ? closedDated
      : closedDated.filter((r) => Date.parse(String(r.closed_at)) > sinceMs);
    // `sum()` skips NULLs and `coalesce(..., 0)` makes an empty window zero — matched here,
    // because a window with no closed trades earned nothing, which is a real 0 and not a
    // missing value.
    const total = inWindow.reduce((acc, r) => acc + (n(r.realized_pnl_usd) ?? 0), 0);
    return { realizedUsd: round(total), closedTrades: inWindow.length };
  };

  /*
   * THE SAME SUM, BROKEN OUT BY DAY.
   *
   * The four windows above already group realised profit by closed_at, so a consumer could
   * see that a trader made money over 30 days and had nothing that could say what he made on
   * a Tuesday -- a thirty-day calendar drew thirty empty squares. The dates were here the
   * whole time; only the grouping was missing.
   *
   * Days with no closed trade are ABSENT rather than zero: a day he closed nothing is not a
   * day he earned nothing, and a calendar should show those differently.
   */
  const dayBuckets = new Map<string, { realizedUsd: number; closedTrades: number }>();
  const since30 = nowMs - 30 * 86_400_000;
  for (const r of closedDated) {
    const ms = Date.parse(String(r.closed_at));
    if (!Number.isFinite(ms) || ms <= since30) continue;
    const day = new Date(ms).toISOString().slice(0, 10);
    const b = dayBuckets.get(day) ?? { realizedUsd: 0, closedTrades: 0 };
    b.realizedUsd += n(r.realized_pnl_usd) ?? 0;
    b.closedTrades++;
    dayBuckets.set(day, b);
  }
  const realizedByDay = [...dayBuckets.entries()]
    .sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([day, v]) => ({ day, realizedUsd: round(v.realizedUsd), closedTrades: v.closedTrades }));

  const windows = {
    basis: "realized profit only — closed trades, summed by closed_at. Unrealised movement " +
           "is not included; see /pnl for banked versus on paper.",
    "24h": windowAgg(nowMs - 86_400_000),
    "7d":  windowAgg(nowMs - 7 * 86_400_000),
    "30d": windowAgg(nowMs - 30 * 86_400_000),
    all:   windowAgg(null),
  };

  return {
    handle: t.display_handle, name: t.name ?? null,
    source: "postgres · trades (loaded from fomoapi)",
    /**
     * Realised profit per day for the last thirty days, same basis as `realized` below.
     * A day with no closed trade is absent, not zero.
     */
    realizedByDay,
    // max(captured_at) over the same rows — identical to the query this replaces, and free.
    asOf: (() => {
      const times = rows.map((r) => (r.captured_at ? Date.parse(String(r.captured_at)) : null))
        .filter((x): x is number => x !== null && Number.isFinite(x));
      return times.length ? new Date(Math.max(...times)).toISOString() : null;
    })(),
    sample: { returned: rows.length, storedAt: rows[0]?.captured_at ?? null },
    winRate, wins, losses, breakeven,
    bestTradeUsd: round(best), worstTradeUsd: round(worst),
    topTradeShare, meanToMedian,
    meanTradeUsd: round(meanTrade), medianTradeUsd: round(medTrade),
    /**
     * Axis 2 — WHICH POPULATION `meanToMedian` above was computed over.
     *
     * It is one data point per TOKEN. The spec's formula assumes one per EXIT: a trader with
     * 200 exits across 40 tokens gives 40 points here and 200 there. Both compute cleanly,
     * they are different numbers, and until this field existed nothing in the response said
     * which you had. That is the failure mode this API is organised against — not a value
     * that is missing, but one that is quietly answering a different question.
     */
    meanToMedianBasis: "per_token",
    /**
     * The same statistic over real EXITS, which is what the spec actually asks for.
     *
     * Each point is one resolved on-chain sell: proceeds minus what that quantity cost at
     * the wallet's own average entry, both sides from `wallet_swaps`. Only positions whose
     * buys AND sells we resolved contribute — selling something we never saw bought has no
     * cost basis, and inventing one would be the whole problem in miniature.
     *
     * `null` where we have fewer than two exits, and `clearsSpecBar` reports the spec's own
     * "< 20 sell rows -> hollow" rule so the front end can apply it without recounting.
     * Coverage is deliberately visible: this is exact where it exists and absent where it
     * does not, which is the honest shape for a number this axis will be scored on.
     */
    perExit: (() => {
      const xs = chainExits.filter((v) => Number.isFinite(v));
      const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
      const med = median(xs);
      return {
        exits: xs.length,
        wins: xs.filter((v) => v > 0).length,
        losses: xs.filter((v) => v < 0).length,
        // Same sign discipline as the per-token figure: a ratio across a sign change is
        // arithmetically true and informationally worthless.
        meanToMedian: xs.length >= 2 && mean !== null && med !== null && mean > 0 && med > 0
          ? Number((mean / med).toFixed(2)) : null,
        meanExitUsd: round(mean), medianExitUsd: round(med),
        clearsSpecBar: xs.length >= 20,
        basis: "one point per resolved on-chain exit, cost basis from the wallet's own " +
               "resolved buys — the granularity the axis formula assumes",
      };
    })(),
    moneyIn: { usd: entryRows.length ? round(entryRows.reduce((s, r) => s + r.amount * r.px, 0)) : null, coverage: inCov },
    moneyOut: { usd: exitRows.length ? round(exitRows.reduce((s, r) => s + r.amount * r.px, 0)) : null, coverage: outCov },
    returnPct: { value: basis > 0 ? Number(((closedPnl / basis) * 100).toFixed(2)) : null,
                 coverage: cov(closedPriced.length, closed.length) },
    typicalBetUsd: bet,
    /**
     * PRD §5 — rhythm, on ONE definition, for every trader whatever source they came from.
     *
     * These figures already existed as `tradesPerDay`, `holdingTime` and `lastTradeAt`; what
     * was missing was a block by an agreed name carrying `basis`, `window`, `coverage` and
     * `asOf` on each one. A consumer that needs a trader's rhythm was refusing every row
     * because it could not find the block, not because the numbers were absent.
     *
     * Unmeasurable is `null` with a `why`, never omitted -- an absent field and a measured
     * "we cannot say" are different answers and only one of them is honest.
     */
    measurements: (() => {
      const closedCount = closed.length;
      // Same definition the top-level `tradesPerDay` uses, computed from the same locals.
      const perDay = spanDays !== null && spanDays >= 1
        ? Number((rows.length / spanDays).toFixed(2)) : null;
      const lastTradeIso = lastAt === null ? null : new Date(lastAt).toISOString();
      return {
        tradesPerDay: {
          value: perDay,
          basis: "closed positions per calendar day between first open and last close",
          window: "all recorded history",
          coverage: cov(closedCount, rows.length),
          why: perDay === null ? "no closed positions on record" : null,
        },
        holdTimeDays: {
          value: medHold === null ? null : Number((medHold / 86_400_000).toFixed(3)),
          basis: "median open-to-close duration over finished positions",
          window: "all recorded history",
          coverage: cov(closedPriced.length, closedCount),
          why: medHold === null
            ? "no finished position carries both an open and a close time" : null,
        },
        lastTradeAt: {
          value: lastTradeIso,
          basis: "most recent close on record",
          window: "all recorded history",
          why: lastTradeIso === null ? "no closed positions on record" : null,
        },
        asOf: (() => {
          const times = rows.map((r) => (r.captured_at ? Date.parse(String(r.captured_at)) : null))
            .filter((x): x is number => x !== null && Number.isFinite(x));
          return times.length ? new Date(Math.max(...times)).toISOString() : null;
        })(),
      };
    })(),
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
      scope: "every position on record for this trader and token, sold ones included",
      sellsReduceIt: false,
      note: "fomoapi supplies one avgEntryPrice per POSITION, already averaged across the " +
            "fills inside it. Where a trader holds several positions in one token we now " +
            "combine them into a quantity-weighted average; each row reports which " +
            "computation it used in `entryMethod` and over how many positions.",
      weighting: "open positions weight by `amount`; closed positions recover quantity from " +
                 "realized pnl / (exit - entry), because `amount` on a closed position is " +
                 "what remains (zero), not what was traded",
      sells: "a sell does not reduce the entry price. This answers what they PAID TO GET IN " +
             "across their whole record, not what their remaining position cost.",
      marketCap: "avgEntryPrice x tokens.total_supply, both returned so the figure can be rechecked",
      previously: "this field was the first entry price seen per token and was not " +
                  "re-averaged; `firstEntryPrice` still carries that value for comparison",
    },
    /**
     * Axis 5's "winrate on hard entries". Restricted to tokens the trader entered below a
     * $1M market cap — buying something small is a different skill from buying something
     * established, and a blended win rate hides which one they are good at.
     *
     * Per TOKEN, not per trade, because that is the granularity we hold. Coverage travels
     * with it: entry market cap needs both an entry price and a supply, and we have both on
     * well under half the record — so this is often computed over a handful of tokens and
     * must not be read as a headline.
     */
    smallCapWinRate: (() => {
      const priced = byToken.filter((t) => t.avgEntryMarketCapUsd !== null);
      const small = priced.filter((t) => t.avgEntryMarketCapUsd! < 1_000_000 && t.closed > 0);
      if (!small.length) {
        return {
          value: null,
          threshold: 1_000_000,
          basis: "per token, not per trade — we hold positions, not individual fills",
          coverage: cov(0, byToken.length),
          note: "no token with a known entry market cap under $1M has a closed position",
        };
      }
      const wins = small.filter((t) => t.realizedPnlUsd > 0).length;
      return {
        value: Number((wins / small.length).toFixed(4)),
        wins,
        tokens: small.length,
        threshold: 1_000_000,
        basis: "per token, not per trade — we hold positions, not individual fills",
        // Denominator is tokens we could PRICE, not all tokens: a token with no entry market
        // cap was not judged small or large, and counting it either way would be a guess.
        coverage: cov(priced.length, byToken.length),
      };
    })(),
    windows,
    /**
     * Axis 5's gate, reported rather than assumed.
     *
     * The spec hollows the axis when supply or price is missing for more than 30% of buys.
     * Publishing the share — and how much of it we had to derive ourselves — lets the front
     * end apply that rule without recomputing it, and lets it argue for a different rule
     * with the evidence in front of it.
     */
    entryPriceCoverage: (() => {
      const withPrice = byToken.filter((t) => t.avgEntryPrice !== null);
      const fromChain = withPrice.filter((t) => t.entryPriceSource === "chain").length;
      const withCap = byToken.filter((t) => t.avgEntryMarketCapUsd !== null).length;
      return {
        tokensPriced: withPrice.length,
        tokensTotal: byToken.length,
        pricedShare: byToken.length ? Number((withPrice.length / byToken.length).toFixed(4)) : null,
        derivedFromChain: fromChain,
        withMarketCap: withCap,
        // Both price AND supply are needed for an entryMcap, so this is the share the axis
        // actually runs on — not the price share, which is always the larger number.
        marketCapShare: byToken.length ? Number((withCap / byToken.length).toFixed(4)) : null,
        clearsSpecBar: byToken.length > 0 && withCap / byToken.length >= 0.7,
      };
    })(),
    tokensTotal: byToken.length,
    byToken: tokenLimit === null ? byToken : byToken.slice(0, tokenLimit),
    plain, caveats,
  };
}

get("/v1/traders/:handle/scorecard", async ({ handle }, url) => {
  const [t] = await sql`
    select t.handle, t.display_handle, t.name, s.volume_usd, s.trade_count
    from traders t left join trader_stats_current s using (handle)
    where t.handle = ${await resolveTrader(handle)}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const h = t.handle as string;
  const [rows, ce, xe] = await Promise.all([
    scorecardRows([h]), chainEntryRows([h]), chainExitRows([h]),
  ]);
  if (!rows.length) throw notFound(`no stored trades for '${t.handle}'`);

  return await scorecardBody(t, rows, intParam(url, "tokens", { min: 0, fallback: null }), {
    entries: new Map(ce.map((c: any) => [`${c.network_id}:${c.token_key}`, Number(c.chain_entry_price)])),
    exits: xe.map((x: any) => Number(x.exit_pnl_usd)),
  });
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
  /**
   * ISSUE-4, the K5 half. `entry` was `min(avg_entry_price)` — not the average the field
   * name promised, and not even the "first value" the doc claimed: the CHEAPEST entry the
   * trader ever got. The scorecard took the first and this took the minimum, so the two
   * routes disagreed with each other as well as with their documentation.
   *
   * Now a quantity-weighted average per trader, using the same `trade_qty()` rule as the
   * scorecard's `legQty`. Falls back to the earliest value only when no leg carries a
   * recoverable quantity, and reports how many legs were weighted so the fallback is
   * visible rather than inferred.
   */
  const per = await sql`
    with legs as (
      select t.display_handle as handle, tr.status, tr.trade_id,
             tr.realized_pnl_usd, tr.unrealized_pnl_usd,
             tr.avg_entry_price, tr.avg_exit_price, tr.opened_at, tr.closed_at,
             trade_qty(tr.status, tr.amount, tr.realized_pnl_usd,
                       tr.avg_entry_price, tr.avg_exit_price) as qty
      from trades tr join traders t on t.handle = tr.handle
      where tr.token_key = ${key}
    )
    select handle,
           count(*)::int                                           as trades,
           count(*) filter (where status = 'closed')::int           as closed,
           coalesce(sum(realized_pnl_usd)
                    filter (where status = 'closed'), 0)            as realized,
           coalesce(sum(unrealized_pnl_usd)
                    filter (where status <> 'closed'), 0)           as unrealized,
           coalesce(
             sum(avg_entry_price * qty) filter (where avg_entry_price > 0 and qty is not null)
               / nullif(sum(qty) filter (where avg_entry_price > 0 and qty is not null), 0),
             (array_agg(avg_entry_price order by opened_at nulls last, trade_id)
                filter (where avg_entry_price > 0))[1]
           )                                                        as entry,
           coalesce(
             sum(avg_exit_price * qty) filter (where avg_exit_price > 0 and qty is not null)
               / nullif(sum(qty) filter (where avg_exit_price > 0 and qty is not null), 0),
             (array_agg(avg_exit_price order by opened_at nulls last, trade_id)
                filter (where avg_exit_price > 0))[1]
           )                                                        as exit,
           count(*) filter (where avg_entry_price > 0)::int          as entry_positions,
           count(*) filter (where avg_entry_price > 0
                              and qty is not null)::int              as entry_positions_weighted,
           min(opened_at)                                           as first_buy,
           max(closed_at)                                           as last_sell
    from legs
    group by handle
    order by realized desc, handle`;

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
      /**
       * One trader, one vote — deliberately NOT weighted by position size.
       *
       * This answers "what did a typical leader pay", which is the question the board is
       * read for. Weighting by size would answer "what did the crowd's money pay" and be
       * set almost entirely by the largest holder. ISSUE-4 was that the INPUTS were
       * first-entries rather than averages; that is what changed here, not the way holders
       * are combined.
       */
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
    where t.handle = ${await resolveTrader(handle)}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const chainQ = (url.searchParams.get("chain") ?? "").trim().toLowerCase() || null;
  const net = await chainWhere(chainQ);
  const limit = intParam(url, "limit", { min: 1, max: 500, fallback: 50 }) ?? 50;

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

  /**
   * True keyset pagination, not an offset.
   *
   * This feed is append-only and the webhook writes to it continuously, so rows arrive at the
   * FRONT of a `block_time desc` ordering. Under `?offset=` every insertion between two calls
   * pushes the whole list down and page two repeats rows page one already returned. A keyset
   * asks for "everything ordered after this exact row", which newly-arrived rows cannot
   * disturb — they sort ahead of the cursor and are simply not in the caller's backward walk.
   *
   * `block_time` is NULL on 0 of 386,544 rows, so the ordering needs no NULL branch; the
   * remaining four columns are the primary key and all ascend, which lets the tail be one
   * row-value comparison rather than a nested OR chain.
   */
  const after = url.searchParams.get("cursor")
    ? decodeCursor(url.searchParams.get("cursor")!) : null;
  if (after && after.length !== 5) {
    throw badRequest("cursor does not belong to this route", { parameter: "cursor" });
  }

  const rows = await sql`
    select tx.network_id, c.name as chain, tx.tx_hash, tx.block_time, tx.direction,
           tx.counterparty, tx.token_key, tx.token_symbol, tx.amount, tx.source,
           tx.tx_type, tx.tx_source, tx.address_key, tx.transfer_key, tx.value_usd
    from transactions tx join chains c using (network_id)
    where tx.address_key = any(${keys})
      ${net === null ? sql`` : sql`and tx.network_id = ${net}`}
      ${kind === null ? sql`` : sql`and upper(tx.tx_type) = ${kind.toUpperCase()}`}
      ${
    after === null ? sql`` : sql`and (
        tx.block_time < ${String(after[0])}::timestamptz
        or (tx.block_time = ${String(after[0])}::timestamptz
            and (tx.tx_hash, tx.network_id, tx.address_key, tx.transfer_key)
              > (${String(after[1])}, ${Number(after[2])}::bigint, ${String(after[3])}, ${String(after[4])}))
      )`
  }
    -- The full primary key is the tiebreak. 23,916 (block_time, tx_hash) pairs carry more
    -- than one row and one carries 49, because a single transaction moves several tokens
    -- and each transfer is its own row. Ordering on the pair alone left up to 49 rows in
    -- arbitrary order, which keyset pagination cannot resume through.
    order by tx.block_time desc nulls last, tx.tx_hash, tx.network_id, tx.address_key, tx.transfer_key
    limit ${limit}`;

  // What the store actually holds for this trader, so "no rows" can be told apart from
  // "we never fetched this chain". A count of zero with a populated store is a real
  // finding; a count of zero with an empty store is a gap in ingestion.
  const storedQ = sql`
    select count(*)::int as total, max(block_time) as newest, min(block_time) as oldest
    from transactions where address_key = any(${keys})`;

  /**
   * T2.1. The cost-basis figures GMGN publishes as `history_bought_cost` /
   * `history_sold_income`, derived from the quote leg of each swap.
   *
   * We overwhelmingly stored the quote side rather than the memecoin side, which is what
   * makes this answerable: we know a wallet spent 1.5 SOL even though we never recorded what
   * came back. So this is how much money MOVED, not what price they paid per token — the
   * second question needs both legs and we hold those for a small minority of swaps.
   *
   * Coverage travels with it because a third of a wallet's swap legs can be unpriceable, and
   * a spend total drawn from two thirds of the record must not read as the whole of it.
   */
  const moneyQ = sql`
    select coalesce(sum(value_usd) filter (where direction = 'out'), 0) as spent,
           coalesce(sum(value_usd) filter (where direction = 'in'),  0) as received,
           count(*) filter (where tx_type = 'SWAP')::int             as swap_legs,
           count(value_usd) filter (where tx_type = 'SWAP')::int     as swap_legs_priced
    from transactions
    where address_key = any(${keys})
      ${net === null ? sql`` : sql`and network_id = ${net}`}`;

  /**
   * The money block is a WHOLE-WALLET total, identical on every page — so it is computed when
   * you start reading a wallet and not again while you page through it.
   *
   * It is the expensive part of this route: 386ms as an index-only scan over 30,907 rows for
   * a large wallet, which took the route from 2.5s to 3.6s against a 2.7s control. Recomputing
   * it on all 12 pages of a walk would spend that twelve times over to return the same number
   * twelve times. Present by default, absent once you are following a cursor, and `?money=true`
   * forces it either way.
   */
  const wantMoney = url.searchParams.get("money") === "true" ||
    (after === null && url.searchParams.get("money") !== "false");
  const [[stored], moneyRows] = await Promise.all([
    storedQ,
    wantMoney ? moneyQ : Promise.resolve([]),
  ]);
  const money = moneyRows[0];

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
    /**
     * Whole-wallet totals, NOT a total of the page — a page of 50 transfers says nothing
     * about a wallet with 30,000, and a figure that changes when you paginate is a trap.
     */
    ...(money
      ? {
        money: {
          spentUsd: round(n(money.spent)),
          receivedUsd: round(n(money.received)),
          netUsd: round((n(money.received) ?? 0) - (n(money.spent) ?? 0)),
          basis: "quote-asset legs only — the stablecoin or SOL side of each swap, valued " +
                 "at its daily close. This is how much money moved, not the price paid per token.",
          coverage: cov(Number(money.swap_legs_priced), Number(money.swap_legs)),
          note: "unpriced legs are the memecoin side of a swap, whose value we did not " +
                "store; they are excluded rather than counted as zero",
        },
      }
      : {
        moneyOmitted: "whole-wallet totals are the same on every page, so they are not " +
          "recomputed while paging. Add ?money=true to include them.",
      }),
    /**
     * `null` on the last page. A full page is only a HINT that more exist — if the feed holds
     * exactly `limit` remaining rows the next call returns empty, which is correct and cheap.
     * Claiming to know otherwise would mean a second count query on every request.
     */
    nextCursor: rows.length === limit && rows.length > 0
      ? encodeCursor([
        new Date(String(rows[rows.length - 1].block_time)).toISOString(),
        String(rows[rows.length - 1].tx_hash),
        Number(rows[rows.length - 1].network_id),
        String(rows[rows.length - 1].address_key),
        String(rows[rows.length - 1].transfer_key),
      ])
      : null,
    transfers: rows.map((r) => ({
      chain: r.chain,
      networkId: Number(r.network_id),
      /**
       * `txHash` is the name every other route uses -- /trades has always spelled it that
       * way. This route emitted `tx_hash` alone, the one snake_case key in an otherwise
       * camelCase API, which is an oversight rather than a convention.
       *
       * Both are returned: the old spelling stays so nothing reading it breaks, and new
       * consumers get the name that matches the rest of the API. `tx_hash` is deprecated.
       */
      txHash: r.tx_hash,
      tx_hash: r.tx_hash,
      time: r.block_time ?? null,
      side: r.direction ?? null,
      // Null where no trade record has taught us the symbol yet; the contract is always
      // present, so a consumer always has something to key on.
      token: r.token_symbol ?? null,
      contract: r.token_key ?? null,
      amount: n(r.amount),
      /**
       * T2.1. USD size of this leg — a MAGNITUDE, like `amount`, with the direction in
       * `side`. `amount` is positive on every row in both directions (measured: 0 of 117,524
       * swap legs are negative), so signing this column would have made the two disagree.
       *
       * `null` is the honest answer for a leg whose token is not a quote asset: ~8,700 of
       * 117,500 swap legs are the memecoin side, and we did not store what it was worth. It
       * is never 0 — a swap we could not value is not a swap worth nothing.
       */
      costUsd: n(r.value_usd) === null ? null : round(n(r.value_usd)),
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

// --------------------------------------------------------------- AUM over time

/** The windows the route accepts, and how far back each reaches. */
const AUM_WINDOWS: Record<string, number | null> = {
  "1d": 86_400_000,
  "1w": 7 * 86_400_000,
  "1m": 30 * 86_400_000,
  all: null,
};
/** Step sizes, coarsest last. The default picks the coarsest that still leaves >= 24 points. */
const AUM_STEPS: { name: string; ms: number }[] = [
  { name: "1h", ms: 3_600_000 },
  { name: "6h", ms: 6 * 3_600_000 },
  { name: "1d", ms: 24 * 3_600_000 },
];

/**
 * A trader's balance over time — one sampled point per hour, in USD, across every wallet
 * and chain.
 *
 * `/portfolio` answers "now"; this answers "over time", and the two are deliberately not
 * merged. If the newest sample here disagrees with `/portfolio`, that is a finding worth
 * chasing, not something to average away.
 *
 * NOT bulk-able through `?include=`, for the same reason `/portfolio` is not: it is a series
 * per trader, and a page of them would be the largest response this API can produce.
 */
/**
 * Parse and validate the three AUM query parameters, once.
 *
 * Shared so the individual route and the batch route cannot drift on what a window means or
 * which steps exist -- GENIE_FOMO_V7_BATCH_AUM_TDR.md §4 requires the two to agree exactly,
 * and the cheapest way to guarantee that is to have one of them.
 */
function aumOptions(url: URL): { windowKey: string; stepRaw: string | null; chainKey: string } {
  const windowKey = (url.searchParams.get("window") ?? "1w").trim();
  if (!(windowKey in AUM_WINDOWS)) {
    throw badRequest(
      `'window' must be one of ${Object.keys(AUM_WINDOWS).join(", ")} — got '${windowKey}'`,
      { parameter: "window" },
    );
  }
  const stepRaw = url.searchParams.get("step");
  if (stepRaw !== null && !AUM_STEPS.some((s) => s.name === stepRaw.trim())) {
    throw badRequest(
      `'step' must be one of ${AUM_STEPS.map((s) => s.name).join(", ")} — got '${stepRaw}'`,
      { parameter: "step" },
    );
  }
  return { windowKey, stepRaw, chainKey: (url.searchParams.get("chain") ?? "").trim().toLowerCase() };
}

async function resolveChain(chainKey: string): Promise<{ network_id: number; name: string } | null> {
  if (!chainKey) return null;
  const [c] = await sql`select network_id, name from chains where name = ${chainKey}`;
  if (!c) {
    const all = await sql`select name from chains order by name`;
    throw badRequest(
      `'chain' must be one of ${all.map((r) => r.name).join(", ")} — got '${chainKey}'`,
      { parameter: "chain" },
    );
  }
  return { network_id: Number(c.network_id), name: String(c.name) };
}

/** Solana's network id, needed to tell the one Solana wallet from the one EVM wallet. */
const SOLANA_NET = 1399811149;

/**
 * Build one trader's AUM envelope from rows already fetched.
 *
 * Pure: it does no I/O, so the same rows always produce the same answer. That is what lets
 * `POST /v1/traders/aum` return a row identical to `GET /v1/traders/:id/aum` instead of a
 * summary that drifts from it.
 */
function buildAum(
  t: { handle: string; display_handle: string },
  rows: Record<string, unknown>[],
  chainRows: Record<string, unknown>[],
  presence: { chains: number; on_solana: boolean; on_evm: boolean } | null,
  opts: { windowKey: string; stepRaw: string | null; chainFilter: { network_id: number; name: string } | null; to: Date },
) {
  const { windowKey, stepRaw, chainFilter, to } = opts;
  const span = AUM_WINDOWS[windowKey];
  const from = span === null ? null : new Date(to.getTime() - span);

  /*
   * THE READING JUST BEFORE THE WINDOW IS KEPT, as an anchor.
   *
   * History steps once a day, so a 24-hour window contained at most one point and usually
   * none -- `window=1d` drew nothing for anybody. But a one-day chart wants exactly two
   * figures: what he was worth at the start of the day and what he is worth now. We hold
   * both; the older one simply sat one row outside the filter.
   *
   * So the newest reading BEFORE the window joins the series, marked `outsideWindow` so it is
   * never mistaken for one inside it. `reach.coveredFrom` reports where the line really
   * starts. This also stops 7d and 30d beginning a day late for the same reason.
   */
  const inWindow = from === null ? rows : rows.filter((r) => Date.parse(String(r.at)) >= from.getTime());
  const before = from === null
    ? []
    : rows.filter((r) => Date.parse(String(r.at)) < from.getTime());

  /*
   * Reach back far enough for a LINE, not just for one point.
   *
   * One anchor is not always enough. History steps once a day and the newest step can be a
   * day and a half old, so the last 24 hours held nothing and the single preceding reading
   * gave one point -- still not a line. Taking preceding readings until the series holds two
   * turns `window=1d` into the two figures a one-day chart actually wants.
   *
   * Nothing here is invented: every point is a real dated reading, the ones from before the
   * window carry `outsideWindow`, and `reach.coveredFrom`/`coveredTo` report the span the
   * line truly covers rather than the span that was asked for.
   */
  /*
   * BORROWED POINTS MUST SHARE THE NEWEST POINT'S BASIS.
   *
   * Two numbers valued on different bases are not a line. unipcs held a sampled reading of
   * $15,665,318 and a rebuilt one of $5,101,125 eight hours apart -- a 67% fall that never
   * happened, because the two count different things. Borrowing across that seam would have
   * drawn exactly the cliff the whole basis/tier distinction exists to prevent.
   *
   * So a borrowed reading has to be the same kind as the one it is being compared with.
   */
  const NEED = 2;
  const newestBasis = rows.length ? String(rows[rows.length - 1].basis) : null;
  const comparable = newestBasis === null
    ? before
    : before.filter((r) => String(r.basis) === newestBasis);

  /*
   * Borrow until the series holds two readings THAT CARRY A FIGURE.
   *
   * Counting rows rather than figures was not enough: GeorgeDroid holds 28 real points, but
   * his two most recent rebuilt readings are both refused, so taking "the last two rows"
   * took two blanks and drew nothing. A refused day is not half a line.
   */
  const hasFigure = (r: Record<string, unknown>) => n(r.total_usd) !== null;
  const anchors: Record<string, unknown>[] = [];
  let have = inWindow.filter(hasFigure).length;
  for (let i = comparable.length - 1; i >= 0 && have < NEED; i--) {
    anchors.unshift(comparable[i]);
    if (hasFigure(comparable[i])) have++;
  }
  const windowed = [...anchors, ...inWindow];
  const anchorAts = new Set(anchors.map((r) => new Date(String(r.at)).toISOString()));

  /*
   * The default step is the coarsest that still leaves at least 24 points, so a week does
   * not arrive as 168 points nobody plots and a day does not collapse to 1.
   */
  const chosen = stepRaw !== null
    ? AUM_STEPS.find((s) => s.name === stepRaw.trim())!
    : [...AUM_STEPS].reverse().find((s) =>
        span === null || Math.floor(span / s.ms) >= 24
      ) ?? AUM_STEPS[0];

  /*
   * Thin by keeping the LAST point in each bucket rather than the first or an average.
   * Averaging would invent a balance he never held, and a refused hour averaged with a
   * measured one would launder the refusal into a number.
   */
  const kept = new Map<number, Record<string, unknown>>();
  for (const r of windowed) {
    const ms = Date.parse(String(r.at));
    if (!Number.isFinite(ms)) continue;
    kept.set(Math.floor(ms / chosen.ms), r);
  }
  const points = [...kept.values()].map((r) => ({
    at: new Date(String(r.at)).toISOString(),
    totalUsd: round(n(r.total_usd)),
    basis: r.basis as string,
    tier: r.tier as string,
    coverage: {
      pricedPositions: r.priced_positions === null ? null : Number(r.priced_positions),
      totalPositions: r.total_positions === null ? null : Number(r.total_positions),
      valueShare: n(r.value_share),
      /*
       * HOW MUCH OF HIM THIS DAY IS, per point rather than per response.
       *
       * A rebuilt day used to be refused outright unless every chain answered at it, which
       * refused 8,894 days across the directory while the per-chain figures for those days
       * existed all along. The day is now stated with the chains that answered -- and these
       * two numbers are the reason that is safe. `chainsAnswered` below `chainsTotal` means
       * the total is a real figure for PART of him, and a consumer can decide whether to
       * draw it. Null on a single-chain series, where the question does not apply.
       */
      chainsAnswered: r.chains_answered === null ? null : Number(r.chains_answered),
      chainsTotal: r.chains_expected === null ? null : Number(r.chains_expected),
      partial: r.chains_answered === null || r.chains_expected === null
        ? null
        : Number(r.chains_answered) < Number(r.chains_expected),
    },
    ...(r.refused_reason ? { refused: r.refused_reason as string } : {}),
    /** True for a real dated reading borrowed from just before the requested window. */
    ...(anchorAts.has(new Date(String(r.at)).toISOString()) ? { outsideWindow: true } : {}),
  }));

  /**
   * The moment real sampling began. Everything before it is a marked rebuild, everything
   * after is measured, and the response never blurs the two together.
   */
  /*
   * WINDOW-INDEPENDENT, both of them. What a trader is worth right now does not depend on how
   * much of his past you asked for, and computing these from the windowed rows meant asking
   * for one day hid the current total entirely -- `now: null` on a trader carrying a month of
   * history and a $5.1M balance.
   */
  const firstSampled = rows.find((r) => r.basis === "sampled");
  const trackedSince = firstSampled ? new Date(String(firstSampled.at)).toISOString() : null;
  const newest = rows.length ? rows[rows.length - 1] : null;

  /*
   * REACH -- what the stored data actually covers, as opposed to what was asked for.
   * `from` echoes the request and is not evidence of anything; a caller that reads it as
   * coverage will label a one-point series "30D".
   */
  const firstAt = points.length ? Date.parse(points[0].at) : null;
  const lastAt  = points.length ? Date.parse(points[points.length - 1].at) : null;
  const requestedDays = span === null ? null : Math.round(span / 86_400_000);
  const coveredDays = firstAt !== null && lastAt !== null
    ? Math.max(0, Math.round((lastAt - firstAt) / 86_400_000))
    : 0;

  /*
   * DOES THE DATA REACH BACK TO WHAT WAS ASKED FOR -- measured as a gap, not a day count.
   *
   * The first version compared coveredDays against requestedDays, which is off by one bucket
   * by construction: thirty daily points span twenty-nine days of difference, so a complete
   * month always reported 29 of 30 and `complete: false`. pointfarmcap had all thirty days
   * present and valued and still failed the PRD's own acceptance test.
   *
   * What actually matters is whether the oldest point we hold sits at or before the start of
   * the requested window, allowing one step of slack -- a daily series cannot be expected to
   * land exactly on a boundary computed to the millisecond.
   */
  /*
   * The slack is the DATA's granularity, not the requested step. Rebuilt history is daily, so
   * a week asked for at six-hour steps would judge a complete daily series "short" purely
   * because its oldest point sits a day inside a boundary computed to the millisecond. That
   * is a category error, not a coverage gap -- pointfarmcap held all thirty days and was
   * reported short on the 1w window. So the tolerance is the larger of the requested step and
   * the median spacing of the points we actually hold.
   */
  const spacings: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const gap = Date.parse(points[i].at) - Date.parse(points[i - 1].at);
    if (Number.isFinite(gap) && gap > 0) spacings.push(gap);
  }
  spacings.sort((a, b) => a - b);
  const medianGap = spacings.length ? spacings[Math.floor(spacings.length / 2)] : 0;
  const slack = Math.max(chosen.ms, medianGap);

  const reachesBack = from === null
    ? points.length > 0
    : firstAt !== null && firstAt - from.getTime() <= slack;

  /*
   * TWO DATED FIGURES ARE A LINE. One never is.
   *
   * This threshold was three, taken from the compatibility rule in
   * GENIE_FOMO_V7_BATCH_AUM_AND_COVERAGE_PRD.md -- but that rule is what the CONSUMER applies
   * when we decline to say anything, not what we should demand of ourselves. Their own
   * measurement states the rule they actually draw by: "two or more real points, which is the
   * owner's rule (one point is never a line)". Holding out for a third made a real two-point
   * series undrawable and put our flag out of step with the figures we report.
   */
  const MIN_DRAWABLE_POINTS = 2;
  const usable = points.filter((p) => p.totalUsd !== null);
  let drawable = true;
  let reason: string | null = null;
  if (usable.length < MIN_DRAWABLE_POINTS) {
    /*
     * Fewer than three numbers. Which of these it is matters: a backfill that has not
     * finished is temporary and worth waiting for, a refusal is not.
     */
    drawable = false;
    reason = newest?.refused_reason
      ? String(newest.refused_reason)
      : (usable.length === 0 ? "warming" : "too_few_points");
  } else if (!reachesBack) {
    // Enough points to draw, but not across the span that was asked for. Both facts are true
    // and the consumer needs the second one to label its axis honestly.
    drawable = false;
    reason = "short_coverage";
  }

  /** Gaps are returned, never smoothed over. A chart breaks its line at each of these. */
  const gaps = points
    .filter((p) => p.totalUsd === null)
    .map((p) => ({ at: p.at, reason: (p as { refused?: string }).refused ?? "no_prices" }));

  /*
   * How much of the trader the newest point could see, in wallets and chains. A chain we
   * hold no row for did not contribute zero dollars -- it contributed nothing at all.
   */
  const totalChains = Number(presence?.chains ?? 0);
  const answeredNets = new Set(
    chainRows.filter((r) => r.total_usd !== null).map((r) => Number(r.network_id)));
  const totalWallets = (presence?.on_evm ? 1 : 0) + (presence?.on_solana ? 1 : 0);
  const answeredWallets =
    ([...answeredNets].some((x) => x !== SOLANA_NET) ? 1 : 0) +
    (answeredNets.has(SOLANA_NET) ? 1 : 0);

  const warming = drawable === false && (reason === "warming" || reason === "short_coverage");
  const nextRun = new Date();
  nextRun.setUTCHours(6, 0, 0, 0);
  if (nextRun.getTime() <= Date.now()) nextRun.setUTCDate(nextRun.getUTCDate() + 1);

  return {
    handle: t.display_handle,
    /** Null means the whole portfolio. A name means this series is that chain alone. */
    chain: chainFilter ? chainFilter.name : null,
    window: windowKey,
    step: chosen.name,
    /** The step in milliseconds, so a consumer need not parse "6h". */
    stepMs: chosen.ms,
    from: from ? from.toISOString() : (points[0]?.at ?? null),
    to: to.toISOString(),
    trackedSince,
    now: newest
      ? {
        at: new Date(String(newest.at)).toISOString(),
        totalUsd: round(n(newest.total_usd)),
        coverage: {
          pricedPositions: newest.priced_positions === null ? null : Number(newest.priced_positions),
          totalPositions: newest.total_positions === null ? null : Number(newest.total_positions),
          valueShare: n(newest.value_share),
        },
        tier: newest.tier as string,
      }
      : null,
    count: points.length,

    /** What the stored data covers, as opposed to what was requested. */
    reach: {
      requestedFrom: from ? from.toISOString() : null,
      coveredFrom: points.length ? points[0].at : null,
      coveredTo: points.length ? points[points.length - 1].at : null,
      requestedDays,
      coveredDays,
      complete: reachesBack,
    },

    /**
     * The service's own answer to "can this be drawn". Consumers must not infer readiness
     * from `window`, `from`, `count` or the position counts.
     */
    drawing: { drawable, usablePoints: usable.length, reason },

    /** Coverage of the newest point, in wallets and chains rather than positions. */
    coverage: { answeredWallets, totalWallets, answeredChains: answeredNets.size, totalChains },

    /** `ready` means this is what we have; `warming` means the same call returns more later. */
    status: warming ? "warming" : "ready",
    progress: warming
      ? { coveredDays, targetDays: requestedDays ?? coveredDays, nextRunAt: nextRun.toISOString() }
      : null,

    gaps,
    points,
    chains: chainRows.map((r) => ({
      chain: r.chain as string,
      networkId: Number(r.network_id),
      totalUsd: round(n(r.total_usd)),
      pricedShare: n(r.priced_share),
      ...(r.reason ? { reason: r.reason as string } : {}),
    })),
    /** Non-null only when the NEWEST sample was refused; the reason names which wall we hit. */
    refused: newest?.refused_reason ?? null,
    plain: !newest
      ? "No balance samples for this trader yet — the sampler has not covered them."
      : newest.total_usd === null
      ? `The most recent reading was refused (${newest.refused_reason}), so there is no total for it. ` +
        `A partial total would read like a real drawdown.`
      : `${points.length} point${points.length === 1 ? "" : "s"} over ${windowKey} at ${chosen.name} steps` +
        (chainFilter ? ` on ${chainFilter.name} alone` : "") + "." +
        (trackedSince === null
          ? " Every point is a marked rebuild — sampling has not started."
          : rows.some((r) => r.basis === "rebuilt")
          ? ` Points before ${trackedSince} are rebuilt from chain transfers, not measured.`
          : ""),
  };
}

/**
 * AUM envelopes for MANY traders in a fixed number of queries.
 *
 * WHY SET-BASED AND NOT A LOOP. The individual route answers in about 3.1 seconds, so fifty
 * of them in sequence is roughly 158 -- an order of magnitude past the 15-second route
 * budget. That is the reason the batch route used to return a five-field summary instead of
 * the real envelope, and why Genie could not read the service's own drawing verdict. Four
 * queries answer fifty traders as readily as one.
 *
 * The per-trader arithmetic stays in buildAum(), which does no I/O, so the batch row and the
 * individual response are the same object built by the same code rather than two shapes kept
 * in sync by hand.
 */
async function aumFor(
  handles: string[],
  opts: { windowKey: string; stepRaw: string | null; chainFilter: { network_id: number; name: string } | null },
): Promise<Map<string, ReturnType<typeof buildAum>>> {
  const out = new Map<string, ReturnType<typeof buildAum>>();
  if (!handles.length) return out;

  const to = new Date();

  /*
   * EVERY ROW, WINDOWED IN MEMORY. The window used to be a WHERE clause, which meant a short
   * window could not see the reading just outside it -- and `window=1d` returned nothing at
   * all, not even the current total, for a trader we hold a month of history for.
   */
  const traders = await sql`
    select handle, display_handle from traders where handle = any(${handles})`;
  if (!traders.length) return out;
  const present = traders.map((r) => String(r.handle));

  /*
   * Coverage on a chain series is `pricedShare` and nothing else. The position counts on the
   * parent row are whole-trader for a sampled point and one chain's for a rebuilt one.
   */
  const rows = opts.chainFilter
    ? await sql`
        select a.handle, a.at, a.total_usd, a.reason as refused_reason,
               null::int as priced_positions, null::int as total_positions,
               a.priced_share as value_share, a.basis, s.tier,
               null::int as chains_answered, null::int as chains_expected
        from aum_chain_samples a
        join aum_samples s
          on s.handle = a.handle and s.at = a.at and s.basis = a.basis
        where a.handle = any(${present}) and a.network_id = ${opts.chainFilter.network_id}
        order by a.handle, a.at asc`
    : await sql`
        select handle, at, total_usd, refused_reason, priced_positions, total_positions,
               value_share, basis, tier, chains_answered, chains_expected
        from aum_samples
        where handle = any(${present})
        order by handle, at asc`;

  const byHandle = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const h = String(r.handle);
    let a = byHandle.get(h); if (!a) byHandle.set(h, a = []);
    a.push(r);
  }

  /*
   * The chain split of each trader's NEWEST point, in one query rather than one per trader.
   * The (handle, at, basis) triples are joined through unnest so the database matches them
   * instead of us issuing fifty lookups.
   */
  const nh: string[] = [], na: string[] = [], nb: string[] = [];
  for (const h of present) {
    const rs = byHandle.get(h);
    if (!rs?.length) continue;
    const newest = rs[rs.length - 1];
    nh.push(h); na.push(String(newest.at)); nb.push(String(newest.basis));
  }
  const chainRows = nh.length
    ? await sql`
        select a.handle, c.name as chain, a.network_id, a.total_usd, a.priced_share, a.reason
        from aum_chain_samples a
        join chains c using (network_id)
        join unnest(${nh}::text[], ${na}::timestamptz[], ${nb}::text[]) as u(handle, at, basis)
          on u.handle = a.handle and u.at = a.at and u.basis = a.basis
        order by a.handle, a.total_usd desc nulls last`
    : [];
  const chainsBy = new Map<string, Record<string, unknown>[]>();
  for (const r of chainRows) {
    const h = String(r.handle);
    let a = chainsBy.get(h); if (!a) chainsBy.set(h, a = []);
    a.push(r);
  }

  const presenceRows = await sql`
    select handle, count(distinct network_id)::int as chains,
           bool_or(network_id = ${SOLANA_NET}) as on_solana,
           bool_or(network_id <> ${SOLANA_NET}) as on_evm
    from holdings_current where handle = any(${present}) and human_amount > 0
    group by handle`;
  const presBy = new Map(presenceRows.map((r) => [String(r.handle), {
    chains: Number(r.chains), on_solana: r.on_solana === true, on_evm: r.on_evm === true,
  }]));

  for (const t of traders) {
    const h = String(t.handle);
    out.set(h, buildAum(
      { handle: h, display_handle: String(t.display_handle) },
      byHandle.get(h) ?? [],
      chainsBy.get(h) ?? [],
      presBy.get(h) ?? null,
      { ...opts, to },
    ));
  }
  return out;
}

get("/v1/traders/:handle/aum", async ({ handle }, url) => {
  const h = await resolveTrader(handle);
  const { windowKey, stepRaw, chainKey } = aumOptions(url);
  const chainFilter = await resolveChain(chainKey);
  const got = await aumFor([h], { windowKey, stepRaw, chainFilter });
  const envelope = got.get(h);
  if (!envelope) throw notFound(`no trader '${handle}' in the directory`);
  return envelope;
});

// ------------------------------------------------------------- trades (§4)

/**
 * The trader's own swaps, both sides, valued from the money side.
 *
 * PRD §4 asks for every swap on every chain. This serves what we have RESOLVED, which is
 * Solana only, and states that in `coverage` rather than implying the rest were quiet.
 *
 * Why only Solana: a swap is the wallet's own two-sided trade, and finding those on EVM was
 * measured and failed. A complete eth_getLogs scan of robinhood -- 2,000,000 blocks, every
 * wallet in the topic array -- produced 30,384 candidate (tx, wallet) groups and ZERO
 * two-sided swaps, because that chain matches off-chain and only settles on-chain in
 * Multicall3 batches. Across all four EVM chains our stored transactions hold 81
 * swap-shaped groups against Solana's 4,696.
 *
 * `valueUsd` comes from the MONEY side -- what was actually paid or received in a coin whose
 * dollar value we know -- not from multiplying the memecoin by a guessed price. That is why
 * it can be trusted where a price cannot.
 */
get("/v1/traders/:handle/trades", async ({ handle }, url) => {
  const h = await resolveTrader(handle);
  const [t] = await sql`
    select t.handle, t.display_handle, w.evm_address_key, lower(w.sol_address) as sol_key
    from traders t left join wallets w using (handle) where t.handle = ${h}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const addrs = [t.sol_key, t.evm_address_key].filter((a): a is string => !!a);
  const limit = intParam(url, "limit", { min: 1, max: 500, fallback: 100 })!;
  const chainQ = (url.searchParams.get("chain") ?? "").trim().toLowerCase() || null;
  const since = url.searchParams.get("since");

  const rows = addrs.length
    ? await sql`
      select ws.tx_hash, ws.block_time, ws.network_id, c.name as chain,
             ws.token_key, tk.address as token_address,
             coalesce(ti.symbol, tk.symbol) as token_symbol,
             ws.token_delta, ws.quote_key, ws.quote_delta, ws.quote_usd,
             qa.symbol as quote_symbol
      from wallet_swaps ws
      join chains c using (network_id)
      left join tokens tk on tk.network_id = ws.network_id and tk.token_key = ws.token_key
      left join token_info ti on ti.network_id = ws.network_id and ti.token_key = ws.token_key
      left join quote_assets qa on qa.network_id = ws.network_id and qa.token_key = ws.quote_key
      where ws.address_key = any(${addrs})
        and (${chainQ}::text is null or c.name = ${chainQ})
        and (${since}::timestamptz is null or ws.block_time >= ${since}::timestamptz)
      order by ws.block_time desc nulls last, ws.tx_hash
      limit ${limit + 1}`
    : [];

  const capped = rows.length > limit;
  const page = capped ? rows.slice(0, limit) : rows;

  /** Chains this trader has traded on at all, so the gap is visible rather than implied. */
  const presence = await sql`
    select chain, trades_seen from wallet_chain_presence where handle = ${h} order by trades_seen desc`;
  const resolvedChains = new Set(page.map((r: any) => r.chain as string));

  return {
    handle: t.display_handle,
    count: page.length,
    /** The cap is stated on every response — a silently truncated page under-counts a roster. */
    limit,
    capped,
    trades: page.map((r: any) => {
      const td = n(r.token_delta), qd = n(r.quote_delta), usd = n(r.quote_usd);
      return {
        chain: r.chain as string,
        networkId: Number(r.network_id),
        txHash: r.tx_hash as string,
        at: r.block_time ? new Date(String(r.block_time)).toISOString() : null,
        /** Which way the trader went. Derived from the token side, not from a label. */
        side: td === null ? null : td > 0 ? "buy" : "sell",
        token: { address: r.token_address ?? null, symbol: r.token_symbol ?? null,
                 amount: td === null ? null : Math.abs(td) },
        /** What it was paid with or received in — the leg whose dollar value we know. */
        money: { symbol: r.quote_symbol ?? null, tokenKey: r.quote_key ?? null,
                 amount: qd === null ? null : Math.abs(qd) },
        valueUsd: usd === null ? null : round(Math.abs(usd)),
        valueSource: usd === null ? null : "money_side",
        /** Implied by the two legs, for cross-checking — not a quoted price. */
        priceUsd: usd !== null && td !== null && td !== 0
          ? Number((Math.abs(usd) / Math.abs(td)).toPrecision(12)) : null,
        tier: "verified",
      };
    }),
    /**
     * What is NOT here. §4 asks for every chain; we resolve Solana. Saying which chains a
     * trader trades on but we cannot serve is the difference between a gap and a lie.
     */
    coverage: {
      chainsResolved: [...resolvedChains],
      chainsTradedButUnresolved: presence
        .map((p: any) => p.chain as string)
        .filter((c: string) => !resolvedChains.has(c)),
      why: "swaps are resolved from chain for Solana only — a complete scan of the EVM " +
           "chains found no two-sided swaps to resolve, so those trades are visible as " +
           "positions on /positions but not as individual swaps here",
    },
    source: "postgres · wallet_swaps (helius rpc pre/post balances)",
  };
});

// ----------------------------------------------------------- batch reads (§8)

/** Up to this many traders per batch call. Stated in the answer, never silently applied. */
const BATCH_MAX = 50;

/**
 * Read `ids` from a POST body, accepting handles or `trd_` ids, and refusing loudly.
 *
 * A background pass over 435 traders cannot make 435 calls an hour. These exist so it can
 * make nine. The cap is returned on every response because a silently truncated list is how
 * a roster under-counts without anyone noticing.
 */
async function batchIds(
  body: unknown,
): Promise<{ requested: string[]; handles: string[]; asked: number; capped: boolean }> {
  const ids = (body as { ids?: unknown })?.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw badRequest("body must be { \"ids\": [...] } with at least one id or handle",
                     { parameter: "ids" });
  }

  /*
   * OVER THE CAP IS A REFUSAL, NOT A TRIM.
   *
   * This used to read the first fifty and set `capped: true`. That is a correct description
   * of what happened and still the wrong behaviour: the caller asked about sixty traders and
   * got a 200, so the ten it never heard about look exactly like ten traders with no data.
   * GENIE_FOMO_V7_BATCH_AUM_TDR.md §6 asks for the refusal instead, and a 400 naming the cap
   * is a bug the caller fixes once rather than a silent under-count it never notices.
   */
  if (ids.length > BATCH_MAX) {
    throw badRequest(
      `at most ${BATCH_MAX} ids per call — got ${ids.length}; split the list rather than ` +
      `relying on truncation`,
      { parameter: "ids" });
  }

  const wanted = ids.map(String);

  /*
   * A DUPLICATE IS AMBIGUOUS, so it is refused rather than collapsed. Two entries for one
   * trader mean the caller expects two rows, and returning one silently breaks the
   * one-result-per-input guarantee the same section requires. Duplicates are detected after
   * resolution too, because a handle and its stable id are the same trader spelled twice.
   */
  const seen = new Set<string>();
  for (const k of wanted) {
    const norm = k.trim().toLowerCase();
    if (seen.has(norm)) {
      throw new ApiError(400, "duplicate_identifier",
        `'${k}' appears more than once — every id must be distinct`,
        { parameter: "ids" });
    }
    seen.add(norm);
  }

  /*
   * RESOLVE ALL FIFTY IN ONE QUERY, not one query each.
   *
   * resolveTrader() looks an id up in the database, so mapping it over the list issued fifty
   * round trips through the pooler -- about nine seconds of a call whose actual data costs
   * 1.2. Measured on a 50-id batch: 9.9s for a window returning 65KB, which is the giveaway
   * that the payload was never the problem. One `any()` answers the whole list.
   */
  const uuidish = wanted.filter((k) => UUID_RE.test(k.trim().replace(/^trd_/, "")));
  const byId = new Map<string, string>();
  if (uuidish.length) {
    const bare = uuidish.map((k) => k.trim().replace(/^trd_/, ""));
    const found = await sql`
      select id, handle from traders where id = any(${bare}::uuid[])`;
    for (const r of found) byId.set(String(r.id).toLowerCase(), String(r.handle));
  }
  const handles = wanted.map((k) => {
    const bare = k.trim().replace(/^trd_/, "").toLowerCase();
    return byId.get(bare) ?? k.trim().toLowerCase();
  });

  const resolved = new Set<string>();
  for (const [i, h] of handles.entries()) {
    if (resolved.has(h)) {
      throw new ApiError(400, "duplicate_identifier",
        `'${wanted[i]}' resolves to a trader already named earlier in the list — ` +
        `an id and its handle are the same trader`,
        { parameter: "ids" });
    }
    resolved.add(h);
  }

  /*
   * `requested` is what the caller actually sent, kept beside the resolved handle.
   *
   * Without it a response is ambiguous the moment a handle changes: the caller asked about
   * an id, the row comes back under a handle, and nothing in between says they are the same
   * trader. GENIE_FOMO_V7_BATCH_AUM_TDR.md §5 asks for the submitted value to be echoed for
   * exactly this reason, so a row can be joined back without guessing.
   */
  return { requested: wanted, handles, asked: wanted.length, capped: false };
}

const batchEnvelope = (asked: number, capped: boolean) => ({
  limit: BATCH_MAX,
  asked,
  /** True when the caller sent more than the cap; the extras were NOT read. */
  capped,
  ...(capped
    ? { note: `only the first ${BATCH_MAX} ids were read — send the rest in another call` }
    : {}),
});

/**
 * Positions for many traders in one call.
 *
 * POST rather than GET because fifty ids do not belong in a query string: a 2 KB URL breaks
 * proxies and fills logs. Nothing here mutates -- it is a read that needs a body.
 */
/**
 * Positions for many traders in one call.
 *
 * POST rather than GET because fifty ids do not belong in a query string: a 2 KB URL breaks
 * proxies and fills logs. Nothing here mutates -- it is a read that needs a body.
 *
 * TWO CONTRACTS, CHOSEN BY THE CALLER, for the same reason as batch AUM. `contractVersion: 2`
 * names every row by the value submitted and the canonical id, states explicitly whether each
 * one succeeded, and reports the counts and completeness
 * GENIE_FOMO_V7_BATCH_AUM_TDR.md §3 asks for. Without that field the older shape is returned
 * unchanged.
 *
 * DELIBERATELY NOT INCLUDED: the holding/activity times the individual route returns. Those
 * come from an aggregate over `transactions` that costs 12.5 seconds for our busiest trader,
 * measured; running it fifty times would take the call far past any sane budget. A consumer
 * that needs them reads the individual route for the trader it is showing, which is the one
 * place the cost is worth paying.
 */
post("/v1/traders/positions", async (_p, _url, body) => {
  const { requested, handles, asked, capped } = await batchIds(body);
  const v2 = Number((body as { contractVersion?: number })?.contractVersion) === 2;

  const rows = await sql`
    select h.handle, ch.name as chain, h.network_id, tk.address as token_address,
           coalesce(ti.symbol, tk.symbol) as symbol,
           h.human_amount, h.price, h.value, h.source, h.captured_at,
           h.price_source, h.priced_at
    from holdings_current h
    join chains ch using (network_id)
    join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    left join token_info ti on ti.network_id = h.network_id and ti.token_key = h.token_key
    where h.handle = any(${handles})
    order by h.handle, h.value desc nulls last`;

  const by = new Map<string, any[]>();
  for (const r of rows) {
    if (!by.has(String(r.handle))) by.set(String(r.handle), []);
    by.get(String(r.handle))!.push(r);
  }

  const position = (r: Record<string, unknown>) => ({
    chain: r.chain, networkId: Number(r.network_id),
    tokenAddress: r.token_address, symbol: r.symbol,
    amount: n(r.human_amount),
    /** §3: the moment the balance was read, not the moment you asked. */
    balanceAt: r.captured_at ? new Date(String(r.captured_at)).toISOString() : null,
    priceUsd: n(r.price),
    priceSource: (r.price_source as string) ?? null,
    pricedAt: r.priced_at ? new Date(String(r.priced_at)).toISOString() : null,
    valueUsd: n(r.value),
    /** null, never 0 — an unpriceable coin is not a worthless one. */
    whyNoPrice: n(r.value) === null ? "no price for this token in any source we hold" : null,
    tier: r.source === "chain" ? "verified" : "reported",
  });

  if (v2) {
    const known = await sql`
      select handle, display_handle, id from traders where handle = any(${handles})`;
    const metaBy = new Map(known.map((r) => [String(r.handle), r]));

    return {
      contractVersion: 2,
      ...batchEnvelope(asked, capped),
      /* One row per requested id, successes and failures alike. */
      traders: requested.map((req, i) => {
        const h = handles[i];
        const meta = metaBy.get(h);
        if (!meta) {
          return {
            ok: false as const,
            requested: req,
            id: null,
            handle: null,
            error: { code: "not_found", detail: `no trader '${req}' in the directory` },
          };
        }
        const own = by.get(h) ?? [];
        const priced = own.filter((r) => n(r.value) !== null && Number(r.value) > 0);
        /*
         * A null total means we could not value ANY of what he holds; zero means he was read
         * and holds nothing. Collapsing the two would turn an unreadable portfolio into an
         * empty one, which is the difference between "we do not know" and "there is nothing".
         */
        const totalValueUsd = own.length === 0
          ? 0
          : priced.length === 0
          ? null
          : round(priced.reduce((sum, r) => sum + Number(r.value), 0));
        return {
          ok: true as const,
          requested: req,
          id: meta.id ? String(meta.id) : null,
          handle: String(meta.display_handle),
          positions: own.map(position),
          positionCount: own.length,
          pricedPositionCount: priced.length,
          totalValueUsd,
          coverage: cov(priced.length, own.length),
          /*
           * Every position this trader holds is in this row -- the batch does not page, so a
           * consumer never has to wonder whether it saw all of them. `nextCursor` is null for
           * the same reason, and is present so the field means the same thing here as on the
           * individual route.
           */
          complete: true,
          nextCursor: null,
        };
      }),
    };
  }

  // ---- the pre-version-2 projection, unchanged so existing consumers keep working
  return {
    ...batchEnvelope(asked, capped),
    traders: handles.map((h) => {
      const own = by.get(h) ?? [];
      const priced = own.filter((r) => n(r.value) !== null && Number(r.value) > 0);
      return {
        handle: h,
        positions: own.map(position),
        coverage: cov(priced.length, own.length),
      };
    }),
  };
});

/**
 * AUM for many traders in one call.
 *
 * TWO CONTRACTS, CHOSEN BY THE CALLER. `contractVersion: 2` returns the identity-safe
 * envelope: one row per requested id, carrying the value submitted, the canonical id, and
 * the COMPLETE AUM object -- byte-identical to what `GET /v1/traders/:id/aum` returns for
 * the same trader and window, because both are built by the same function from the same
 * rows. Without that field the older projection is returned unchanged, so a consumer already
 * reading it keeps working until it migrates.
 *
 * The older shape identifies rows by display handle alone, which cannot survive a rename or
 * a folded-handle collision, and it drops the service's own `drawing` verdict -- leaving a
 * consumer to guess whether a short series is a warming backfill or a real refusal. That is
 * why version 2 exists; see GENIE_FOMO_V7_BATCH_AUM_AND_COVERAGE_PRD.md.
 */
post("/v1/traders/aum", async (_p, _url, body) => {
  const { requested, handles, asked, capped } = await batchIds(body);
  const b = body as { window?: string; step?: string; contractVersion?: number; chain?: string };
  const windowKey = (b?.window ?? "1w").trim();
  if (!(windowKey in AUM_WINDOWS)) {
    throw badRequest(`'window' must be one of ${Object.keys(AUM_WINDOWS).join(", ")}`,
                     { parameter: "window" });
  }
  const stepRaw = typeof b?.step === "string" ? b.step : null;
  if (stepRaw !== null && !AUM_STEPS.some((s) => s.name === stepRaw.trim())) {
    throw badRequest(`'step' must be one of ${AUM_STEPS.map((s) => s.name).join(", ")}`,
                     { parameter: "step" });
  }

  /*
   * A BATCH CAN NAME A CHAIN, because the history mostly lives in the per-chain answers.
   * Without this a screen of fifty traders on one chain was fifty calls; it is now one.
   * The individual route has always taken `?chain=`, and aumFor() is the same code for both,
   * so the two cannot disagree about what a chain series means.
   */
  const chainFilter = await resolveChain((b?.chain ?? "").trim().toLowerCase());
  const envelopes = await aumFor(handles, { windowKey, stepRaw, chainFilter });

  if (Number(b?.contractVersion) === 2) {
    const idRows = await sql`
      select handle, id from traders where handle = any(${handles})`;
    const idBy = new Map(idRows.map((r) => [String(r.handle), r.id ? String(r.id) : null]));

    return {
      contractVersion: 2,
      ...batchEnvelope(asked, capped),
      window: windowKey,
      /** Null when the batch asked for the whole portfolio; a name when it named a chain. */
      chain: chainFilter ? chainFilter.name : null,
      /*
       * EXACTLY ONE ROW PER REQUESTED ID, INCLUDING THE ONES THAT FAILED. An omitted row is
       * indistinguishable from a trader with no data, so an id we could not resolve comes
       * back as an explicit refusal rather than a hole in the list.
       */
      traders: requested.map((req, i) => {
        const h = handles[i];
        const aum = envelopes.get(h);
        if (!aum) {
          return {
            ok: false as const,
            requested: req,
            id: null,
            handle: null,
            error: { code: "not_found", detail: `no trader '${req}' in the directory` },
          };
        }
        return {
          ok: true as const,
          requested: req,
          id: idBy.get(h) ?? null,
          handle: aum.handle,
          aum,
        };
      }),
    };
  }

  // ---- the pre-version-2 projection, unchanged so existing consumers keep working
  return {
    ...batchEnvelope(asked, capped),
    window: windowKey,
    ...(chainFilter ? { chain: chainFilter.name } : {}),
    traders: handles.map((h) => {
      const aum = envelopes.get(h);
      return {
        handle: h,
        trackedSince: aum?.trackedSince ?? null,
        count: aum?.count ?? 0,
        now: aum?.now
          ? { at: aum.now.at, totalUsd: aum.now.totalUsd, tier: aum.now.tier,
              coverage: aum.now.coverage }
          : null,
        points: (aum?.points ?? []).map((p) => ({
          at: p.at,
          totalUsd: p.totalUsd,
          basis: p.basis,
          ...((p as { refused?: string }).refused ? { refused: (p as { refused?: string }).refused } : {}),
        })),
      };
    }),
  };
});

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
  const [c] = await sql`
    select (select count(*) from traders)                        as traders,
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
           (select max(last_seen_at) from wallets)                       as wallets_at,
           (select count(*) from aum_samples)::int                       as aum_rows,
           (select count(distinct handle) from aum_samples)::int         as aum_traders`;

  const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);

  /**
   * The share of traders carrying a usable rhythm figure (§5).
   *
   * Reported here rather than left for a consumer to discover by sampling scorecards, which
   * is how they found out it was zero last time.
   */
  const [m] = await sql`
    select count(*)::int as traders,
           count(*) filter (where exists (
             select 1 from trades tr where tr.handle = t.handle and tr.status = 'closed'
           ))::int as measurable
    from traders t`;

  return {
    status: "ok",
    runtime: "supabase edge function (deno)",
    source: "postgres",
    build: { capturedAt: b?.captured_at ?? null, window: b?.window_label ?? null },
    /** Per-feed freshness. A stale feed is visible here before it misleads a screen. */
    feeds: {
      traders:      { lastRefreshAt: iso(f.trades_at),       rowCount: null },
      wallets:      { lastRefreshAt: iso(f.wallets_at),      rowCount: null },
      positions:    { lastRefreshAt: iso(f.holdings_at),     rowCount: null },
      transactions: { lastRefreshAt: iso(f.transactions_at), rowCount: null },
      tokenInfo:    { lastRefreshAt: iso(f.token_info_at),   rowCount: null },
      aum:          { lastRefreshAt: iso(f.aum_at),          rowCount: Number(f.aum_rows),
                      traders: Number(f.aum_traders) },
    },
    measurements: {
      traders: Number(m.traders),
      withClosedTrades: Number(m.measurable),
      share: Number(m.traders) ? Number((Number(m.measurable) / Number(m.traders)).toFixed(4)) : null,
    },
    rows: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number(v)])),
    /** Which entries in `rows` are planner estimates rather than counted. */
    estimatedRows: ["transactions"],
    // Every route here answers from Postgres. Nothing in the request path calls fomoapi,
    // Helius, Bitquery or Etherscan — those keys belong to the scheduled loaders.
    externalCallsPerRequest: 0,
  };
});

// ----------------------------------------------------------------- wallets

/** Wallet rows for many traders at once, for the ISSUE-8 bulk route. */
const walletRows = (handles: string[]) => sql`
  select t.handle, t.id, t.display_handle, t.handle_changed_at,
         t.name, t.bio, t.avatar, t.twitter,
         w.evm_address, w.sol_address, w.evm_source, w.sol_source,
         w.evm_confidence, w.sol_confidence
  from traders t left join wallets w using (handle)
  where t.handle = any(${handles})`;

/** Shared by the single route and the bulk route, so the two cannot diverge. */
// deno-lint-ignore no-explicit-any
function walletsBody(t: any) {
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
}

/**
 * Resolve a path segment that may be a handle OR a stable id.
 *
 * `handle` is a display name and people change them; `id` is the uuid that never moves. Both
 * are accepted on EVERY per-trader route so a consumer can key on the stable one without
 * losing the readable one.
 *
 * This existed before and was wired into two routes out of ten. The other eight looked the
 * path segment up as a handle directly, so the id printed by the directory answered 404 on
 * the route the directory exists to point at -- exactly the failure
 * GENIE_FOMO_V7_BATCH_AUM_AND_COVERAGE_PRD.md reports as its first blocker. A resolver that
 * only some routes call is not a resolver, so it is now the single way in.
 *
 * Both spellings of the id are accepted, with and without the `trd_` prefix, because both
 * have been published and a consumer holding either must keep working.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveTrader(key: string): Promise<string> {
  const k = key.trim();
  // A uuid, with or without the `trd_` prefix the plugin team uses.
  const bare = k.replace(/^trd_/, "");
  if (UUID_RE.test(bare)) {
    const [r] = await sql`select handle from traders where id = ${bare}::uuid`;
    if (r) return r.handle as string;
  }

  /*
   * THE DIRECTORY'S OWN HANDLE HAS TO WORK, and for one trader it did not.
   *
   * `display_handle` is what every listing shows, and it is usually identical to `handle`.
   * It is not for `yeon__ (gmgn)`: two traders arrived sharing one folded handle, so a
   * migration appended the source to the display name to tell them apart. The directory then
   * published a name that this resolver could not resolve -- the only trader of 435 who
   * could not be charted at all, and the failure was ours, not the caller's.
   *
   * Tried only after the plain handle misses, so the ordinary case still costs no query.
   */
  const lower = k.toLowerCase();
  const [exact] = await sql`select handle from traders where handle = ${lower}`;
  if (exact) return exact.handle as string;

  const [byDisplay] = await sql`
    select handle from traders where lower(display_handle) = ${lower} limit 1`;
  if (byDisplay) return byDisplay.handle as string;

  return lower;
}

/**
 * Wallets, each with its FAMILY and the chains it has actually been seen on.
 *
 * PRD §2. `family` is `solana` or `evm` and never a chain, because one Ethereum-style
 * address is the same wallet on Ethereum, Base, BNB Chain and Robinhood Chain at once --
 * 140 of our 260 EVM-only traders trade on four of them. A consumer that assumes one chain
 * per address files a third of them as quiet while they trade daily.
 *
 * `chains` is what we have OBSERVED, never inferred from the address format. A chain we have
 * never seen the wallet on is absent, not `tradesSeen: 0` -- those are different claims.
 */
get("/v1/traders/:handle/wallets", async ({ handle }) => {
  const h = await resolveTrader(handle);
  const [t] = await walletRows([h]);
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const presence = await sql`
    select chain, network_id, trades_seen, last_active_at
    from wallet_chain_presence where handle = ${h} order by trades_seen desc`;

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
      chains: seen.filter((c) => c.networkId === SOLANA),
    });
  }
  if (t.evm_address) {
    wallets.push({
      address: t.evm_address as string,
      family: "evm",
      source: t.evm_source ?? null,
      chains: seen.filter((c) => c.networkId !== SOLANA),
    });
  }

  return {
    ...walletsBody(t),
    /**
     * The stable key. `handle` above is a display name and may change; this does not.
     *
     * ONE SPELLING, and it is the directory's. This route used to prefix the uuid with
     * `trd_` while `GET /traders` returned it bare, so the same trader had two ids depending
     * on which route you asked -- a consumer storing one and looking up the other found
     * nothing. The directory is what a consumer reads first, so the directory's form wins.
     * Both spellings are still ACCEPTED as input, forever; only the output is now consistent.
     */
    id: t.id ?? null,
    /** When the display handle last changed; a consumer can notice a rename. */
    handleChangedAt: t.handle_changed_at
      ? new Date(String(t.handle_changed_at)).toISOString() : null,
    /**
     * `[]` for a trader we hold no wallet for -- 3 of 435 today. An empty list is the
     * correct answer to "which wallets", not an error: they are registered, we simply
     * have no address.
     */
    wallets,
    /** A wallet with no observed chain says so rather than implying it is idle. */
    presence: wallets.every((w) => w.chains.length === 0) && wallets.length
      ? "not_yet_scanned" : "observed",
  };
});

// ------------------------------------------------------ T1 banked vs on paper

/**
 * The P&L aggregate, grouped so the bulk route gets every trader in one statement.
 *
 * Note `group by` returns NO row for a trader with no trades, where the single-trader query
 * returned one row of zeros. `pnlBody` therefore treats a missing row and a zero row
 * identically — see its signature.
 */
const pnlAgg = (handles: string[]) => sql`
  select handle,
         count(*) filter (where status = 'closed')::int  as closed,
         count(*) filter (where status <> 'closed')::int as open,
         coalesce(sum(realized_pnl_usd)   filter (where status = 'closed'), 0)  as realized,
         coalesce(sum(unrealized_pnl_usd) filter (where status <> 'closed'), 0) as unrealized,
         max(captured_at) as captured
  from trades where handle = any(${handles}) group by handle`;

/**
 * Split out for ISSUE-8, same reasoning as `scorecardBody`: the bulk route runs this exact
 * function rather than a parallel implementation that would drift on the first edit.
 */
// deno-lint-ignore no-explicit-any
function pnlBody(t: any, r: any | undefined) {
  const closed = Number(r?.closed ?? 0), open = Number(r?.open ?? 0);
  const realized = (r ? n(r.realized) : 0) ?? 0, unrealized = (r ? n(r.unrealized) : 0) ?? 0;
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
    // Same value under both names. `asOf` is the convention every other money route uses;
    // `capturedAt` predates it and is kept so existing consumers do not break.
    asOf: r?.captured ? new Date(String(r.captured)).toISOString() : null,
    capturedAt: r?.captured ?? null,
    plain,
  };
}

/**
 * T2.2. Profit derived from the chain, independent of fomo.
 *
 * Every other money figure on this API is fomo's, which is exactly what `/trust` exists to
 * test. This one is ours: both sides of each swap resolved from Helius RPC pre/post balances,
 * so a buy and its matching sell reconcile on quantity.
 *
 * It is deliberately narrow. `transactions.tx_type` is the TRANSACTION's type, not the
 * wallet's action — measured on 60 random rows tagged SWAP, the wallet was not even among the
 * transaction's accounts in 57. Only the two-sided remainder is a trade the wallet made, and
 * only those are counted here. Coverage says how few that is rather than hiding it.
 */
const chainPnl = (addrs: string[]) => sql`
  select count(*)::int                                             as swaps,
         count(distinct token_key)::int                            as tokens,
         coalesce(sum(quote_usd), 0)                               as net_cash_usd,
         count(*) filter (where quote_usd is null)::int            as unvalued,
         min(block_time)                                           as first_at,
         max(block_time)                                           as last_at
  from wallet_swaps where address_key = any(${addrs})`;

/**
 * Positions the wallet opened AND fully closed on chain — where the token quantity nets to
 * approximately zero, so the dollars in and out are a complete round trip.
 *
 * This is the only subset where "realised profit" is literally true. A position still open
 * has spent dollars and no proceeds; counting it would report every holder as loss-making.
 * The 1e-6 tolerance absorbs the rounding in a UI-unit balance, not a real residual.
 */
const chainRoundTrips = (addrs: string[]) => sql`
  select count(*)::int                          as closed_positions,
         coalesce(sum(net_usd), 0)              as realized_usd,
         count(*) filter (where net_usd > 0)::int as winners
  from (
    select token_key,
           sum(quote_usd)  as net_usd,
           sum(token_delta) as residual
    from wallet_swaps
    where address_key = any(${addrs}) and quote_usd is not null
    group by token_key
    having abs(sum(token_delta)) < 1e-6 and count(*) > 1
  ) s`;

get("/v1/traders/:handle/pnl", async ({ handle }) => {
  const [t] = await sql`
    select t.handle, t.display_handle, t.name, w.sol_address
    from traders t left join wallets w using (handle)
    where t.handle = ${await resolveTrader(handle)}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const addrs = t.sol_address ? [String(t.sol_address).toLowerCase()] : [];
  const [[r], [chain], [rt], [seen]] = await Promise.all([
    pnlAgg([t.handle as string]),
    addrs.length ? chainPnl(addrs) : Promise.resolve([undefined]),
    addrs.length ? chainRoundTrips(addrs) : Promise.resolve([undefined]),
    addrs.length
      ? sql`select count(*)::int as n from (
              select tx_hash from transactions
               where network_id = 1399811149 and tx_type = 'SWAP'
                 and address_key = any(${addrs}) group by tx_hash) x`
      : Promise.resolve([{ n: 0 }]),
  ]);

  const body = pnlBody(t, r) as Record<string, unknown>;
  const swaps = Number(chain?.swaps ?? 0);
  body.chainDerived = swaps
    ? {
      /**
       * Realised profit over positions opened and fully closed on chain. `null` rather than
       * 0 when none have round-tripped — "no closed position" is not "made nothing".
       */
      realizedUsd: Number(rt?.closed_positions ?? 0) > 0 ? round(n(rt?.realized_usd)) : null,
      closedPositions: Number(rt?.closed_positions ?? 0),
      winners: Number(rt?.winners ?? 0),
      /**
       * Dollars out minus dollars in across every resolved swap, open positions included.
       * Negative for anyone still holding, which is correct and is why it is named for cash
       * flow rather than profit.
       */
      netCashUsd: round(n(chain?.net_cash_usd)),
      swapsResolved: swaps,
      tokensTraded: Number(chain?.tokens ?? 0),
      firstSwapAt: chain?.first_at ? new Date(String(chain.first_at)).toISOString() : null,
      lastSwapAt: chain?.last_at ? new Date(String(chain.last_at)).toISOString() : null,
      tier: "verified",
      source: "postgres · wallet_swaps (helius rpc pre/post balances)",
      basis: "both sides of each swap resolved from the wallet's net balance change, so a " +
             "buy and its matching sell reconcile on quantity. Solana only.",
      coverage: cov(swaps, Number(seen?.n ?? 0)),
      note: "coverage is low BY CONSTRUCTION: most rows tagged SWAP are inbound transfers " +
            "inside someone else's transaction, not trades the wallet made. Only two-sided " +
            "swaps are counted, and this figure is independent of the fomo numbers above.",
    }
    : null;
  return body;
});
