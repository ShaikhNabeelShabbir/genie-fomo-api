/**
 * Pure parts of the launch job: narrow guards over Solana JSON-RPC replies and the base64
 * decode. No I/O: tested in tests/launches_core_test.ts.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The `error.message` of a JSON-RPC reply, or null when it carries none. */
export function rpcError(j: unknown): string | null {
  if (!isRecord(j) || !isRecord(j.error)) return null;
  return String(j.error.message ?? "rpc error").slice(0, 80);
}

/** `result.value.data[0]` of a base64 `getAccountInfo` reply; null when the account does not exist. */
export function accountData(j: unknown): string | null {
  if (!isRecord(j) || !isRecord(j.result) || !isRecord(j.result.value)) return null;
  const d = j.result.value.data;
  return Array.isArray(d) && typeof d[0] === "string" ? d[0] : null;
}

export interface Signature { readonly signature: string; readonly blockTime: number | null }

const isSignature = (v: unknown): v is Signature =>
  isRecord(v) && typeof v.signature === "string" && (v.blockTime === null || typeof v.blockTime === "number");

/** The `result` array of a `getSignaturesForAddress` reply, malformed entries dropped. */
export function signatures(j: unknown): Signature[] {
  const r = isRecord(j) ? j.result : undefined;
  return Array.isArray(r) ? r.filter(isSignature) : [];
}

export const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
