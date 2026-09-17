import { SOL_MINT, SOLANA_NETWORK_ID } from "../../../supabase/functions/_shared/chain_reads.ts";
import { EVM_CHAINS } from "../../../supabase/functions/_shared/settings.ts";
import type { Transfer } from "../../../supabase/functions/_shared/transactions.ts";

/**
 * Pure half of the transfer backfill: the row shaping and dedupe of
 * scripts/backfill_transactions.mjs, and the webhook pick of scripts/register_webhook.mjs.
 * No I/O: tested in tests/transfers_core_test.ts.
 */

export type Cell = string | number | null;
/**
 * One `transactions` row, positional, in the bind order the insert in transfers.ts names:
 * network_id, tx_hash, address_key, block_time, direction, counterparty, token_key,
 * token_symbol, amount, source, tx_type, tx_source.
 */
export type Row = [number, string, string, string | null, Cell, Cell, Cell, Cell, Cell, string, Cell, Cell];

export interface Wallet {
  readonly handle: string;
  readonly evm_address: string | null;
  readonly sol_address: string | null;
}

/** Chain word (as `Transfer.chain` names it) -> network_id. */
export const NETWORK_OF: ReadonlyMap<string, number> = new Map<string, number>([
  ["solana", SOLANA_NETWORK_ID],
  ...Object.entries(EVM_CHAINS).map(([id, cfg]): [string, number] => [cfg.name, Number(id)]),
]);

/** `source` means WHO TOLD US — the provider, not the protocol Helius attributes. */
export const providerOf = (chain: string): string =>
  chain === "solana" ? "helius" : chain === "robinhood" ? "blockscout" : "bitquery";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Rows for the wallet the transfers were fetched FOR; solana rows key on the solana wallet. */
export function toRows(w: Wallet, transfers: readonly Transfer[]): Row[] {
  const rows: Row[] = [];
  for (const t of transfers) {
    const net = NETWORK_OF.get(t.chain);
    if (net === undefined || !t.tx_hash) continue;
    const addr = net === SOLANA_NETWORK_ID ? w.sol_address : w.evm_address;
    if (!addr) continue;
    // `side` is relative to the wallet we asked about, so the counterparty is the other end
    // of that leg — not simply `to`.
    const counterparty = t.side === "in" ? t.from : t.to;
    // A native lamport movement is labelled "native" by the fetch; it is stored under SOL's
    // `quote_assets` address so the row can be priced. The webhook writes the same key.
    const contract = t.contract ? String(t.contract).toLowerCase() : null;
    rows.push([
      net, t.tx_hash, addr.toLowerCase(),
      t.time_iso ?? (t.time ? new Date(t.time * 1000).toISOString() : null),
      t.side ?? null,
      counterparty ? String(counterparty).toLowerCase() : null,
      contract === "native" ? SOL_MINT : contract,
      t.token ?? null,
      num(t.amount),
      providerOf(t.chain),
      t.type ?? null,   // SWAP / TRANSFER / ... — a swap is a trade, a transfer often is not
      t.source ?? null, // the protocol, where the provider attributes one
    ]);
  }
  return rows;
}

/**
 * Postgres refuses an ON CONFLICT statement that touches the same row twice, so byte-identical
 * transfers must collapse BEFORE the insert. Keyed on exactly the fields the SQL digest uses.
 */
export function dedupe(rows: readonly Row[]): Row[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r[0]}|${r[1]}|${r[2]}|${r[6] ?? ""}|${r[4] ?? ""}|${r[5] ?? ""}|${r[8] ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function chunk<T>(list: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
}

export interface Webhook { readonly webhookID: string; readonly webhookURL: string }

/** The two fields of a Helius webhook listing this job reads. */
export function webhooksOf(list: unknown): Webhook[] {
  if (!Array.isArray(list)) return [];
  const out: Webhook[] = [];
  for (const w of list) {
    if (typeof w !== "object" || w === null) continue;
    const { webhookID, webhookURL } = w as Record<string, unknown>;
    if (typeof webhookID === "string") out.push({ webhookID, webhookURL: typeof webhookURL === "string" ? webhookURL : "" });
  }
  return out;
}

/** The webhook to update: ours by URL, else the first one (idempotent: never a second webhook). */
export function pickWebhook(existing: readonly Webhook[], target: string): Webhook | null {
  return existing.find((w) => w.webhookURL === target) ?? existing[0] ?? null;
}
