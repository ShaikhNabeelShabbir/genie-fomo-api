/**
 * Pure half of the GMGN job (`./gmgn.ts`): the list-entry and activity parsers, the
 * person grouping and handle rule from `scripts/load_gmgn_traders.mjs`, and the per-token
 * fold from `scripts/load_gmgn_trades.mjs`. No imports and no I/O, so
 * `tests/gmgn_core_test.ts` runs it under Deno.
 */

/** GMGN chain word -> network_id. */
export const CHAINS: Readonly<Record<string, number>> = { sol: 1399811149, bsc: 56, base: 8453, eth: 1, robinhood: 4663 };
export const EVM_CHAINS: readonly string[] = ["bsc", "base", "eth", "robinhood"];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** GMGN returns "" — not null — for a missing twitter handle or name. Empty is missing. */
export const blank = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** Postgres rejects \u0000 in text outright, and some token symbols genuinely contain one. */
export const clean = (v: unknown): string | null =>
  typeof v === "string" ? v.replace(/\u0000/g, "").replace(/\\u0000/g, "") || null : null;

/** A finite number from a number or numeric string, else null. `null` is absent, never 0. */
export const num = (v: unknown): number | null => {
  if (typeof v !== "number" && typeof v !== "string") return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/** One wallet from `/v1/user/kol` or `/v1/user/smartmoney`. */
export interface DiscoveredWallet {
  readonly chain: string;
  readonly wallet: string;
  readonly twitter: string | null;
  readonly name: string | null;
  readonly avatar: string | null;
  readonly tags: readonly string[];
}

/** A list entry as a wallet, or null when it carries no `maker`. */
export function walletFrom(x: unknown, chain: string): DiscoveredWallet | null {
  if (!isRecord(x) || typeof x.maker !== "string" || x.maker === "") return null;
  const info = isRecord(x.maker_info) ? x.maker_info : {};
  const tags = Array.isArray(info.tags) ? info.tags.filter((t): t is string => typeof t === "string") : [];
  return {
    chain,
    wallet: x.maker,
    twitter: blank(info.twitter_username),
    name: blank(info.twitter_name) ?? blank(info.name),
    avatar: blank(info.avatar),
    tags,
  };
}

export interface Person {
  readonly twitter: string | null;
  readonly name: string | null;
  readonly avatar: string | null;
  readonly tags: readonly string[];
  readonly wallets: readonly { readonly chain: string; readonly wallet: string }[];
}

/** Collapse wallets into people. One twitter handle is one person across every chain. */
export function group(rows: readonly DiscoveredWallet[]): Person[] {
  const people = new Map<string, Person>();
  for (const r of rows) {
    const id = r.twitter ? `tw:${r.twitter.toLowerCase()}` : `w:${r.wallet}`;
    const p = people.get(id) ?? { twitter: r.twitter, name: null, avatar: null, tags: [], wallets: [] };
    people.set(id, {
      twitter: p.twitter,
      name: p.name ?? r.name,
      avatar: p.avatar ?? r.avatar,
      tags: [...new Set([...p.tags, ...r.tags])],
      wallets: [...p.wallets, { chain: r.chain, wallet: r.wallet }],
    });
  }
  return [...people.values()];
}

/**
 * A handle that is stable, readable, and cannot collide with fomo's namespace: the twitter
 * handle when free, `gmgn_` + it when taken, else `gmgn_` + the first wallet's prefix.
 */
export function handleFor(person: Person, taken: ReadonlySet<string>): string {
  const tw = person.twitter?.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (tw && !taken.has(tw)) return tw;
  if (tw && !taken.has(`gmgn_${tw}`)) return `gmgn_${tw}`;
  return `gmgn_${person.wallets[0].wallet.slice(0, 10).toLowerCase()}`;
}

export interface TraderRow {
  readonly handle: string;
  readonly display_handle: string;
  readonly name: string | null;
  readonly avatar: string | null;
  readonly bio: string | null;
  readonly twitter: string | null;
  readonly sol: string | null;
  readonly evm: string | null;
}

/** The rows to add: people not already in the directory who have at least one address. */
export function newTraders(people: readonly Person[], existing: ReadonlySet<string>): TraderRow[] {
  const taken = new Set(existing);
  const out: TraderRow[] = [];
  for (const p of people) {
    const handle = handleFor(p, taken);
    if (taken.has(handle)) continue;
    taken.add(handle);
    const sol = p.wallets.find((w) => w.chain === "sol")?.wallet ?? null;
    const evm = p.wallets.find((w) => w.chain !== "sol")?.wallet ?? null;
    if (!sol && !evm) continue;
    out.push({
      handle,
      display_handle: p.twitter ?? handle,
      name: p.name,
      avatar: p.avatar,
      bio: p.tags.join(", ") || null,
      twitter: p.twitter,
      sol,
      evm,
    });
  }
  return out;
}

/** One per-(trader, token) position in the shape `trades` stores for fomo. */
export interface Position {
  readonly network_id: number;
  readonly token_key: string;
  readonly token_address: string;
  readonly token_symbol: string | null;
  readonly status: "open" | "closed";
  readonly amount: number | null;
  readonly avg_entry_price: number | null;
  readonly avg_exit_price: number | null;
  readonly realized_pnl_usd: number | null;
  readonly opened_at: string | null;
  readonly closed_at: string | null;
  readonly total_supply: number | null;
}

interface Acc {
  address: string; symbol: string | null; supply: number | null;
  qtyIn: number; costIn: number; qtyOut: number; proceeds: number; basis: number;
  firstBuy: number | null; lastSell: number | null; buys: number; sells: number;
}

/**
 * Fold one wallet's `wallet_activity` on one chain into per-token positions. transferIn /
 * transferOut are not trades and are skipped; a $0 price means "could not value", never
 * "got in for nothing", so it is null.
 */
export function fold(acts: readonly unknown[], networkId: number): Position[] {
  const byToken = new Map<string, Acc>();
  for (const a of acts) {
    if (!isRecord(a)) continue;
    const kind = a.event_type ?? a.type;
    if (kind !== "buy" && kind !== "sell") continue;
    const tok = isRecord(a.token) ? a.token : {};
    const addr = typeof tok.address === "string" && tok.address !== "" ? tok.address : null;
    if (!addr) continue;
    const key = addr.toLowerCase();
    const rec = byToken.get(key) ?? {
      address: addr, symbol: clean(tok.symbol), supply: num(tok.total_supply),
      qtyIn: 0, costIn: 0, qtyOut: 0, proceeds: 0, basis: 0, firstBuy: null, lastSell: null, buys: 0, sells: 0,
    };
    const qty = num(a.token_amount) ?? 0, usd = num(a.cost_usd);
    const t = num(a.timestamp);
    const ts = t ? t * 1000 : null;
    if (kind === "buy") {
      rec.buys++; rec.qtyIn += qty; if (usd !== null) rec.costIn += usd;
      if (ts && (rec.firstBuy === null || ts < rec.firstBuy)) rec.firstBuy = ts;
    } else {
      rec.sells++; rec.qtyOut += qty;
      if (usd !== null) rec.proceeds += usd;
      const b = num(a.buy_cost_usd); if (b !== null) rec.basis += b;
      if (ts && (rec.lastSell === null || ts > rec.lastSell)) rec.lastSell = ts;
    }
    rec.supply ??= num(tok.total_supply);
    byToken.set(key, rec);
  }
  return [...byToken].map(([key, r]) => {
    // Sold essentially everything they bought -> closed. 1% absorbs UI-unit rounding only.
    const closed = r.qtyIn > 0 && r.qtyOut >= r.qtyIn * 0.99;
    return {
      network_id: networkId, token_key: key, token_address: r.address, token_symbol: r.symbol,
      status: closed ? "closed" : "open",
      amount: r.qtyIn > 0 ? r.qtyIn : (r.qtyOut || null),
      avg_entry_price: r.qtyIn > 0 && r.costIn > 0 ? r.costIn / r.qtyIn : null,
      avg_exit_price: r.qtyOut > 0 && r.proceeds > 0 ? r.proceeds / r.qtyOut : null,
      realized_pnl_usd: r.sells > 0 && r.basis > 0 ? r.proceeds - r.basis : null,
      opened_at: r.firstBuy ? new Date(r.firstBuy).toISOString() : null,
      closed_at: closed && r.lastSell ? new Date(r.lastSell).toISOString() : null,
      total_supply: r.supply,
    };
  });
}
