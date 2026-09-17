import type postgres from "postgres";
import type { Env } from "../env";
import { db } from "../db";
import { rpc, SOLANA_NETWORK_ID } from "../../../supabase/functions/_shared/chain_reads.ts";
import { type Fee, type FeeKind, readBatch } from "./fees-core";

/**
 * Transaction fees, the Worker half of the three "Read transaction fees" steps and "Refresh
 * trader fees" in `.github/workflows/refresh.yml`.
 *
 * TWIN OF `scripts/load_transaction_fees.mjs` + `scripts/refresh_trader_fees.mjs`: edit all
 * three. Same pending query, same fee arithmetic, same insert, same rollup CTE. Differs only
 * where the platform does: each chain gets a SLICE of its oldest unpriced transactions per
 * run under a wall-clock budget (the anti-join makes the next run continue), a failed batch
 * is counted rather than fatal, and the rollup rebuilds only the traders this run touched,
 * in place (the script's one-trader path), instead of the whole table behind a swap.
 */

type Sql = postgres.Sql;
interface Chain { readonly network_id: number; readonly name: string; readonly native_symbol: string; readonly rpc: string }
interface Step { readonly chain: string; readonly batch: number; readonly swapsOnly: boolean }
interface Pending { readonly hashes: readonly string[]; readonly addresses: ReadonlySet<string>; readonly total: number }
interface ChainCount { receipts: number; failed: number }

/** The workflow's steps, in its order and at its batch sizes (base refuses more than 10). */
const STEPS: readonly Step[] = [
  { chain: "bsc", batch: 100, swapsOnly: false },
  { chain: "ethereum", batch: 100, swapsOnly: false },
  { chain: "base", batch: 10, swapsOnly: false },
  { chain: "solana", batch: 10, swapsOnly: true },
];
/** ponytail: oldest unpriced transactions per chain per run; raise when the backlog is measured to lag the cron. */
const SLICE = 1000;
/** Traders per rollup statement, as the script: a 25-trader chunk finishes inside the statement timeout. */
const ROLLUP_CHUNK = 25;
/** Share of the budget the reads leave for phase 2. */
const ROLLUP_SHARE = 0.25;

export interface RollupSummary {
  /** Traders touched by this run's receipts. */
  readonly traders: number;
  /** `trader_fees_daily` rows rebuilt. */
  readonly dayRows: number;
  /** Traders whose chunk failed; their days keep the previous totals. */
  readonly failed: number;
}

export interface FeesSummary {
  /** Per chain: fees written and batches that failed or were refused. */
  readonly perChain: Record<string, ChainCount>;
  readonly rollup: RollupSummary;
  /** Unpriced transactions left across the chains. Zero means the backlog is clear. */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

async function chains(sql: Sql): Promise<Map<string, Chain>> {
  const rows = await sql<{ network_id: string; name: string; native_symbol: string; rpc: string }[]>`
    select network_id, name, native_symbol, rpc from chains where name = any(${STEPS.map((s) => s.chain)})`;
  return new Map(rows.map((r) => [r.name, { ...r, network_id: Number(r.network_id) }]));
}

/**
 * The transactions we still have no fee for, oldest first: the union of both places a hash can
 * appear (`wallet_swaps` for a per-trade fee, `transactions` for a per-window total) anti-joined
 * against `transaction_fees`, which is what makes a repeat run free. The addresses come along
 * so phase 2 knows which traders to roll up.
 */
async function pending(sql: Sql, net: number, swapsOnly: boolean): Promise<Pending> {
  const rows = await sql<{ tx_hash: string; addrs: string[]; total: string }[]>`
    select t.tx_hash, array_agg(distinct t.address_key) as addrs, count(*) over () as total
      from (
        select tx_hash, address_key, block_time from wallet_swaps
         where network_id = ${net}
        union
        select tx_hash, address_key, block_time from transactions
         where network_id = ${net} and ${swapsOnly}::bool is false
      ) t
     where not exists (
       select 1 from transaction_fees f where f.network_id = ${net} and f.tx_hash = t.tx_hash)
     group by t.tx_hash
     order by min(t.block_time) nulls last
     limit ${SLICE}`;
  return {
    hashes: rows.map((r) => r.tx_hash),
    addresses: new Set(rows.flatMap((r) => r.addrs)),
    total: Number(rows[0]?.total ?? 0),
  };
}

async function writeFees(sql: Sql, net: number, fees: readonly Fee[], symbol: string, source: string): Promise<void> {
  if (!fees.length) return;
  await sql`
    insert into transaction_fees (network_id, tx_hash, fee_native, fee_native_symbol, source)
    select ${net}, h, f::numeric, s, src
    from unnest(${fees.map((f) => f.hash)}::text[], ${fees.map((f) => f.fee)}::text[],
                ${fees.map(() => symbol)}::text[], ${fees.map(() => source)}::text[]) as u(h, f, s, src)
    on conflict (network_id, tx_hash) do nothing`;
}

const batchBody = (hashes: readonly string[], kind: FeeKind): unknown[] =>
  hashes.map((h, id) => kind === "solana"
    ? { jsonrpc: "2.0", id, method: "getTransaction", params: [h, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }] }
    : { jsonrpc: "2.0", id, method: "eth_getTransactionReceipt", params: [h] });

