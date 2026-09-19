/**
 * Pure half of the fee loader (`./fees.ts`): the Solana batch-reply reader (ported from
 * `scripts/load_transaction_fees.mjs`), the Bitquery `EVM.Transactions` reader, and the queue's two
 * statements, which take `sql` so `tests/fees_core_test.ts` and `tests/fees_queue_test.ts` run them under Deno.
 */
import type { Sql } from "../d1.ts";
import { chunk } from "./directory-core.ts";

export interface Fee { readonly hash: string; readonly fee: string }
/**
 * What one reply yielded. `absent` holds the hashes the source ANSWERED and had no fee for; a hash in
 * neither list was not answered and stays in the queue. `null` means the provider REFUSED the batch.
 */
export interface BatchRead { readonly fees: readonly Fee[]; readonly absent: readonly string[] }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** An integer count of base units as a decimal string with `decimals` places, trailing zeros dropped. */
function scaled(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** `meta.fee` in lamports, scaled to SOL (9 decimals), as a string so nothing rounds. */
export function solanaFee(tx: unknown): string | null {
  if (!isRecord(tx) || !isRecord(tx.meta)) return null;
  const lamports = tx.meta.fee;
  if (typeof lamports !== "number" || !Number.isInteger(lamports)) return null;
  return scaled(BigInt(lamports), 9);
}

/**
 * Read one Helius `getTransaction` batch reply against the hashes it was sent for (ids are
 * indexes into `hashes`). A reply that is not an array is a REFUSAL, not an empty answer:
 * reading it as "no fee" would write a silent hole across the chain, and so is a list that answers
 * none of the hashes (every item rate-limited). An id never sent is never trusted; a null result is
 * `absent`; an item carrying `error` was not answered, so it is neither.
 */
export function readBatch(reply: unknown, hashes: readonly string[]): BatchRead | null {
  if (!Array.isArray(reply)) return null;
  const fees: Fee[] = [];
  const absent: string[] = [];
  for (const r of reply) {
    if (!isRecord(r) || typeof r.id !== "number") continue;
    const hash = hashes[r.id];
    if (!hash || r.error != null || !("result" in r)) continue;
    const fee = r.result ? solanaFee(r.result) : null;
    if (fee === null) absent.push(hash); else fees.push({ hash, fee });
  }
  return fees.length + absent.length ? { fees, absent } : null;
}

/** A non-negative decimal in native units, as Bitquery scales it; anything else is absent. */
function nativeDecimal(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v);
  return /^\d+(\.\d+)?$/.test(s) ? s : null;
}

/**
 * Read one Bitquery `EVM.Transactions` reply (`{ EVM: { Transactions: [{ Transaction: { Hash
 * Cost }, Fee: { SenderFee } }] } }`) against the hashes it was asked for. `Fee.SenderFee` is
 * what the sender paid in the chain's coin; `Transaction.Cost` (gas used x gas price) stands in
 * when it is absent. A hash not in the reply is `absent`; a reply without the list is a refusal.
 */
export function readBitqueryFees(data: unknown, hashes: readonly string[]): BatchRead | null {
  const evm = isRecord(data) && isRecord(data.EVM) ? data.EVM : null;
  if (!evm || !Array.isArray(evm.Transactions)) return null;
  const wanted = new Map(hashes.map((h) => [h.toLowerCase(), h]));
  const fees = new Map<string, string>();
  for (const row of evm.Transactions) {
    if (!isRecord(row) || !isRecord(row.Transaction) || typeof row.Transaction.Hash !== "string") continue;
    const hash = wanted.get(row.Transaction.Hash.toLowerCase());
    if (!hash || fees.has(hash)) continue;
    const fee = nativeDecimal(isRecord(row.Fee) ? row.Fee.SenderFee : undefined) ?? nativeDecimal(row.Transaction.Cost);
    if (fee !== null) fees.set(hash, fee);
  }
  return { fees: [...fees].map(([hash, fee]) => ({ hash, fee })), absent: hashes.filter((h) => !fees.has(h)) };
}

