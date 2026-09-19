/**
 * Pure half of the token refresh (`./tokens.ts`): address shapes, Bitquery reply decoding, the
 * GMGN envelope and the token_info row, ported from `scripts/resolve_trade_chains.mjs`,
 * `scripts/load_token_supply.mjs` and `scripts/load_token_info.mjs` (the scripts still read
 * chains and supply over JSON-RPC; the Worker reads them from Bitquery). No I/O, so
 * `tests/tokens_test.ts` runs it under Deno.
 */
import type { Sql } from "../d1.ts";

export type Rec = Readonly<Record<string, unknown>>;
export const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

// ------------------------------------------------------------------ chain shape
export const isEvmAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);
export const isSolAddress = (a: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

/** A 0x address seen on exactly one chain. Several is left unresolved: the same address really can be deployed twice. */
export const singleChain = (hits: readonly number[]): number | null => (hits.length === 1 ? hits[0] : null);

/** Rows of one cube under one root alias of a Bitquery reply (`data.<alias>.<cube>`). */
const cubeRows = (data: unknown, alias: string, cube: string): unknown[] => {
  const root = isRec(data) ? data[alias] : null;
  const rows = isRec(root) ? root[cube] : null;
  return Array.isArray(rows) ? rows : [];
};

/**
 * Chain probe reply: one `EVM` root per chain, aliased `n<id>`, each with a one-row Transfers
 * cube. A chain whose cube has a row has seen the contract.
 */
export const chainHits = (data: unknown, ids: readonly number[]): number[] =>
  ids.filter((id) => cubeRows(data, `n${id}`, "Transfers").length > 0);

// ---------------------------------------------------------------------- supply
/** `decimals` is what Bitquery said, null when it did not; `supply` is already in human units. */
export interface Supply { readonly supply: number; readonly decimals: number | null; readonly source: string }

function supplyOf(row: unknown, amountKey: "TotalSupply" | "PostBalance"): Supply | null {
  if (!isRec(row)) return null;
  const supply = num(row[amountKey]);
  if (supply === null || supply <= 0) return null;
  return { supply, decimals: isRec(row.Currency) ? num(row.Currency.Decimals) : null, source: "bitquery" };
}

/** `EVM.TransactionBalances[0].TokenBalance` (`TotalSupply`, `Currency.Decimals`). */
export const evmSupply = (data: unknown): Supply | null => {
  const [row] = cubeRows(data, "EVM", "TransactionBalances");
  return supplyOf(isRec(row) ? row.TokenBalance : null, "TotalSupply");
};

/** `Solana.TokenSupplyUpdates[0].TokenSupplyUpdate` (`PostBalance`, `Currency.Decimals`). */
export const solanaSupply = (data: unknown): Supply | null => {
  const [row] = cubeRows(data, "Solana", "TokenSupplyUpdates");
  return supplyOf(isRec(row) ? row.TokenSupplyUpdate : null, "PostBalance");
};

// ------------------------------------------------------------------------ gmgn
/** Our chain names are not GMGN's. Two differ and the rest pass through. */
export const CHAIN_CODE: Readonly<Record<string, string>> = { solana: "sol", ethereum: "eth", bsc: "bsc", base: "base", robinhood: "robinhood" };

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/** Postgres jsonb cannot hold a NUL (U+0000), and memecoin names are full of them. */
export const jsonForPg = (v: unknown): string => JSON.stringify(v).replace(/\\u0000/g, "");
/** Same problem in the plain text columns. */
export const clean = (v: unknown): string | null =>
  typeof v === "string" ? v.replace(/\u0000/g, "").replace(/\\u0000/g, "") : null;

/** Unwrap a GMGN envelope; throws "RATE_LIMIT" for their limiter so the caller backs off. */
export function gmgnData(ok: boolean, status: number, body: unknown): Rec {
  const j = isRec(body) ? body : null;
  if (j?.error === "RATE_LIMIT_EXCEEDED") throw new Error("RATE_LIMIT");
  if (!ok) throw new Error(`HTTP ${status}`);
  if (j?.code !== 0) throw new Error(String(j?.message ?? j?.error ?? "gmgn error").slice(0, 80));
  if (!isRec(j.data)) throw new Error("malformed document");
  return j.data;
}

/**
 * Why a GMGN read produced no document. `refused`: the SOURCE is turning us away (bad key, rate
 * limit, outage) and the next coin will fare no better. `nothing`: it answered, and has no document
 * for THIS coin — which is an answer, and the coin is parked instead of being asked first every run.
 */
export const gmgnFailure = (message: string): "refused" | "nothing" =>
  /^HTTP (?:401|403|429|5\d\d)$|RATE_LIMIT|timed? ?out|network|fetch failed|abort/i.test(message) ? "refused" : "nothing";

export interface Security {
  readonly is_honeypot: boolean | null;
  readonly is_open_source: boolean | null;
  readonly is_renounced: boolean | null;
  readonly renounced_mint: boolean | null;
  readonly renounced_freeze: boolean | null;
  readonly is_blacklisted: boolean | null;
  readonly can_not_sell: boolean | null;
  readonly buy_tax: number | null;
  readonly sell_tax: number | null;
  readonly rug_ratio: number | null;
  readonly burn_ratio: number | null;
}

/**
 * GMGN answers every field on every chain and the inapplicable ones come back `false`.
 * Inapplicable checks are stored NULL: "we do not know", never "safe". See load_token_info.mjs.
 */
export function normaliseSecurity(chain: string, d: Rec): Security {
  const sol = chain === "solana";
  const bool = (v: unknown): boolean | null => (v === null || v === undefined || v === "" ? null : Boolean(v));
  const cns = num(d.can_not_sell);
  return {
    is_honeypot: sol ? null : bool(d.is_honeypot),
    is_open_source: sol ? null : bool(d.is_open_source),
    is_renounced: sol ? null : bool(d.is_renounced),
    renounced_mint: sol ? bool(d.renounced_mint) : null,
    renounced_freeze: sol ? bool(d.renounced_freeze_account) : null,
    is_blacklisted: sol ? null : bool(d.is_blacklist),
    // can_not_sell is a count in their payload, not a flag.
    can_not_sell: cns === null ? null : cns > 0,
    buy_tax: num(d.buy_tax),
    sell_tax: num(d.sell_tax),
    rug_ratio: num(d.rug_ratio),
    burn_ratio: num(d.burn_ratio),
  };
}

/** Always ours (GMGN returned market_cap on 0 of 1,095 tokens); NULL above $10T, where it is a supply artifact. */
export function marketCap(reported: number | null, price: number | null, circ: number | null): number | null {
  const raw = reported ?? (price !== null && circ !== null ? price * circ : null);
  return raw !== null && raw <= 1e13 ? raw : null;
}

export interface InfoRow {
  readonly symbol: string | null;
  readonly name: string | null;
  readonly price_usd: number | null;
  readonly liquidity_usd: number | null;
  readonly market_cap_usd: number | null;
  readonly total_supply: number | null;
  readonly circulating_supply: number | null;
  readonly max_supply: number | null;
  readonly holder_count: number | null;
  readonly top_10_holder_rate: number | null;
  /** GMGN's `logo`; null when absent or not a URL. */
  readonly logo_url: string | null;
  readonly raw: string;
}

/** A string that is a URL, else null: a logo field holding "" or a bare filename is no logo. */
export const urlOrNull = (v: unknown): string | null => {
  const s = clean(v);
  return s !== null && /^https?:\/\//.test(s) ? s : null;
};

/** The fundamentals columns from a /v1/token/info document. */
export function infoRow(d: Rec): InfoRow {
  const price = num(isRec(d.price) ? d.price.price : null);
  const circ = num(d.circulating_supply);
  return {
    symbol: clean(d.symbol),
    name: clean(d.name),
    price_usd: price,
    liquidity_usd: num(d.liquidity),
    market_cap_usd: marketCap(num(d.market_cap), price, circ),
    total_supply: num(d.total_supply),
    circulating_supply: circ,
    max_supply: num(d.max_supply),
    holder_count: num(d.holder_count),
    top_10_holder_rate: num(isRec(d.stat) ? d.stat.top_10_holder_rate : null),
    logo_url: urlOrNull(d.logo),
    raw: jsonForPg(d),
  };
}

export interface InfoTarget { readonly network_id: number; readonly token_key: string; readonly address: string; readonly chain: string }

/**
 * The GMGN queue, in the order it is worked. Here, not in tokens.ts, so tests/tokens_queue_test.ts
 * can run it against the schema. `staleAgo` and `missRetryAgo` are SQLite date modifiers.
 */
export const infoTargets = (sql: Sql, staleAgo: string, missRetryAgo: string) => sql<InfoTarget[]>`
  select network_id, token_key, address, chain from (
    select due.*,
           row_number() over (order by holders desc, waited, token_key) as by_held,
           row_number() over (order by waited, holders desc, token_key) as by_wait
      from (
    select h.network_id, h.token_key, tk.address, ch.name as chain,
           count(distinct h.handle) as holders,
           max(coalesce(ti.fetched_at, ''), coalesce(ms.missed_at, '')) as waited
      from holdings_current h
      join tokens tk  on tk.network_id = h.network_id and tk.token_key = h.token_key
      join chains ch  on ch.network_id = h.network_id
      left join quote_assets q
        on q.network_id = h.network_id and q.token_key = h.token_key
      left join token_info ti
        on ti.network_id = h.network_id and ti.token_key = h.token_key
      left join token_info_misses ms
        on ms.network_id = h.network_id and ms.token_key = h.token_key
     where q.token_key is null
       -- Either half being stale is reason to refetch: security has its own timestamp.
       and (ti.fetched_at is null or ti.security_fetched_at is null
            or ti.fetched_at < strftime('%Y-%m-%dT%H:%M:%fZ','now',${staleAgo})
            or ti.security_fetched_at < strftime('%Y-%m-%dT%H:%M:%fZ','now',${staleAgo}))
       -- A coin GMGN had nothing for waits before it is asked again. It used to be asked FIRST on
       -- every run (never-fetched sorted first and a miss left no trace), so the head of the queue
       -- was permanently coins GMGN does not know and the coins it does know sat 9 days old.
       and (ms.missed_at is null or ms.missed_at < strftime('%Y-%m-%dT%H:%M:%fZ','now',${missRetryAgo}))
     group by h.network_id, h.token_key, tk.address, ch.name, ti.fetched_at, ms.missed_at
      ) due)
   -- TWO ORDERS, INTERLEAVED: odd places to the most-held due coin, even places to the one longest since
   -- it was last ASKED (the LATER of answered and missed; never asked sorts before any date). A run reads ~94
   -- coins and the top ~1,030 by holders fall due again every 22 h, so most-held-first alone never reached the tail.
   order by min(2 * by_held - 1, 2 * by_wait)`;
