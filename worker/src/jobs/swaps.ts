import type postgres from "postgres";
import type { Env } from "../env";
import { db } from "../db";
import { SOLANA_NETWORK_ID } from "../../../supabase/functions/_shared/chain_reads.ts";
import { bitquery } from "../../../supabase/functions/_shared/bitquery.ts";
import { EVM_CHAINS } from "../../../supabase/functions/_shared/settings.ts";
import { type NativeQuote, type Quote, type SwapRow, type Trade, decode, toRow } from "./swaps-core";

/**
 * A4, the wallet's OWN two-sided swaps on the EVM chains: the Worker half of refresh.yml
 * "Resolve EVM swaps from receipts", now read from Bitquery's decoded `DEXTrades` rather than
 * receipts off a public node (no free JSON-RPC endpoint is called from the Worker since
 * 18 Sep 2026). Ported from `scripts/resolve_evm_swaps_from_receipts.mjs` (deleted 18 Sep 2026;
 * the Worker is the only copy). Same candidate query, same decode and pricing rules
 * (`swaps-core.ts`), same insert. A wall-clock budget stops between batches and reports what
 * is left; a failed batch is counted and its transactions stay unresolved for the next run.
 */

type Sql = postgres.Sql;
interface Chain { readonly network_id: number; readonly name: string }
interface Cand { readonly tx_hash: string; readonly address_key: string; readonly block_time: Date }
interface Priced { readonly cand: Cand; readonly row: SwapRow }
interface Ctx {
  readonly sql: Sql;
  readonly key: string;
  readonly net: number;
  /** Bitquery's word for this chain (`EVM_CHAINS[net].bitquery`). */
  readonly network: string;
  /** This chain's quote assets, keyed by token address. */
  readonly quotes: ReadonlyMap<string, Quote>;
  readonly wrapped: NativeQuote | null;
}

