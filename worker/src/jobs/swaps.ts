import type { Env } from "../env";
import { jobSql, type Sql } from "../sql";
import { SOLANA_NETWORK_ID, throttled } from "../../../supabase/functions/_shared/chain_reads.ts";
import { bitquery } from "../../../supabase/functions/_shared/bitquery.ts";
import { EVM_CHAINS } from "../../../supabase/functions/_shared/settings.ts";
import { type NativeQuote, type Quote, type SwapRow, type Trade, decode, solanaDecodeEnhanced, toRow } from "./swaps-core";
import { chunk } from "./directory-core";

/**
 * A4, the wallet's OWN two-sided swaps, written to `wallet_swaps`. Phase 1 is the EVM chains
 * from Bitquery's decoded `DEXTrades` (ported from `scripts/resolve_evm_swaps_from_receipts.mjs`;
 * no free JSON-RPC endpoint is called from the Worker). Phase 2 is Solana: every `transactions`
 * row tagged SWAP, resolved through Helius's Enhanced Transactions API, 100 signatures a
 * request (the `getTransaction` batches of 10 it replaced resolved ~2 candidates a second,
 * behind the ~2,000 SWAP rows an hour the webhook writes). Same decode and pricing rules
 * (`swaps-core.ts`), same insert. Candidates are read
 * newest first with a cap per run, so every run reaches the head of the feed and the backlog
 * drains from there; each candidate asked is marked in `wallet_swaps_checked` whether or not
 * it was a swap (95% are not), so the next run asks the next slice. A failed batch is counted
 * and its transactions stay unmarked for the next run. The run ends with a re-price pass over
 * the last 30 days for rows whose money leg got a daily close after they were written.
 */

interface Chain { readonly network_id: number; readonly name: string }
/** `block_time` is the ISO-8601 UTC text D1 stores. */
interface Cand { readonly tx_hash: string; readonly address_key: string; readonly block_time: string }
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

