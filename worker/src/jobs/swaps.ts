import type postgres from "postgres";
import type { Env } from "../env";
import { db } from "../db";
import { SOLANA_NETWORK_ID, rpc } from "../../../supabase/functions/_shared/chain_reads.ts";
import { type Decoded, type NativeQuote, type Quote, type Receipt, type SwapRow, type TxBody, decode, toRow, tokensOf } from "./swaps-core";

/**
 * A4, the wallet's OWN two-sided swaps on the EVM chains, read from receipts: the Worker half
 * of refresh.yml "Resolve EVM swaps from receipts".
 *
 * TWIN OF `scripts/resolve_evm_swaps_from_receipts.mjs`: edit both. Same candidate query, same
 * batch sizes, same decode and pricing rules (`swaps-core.ts`), same insert. Differs only where
 * the platform does: a wall-clock budget stops between batches and reports what is left, a
 * failed batch (transport, or a node refusing the batch) is counted and its transactions stay
 * unresolved for the next run, and there are no `--chain`/`--dry-run`/`--batch` flags.
 */

type Sql = postgres.Sql;
interface Chain { readonly network_id: number; readonly name: string; readonly rpc: string }
interface Cand { readonly tx_hash: string; readonly address_key: string; readonly block_time: Date }
interface RpcItem { readonly id?: number; readonly result?: unknown }
interface Priced { readonly cand: Cand; readonly row: SwapRow }
interface Ctx {
  readonly sql: Sql;
  /** This chain's quote assets, keyed by token address. */
  readonly quotes: ReadonlyMap<string, Quote>;
  readonly wrapped: NativeQuote | null;
  /** Decimals learnt so far on this chain, keyed by token address. */
  readonly decimals: Map<string, number>;
}