/** A miss is parked only once its transaction is this old: a fresh hash the source has not indexed yet is asked again next run. */
const PARK_AFTER_MS = 24 * 3_600_000;

/** The absent hashes old enough to park (`recordMisses`). An undated hash is parked: no later run could date it. */
export const parkable = (absent: readonly string[], blockTime: ReadonlyMap<string, string | null>, nowMs: number): string[] =>
  absent.filter((h) => {
    const at = blockTime.get(h) ?? null;
    return at === null || nowMs - Date.parse(at) > PARK_AFTER_MS;
  });

export interface Pending {
  readonly hashes: readonly string[];
  /** Each hash's block time, which is what `parkable` judges. */
  readonly blockTime: ReadonlyMap<string, string | null>;
  readonly addresses: ReadonlySet<string>;
  readonly total: number;
}

/**
 * The transactions we still have no fee for: the union of both places a hash can appear
 * (`wallet_swaps` for a per-trade fee, `transactions` for a per-window total) anti-joined against
 * `transaction_fees`, which is what makes a repeat run free. The addresses come along so phase 2
 * knows which traders to roll up.
 *
 * NEWEST FIRST, and a parked hash (`recordMisses`) waits `missRetryAgo` (a SQLite date
 * modifier) before it is offered again. It was oldest first with no trace of a miss, on a source
 * that only serves recent transactions: once a chain held `limit` hashes too old to answer, they
 * were re-asked on every run and no new transaction on that chain ever got a fee.
 */
export async function pending(sql: Sql, net: number, swapsOnly: boolean, limit: number, missRetryAgo: string): Promise<Pending> {
  /* `union all`, not `union`: the group by already collapses a transaction's repeated legs. */
  const rows = await sql<{ tx_hash: string; at: string | null; addrs: string; total: number }[]>`
    select t.tx_hash, min(t.block_time) as at, json_group_array(distinct t.address_key) as addrs, count(*) over () as total
      from (
        select tx_hash, address_key, block_time from wallet_swaps
         where network_id = ${net}
        ${swapsOnly ? sql`` : sql`union all
        select tx_hash, address_key, block_time from transactions
         where network_id = ${net}`}
      ) t
     where not exists (
       select 1 from transaction_fees f where f.network_id = ${net} and f.tx_hash = t.tx_hash)
       and not exists (
       select 1 from transaction_fee_misses m where m.network_id = ${net} and m.tx_hash = t.tx_hash
          and m.missed_at > strftime('%Y-%m-%dT%H:%M:%fZ','now',${missRetryAgo}))
     group by t.tx_hash
     order by min(t.block_time) desc
     limit ${limit}`;
  return {
    hashes: rows.map((r) => r.tx_hash),
    blockTime: new Map(rows.map((r) => [r.tx_hash, r.at])),
    addresses: new Set(rows.flatMap((r) => JSON.parse(r.addrs) as string[])),
    total: rows[0]?.total ?? 0,
  };
}

/** Rows per `transaction_fee_misses` insert: 3 columns x 30 rows = 90 of D1's 100 bind parameters. */
const MISS_WRITE_CHUNK = 30;

/** The source answered and had no row for these hashes (`parkable`): remember when, so they leave the head of the queue. */
export async function recordMisses(sql: Sql, net: number, hashes: readonly string[]): Promise<void> {
  if (!hashes.length) return;
  const now = new Date().toISOString();
  await sql.begin(async (tx) => {
    await Promise.all(chunk(hashes, MISS_WRITE_CHUNK).map((part) =>
      tx.unsafe(
        `insert into transaction_fee_misses (network_id, tx_hash, missed_at)
         values ${part.map(() => "(?,?,?)").join(",")}
         on conflict (network_id, tx_hash) do update set missed_at = excluded.missed_at`,
        part.flatMap((h) => [net, h, now]),
      )));
  });
}