export interface ChainCounts { resolved: number; unresolved: number; failed: number; queries: number }
export interface SwapsSummary {
  /** Per chain name: swaps written, transactions read but not one two-token trade, transactions in failed batches, source calls (Helius batches on solana, Bitquery queries elsewhere). */
  readonly perChain: Record<string, ChainCounts>;
  /** Bitquery queries sent across the EVM chains. */
  readonly bitqueryQueries: number;
  /** Rows valued by the re-price pass (a daily close arrived after the row was written). */
  readonly repriced: number;
  /** Candidate transactions never asked because the budget ran out. */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

/** Hashes per Bitquery query: one `in` list, one reply. */
const BATCH = 100;
/** Signatures per Helius parse request: the API's `maxItems`. */
const SOLANA_BATCH = 100;
/** ponytail: newest candidates per chain per run; the cron is every 15 min, so a slice a run drains a backlog without hogging the budget. Raise when `remaining` stays high. */
const SOLANA_LIMIT = 3000;  // 30 parse requests, ~0.3 s each behind the host gate: well inside the budget after the EVM phase
const EVM_LIMIT = 2000;
/** ponytail: a route is a handful of hops; a transaction with more trades than this is not one wallet's swap anyway. */
const TRADES_PER_TX = 10;
/** Rows the re-price pass considers; older rows keep whatever they were written with. */
const REPRICE_DAYS = 30;
/** Raw transfer legs a candidate page reads; the walk stops once `limit` distinct pairs are held. */
const CAND_PAGE = 2000;
/** Rows per `wallet_swaps` insert: 10 columns x 9 rows = 90 of D1's 100 bind parameters. */
const SWAP_WRITE_CHUNK = 9;
/** Rows per `wallet_swaps_checked` insert: 3 columns x 30 rows = 90 parameters. */
const CHECKED_WRITE_CHUNK = 30;

/** Quote assets, keyed `network_id:token_key`, with the three prices `priceQuote` chooses from. */
async function loadQuotes(sql: Sql): Promise<Map<string, Quote>> {
  const rows = await sql<{ network_id: number; token_key: string; symbol: string; pegged_usd: number | null; closes: string; market_price: number | null }[]>`
    select q.network_id, q.token_key, q.symbol, q.pegged_usd,
           (select coalesce(json_group_object(p.day, p.usd), '{}') from token_prices p
             where p.network_id = q.network_id and p.token_key = q.token_key and q.pegged_usd is null) as closes,
           (select h.price from holdings_current h
             where h.network_id = q.network_id and h.token_key = q.token_key
               and h.price is not null and h.price_source is not null
               and h.price_source <> 'fomo_reported_entry'
             order by h.priced_at desc limit 1) as market_price
    from quote_assets q`;
  /* A stablecoin's peg is the honest price; a floating quote takes its daily close, else the portfolio's market price; unpriced still resolves. */
  return new Map(rows.map((q) => [`${q.network_id}:${q.token_key}`, {
    symbol: q.symbol,
    pegged: q.pegged_usd,
    closes: new Map(Object.entries(JSON.parse(q.closes) as Record<string, number>)),
    market: q.market_price,
  }]));
}

/** Each chain's wrapped native: the quote asset a native leg is recorded against. */
async function loadNativeQuotes(sql: Sql, quotes: ReadonlyMap<string, Quote>): Promise<Map<number, NativeQuote>> {
  const rows = await sql<{ network_id: number; native_symbol: string; token_key: string }[]>`
    select c.network_id, c.native_symbol, q.token_key
    from chains c
    join quote_assets q on q.network_id = c.network_id
     and upper(q.symbol) = 'W' || upper(c.native_symbol)`;
  const out = new Map<number, NativeQuote>();
  for (const r of rows) {
    const quote = quotes.get(`${r.network_id}:${r.token_key}`);
    if (quote) out.set(r.network_id, { key: r.token_key, quote });
  }
  return out;
}

/**
 * The newest `limit` transactions on this chain not yet asked about, one per (tx, wallet). On
 * Solana only rows Helius tagged SWAP are candidates; EVM rows carry no type. D1 runs one
 * statement at a time with no room for an aggregate over the whole feed, so the group-by became
 * newest-first pages of raw transfer legs deduped here: `block_time` is the cursor (every leg of
 * a transaction carries its block's time, so a page that adds no new pair ends the walk) and a
 * leg with no time is skipped, since it can neither be ordered nor resume the walk.
 */
async function candidates(sql: Sql, net: number, limit: number): Promise<Cand[]> {
  const out = new Map<string, Cand>();
  let cursor: string | null = null;
  while (out.size < limit) {
    const page: Cand[] = await sql<Cand[]>`
      select t.tx_hash, t.address_key, t.block_time
      from transactions t
      where t.network_id = ${net} and t.block_time is not null
        ${net === SOLANA_NETWORK_ID ? sql`and t.tx_type = 'SWAP'` : sql``}
        ${cursor === null ? sql`` : sql`and t.block_time <= ${cursor}`}
        and not exists (
          select 1 from wallet_swaps_checked s
          where s.network_id = ${net} and s.tx_hash = t.tx_hash and s.address_key = t.address_key)
      order by t.block_time desc
      limit ${CAND_PAGE}`;
    const before = out.size;
    for (const r of page) {
      const key = `${r.tx_hash}|${r.address_key}`;
      const held = out.get(key);
      /* `min(t.block_time)` of the group the SQL took: the earliest leg wins. */
      if (!held || r.block_time < held.block_time) out.set(key, r);
      if (out.size >= limit) break;
    }
    if (page.length < CAND_PAGE || out.size === before) break;
    cursor = page[page.length - 1].block_time;
  }
  return [...out.values()].slice(0, limit);
}

async function writeRows(sql: Sql, net: number, out: readonly Priced[]): Promise<void> {
  if (!out.length) return;
  await sql.begin(async (tx) => {
    /* Issued with no await between them, so the shim flushes the whole set as ONE atomic d1 batch. */
    await Promise.all(chunk(out, SWAP_WRITE_CHUNK).map((part) =>
      tx.unsafe(
        `insert into wallet_swaps
           (network_id, tx_hash, address_key, block_time, token_key, token_delta,
            quote_key, quote_delta, quote_usd, quote_source, resolved_at)
         values ${part.map(() => "(?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").join(",")}
         on conflict do nothing`,
        part.flatMap((p) => [
          net, p.cand.tx_hash, p.cand.address_key, p.cand.block_time, p.row.tokenKey, p.row.tokenDelta,
          p.row.quoteKey, p.row.quoteDelta, p.row.quoteUsd, p.row.quoteSource,
        ]),
      )));
  });
}

/** Every candidate a source answered for is done, swap or not; the anti-join skips it from now on. */
async function markChecked(sql: Sql, net: number, cands: readonly Cand[]): Promise<void> {
  if (!cands.length) return;
  await sql.begin(async (tx) => {
    await Promise.all(chunk(cands, CHECKED_WRITE_CHUNK).map((part) =>
      tx.unsafe(
        `insert into wallet_swaps_checked (network_id, tx_hash, address_key)
         values ${part.map(() => "(?,?,?)").join(",")}
         on conflict do nothing`,
        part.flatMap((c) => [net, c.tx_hash, c.address_key]),
      )));
  });
}

/**
 * Helius Enhanced Transactions for a slice of signatures, one POST
 * (https://www.helius.dev/docs/api-reference/enhanced-transactions/gettransactions: body
 * `{ transactions: [<= 100 signatures] }`, key as `?api-key=`), keyed by `signature`. Helius
 * drops a signature it cannot parse, so a missing key is an unresolved candidate. A reply that
 * is not an array is a refusal.
 */
async function solanaTxs(url: string, hashes: readonly string[]): Promise<Map<string, unknown>> {
  const r = await throttled(url, () => fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactions: hashes }), signal: AbortSignal.timeout(45_000),
  }));
  if (!r.ok) throw new Error(`Helius parse HTTP ${r.status} for ${hashes.length} signatures`);
  const reply: unknown = await r.json();
  if (!Array.isArray(reply)) throw new Error(`Helius answered without an array for ${hashes.length} signatures`);
  const out = new Map<string, unknown>();
  for (const t of reply) {
    const sig = typeof t === "object" && t !== null ? (t as { signature?: unknown }).signature : undefined;
    if (typeof sig === "string") out.set(sig, t);
  }
  return out;
}

