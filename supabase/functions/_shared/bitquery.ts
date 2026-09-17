/**
 * Bitquery GraphQL client, shared by the transfer fetch and the EVM balance read.
 *
 * Balances come from here and not from public JSON-RPC since 17 Sep 2026: Cloudflare's shared
 * egress gets HTTP 429 from Robinhood's and Base's public nodes (the first balances cron lost
 * 4 of 28 chain reads), and Bitquery is the one paid indexer already in the bill.
 */
import { throttled, ZERO_ADDRESS } from "./chain_reads.ts";

/**
 * DATASET IS `realtime` EVERYWHERE. The plan (checked 17 Sep 2026) allows only the realtime
 * dataset; `combined` and `archive` answer 403 "access restricted". Realtime `Balances`
 * still returns the full current balance per currency, and `TransactionBalances`,
 * `Transactions`, `DEXTrades` and `Transfers` answer for recent activity, which is what the
 * jobs ask for. Upgrade the plan before asking for history older than the realtime window.
 */
const ENDPOINT = "https://streaming.bitquery.io/graphql";

interface Reply { readonly data?: unknown; readonly errors?: readonly unknown[] }

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isReply = (v: unknown): v is Reply =>
  isRec(v) && (v.errors === undefined || Array.isArray(v.errors)) && (v.data === undefined || isRec(v.data));

/** One POST, throttled per host; a GraphQL error is thrown, a points/quota one under a fixed message. */
export async function bitquery(key: string, query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
  if (!key) throw new Error("BITQUERY_KEY is not set");
  const r = await throttled(ENDPOINT, () => fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(45_000),
  }));
  const text = await r.text();
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new Error(`Bitquery HTTP ${r.status}: ${text.slice(0, 160)}`); }
  if (!isReply(j)) throw new Error(`Bitquery HTTP ${r.status}: unexpected reply shape`);
  if (j.errors?.length) {
    const first = j.errors[0];
    const msg = isRec(first) && typeof first.message === "string" ? first.message : String(first);
    throw new Error(/points limit|quota/i.test(msg) ? "Bitquery quota reached" : msg.slice(0, 160));
  }
  if (!r.ok) throw new Error(`Bitquery HTTP ${r.status}`);
  return j.data;
}

export interface BitqueryBalance {
  /** Contract, lower-case; the chain's own coin under `ZERO_ADDRESS`, as `tokens` seeds it (N1). */
  readonly address: string;
  /** Human units, as Bitquery scales it. */
  readonly amount: string;
  /** Null when Bitquery did not say; never a made-up 0. */
  readonly decimals: number | null;
  readonly symbol: string | null;
}

/** Bitquery marks the native coin with `Currency.Native: true` and `SmartContract: "0x"`. */
const isNative = (cur: Record<string, unknown>): boolean => cur.Native === true || cur.SmartContract === "0x";

/**
 * `EVM.Balances` rows -> one balance per currency. Zero, negative and unreadable amounts are
 * dropped (a zero balance is not a holding); a currency listed twice is summed.
 */
export function parseBalances(data: unknown): BitqueryBalance[] {
  const evm = isRec(data) && isRec(data.EVM) ? data.EVM : {};
  const rows = Array.isArray(evm.Balances) ? evm.Balances : [];
  const out = new Map<string, BitqueryBalance>();
  for (const row of rows) {
    if (!isRec(row) || !isRec(row.Currency) || !isRec(row.Balance)) continue;
    const cur = row.Currency, bal = row.Balance;
    const native = isNative(cur);
    const contract = typeof cur.SmartContract === "string" ? cur.SmartContract.toLowerCase() : "";
    if (!native && !/^0x[0-9a-f]{40}$/.test(contract)) continue;
    const address = native ? ZERO_ADDRESS : contract;
    const amount = typeof bal.Amount === "string" || typeof bal.Amount === "number" ? String(bal.Amount) : "";
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) continue;
    const decimals = native ? 18 : Number.isInteger(cur.Decimals) ? (cur.Decimals as number) : null;
    const symbol = typeof cur.Symbol === "string" && cur.Symbol ? cur.Symbol : null;
    const prev = out.get(address);
    out.set(address, prev
      ? { ...prev, amount: String(Number(prev.amount) + n) }
      : { address, amount, decimals, symbol });
  }
  return [...out.values()];
}

