import type { Env } from "../env";
import { jobSql, type Sql } from "../sql";
import { rpc, SOLANA_NETWORK_ID } from "../../../supabase/functions/_shared/chain_reads.ts";
import { bitquery } from "../../../supabase/functions/_shared/bitquery.ts";
import { EVM_CHAINS } from "../../../supabase/functions/_shared/settings.ts";
import { type BatchRead, type Fee, readBatch, readBitqueryFees } from "./fees-core";
import { chunk } from "./directory-core";

/**
 * Transaction fees, the Worker half of the three "Read transaction fees" steps and "Refresh
 * trader fees" in `.github/workflows/refresh.yml`.
 *
 * TWIN OF `scripts/load_transaction_fees.mjs` + `scripts/refresh_trader_fees.mjs`: edit all
 * three. Same pending query, same insert, same rollup CTE. Differs where the platform does:
 * each chain gets a SLICE of its oldest unpriced transactions per run under a wall-clock budget
 * (the anti-join makes the next run continue), a failed batch is counted rather than fatal, and
 * the rollup rebuilds only the traders this run touched, in place (the script's one-trader
 * path), instead of the whole table behind a swap. The script's whole-table rollup branch is
 * gone with it: D1 runs one statement at a time, so every rollup statement is scoped to a chunk.
 * And the EVM fee is Bitquery's `Fee.SenderFee` rather than gasUsed x effectiveGasPrice from a
 * public node: since 17 Sep 2026 no free JSON-RPC endpoint is called from the Worker. Solana
 * stays on Helius.
 */

interface Chain { readonly network_id: number; readonly name: string; readonly native_symbol: string }
interface Step { readonly chain: string; readonly batch: number; readonly swapsOnly: boolean }
interface Pending { readonly hashes: readonly string[]; readonly addresses: ReadonlySet<string>; readonly total: number }
interface ChainCount { receipts: number; failed: number; bitqueryQueries: number }

/** Hashes per Bitquery query: one `in` list, one reply, ≤ 100 records. */
const BITQUERY_BATCH = 100;
/** The workflow's steps, in its order; EVM chains take a Bitquery batch, Solana Helius's 10. */
const STEPS: readonly Step[] = [
  { chain: "bsc", batch: BITQUERY_BATCH, swapsOnly: false },
  { chain: "ethereum", batch: BITQUERY_BATCH, swapsOnly: false },
  { chain: "base", batch: BITQUERY_BATCH, swapsOnly: false },
  { chain: "solana", batch: 10, swapsOnly: true },
];
/** ponytail: oldest unpriced transactions per chain per run; raise when the backlog is measured to lag the cron. */
const SLICE = 1000;
/** Traders per rollup statement, as the script: a 25-trader chunk stays inside D1's 30 s a statement. */
const ROLLUP_CHUNK = 25;
/** Rows per `transaction_fees` insert: 5 columns x 18 rows = 90 of D1's 100 bind parameters. */
const FEE_WRITE_CHUNK = 18;
/** Share of the budget the reads leave for phase 2. */
const ROLLUP_SHARE = 0.25;
const EVM_SOURCE = "bitquery EVM.Transactions Fee.SenderFee";
const SOLANA_SOURCE = "helius getTransaction";

export interface RollupSummary {
  /** Traders touched by this run's receipts. */
  readonly traders: number;
  /** `trader_fees_daily` rows rebuilt. */
  readonly dayRows: number;
  /** Traders whose chunk failed; their days keep the previous totals. */
  readonly failed: number;
}

