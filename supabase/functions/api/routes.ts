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
    /**
     * THE CHAIN VOCABULARY IS CLOSED, AND SAYS SO.
     *
     * Chain words are this service's own -- a consumer takes them off this block and asks
     * with them verbatim, because a word they invented is a read spent on nothing. That only
     * works if the set is known to be complete: today there are five words, each with exactly
     * one network id and no collisions, but nothing said whether a sixth was a new chain or a
     * typo. `closed: true` means this list is the whole set; `vocabularyVersion` changes when
     * a word is added or retired, so a diff is a release note rather than a surprise.
     *
     * A word is never renamed in place. A rename is a retirement and an addition.
     */
    vocabulary: {
      closed: true,
      version: 1,
      words: rows.map((r) => String(r.name)).sort(),
      note: "one word per network id, one network id per word. Ask with these verbatim; " +
            "a word not in this list is not a chain this service indexes",
    },
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

/**
 * Each chain's own coin, and what one of them costs — so a chain's dollars can also be said
 * the way a wallet says them, "114.09 BNB" beside "$83.6K".
 *
 * The price has to be a MARKET price or it is worse than nothing. Most of what we hold for a
 * wrapped native is `fomo_reported_entry` — the price a trader reported paying, not what the
 * coin is worth now — and some rows carry a price with no source at all, which cannot be
 * stood behind either. Both are excluded, so three of five chains answer `null` today rather
 * than converting a portfolio at a number nobody can defend.
 *
 * Five rows, cached for the process: chains do not change and the price moves slowly enough
 * that a per-request query would be pure cost.
 */
type NativePrice = { symbol: string; usd: number | null; source: string | null };
let nativeCache: { at: number; by: Map<number, NativePrice> } | null = null;

async function nativePrices(): Promise<Map<number, NativePrice>> {
  if (nativeCache && Date.now() - nativeCache.at < 5 * 60_000) return nativeCache.by;
  const rows = await sql`
    with native as (
      select c.network_id, c.name, c.native_symbol,
             (select q.token_key from quote_assets q
               where q.network_id = c.network_id
                 and upper(q.symbol) in ('W' || upper(c.native_symbol), upper(c.native_symbol))
               order by (upper(q.symbol) = 'W' || upper(c.native_symbol)) desc
               limit 1) as token_key
      from chains c)
    select n.network_id, n.native_symbol,
           coalesce(tp.usd, hp.price, xc.usd) as usd,
           case when tp.usd is not null then 'token_prices_daily'
                when hp.price is not null then hp.price_source
                when xc.usd is not null then xc.source || ' (via ' || xc.chain || ')'
                else null end as source
    from native n
    left join lateral (
      select usd from token_prices p
      where p.network_id = n.network_id and p.token_key = n.token_key
      order by day desc limit 1) tp on true
    left join lateral (
      select h.price, h.price_source from holdings_current h
      where h.network_id = n.network_id and h.token_key = n.token_key
        and h.price is not null
        and h.price_source is not null and h.price_source <> 'fomo_reported_entry'
      order by h.priced_at desc nulls last limit 1) hp on true
    /*
     * ETH IS ETH, whichever chain it is the native coin of.
     *
     * ethereum and base carry no market price for their own native in our store, while
     * robinhood's curated WETH is priced at 2,478.49 and Solana's at 2,497.98 -- two
     * independent sources agreeing within 0.8%, which is a real price for the asset rather
     * than a quirk of one chain. Refusing to use it would leave two chains unpriced for no
     * reason a reader would accept.
     *
     * Matched on the NATIVE SYMBOL against the curated quote assets only, never on any token
     * calling itself ETH: the store holds several impostors under that symbol, one of them
     * priced at 0.00. The chain it came from is named in the source string, so the borrowing
     * is visible rather than implied.
     */
    left join lateral (
      select h.price as usd, h.price_source as source, c2.name as chain
      from quote_assets q2
      join chains c2 on c2.network_id = q2.network_id
      join holdings_current h
        on h.network_id = q2.network_id and h.token_key = q2.token_key
      where upper(q2.symbol) in ('W' || upper(n.native_symbol), upper(n.native_symbol))
        and h.price is not null and h.price > 0
        and h.price_source is not null and h.price_source <> 'fomo_reported_entry'
      order by h.priced_at desc nulls last limit 1) xc on true`;
  const by = new Map<number, NativePrice>();
  for (const r of rows) {
    by.set(Number(r.network_id), {
      symbol: String(r.native_symbol),
      usd: n(r.usd),
      source: r.source ? String(r.source) : null,
    });
  }
  nativeCache = { at: Date.now(), by };
  return by;
}

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

  const natives = await nativePrices();
  const chainCoverage = byChain.map((r) => {
    const net = Number(r.network_id);
    const usd = Number(r.priced) ? round(n(r.value)) : null;
    const nat = natives.get(net) ?? null;
    return {
      chain: r.chain,
      networkId: net,
      positions: Number(r.positions),
      priced: Number(r.priced),
      valueUsd: usd,
      /**
       * The same dollars said in the chain's own coin, which is how a wallet says them.
       *
       * `nativeAmount` is `valueUsd / nativeUsd` and nothing more, so the two always agree;
       * `nativeUsd` and `nativePriceSource` travel with it so the division can be rechecked
       * and so a consumer can see WHERE the rate came from.
       *
       * Null, never 0, when we hold no market price for that coin — see `whyNoNative`. A
       * portfolio converted at a price nobody can stand behind is a worse answer than none.
       */
      nativeSymbol: nat?.symbol ?? null,
      nativeUsd: nat?.usd ?? null,
      nativePriceSource: nat?.source ?? null,
      nativeAmount: nat?.usd && usd !== null
        ? Number((usd / nat.usd).toPrecision(10))
        : null,
      whyNoNative: nat?.usd && usd !== null ? null
        : usd === null ? "nothing on this chain carries a price"
        : "no market price for this chain's own coin — the only figures we hold for it are " +
          "traders' reported entry prices, which are not what it is worth now",
    };
  });

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
 * WHAT A BLACKLIST ANSWER LOOKS LIKE WHEN NOTHING WAS CHECKED.
 *
 * `listed` is null, not false. False would mean we looked and he was not on a list; null with
 * `checked: false` means we never looked, and those are opposite statements. `checkedAt` is
 * null for the same reason -- there was no check to time.
 */
