/**
 * Pure half of the fee loader (`./fees.ts`): the fee arithmetic and the batch-reply reader,
 * ported one-for-one from `scripts/load_transaction_fees.mjs`. No imports and no I/O, so
 * `tests/fees_core_test.ts` runs it under Deno.
 */

export type FeeKind = "evm" | "solana";
export interface Fee { readonly hash: string; readonly fee: string }
/** What one JSON-RPC batch reply yielded. `null` means the node REFUSED the batch. */
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

/** gasUsed x effectiveGasPrice, exact in wei, then scaled to the native coin (18 decimals). */
export function evmFee(receipt: unknown): string | null {
  if (!isRecord(receipt)) return null;
  const g = receipt.gasUsed, p = receipt.effectiveGasPrice;
  if (typeof g !== "string" || typeof p !== "string") return null;
  try { return scaled(BigInt(g) * BigInt(p), 18); } catch { return null; }
}

/** `meta.fee` in lamports, scaled to SOL (9 decimals), as a string so nothing rounds. */
export function solanaFee(tx: unknown): string | null {
  if (!isRecord(tx) || !isRecord(tx.meta)) return null;
  const lamports = tx.meta.fee;
  if (typeof lamports !== "number" || !Number.isInteger(lamports)) return null;
  return scaled(BigInt(lamports), 9);
}

/**
 * Read one batch reply against the hashes it was sent for (ids are indexes into `hashes`).
 * A reply that is not an array is a REFUSAL, not an empty answer: base once returned HTTP 200
 * carrying "maximum 10 calls in 1 batch", and reading that as "no fee" would write a silent
 * hole across a whole chain. An id never sent is never trusted; a null result is `missing`.
 */
export function readBatch(reply: unknown, hashes: readonly string[], kind: FeeKind): BatchRead | null {
  if (!Array.isArray(reply)) return null;
  const fees: Fee[] = [];
  let missing = 0;
  for (const r of reply) {
    if (!isRecord(r) || typeof r.id !== "number") continue;
    const hash = hashes[r.id];
    if (!hash) continue;
    const res = r.result;
    if (!res) { missing += 1; continue; }
    const fee = kind === "solana" ? solanaFee(res) : evmFee(res);
    if (fee === null) { missing += 1; continue; }
    fees.push({ hash, fee });
  }
  return { fees, missing };
}