/** One chain's slice, in batches, until the slice ends, the node refuses, or `deadline` passes. Returns how many hashes got an answer. */
async function readChain(sql: Sql, c: Chain, step: Step, hashes: readonly string[], url: string, count: ChainCount, deadline: number): Promise<number> {
  const kind: FeeKind = c.network_id === SOLANA_NETWORK_ID ? "solana" : "evm";
  const source = kind === "solana" ? "helius getTransaction" : "eth_getTransactionReceipt";
  let answered = 0;
  for (let i = 0; i < hashes.length; i += step.batch) {
    if (Date.now() > deadline) break;
    const slice = hashes.slice(i, i + step.batch);
    try {
      const read = readBatch(await rpc(url, batchBody(slice, kind)), slice, kind);
      if (read === null) {
        /* A refusal, not an empty answer: stop this chain rather than write a hole. */
        count.failed += 1;
        console.error(`fees: ${c.name} node refused a batch of ${slice.length}`);
        break;
      }
      await writeFees(sql, c.network_id, read.fees, c.native_symbol, source);
      count.receipts += read.fees.length;
      answered += slice.length;
    } catch (e) {
      /* Counted, never fatal: the anti-join asks for these again next run. */
      count.failed += 1;
      console.error(`fees: ${c.name} batch of ${slice.length} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return answered;
}

/** The traders behind a set of address keys: the inverse of the rollup's `w` CTE. */
async function handlesOf(sql: Sql, addresses: ReadonlySet<string>): Promise<string[]> {
  if (!addresses.size) return [];
  const rows = await sql<{ handle: string }[]>`
    select distinct t.handle
      from traders t
      join wallets wl using (handle),
      lateral (values (wl.evm_address_key), (lower(wl.sol_address))) x(addr)
     where lower(x.addr) = any(${[...addresses]})`;
  return rows.map((r) => r.handle).sort();
}

/**
 * The script's one-trader path over a chunk: replace those traders' rows in place, in one
 * transaction. DISTINCT is the whole point: `transactions` holds one row per transfer leg, and
 * one transaction pays one fee however many legs it moved.
 */
async function rollupChunk(sql: Sql, handles: readonly string[]): Promise<number> {
  return await sql.begin(async (tx) => {
    await tx`delete from trader_fees_daily where handle = any(${handles})`;
    const r = await tx`
      insert into trader_fees_daily (handle, network_id, day, fee_native, tx_count)
      with w as (
        select t.handle, lower(x.addr) as address_key
        from traders t
        join wallets wl using (handle),
        lateral (values (wl.evm_address_key), (lower(wl.sol_address))) x(addr)
        where x.addr is not null
          and (${handles}::text[] is null or t.handle = any(${handles}))
      ),
      tx as (
        select distinct w.handle, t.network_id, t.tx_hash, t.block_time
        from w
        join transactions t on t.address_key = w.address_key
      )
      select tx.handle, tx.network_id, (tx.block_time at time zone 'utc')::date as day,
             sum(f.fee_native) as fee_native,
             count(*)::int     as tx_count
      from tx
      join transaction_fees f
        on f.network_id = tx.network_id and f.tx_hash = tx.tx_hash
      where tx.block_time is not null
      group by 1, 2, 3`;
    return r.count;
  });
}

/**
 * Phase 1: one slice per chain in the workflow's order, under the read share of the budget.
 * Phase 2: the daily rollup for the traders those receipts belong to. Phase 2 is bounded by
 * its chunks (statement timeout each), not by the budget: a trader whose fees landed but
 * whose days were not rebuilt would keep stale totals for good, since the anti-join never
 * offers those transactions again. Throws only when batches were sent and every one failed.
 */
export async function runFees(env: Env, budgetMs: number): Promise<FeesSummary> {
  const started = Date.now();
  const readDeadline = started + budgetMs * (1 - ROLLUP_SHARE);
  const helius = (env.HELIUS_SOLANA_KEY ?? "").trim();
  const sql = db(env);
  try {
    const byName = await chains(sql);
    const perChain: Record<string, ChainCount> = {};
    const touched = new Set<string>();
    let remaining = 0, stoppedEarly = false;
    for (const step of STEPS) {
      const c = byName.get(step.chain);
      if (!c) throw new Error(`fees: chain '${step.chain}' is not in \`chains\``);
      const count: ChainCount = { receipts: 0, failed: 0 };
      perChain[c.name] = count;
      if (c.network_id === SOLANA_NETWORK_ID && !helius) { console.log(`fees: ${c.name} skipped, HELIUS_SOLANA_KEY is not set`); continue; }
      const url = c.network_id === SOLANA_NETWORK_ID ? `https://mainnet.helius-rpc.com/?api-key=${helius}` : c.rpc;
      const p = await pending(sql, c.network_id, step.swapsOnly);
      const answered = p.hashes.length ? await readChain(sql, c, step, p.hashes, url, count, readDeadline) : 0;
      if (answered < p.hashes.length && Date.now() > readDeadline) stoppedEarly = true;
      remaining += p.total - answered;
      if (count.receipts > 0) for (const a of p.addresses) touched.add(a);
    }
    const counts = Object.values(perChain);
    if (counts.some((c) => c.failed > 0) && counts.every((c) => c.receipts === 0)) {
      throw new Error("fees: every batch on every chain failed");
    }

    const handles = await handlesOf(sql, touched);
    const rollup = { traders: handles.length, dayRows: 0, failed: 0 };
    for (let i = 0; i < handles.length; i += ROLLUP_CHUNK) {
      const chunk = handles.slice(i, i + ROLLUP_CHUNK);
      try {
        rollup.dayRows += await rollupChunk(sql, chunk);
      } catch (e) {
        /* Reported and skipped, never silently dropped: the transaction rolled back, so the chunk's traders keep their old totals. */
        rollup.failed += chunk.length;
        console.error(`fees: rollup chunk of ${chunk.length} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { perChain, rollup, remaining, stoppedEarly, elapsedMs: Date.now() - started };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
