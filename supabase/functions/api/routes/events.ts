import { sql, n, round } from "../db.ts";
import { get } from "../router.ts";
import { badRequest } from "../errors.ts";
import { intParam } from "../shared/params.ts";
import { chainWhere } from "../shared/chains.ts";
import { resolveTrader } from "../shared/traders.ts";
import { encodeCursor, decodeCursor } from "../shared/cursor.ts";
import { sellFlags } from "../shared/positions-core.ts";

// ------------------------------------------------------------- events feed

/**
 * Workflow gap 2 (docs/consumer/workflow-coverage-17-sep.md): one keyset-paged feed, oldest
 * first, over rows we already store. The app polls it with the cursor it was last handed.
 * No push, no alerts: this is the substrate those are built on.
 */
export const EVENT_KINDS = ["transfer", "swap", "reading"] as const;
export type EventKind = typeof EVENT_KINDS[number];

/** Default lookback when the caller gives no `since`: keeps the union bounded. */
const DEFAULT_SINCE_MS = 24 * 3600 * 1000;

const isKind = (v: unknown): v is EventKind => EVENT_KINDS.includes(v as EventKind);

/**
 * The keyset is (at, kind, id, sub): id is the tx hash for transfers and swaps, the handle for
 * readings; sub tells one transaction's rows apart (its legs, and each watched wallet it touched).
 */
export type EventCursor = { at: string; kind: EventKind; id: string; sub: string };

export const encodeEventCursor = (c: EventCursor): string => encodeCursor([c.at, c.kind, c.id, c.sub]);

/** A 3-part cursor predates `sub`: it resumes at '' and re-delivers the boundary transaction, never loses it. */
export const decodeEventCursor = (raw: string): EventCursor => {
  const parts = decodeCursor(raw);
  const [at, kind, id, sub = ""] = parts;
  if ((parts.length !== 3 && parts.length !== 4) || typeof at !== "string" || !isKind(kind)
      || typeof id !== "string" || typeof sub !== "string" || !Number.isFinite(Date.parse(at))) {
    throw badRequest("cursor does not belong to this route", { parameter: "cursor" });
  }
  return { at, kind, id, sub };
};

/** One union row, as SQL returns it. Columns absent for a kind are null. */
export type EventRow = {
  kind: EventKind; at: string | Date; id: string; sub: string;
  handle: string; display_handle: string; trader_source: string;
  chain: string | null;
  direction: string | null; token_address: string | null; amount: unknown;
  counterparty: string | null; source: string | null; tx_type: string | null;
  token_delta: unknown; quote_delta: unknown; quote_usd: unknown;
  total_usd: unknown; refused_reason: string | null;
  /** SQLite booleans arrive as 0/1 (NULL = not assessed); read through `sellFlags`. */
  has_info: unknown; is_honeypot: unknown; can_not_sell: unknown;
};

const iso = (v: string | Date): string => new Date(String(v)).toISOString();

/** Pure: the published shape of one event. */
export const toEvent = (r: EventRow) => {
  const base = { kind: r.kind, at: iso(r.at), handle: r.display_handle, traderSource: r.trader_source };
  if (r.kind === "reading") {
    return { ...base, totalUsd: round(n(r.total_usd)), refusedReason: r.refused_reason ?? null };
  }
  /** `null` when token_info holds no row for this token: unassessed, not safe. */
  const gates = r.has_info ? { ...sellFlags(r), priceSuspect: null } : null;
  const token = { chain: r.chain, tokenAddress: r.token_address ?? null, txHash: r.id, gates };
  return r.kind === "swap"
    ? { ...base, ...token, tokenDelta: n(r.token_delta), quoteDelta: n(r.quote_delta),
        quoteUsd: round(n(r.quote_usd)) }
    : { ...base, ...token, direction: r.direction ?? null, amount: n(r.amount),
        counterparty: r.counterparty ?? null, source: r.source ?? null, txType: r.tx_type ?? null };
};