const BLACKLIST_CHECK = {
  checked: false,
  lists: [] as string[],
  listed: null as boolean | null,
  checkedAt: null as string | null,
  why: "no blacklist, sanctions list or known-scam source is consulted by this route. " +
       "An absent blacklist flag means NOT CHECKED — never 'checked and clear'.",
};

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
    /**
     * WHAT WAS CHECKED, so an absent flag cannot be read as a clean bill of health.
     *
     * Every flag this route raises is an internal-consistency check on figures we already
     * hold: two numbers that cannot both be true, or too little evidence to judge. NOTHING
     * here consults an external reputation service, a blacklist, or a known-scam list.
     *
     * That distinction is the whole point of publishing this block. "We checked a blacklist
     * and this trader is not on it" and "we never looked" are opposite statements, and until
     * now an absent blacklist flag was indistinguishable from the first while meaning the
     * second. `blacklist.checked: false` says which one it is.
     */
    checks: {
      performed: [
        "pnl_exceeds_volume", "pnl_exceeds_holdings", "holdings_coverage_too_low",
        "too_few_trades", "partial_pricing",
      ],
      basis: "internal consistency only — figures we hold, checked against each other",
      blacklist: BLACKLIST_CHECK,
      externalReputation: { checked: false, sources: [] },
    },
    /**
     * The contract names `trust.blacklist`, so it is here as well as inside `checks`. Same
     * object, one source, so the two can never disagree.
     */
    blacklist: BLACKLIST_CHECK,
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
  /**
   * DELISTED TRADERS ARE NOT LISTED, and are still answerable by name.
   *
   * Four traders have no wallet and never will: fomoapi has dropped them from every
   * leaderboard window, and 377 GMGN KOL and smart-money entries matched none of them. A2 is
   * explicit about them -- "either given one or dropped from the directory; being listed and
   * unpriceable is the worst of both" -- because a trader on the board with no balance and no
   * chart is a blank a person cannot interpret.
   *
   * They are flagged, not deleted. `cmbarce` alone carries 103 holdings and 144 trades, and
   * the condition reverses the moment the source lists him again. So the board stops showing
   * them, `/traders/:handle` still answers for them, and `?includeDelisted=true` puts them
   * back in the listing for anyone reconciling against an older copy.
   */
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
    select t.handle, t.id, t.display_handle, t.name, t.avatar, t.last_seen_at, t.source,
           s.rank, s.pnl_usd, s.volume_usd, s.followers, s.trade_count, s.captured_at,
           case
             when ${q} = '' then 0
             when lower(t.display_handle) = ${q} or lower(coalesce(t.name,'')) = ${q} then 0
             when lower(t.display_handle) like ${q + "%"} or lower(coalesce(t.name,'')) like ${q + "%"} then 1
             else 2
           end as score
    from traders t
    left join trader_stats_current s using (handle)
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
  const [pnlRows, scRows, wRows, trRows, swapBy] = handles.length
    ? await Promise.all([
      include.includes("pnl") ? pnlAgg(handles) : Promise.resolve([]),
      wantsScorecard ? scorecardRows(handles) : Promise.resolve([]),
      include.includes("wallets") ? walletRows(handles) : Promise.resolve([]),
      include.includes("trust") ? trustHoldings(handles) : Promise.resolve([]),
      // Axes 5 and 2. One query for every swap on the page, from which the entry price, the
      // exit P&L and the individual buys are all derived -- see `swapsFor`.
      wantsScorecard ? swapsFor(handles) : Promise.resolve(new Map<string, Swap[]>()),
    ])
    : [[], [], [], [], new Map<string, Swap[]>()];

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
  /** One query for the page, not one per trader — same rule as every other include. */
  const knownChainsBy = include.includes("wallets")
    ? await knownChainsFor(page.map((r) => String(r.handle)))
    : new Map<string, KnownChain[]>();
  /** Same rule for fees: one read of the daily buckets for the whole page. */
  const feesBy = include.includes("scorecard")
    ? await nativePrices().then((nat) => feesFor(page.map((r) => String(r.handle)), nat))
    : new Map<string, FeeWindows>();
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

  /*
   * Month-start balances for the whole page in ONE query, not one per trader — the same rule
   * every other include here follows.
   */
  const startCapBy = include.includes("scorecard")
    ? await monthStartCapital(page.map((r) => String(r.handle)))
    : new Map<string, Map<string, number>>();

  const extras = include.length ? await Promise.all(page.map(attach)) : [];

  return {
    board: "traders",
    window: window_label ?? null,
    /**
     * ISO-8601, not the epoch integer this used to be.
     *
     * Every other moment this service publishes is an ISO string with an explicit Z, and
     * `/v1/fields` says so in as many words: "*At / *From / *To / *Since: ISO-8601 with an
     * explicit Z. Never epoch seconds." This one field contradicted that, on the most-called
     * route, for a field the consumer's contract marks load-bearing -- "a board with no
     * captured moment is refused outright".
     *
     * `capturedAtEpoch` carries the old integer so nothing that already parses it breaks. It
     * is the shape that changed, not the meaning, and a consumer gets a version ahead.
     */
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
      /**
       * WHERE THIS TRADER CAME FROM.
       *
       * The two sources fail in opposite directions and always have: entry prices are thin on
       * the fomo side and rich on the GMGN side, resolved trades exist on the fomo side and
       * barely at all on the GMGN side. A profile built to one contract therefore looks rich
       * on some traders and threadbare on others, and until now nothing in the answer
       * explained why -- the only tell was that `rank` and `followers` came back null, which
       * is an inference, not a field.
       */
      source: r.source ?? null,
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
             where address_key = any(${[t.evm_address, t.sol_address]
               .filter((a): a is string => !!a).map((a) => a.toLowerCase())})) as transfers`;

  return {
    // Stable across a fomo rename; `handle` is not guaranteed to be.
    id: t.id,
    handle: t.display_handle,
    name: t.name ?? null,
    rank: t.rank ?? null,
    verified: !!t.verified,
    /**
     * IS THIS TRADER STILL ON THE BOARD, and if not, why.
     *
     * `listed: false` means the source stopped carrying them, so the directory no longer shows
     * them — but this route still answers, because a link that used to work should not start
     * 404ing over a condition upstream of us. Nothing is deleted: their holdings, trades and
     * history are intact and the flag reverses if the source lists them again.
     */
    listed: t.listed !== false,
    ...(t.listed === false
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

/**
 * WHAT A TRADER PAID FOR WHAT HE STILL HOLDS.
 *
 * `/positions` gave quantity, price and value with no acquisition cost, so "up 3x on this
 * coin" could not be said at all. Every open position we store carries an entry price and an
 * amount, and that is a cost basis.
 *
 * Two rules shape this:
 *
 *   A holding with no stored position gets `null`, never `0`. Coins arrive by transfer as
 *   well as by purchase, and a transfer in is not a free acquisition -- reading it as one
 *   would turn every airdrop into infinite profit. `costReason` names which case it is.
 *
 *   `unrealizedUsd` is measured against the quantity whose cost we know, not against the
 *   whole holding. Those differ whenever some positions carry an entry price and others do
 *   not, and multiplying a partial cost by a full quantity invents a number.
 *
 * Keyed by handle then "networkId:tokenKey". One query for the batch: 0.6 ms for a trader
 * through trades_handle_idx.
 */
type CostBasis = {
  costKnownAmount: number | null; costUsd: number | null; avgCostPrice: number | null;
  realizedUsd: number | null; openPositions: number; openPriced: number;
};

async function costBasisFor(handles: string[]): Promise<Map<string, Map<string, CostBasis>>> {
  const out = new Map<string, Map<string, CostBasis>>();
  if (!handles.length) return out;
  const rows = await sql`
    select handle, network_id, token_key,
           sum(amount) filter (
             where status = 'open' and avg_entry_price is not null and amount > 0) as cost_qty,
           sum(avg_entry_price * amount) filter (
             where status = 'open' and avg_entry_price is not null and amount > 0) as cost_usd,
           count(*) filter (where status = 'open')::int as open_positions,
           count(*) filter (
             where status = 'open' and avg_entry_price is not null and amount > 0)::int
             as open_priced,
           sum(realized_pnl_usd) filter (where status = 'closed') as realized_usd
    from trades
    where handle = any(${handles})
    group by handle, network_id, token_key`;
  for (const r of rows) {
    const h = String(r.handle);
    let m = out.get(h); if (!m) out.set(h, m = new Map());
    const qty = n(r.cost_qty), usd = n(r.cost_usd);
    m.set(`${Number(r.network_id)}:${r.token_key}`, {
      costKnownAmount: qty,
      costUsd: usd === null ? null : round(usd),
      avgCostPrice: qty !== null && qty > 0 && usd !== null
        ? Number((usd / qty).toPrecision(12)) : null,
      realizedUsd: n(r.realized_usd) === null ? null : round(n(r.realized_usd)),
      openPositions: Number(r.open_positions),
      openPriced: Number(r.open_priced),
    });
  }
  return out;
}

/** The A12 block for one holding, shared by the single and batch routes. */
function costBlock(cb: CostBasis | undefined, amount: number | null, priceUsd: number | null) {
  if (!cb || cb.openPositions === 0) {
    return {
      costKnownAmount: null, avgCostPrice: null, costUsd: null,
      realizedUsd: cb?.realizedUsd ?? null, unrealizedUsd: null,
      costMethod: null, costSource: null,
      costCoverage: cov(0, 0),
      costReason: "no stored position for this holding — it may have arrived as a transfer, " +
                  "and a transfer in is not a purchase at zero",
    };
  }
  const known = cb.costKnownAmount;
  const unrealized = known !== null && known > 0 && cb.avgCostPrice !== null && priceUsd !== null
    ? round((priceUsd - cb.avgCostPrice) * known) : null;
  return {
    costKnownAmount: known,
    avgCostPrice: cb.avgCostPrice,
    costUsd: cb.costUsd,
    /** Realised on this coin's CLOSED positions — a different quantity, and said so here. */
    realizedUsd: cb.realizedUsd,
    /** Against `costKnownAmount` only, never against the whole holding. */
    unrealizedUsd: unrealized,
    costMethod: cb.openPriced === 0 ? null
      : (cb.openPriced === cb.openPositions ? "weighted_open_positions"
                                            : "weighted_open_positions_partial"),
    costSource: cb.openPriced === 0 ? null : "stored trades: avg_entry_price x amount",
    costCoverage: cov(cb.openPriced, cb.openPositions),
    costReason: cb.openPriced > 0 ? null
      : "this coin's open positions carry no entry price, so what was paid is unknown",
    /** The share of the holding the cost covers, so a partial basis is never read as whole. */
    costAmountShare: known !== null && amount !== null && amount > 0
      ? Number(Math.min(1, known / amount).toFixed(4)) : null,
  };
}

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

  const [timing, costBy] = await Promise.all([
    addrs.length ? positionTiming(addrs) : Promise.resolve([]),
    costBasisFor([t.handle as string]),
  ]);
  const costs = costBy.get(t.handle as string) ?? new Map<string, CostBasis>();

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
       * WHAT HE PAID FOR THIS, and the profit measured against it.
       *
       * `costUsd` is null rather than 0 when nothing we store says he bought it: coins arrive
       * by transfer too, and reading a transfer in as a free acquisition turns every airdrop
       * into infinite profit. `costReason` names which case a null is.
       */
      ...costBlock(costs.get(`${Number(r.network_id)}:${r.token_key}`),
                   n(r.human_amount), n(r.price)),
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
/** SUPERSEDED by swapsFor() + chainEntriesFrom(). Kept only for reference; no caller. */
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
/** SUPERSEDED by swapsFor() + chainExitsFrom(). Kept only for reference; no caller. */
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
 * Dollars for a FEE, which is often a fraction of a cent.
 *
 * `round()` keeps two decimals, and a Solana fee of 0.0000292 SOL is $0.003 -- which came
 * back as `0`. Zero states that the trade cost nothing to make, and no trade on any chain
 * does. Six decimals keep the smallest fee we have measured visible while a large one still
 * prints as money: 0.003 and 676.9, not 0 and 676.9.
 */
const feeUsd = (v: number | null): number | null =>
  v === null || !Number.isFinite(v) ? null : Number(v.toFixed(6));

/**
 * Fees a trader paid, per window, in dollars.
 *
 * Read from `trader_fees_daily`, which is built off the request path: summing this from
 * `transactions` at request time measured 24.5 seconds for our busiest trader, because that
 * table holds one row per transfer leg and the honest sum has to take DISTINCT transactions
 * out of it. Against the daily buckets the same answer takes 0.78 ms.
 *
 * Dollars are computed here rather than stored, from the same native price the portfolio
 * uses, so a fee and a balance can never be converted at two different rates.
 *
 * THE CONVERSION IS AN APPROXIMATION AND THE RESPONSE SAYS SO. We hold no historical native
 * price, so a fee paid in July is valued at today's rate. The native figure beside it is
 * exact and is the one to trust.
 */
type FeeWindows = {
  usd: Record<string, number | null>;
  native: { symbol: string; amount: number; chains: number }[];
  txCount: number;
  chainsPriced: number;
  chainsTotal: number;
};

async function feesFor(
  handles: string[], natives: Map<number, NativePrice>,
): Promise<Map<string, FeeWindows>> {
  const out = new Map<string, FeeWindows>();
  if (!handles.length) return out;
  const rows = await sql`
    select handle, network_id,
           sum(fee_native) filter (where day > (now() at time zone 'utc')::date - 1)  as w24h,
           sum(fee_native) filter (where day > (now() at time zone 'utc')::date - 7)  as w7d,
           sum(fee_native) filter (where day > (now() at time zone 'utc')::date - 30) as w30d,
           sum(fee_native)  as wall,
           sum(tx_count)::int as txs
    from trader_fees_daily
    where handle = any(${handles})
    group by handle, network_id`;

  for (const r of rows) {
    const h = String(r.handle);
    let f = out.get(h);
    if (!f) {
      out.set(h, f = {
        usd: { "24h": null, "7d": null, "30d": null, all: null },
        native: [], txCount: 0, chainsPriced: 0, chainsTotal: 0,
      });
    }
    const nat = natives.get(Number(r.network_id)) ?? null;
    f.txCount += Number(r.txs ?? 0);
    f.chainsTotal++;
    /*
     * Summed by SYMBOL, not by chain. ETH is the native coin of three of our five chains, so
     * a per-chain list showed "ETH" three times and left the reader to add them up -- and to
     * wonder whether the three were the same asset. They are.
     */
    const all = n(r.wall);
    if (all !== null && nat) {
      const hit = f.native.find((x) => x.symbol === nat.symbol);
      if (hit) { hit.amount += all; hit.chains++; }
      else f.native.push({ symbol: nat.symbol, amount: all, chains: 1 });
    }
    /*
     * A chain whose native coin we cannot price contributes NOTHING to the dollar total and
     * is counted in `chainsTotal` but not in `chainsPriced`. Adding zero for it would state
     * that trading there was free.
     */
    if (!nat?.usd) continue;
    f.chainsPriced++;
    for (const [key, col] of [["24h", "w24h"], ["7d", "w7d"], ["30d", "w30d"], ["all", "wall"]] as const) {
      const v = n(r[col]);
      if (v === null) continue;
      f.usd[key] = feeUsd((f.usd[key] ?? 0) + v * nat.usd);
    }
  }
  return out;
}

/**
 * INDIVIDUAL BUYS, so a question about buys can be counted in buys.
 *
 * The scorecard's `avgEntryPrice` is an average fomoapi hands us already averaged across the
 * fills inside a position, and an average cannot be un-averaged: five buys at five prices
 * arrive as one number. "95% of his buys were under $100K" counts buys, so it needs them
 * individually, and the only place they exist is `wallet_swaps` -- Solana from the start, and
 * the four EVM chains since the receipts were read.
 *
 * Keyed by handle then "networkId:tokenKey", so a per-coin row can carry its own buys and the
 * batch path pays one query for the page.
 */
type Buy = {
  at: string | null; txHash: string; amount: number;
  costUsd: number | null; priceUsd: number | null;
};

/** SUPERSEDED by swapsFor() + buysFrom(). Kept only for reference; no caller. */
async function buysFor(handles: string[]): Promise<Map<string, Map<string, Buy[]>>> {
  const out = new Map<string, Map<string, Buy[]>>();
  if (!handles.length) return out;
  const rows = await sql`
    select t.handle, ws.network_id, ws.token_key, ws.tx_hash, ws.block_time,
           ws.token_delta, ws.quote_usd
    from traders t
    join wallets w using (handle)
    join wallet_swaps ws
      on ws.address_key = w.evm_address_key or ws.address_key = lower(w.sol_address)
    where t.handle = any(${handles}) and ws.token_delta > 0
    order by t.handle, ws.block_time asc`;

  for (const r of rows) {
    const h = String(r.handle);
    let m = out.get(h); if (!m) out.set(h, m = new Map());
    const k = `${Number(r.network_id)}:${r.token_key}`;
    let a = m.get(k); if (!a) m.set(k, a = []);
    const amount = n(r.token_delta) ?? 0;
    const cost = n(r.quote_usd);
    a.push({
      at: r.block_time ? new Date(String(r.block_time)).toISOString() : null,
      txHash: String(r.tx_hash),
      amount,
      costUsd: cost === null ? null : round(Math.abs(cost)),
      /*
       * What this buy paid per token -- the figure a size band is drawn from. Null, never 0,
       * when the money leg carried no dollar value.
       */
      priceUsd: cost !== null && amount > 0
        ? Number((Math.abs(cost) / amount).toPrecision(12)) : null,
    });
  }
  return out;
}

/**
 * EVERY RESOLVED SWAP FOR THESE TRADERS, IN ONE QUERY.
 *
 * Three separate queries used to scan `wallet_swaps` over the same join for the same trader:
 * the chain entry price, the chain exit P&L, and the individual buys. Each one measures about
 * 160 ms, which sounds harmless -- but each also holds its own connection, and a pool exhausts
 * on connections held, not on milliseconds burned. That is what took the service down under a
 * 448-trader sweep.
 *
 * So the rows are fetched once and the three answers are derived from them in memory. Same
 * numbers, one third of the connections.
 */
type Swap = {
  handle: string; net: number; tokenKey: string; txHash: string;
  at: string | null; tokenDelta: number; quoteUsd: number | null;
};

async function swapsFor(handles: string[]): Promise<Map<string, Swap[]>> {
  const out = new Map<string, Swap[]>();
  if (!handles.length) return out;
  const rows = await sql`
    select w.handle, ws.network_id, ws.token_key, ws.tx_hash, ws.block_time,
           ws.token_delta, ws.quote_usd
    from wallet_swaps ws
    join wallets w
      on lower(w.sol_address) = ws.address_key or w.evm_address_key = ws.address_key
    where w.handle = any(${handles})
    order by w.handle, ws.block_time asc`;
  for (const r of rows) {
    const h = String(r.handle);
    let a = out.get(h); if (!a) out.set(h, a = []);
    a.push({
      handle: h, net: Number(r.network_id), tokenKey: String(r.token_key),
      txHash: String(r.tx_hash),
      at: r.block_time ? new Date(String(r.block_time)).toISOString() : null,
      tokenDelta: n(r.token_delta) ?? 0, quoteUsd: n(r.quote_usd),
    });
  }
  return out;
}

/** The quantity-weighted entry price per "net:token", from the buys in one swap list. */
function chainEntriesFrom(swaps: Swap[]): Map<string, number> {
  const acc = new Map<string, { usd: number; qty: number }>();
  for (const s of swaps) {
    if (s.tokenDelta <= 0 || s.quoteUsd === null) continue;
    const k = `${s.net}:${s.tokenKey}`;
    const a = acc.get(k) ?? { usd: 0, qty: 0 };
    a.usd += Math.abs(s.quoteUsd); a.qty += s.tokenDelta;
    acc.set(k, a);
  }
  const out = new Map<string, number>();
  for (const [k, a] of acc) if (a.qty > 0) out.set(k, a.usd / a.qty);
  return out;
}

/** Realised P&L per closing swap, valued against that token's entry price. */
function chainExitsFrom(swaps: Swap[], entries: Map<string, number>): number[] {
  const out: number[] = [];
  for (const s of swaps) {
    if (s.tokenDelta >= 0 || s.quoteUsd === null) continue;
    const px = entries.get(`${s.net}:${s.tokenKey}`);
    if (px === undefined) continue;
    out.push(s.quoteUsd + s.tokenDelta * px);
  }
  return out;
}

/** The individual buys, grouped by "net:token", from the same rows. */
function buysFrom(swaps: Swap[]): Map<string, Buy[]> {
  const out = new Map<string, Buy[]>();
  for (const s of swaps) {
    if (s.tokenDelta <= 0) continue;
    const k = `${s.net}:${s.tokenKey}`;
    let a = out.get(k); if (!a) out.set(k, a = []);
    const cost = s.quoteUsd === null ? null : Math.abs(s.quoteUsd);
    a.push({
      at: s.at, txHash: s.txHash, amount: s.tokenDelta,
      costUsd: cost === null ? null : round(cost),
      priceUsd: cost !== null && s.tokenDelta > 0
        ? Number((cost / s.tokenDelta).toPrecision(12)) : null,
    });
  }
  return out;
}

/**
 * Everything the scorecard computes, over rows already fetched.
 *
 * Split out for ISSUE-8 so `/traders?include=scorecard` runs THIS function rather than a
 * second implementation of it. A bulk route that re-derives its own summary drifts from the
 * single-trader route the first time either is edited; sharing the code path makes the two
 * identical by construction rather than by test.
 */
// deno-lint-ignore no-explicit-any
/**
 * THE BALANCE A TRADER STARTED EACH MONTH WITH — the denominator a monthly return needs.
 *
 * Every month has arrived in dollars with `startCapitalUsd` empty, and the consumer's fourth
 * verdict test is written as a percentage: did he survive a bad month, losing less than a
 * fifth. With no starting balance there is no denominator, so that test was unanswerable for
 * every trader in the directory and the top verdict was unreachable for all of them.
 *
 * It is answerable now because the sampler runs. `aum_samples` holds a priced reading per
 * trader per hour, so the balance entering a month is simply the first one the month has.
 *
 * ONLY WHEN THE READING IS ACTUALLY NEAR THE START. A reading taken on the 20th is not what
 * he began the month with, and dividing by it would produce a percentage that looks measured
 * and is not. Seven days is the bound; past that the month keeps a null and says why, which
 * is the same discipline every other figure here follows.
 */
const START_CAPITAL_WINDOW_DAYS = 7;

async function monthStartCapital(handles: string[]): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (!handles.length) return out;
  const rows = await sql`
    select distinct on (handle, month)
           handle,
           to_char(date_trunc('month', at at time zone 'utc'), 'YYYY-MM') as month,
           total_usd,
           extract(day from (at at time zone 'utc'))::int as day_of_month
    from aum_samples
    where handle = any(${handles}) and total_usd is not null
    order by handle, month, at asc`;
  for (const r of rows) {
    if (Number(r.day_of_month) > START_CAPITAL_WINDOW_DAYS) continue;
    const h = String(r.handle);
    let m = out.get(h); if (!m) out.set(h, m = new Map());
    m.set(String(r.month), Number(r.total_usd));
  }
  return out;
}

async function scorecardBody(
  t: any, rows: any[], tokenLimit: number | null,
  chain?: { entries: Map<string, number>; exits: number[] },
  feeWindows?: FeeWindows | null,
  buys?: Map<string, Buy[]> | null,
  /** month (YYYY-MM) -> the balance he entered it with. See monthStartCapital(). */
  startCapital?: Map<string, number> | null,
) {
  const chainEntry = chain?.entries ?? new Map<string, number>();
  const chainExits = chain?.exits ?? [];
  const fw = feeWindows ?? null;

  /*
   * WHEN THIS TRADER'S RECORD WAS LAST LOADED — the NEWEST row, not the first one.
   *
   * `rows[0].captured_at` is whatever row the query happened to return first, and a trader
   * whose record is refreshed keeps his older rows: unipcs spans 4 September to 15 September,
   * so the scorecard reported a load stamp ten days old on a record refreshed that morning.
   * That is the exact shape of the staleness complaint this field exists to answer, produced
   * by the field itself. `asOf` next to it was already taking the maximum and disagreeing.
   */
  const loadedAtIso = (() => {
    const times = rows
      .map((r) => (r.captured_at ? Date.parse(String(r.captured_at)) : null))
      .filter((x): x is number => x !== null && Number.isFinite(x));
    return times.length ? new Date(Math.max(...times)).toISOString() : null;
  })();

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
    return { value, method, legs: a.legs, legsWeighted: a.weighted, first: a.first,
             sum: a.sum, weight: a.weight };
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
      /**
       * DOLLARS IN AND DOLLARS OUT on this coin, which is what "how much a bet" and the
       * profit bands are actually asking for. An average price cannot answer it: two traders
       * with the same average entry can have staked a hundred dollars or a hundred thousand.
       *
       * Both are the quantity-weighted sums that already produced the averages above -- the
       * price of each position times the quantity recovered for it -- so they reconcile with
       * `avgEntryPrice` exactly, and are not a second estimate of the same thing.
       *
       * Null, never 0, when no position in this coin carried a recoverable quantity. A coin
       * whose cost we cannot establish must not appear to have been free.
       */
      costUsd: e.legsWeighted > 0 ? round(e.sum) : null,
      proceedsUsd: x.legsWeighted > 0 ? round(x.sum) : null,
      /** The quantity each sum was taken over, so the division can be rechecked. */
      costQuantity: e.legsWeighted > 0 ? e.weight : null,
      proceedsQuantity: x.legsWeighted > 0 ? x.weight : null,
      /** How many of this coin's positions contributed dollars, against how many had a price. */
      costCoverage: cov(e.legsWeighted, e.legs),
      proceedsCoverage: cov(x.legsWeighted, x.legs),
      whyNoCostUsd: e.legsWeighted > 0 ? null
        : (e.legs === 0
          ? "no position in this coin carries an entry price"
          : "entry prices are present but no position has a recoverable quantity"),
      whyNoProceedsUsd: x.legsWeighted > 0 ? null
        : (x.legs === 0
          ? "nothing in this coin has been sold, or no sale carries an exit price"
          : "exit prices are present but no position has a recoverable quantity"),
      /**
       * A REASON BESIDE EVERY NULL ON THIS ROW, from a fixed vocabulary.
       *
       * A null says a figure is absent and nothing about why, and the four causes want
       * different responses from a screen: `not_applicable` should not be shown at all,
       * `not_yet_calculated` is worth returning for, `source_unavailable` and
       * `historical_input_missing` are permanent for this coin and should be labelled.
       *
       * Only keys that ARE null appear, so a fully populated row carries an empty object
       * rather than a wall of nulls-about-nulls. This explains existing fields; it does not
       * replace any null with a zero.
       */
      /**
       * THE BUYS THEMSELVES, where we hold them.
       *
       * `avgEntryPrice` above is one number for the coin; these are the fills it averages.
       * A question about buys -- "95% of buys under $100K", the size bands, "how much a bet"
       * -- has to count buys, and an average cannot be taken apart into them.
       *
       * `marketCapUsd` is that buy's price times the supply we hold, so a buy can be placed
       * in a size band. It is null wherever either input is, never 0.
       *
       * Capped at 100 per coin with `buysTotal` stating the real count, so one heavily traded
       * coin cannot dominate a response. Absent chains contribute nothing: `buysTotal` of 0
       * means we hold no individual buys for this coin, NOT that none were made -- read
       * `buysCoverage` on the answer before counting anything.
       */
      buys: (() => {
        const list = buys?.get(chainKey) ?? [];
        return list.slice(0, 100).map((b) => ({
          at: b.at, txHash: b.txHash, amount: b.amount,
          costUsd: b.costUsd, priceUsd: b.priceUsd,
          marketCapUsd: b.priceUsd !== null && r.totalSupply !== null && r.totalSupply > 0
            ? Number((b.priceUsd * r.totalSupply).toPrecision(10)) : null,
        }));
      })(),
      buysTotal: (buys?.get(chainKey) ?? []).length,
      fieldReasons: (() => {
        const why: Record<string, string> = {};
        if (entryPx === null) why.avgEntryPrice = "historical_input_missing";
        if (e.legsWeighted === 0) why.costUsd = "historical_input_missing";
        if (x.value === null) {
          // Nothing sold is a different statement from sold-but-unpriced.
          why.avgExitPrice = r.closed === 0 ? "not_applicable" : "historical_input_missing";
        }
        if (x.legsWeighted === 0) {
          why.proceedsUsd = r.closed === 0 ? "not_applicable" : "historical_input_missing";
        }
        if (r.totalSupply === null) why.totalSupply = "source_unavailable";
        if (entryPx === null || r.totalSupply === null || !(r.totalSupply > 0)) {
          why.avgEntryMarketCapUsd = entryPx === null
            ? "historical_input_missing" : "source_unavailable";
        }
        if (x.value === null || r.totalSupply === null || !(r.totalSupply > 0)) {
          why.avgExitMarketCapUsd = x.value === null
            ? (r.closed === 0 ? "not_applicable" : "historical_input_missing")
            : "source_unavailable";
        }
        if (tokenCreatedUnix === null) why.tokenCreatedAt = "source_unavailable";
        if (tokenCreatedUnix === null || firstOpenedMs === null) {
          why.tokenAgeAtEntryDays = tokenCreatedUnix === null
            ? "source_unavailable" : "historical_input_missing";
        }
        /*
         * No individual buys for this coin. `source_unavailable` rather than
         * `historical_input_missing`: the fills happened, and the reason we cannot show them
         * is that no resolver reaches this coin's chain, not that a value went unrecorded.
         */
        if ((buys?.get(chainKey) ?? []).length === 0) why.buys = "source_unavailable";
        if (firstClosedMs === null) why.firstClosedAt = "not_applicable";
        if (lastClosedMs === null) why.lastClosedAt = "not_applicable";
        return why;
      })(),
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
  const windowAgg = (sinceMs: number | null, windowKey: string) => {
    const inWindow = sinceMs === null
      ? closedDated
      : closedDated.filter((r) => Date.parse(String(r.closed_at)) > sinceMs);
    // `sum()` skips NULLs and `coalesce(..., 0)` makes an empty window zero — matched here,
    // because a window with no closed trades earned nothing, which is a real 0 and not a
    // missing value.
    const total = inWindow.reduce((acc, r) => acc + (n(r.realized_pnl_usd) ?? 0), 0);

    /*
     * VOLUME THIS WINDOW, MEASURED RATHER THAN REPORTED.
     *
     * The leaderboard gives one lifetime volume per trader and nothing to slice it by, so
     * "volume in the last 7 days" had no answer at all. Every closed position here carries
     * an entry price, an exit price and a recoverable quantity, and dollars in plus dollars
     * out is what volume means -- both legs, because a round trip trades twice.
     *
     * Counted only over the positions that carry all three, with `coverage` saying how many
     * that was. A volume summed over half a window and presented as the whole is the same
     * failure as a partial balance total.
     */
    let volume = 0, volumed = 0;
    for (const r of inWindow) {
      const q = legQty(r), e = n(r.avg_entry_price), x = n(r.avg_exit_price);
      if (q === null || e === null || x === null) continue;
      volume += q * e + q * x;
      volumed++;
    }
    return {
      realizedUsd: round(total),
      closedTrades: inWindow.length,
      /** Both legs of each round trip. Null, never 0, when no position carried the inputs. */
      volumeUsd: volumed > 0 ? round(volume) : null,
      volumeCoverage: cov(volumed, inWindow.length),
      whyNoVolume: volumed > 0 ? null
        : (inWindow.length === 0
          ? "no position closed in this window"
          : "no closed position in this window carries an entry price, an exit price and a " +
            "recoverable quantity"),
      /**
       * Fees are NOT deducted from `realizedUsd`, and nothing here can deduct them: no fee
       * or gas figure is stored on any trade or transfer we hold. See `fees` on the response.
       *
       * `feesUsd` is null rather than 0 and always will be until fees are stored: zero would
       * claim this window cost nothing to trade, which is certainly false.
       */
      includesFees: false,
      /**
       * What this window cost to trade. Null, never 0, when we hold no fee for it -- a window
       * with trades in it was never free. `fees` on the response carries the caveat: the
       * dollar figure applies today's native price to a payment made in the past, because no
       * historical native price is stored. The native figure there is the exact one.
       */
      feesUsd: fw ? (fw.usd[windowKey] ?? null) : null,
      feesCoverage: fw ? cov(fw.chainsPriced, fw.chainsTotal) : cov(0, 0),
    };
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

  /*
   * THE SAME GROUPING, BY CALENDAR MONTH, for "worst month" and the bad-days test.
   *
   * A balance drawdown does not answer this: money moving in or out of a wallet is not a
   * trading loss, and the two are indistinguishable on a balance line. Realised profit summed
   * by close date is, and the close dates have been on every row all along.
   *
   * Thirteen buckets: the twelve completed calendar months plus the one in progress, which
   * carries `complete: false` so a partial month is never read as a bad one.
   *
   * `coverage` is the closed trades in the month that carry a realised figure against all of
   * them, because a month whose trades mostly lack a P&L is a thin month, not a flat one.
   *
   * A month with no closed trade is ABSENT rather than zero, the same rule `realizedByDay`
   * follows: a month he closed nothing is not a month he earned nothing.
   */
  const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7);
  const nowMonth = monthKey(nowMs);
  const firstMonthDate = new Date(nowMs);
  firstMonthDate.setUTCDate(1);
  firstMonthDate.setUTCHours(0, 0, 0, 0);
  firstMonthDate.setUTCMonth(firstMonthDate.getUTCMonth() - 12);
  const since12m = firstMonthDate.getTime();

  const monthBuckets = new Map<string,
    { realizedUsd: number; closedTrades: number; withFigure: number }>();
  for (const r of closedDated) {
    const ms = Date.parse(String(r.closed_at));
    if (!Number.isFinite(ms) || ms < since12m) continue;
    const m = monthKey(ms);
    const b = monthBuckets.get(m) ?? { realizedUsd: 0, closedTrades: 0, withFigure: 0 };
    const pnl = n(r.realized_pnl_usd);
    if (pnl !== null) { b.realizedUsd += pnl; b.withFigure++; }
    b.closedTrades++;
    monthBuckets.set(m, b);
  }
  const realizedByMonth = [...monthBuckets.entries()]
    .sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([month, v]) => ({
      month,
      realizedUsd: v.withFigure === 0 ? null : round(v.realizedUsd),
      closedTrades: v.closedTrades,
      coverage: cov(v.withFigure, v.closedTrades),
      /** False for the month still running, so a part-month is not compared with whole ones. */
      complete: month !== nowMonth,
      /**
       * What a return percentage would need. The balance history reaches thirty days back, so
       * eleven of these twelve months have no capital figure to divide by -- and a percentage
       * computed against a balance we did not measure would be a guess wearing a number.
       * Read `realizedUsd` against `/aum` for the months the history covers.
       */
      startingCapitalUsd: round(startCapital?.get(month) ?? null),
      /** The contract's spelling of the same field. One value, two names, never two answers. */
      startCapitalUsd: round(startCapital?.get(month) ?? null),
      /**
       * The month's realised profit as a share of what he began it with.
       *
       * This is the figure the consumer's fourth verdict test reads -- "worst month lost less
       * than a fifth" -- and it has been null for every trader because the denominator was.
       * Null still, wherever the balance is: a percentage against a capital figure we did not
       * measure would be a guess wearing a number.
       */
      returnPct: (() => {
        const cap = startCapital?.get(month) ?? null;
        if (cap === null || !(cap > 0) || v.withFigure === 0) return null;
        return Number(((v.realizedUsd / cap) * 100).toFixed(2));
      })(),
    }));

  /*
   * WHY THESE MONTHS DO NOT SUM TO THE LIFETIME FIGURE.
   *
   * A trader with a longer record has closes before this window -- one measured 20 closes
   * worth $5,005.73 sitting before the twelve months, so his months summed to $59,422.09
   * against an `all` of $64,427.81. Both numbers are right and the difference is not an
   * error, but a consumer adding up a calendar and comparing it with the headline has no way
   * to know that unless we say it. So the difference is stated rather than left to be
   * discovered.
   */
  const monthsRealized = realizedByMonth
    .reduce((a, m) => a + (m.realizedUsd ?? 0), 0);
  const lifetimeRealized = closedDated
    .reduce((a, r) => a + (n(r.realized_pnl_usd) ?? 0), 0);

  const windows = {
    basis: "realized profit only — closed trades, summed by closed_at. Unrealised movement " +
           "is not included; see /pnl for banked versus on paper. Gross of fees: see `fees`.",
    "24h": windowAgg(nowMs - 86_400_000, "24h"),
    "7d":  windowAgg(nowMs - 7 * 86_400_000, "7d"),
    "30d": windowAgg(nowMs - 30 * 86_400_000, "30d"),
    all:   windowAgg(null, "all"),
  };

  return {
    handle: t.display_handle, name: t.name ?? null,
    /**
     * WHERE THESE ROWS CAME FROM — and it is not the same answer for every trader.
     *
     * This said "loaded from fomoapi" for everyone, including the 291 traders whose trades
     * are built from GMGN's activity feed. A consumer reading it to decide how far to trust a
     * figure was being told the wrong provider for two thirds of the directory, and the two
     * behave differently: entry prices are thin on one side and rich on the other.
     */
    source: t.source === "gmgn"
      ? "postgres · trades (folded from GMGN wallet activity)"
      : "postgres · trades (loaded from fomoapi)",
    /** The directory this trader came from, the same value `GET /v1/traders` reports. */
    traderSource: t.source ?? null,
    /**
     * Realised profit per day for the last thirty days, same basis as `realized` below.
     * A day with no closed trade is absent, not zero.
     */
    realizedByDay,
    /**
     * Realised profit per calendar month for the last twelve completed months plus the one in
     * progress. Same basis as `realizedByDay` and as `realized` below: closed trades summed by
     * `closed_at`, unrealised movement excluded. A month with no closed trade is absent.
     */
    realizedByMonth,
    /** What the months above cover, and what they leave out. */
    realizedByMonthBasis: {
      months: realizedByMonth.length,
      from: realizedByMonth[0]?.month ?? null,
      to: realizedByMonth[realizedByMonth.length - 1]?.month ?? null,
      realizedUsd: round(monthsRealized),
      /** Realised profit on closes OLDER than this window; 0 when the record fits inside it. */
      beforeWindowUsd: round(lifetimeRealized - monthsRealized),
      note: "the last twelve completed calendar months plus the one running. A record that " +
            "starts earlier has closes before this window, so these months do not sum to " +
            "windows.all.realizedUsd — `beforeWindowUsd` is exactly that difference.",
    },
    // max(captured_at) over the same rows — identical to the query this replaces, and free.
    asOf: (() => {
      const times = rows.map((r) => (r.captured_at ? Date.parse(String(r.captured_at)) : null))
        .filter((x): x is number => x !== null && Number.isFinite(x));
      return times.length ? new Date(Math.max(...times)).toISOString() : null;
    })(),
    /**
     * WHAT THIS SCORECARD WAS COMPUTED OVER, and whether that is the whole record.
     *
     * It used to say `sample`, with a count and a load date, and a consumer could not tell
     * whether 363 was a trader's whole history or a slice of it. `complete` answers exactly
     * that one question and no more: every position stored for this trader was used, with no
     * cap and no sampling. Whether the STORE is behind the chain is a different question, and
     * `storedAt` with `nextLoadAt` is what answers it -- as does the `trades` feed on
     * /health, which states its own age and allowance.
     *
     * `unit` matters more than it looks. We hold POSITIONS, already averaged across the fills
     * inside them; the leaderboard counts FILLS. 363 against 4,745 is not a coverage gap, it
     * is two different things counted, and `reportedTrades` is carried so the difference is
     * visible instead of alarming.
     */
    sample: {
      returned: rows.length,
      storedAt: loadedAtIso,
      complete: true,
      capped: false,
      unit: "position",
      positionsStored: rows.length,
      reportedTrades: n(t.trade_count),
      reportedTradesSource: "leaderboard, lifetime, counted as fills",
      /**
       * When the trade load behind these rows ran, and when it is next due. This is the
       * scorecard's half of the freshness contract -- the same question `sampler` answers for
       * the balance series, on the store that actually feeds this route.
       */
      loadedAt: loadedAtIso,
      nextLoadAt: (() => {
        const d = new Date();
        d.setUTCHours(6, 0, 0, 0);
        if (d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString();
      })(),
      note: "no cap is applied: every position stored for this trader is used. `returned` " +
            "counts positions, `reportedTrades` counts fills, and they are not comparable.",
    },
    /*
     * THE SAME FIVE FACTS AT THE LEVEL THE CONTRACT NAMES THEM.
     *
     * Section 7.5 asks for `complete`, `tradesKnown`, `tradesUsed`, `loadedAt` and
     * `nextLoadAt` on the scorecard itself. They are computed once above and read from the
     * same place here, so the two spellings cannot drift apart.
     */
    complete: true,
    tradesKnown: rows.length,
    tradesUsed: rows.length,
    loadedAt: loadedAtIso,
    nextLoadAt: (() => {
      const d = new Date();
      d.setUTCHours(6, 0, 0, 0);
      if (d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString();
    })(),
    /**
     * A VERDICT ON THIS RECORD'S AGE, not just the date it was loaded.
     *
     * `loadedAt` and `nextLoadAt` were both already here and a consumer could in principle
     * subtract one from the clock. Nobody did. Measured across the directory: the oldest
     * scorecard was 208 hours old and sixteen were past 72, every one of them served without
     * qualification beside a live balance -- which reads as one moment's truth and is not.
     *
     * The allowance matches the one /health judges scorecards by, so the two cannot disagree
     * about which traders are stale. `never` is not `stale`: a record that has never loaded
     * has a different cause and a different fix.
     */
    staleness: (() => {
      const t = loadedAtIso ? Date.parse(loadedAtIso) : NaN;
      const ageSeconds = Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
      const staleAfterHours = 72;
      return {
        state: ageSeconds === null
          ? "never"
          : (ageSeconds > staleAfterHours * 3600 ? "stale" : "current"),
        ageSeconds,
        staleAfterHours,
      };
    })(),
    /**
     * FEES, ANSWERED HONESTLY RATHER THAN ASSUMED EITHER WAY.
     *
     * The profile's headline says "made, after fees". Nothing here is after fees, and saying
     * so is the only correct answer available: no fee or gas column exists on any trade or
     * transfer we store, so a fee figure would have to be invented. `includesFees: false`
     * travels on every realised window so the claim cannot be lost.
     */
    fees: {
      /**
       * Fees are now MEASURED, and still not deducted. Both facts matter: a consumer that
       * wants "after fees" can subtract `paidUsd` itself, and one that reads `realizedUsd`
       * is not silently given a net figure where it expected a gross one.
       */
      includedInRealized: false,
      paidUsd: fw ? (fw.usd.all ?? null) : null,
      byWindowUsd: fw
        ? { "24h": fw.usd["24h"] ?? null, "7d": fw.usd["7d"] ?? null,
            "30d": fw.usd["30d"] ?? null, all: fw.usd.all ?? null }
        : null,
      /** Exact, in each chain's own coin. This is the measurement; the dollars are derived. */
      paidNative: fw
        ? fw.native.map((x) => ({
            symbol: x.symbol,
            amount: Number(x.amount.toPrecision(12)),
            /** How many chains that coin was paid on — ETH is native to three of our five. */
            chains: x.chains,
          }))
        : [],
      transactions: fw?.txCount ?? 0,
      coverage: fw ? cov(fw.chainsPriced, fw.chainsTotal) : cov(0, 0),
      source: fw
        ? "gas_used x effective_gas_price from the transaction receipt on the EVM chains, " +
          "meta.fee on Solana"
        : null,
      perTradeUsd: null,
      /**
       * WHY THE DOLLARS ARE AN APPROXIMATION AND THE COIN FIGURE IS NOT.
       *
       * A fee is paid once, in the chain's own coin, at a moment. We hold no historical price
       * for those coins, so the dollar figure applies today's rate to a past payment. The
       * native amount is exact and does not move.
       */
      usdBasis: "native fee valued at the current native price, not the price when it was paid",
      why: fw ? null : "no fee has been read for this trader's transactions yet",
      perTradeWhy: "a stored position carries no transaction hash, so a fee cannot be " +
                   "attached to one. Per-trade fees are on /trades, where a row IS a " +
                   "transaction",
    },
    /**
     * VOLUME, both the reported lifetime figure and the measured per-window one.
     *
     * They are different measurements and will not agree: the first is the leaderboard's
     * lifetime number for the trader, the second is what we can prove from the positions we
     * hold. `windows[].volumeUsd` carries the per-window figures with their own coverage.
     */
    volume: {
      reportedLifetimeUsd: n(t.volume_usd),
      reportedSource: "leaderboard, lifetime",
      measuredBasis: "entry leg plus exit leg of every closed position that carries an entry " +
                     "price, an exit price and a recoverable quantity",
      perWindow: "see windows[].volumeUsd and windows[].volumeCoverage",
    },
    winRate, wins, losses, breakeven,
    /**
     * WHAT `winRate` IS A RATE OF — named, not left to be inferred.
     *
     * The denominator is NOT `closedTrades`. It is the closed positions that carry a
     * realized figure, and for 61 traders those are different numbers: 702 closed positions
     * across the directory have a null `realized_pnl_usd`. They are counted by
     * `windows[].closedTrades` and excluded from `wins`, `losses` and from this rate.
     *
     * That gap is not small where it exists. One trader serves 0.6222 here and 0.4308 over
     * his closed trades; thirteen traders sit on opposite sides of a 30% copy floor
     * depending on which denominator is used. Both figures are defensible and only one of
     * them is on the page, so the page has to be able to say which.
     *
     * `winRateCoverage.of` is this rate's denominator; `.total` is `closedTrades`. Equal for
     * the 387 traders whose record is complete, and visibly unequal for the 61 where it is not.
     */
    winRateBasis: "closed_positions_with_realized_figure",
    winRateCoverage: cov(realized.length, closed.length),
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
     * THE SAME VOCABULARY, SUMMARISED FOR THE WHOLE ANSWER.
     *
     * `byToken[].fieldReasons` explains a null on one coin; this explains a null on a figure
     * that stands for the trader. Only keys that are actually null appear.
     *
     *   not_applicable            the question does not arise — nothing has closed yet
     *   not_yet_calculated        a job has not produced it; it may appear later
     *   source_unavailable        no source we hold carries it
     *   historical_input_missing  the inputs existed once and were not recorded
     */
    fieldReasons: (() => {
      const why: Record<string, string> = {};
      const noClosed = closed.length === 0;
      if (winRate === null) why.winRate = noClosed ? "not_applicable" : "historical_input_missing";
      if (medHold === null) {
        why.holdingTime = noClosed ? "not_applicable" : "historical_input_missing";
      }
      if (!entryRows.length) why.moneyIn = "historical_input_missing";
      if (!exitRows.length) {
        why.moneyOut = noClosed ? "not_applicable" : "historical_input_missing";
      }
      if (!(basis > 0)) {
        why.returnPct = noClosed ? "not_applicable" : "historical_input_missing";
      }
      if (bet.value === null) why.typicalBetUsd = "historical_input_missing";
      if (spanDays === null) why.trackRecordDays = "historical_input_missing";
      /*
       * THE SPREAD FIGURES, which go null for two different reasons and said neither.
       *
       * `worstTradeUsd` and `medianTradeUsd` are null when no closed position carries a
       * realized figure -- the same population `winRateBasis` names. `topTradeShare` has its
       * own cause: it is the best trade over GROSS GAINS, so a trader whose every closed trade
       * lost money has no denominator and the share is not a number. Serving 0 there would
       * read as "none of his profit came from one trade" about a man with no profit.
       *
       * Eight absences across the directory carried no reason before this. Small, and exactly
       * the class of hole the six axes are drawn from.
       */
      if (worst === null) {
        why.worstTradeUsd = noClosed ? "not_applicable" : "no_realized_figure";
      }
      if (medTrade === null) {
        why.medianTradeUsd = noClosed ? "not_applicable" : "no_realized_figure";
      }
      if (topTradeShare === null) {
        why.topTradeShare = noClosed
          ? "not_applicable"
          : (realized.length === 0 ? "no_realized_figure" : "no_winning_trade");
      }
      if (best === null) {
        why.bestTradeUsd = noClosed ? "not_applicable" : "no_realized_figure";
      }
      if (meanToMedian === null && realized.length > 0) {
        why.meanToMedian = "sign_discipline_not_both_positive";
      }
      /* Only when no fee has been read for this trader yet -- it is now a loadable fact. */
      if (!fw || fw.chainsPriced === 0) why.feesUsd = "not_yet_calculated";
      why.startCapitalUsd = "historical_input_missing";
      return why;
    })(),
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
          /*
           * THE SAME COVERAGE THE FIGURE WAS ACTUALLY COMPUTED OVER.
           *
           * This used to report `closedPriced` -- positions carrying an entry AND an exit
           * PRICE, which is the denominator the return figures need and has nothing to do
           * with a duration. So one median appeared twice under two coverages, 43 of 43 here
           * and 3 of 43 there, and a consumer had no way to tell which was true. A duration
           * needs two timestamps, so the denominator is the positions that carry them, which
           * is exactly `holds` -- the array this median was taken from.
           */
          coverage: cov(holds.length, closedCount),
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
    /**
     * HOW MUCH OF THIS TRADER'S BUYING WE HOLD BUY BY BUY.
     *
     * Read this before counting anything in `byToken[].buys`. A percentile over the buys we
     * happen to hold, printed as a fact about the trader, is the failure this API is built
     * against -- and the buys we hold are not a random sample of his. They are the ones on
     * chains whose swaps we could resolve.
     *
     * `positions` is what the scorecard is built from, and it is the honest denominator: each
     * one folds an unknown number of fills into a single average.
     */
    buysCoverage: (() => {
      const withBuys = byToken.filter((x) => x.buysTotal > 0);
      const total = byToken.reduce((a, x) => a + x.buysTotal, 0);
      return {
        buys: total,
        coinsWithBuys: withBuys.length,
        coinsTotal: byToken.length,
        share: byToken.length
          ? Number((withBuys.length / byToken.length).toFixed(4)) : null,
        basis: "individual buys resolved from chain swaps. Solana throughout; the four " +
               "Ethereum-style chains only where a transaction shows this wallet both " +
               "sending and receiving a token, which is what a trade the wallet made looks " +
               "like",
        why: total === 0
          ? "no individual buys resolved for this trader — count from avgEntryPrice instead, " +
            "which is one figure per coin"
          : null,
      };
    })(),
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
    /**
     * The same count under the name the consumer's verdict test actually reads.
     *
     * Their "real record" test is `topTradeShare` plus at least 30 coins, and it reads
     * `coinsTotal`. We published it only as `tokensTotal` and inside `buysCoverage`, so the
     * test looked at the top level, found nothing, and evaluated a threshold against
     * undefined. One coin, one token, one name on each side.
     */
    coinsTotal: byToken.length,
    /**
     * OMITTED, NOT EMPTIED, when the caller asked for no coins.
     *
     * The bulk route passes `tokenLimit: 0` because a page of fifty traders carrying every
     * coin each is a payload nobody asked for. `slice(0, 0)` made that an EMPTY ARRAY, which
     * is a different statement: `byToken: []` beside `tokensTotal: 390` reads as "this trader
     * has no coins", and the consumer's own rule says an absent list means "we did not say"
     * and an empty one means "there are none". We were asserting the wrong one.
     *
     * So at zero the key does not appear at all, and `tokensTotal` still says how many exist.
     */
    ...(tokenLimit === 0
      ? {}
      : { byToken: tokenLimit === null ? byToken : byToken.slice(0, tokenLimit) }),
    plain, caveats,
  };
}

get("/v1/traders/:handle/scorecard", async ({ handle }, url) => {
  const [t] = await sql`
    select t.handle, t.display_handle, t.name, t.source, s.volume_usd, s.trade_count
    from traders t left join trader_stats_current s using (handle)
    where t.handle = ${await resolveTrader(handle)}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);

  const h = t.handle as string;
  /*
   * Three queries became one. The entry price, the exit P&L and the individual buys are all
   * derived from the same swap rows, so they are fetched once -- see `swapsFor`.
   */
  const [rows, swapBy, feeBy] = await Promise.all([
    scorecardRows([h]),
    swapsFor([h]),
    nativePrices().then((nat) => feesFor([h], nat)),
  ]);
  if (!rows.length) throw notFound(`no stored trades for '${t.handle}'`);

  const swaps = swapBy.get(h) ?? [];
  const entries = chainEntriesFrom(swaps);
  const startCap = (await monthStartCapital([h])).get(h) ?? null;
  return await scorecardBody(t, rows, intParam(url, "tokens", { min: 0, fallback: null }), {
    entries,
    exits: chainExitsFrom(swaps, entries),
  }, feeBy.get(h) ?? null, buysFrom(swaps), startCap);
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
/**
 * THE SAME WINDOW, SPELLED THE WAY PEOPLE SPELL IT.
 *
 * The four windows are `1d`, `1w`, `1m`, `all`, and everything else was a 400 -- including
 * `30d`, which is the natural request from a document that keeps saying "thirty days", and
 * `1D` / `30D` / `1M`, which is how chart buttons are usually labelled. A consumer whose pills
 * read 1D / 7D / 30D / All got a chart on three of them and an error on the fourth, which
 * reads as the service being down rather than as a spelling disagreement.
 *
 * The canonical names are unchanged and are what `window` echoes back, so nothing that already
 * works changes its answer. These are only ways IN.
 */
