/**
 * Pure parts of the launch job: narrow guards over Solana JSON-RPC replies and the base64
 * decode, tested in tests/launches_core_test.ts; and the target statement, which takes `sql` so
 * tests/launches_targets_test.ts can run it.
 */
import type { Sql } from "../d1.ts";

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

export interface Target { readonly address: string; readonly token_key: string; readonly created_at: string | null }

/**
 * Held or recently traded tokens of one chain, unread or ungraduated; stalest first (ascending
 * already puts a never-read token first in SQLite). Each set is read ONCE into an `in` list, which
 * SQLite indexes, and every token seeks it. They were two left joins over derived tables, which it
 * does not index: every token scanned both sets end to end, 39 s at 31k tokens, past D1's 30 s,
 * so the job died on its first statement every night.
 */
export const launchTargets = (sql: Sql, net: number) => sql<Target[]>`
  select tk.address, tk.token_key, tk.created_at
    from tokens tk
   where tk.network_id = ${net}
     and (tk.launch_read_at is null or tk.graduated = 0)
     and (tk.token_key in (select token_key from holdings_current where network_id = ${net})
          or tk.token_key in (select token_key from transactions
                               where network_id = ${net}
                                 and block_time > strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')))
   order by tk.launch_read_at, tk.address`;
