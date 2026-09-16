import { sql, n, round } from "../db.ts";
import { get, post } from "../router.ts";
import { notFound } from "../errors.ts";
import { asOfHoldings } from "../shared/asof.ts";
import { intParam } from "../shared/params.ts";
import { cov, money } from "../shared/format.ts";
import { nativePrices } from "../shared/prices.ts";
import { resolveTrader } from "../shared/traders.ts";
import { encodeCursor, resumeAfter } from "../shared/cursor.ts";
import { batchIds, batchEnvelope } from "../shared/batch.ts";
import { CostBasis, costBasisFor, costBlock } from "../shared/positions-core.ts";
import { priceSuspectReason } from "../../aum-sample/value.ts";

/** A row's gross amount x price, before any ceiling withheld its `value` (V1). */
const gross = (r: Record<string, unknown>): number | null => {
  const a = n(r.human_amount), p = n(r.price);
  return a !== null && p !== null ? a * p : null;
};

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
      /** The same dollars said in the chain's own coin, which is how a wallet says them. See docs/DECISIONS.md#d071 */
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


// ---------------------------------------------------------- T12 positions

/** T1.1. See docs/DECISIONS.md#d072 */
const positionTiming = (addrs: string[]) => sql`
  select network_id, token_key, start_at, end_at, last_at
  from position_timing
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
           (q.token_key is not null) as is_quote,
           tk.total_supply::float8 as total_supply
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

  /** The floor under every timestamp on this page, derived in memory from `timing`. See docs/DECISIONS.md#d073 */
  const observedFrom = timing
    .map((r) => (r.start_at ? Date.parse(String(r.start_at)) : null))
    .filter((x): x is number => x !== null && Number.isFinite(x));
  const historyFrom = observedFrom.length
    ? new Date(Math.min(...observedFrom)).toISOString() : null;
  const timeBy = new Map<string, Record<string, unknown>>();
  for (const r of timing) timeBy.set(`${r.network_id}:${r.token_key}`, r);
  const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);

  const total = rows.reduce((s, r) => s + ((n(r.value) ?? 0) > 0 ? n(r.value)! : 0), 0);
  const grossTotal = rows.reduce((s: number, r: Record<string, unknown>) => s + (gross(r) ?? 0), 0);
  const all = rows.map((r) => {
    const tm = timeBy.get(`${r.network_id}:${r.token_key}`);
    const v = (n(r.value) ?? 0) > 0 ? n(r.value) : null;
    const suspect = priceSuspectReason(n(r.price), n(r.total_supply), gross(r), grossTotal);
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
      whyNoPrice: v !== null ? null
        : n(r.price) !== null ? "price refused by the valuation ceilings; see priceSuspectReason"
        : "no price for this token in any source we hold",
      /** V1: the price fails a check a consumer cannot run alone (price x supply, concentration). */
      priceSuspect: suspect !== null,
      priceSuspectReason: suspect,
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
  /** PAGED, AND HONEST ABOUT IT. See docs/DECISIONS.md#d074 */
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
    /** T1.1. See docs/DECISIONS.md#d075 */
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


/**
 * Positions for many traders in one call.
 *
 * POST rather than GET because fifty ids do not belong in a query string: a 2 KB URL breaks
 * proxies and fills logs. Nothing here mutates -- it is a read that needs a body.
 */
/** Positions for many traders in one call. See docs/DECISIONS.md#d076 */
post("/v1/traders/positions", async (_p, _url, body) => {
  const { requested, handles, asked, capped } = await batchIds(body);
  /** THE FULL ENVELOPE IS THE DEFAULT. See docs/DECISIONS.md#d077 */
  const v2 = Number((body as { contractVersion?: number })?.contractVersion) !== 1;

  const rows = await sql`
    select h.handle, ch.name as chain, h.network_id, h.token_key,
           tk.address as token_address,
           coalesce(ti.symbol, tk.symbol) as symbol,
           h.human_amount, h.price, h.value, h.source, h.captured_at,
           h.price_source, h.priced_at, tk.total_supply::float8 as total_supply
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

  /** Per-trader gross totals, for the concentration check on each row. */
  const grossBy = new Map<string, number>();
  for (const r of rows) grossBy.set(String(r.handle), (grossBy.get(String(r.handle)) ?? 0) + (gross(r) ?? 0));

  const position = (r: Record<string, unknown>) => {
    const suspect = priceSuspectReason(n(r.price), n(r.total_supply), gross(r), grossBy.get(String(r.handle)) ?? 0);
    return {
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
    whyNoPrice: n(r.value) !== null ? null
      : n(r.price) !== null ? "price refused by the valuation ceilings; see priceSuspectReason"
      : "no price for this token in any source we hold",
    priceSuspect: suspect !== null,
    priceSuspectReason: suspect,
    tier: r.source === "chain" ? "verified" : "reported",
    };
  };

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