export interface FeesSummary {
  /** Per chain: fees written, batches that failed or were refused, Bitquery queries sent. */
  readonly perChain: Record<string, ChainCount>;
  readonly rollup: RollupSummary;
  /** Bitquery queries sent across the EVM chains. */
  readonly bitqueryQueries: number;
  /** Unpriced transactions left across the chains. Zero means the backlog is clear. */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

async function chains(sql: Sql): Promise<Map<string, Chain>> {
  const rows = await sql<{ network_id: number; name: string; native_symbol: string }[]>`
    select network_id, name, native_symbol from chains where name in (${STEPS.map((s) => s.chain)})`;
  return new Map(rows.map((r) => [r.name, r]));
}

/**
 * The transactions we still have no fee for, oldest first: the union of both places a hash can
 * appear (`wallet_swaps` for a per-trade fee, `transactions` for a per-window total) anti-joined
 * against `transaction_fees`, which is what makes a repeat run free. The addresses come along
 * so phase 2 knows which traders to roll up.
 */
async function pending(sql: Sql, net: number, swapsOnly: boolean): Promise<Pending> {
  /* `union all`, not `union`: the group by already collapses a transaction's repeated legs. */
  const rows = await sql<{ tx_hash: string; addrs: string; total: number }[]>`
    select t.tx_hash, json_group_array(distinct t.address_key) as addrs, count(*) over () as total
      from (
        select tx_hash, address_key, block_time from wallet_swaps
         where network_id = ${net}
        ${swapsOnly ? sql`` : sql`union all
        select tx_hash, address_key, block_time from transactions
         where network_id = ${net}`}
      ) t
     where not exists (
       select 1 from transaction_fees f where f.network_id = ${net} and f.tx_hash = t.tx_hash)
     group by t.tx_hash
     order by min(t.block_time) is null, min(t.block_time)
     limit ${SLICE}`;
  return {
    hashes: rows.map((r) => r.tx_hash),
    addresses: new Set(rows.flatMap((r) => JSON.parse(r.addrs) as string[])),
    total: rows[0]?.total ?? 0,
  };
}

async function writeFees(sql: Sql, net: number, fees: readonly Fee[], symbol: string, source: string): Promise<void> {
  if (!fees.length) return;
  await sql.begin(async (tx) => {
    /* Issued with no await between them, so the shim flushes the whole set as ONE atomic d1 batch. */
    await Promise.all(chunk(fees, FEE_WRITE_CHUNK).map((part) =>
      tx.unsafe(
        `insert into transaction_fees (network_id, tx_hash, fee_native, fee_native_symbol, source)
         values ${part.map(() => "(?,?,?,?,?)").join(",")}
         on conflict (network_id, tx_hash) do nothing`,
        part.flatMap((f) => [net, f.hash, Number(f.fee), symbol, source]),
      )));
  });
}

/** Helius `getTransaction` for a slice of signatures, one JSON-RPC batch. */
async function solanaFees(url: string, hashes: readonly string[]): Promise<BatchRead | null> {
  const body = hashes.map((h, id) =>
    ({ jsonrpc: "2.0", id, method: "getTransaction", params: [h, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }] }));
  return readBatch(await rpc(url, body), hashes);
}

/**
 * The paid fee of each hash from Bitquery's transaction cube, in the chain's coin. `Fee.SenderFee`
 * (with `SenderFeeInUSD`) is the fee the sender paid per
 * https://docs.bitquery.io/docs/blockchain/Ethereum/fees/fees-api/ and
 * https://docs.bitquery.io/docs/usecases/mempool-transaction-fee/ (`Fee { Burnt SenderFee
 * PriorityFeePerGas MinerReward GasRefund EffectiveGasPrice Savings }`); `Transaction.Cost` is
 * "gas used multiplied by the gas price" per
 * https://docs.bitquery.io/docs/examples/transactions/transaction-api/ and the fallback. The hash
 * filter is `Transaction: { Hash: { in: $hashes } }` per
 * https://docs.bitquery.io/docs/graphql/filters/ (string operators `is, not, in, notIn, ...`) and
 * https://docs.bitquery.io/docs/blockchain/Ethereum/ethers-library/eth_getTransactionReceipt/.
 * `network` is a GraphQL enum, so it goes in the query text; `limit` is explicit because the
 * cube's default is smaller than a batch.
 */
async function evmFees(key: string, network: string, hashes: readonly string[]): Promise<BatchRead | null> {
  const query = `query ($hashes: [String!]) {
    EVM(network: ${network}, dataset: realtime) {
      Transactions(where: { Transaction: { Hash: { in: $hashes } } }, limit: { count: ${hashes.length} }) {
        Transaction { Hash Cost }
        Fee { SenderFee }
      }
    }
  }`;
  return readBitqueryFees(await bitquery(key, query, { hashes }), hashes);
}

/** Bitquery's word for an EVM chain in `chains`; a chain it has no word for is a configuration error. */
function networkWord(c: Chain): string {
  const w = EVM_CHAINS[c.network_id]?.bitquery;
  if (!w || !/^[a-z0-9_]+$/.test(w)) throw new Error(`fees: no Bitquery network word for chain '${c.name}' (${c.network_id})`);
  return w;
}

interface Reader { readonly source: string; readonly read: (hashes: readonly string[]) => Promise<BatchRead | null> }

