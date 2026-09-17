import { num } from "./scorecards-core.ts";

/**
 * Pure half of the directory job (`./directory.ts`): the fomoapi leaderboard, trades and
 * balances parsers, the position merge, the build validation and the row shapes, ported
 * one-for-one from `loaders/build_directory_fomoapi.py` and `loaders/load_to_db.py`.
 * No I/O, so `tests/directory_test.ts` runs it under Deno.
 */

export const SOLANA_NETWORK_ID = 1399811149;
export const SOURCE = "fomoapi.io";

/** One leaderboard trader, the `entries` element of the python builder. */
export interface Entry {
  readonly handle: string;
  readonly name: string;
  readonly rank: number;
  /* fomo's provisioned evm/sol are not exposed by fomoapi and hold nothing anyway, so they stay empty rather than faked. */
  /* Third-party resolved wallets: a second opinion, not a verdict. */
  readonly srcEvm: string;
  readonly srcSol: string;
  readonly pnl: number;
  readonly volume: number;
  readonly trades: number;
  readonly followers: number;
  readonly avatar: string;
  readonly verified: boolean;
}

/** An open position from /trades, before its chain is known: fomoapi returns no chain id. */
export interface OpenTrade { readonly address: string; readonly amount: number; readonly price: number | null }

/** A current position, keyed (token, chain). */
export interface Position {
  readonly tokenAddress: string;
  readonly networkId: number;
  readonly humanAmount: number;
  readonly price: number | null;
  readonly value: number | null;
}