const WINDOW_ALIASES: Record<string, string> = {
  "24h": "1d", "1day": "1d",
  "7d": "1w", "1week": "1w", "7day": "1w",
  "30d": "1m", "1month": "1m", "30day": "1m", "1mo": "1m",
  everything: "all", lifetime: "all", max: "all",
};

/** Canonical window for a requested one, or null when it is not a window we serve. */
function resolveWindow(raw: string): string | null {
  const k = raw.trim().toLowerCase();
  if (k in AUM_WINDOWS) return k;
  return WINDOW_ALIASES[k] ?? null;
}

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
  const asked = (url.searchParams.get("window") ?? "1w").trim();
  const windowKey = resolveWindow(asked);
  if (windowKey === null) {
    throw badRequest(
      `'window' must be one of ${Object.keys(AUM_WINDOWS).join(", ")} — got '${asked}'. ` +
      `Also accepted: ${Object.keys(WINDOW_ALIASES).join(", ")}, in any case.`,
      { parameter: "window" },
    );
  }
  const stepRaw = url.searchParams.get("step");
  /* Steps take the same courtesy: `1H` and `6H` are the same request as `1h` and `6h`. */
  if (stepRaw !== null &&
      !AUM_STEPS.some((s) => s.name === stepRaw.trim().toLowerCase())) {
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
  opts: {
    windowKey: string; stepRaw: string | null;
    chainFilter: { network_id: number; name: string } | null; to: Date;
    /** Every point's chain split, keyed "<iso at>|<basis>". Null when not fetched. */
    pointChains?: Map<string, { chain: string; usd: number | null }[]> | null;
    /** Every chain this trader uses, window-independent. Null when not fetched. */
    knownChains?: KnownChain[] | null;
    /** Each chain's own coin and what one costs, for the native amounts on `chains[]`. */
    natives?: Map<number, NativePrice> | null;
    sampler?: { lastAt: Date | null; lastSuccess: Date | null };
  },
) {
  const { windowKey, stepRaw, chainFilter, to } = opts;
  const span = AUM_WINDOWS[windowKey];
  const from = span === null ? null : new Date(to.getTime() - span);

  /*
   * A FIGURE BUILT FROM ALMOST NONE OF A WALLET IS NOT A BALANCE.
   *
   * Section 9 has always said `totalUsd` is null, never a smaller number, when a wallet could
   * not be read. That rule was applied to outright refusals and not to the case that actually
   * bites: a point that DID answer, for 1.7% of the wallet.
   *
   * Measured over thirty days: the median REBUILT point prices 1.7% of its trader's value,
   * and 6,133 of 7,815 price under a tenth. The median SAMPLED point prices 66.7%. So the
   * rebuilt history is thinly priced by construction -- and drawing it as a balance line
   * produces exactly what the consumer reported: $40 to $389,797 between two neighbouring
   * points, with no method change and no chain change to explain it. 1,226 of 3,033 jumps of
   * half or more had no declared cause, and on those the lower side priced a median 1.2%.
   *
   * No break marker fixes that, because both sides are thin: the ratio between 1.2% and 1.5%
   * is nothing, while the dollar figures differ by a thousandfold. The honest answer is the
   * one this document already gives everywhere else -- refuse the number and say why. The
   * point still exists, `gaps[]` still lists it, and a chart breaks its line there instead of
   * drawing through a figure that is wrong in a way no consumer could detect.
   *
   * PRICED_FLOOR is the one number that decides this. It is deliberately a single constant,
   * and the trade at each setting was measured against the consumer's own metric -- jumps of
   * half or more on the month window that carry no declared cause:
   *
   *     floor   traders who can draw     undeclared jumps
   *     none            432                    1,226
   *     0.10            416                      254
   *     0.20            408                      158   <- here
   *     0.30            393                      122
   *
   * 0.20 halves the residual for the cost of eight traders. Of the 158 that remain, 66 have
   * both sides pricing over half the wallet -- those are most likely real moves, and marking
   * them would be a false alarm rather than a fix.
   *
   * RAISED TO 0.25 for the v10 acceptance tests, which ask for a quarter rather than a fifth.
   * Measured at 0.20: 341 points were served as a balance on a value share between 20.0% and
   * 24.6%, and none below 20%. Those 341 are exactly what this move converts into refusals.
   *
   * A MINIMUM PRICED-POSITION COUNT BELONGS HERE TOO, and cannot be added yet.
   *
   * Measured on unipcs, 18 August: the whole book was refused at a 0.32% priced share, and so
   * were robinhood and solana on the same reading. `bsc` was SERVED, at a 50% share, because
   * bsc held two positions and one of them was priced -- so a consumer summing chains built a
   * $0.44 chart for a man the service itself refused to price. A share alone cannot catch
   * that; it needs the count behind the share.
   *
   * `aum_chain_samples` does not carry one. The chain query below selects
   * `null::int as priced_positions` because the column does not exist, so a count-based guard
   * would silently never fire on exactly the path that needs it. Adding it is a migration
   * plus a rebuild, not a read-path change.
   */
  const PRICED_FLOOR = 0.25;
  /*
   * THE REFUSED FIGURE IS KEPT, not discarded.
   *
   * Refusing a thin point is right: served as `totalUsd` it is a balance, and a balance built
   * from 3% of a wallet is wrong in a way no consumer can detect. But the number was computed
   * from real positions at a real moment, and throwing it away meant a month of history with
   * three drawable points out of twenty-seven -- the other twenty-four existed and said
   * nothing at all.
   *
   * So the refusal stands and the arithmetic survives beside it. `partialUsd` is the figure as
   * computed, carrying the coverage it was computed at, and it is NEVER `totalUsd`: a caller
   * has to reach for it deliberately, and cannot mistake it for a balance the service stands
   * behind. Plot it as a faint line, a shaded band, a tooltip -- but not as his money.
   */
  rows = rows.map((r) => {
    const share = n(r.value_share);
    if (n(r.total_usd) === null || share === null || share >= PRICED_FLOOR) return r;
    return {
      ...r,
      total_usd: null,
      refused_reason: "too_little_priced",
      /** What `total_usd` would have been. Not a balance — see the note above. */
      partial_usd: n(r.total_usd),
    };
  });

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
   * THE DEFAULT STEP IS THE COARSER OF WHAT THE WINDOW AFFORDS AND WHAT THE DATA HOLDS.
   *
   * It used to be the first of those alone: the coarsest step leaving at least 24 points in
   * the requested span, so a week does not arrive as 168 points nobody plots and a day does
   * not collapse to 1. That is a sound rule about the WINDOW and says nothing about the
   * readings, so every one of the 435 weeks declared 6h steps over readings a day apart --
   * 566 of the gaps between neighbouring readings measured 24 hours, against 156 at 8 and
   * 258 at 16. The answer described itself wrongly, which is its own kind of untrue figure.
   *
   * So the observed spacing sets a floor. A week over daily readings declares 1d, and starts
   * declaring 6h on its own the day the readings are actually six-hourly.
   */
  const rawGaps: number[] = [];
  for (let i = 1; i < windowed.length; i++) {
    const g = Date.parse(String(windowed[i].at)) - Date.parse(String(windowed[i - 1].at));
    if (Number.isFinite(g) && g > 0) rawGaps.push(g);
  }
  rawGaps.sort((a, b) => a - b);
  /** Median, not mean: one long gap after a quiet spell must not coarsen the whole series. */
  const observedStepMs = rawGaps.length ? rawGaps[Math.floor(rawGaps.length / 2)] : 0;

  const chosen = stepRaw !== null
    ? AUM_STEPS.find((s) => s.name === stepRaw.trim().toLowerCase())!
    : [...AUM_STEPS].reverse().find((s) =>
        span === null || Math.floor(span / s.ms) >= 24
      ) ?? AUM_STEPS[0];

  /*
   * WHAT IS DECLARED IS NOT WHAT IS BUCKETED, and conflating them costs real readings.
   *
   * `chosen` is the bucket the points are thinned into, and it must stay as fine as the
   * window affords: coarsening it to match the data merged both of one trader's 10 September
   * readings into one and returned five points where six exist. Thinning is for keeping a
   * chart plottable, not for making the label true.
   *
   * `declared` is what the answer CALLS its step, and that has to match the readings. It is
   * the coarsest step that covers the observed spacing, so a week over daily readings says
   * 1d and begins saying 6h by itself the day the readings are six-hourly.
   *
   * A caller who names a step gets that step in both places: they asked, and the answer
   * should not argue. `observedStepMs` still reports what the data does either way.
   */
  const declared = stepRaw !== null
    ? chosen
    : (AUM_STEPS.find((x) => x.ms >= Math.max(chosen.ms, observedStepMs))
       ?? AUM_STEPS[AUM_STEPS.length - 1]);

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
    /**
     * THE FIGURE BEHIND A REFUSAL. Present only when this point was refused for thin pricing,
     * null otherwise.
     *
     * Not a balance, and deliberately not `totalUsd`. It is what the priced positions summed
     * to at this moment, and `coverage.valueShare` says how much of him that was. A month
     * window that draws three points out of twenty-seven has twenty-four of these: real
     * arithmetic over real positions, too thin to publish as his money, too informative to
     * throw away. Draw it faint, or on request, or not at all — but never as the line.
     */
    partialUsd: round(n((r as { partial_usd?: unknown }).partial_usd)),
    basis: r.basis as string,
    tier: r.tier as string,
    coverage: {
      pricedPositions: r.priced_positions === null ? null : Number(r.priced_positions),
      totalPositions: r.total_positions === null ? null : Number(r.total_positions),
      /**
       * `valueShare` IS NOT A SHARE OF VALUE, and the name has misled for long enough.
       *
       * It is `pricedPositions ÷ totalPositions` -- a COUNT. Measured on poopinyourhands:
       * 18 priced of 20 positions, valueShare 0.9, and 18÷20 = 0.9 exactly. The consumer
       * caught this and is right: a trader whose one real holding is fully priced but who
       * carries sixteen dust positions reads as thin and gets refused by a floor built on
       * this number, when by value we have priced essentially everything he owns.
       *
       * A TRUE share of value cannot be computed and never could: the unpriced positions are
       * unpriced, so their value is unknown by definition. Pretending otherwise would be a
       * worse answer than a badly named one.
       *
       * So the field is named honestly alongside, and the old name keeps working. Read
       * `pricedPositionShare`; `valueShare` is the same number under a name that lies about
       * what it counts.
       */
      pricedPositionShare: n(r.value_share),
      /** @deprecated A count ratio, not a share of value. Read `pricedPositionShare`. */
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
      /*
       * PARTIAL MEANS THE FIGURE IS INCOMPLETE, by whichever route it got that way.
       *
       * It used to mean only "a chain is missing", so 106 readings priced less than all of
       * their value and still said `partial: false`. A total built from 63% of a wallet is
       * partial whether the missing 37% is a whole chain or a thousand unpriced coins.
       */
      partial: (() => {
        const chainsShort = r.chains_answered !== null && r.chains_expected !== null &&
          Number(r.chains_answered) < Number(r.chains_expected);
        const share = n(r.value_share);
        const priceShort = share !== null && share < 1;
        return (r.chains_answered === null || r.chains_expected === null) && share === null
          ? null
          : (chainsShort || priceShort);
      })(),
      /** Which of the two made it partial, so a consumer can tell them apart. */
      partialReason: (() => {
        const chainsShort = r.chains_answered !== null && r.chains_expected !== null &&
          Number(r.chains_answered) < Number(r.chains_expected);
        const share = n(r.value_share);
        const priceShort = share !== null && share < 1;
        if (chainsShort && priceShort) return "chains_missing_and_unpriced_positions";
        if (chainsShort) return "chains_missing";
        if (priceShort) return "unpriced_positions";
        return null;
      })(),
    },
    ...(r.refused_reason ? { refused: r.refused_reason as string } : {}),
    /** True for a real dated reading borrowed from just before the requested window. */
    ...(anchorAts.has(new Date(String(r.at)).toISOString()) ? { outsideWindow: true } : {}),
  }));

  /*
   * ===================== THE SEAM BETWEEN TWO KINDS OF POINT =====================
   *
   * Section 9 already says a sampled figure and a rebuilt one count different things, and
   * refuses to borrow across that seam. The series itself was not held to the same rule: two
   * neighbouring points could be valued over different sets of chains, and the difference was
   * printed as a move in the balance. `fhn_gt` read $65,367.54, then $33.26, then $52,276.29,
   * and a card said "+155,855.5% in 7 days". He did not lose 99.9% of his money -- the second
   * point answered for robinhood alone, having dropped the ethereum leg the first one had.
   *
   * The consumer asked for three things, best first. What each one costs, measured over the
   * last week across all 435 traders (1,418 consecutive valued steps, 865 of which move the
   * line by half or more):
   *
   *   1. "Value both kinds the same way." NOT POSSIBLE from what is stored, and the reason is
   *      specific rather than a shrug. Per chain, a rebuilt point prices 39% of the positions
   *      on average and a sampled one 77-84%; the cliffs concentrate exactly on the steps that
   *      cross between them (60% of sampled-after-rebuilt steps, 74% of rebuilt-after-sampled,
   *      against 14% of sampled-after-sampled). Equalising that needs the per-token history the
   *      rebuild did not keep -- only the per-chain totals were stored. Valuing every point
   *      over the chains they all share was tried and measured: it removes the chain-set
   *      cliffs and leaves the coverage ones, 548 of 1,074 steps still moving by half or more.
   *      A column called "comparable" that is wrong half the time is the failure this API is
   *      organised against, so it is not published.
   *
   *   2. "Mark every change of method." Done, and WIDENED, because as asked it would have
   *      missed a quarter of them: 542 of the 865 big moves change `basis`, but 226 more keep
   *      the same method and change the set of chains -- both of `fhn_gt`'s first two steps
   *      among them. Marking either catches 768 of 865.
   *
   *   3. "Failing both, don't call it drawable." Not needed, and not done: `drawable` stays
   *      the service's answer about whether a line exists, which is a different question, and
   *      85% of rebuilt points are partial -- refusing all of them would delete the history
   *      rather than describe it.
   */
  const pointChains = opts.pointChains ?? null;
  const keyOf = (at: string, basis: string) => `${at}|${basis}`;

  /** The chains a point actually put a number on. Empty when we hold no split for it. */
  const chainsAt = (at: string, basis: string): string[] => {
    if (!pointChains) return [];
    const rowsHere = pointChains.get(keyOf(at, basis)) ?? [];
    const names = rowsHere.filter((x) => x.usd !== null).map((x) => x.chain);
    // A one-chain series has no chain-set question to answer; it is already comparable.
    return (chainFilter ? names.filter((c) => c === chainFilter.name) : names).sort();
  };

  /*
   * EVERY SEAM BETWEEN TWO VALUED POINTS, in either direction. A change of method and a
   * change of chain set are both reasons two figures cannot be subtracted, and a step can be
   * both at once. This is a statement about what the two numbers COUNT, not about how far
   * apart they are: a step that changed composition and barely moved is still marked, because
   * the next one like it will move a great deal.
   */
  const valued = points.filter((p) => p.totalUsd !== null);
  const breaks: {
    at: string; previousAt: string; reason: string;
    chainsAdded: string[]; chainsRemoved: string[];
    pricedShareBefore: number | null; pricedShareAfter: number | null;
  }[] = [];
  /** The source row behind each returned point, for the priced share the point does not carry. */
  const valuedRowByKey = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    valuedRowByKey.set(
      `${new Date(String(r.at)).toISOString()}|${r.basis}`, r);
  }
  /*
   * A THIRD REASON, AND IT IS THE COMMONEST ONE.
   *
   * Method and chain set were the two I marked, and I tested a priced-share rule once, on the
   * WEEK window at a ten-point threshold, found it bought 21 catches for 25 extra marks, and
   * dropped it. That was the wrong window and the wrong threshold. On the MONTH window 1,261
   * of 2,768 jumps of half or more carry no break at all -- 46% -- and on those jumps the
   * lower point prices a median 1.5% of the trader's value. One measured example: a line went
   * $358,325 -> $1,132,934 drawn from 3 of 2,477 priced holdings, same chains, same method.
   *
   * That is not a move in the balance, it is a move in how much of the wallet we could see.
   * So a material change in priced share is a break, on the same footing as the other two.
   *
   * The threshold is a RATIO, not a difference in points: 63% against 60% is the same picture
   * twice, while 1.5% against 60% is two different pictures. A doubling either way is the
   * line at which the smaller reading is no longer measuring the same trader.
   */
  const SHARE_RATIO = 2;
  const shareAt = (p: { at: string; basis: string }): number | null => {
    const row = valuedRowByKey.get(`${p.at}|${p.basis}`);
    return row ? n(row.value_share) : null;
  };

  for (let i = 1; i < valued.length; i++) {
    const prev = valued[i - 1], cur = valued[i];
    const a = chainsAt(prev.at, prev.basis), b = chainsAt(cur.at, cur.basis);
    const added = b.filter((c) => !a.includes(c));
    const removed = a.filter((c) => !b.includes(c));
    const methodChanged = prev.basis !== cur.basis;
    const chainsChanged = added.length > 0 || removed.length > 0;

    const ps = shareAt(prev), cs = shareAt(cur);
    const shareChanged = ps !== null && cs !== null && ps > 0 && cs > 0 &&
      Math.max(ps / cs, cs / ps) >= SHARE_RATIO;

    if (!methodChanged && !chainsChanged && !shareChanged) continue;
    const why: string[] = [];
    if (methodChanged) why.push("method");
    if (chainsChanged) why.push("chains");
    if (shareChanged) why.push("priced_share");
    breaks.push({
      at: cur.at,
      previousAt: prev.at,
      reason: why.join("_and_") + "_changed",
      chainsAdded: added,
      chainsRemoved: removed,
      /** The share of value each side priced, so the size of the change is visible. */
      pricedShareBefore: ps,
      pricedShareAfter: cs,
    });
  }
  const breakAt = new Set(breaks.map((b) => b.at));

  /** The seam fields live on the point, so a chart reading `points[]` alone still sees them. */
  const pointsOut = points.map((p, i) => ({
    ...p,
    /**
     * The chains this point put a number on, by name. `coverage.chainsAnswered` gives the
     * count; this says WHICH, which is what makes a step explicable rather than mysterious.
     */
    chains: chainsAt(p.at, p.basis),
    /**
     * False when this figure and the one before it do not count the same thing. Never measure
     * a percentage across a `false` -- break the line there. Null on the first point, which
     * has nothing before it.
     */
    comparableWithPrevious: i === 0 || p.totalUsd === null ? null : !breakAt.has(p.at),
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

  /*
   * `now` IS THE MOST COMPLETE RECENT READING, NOT SIMPLY THE NEWEST.
   *
   * It used to be the last row by time, and that published a number three times too small.
   * When the sampler fell behind, the newest row became a REBUILT point covering 1 of a
   * trader's 5 chains, and unipcs was reported at $5.1M -- eight hours after a measured
   * reading of $15.7M, against a portfolio route saying $15.8M. The figure people read first
   * was a fifth of him, presented as all of him.
   *
   * So completeness wins over recency: the newest reading that answered for every chain he is
   * known to be on, falling back to the newest that answered for the most of them, and only
   * then to the newest row at all. Recency still breaks ties, so a fresh full reading always
   * beats a stale one.
   */
  const withFigure = rows.filter((r) => n(r.total_usd) !== null);
  const cover = (r: Record<string, unknown>) =>
    r.chains_answered === null || r.chains_answered === undefined ? -1 : Number(r.chains_answered);
  const wanted = (r: Record<string, unknown>) =>
    r.chains_expected === null || r.chains_expected === undefined ? -1 : Number(r.chains_expected);

  let newest: Record<string, unknown> | null = null;
  if (withFigure.length) {
    /*
     * RECENT FIRST, THEN COMPLETE. Completeness alone is not enough -- ranking purely on it
     * picked a five-day-old rebuild covering 5 of 5 chains over a measured reading taken that
     * morning covering 4 of 5, which is a different way of publishing the wrong number.
     *
     * So only readings close to the freshest one compete, using the same 36-hour allowance
     * the sampler is judged by. Among those: widest coverage wins, a measured reading beats an
     * inferred one at equal coverage, and recency settles the rest.
     */
    const freshest = Date.parse(String(withFigure[withFigure.length - 1].at));
    const RECENT_MS = 36 * 3_600_000;
    const recent = withFigure.filter((r) => freshest - Date.parse(String(r.at)) <= RECENT_MS);
    const pool = recent.length ? recent : [withFigure[withFigure.length - 1]];

    const score = (r: Record<string, unknown>): [number, number, number] => [
      cover(r),
      r.basis === "sampled" ? 1 : 0,
      Date.parse(String(r.at)),
    ];
    let best = pool[0];
    for (const r of pool) {
      const a = score(r), b = score(best);
      if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) best = r;
    }
    newest = best;
  } else if (rows.length) {
    // Every reading was refused. The newest one still carries the reason, which is the answer.
    newest = rows[rows.length - 1];
  }

  /*
   * REACH -- what the stored data actually covers, as opposed to what was asked for.
   * `from` echoes the request and is not evidence of anything; a caller that reads it as
   * coverage will label a one-point series "30D".
   */
  const firstAt = points.length ? Date.parse(points[0].at) : null;
  const lastAt  = points.length ? Date.parse(points[points.length - 1].at) : null;
  const requestedDays = span === null ? null : Math.round(span / 86_400_000);
  /*
   * ANCHOR POINTS ARE EXCLUDED FROM `coveredDays`, because they were not asked for.
   *
   * A 1d window keeps one real reading from just BEFORE the window so a single-point chart
   * has something to compare against (see the anchor block above), and marks it
   * `outsideWindow: true`. Counting it made `coveredDays: 2` against `requestedDays: 1` on
   * 431 of 448 one-day answers -- a consumer testing the documented
   * `coveredDays <= requestedDays` relation failed on 96% of them.
   *
   * The anchor is still SERVED and still flagged; it is simply not counted as coverage of a
   * window it sits outside. `reach.anchorPoints` says how many were borrowed, so the
   * difference between what is drawn and what was requested stays visible.
   */
  const inWindowPoints = points.filter((p) => !(p as { outsideWindow?: boolean }).outsideWindow);
  const anchorPoints = points.length - inWindowPoints.length;
  const covFirst = inWindowPoints.length ? Date.parse(inWindowPoints[0].at) : firstAt;
  const covLast = inWindowPoints.length
    ? Date.parse(inWindowPoints[inWindowPoints.length - 1].at) : lastAt;
  const coveredDays = covFirst !== null && covLast !== null
    ? Math.max(0, Math.round((covLast - covFirst) / 86_400_000))
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
  /*
   * A ZERO THAT NOTHING ANSWERED FOR IS NOT A ZERO.
   *
   * Section 9 says a trader whose wallets all answered and held nothing reads `0`, and that
   * zero is a measurement. The rule was right and the CHECK was missing: nothing verified
   * that a wallet had answered. 72 of 432 ready traders returned exactly $0 with no chain
   * count, no priced share and no positions, and 71 of them were still marked drawable -- so
   * a consumer following the flag drew a flat $0 line for a trader whose wallets are on known
   * chains and hold real coins.
   *
   * An empty read is a refusal. It is told apart from a real zero by the coverage beside it:
   * a measured zero answered for at least one chain or looked at at least one position.
   */
  const emptyRead = (r: Record<string, unknown> | null): boolean => {
    if (!r) return false;
    if (n(r.total_usd) !== 0) return false;
    const chains = r.chains_answered === null || r.chains_answered === undefined
      ? 0 : Number(r.chains_answered);
    const looked = r.total_positions === null || r.total_positions === undefined
      ? 0 : Number(r.total_positions);
    return chains === 0 && looked === 0;
  };
  /*
   * TWO WAYS TO HAVE NOTHING, and both must stop `ready`.
   *
   *   a zero nothing answered for  -- total 0, no chains, no positions   (72 traders)
   *   no figure at all             -- every reading refused               (seen live)
   *
   * The second was reported as `ready` even after the first was fixed, because a refused row
   * is still a row and the fallback picked it up.
   */
  const newestIsEmpty = emptyRead(newest) || withFigure.length === 0;

  const MIN_DRAWABLE_POINTS = 2;
  const usable = points.filter((p) => p.totalUsd !== null);
  let drawable = true;
  let reason: string | null = null;
  if (newestIsEmpty) {
    /*
     * Nothing answered for this trader at the newest reading. Not drawable, and not `ready`
     * below -- the series would otherwise be a flat line at zero drawn from nothing.
     */
    drawable = false;
    reason = "nothing_answered";
  } else if (usable.length < MIN_DRAWABLE_POINTS) {
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
  /*
   * EACH GAP CARRIES THE SPAN IT COVERS, not just the moment it sits at.
   *
   * `at` alone says where the hole is; `from`/`to` say how wide. A consumer drawing a broken
   * line needs the width -- it is the difference between a dot and a segment -- and the
   * consumer's own field contract asks for all three: "Each carries at, from, to, reason."
   *
   * The span is the bucket this point occupies: from its own moment to the next point's, or
   * to the end of the window when it is the last. Consecutive refusals therefore describe a
   * continuous hole rather than a row of unconnected dots.
   */
  const gaps = points
    .map((p, i) => ({ p, next: points[i + 1] }))
    .filter(({ p }) =>
      p.totalUsd === null &&
      /*
       * A REFUSED ANCHOR IS NOT A GAP IN THIS WINDOW.
       *
       * The anchor is a reading borrowed from BEFORE the window so a short chart has a
       * baseline; it is served and flagged `outsideWindow`. When it happens to be refused it
       * was also landing in `gaps[]`, dated before `from` — and a consumer walking gaps to
       * draw holes inside the window got one outside it, which is both wrong and a violation
       * of the stated `every gap falls inside from..to`. Four answers did this.
       *
       * The point itself still carries its `refused` word, so nothing is hidden; it simply is
       * not described as a hole in a window it was never part of.
       */
      !(p as { outsideWindow?: boolean }).outsideWindow)
    .map(({ p, next }) => ({
      at: p.at,
      from: p.at,
      /**
       * The next reading's moment, or this point's own when it is the last.
       *
       * NOT the window's end, which is computed from the clock: that made the final gap's
       * span widen by a few milliseconds on every request, so two reads seconds apart
       * disagreed about a hole that had not moved.
       */
      to: next?.at ?? p.at,
      reason: (p as { refused?: string }).refused ?? "no_prices",
    }));

  /*
   * How much of the trader the newest point could see, in wallets and chains. A chain we
   * hold no row for did not contribute zero dollars -- it contributed nothing at all.
   */
  /*
   * TOTAL CHAINS COMES FROM THE SAME UNION `knownChains` DOES, not from what is held today.
   *
   * `presence` counts `holdings_current where human_amount > 0` -- chains the trader holds
   * something on RIGHT NOW. `answeredNets` below counts chains that produced a reading. A
   * trader who has sold out of a chain still has readings there, so answered exceeded total
   * for twelve traders: RunningClam reported 5 of 4, gundam 4 of 3, 0xkuidian 3 of 2. A
   * coverage ratio above 1 is not a coverage ratio.
   *
   * `opts.knownChains` is already built from the union of wallet_chain_presence,
   * holdings_current and aum_chain_samples, and is already carried on this envelope, so this
   * costs no query. Falls back to the old count when it was not fetched.
   */
  const totalChains = opts.knownChains?.length ?? Number(presence?.chains ?? 0);

  const answeredNets = new Set(
    chainRows.filter((r) => r.total_usd !== null).map((r) => Number(r.network_id)));
  /*
   * TOTAL WALLETS FROM THE SAME UNION AS THE CHAINS, for the reason `totalChains` above moved.
   *
   * `presence` counts wallet families the trader holds something on RIGHT NOW. `answeredNets`
   * counts families that produced a reading, and a trader who has sold out of a family still
   * has readings there — so answered exceeded total for gmgn_0xc91063fd on all four windows,
   * which is a coverage ratio above 1 and therefore not a coverage ratio.
   *
   * `knownChains` already unions presence, holdings and chain samples, so the families it
   * names are the honest denominator. Falls back to the old count when it was not fetched.
   */
  const totalWallets = opts.knownChains?.length
    ? (opts.knownChains.some((c) => Number(c.networkId) !== SOLANA_NET) ? 1 : 0) +
      (opts.knownChains.some((c) => Number(c.networkId) === SOLANA_NET) ? 1 : 0)
    : (presence?.on_evm ? 1 : 0) + (presence?.on_solana ? 1 : 0);
  const answeredWallets =
    ([...answeredNets].some((x) => x !== SOLANA_NET) ? 1 : 0) +
    (answeredNets.has(SOLANA_NET) ? 1 : 0);
  /*
   * IS THE NEWEST READING SHORT OF A CHAIN -- asked of the ENVELOPE when the reading cannot say.
   *
   * `partial` used to be computed from the reading's own `chains_answered` / `chains_expected`
   * alone. Those are frequently null, and when they are, only the pricing share is left -- so
   * an answer missing a whole chain reported `partial: false`. 268 answers did exactly that.
   * ethersole: `coverage` said 3 chains of 4 and 1 wallet of 2, while `now.partial` said false
   * and `status` said ready. Two blocks of one answer disagreeing about whether it is complete.
   *
   * The envelope's own counts are computed just above and know better, so they are the
   * fallback. The reading's own numbers still win when it has them -- they describe that
   * reading, where the envelope describes the trader.
   */
  const newestPartial = (() => {
    const r = newest;
    if (!r) return { partial: null as boolean | null, reason: null as string | null };
    const ownCover = cover(r), ownWanted = wanted(r);
    const hasOwn = ownCover >= 0 && ownWanted >= 0;
    /*
     * EITHER MEASURE SAYING "SHORT" MAKES IT SHORT, and it has to be an OR rather than a
     * preference for the reading's own numbers.
     *
     * The two count different things. A reading's `chains_expected` is what that read went and
     * ASKED -- the sampler only reaches an EVM chain the trader has traded tokens on. The
     * envelope's `totalChains` is every chain he is KNOWN to use, from the wider union. For
     * `enci` those are 4 and 5: his reading answered everything it asked and still covered
     * four fifths of him, so trusting the reading alone published `partial: false` beside a
     * `coverage` block that plainly said 4 of 5. Four answers did exactly that.
     *
     * Neither number is wrong; they answer different questions. The honest combination is the
     * pessimistic one -- complete means complete by both.
     */
    const ownShort = hasOwn && ownCover < ownWanted;
    const envShort = totalChains > 0 && answeredNets.size < totalChains;
    const chainsShort = ownShort || envShort;
    const share = n(r.value_share);
    const priceShort = share !== null && share < 1;
    const known = hasOwn || totalChains > 0 || share !== null;
    if (!known) return { partial: null as boolean | null, reason: null as string | null };
    return {
      partial: chainsShort || priceShort,
      reason: chainsShort && priceShort
        ? "chains_missing_and_unpriced_positions"
        : chainsShort
        ? "chains_missing"
        : priceShort
        ? "unpriced_positions"
        : null,
    };
  })();

  const warming = drawable === false && (reason === "warming" || reason === "short_coverage");
  const nextRun = new Date();
  nextRun.setUTCHours(6, 0, 0, 0);
  if (nextRun.getTime() <= Date.now()) nextRun.setUTCDate(nextRun.getUTCDate() + 1);

  /*
   * SAMPLER STATE, NAMED RATHER THAN IMPLIED.
   *
   * The sampler runs daily, so a reading inside 36 hours is on schedule -- one run plus a
   * fully missed one, the same allowance the staleness check uses. Past that the readings are
   * still true, they are simply old, and the answer has to say so instead of reporting
   * `ready` over three-day-old figures.
   *
   * `lastAttemptAt` is null on purpose: we record successes, not attempts, and inventing a
   * value would be worse than admitting the gap.
   */
  const STALE_AFTER_H = 36;
  const lastSuccess = opts.sampler?.lastSuccess ?? null;

  /*
   * THE STATE IS THIS TRADER'S, NOT THE PIPELINE'S.
   *
   * This was computed from the newest successful run anywhere in the table -- so on a night
   * the sampler ran for most of the directory, a trader whose OWN newest reading was 6.8 days
   * old still answered `current`, and `status` still said `ready`. Fourteen traders were
   * measured in exactly that state, and a consumer trusting `status` drew a week-old figure
   * as today's.
   *
   * A trader is asking about himself. The age that matters is the age of the reading he is
   * about to be shown, so that is what decides the verdict. The pipeline's own last run is
   * still reported, under a name that says what it is, because "my reading is old" and "the
   * job has stopped" are different problems with different fixes.
   */
  /*
   * The age of the FIGURE, not of the newest row.
   *
   * When every reading a trader has is refused, `newest` falls back to the newest row so its
   * reason can be reported -- but that row carries no number. Ageing it said "this trader's
   * reading is 25 hours old" about a reading that does not exist, and `status` answered
   * `ready`. A reading with no figure has no age.
   */
  const ownAgeH = newest?.at && n(newest.total_usd) !== null
    ? (to.getTime() - Date.parse(String(newest.at))) / 3_600_000
    : null;
  const sinceSuccessH = lastSuccess === null
    ? null
    : (to.getTime() - lastSuccess.getTime()) / 3_600_000;

  const samplerState = ownAgeH === null
    ? "warming"
    : (ownAgeH > STALE_AFTER_H ? "stale" : "current");

  const samplerBlock = {
    state: samplerState,
    lastAttemptAt: null,
    /** When THIS trader was last measured. The figure `state` is judged on. */
    lastSuccessAt: newest?.at ? new Date(String(newest.at)).toISOString() : null,
    ageSeconds: ownAgeH === null ? null : Math.round(ownAgeH * 3600),
    nextExpectedAt: nextRun.toISOString(),
    staleAfterHours: STALE_AFTER_H,
    reason: samplerState === "stale"
      ? `this trader's newest reading is ${ownAgeH!.toFixed(1)}h old — it is true, but old`
      : null,
    /**
     * The pipeline's own clock, for telling "my reading is old" from "the job has stopped".
     * A fresh `pipelineLastSuccessAt` beside a stale `state` means the sampler ran and did
     * not reach this trader.
     */
    pipelineLastSuccessAt: lastSuccess ? lastSuccess.toISOString() : null,
    pipelineAgeSeconds: sinceSuccessH === null ? null : Math.round(sinceSuccessH * 3600),
  };

  return {
    handle: t.display_handle,
    /** Null means the whole portfolio. A name means this series is that chain alone. */
    chain: chainFilter ? chainFilter.name : null,
    window: windowKey,
    /**
     * When the figure this answer is anchored on was taken. Every route carries `asOf` so a
     * profile can date each panel separately instead of assuming they share a moment -- they
     * do not: balances, trades and the directory are refreshed by different jobs.
     */
    asOf: newest ? new Date(String(newest.at)).toISOString() : null,
    step: declared.name,
    /** The step in milliseconds, so a consumer need not parse "6h". */
    stepMs: declared.ms,
    /** The bucket the points were thinned into, which may be finer than the step declared. */
    bucketMs: chosen.ms,
    /**
     * The median spacing of the readings actually held, in milliseconds. `step` is the bucket
     * the points are thinned into; this is what the data does. They agree unless a caller
     * asked for a step explicitly, and a consumer labelling an axis should read this one.
     */
    observedStepMs: observedStepMs || null,
    /**
     * TRUE WHEN `step` UNDERSTATES THE REAL SPACING, AND IT CANNOT SAY SO ANY OTHER WAY.
     *
     * `step` is an enum of `1h`, `6h`, `1d` — a consumer switches on it, so it stays an enum.
     * But a one-day window over readings three and a half days apart has no honest value in
     * that set: `1d` is the coarsest name available and it still overstates how close the
     * points are. Rather than quietly return the wrong one, the answer says the label is a
     * floor and `observedStepMs` carries the truth.
     */
    stepUnderstated: observedStepMs > declared.ms,
    from: from ? from.toISOString() : (points[0]?.at ?? null),
    to: to.toISOString(),
    trackedSince,
    now: newest
      ? {
        at: new Date(String(newest.at)).toISOString(),
        totalUsd: round(n(newest.total_usd)),
        /** The figure behind a refusal, when this reading was refused. See points[].partialUsd. */
        partialUsd: round(n((newest as { partial_usd?: unknown }).partial_usd)),
        /** How old this reading is, so a card can say "as of Thursday" without doing date maths. */
        ageSeconds: Math.max(0, Math.round((to.getTime() - Date.parse(String(newest.at))) / 1000)),
        /** `sampled` was read from the chain at the time; `rebuilt` was inferred afterwards. */
        basis: newest.basis as string,
        tier: newest.tier as string,
        /**
         * True when this figure covers only part of the trader — a missing chain, unpriced
         * positions, or both. `partialReason` names which.
         */
        partial: newestPartial.partial,
        partialReason: newestPartial.reason,
        /*
         * ON `now` ITSELF, not only inside `coverage`.
         *
         * The contract names `now.chainsAnswered` and `now.chainsTotal`, and a consumer
         * reading the balance reads `now` -- asking it to descend into `coverage` to find out
         * whether the figure it just printed covers the whole trader is how a partial total
         * gets published as a whole one. Both spellings carry the same value.
         */
        chainsAnswered: newest.chains_answered === null ? null : Number(newest.chains_answered),
        chainsTotal: newest.chains_expected === null ? null : Number(newest.chains_expected),
        coverage: {
          pricedPositions: newest.priced_positions === null ? null : Number(newest.priced_positions),
          totalPositions: newest.total_positions === null ? null : Number(newest.total_positions),
          /** A count ratio. See points[].coverage.pricedPositionShare for why. */
          pricedPositionShare: n(newest.value_share),
          /** @deprecated A count ratio, not a share of value. Read `pricedPositionShare`. */
          valueShare: n(newest.value_share),
          chainsAnswered: newest.chains_answered === null ? null : Number(newest.chains_answered),
          chainsTotal: newest.chains_expected === null ? null : Number(newest.chains_expected),
        },
      }
      : null,
    count: points.length,

    /** What the stored data covers, as opposed to what was requested. */
    reach: {
      requestedFrom: from ? from.toISOString() : null,
      /*
       * The span INSIDE the window. An anchor borrowed from before it is served and flagged,
       * but reporting it here would contradict `coveredDays`, which excludes it -- a consumer
       * subtracting these two dates must get the same answer the day count gives.
       * Falls back to the full range when every point we hold is an anchor.
       */
      coveredFrom: (inWindowPoints[0] ?? points[0])?.at ?? null,
      coveredTo: (inWindowPoints[inWindowPoints.length - 1]
                  ?? points[points.length - 1])?.at ?? null,
      requestedDays,
      coveredDays,
      /** Real readings borrowed from before the window so a short chart has a baseline. */
      anchorPoints,
      complete: reachesBack,
    },

    /**
     * The service's own answer to "can this be drawn". Consumers must not infer readiness
     * from `window`, `from`, `count` or the position counts.
     */
    drawing: {
      drawable, usablePoints: usable.length, reason,
      /**
       * Points carrying a `partialUsd` — real arithmetic refused as too thin to be a balance.
       *
       * Published so a consumer can tell "there is nothing here" from "there is something
       * here we will not call his balance", which are very different answers to a blank
       * chart and used to look identical.
       */
      partialPoints: pointsOut.filter((p) =>
        (p as { totalUsd: number | null; partialUsd: number | null }).totalUsd === null &&
        (p as { partialUsd: number | null }).partialUsd !== null).length,
    },

    /** Coverage of the newest point, in wallets and chains rather than positions. */
    coverage: { answeredWallets, totalWallets, answeredChains: answeredNets.size, totalChains },

    /**
     * EVERY CHAIN THIS TRADER USES, and it does not change with the window.
     *
     * `chains` below is the split of the newest reading; this is the trader. They answer
     * different questions and both are needed: draw the chain switches from this one, and
     * read `chains` for what the latest reading actually covered. `coverage` and each point's
     * `chainsAnswered` / `chainsTotal` are untouched.
     */
    knownChains: opts.knownChains ?? [],

    /**
     * `ready` — this is what we have to offer.
     * `warming` — a backfill or first sampling is still filling it.
     * `stale` — the readings are true but the sampler has not written for a while; see
     *   `sampler`. This never used to be said, and 432 of 435 answers claimed `ready` over
     *   figures three days old.
     */
    status: newestIsEmpty
      ? "no_reading"
      : (warming ? "warming" : (samplerState === "stale" ? "stale" : "ready")),

    /** When measurement last succeeded, and when it is next due. */
    sampler: samplerBlock,
    /**
     * HOW MUCH OF THE ASKED-FOR WINDOW IS ACTUALLY BEHIND THIS ANSWER, always.
     *
     * This used to be populated only while `warming`, so every settled answer served null --
     * and `window=all` therefore said nothing at all about what "all" meant. Measured: the ten
     * longest records run 1,131 to 1,685 days and `window=all` covers 35 or 36 of them, which
     * is the full extent of the stored readings rather than any statement about the trader.
     *
     * It is not a backfill that is missing. Balance history is rebuilt from stored
     * transactions, and for those ten traders the earliest transaction held is 5-11 September
     * -- there is nothing behind that date to rebuild from. So the honest answer is not a
     * promise that more is coming; it is to say what bounds the series and stop implying the
     * window covers a career.
     *
     * `boundedBy` is the load-bearing field: `window` means the answer covers what was asked,
     * `history` means the stored readings ran out first.
     */
    progress: {
      coveredDays,
      targetDays: requestedDays ?? coveredDays,
      /** Where the readings themselves begin, regardless of the window asked for. */
      historyStartsAt: trackedSince,
      boundedBy: requestedDays !== null && coveredDays >= requestedDays ? "window" : "history",
      /** Only meaningful while filling; null once the series is as long as it will get. */
      nextRunAt: warming ? nextRun.toISOString() : null,
      warming,
    },

    gaps,

    /**
     * WHY TWO NEIGHBOURING FIGURES MAY NOT BE SUBTRACTABLE, stated once for the series.
     *
     * `equalised: false` is the honest answer to "value both kinds the same way": a rebuilt
     * point and a sampled one price different fractions of the same wallet, and the per-token
     * history that would let us equalise them was never stored -- only per-chain totals were.
     * So the seam is MARKED rather than removed, and `breaks` below is where it is marked.
     */
    comparability: {
      equalised: false,
      reason: "coverage_differs_by_method",
      detail: "a rebuilt point prices about 39% of a chain's positions and a sampled one " +
              "77-84%, so the two count different fractions of the same wallet. Break the " +
              "line at every entry in `breaks` and do not measure a percentage across one.",
    },

    /**
     * EVERY SEAM, shaped like `gaps` because that is the list a chart already breaks on.
     *
     * A step appears here when the two figures do not count the same thing: the method
     * changed (`method_changed`), the set of answered chains changed (`chains_changed`), or
     * both. `chainsAdded` / `chainsRemoved` name which chains moved, so the step is
     * explicable rather than mysterious.
     *
     * `chains_changed` is the one a method marker alone would miss, and it is not rare:
     * measured over the last week across the whole directory, 226 of the 865 steps that move
     * a line by half or more keep the same method and change only the chain set.
     */
    breaks,
    points: pointsOut,
    chains: chainRows.map((r) => {
      const usd = round(n(r.total_usd));
      const nat = opts.natives?.get(Number(r.network_id)) ?? null;
      return {
        chain: r.chain as string,
        networkId: Number(r.network_id),
        totalUsd: usd,
        /**
       * Also a COUNT ratio, not a share of value -- the same fault as `valueShare` above, and
       * the consumer's own note names both. `pricedPositionShare` is the honest name; this
       * stays so nothing that reads it breaks.
       */
      pricedPositionShare: n(r.priced_share),
      /** @deprecated A count ratio, not a share of value. Read `pricedPositionShare`. */
      pricedShare: n(r.priced_share),
        /**
         * The same dollars in the chain's own coin. `nativeAmount` is `totalUsd / nativeUsd`
         * and nothing more, and the rate travels with it so the division can be rechecked.
         * Null, never 0, when we hold no market price for that coin -- see `whyNoNative`.
         */
        nativeSymbol: nat?.symbol ?? null,
        nativeUsd: nat?.usd ?? null,
        nativePriceSource: nat?.source ?? null,
        nativeAmount: nat?.usd && usd !== null
          ? Number((usd / nat.usd).toPrecision(10))
          : null,
        whyNoNative: nat?.usd && usd !== null ? null
          : usd === null ? "this chain carries no total at this reading"
          : "no market price for this chain's own coin — the only figures we hold for it are " +
            "traders' reported entry prices, which are not what it is worth now",
        ...(r.reason ? { reason: r.reason as string } : {}),
      };
    }),
    /** Non-null only when the NEWEST sample was refused; the reason names which wall we hit. */
    refused: newest?.refused_reason ?? null,
    plain: !newest
      ? "No balance samples for this trader yet — the sampler has not covered them."
      : newest.total_usd === null
      ? `The most recent reading was refused (${newest.refused_reason}), so there is no total for it. ` +
        `A partial total would read like a real drawdown.`
      : `${points.length} point${points.length === 1 ? "" : "s"} over ${windowKey} at ${declared.name} steps` +
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

  /*
   * THE CHAIN SPLIT OF EVERY POINT, not only the newest -- because the seam that breaks a
   * chart is a change in WHICH CHAINS a point could answer for, and nothing above can see it.
   *
   * unipcs measured 15.1M (5 chains, rebuilt), then 5.4M (4 chains, rebuilt, robinhood
   * missing), then 15.7M (3 chains, sampled). The middle step is a 64% fall that never
   * happened: the same trader, one chain short. Both points are rebuilt, so marking changes
   * of METHOD -- which is what the consumer asked for -- would not have caught it. Measured
   * over the last week across all 435 traders: 865 steps move the line by half or more, 542
   * change method, and 226 change only the chain set. A method marker alone misses a quarter
   * of them.
   *
   * Costed before adding: 5,979 rows for fifty traders in 188 ms against a table of 37,062.
   * Cheap enough to fetch outright rather than approximate.
   */
  const allChainRows = present.length
    ? await sql`
        select a.handle, a.at, a.basis, c.name as chain, a.total_usd
        from aum_chain_samples a
        join chains c using (network_id)
        where a.handle = any(${present})
        order by a.handle, a.at asc`
    : [];
  /** Window-independent chain list, one query for the whole batch. */
  const knownBy = await knownChainsFor(present);
  /** Cached for the process; five rows that barely move. */
  const natives = await nativePrices();

  /** handle -> "<iso at>|<basis>" -> [{ chain, usd }]. One map, built once for the batch. */
  const pointChainsBy = new Map<string, Map<string, { chain: string; usd: number | null }[]>>();
  for (const r of allChainRows) {
    const h = String(r.handle);
    let m = pointChainsBy.get(h); if (!m) pointChainsBy.set(h, m = new Map());
    const k = `${new Date(String(r.at)).toISOString()}|${r.basis}`;
    let a = m.get(k); if (!a) m.set(k, a = []);
    a.push({ chain: String(r.chain), usd: n(r.total_usd) });
  }

  /*
   * WHEN THE SAMPLER LAST SUCCEEDED, read once for the whole batch.
   *
   * The consumer measured every answer saying `ready` while the newest reading anywhere was
   * 75 hours old, and nothing in the response said so. Freshness has to travel WITH the
   * number rather than be reconstructed from dates by every caller.
   */
  const [samplerRow] = await sql`
    select max(at) as last_at, max(sampled_at) as last_success
    from aum_samples where basis = 'sampled'`;

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
      { ...opts, to, pointChains: pointChainsBy.get(h) ?? null,
        knownChains: knownBy.get(h) ?? [], natives, sampler: {
        lastAt: samplerRow?.last_at ? new Date(String(samplerRow.last_at)) : null,
        lastSuccess: samplerRow?.last_success ? new Date(String(samplerRow.last_success)) : null,
      } },
    ));
  }
  return out;
}