/** ONE HELIUS PARSE REQUEST: the wallet's net legs per transaction, priced, written, marked. Returns [resolved, not the wallet's own two-sided swap]. */
async function resolveSolanaBatch(sql: Sql, url: string, quotes: ReadonlyMap<string, Quote>, slice: readonly Cand[]): Promise<[number, number]> {
  const txs = await solanaTxs(url, [...new Set(slice.map((c) => c.tx_hash))]);
  const out: Priced[] = [];
  for (const cand of slice) {
    const d = solanaDecodeEnhanced(txs.get(cand.tx_hash), cand.address_key);
    const row = d && toRow(d, quotes, null, new Date(cand.block_time));
    if (row) out.push({ cand, row });
  }
  if (out.length) await writeRows(sql, SOLANA_NETWORK_ID, out);
  await markChecked(sql, SOLANA_NETWORK_ID, slice);
  return [out.length, slice.length - out.length];
}

/**
 * Every decoded DEX trade in a batch of transactions, grouped by hash (lower-case). Fields per
 * https://docs.bitquery.io/docs/schema/evm/dextrades/ (`Trade { Buy { Amount Buyer Seller
 * Currency { SmartContract } } Sell { ... } }`, `Transaction { Hash From }`) and
 * NOT `Native`: the DEXTrades currency type has no such field (the Balances cube does), and asking
 * for it failed every EVM batch with a GraphQL error until 17 Sep 2026. Native shows as
 * `SmartContract: "0x"` here, which `tokenOf` already reads.
 * https://docs.bitquery.io/docs/examples/dextrades/trades-of-an-address-api/ (`Buy.Buyer` /
 * `Buy.Seller` are the two roles a wallet can hold); `Amount` is in human units, as every
 * Bitquery amount is. The hash filter is `Transaction: { Hash: { in: $hashes } }` per
 * https://docs.bitquery.io/docs/graphql/filters/. `network` is a GraphQL enum, so it goes in
 * the query text; `limit` is explicit because the cube's default is smaller than a batch.
 */