/** Column-keyed rows, spread into the inserts by postgres.js. */
export interface TraderRow {
  readonly handle: string; readonly display_handle: string; readonly name: string | null;
  readonly avatar: string | null; readonly bio: string | null; readonly twitter: string | null;
  readonly verified: boolean; readonly source: string;
}
export interface StatsRow {
  readonly handle: string; readonly captured_at: Date; readonly rank: number | null;
  readonly pnl_usd: number | null; readonly volume_usd: number | null;
  readonly trade_count: number | null; readonly followers: number | null;
}
export interface WalletRow {
  readonly handle: string; readonly evm_address: string | null; readonly evm_source: string | null;
  readonly sol_address: string | null; readonly sol_source: string | null;
}
export interface TokenRow { readonly network_id: number; readonly address: string }
export interface HoldingRow {
  readonly handle: string; readonly network_id: number; readonly token_key: string; readonly captured_at: Date;
  readonly human_amount: number | null; readonly price: number | null; readonly value: number | null;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
/** python `int(x or 0)`: a missing count is 0 there, so it is 0 here. */
const count = (v: unknown): number => Math.trunc(num(v) ?? 0);

/** `/v2/leaderboard/{window}` -> entries, in leaderboard order, capped at `topN`; nameless rows are dropped. */
export function parseLeaderboard(body: unknown, topN: number): Entry[] {
  const rows = isRecord(body) ? list(body.traders) : [];
  const out: Entry[] = [];
  rows.slice(0, topN).forEach((t, i) => {
    if (!isRecord(t)) return;
    const handle = str(t.handle);
    if (!handle) return;
    const w = isRecord(t.wallets) ? t.wallets : {};
    out.push({
      handle,
      name: str(t.displayName) || handle,
      rank: num(t.rank) || i + 1,
      srcEvm: str(w.evm).toLowerCase(),
      srcSol: str(w.solana),
      pnl: num(t.pnlUsd) ?? 0,
      volume: num(t.volumeUsd) ?? 0,
      trades: count(t.trades),
      followers: count(t.followers),
      avatar: str(t.avatar),
      verified: Boolean(t.verified),
    });
  });
  return out;
}

/** `/trades` is the ONLY source of EVM positions; measured ~6d stale, so sizes drift. Open, sized rows only. */
export function parseOpenTrades(body: unknown): OpenTrade[] {
  const out: OpenTrade[] = [];
  for (const t of isRecord(body) ? list(body.trades) : []) {
    if (!isRecord(t) || t.status !== "open") continue;
    const address = isRecord(t.token) ? str(t.token.address) : "";
    const amount = num(t.amount);
    if (!address || amount === null || amount <= 0) continue;
    out.push({ address, amount, price: num(t.avgEntryPrice) });
  }
  return out;
}

/** `/balances` is Solana-only but measured LIVE, and covers traders whose trades are all closed. A 0x here would be unexpected. */
export function parseBalances(body: unknown): Position[] {
  const out: Position[] = [];
  for (const h of isRecord(body) ? list(body.holdings) : []) {
    if (!isRecord(h)) continue;
    const address = isRecord(h.token) ? str(h.token.address) : "";
    const amount = num(h.amount);
    if (!address || address.startsWith("0x") || amount === null || amount <= 0) continue;
    out.push({ tokenAddress: address, networkId: SOLANA_NETWORK_ID, humanAmount: amount, price: num(h.priceUsd), value: num(h.valueUsd) });
  }
  return out;
}

/**
 * Merged and deduped by (token, chain); /balances wins on conflict for Solana since it is the
 * fresher number. Keyed on the lowercased address as the holdings table is (last write wins).
 */
export function mergePositions(trades: readonly (OpenTrade & { readonly networks: readonly number[] })[], balances: readonly Position[]): Position[] {
  const merged = new Map<string, Position>();
  for (const t of trades) {
    for (const networkId of t.networks) {
      merged.set(`${networkId}:${t.address.toLowerCase()}`, { tokenAddress: t.address, networkId, humanAmount: t.amount, price: t.price, value: null });
    }
  }
  for (const b of balances) merged.set(`${b.networkId}:${b.tokenAddress.toLowerCase()}`, b);
  return [...merged.values()];
}

/**
 * Refuse to publish a bad build: a partial response replacing a good directory is worse than
 * skipping the refresh. `prevTraderCount` is the newest `builds.trader_count` (the python read
 * the previous JSON file). Returns the reason, or null when the build may land.
 */
export function rejectBuild(entries: readonly Entry[], prevTraderCount: number | null): string | null {
  if (!entries.length) return "leaderboard returned no traders";
  const withAddr = entries.filter((e) => e.srcEvm || e.srcSol).length;
  if (withAddr < entries.length * 0.5) return `only ${withAddr}/${entries.length} traders have any address — refusing to publish`;
  if (prevTraderCount && entries.length < prevTraderCount * 0.8) {
    return `got ${entries.length} traders but the previous build has ${prevTraderCount} — refusing to shrink it by more than 20%`;
  }
  return null;
}

/** Lowercased canonical handle; the display handle keeps its case. */
export const canonical = (handle: string): string => handle.trim().toLowerCase();

export function traderRow(e: Entry): TraderRow {
  return { handle: canonical(e.handle), display_handle: e.handle.trim(), name: e.name, avatar: e.avatar, bio: "", twitter: "", verified: e.verified, source: SOURCE };
}

export function statsRow(e: Entry, captured: Date): StatsRow {
  return { handle: canonical(e.handle), captured_at: captured, rank: e.rank, pnl_usd: e.pnl, volume_usd: e.volume, trade_count: e.trades, followers: e.followers };
}

/** Provenance per chain so a consumer can tell Reported from Verified: these are REPORTED. Null when the trader has no address. */
export function walletRow(e: Entry): WalletRow | null {
  const evm = e.srcEvm.trim() || null;
  const sol = e.srcSol.trim() || null;
  if (!evm && !sol) return null;
  return { handle: canonical(e.handle), evm_address: evm, evm_source: evm ? SOURCE : null, sol_address: sol, sol_source: sol ? SOURCE : null };
}

/** Case is preserved on first sight: Solana base58 is case-SENSITIVE, and a lowercased address can no longer be queried. */
export function tokenRows(positions: readonly Position[]): TokenRow[] {
  const seen = new Map<string, TokenRow>();
  for (const p of positions) {
    const key = `${p.networkId}:${p.tokenAddress.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, { network_id: p.networkId, address: p.tokenAddress });
  }
  return [...seen.values()];
}

/** Nothing here coerces a missing value to 0: `holdings.value` stays null so unpriced rows are excluded from every aggregate. */
export function holdingRows(handle: string, captured: Date, positions: readonly Position[]): HoldingRow[] {
  return positions.map((p) => ({
    handle, network_id: p.networkId, token_key: p.tokenAddress.toLowerCase(), captured_at: captured,
    human_amount: p.humanAmount, price: p.price, value: p.value,
  }));
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}