/**
 * READ-THROUGH REFRESH: when the stored reading is old, go and get a new one.
 *
 * Until now this route served whatever the sampler last wrote and nothing else, so a trader
 * nobody had sampled for a day answered with yesterday's money however many times you asked.
 * The `aum-sample` function can read his wallets in about eight seconds; the only reason not
 * to do it on every request is cost -- a popular trader viewed a hundred times would be a
 * hundred chain sweeps for one number.
 *
 * So it is a FLOOR, not a cache bypass. Older than `AUM_LIVE_AFTER_MINUTES` and the request
 * pays for a fresh read; newer and it serves what is already there. At five minutes that is
 * live for anyone watching and roughly free for everyone else, because the hundred viewers in
 * that window share one fetch.
 *
 * WHAT THIS COSTS, said plainly: this route can now make an external call, which no route
 * here could before. `/health` reports it under `externalCallsPerRequest` rather than leaving
 * the old claim standing -- that field was true of every route and must not quietly stop being
 * true of this one.
 *
 * Bounded three ways, because a slow chain must never become a slow API:
 *   - only the single-trader route, never the batch. Fifty traders is fifty sweeps.
 *   - `AUM_LIVE_WAIT_MS` caps the wait. Past it the request serves the stored reading and
 *     lets the sample finish in the background, so the NEXT caller gets it.
 *   - one in-flight fetch per trader per instance; concurrent callers wait on the same one.
 *
 * `?live=false` opts out entirely and `?live=true` forces a read regardless of age.
 */
