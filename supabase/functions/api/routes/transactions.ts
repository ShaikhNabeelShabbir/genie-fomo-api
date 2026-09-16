import { sql, n, round } from "../db.ts";
import { get, post } from "../router.ts";
import { notFound, badRequest } from "../errors.ts";
import { intParam } from "../shared/params.ts";
import { cov, money } from "../shared/format.ts";
import { NativePrice, nativePrices } from "../shared/prices.ts";
import { chainWhere } from "../shared/chains.ts";
import { resolveTrader } from "../shared/traders.ts";
import { encodeCursor, decodeCursor } from "../shared/cursor.ts";
import { feeUsd } from "../shared/scorecard-core.ts";

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