/**
 * Every token one wallet holds on one EVM chain, native coin included, with no traded-token
 * list needed. `Balances` on `dataset: realtime` is Bitquery's "latest balances" cube; the
 * `selectWhere` keeps the reply to non-zero rows.
 *
 * Field names and the native marker per https://docs.bitquery.io/docs/examples/balances/balance-api/,
 * https://docs.bitquery.io/docs/cubes/balances-cube/ (`Currency: { Native: true }`) and
 * https://docs.bitquery.io/docs/blockchain/Ethereum/ethers-library/eth-getbalance/ (native =
 * `SmartContract: "0x"`). `EVM.BalanceUpdates` was removed on 15 Jun 2026; this is its replacement.
 *
 * BITQUERY_POINTS_PER_RUN: https://docs.bitquery.io/docs/ide/points/ prices `dataset: realtime`
 * at a flat 5 points per cube; for `combined` it only says points scale with records and
 * complexity and gives no figure, so the cost of one balance query is not stated. Measure it
 * in the IDE before sizing BALANCE_SLICE.
 *
 * `network` is Bitquery's word for the chain (`EVM_CHAINS[id].bitquery`): a GraphQL enum, so it
 * goes in the query text; the wallet travels as a variable.
 */
export async function evmBalancesBitquery(
  key: string, network: string, wallet: string,
): Promise<{ balances: BitqueryBalance[] }> {
  if (!/^[a-z0-9_]+$/.test(network)) throw new Error(`Bitquery network word "${network}" is not one`);
  const query = `query ($wallet: String!) {
    EVM(network: ${network}, dataset: realtime) {
      Balances(where: { Balance: { Address: { is: $wallet } } }) {
        Currency { Symbol SmartContract Native Decimals }
        Balance { Amount(selectWhere: { gt: "0" }) }
      }
    }
  }`;
  return { balances: parseBalances(await bitquery(key, query, { wallet })) };
}

/**
 * `EVM.Transactions[0].count` -> a number; null when the reply carries no count (never a made-up
 * 0). No row at all is a count of zero: the cube answered and matched nothing.
 */
export function parseTxCount(data: unknown): number | null {
  const evm = isRec(data) && isRec(data.EVM) ? data.EVM : null;
  if (!evm || !Array.isArray(evm.Transactions)) return null;
  if (evm.Transactions.length === 0) return 0;
  const first = evm.Transactions[0];
  const c = isRec(first) ? Number(first.count) : NaN;
  return Number.isInteger(c) && c >= 0 ? c : null;
}

/**
 * R6: how many transactions one wallet has SENT on one EVM chain, as the `count` metric over
 * `Transactions` (https://docs.bitquery.io/docs/graphql/metrics/count/: "returns the total
 * count of elements in each set of dimensions"; the cube and its `Transaction.From` filter per
 * https://docs.bitquery.io/docs/evm/transactions/). `dataset: realtime` is a WINDOW, not the
 * chain's history, so this is a lower bound on the nonce; /positions says so with
 * `coverage.chains[].basis: bitquery_realtime`.
 */
export async function evmTxCount(key: string, network: string, wallet: string): Promise<number | null> {
  if (!/^[a-z0-9_]+$/.test(network)) throw new Error(`Bitquery network word "${network}" is not one`);
  const query = `query ($wallet: String!) {
    EVM(network: ${network}, dataset: realtime) {
      Transactions(where: { Transaction: { From: { is: $wallet } } }) { count }
    }
  }`;
  return parseTxCount(await bitquery(key, query, { wallet }));
}