const LIVE_AFTER_MS = Number(Deno.env.get("AUM_LIVE_AFTER_MINUTES") ?? 5) * 60_000;
/*
 * SHORT ON PURPOSE. The route's own budget is 15s and its query work is 4-6s, so a nine
 * second wait measured 14.0s end to end -- inside the limit and far too close to it. A big
 * trader takes about eight seconds to sample and was never going to finish inside the wait
 * anyway; a small one finishes in one or two. So the wait is sized for the traders it can
 * actually catch, and everyone else is served the stored reading with `still_running` and
 * gets the fresh one on their next call a moment later.
 */
const LIVE_WAIT_MS = Number(Deno.env.get("AUM_LIVE_WAIT_MS") ?? 3_000);
const SAMPLE_URL = (Deno.env.get("AUM_SAMPLE_URL") ?? "").trim();
const SAMPLE_SECRET = (Deno.env.get("AUM_SAMPLE_SECRET") ?? "").trim();
/** Per instance. Edge Functions scale out, so this thins the stampede rather than ending it. */
const inFlight = new Map<string, Promise<void>>();

/** True when a live read is configured and possible at all. */
const liveReadable = () => SAMPLE_URL !== "" && SAMPLE_SECRET !== "";

async function refreshNow(handle: string): Promise<void> {
  const running = inFlight.get(handle);
  if (running) return running;
  const task = (async () => {
    try {
      const r = await fetch(SAMPLE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-sample-secret": SAMPLE_SECRET },
        body: JSON.stringify({ handle }),
        /* Its own ceiling, above our wait, so a fetch we stopped waiting for still completes. */
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) console.error(`aum live refresh ${handle}: HTTP ${r.status}`);
    } catch (e) {
      /*
       * A failed refresh is NOT a failed request. The stored reading is still a true reading
       * of an earlier moment, and `now.ageSeconds` already says how old it is -- serving that
       * is strictly better than turning a slow chain into a 500.
       */
      console.error(`aum live refresh ${handle}: ${(e as Error).message}`);
    } finally {
      inFlight.delete(handle);
    }
  })();
  inFlight.set(handle, task);
  return task;
}

