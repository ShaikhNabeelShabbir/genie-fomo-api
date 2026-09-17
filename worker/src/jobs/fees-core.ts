/**
 * Pure half of the fee loader (`./fees.ts`): the Solana batch-reply reader (ported from
 * `scripts/load_transaction_fees.mjs`) and the Bitquery `EVM.Transactions` reader. No imports
 * and no I/O, so `tests/fees_core_test.ts` runs it under Deno.
 */

export interface Fee { readonly hash: string; readonly fee: string }
/** What one reply yielded. `null` means the provider REFUSED the batch (a non-list reply). */
export interface BatchRead { readonly fees: readonly Fee[]; readonly missing: number }

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
 * reading it as "no fee" would write a silent hole across the chain. An id never sent is never
 * trusted; a null result is `missing`.
 */
export function readBatch(reply: unknown, hashes: readonly string[]): BatchRead | null {
  if (!Array.isArray(reply)) return null;
  const fees: Fee[] = [];
  let missing = 0;
  for (const r of reply) {
    if (!isRecord(r) || typeof r.id !== "number") continue;
    const hash = hashes[r.id];
    if (!hash) continue;
    const fee = r.result ? solanaFee(r.result) : null;
    if (fee === null) { missing += 1; continue; }
    fees.push({ hash, fee });
  }
  return { fees, missing };
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
 * when it is absent. A hash not in the reply is `missing`; a reply without the list is a refusal.
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
  return { fees: [...fees].map(([hash, fee]) => ({ hash, fee })), missing: hashes.length - fees.size };
}