async function tradesByHash(ctx: Ctx, hashes: readonly string[]): Promise<Map<string, Trade[]>> {
  const query = `query ($hashes: [String!]) {
    EVM(network: ${ctx.network}, dataset: realtime) {
      DEXTrades(where: { Transaction: { Hash: { in: $hashes } } }, limit: { count: ${hashes.length * TRADES_PER_TX} }) {
        Transaction { Hash From }
        Trade {
          Buy { Amount Buyer Seller Currency { SmartContract } }
          Sell { Amount Buyer Seller Currency { SmartContract } }
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

/** ONE QUERY PER BATCH: Bitquery's decoded trades, netted per wallet, priced, written, marked. Returns [resolved, not a two-token trade]. */
async function resolveBatch(ctx: Ctx, slice: readonly Cand[]): Promise<[number, number]> {
  const trades = await tradesByHash(ctx, [...new Set(slice.map((c) => c.tx_hash))]);
  const out: Priced[] = [];
  for (const cand of slice) {
    const d = decode(trades.get(cand.tx_hash.toLowerCase()) ?? [], cand.address_key);
    const row = d && toRow(d, ctx.quotes, ctx.wrapped, new Date(cand.block_time));
    if (row) out.push({ cand, row });
  }
  if (out.length) await writeRows(ctx.sql, ctx.net, out);
  await markChecked(ctx.sql, ctx.net, slice);
  return [out.length, slice.length - out.length];
}

/**
 * The deleted Solana script's final update, scoped: rows written unpriced in the last
 * `REPRICE_DAYS` get the peg or the daily close of their block day once `quote_prices` has
 * loaded it. Signed like the writer (`quote_delta` x unit price). Returns rows valued.
 */
async function reprice(sql: Sql): Promise<number> {
  const res = await sql`
    update wallet_swaps
       set quote_usd = wallet_swaps.quote_delta * coalesce(q.pegged_usd, p.usd),
           quote_source = case when q.pegged_usd is not null then 'money_side_pegged' else 'money_side_daily_close' end
      from quote_assets q
      left join token_prices p
        on p.network_id = q.network_id and p.token_key = q.token_key and q.pegged_usd is null
     where q.network_id = wallet_swaps.network_id and q.token_key = wallet_swaps.quote_key
       and (q.pegged_usd is not null or p.day = substr(wallet_swaps.block_time, 1, 10))
       and coalesce(q.pegged_usd, p.usd) is not null
       and wallet_swaps.quote_usd is null
       and wallet_swaps.block_time > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${REPRICE_DAYS} days`})`;
  return res.count;
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
 * One pass, Solana then every EVM chain, over the newest unresolved transactions within
 * `budgetMs`, then the re-price pass. Throws only when batches were attempted and every one
 * failed, so the cron shows as failed.
 */
export async function runSwaps(env: Env, budgetMs: number): Promise<SwapsSummary> {
  const started = Date.now();
  const key = (env.BITQUERY_KEY ?? "").trim();
  if (!key) throw new Error("swaps: BITQUERY_KEY is not set");
  const helius = (env.HELIUS_SOLANA_KEY ?? "").trim();
  if (!helius) throw new Error("swaps: HELIUS_SOLANA_KEY is not set; Solana is read through Helius only");
  const heliusUrl = `https://api.helius.xyz/v0/transactions?api-key=${helius}`;
  const sql = jobSql(env);
  const perChain: Record<string, ChainCounts> = {};
  let remaining = 0, stoppedEarly = false, attempted = 0, failedBatches = 0, bitqueryQueries = 0;
  /** Slices of one chain's candidates through `resolve`, within the budget; bookkeeping is the same for both sources. */
  const drain = async (name: string, cands: readonly Cand[], batch: number, resolve: (slice: readonly Cand[]) => Promise<[number, number]>): Promise<ChainCounts> => {
    const counts: ChainCounts = { resolved: 0, unresolved: 0, failed: 0, queries: 0 };
    perChain[name] = counts;
    let i = 0;
    for (; i < cands.length; i += batch) {
      if (Date.now() - started > budgetMs) { stoppedEarly = true; break; }
      const slice = cands.slice(i, i + batch);
      attempted += 1;
      counts.queries += 1;
      try {
        const [resolved, unresolved] = await resolve(slice);
        counts.resolved += resolved; counts.unresolved += unresolved;
      } catch (e) {
        failedBatches += 1; counts.failed += slice.length;
        console.error(`swaps: ${name} batch ${i / batch + 1} of ${slice.length} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    remaining += Math.max(0, cands.length - i);
    return counts;
  };
  try {
    const chains: Chain[] = (await sql<{ network_id: number; name: string }[]>`
      select network_id, name from chains order by (network_id = ${SOLANA_NETWORK_ID}) asc, name`)  // EVM first: 20 Bitquery calls; Solana's slower slice takes what is left
      .map((r) => ({ ...r, network_id: Number(r.network_id) }));
    const quotes = await loadQuotes(sql);
    const natives = await loadNativeQuotes(sql, quotes);
    for (const c of chains) {
      if (c.network_id === SOLANA_NETWORK_ID) {
        const solQuotes = quotesOn(SOLANA_NETWORK_ID, quotes);
        await drain(c.name, await candidates(sql, SOLANA_NETWORK_ID, SOLANA_LIMIT), SOLANA_BATCH,
          (slice) => resolveSolanaBatch(sql, heliusUrl, solQuotes, slice));
        continue;
      }
      const ctx: Ctx = {
        sql, key, net: c.network_id, network: networkWord(c),
        quotes: quotesOn(c.network_id, quotes), wrapped: natives.get(c.network_id) ?? null,
      };
      const counts = await drain(c.name, await candidates(sql, c.network_id, EVM_LIMIT), BATCH, (slice) => resolveBatch(ctx, slice));
      bitqueryQueries += counts.queries;
    }
    if (attempted > 0 && failedBatches === attempted) throw new Error(`swaps: all ${attempted} batches failed`);
    const repriced = await reprice(sql);
    return { perChain, bitqueryQueries, repriced, remaining, stoppedEarly, elapsedMs: Date.now() - started };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