/** One chain's slice, in batches, until the slice ends, the provider refuses, or `deadline` passes. Returns how many hashes got an answer. */
async function readChain(sql: Sql, c: Chain, step: Step, hashes: readonly string[], reader: Reader, count: ChainCount, deadline: number): Promise<number> {
  let answered = 0;
  for (let i = 0; i < hashes.length; i += step.batch) {
    if (Date.now() > deadline) break;
    const slice = hashes.slice(i, i + step.batch);
    try {
      if (c.network_id !== SOLANA_NETWORK_ID) count.bitqueryQueries += 1;
      const read = await reader.read(slice);
      if (read === null) {
        /* A refusal, not an empty answer: stop this chain rather than write a hole. */
        count.failed += 1;
        console.error(`fees: ${c.name} provider refused a batch of ${slice.length}`);
        break;
      }
      await writeFees(sql, c.network_id, read.fees, c.native_symbol, reader.source);
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

/**
 * The traders behind a set of address keys: the inverse of the rollup's `w` CTE. `wallets` holds
 * one row per trader, so the whole (small) table is matched here instead of binding a set of
 * addresses that would not fit D1's 100 parameters a statement.
 */
async function handlesOf(sql: Sql, addresses: ReadonlySet<string>): Promise<string[]> {
  if (!addresses.size) return [];
  const rows = await sql<{ handle: string; evm_address_key: string | null; sol_address_key: string | null }[]>`
    select handle, evm_address_key, sol_address_key from wallets`;
  return rows
    .filter((r) => (r.evm_address_key !== null && addresses.has(r.evm_address_key))
      || (r.sol_address_key !== null && addresses.has(r.sol_address_key)))
    .map((r) => r.handle).sort();
}

/**
 * The script's one-trader path over a chunk: replace those traders' rows in place, in one
 * transaction. DISTINCT is the whole point: `transactions` holds one row per transfer leg, and
 * one transaction pays one fee however many legs it moved.
 */
async function rollupChunk(sql: Sql, handles: readonly string[]): Promise<number> {
  return await sql.begin(async (tx) => {
    /* Issued with no await between them, so the shim flushes both as ONE atomic d1 batch. */
    void tx`delete from trader_fees_daily where handle in (${handles})`;
    const r = tx`
      insert into trader_fees_daily (handle, network_id, day, fee_native, tx_count)
      with w as (
        select handle, evm_address_key as address_key from wallets
         where evm_address_key is not null and handle in (${handles})
        union all
        select handle, sol_address_key as address_key from wallets
         where sol_address_key is not null and handle in (${handles})
      ),
      tx as (
        select distinct w.handle, t.network_id, t.tx_hash, t.block_time
        from w
        join transactions t on t.address_key = w.address_key
      )
      select tx.handle, tx.network_id, substr(tx.block_time, 1, 10) as day,
             sum(f.fee_native) as fee_native,
             count(*)          as tx_count
      from tx
      join transaction_fees f
        on f.network_id = tx.network_id and f.tx_hash = tx.tx_hash
      where tx.block_time is not null
      group by tx.handle, tx.network_id, substr(tx.block_time, 1, 10)`;
    return (await r).count;
  });
}

/**
 * Phase 1: one slice per chain in the workflow's order, under the read share of the budget.
 * Phase 2: the daily rollup for the traders those receipts belong to. Phase 2 is bounded by
 * its chunks (one D1 statement each), not by the budget: a trader whose fees landed but
 * whose days were not rebuilt would keep stale totals for good, since the anti-join never
 * offers those transactions again. Throws only when batches were sent and every one failed.
 */
export async function runFees(env: Env, budgetMs: number): Promise<FeesSummary> {
  const started = Date.now();
  const readDeadline = started + budgetMs * (1 - ROLLUP_SHARE);
  const helius = (env.HELIUS_SOLANA_KEY ?? "").trim();
  const bitqueryKey = (env.BITQUERY_KEY ?? "").trim();
  if (!bitqueryKey) throw new Error("fees: BITQUERY_KEY is not set");
  const sql = jobSql(env);
  try {
    const byName = await chains(sql);
    const perChain: Record<string, ChainCount> = {};
    const touched = new Set<string>();
    let remaining = 0, stoppedEarly = false;
    for (const step of STEPS) {
      const c = byName.get(step.chain);
      if (!c) throw new Error(`fees: chain '${step.chain}' is not in \`chains\``);
      const count: ChainCount = { receipts: 0, failed: 0, bitqueryQueries: 0 };
      perChain[c.name] = count;
      if (c.network_id === SOLANA_NETWORK_ID && !helius) { console.log(`fees: ${c.name} skipped, HELIUS_SOLANA_KEY is not set`); continue; }
      const reader: Reader = c.network_id === SOLANA_NETWORK_ID
        ? { source: SOLANA_SOURCE, read: (h) => solanaFees(`https://mainnet.helius-rpc.com/?api-key=${helius}`, h) }
        : { source: EVM_SOURCE, read: (h) => evmFees(bitqueryKey, networkWord(c), h) };
      const p = await pending(sql, c.network_id, step.swapsOnly);
      const answered = p.hashes.length ? await readChain(sql, c, step, p.hashes, reader, count, readDeadline) : 0;
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
    const bitqueryQueries = counts.reduce((n, c) => n + c.bitqueryQueries, 0);
    return { perChain, rollup, bitqueryQueries, remaining, stoppedEarly, elapsedMs: Date.now() - started };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