get("/v1/traders/:handle/aum", async ({ handle }, url) => {
  const h = await resolveTrader(handle);
  const { windowKey, stepRaw, chainKey } = aumOptions(url);
  const chainFilter = await resolveChain(chainKey);

  const liveParam = (url.searchParams.get("live") ?? "").trim().toLowerCase();
  let refreshed: string | null = null;

  if (liveParam !== "false" && liveReadable()) {
    /*
     * AGE IS MEASURED FROM `sampled_at`, NOT `at`, and the difference is the whole feature.
     *
     * `at` is the HOUR the reading describes -- truncated, so a sample taken at 06:44 is
     * stamped 06:00 and reads as forty-four minutes old the moment it is written. Checking
     * that against a five minute floor meant every request re-fetched a reading taken
     * seconds earlier, which is not a freshness floor at all, just a slow route. Measured
     * exactly that way before this line was fixed: `ageSeconds 2651` on a sample a minute old.
     *
     * `sampled_at` is when we actually read the chain, which is the only thing "how fresh is
     * this" can honestly mean.
     */
    const [newest] = await sql`
      select max(sampled_at) as at from aum_samples
      where handle = ${h} and basis = 'sampled' and total_usd is not null`;
    const ageMs = newest?.at ? Date.now() - Date.parse(String(newest.at)) : Infinity;
    if (liveParam === "true" || ageMs > LIVE_AFTER_MS) {
      const fetching = refreshNow(h);
      /*
       * Wait, but not forever. Whichever finishes first decides what this caller gets, and
       * either way the sample completes and the next caller is served from it.
       */
      const won = await Promise.race([
        fetching.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), LIVE_WAIT_MS)),
      ]);
      refreshed = won ? "fetched" : "still_running";
    } else {
      refreshed = "not_needed";
    }
  } else if (liveParam === "false") {
    refreshed = "skipped";
  } else if (!liveReadable()) {
    refreshed = "unavailable";
  }

  const got = await aumFor([h], { windowKey, stepRaw, chainFilter });
  const envelope = got.get(h);
  if (!envelope) throw notFound(`no trader '${handle}' in the directory`);
  return {
    ...envelope,
    /**
     * WHAT THIS REQUEST DID ABOUT FRESHNESS, so `now.ageSeconds` can be read in context.
     *
     * `fetched` — a live read finished and `now` is from it.
     * `still_running` — one was started and outlasted our wait; this answer is the previous
     *   reading and the next request will have the new one.
     * `not_needed` — the stored reading is inside the freshness floor.
     * `skipped` — the caller passed `live=false`.
     * `unavailable` — no live read is configured on this deployment.
     */
    liveRead: {
      state: refreshed,
      freshnessFloorMinutes: LIVE_AFTER_MS / 60_000,
      waitedMs: refreshed === "fetched" || refreshed === "still_running" ? LIVE_WAIT_MS : null,
    },
  };
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
  const until = url.searchParams.get("until");
  /*
   * `status` filters on the PAIRING below, not on a stored column: a swap is a swap, and
   * whether it is still open is a fact about what happened afterwards.
   */
  const statusQ = (url.searchParams.get("status") ?? "").trim().toLowerCase() || null;
  if (statusQ !== null && statusQ !== "open" && statusQ !== "closed") {
    throw badRequest("'status' must be 'open' or 'closed'", { parameter: "status" });
  }

  /*
   * KEYSET PAGING, so a whole record can be read rather than its first 100 rows.
   *
   * The sort key is (block_time desc, tx_hash), and the cursor carries exactly that pair.
   * An offset would drift as new swaps arrive at the head; a keyset cannot.
   */
  const cursorRaw = url.searchParams.get("cursor");
  const cur = cursorRaw ? decodeCursor(cursorRaw) : null;
  const curAt = cur ? String(cur[0]) : null;
  const curHash = cur ? String(cur[1]) : null;

  /*
   * EVERY SWAP THIS TRADER MADE, for the pairing -- not just the page.
   *
   * A sell cannot be matched to its buy from one page: the buy may be a year and nine pages
   * away. The whole set is small enough to walk in memory (3,629 rows across 122 wallets,
   * 29.7 per wallet on average and 525 at the worst), so it is fetched once and paired once.
   */
  const [rows, allSwaps] = addrs.length
    ? await Promise.all([
      sql`
      select ws.tx_hash, ws.block_time, ws.network_id, c.name as chain,
             ws.token_key, tk.address as token_address,
             coalesce(ti.symbol, tk.symbol) as token_symbol,
             ws.token_delta, ws.quote_key, ws.quote_delta, ws.quote_usd,
             qa.symbol as quote_symbol, ws.address_key, ws.resolved_at
      from wallet_swaps ws
      join chains c using (network_id)
      left join tokens tk on tk.network_id = ws.network_id and tk.token_key = ws.token_key
      left join token_info ti on ti.network_id = ws.network_id and ti.token_key = ws.token_key
      left join quote_assets qa on qa.network_id = ws.network_id and qa.token_key = ws.quote_key
      where ws.address_key = any(${addrs})
        and (${chainQ}::text is null or c.name = ${chainQ})
        and (${since}::timestamptz is null or ws.block_time >= ${since}::timestamptz)
        and (${until}::timestamptz is null or ws.block_time <= ${until}::timestamptz)
        and (${curAt}::timestamptz is null
             or ws.block_time < ${curAt}::timestamptz
             or (ws.block_time = ${curAt}::timestamptz and ws.tx_hash > ${curHash}))
      order by ws.block_time desc nulls last, ws.tx_hash
      limit ${limit + 1}`,
      sql`
      select ws.tx_hash, ws.block_time, ws.network_id, ws.address_key,
             ws.token_key, ws.token_delta, c.name as chain
      from wallet_swaps ws
      join chains c using (network_id)
      where ws.address_key = any(${addrs})
      order by ws.block_time asc, ws.tx_hash`,
    ])
    : [[], []];

  /*
   * FIFO PAIRING: each sell consumes the oldest buy still holding quantity.
   *
   * This is what turns a list of swaps into round trips -- "in and out under five seconds",
   * "still open when our copy landed", and a holding time per trade rather than per coin.
   * FIFO because it is the convention a reader assumes and the only one we can defend
   * without knowing the trader's own accounting.
   *
   * A lot is identified by the tx that opened it, so a round-trip id is stable and points at
   * something a consumer can look up on a block explorer.
   */
  /** `key` is the pairing entry this lot's own buy wrote, so closing it is O(1). */
  type Lot = { id: string; key: string; at: number; left: number };
  const openLots = new Map<string, Lot[]>();
  /** tx_hash + token_key -> what the pairing found for that swap. */
  const pairing = new Map<string, {
    positionId: string | null; status: string;
    openedAt: number | null; closedAt: number | null;
  }>();
  const keyOfSwap = (r: Record<string, unknown>) =>
    `${r.tx_hash}|${r.network_id}|${r.token_key}`;

  for (const r of allSwaps as Record<string, unknown>[]) {
    const lotKey = `${r.address_key}|${r.network_id}|${r.token_key}`;
    const at = r.block_time ? Date.parse(String(r.block_time)) : NaN;
    const delta = n(r.token_delta) ?? 0;
    if (!Number.isFinite(at) || delta === 0) continue;
    let q = openLots.get(lotKey); if (!q) openLots.set(lotKey, q = []);

    if (delta > 0) {
      const id = String(r.tx_hash);
      const key = keyOfSwap(r);
      q.push({ id, key, at, left: delta });
      pairing.set(key, { positionId: id, status: "open", openedAt: at, closedAt: null });
    } else {
      let need = -delta;
      let firstOpenedAt: number | null = null;
      let firstId: string | null = null;
      while (need > 0 && q.length) {
        const lot = q[0];
        if (firstOpenedAt === null) { firstOpenedAt = lot.at; firstId = lot.id; }
        const take = Math.min(lot.left, need);
        lot.left -= take; need -= take;
        if (lot.left <= 1e-12) {
          // That buy is now fully sold, and this is the sell that finished it.
          const done = q.shift()!;
          const b = pairing.get(done.key);
          if (b) pairing.set(done.key, { ...b, status: "closed", closedAt: at });
        }
      }
      pairing.set(keyOfSwap(r), {
        positionId: firstId,
        status: "closed",
        openedAt: firstOpenedAt,
        closedAt: at,
      });
    }
  }

  /*
   * The fee each row's transaction paid. A row here IS a transaction, so unlike a stored
   * position it can carry one. Looked up for the page only -- at most 500 hashes.
   */
  const pageHashes = rows.map((r: Record<string, unknown>) => String(r.tx_hash));
  const [feeRows, feeNatives] = pageHashes.length
    ? await Promise.all([
      sql`select network_id, tx_hash, fee_native, fee_native_symbol
          from transaction_fees
          where tx_hash = any(${pageHashes})`,
      nativePrices(),
    ])
    : [[], new Map<number, NativePrice>()];
  const feeBy = new Map<string, { native: number; symbol: string; net: number }>();
  for (const f of feeRows) {
    const v = n(f.fee_native);
    if (v === null) continue;
    feeBy.set(`${Number(f.network_id)}|${f.tx_hash}`,
      { native: v, symbol: String(f.fee_native_symbol), net: Number(f.network_id) });
  }

  const capped = rows.length > limit;
  /*
   * `pageRaw` is the page as the database returned it; `page` is what survives `?status=`.
   *
   * The cursor is taken from `pageRaw` and never from `page`. Filtering happens after paging
   * -- the pairing that decides open-versus-closed is not a stored column, so the database
   * cannot do it -- and a page whose rows are all filtered out would otherwise produce a null
   * cursor and stop the caller dead while rows remained. A sparse page is fine; a lost tail
   * is not.
   */
  const pageRaw = capped ? rows.slice(0, limit) : rows;
  const page = statusQ === null
    ? pageRaw
    : pageRaw.filter((r: Record<string, unknown>) =>
      (pairing.get(keyOfSwap(r))?.status ?? null) === statusQ);

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
    /**
     * The newest trade we hold for this trader under the filters asked for. Every route carries
     * an `asOf` so a caller can age the answer without knowing how the answer was produced.
     */
    asOf: page.length && page[0].block_time
      ? new Date(String(page[0].block_time)).toISOString() : null,
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
        /**
         * THE ROUND TRIP THIS SWAP BELONGS TO, from FIFO over the trader's whole record.
         *
         * `positionId` is the transaction that OPENED the lot, so it is stable and points at
         * something a consumer can look up. On a buy, `status` is `open` until a later sell
         * finishes consuming it. On a sell, `openedAt` is when the quantity it sold was
         * bought, which is what "in and out under five seconds" measures.
         *
         * Null on a sell with nothing left to match -- a wallet whose earlier buys predate
         * what we hold. That is a gap in our record, not a trade from nowhere.
         */
        ...(() => {
          const pr = pairing.get(`${r.tx_hash}|${r.network_id}|${r.token_key}`) ?? null;
          const openedAt = pr?.openedAt ?? null;
          const closedAt = pr?.closedAt ?? null;
          return {
            positionId: pr?.positionId ?? null,
            status: pr?.status ?? null,
            openedAt: openedAt === null ? null : new Date(openedAt).toISOString(),
            closedAt: closedAt === null ? null : new Date(closedAt).toISOString(),
            holdSeconds: openedAt !== null && closedAt !== null
              ? Math.max(0, Math.round((closedAt - openedAt) / 1000)) : null,
            whyNoPosition: pr?.positionId ? null
              : "no buy we hold matches this sell — the wallet's earlier buys predate our " +
                "record of it",
          };
        })(),
        /** Where the row came from and how far to trust it, per row rather than per answer. */
        source: "helius rpc pre/post balances",
        confidence: usd !== null ? "high" : "medium",
        /**
         * WHAT THIS TRADE COST TO MAKE.
         *
         * `feeNative` is the measurement and is exact -- gas_used x effective_gas_price from
         * the receipt on the EVM chains, meta.fee on Solana. `feeUsd` values it at the
         * CURRENT native price, because we hold no historical one; it is an approximation and
         * `feeUsdBasis` says so. Null, never 0: a trade is never free, so a missing fee is a
         * gap in our reading, not a costless trade.
         */
        ...(() => {
          const f = feeBy.get(`${Number(r.network_id)}|${r.tx_hash}`) ?? null;
          const px = f ? (feeNatives.get(f.net)?.usd ?? null) : null;
          return {
            feeNative: f?.native ?? null,
            feeNativeSymbol: f?.symbol ?? null,
            feeUsd: f && px ? feeUsd(f.native * px) : null,
            feeUsdBasis: f && px
              ? "native fee valued at the current native price, not the price when it was paid"
              : null,
            whyNoFee: f
              ? (px ? null : "no market price for this chain's own coin, so the fee cannot be " +
                             "stated in dollars — `feeNative` is exact")
              : "no fee has been read for this transaction yet",
          };
        })(),
      };
    }),
    /**
     * `null` on the last page. A full page only HINTS that more exist — if exactly `limit`
     * rows remain, the next call returns empty, which is correct and costs one cheap query
     * rather than a count on every request.
     */
    nextCursor: capped && pageRaw.length
      ? encodeCursor([
        new Date(String(pageRaw[pageRaw.length - 1].block_time)).toISOString(),
        String(pageRaw[pageRaw.length - 1].tx_hash),
      ])
      : null,
    complete: !capped,
    /**
     * How many rows the page held before `?status=` was applied. With a status filter, `count`
     * can be 0 while `nextCursor` is non-null -- that is a sparse page, not the end. Keep
     * following the cursor until it is null.
     */
    ...(statusQ !== null ? { scanned: pageRaw.length, status: statusQ } : {}),
    /**
     * What is NOT here. §4 asks for every chain; we resolve Solana. Saying which chains a
     * trader trades on but we cannot serve is the difference between a gap and a lie.
     */
    coverage: {
      chainsResolved: [...resolvedChains],
      chainsTradedButUnresolved: presence
        .map((p: any) => p.chain as string)
        .filter((c: string) => !resolvedChains.has(c)),
      /**
       * PER CHAIN, so "he made no trades there" and "we have not read that chain" stop
       * looking identical.
       *
       * `unresolved` means we hold no swaps for that chain at all though the trader is known
       * to trade on it -- the honest state for the four EVM chains today. `complete` means we
       * hold swaps and `from`/`to` say which span they cover, so a caller asking for last
       * week can tell whether last week was even read.
       */
      byChain: (() => {
        const span = new Map<string, { from: number; to: number; rows: number }>();
        for (const r of allSwaps as Record<string, unknown>[]) {
          const netName = r.chain ? String(r.chain) : null;
          if (!netName) continue;
          const at = r.block_time ? Date.parse(String(r.block_time)) : NaN;
          if (!Number.isFinite(at)) continue;
          const cur = span.get(netName);
          if (!cur) span.set(netName, { from: at, to: at, rows: 1 });
          else { cur.from = Math.min(cur.from, at); cur.to = Math.max(cur.to, at); cur.rows++; }
        }
        const named = new Set<string>([
          ...span.keys(),
          ...presence.map((p: any) => String(p.chain)),
        ]);
        return [...named].sort().map((chain) => {
          const sp = span.get(chain) ?? null;
          return {
            chain,
            state: sp === null ? "unresolved" : "complete",
            from: sp ? new Date(sp.from).toISOString() : null,
            to: sp ? new Date(sp.to).toISOString() : null,
            swaps: sp?.rows ?? 0,
            why: sp === null
              ? "this trader trades here but we hold no resolved swaps for this chain"
              : null,
          };
        });
      })(),
      why: "swaps are resolved from chain on Solana and on bsc, base and ethereum. A wallet " +
           "appears in far more transactions than it trades in — measured on a random " +
           "sample, 5 in 6 are the wallet receiving tokens inside someone else's trade — so " +
           "a chain with no rows here is one where we resolved none of this wallet's own " +
           "trades, not one where it made none",
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
  let handles = wanted.map((k) => {
    const bare = k.trim().replace(/^trd_/, "").toLowerCase();
    return byId.get(bare) ?? k.trim().toLowerCase();
  });

  /*
   * THE `display_handle` FALLBACK, which the single routes have had and this one did not.
   *
   * resolveTrader() tries the stored handle, then `display_handle`, because for one trader
   * they differ: `yeon__ (gmgn)` is published under that name and stored as `gmgn_yeon__`.
   * Lowercasing the published name therefore matched nothing here, so the SAME trader
   * answered 200 with a full envelope on /traders/:handle/aum and `not_found` in the batch.
   * One trader of 448, resolvable by id, and the only one whose two routes disagreed about
   * whether he exists -- which is precisely the failure the batch contract forbids.
   *
   * Only the handles that missed are looked up, so the ordinary batch pays nothing: the
   * query runs at all only when a name did not match a stored handle.
   */
  const missed = [...new Set(handles)];
  if (missed.length) {
    const known = await sql`
      select handle from traders where handle = any(${missed})`;
    const have = new Set(known.map((r) => String(r.handle)));
    const unknown = missed.filter((h) => !have.has(h));
    if (unknown.length) {
      const byDisplay = await sql`
        select lower(display_handle) as display, handle from traders
         where lower(display_handle) = any(${unknown})`;
      if (byDisplay.length) {
        const dmap = new Map(byDisplay.map((r) => [String(r.display), String(r.handle)]));
        handles = handles.map((h) => dmap.get(h) ?? h);
      }
    }
  }

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

const batchEnvelope = (asked: number, capped: boolean, asOf: string | null = null) => ({
  limit: BATCH_MAX,
  asked,
  /** True when the caller sent more than the cap; the extras were NOT read. */
  capped,
  /**
   * When the data behind this batch was taken. The batch routes had no `asOf` while every
   * individual route had one, so a consumer reading fifty traders at once could not date the
   * answer without calling a route it was trying to avoid.
   */
  asOf,
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
  /*
   * THE FULL ENVELOPE IS THE DEFAULT. `contractVersion: 1` opts back into the short shape.
   *
   * The short projection omits the per-row `ok` / `requested` / `id` and the explicit
   * not-found refusal, so an id that could not be resolved is indistinguishable from a trader
   * with no data. A consumer's bulk pass is the one place that shape does the most damage --
   * measured on the sibling route, 435 of 435 warmed traders were stored chainless, while the
   * same trader spot-checked one at a time carried five chains. Defaulting to the complete
   * answer means a caller has to ASK for the lossy one rather than discover it.
   */
  const v2 = Number((body as { contractVersion?: number })?.contractVersion) !== 1;

  const rows = await sql`
    select h.handle, ch.name as chain, h.network_id, h.token_key,
           tk.address as token_address,
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

  /*
   * The newest balance read across the traders asked for -- taken from the rows already in
   * hand rather than from a second query, so dating the batch costs nothing.
   */
  const positionsAsOf = rows.reduce<string | null>((best, r) => {
    if (!r.captured_at) return best;
    const at = new Date(String(r.captured_at)).toISOString();
    return best === null || at > best ? at : best;
  }, null);

  /** Same cost basis the individual route serves, from the same function. */
  const costByHandle = await costBasisFor(handles);

  const position = (r: Record<string, unknown>) => ({
    chain: r.chain, networkId: Number(r.network_id),
    tokenAddress: r.token_address, symbol: r.symbol,
    amount: n(r.human_amount),
    ...costBlock(
      costByHandle.get(String(r.handle))?.get(`${Number(r.network_id)}:${r.token_key}`),
      n(r.human_amount), n(r.price)),
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
      ...batchEnvelope(asked, capped, positionsAsOf),
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
    ...batchEnvelope(asked, capped, positionsAsOf),
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
  /* Same aliases as the individual route, from the same table, so the two cannot disagree. */
  const askedWindow = (b?.window ?? "1w").trim();
  const windowKey = resolveWindow(askedWindow);
  if (windowKey === null) {
    throw badRequest(
      `'window' must be one of ${Object.keys(AUM_WINDOWS).join(", ")} — got '${askedWindow}'. ` +
      `Also accepted: ${Object.keys(WINDOW_ALIASES).join(", ")}, in any case.`,
      { parameter: "window" });
  }
  const stepRaw = typeof b?.step === "string" ? b.step : null;
  if (stepRaw !== null &&
      !AUM_STEPS.some((s) => s.name === stepRaw.trim().toLowerCase())) {
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

  /*
   * The newest reading anywhere in this batch. Each trader carries his own `now.at`; this is
   * the one date for the answer as a whole, and matches what the individual route reports for
   * the freshest trader in the list.
   */
  const batchAsOf = [...envelopes.values()].reduce<string | null>((best, e) => {
    const at = e.asOf ?? null;
    return at !== null && (best === null || at > best) ? at : best;
  }, null);

  /*
   * THE FULL ENVELOPE IS THE DEFAULT here too, for the reason above and one measurement:
   * without it this route answers a handle, a count, a newest figure and the points, and
   * nothing else -- no chains, no reach, no status, no drawable decision. Every consumer's
   * bulk pass uses this route, so that shape became the stored copy of the world.
   *
   * `contractVersion: 1` still returns the old projection, unchanged, for anyone parsing it.
   */
  if (Number(b?.contractVersion) !== 1) {
    const idRows = await sql`
      select handle, id from traders where handle = any(${handles})`;
    const idBy = new Map(idRows.map((r) => [String(r.handle), r.id ? String(r.id) : null]));

    const rowsOut = requested.map((req, i) => {
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
    });

    return {
      contractVersion: 2,
      ...batchEnvelope(asked, capped, batchAsOf),
      window: windowKey,
      /** Null when the batch asked for the whole portfolio; a name when it named a chain. */
      chain: chainFilter ? chainFilter.name : null,
      /**
       * THE IDS WE COULD NOT ANSWER FOR, gathered under the name the consumer looks for.
       *
       * Every asked id has always appeared in `traders[]` -- a failure as an `ok: false` row
       * carrying its own error, which is what stops a dropped row looking like a trader with
       * no data. But their contract reads `unreadableRows[]`, and a consumer checking that key
       * found nothing and concluded every id had answered.
       *
       * Same rows, listed twice on purpose: `traders[]` keeps one entry per requested id in
       * the order asked, and this is the subset that failed. Empty is the healthy state.
       */
      unreadableRows: rowsOut.filter((r) => !r.ok).map((r) => ({
        requested: r.requested,
        error: (r as { error?: unknown }).error,
      })),
      /*
       * EXACTLY ONE ROW PER REQUESTED ID, INCLUDING THE ONES THAT FAILED. An omitted row is
       * indistinguishable from a trader with no data, so an id we could not resolve comes
       * back as an explicit refusal rather than a hole in the list.
       */
      traders: rowsOut,
    };
  }

  // ---- the pre-version-2 projection, unchanged so existing consumers keep working
  return {
    ...batchEnvelope(asked, capped, batchAsOf),
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

// ------------------------------------------------------------------ fields

/**
 * WHAT EVERY FIELD MEANS, WHAT IT CAN SAY, AND HOW OFTEN IT SAYS ANYTHING.
 *
 * Three questions a consumer has had to answer by observation, one refusal and one empty
 * screen at a time:
 *
 *   1. Which words can this field hold?  Every enumerated value was discovered the hard way --
 *      `chains_unrebuildable`, `too_little_priced`, `no_chains_answered` each arrived as an
 *      unexplained blank on somebody's screen first. Four more break reasons appeared between
 *      one report and the next. A word nobody published is a word with no sentence behind it.
 *   2. What unit is this in?  A unit change under a stable name is undetectable and
 *      catastrophic: every figure stays plausible and every one is wrong by a thousand.
 *   3. Is this field actually populated?  Every screen built on a field that turned out to be
 *      mostly empty was built because a spot check of two or three traders showed it filled.
 *      An entry-size figure good enough to rank on existed for 11 of 144 traders, and that was
 *      discovered after shipping.
 *
 * The fill rates are counted live over the whole directory, not sampled -- 227ms measured, so
 * it costs about what /health does.
 */
get("/v1/fields", async () => {
  const [f] = await sql`
    with sc as (
      select t.handle,
        count(*) filter (where t.status = 'closed')::int as closed,
        count(*) filter (where t.status = 'closed' and t.realized_pnl_usd is not null)::int as realized,
        count(*) filter (where t.avg_entry_price is not null and t.avg_entry_price > 0)::int as entry_px,
        count(distinct to_char(t.closed_at, 'YYYY-MM')) filter (where t.status = 'closed')::int as months,
        count(*) filter (where t.status <> 'closed' and t.unrealized_pnl_usd is not null)::int as unreal
      from trades t group by t.handle),
    w as (select handle from wallets where evm_address is not null or sol_address is not null),
    a as (select handle, count(*) filter (where total_usd is not null)::int as pts
          from aum_samples group by handle)
    select
      (select count(*) from traders)::int                                as traders,
      (select count(*) from w)::int                                      as with_wallet,
      (select count(*) from sc where closed > 0)::int                    as with_closed,
      (select count(*) from sc where realized > 0)::int                  as with_realized,
      (select count(*) from sc where closed > 0 and realized = closed)::int as realized_complete,
      (select count(*) from sc where entry_px > 0)::int                  as with_entry_px,
      (select count(*) from sc where entry_px >= 20)::int                as entry_px_20,
      (select count(*) from sc where months >= 3)::int                   as months_3,
      (select count(*) from sc where unreal > 0)::int                    as with_unrealized,
      (select count(*) from a where pts > 0)::int                        as with_reading`;

  const N = Number(f.traders);
  const rate = (of: unknown, why: string | null = null) => ({
    of: Number(of), total: N, share: N ? Number((Number(of) / N).toFixed(4)) : null,
    commonestAbsence: why,
  });

  return {
    board: "fields",
    asOf: new Date().toISOString(),
    traders: N,

    /**
     * EVERY ENUMERATED FIELD, AND ITS COMPLETE SET.
     *
     * `closed: true` means this is the whole set and a value outside it is a bug, not a new
     * feature. Adding a word bumps `version` and is a release note.
     */
    vocabulary: {
      closed: true,
      version: 1,
      fields: {
        "aum.status": ["ready", "warming", "stale", "no_reading"],
        "aum.points[].basis": ["sampled", "rebuilt"],
        "aum.points[].tier": ["verified", "reported"],
        "aum.points[].refused": ["too_little_priced", "nothing_answered", "chains_unrebuildable",
                                 "no_prices", "wallet_unreadable"],
        "aum.gaps[].reason": ["too_little_priced", "nothing_answered", "chains_unrebuildable",
                              "no_prices", "wallet_unreadable"],
        /* gaps[] now carries `from` and `to` as well as `at` — the span, not just the moment. */
        "aum.breaks[].reason": ["chains_changed", "method_changed", "priced_share_changed",
                                "method_and_chains_changed", "method_and_priced_share_changed",
                                "chains_and_priced_share_changed",
                                "method_and_chains_and_priced_share_changed"],
        "aum.drawing.reason": ["too_few_points", "nothing_answered", "warming", "short_coverage"],
        "aum.chains[].reason": ["no_prices"],
        /* `none` is a chain we know he uses and hold no balance history for at all. */
        "aum.knownChains[].historyState": ["ready", "warming", "none"],
        "aum.sampler.state": ["current", "stale", "warming"],
        "aum.coverage.partialReason": ["chains_missing", "unpriced_positions",
                                       "chains_missing_and_unpriced_positions"],
        "aum.progress.boundedBy": ["window", "history"],
        /* What this request did about freshness before answering. See the /aum route. */
        "aum.liveRead.state": ["fetched", "still_running", "not_needed", "skipped",
                               "unavailable"],
        "wallets.walletState": ["on_record", "unresolved_upstream"],
        "traders.delisted.reason": ["absent_from_source"],
        "aum.comparability.reason": ["coverage_differs_by_method"],
        "scorecard.winRateBasis": ["closed_positions_with_realized_figure"],
        /* Why a named figure is null. `not_applicable` means the question does not arise. */
        "scorecard.fieldReasons.*": ["not_applicable", "historical_input_missing",
                                     "not_yet_calculated", "no_realized_figure",
                                     "no_winning_trade", "sign_discipline_not_both_positive",
                                     "source_unavailable"],
        "scorecard.staleness.state": ["current", "stale", "never"],
        "scorecard.meanToMedianBasis": ["per_token"],
        "pnl.realizedShareReason": ["no_trades_on_record", "nothing_banked_or_on_paper",
                                    "sign_discipline_not_both_positive"],
        "health.feeds.*.state": ["current", "stale", "never"],
        "health.dataState": ["current", "degraded"],
        "error.code": ["not_found", "bad_request", "duplicate_identifier", "rate_limited",
                       "timeout", "internal",
                       /* POST /traders/:handle/wallets — see that route. */
                       "not_configured", "unauthorized", "invalid_address", "address_in_use",
                       "already_on_record"],
        "walletSubmission.pricing.state": ["pending_first_read"],
      },
    },

    /**
     * THE UNIT OF EVERY QUANTITY, by naming convention.
     *
     * The suffix IS the unit and always has been; publishing it is what makes that a contract
     * rather than a habit. A unit change gets a NEW FIELD NAME -- never a new meaning under
     * the old one, because that is the one change no test and no screen can detect.
     */
    units: {
      "*Usd": "United States dollars, as a number. Never cents, never a string",
      "*Native": "the chain's own coin, exact, at full precision",
      "*Share": "a ratio from 0 to 1 inclusive. Never a percentage",
      "pricedPositionShare": "priced positions divided by total positions, 0 to 1 — a COUNT " +
        "ratio, not a share of value. The value of an unpriced position is unknowable, so no " +
        "true value share exists. `valueShare` and `pricedShare` are the same number under " +
        "older names that misdescribe it",
      "winRate": "a ratio from 0 to 1 inclusive",
      "*Pct": "a percentage from 0 to 100. The only quantities on that scale",
      "*Ms": "milliseconds, integer",
      "*Seconds": "seconds, integer",
      "*Hours": "hours, may be fractional",
      "*Days": "days, may be fractional",
      "*At / *From / *To / *Since": "ISO-8601 with an explicit Z. Never epoch seconds",
      "day": "a calendar date, YYYY-MM-DD",
      "month": "a calendar month, YYYY-MM",
      "coverage{of,total,share}": "counts as integers; share is of/total from 0 to 1",
      note: "absence is always null. Zero is a claim and null is an absence — no string ever " +
            "stands in for a missing number, and no number for a missing fact",
    },

    /**
     * HOW MUCH OF THE DIRECTORY ACTUALLY CARRIES EACH FIELD.
     *
     * Counted over every trader, every time this is called. A field below a rate you are
     * willing to build a screen on is one to treat as not generally available.
     */
    fillRates: {
      "wallets.evmAddress or solanaAddress":
        rate(f.with_wallet, "no wallet has been resolved for this trader"),
      "aum.now.totalUsd (any reading at all)":
        rate(f.with_reading, "the sampler has not reached this trader yet"),
      "scorecard.winRate / wins / losses":
        rate(f.with_realized, "no closed position carries a realized figure"),
      "scorecard.winRate over a COMPLETE record":
        rate(f.realized_complete,
             "some closed positions carry no realized figure, so winRateCoverage.of is " +
             "below closedTrades — see winRateBasis"),
      "scorecard.windows[].closedTrades":
        rate(f.with_closed, "no position has closed on record"),
      "scorecard.entryPriceCoverage (any priced token)":
        rate(f.with_entry_px, "no position carries an entry price"),
      "scorecard.entryPriceCoverage (20+, enough to rank on)":
        rate(f.entry_px_20, "fewer than twenty tokens carry an entry price"),
      "scorecard.realizedByMonth (3+ months)":
        rate(f.months_3, "the record does not span three calendar months of closes"),
      "pnl.onPaperUsd":
        rate(f.with_unrealized, "no open position carries an unrealized figure"),
    },

    plain: "Every enumerated field with its complete set, every quantity with its unit, and " +
           "how much of the directory carries each field. Counted live, not sampled.",
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

// ----------------------------------------------------------------- wallets

/**
 * EVERY CHAIN A TRADER USES, independent of any window or any single reading.
 *
 * `aum.chains` lists the chains in the NEWEST reading, which is a fact about that reading and
 * not about the trader -- it showed Solana alone for a trader whose portfolio spans five. A
 * consumer drawing chain switches from it offered 128 of 435 traders fewer switches than the
 * service itself says they use.
 *
 * So the list is built from every place a chain can be evidenced, unioned:
 *   - a chain his wallets have been SEEN trading on (wallet_chain_presence)
 *   - a chain he currently HOLDS something on (holdings_current)
 *   - a chain we hold BALANCE HISTORY for (aum_chain_samples)
 *
 * Set-based over every handle at once, so the batch routes pay one query rather than fifty:
 * measured 116 ms for fifty traders.
 */
type KnownChain = {
  chain: string; networkId: number; wallets: number;
  hasPositions: boolean; historyState: string;
};

async function knownChainsFor(handles: string[]): Promise<Map<string, KnownChain[]>> {
  const out = new Map<string, KnownChain[]>();
  if (!handles.length) return out;

  const rows = await sql`
    with hs as (
      select handle, network_id, count(*) filter (where human_amount > 0) as pos
      from holdings_current where handle = any(${handles}) group by 1, 2),
    ah as (
      select handle, network_id, count(*) filter (where total_usd is not null) as pts
      from aum_chain_samples where handle = any(${handles}) group by 1, 2),
    pr as (
      select handle, network_id from wallet_chain_presence where handle = any(${handles})),
    seen as (
      select handle, network_id from pr
      union select handle, network_id from hs where pos > 0
      union select handle, network_id from ah),
    fam as (
      select t.handle,
             (w.sol_address is not null) as has_sol,
             (w.evm_address is not null) as has_evm
      from traders t left join wallets w using (handle)
      where t.handle = any(${handles}))
    select s.handle, c.name as chain, s.network_id,
           coalesce(hs.pos, 0) as positions,
           coalesce(ah.pts, 0) as history_points,
           case when s.network_id = ${SOLANA_NET} then fam.has_sol else fam.has_evm end
             as has_wallet
    from seen s
    join chains c using (network_id)
    join fam on fam.handle = s.handle
    left join hs on hs.handle = s.handle and hs.network_id = s.network_id
    left join ah on ah.handle = s.handle and ah.network_id = s.network_id
    order by s.handle, c.name`;

  for (const r of rows) {
    const h = String(r.handle);
    let a = out.get(h); if (!a) out.set(h, a = []);
    const pts = Number(r.history_points);
    a.push({
      chain: String(r.chain),
      networkId: Number(r.network_id),
      /*
       * One Ethereum-style address serves four chains, so this is 1 whenever the family that
       * reaches this chain is on record, and 0 when the chain is evidenced but the address
       * behind it is not -- which is a real state and worth seeing rather than assuming.
       */
      wallets: r.has_wallet === true ? 1 : 0,
      hasPositions: Number(r.positions) > 0,
      /*
       * Whether this chain can be drawn on its own, by the same two-point rule the series
       * uses. `none` is not `warming`: one has never produced a reading, the other has.
       */
      historyState: pts >= 2 ? "ready" : (pts === 1 ? "warming" : "none"),
    });
  }
  return out;
}

/** Wallet rows for many traders at once, for the ISSUE-8 bulk route. */
const walletRows = (handles: string[]) => sql`
  select t.handle, t.id, t.display_handle, t.handle_changed_at, t.source,
         t.name, t.bio, t.avatar, t.twitter,
         w.evm_address, w.sol_address, w.evm_source, w.sol_source,
         w.evm_confidence, w.sol_confidence, w.last_seen_at
  from traders t left join wallets w using (handle)
  where t.handle = any(${handles})`;

/** Shared by the single route and the bulk route, so the two cannot diverge. */
// deno-lint-ignore no-explicit-any
function walletsBody(t: any, knownChains: KnownChain[] | null = null) {
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
    /**
     * WHY THIS TRADER HAS NO ADDRESS — the difference between "we never looked" and
     * "the source is still working on it".
     *
     * Seven traders are published with no wallet, and until now the answer said nothing about
     * why. Asked of fomoapi directly on 16 September, they are not one problem but two:
     * three (`zeri_term`, `bamblewood8`, `qwerty888`) come back `status: "resolving"` — the
     * upstream has not finished resolving them and there is no address to fetch. The other
     * four have dropped off every fomoapi window entirely and are stale directory entries.
     *
     * Those are opposite facts about the same blank screen. One will fix itself; the other
     * never will.
     *
     * Both report `unresolved_upstream` today, which is as far as the stored data can
     * separate them: all seven have no `wallets` row at all, and fomoapi's own
     * `wallets.status` is not something we keep. Telling `resolving` from `delisted` means
     * storing that status on the directory load — worth doing, and a change to the loader
     * rather than to this route.
     */
    walletState: (ok(t.sol_address as string) || ok(t.evm_address as string))
      ? "on_record"
      : "unresolved_upstream",
    tier: (t.evm_confidence || t.sol_confidence) ? "verified" : "reported",
    confidence: { evm: t.evm_confidence ?? null, solana: t.sol_confidence ?? null },
    ...(bad ? { warning: `${bad} stored address(es) are malformed and were withheld` } : {}),
    /**
     * EVERY CHAIN THIS TRADER USES, window-independent and stable.
     *
     * `wallets[].chains` says where each ADDRESS has been seen; this says where the TRADER
     * is, which is the list chain tags and per-chain switches are drawn from. They differ:
     * a chain can carry positions or balance history without a trade we observed.
     *
     * Null rather than [] when the caller did not ask for it to be resolved, so an absent
     * list is never read as a trader on no chains.
     */
    knownChains,
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

  /*
   * A LEADING `@` IS HOW PEOPLE WRITE A HANDLE, and it 404s today.
   *
   * We store handles bare. The consumer's own report names every trader `@unipcs` in its
   * prose and `unipcs` in its curl lines -- the same trader, one spelling of which does not
   * resolve. Tried last, after the bare handle and the display handle, so a handle that
   * genuinely begins with `@` still wins on its own terms.
   */
  if (lower.startsWith("@")) {
    const [at] = await sql`select handle from traders where handle = ${lower.slice(1)}`;
    if (at) return at.handle as string;
  }

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
/**
 * A3 — accept a wallet for a trader we already list.
 *
 * WHY THIS EXISTS AND WHY IT IS NARROW. Seven traders are published with no address, so they
 * reach a screen with no balance and no chart. We resolve wallets ourselves and will keep
 * doing so; this is the route that lets whoever already holds one hand it over rather than
 * watching a trader stay unpriceable.
 *
 * IT IS THE ONLY WRITE IN THIS SERVICE, and that is the whole risk. Every other address here
 * came from a resolver we control, carrying its own source and confidence. An address that
 * arrives from outside has neither, and the failure it invites is the worst one available to
 * this API: attribute the wrong wallet to a trader and we price a stranger's money and
 * publish it under his name, plausibly, with nothing downstream able to tell.
 *
 * So the submission is treated as a CLAIM, not a fact:
 *   - the shape is checked, per family, before anything is stored;
 *   - an address already on another trader is REFUSED, never moved -- that single check is
 *     what stops one person's money appearing on another's page;
 *   - an address a trader already has is refused rather than silently overwritten;
 *   - what is stored carries `source: "submitted"` and `confidence: "reported"`, never
 *     `verified`, so every figure derived from it inherits the weaker tier.
 *
 * Every refusal is a machine word, because a caller has to be able to tell "you sent a typo"
 * from "that wallet belongs to somebody else" without reading English.
 */
const WALLET_SUBMIT_SECRET = (Deno.env.get("WALLET_SUBMIT_SECRET") ?? "").trim();
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
/** base58, no 0/O/I/l. Solana addresses are 32-44 of these. */
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

post("/v1/traders/:handle/wallets", async ({ handle }, _url, body) => {
  /*
   * A write is not open the way the reads are. Unset means misconfigured, and refusing is the
   * safe reading of that -- an open write route is worse than an absent one.
   */
  if (!WALLET_SUBMIT_SECRET) {
    throw new ApiError(503, "not_configured",
      "wallet submission is not enabled on this deployment", {});
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (String(b.secret ?? "") !== WALLET_SUBMIT_SECRET) {
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

  /*
   * IS THIS ADDRESS ALREADY SOMEBODY ELSE'S? The one check that matters most here.
   *
   * Two traders sharing an address means one of them is shown the other's money, and it is
   * invisible afterwards because the figure is real -- it just belongs to a different person.
   * Refused outright rather than reassigned, and the refusal names the trader who holds it so
   * the sender can see the collision rather than guess at it.
   */
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
    insert into wallets (handle, evm_address, evm_address_key, evm_source, evm_confidence,
                         sol_address, sol_address_key, sol_source, sol_confidence,
                         first_seen_at, last_seen_at)
    values (${h},
            ${evm}, ${evm ? evm.toLowerCase() : null},
            ${evm ? "submitted" : null}, ${evm ? "reported" : null},
            ${sol}, ${sol ? sol.toLowerCase() : null},
            ${sol ? "submitted" : null}, ${sol ? "reported" : null},
            now(), now())
    on conflict (handle) do update set
      evm_address     = coalesce(wallets.evm_address, excluded.evm_address),
      evm_address_key = coalesce(wallets.evm_address_key, excluded.evm_address_key),
      evm_source      = coalesce(wallets.evm_source, excluded.evm_source),
      evm_confidence  = coalesce(wallets.evm_confidence, excluded.evm_confidence),
      sol_address     = coalesce(wallets.sol_address, excluded.sol_address),
      sol_address_key = coalesce(wallets.sol_address_key, excluded.sol_address_key),
      sol_source      = coalesce(wallets.sol_source, excluded.sol_source),
      sol_confidence  = coalesce(wallets.sol_confidence, excluded.sol_confidence),
      last_seen_at    = now()`;

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

  const [presence, knownBy] = await Promise.all([
    sql`select chain, network_id, trades_seen, last_active_at
        from wallet_chain_presence where handle = ${h} order by trades_seen desc`,
    knownChainsFor([h]),
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
    ...walletsBody(t, knownBy.get(h) ?? []),
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
    /**
     * WHY `realizedShare` IS NULL, as a machine word rather than only in `plain`.
     *
     * It is withheld on purpose and the sign discipline above explains why: a trader who lost
     * $10,000 would otherwise render as "80% banked". That reasoning was sound and completely
     * invisible to a machine -- 391 of 448 traders serve a null here, and not one carried a
     * stated reason, which made this field alone 386 of the 425 silent absences across the
     * six axes. A hollow axis is honest; a hollow axis with no reason is a hole a person reads
     * as a judgement about the trader.
     */
    realizedShareReason: share !== null
      ? null
      : (!any
        ? "no_trades_on_record"
        : (realized <= 0 && unrealized <= 0
          ? "nothing_banked_or_on_paper"
          : "sign_discipline_not_both_positive")),
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
  /*
   * The fomo figures in `body` date from the trade load; `chainDerived` below dates from the
   * swaps we resolved ourselves. `asOf` names the first, and `chainDerived.lastSwapAt` the
   * second, so neither one is read as speaking for the other.
   */
  body.asOf = await asOfTrades(t.handle as string);
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
