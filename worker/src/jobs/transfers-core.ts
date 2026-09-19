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
  /** W2: 1 once the backward Solana walk reached the end of the wallet's history. */
  readonly sol_backfill_done?: number | null;
  /** W2: the oldest Solana signature we already hold, the `before` the next page starts at. */
  readonly sol_oldest_signature?: string | null;
  /** The newest Solana signature a PULL (not the webhook) stored: where the next head pull stops. */
  readonly sol_newest_pulled_signature?: string | null;
}

/** Chain word (as `Transfer.chain` names it) -> network_id. */
export const NETWORK_OF: ReadonlyMap<string, number> = new Map<string, number>([
  ["solana", SOLANA_NETWORK_ID],
  ...Object.entries(EVM_CHAINS).map(([id, cfg]): [string, number] => [cfg.name, Number(id)]),
]);

/** `source` means WHO TOLD US — the provider, not the protocol Helius attributes. */
export const providerOf = (chain: string): string =>
  chain === "solana" ? "helius" : "bitquery";

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

/** A chain error that means the SOURCE is turning us away, as opposed to this wallet having a problem. */
export const isSourceRefusal = (error: string | null): boolean => error !== null && /HTTP (?:403|429)\b|rejected the key/i.test(error);

/** Wallets whose Solana history is not all in yet, in the order given; `limit` of them are walked back per run. */
export const walkBackTargets = <W extends Wallet>(targets: readonly W[], limit: number): W[] =>
  targets.filter((w) => w.sol_address && w.sol_backfill_done !== 1 && w.sol_oldest_signature).slice(0, limit);

/**
 * The upsert for `rows` rows of 13 binds. A conflict that would change nothing is NOT a write: Bitquery has
 * no lower bound, so every hourly pull re-reads the newest 100 transfers per EVM chain per wallet, and each
 * was rewritten only to move `ingested_at` (which nothing reads). Here so tests/transfers_upsert_test.ts runs it.
 */
export const upsertText = (rows: number): string =>
  `insert into transactions
     (network_id, tx_hash, address_key, transfer_key, block_time, direction,
      counterparty, token_key, token_symbol, amount, source, tx_type, tx_source)
   values ${Array.from({ length: rows }, () => "(?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}
   on conflict (network_id, tx_hash, address_key, transfer_key) do update set
     block_time = excluded.block_time, token_symbol = excluded.token_symbol,
     amount = excluded.amount, source = excluded.source,
     tx_type = coalesce(excluded.tx_type, transactions.tx_type),
     tx_source = coalesce(excluded.tx_source, transactions.tx_source),
     ingested_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   where transactions.block_time is not excluded.block_time
      or transactions.token_symbol is not excluded.token_symbol
      or transactions.amount is not excluded.amount
      or transactions.source is not excluded.source
      or (excluded.tx_type is not null and transactions.tx_type is not excluded.tx_type)
      or (excluded.tx_source is not null and transactions.tx_source is not excluded.tx_source)`;