export interface ChainCounts { resolved: number; unresolved: number; failed: number; bitqueryQueries: number }
export interface SwapsSummary {
  /** Per chain name: swaps written, transactions read but not one two-token trade, transactions in failed batches, queries sent. */
  readonly perChain: Record<string, ChainCounts>;
  /** Bitquery queries sent across the chains. */
  readonly bitqueryQueries: number;
  /** Candidate transactions never asked because the budget ran out. */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

/** Hashes per Bitquery query: one `in` list, one reply. */
const BATCH = 100;
/** ponytail: a route is a handful of hops; a transaction with more trades than this is not one wallet's swap anyway. */
const TRADES_PER_TX = 10;

/** Quote assets, keyed `network_id:token_key`, with the dollar value of one unit where we can state it. */
async function loadQuotes(sql: Sql): Promise<Map<string, Quote>> {
  const rows = await sql<{ network_id: string; token_key: string; symbol: string; pegged_usd: string | null; market_price: string | null }[]>`
    select q.network_id, q.token_key, q.symbol, q.pegged_usd,
           (select h.price from holdings_current h
             where h.network_id = q.network_id and h.token_key = q.token_key
               and h.price is not null and h.price_source is not null
               and h.price_source <> 'fomo_reported_entry'
             order by h.priced_at desc nulls last limit 1) as market_price
    from quote_assets q`;
  /* A stablecoin's peg is the honest price; a wrapped native takes the portfolio's market price; unpriced still resolves. */
  return new Map(rows.map((q) => [`${Number(q.network_id)}:${q.token_key}`, {
    symbol: q.symbol,
    usd: q.pegged_usd !== null ? Number(q.pegged_usd) : q.market_price !== null ? Number(q.market_price) : null,
  }]));
}

/** Each chain's wrapped native: the quote asset a native leg is recorded against. */
async function loadNativeQuotes(sql: Sql, quotes: ReadonlyMap<string, Quote>): Promise<Map<number, NativeQuote>> {
  const rows = await sql<{ network_id: string; native_symbol: string; token_key: string }[]>`
    select c.network_id, c.native_symbol, q.token_key
    from chains c
    join quote_assets q on q.network_id = c.network_id
     and upper(q.symbol) = 'W' || upper(c.native_symbol)`;
  return new Map(rows.map((r) => [Number(r.network_id), {
    key: r.token_key, usd: quotes.get(`${Number(r.network_id)}:${r.token_key}`)?.usd ?? null,
  }]));
}

/** Every transaction on this chain with no wallet_swaps row yet, one per (tx, wallet). */
const candidates = (sql: Sql, net: number) => sql<Cand[]>`
  select t.tx_hash, t.address_key, min(t.block_time) as block_time
  from transactions t
  where t.network_id = ${net}
    and not exists (
      select 1 from wallet_swaps s
      where s.network_id = ${net} and s.tx_hash = t.tx_hash and s.address_key = t.address_key)
  group by t.tx_hash, t.address_key`;

async function writeRows(sql: Sql, net: number, out: readonly Priced[]): Promise<void> {
  const col = <T>(f: (p: Priced) => T): T[] => out.map(f);
  await sql`
    insert into wallet_swaps
      (network_id, tx_hash, address_key, block_time, token_key, token_delta,
       quote_key, quote_delta, quote_usd, resolved_at)
    select ${net}, u.tx, u.addr, u.at::timestamptz, u.tk, u.td::numeric,
           u.qk, u.qd::numeric, nullif(u.qu,'')::numeric, now()
    from unnest(${col((p) => p.cand.tx_hash)}::text[], ${col((p) => p.cand.address_key)}::text[],
                ${col((p) => new Date(p.cand.block_time).toISOString())}::text[], ${col((p) => p.row.tokenKey)}::text[],
                ${col((p) => String(p.row.tokenDelta))}::text[], ${col((p) => p.row.quoteKey)}::text[],
                ${col((p) => String(p.row.quoteDelta))}::text[],
                ${col((p) => p.row.quoteUsd === null ? "" : String(p.row.quoteUsd))}::text[])
         as u(tx, addr, at, tk, td, qk, qd, qu)
    on conflict do nothing`;
}

/**
 * Every decoded DEX trade in a batch of transactions, grouped by hash (lower-case). Fields per
 * https://docs.bitquery.io/docs/schema/evm/dextrades/ (`Trade { Buy { Amount Buyer Seller
 * Currency { SmartContract Native } } Sell { ... } }`, `Transaction { Hash From }`) and
 * https://docs.bitquery.io/docs/examples/dextrades/trades-of-an-address-api/ (`Buy.Buyer` /
 * `Buy.Seller` are the two roles a wallet can hold); `Amount` is in human units, as every
 * Bitquery amount is. The hash filter is `Transaction: { Hash: { in: $hashes } }` per
 * https://docs.bitquery.io/docs/graphql/filters/. `network` is a GraphQL enum, so it goes in
 * the query text; `limit` is explicit because the cube's default is smaller than a batch.
 */
async function tradesByHash(ctx: Ctx, hashes: readonly string[]): Promise<Map<string, Trade[]>> {
  const query = `query ($hashes: [String!]) {
    EVM(network: ${ctx.network}, dataset: combined) {
      DEXTrades(where: { Transaction: { Hash: { in: $hashes } } }, limit: { count: ${hashes.length * TRADES_PER_TX} }) {
        Transaction { Hash From }
        Trade {
          Buy { Amount Buyer Seller Currency { SmartContract Native } }
          Sell { Amount Buyer Seller Currency { SmartContract Native } }
        }
      }
    }
  }`;
  const data: unknown = await bitquery(ctx.key, query, { hashes });
  const evm = typeof data === "object" && data !== null ? (data as { EVM?: { DEXTrades?: unknown } }).EVM : undefined;
  if (!Array.isArray(evm?.DEXTrades)) throw new Error(`Bitquery answered without DEXTrades for a batch of ${hashes.length}`);
  const out = new Map<string, Trade[]>();
  for (const t of evm.DEXTrades as Trade[]) {
    const h = typeof t.Transaction?.Hash === "string" ? t.Transaction.Hash.toLowerCase() : "";
    if (h) out.set(h, [...(out.get(h) ?? []), t]);
  }
  return out;
}

/** ONE QUERY PER BATCH: Bitquery's decoded trades, netted per wallet, priced, written. Returns [resolved, not a two-token trade]. */
async function resolveBatch(ctx: Ctx, slice: readonly Cand[]): Promise<[number, number]> {
  const trades = await tradesByHash(ctx, [...new Set(slice.map((c) => c.tx_hash))]);
  const out: Priced[] = [];
  let skipped = 0;
  for (const cand of slice) {
    const d = decode(trades.get(cand.tx_hash.toLowerCase()) ?? [], cand.address_key);
    const row = d && toRow(d, ctx.quotes, ctx.wrapped);
    if (row) out.push({ cand, row }); else skipped++;
  }
  if (out.length) await writeRows(ctx.sql, ctx.net, out);
  return [out.length, skipped];
}

/** The `network_id:` prefix stripped, so the core sees one chain's quotes keyed by token address. */
function quotesOn(net: number, quotes: ReadonlyMap<string, Quote>): Map<string, Quote> {
  const prefix = `${net}:`;
  return new Map([...quotes].filter(([k]) => k.startsWith(prefix)).map(([k, q]) => [k.slice(prefix.length), q]));
}

/** Bitquery's word for an EVM chain in `chains`; a chain it has no word for is a configuration error. */
function networkWord(c: Chain): string {
  const w = EVM_CHAINS[c.network_id]?.bitquery;
  if (!w || !/^[a-z0-9_]+$/.test(w)) throw new Error(`swaps: no Bitquery network word for chain '${c.name}' (${c.network_id})`);
  return w;
}

/**
 * One pass over every EVM chain's unresolved transactions, within `budgetMs`. Throws only when
 * batches were attempted and every one failed, so the cron shows as failed.
 */
export async function runSwaps(env: Env, budgetMs: number): Promise<SwapsSummary> {
  const started = Date.now();
  const key = (env.BITQUERY_KEY ?? "").trim();
  if (!key) throw new Error("swaps: BITQUERY_KEY is not set");
  const sql = db(env);
  const perChain: Record<string, ChainCounts> = {};
  let remaining = 0, stoppedEarly = false, attempted = 0, failedBatches = 0;
  try {
    const chains: Chain[] = (await sql<{ network_id: string; name: string }[]>`
      select network_id, name from chains where network_id <> ${SOLANA_NETWORK_ID} order by name`)
      .map((r) => ({ ...r, network_id: Number(r.network_id) }));
    const quotes = await loadQuotes(sql);
    const natives = await loadNativeQuotes(sql, quotes);
    for (const c of chains) {
      const cands = await candidates(sql, c.network_id);
      const counts: ChainCounts = { resolved: 0, unresolved: 0, failed: 0, bitqueryQueries: 0 };
      perChain[c.name] = counts;
      const ctx: Ctx = {
        sql, key, net: c.network_id, network: networkWord(c),
        quotes: quotesOn(c.network_id, quotes), wrapped: natives.get(c.network_id) ?? null,
      };
      let i = 0;
      for (; i < cands.length; i += BATCH) {
        if (Date.now() - started > budgetMs) { stoppedEarly = true; break; }
        const slice = cands.slice(i, i + BATCH);
        attempted += 1;
        counts.bitqueryQueries += 1;
        try {
          const [resolved, unresolved] = await resolveBatch(ctx, slice);
          counts.resolved += resolved; counts.unresolved += unresolved;
        } catch (e) {
          failedBatches += 1; counts.failed += slice.length;
          console.error(`swaps: ${c.name} batch ${i / BATCH + 1} of ${slice.length} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      remaining += Math.max(0, cands.length - i);
    }
    if (attempted > 0 && failedBatches === attempted) throw new Error(`swaps: all ${attempted} batches failed`);
    const bitqueryQueries = Object.values(perChain).reduce((n, c) => n + c.bitqueryQueries, 0);
    return { perChain, bitqueryQueries, remaining, stoppedEarly, elapsedMs: Date.now() - started };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