export interface ChainCounts { resolved: number; unresolved: number; failed: number }
export interface SwapsSummary {
  /** Per chain name: swaps written, transactions read but not one two-token trade, transactions in failed batches. */
  readonly perChain: Record<string, ChainCounts>;
  /** Candidate transactions never asked because the budget ran out. */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

const DEC_SELECTOR = "0x313ce567";
/** base caps a JSON-RPC batch at 10 and says so in a 200 body. Everything else takes 100. */
const batchFor = (name: string): number => name === "base" ? 10 : 100;

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

/** Learn decimals for `addrs` into `cache`: `tokens.decimals` first, then `decimals()` on chain. Unknown stays unknown. */
async function decimalsFor(sql: Sql, c: Chain, cache: Map<string, number>, addrs: readonly string[]): Promise<void> {
  const need = addrs.filter((a) => !cache.has(a));
  if (!need.length) return;
  const rows = await sql<{ token_key: string; decimals: string }[]>`
    select token_key, decimals from tokens
     where network_id = ${c.network_id} and token_key = any(${need}) and decimals is not null`;
  for (const r of rows) cache.set(r.token_key, Number(r.decimals));
  const still = need.filter((a) => !cache.has(a));
  for (let i = 0; i < still.length; i += 40) {
    const slice = still.slice(i, i + 40);
    try {
      const j: unknown = await rpc(c.rpc, slice.map((a, k) => ({
        jsonrpc: "2.0", id: k, method: "eth_call", params: [{ to: a, data: DEC_SELECTOR }, "latest"],
      })));
      for (const r of Array.isArray(j) ? (j as RpcItem[]) : []) {
        const a = r.id === undefined ? undefined : slice[r.id];
        if (!a || typeof r.result !== "string" || r.result.length < 3) continue;
        try {
          const d = Number(BigInt(r.result));
          /* A decimals() that reverts or answers absurdly is not an ERC-20 we can scale. */
          if (Number.isFinite(d) && d >= 0 && d <= 36) cache.set(a, d);
        } catch { /* not a number; leave it unknown */ }
      }
    } catch { /* leave unknown; the swap is skipped, never guessed */ }
  }
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
 * TWO CALLS PER TRANSACTION: the receipt for the logs, the body for `from`/`value` (the native
 * leg). Decode, learn decimals once, write. Returns [resolved, not a two-token trade].
 */
async function resolveBatch(ctx: Ctx, c: Chain, slice: readonly Cand[]): Promise<[number, number]> {
  const call = (method: string): Promise<unknown> =>
    rpc(c.rpc, slice.map((x, k) => ({ jsonrpc: "2.0", id: k, method, params: [x.tx_hash] })));
  const [reply, bodies] = await Promise.all([call("eth_getTransactionReceipt"), call("eth_getTransactionByHash")]);
  if (!Array.isArray(reply)) throw new Error(`node refused a batch of ${slice.length}: ${JSON.stringify(reply).slice(0, 140)}`);
  const bodyById = new Map<number, TxBody>();
  for (const b of Array.isArray(bodies) ? (bodies as RpcItem[]) : []) {
    if (b.id !== undefined && b.result) bodyById.set(b.id, b.result as TxBody);
  }
  let skipped = 0;
  const decoded: { cand: Cand; d: Decoded }[] = [];
  for (const r of reply as RpcItem[]) {
    const cand = r.id === undefined ? undefined : slice[r.id];
    if (!cand || !r.result || r.id === undefined) { skipped++; continue; }
    const d = decode(r.result as Receipt, bodyById.get(r.id) ?? null, cand.address_key);
    if (d) decoded.push({ cand, d }); else skipped++;
  }
  await decimalsFor(ctx.sql, c, ctx.decimals, [...new Set(decoded.flatMap((x) => tokensOf(x.d)))]);
  const out: Priced[] = [];
  for (const { cand, d } of decoded) {
    const row = toRow(d, ctx.decimals, ctx.quotes, ctx.wrapped);
    if (row) out.push({ cand, row }); else skipped++;
  }
  if (out.length) await writeRows(ctx.sql, c.network_id, out);
  return [out.length, skipped];
}

/** The `network_id:` prefix stripped, so the core sees one chain's quotes keyed by token address. */
function quotesOn(net: number, quotes: ReadonlyMap<string, Quote>): Map<string, Quote> {
  const prefix = `${net}:`;
  return new Map([...quotes].filter(([k]) => k.startsWith(prefix)).map(([k, q]) => [k.slice(prefix.length), q]));
}

/**
 * One pass over every EVM chain's unresolved transactions, within `budgetMs`. Throws only when
 * batches were attempted and every one failed, so the cron shows as failed.
 */
export async function runSwaps(env: Env, budgetMs: number): Promise<SwapsSummary> {
  const started = Date.now();
  const sql = db(env);
  const perChain: Record<string, ChainCounts> = {};
  let remaining = 0, stoppedEarly = false, attempted = 0, failedBatches = 0;
  try {
    const chains: Chain[] = (await sql<{ network_id: string; name: string; rpc: string }[]>`
      select network_id, name, rpc from chains where network_id <> ${SOLANA_NETWORK_ID} order by name`)
      .map((r) => ({ ...r, network_id: Number(r.network_id) }));
    const quotes = await loadQuotes(sql);
    const natives = await loadNativeQuotes(sql, quotes);
    for (const c of chains) {
      const cands = await candidates(sql, c.network_id);
      const counts: ChainCounts = { resolved: 0, unresolved: 0, failed: 0 };
      perChain[c.name] = counts;
      const size = batchFor(c.name);
      const ctx: Ctx = { sql, quotes: quotesOn(c.network_id, quotes), wrapped: natives.get(c.network_id) ?? null, decimals: new Map() };
      let i = 0;
      for (; i < cands.length; i += size) {
        if (Date.now() - started > budgetMs) { stoppedEarly = true; break; }
        const slice = cands.slice(i, i + size);
        attempted += 1;
        try {
          const [resolved, unresolved] = await resolveBatch(ctx, c, slice);
          counts.resolved += resolved; counts.unresolved += unresolved;
        } catch (e) {
          failedBatches += 1; counts.failed += slice.length;
          console.error(`swaps: ${c.name} batch ${i / size + 1} of ${slice.length} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      remaining += Math.max(0, cands.length - i);
    }
    if (attempted > 0 && failedBatches === attempted) throw new Error(`swaps: all ${attempted} batches failed`);
    return { perChain, remaining, stoppedEarly, elapsedMs: Date.now() - started };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