get("/v1/events", async (_p, url) => {
  const limit = intParam(url, "limit", { min: 1, max: 500, fallback: 100 })!;
  const sinceRaw = url.searchParams.get("since");
  if (sinceRaw !== null && !Number.isFinite(Date.parse(sinceRaw))) {
    throw badRequest(`'since' must be an ISO timestamp — got '${sinceRaw}'`, { parameter: "since" });
  }
  const since = sinceRaw ? new Date(sinceRaw).toISOString()
                         : new Date(Date.now() - DEFAULT_SINCE_MS).toISOString();
  const kind = (url.searchParams.get("kind") ?? "").trim().toLowerCase() || null;
  if (kind !== null && !isKind(kind)) {
    throw badRequest(`unknown kind '${kind}' — use one of ${EVENT_KINDS.join(", ")}`,
      { parameter: "kind", valid: EVENT_KINDS });
  }
  const net = await chainWhere((url.searchParams.get("chain") ?? "").trim().toLowerCase() || null);
  const handleQ = url.searchParams.get("handle");
  const handle = handleQ ? await resolveTrader(handleQ) : null;
  const cursorRaw = url.searchParams.get("cursor");
  const cur = cursorRaw ? decodeEventCursor(cursorRaw) : null;

  /*
   * Three sources, one order. Predicates on the union's columns push down into each arm, so
   * `since` and the keyset hit wallet_swaps_time_idx and aum_samples_at_idx; transactions has
   * no time-only index, which is why `since` defaults to 24 h rather than the beginning.
   */
  const rows = await sql<EventRow[]>`
    with ev as (
      select 'transfer' as kind, tx.block_time as at, tx.tx_hash as id,
             w.handle || '|' || tx.network_id || '|' || tx.address_key || '|' || tx.transfer_key as sub, w.handle,
             tx.network_id, tx.direction, tx.token_key as token_address, tx.amount,
             tx.counterparty, tx.tx_source as source, tx.tx_type,
             null as token_delta, null as quote_delta, null as quote_usd,
             null as total_usd, null as refused_reason
      from transactions tx
      join wallets w on tx.address_key in (w.evm_address_key, w.sol_address_key)
      where tx.block_time is not null
      union all
      select 'swap', ws.block_time, ws.tx_hash,
             w.handle || '|' || ws.network_id || '|' || ws.address_key, w.handle,
             ws.network_id, null, ws.token_key, null, null, null, null,
             ws.token_delta, ws.quote_delta, ws.quote_usd, null, null
      from wallet_swaps ws
      join wallets w on ws.address_key in (w.evm_address_key, w.sol_address_key)
      where ws.block_time is not null
      union all
      -- JS cursors carry milliseconds; sampled_at is already stored to the millisecond,
      -- so date_trunc('milliseconds', …) has nothing left to do.
      select 'reading', s.sampled_at, s.handle, '', s.handle,
             null, null, null, null, null, null, null,
             null, null, null, s.total_usd, s.refused_reason
      from aum_samples s
      where s.basis = 'sampled'
    )
    select ev.*, c.name as chain, traders.display_handle, traders.source as trader_source,
           (ti.token_key is not null) as has_info, ti.is_honeypot, ti.can_not_sell
    from ev
    join traders using (handle)
    left join chains c using (network_id)
    left join token_info ti on ti.network_id = ev.network_id and ti.token_key = ev.token_address
    -- The keyset below already implies at >= the cursor at, and saying so lets each arm SEEK from the cursor, not from since.
    where ev.at >= max(${since}, ${cur === null ? since : cur.at})
      ${kind === null ? sql`` : sql`and ev.kind = ${kind}`}
      ${net === null ? sql`` : sql`and ev.network_id = ${net}`}
      ${handle === null ? sql`` : sql`and ev.handle = ${handle}`}
      ${cur === null ? sql``
        : sql`and (ev.at, ev.kind, ev.id, ev.sub) > (${cur.at}, ${cur.kind}, ${cur.id}, ${cur.sub})`}
    order by ev.at, ev.kind, ev.id, ev.sub
    limit ${limit}`;

  const last = rows.at(-1);
  return {
    asOf: new Date().toISOString(),
    since,
    count: rows.length,
    limit,
    filters: { kind, chain: net === null ? null : url.searchParams.get("chain"), handle },
    /** `null` on the last page; a full page is only a hint that more exist. */
    nextCursor: rows.length === limit && last
      ? encodeEventCursor({ at: iso(last.at), kind: last.kind, id: last.id, sub: last.sub }) : null,
    events: rows.map(toEvent),
    note: "Solana transfers and swaps arrive in real time from the Helius webhook; EVM " +
          "transfers are backfilled nightly, so an EVM event can appear up to a day after " +
          "its `at`. Readings are the sampler's balance readings (basis sampled). " +
          "`since` defaults to the last 24 hours; page forward with `nextCursor`. " +
          "`?chain=` excludes readings, which are not per chain.",
    source: "d1 · transactions, wallet_swaps, aum_samples, token_info",
  };
});
