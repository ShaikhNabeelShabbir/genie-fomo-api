import type { Sql } from "../d1.ts";
import { MAX_POSITION_USD, MAX_PRICE_PER_TOKEN, suspectRows, value } from "../../../supabase/functions/aum-sample/value.ts";
import { chunk } from "./directory-core.ts";

/**
 * The two valuation functions, in TypeScript. D1 holds no functions, so the final Postgres
 * bodies of `aum_history_build` and `aum_live_refresh`
 * (supabase/migrations/20260918100000_valuation_v4_no_market.sql) live here: same hour rules,
 * same price ladders, same reasons, same upserts. The reads are a few bounded set-based
 * selects; the arithmetic is aum-sample/value.ts, which the SQL only ever transcribed.
 */

/** Bound ids per `in (…)`: D1 allows 100 parameters a statement, the rest of the clause needs a few. */
const IN_CHUNK = 80;
/** Rows per multi-row upsert; 10 columns x 9 rows = 90 parameters. */
const WRITE_CHUNK = 9;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A hourly sample older than this cannot price an hour (SQL: `ph.hour > b.hour - interval '24 hours'`). */
const HOURLY_STALE_MS = 24 * HOUR_MS;
/** The live ladder's daily rung reaches back a week (SQL: `tp.day > now()::date - 7`). */
const DAILY_STALE_DAYS = 7;
/** aum-rules.ts PRICED_FLOOR, as the two functions spelled it. */
const PRICED_FLOOR = 0.25;
/** Under this many dollars a mostly-unpriced reading says so instead of reporting the fragment. */
const TOO_LITTLE_USD = 100;

export type Reason = "no_holdings" | "no_prices" | "too_little_priced" | "price_suspect";

/** One position to value: the amount held, its price rung result and the token facts behind it. */
export interface Position {
  readonly amount: number;
  readonly price: number | null;
  readonly supply: number | null;
  readonly liquidityUsd: number | null;
  readonly unsellable: boolean;
  /** N1: a `quote_assets` row — a dollar coin or a chain's own coin. See value.ts SuspectRow. */
  readonly quoteAsset?: boolean;
}

export interface Valuation {
  /** Sum of the sellable, non-suspect, priced positions. Unrounded; null when `reason` is set. */
  readonly totalUsd: number | null;
  readonly suspectUsd: number | null;
  readonly unsellableUsd: number | null;
  readonly pricedPositions: number;
  readonly totalPositions: number;
  readonly reason: Reason | null;
}

const sumOrNull = (xs: readonly number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) : null);

const hourIso = (ms: number): string => new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString();
const dayOf = (iso: string): string => iso.slice(0, 10);

/**
 * The `classified` / `priced` / `computed` CTEs of both functions, over one partition (a trader
 * for the live refresh, an hour for the build). Branch order is the SQL's: no price, unsellable,
 * implied cap, concentration, the position ceiling, then no market behind the price.
 */
export function valueGroup(rows: readonly Position[]): Valuation {
  if (!rows.length) {
    return { totalUsd: null, suspectUsd: null, unsellableUsd: null, pricedPositions: 0, totalPositions: 0, reason: "no_holdings" };
  }
  const raw = rows.map((r) =>
    r.price === null || !Number.isFinite(r.price) || r.price <= 0 || r.price > MAX_PRICE_PER_TOKEN ? null : r.amount * r.price
  );
  // The concentration base is the sellable, priced gross: an unsellable row is not part of it.
  const reasons = suspectRows(rows.map((r, i) => ({
    price: r.price, supply: r.supply, usd: r.unsellable ? null : raw[i], liquidityUsd: r.liquidityUsd,
    quoteAsset: r.quoteAsset === true,
  })));
  const kinds = rows.map((r, i): "priced" | "suspect" | "unsellable" | "unpriced" => {
    const usd = raw[i];
    if (usd === null) return "unpriced";
    if (r.unsellable) return "unsellable";
    if (reasons[i] === "implied_mcap_over_ceiling" || reasons[i] === "concentration_over_ceiling") return "suspect";
    if (usd > MAX_POSITION_USD) return r.supply === null ? "suspect" : "unpriced";
    if (reasons[i] === "no_market_over_ceiling") return "suspect";
    return value(r.amount, r.price, r.supply).usd === undefined ? "unpriced" : "priced";
  });
  const pick = (kind: string): number[] =>
    raw.filter((usd, i): usd is number => kinds[i] === kind && usd !== null && (kind !== "priced" || usd > 0));
  const priced = pick("priced");
  const suspectUsd = sumOrNull(pick("suspect"));
  const total = sumOrNull(priced);
  const totalPositions = rows.length;
  const reason: Reason | null = priced.length === 0
    ? (suspectUsd !== null ? "price_suspect" : "no_prices")
    : priced.length / totalPositions < PRICED_FLOOR && (total ?? 0) < TOO_LITTLE_USD
    ? "too_little_priced"
    : null;
  return {
    totalUsd: reason === null ? total : null,
    suspectUsd,
    unsellableUsd: sumOrNull(pick("unsellable")),
    pricedPositions: priced.length,
    totalPositions,
    reason,
  };
}

// ------------------------------------------------------------------ token facts and prices

interface TokenRef { readonly networkId: number; readonly tokenKey: string }

/** Everything about a token that does not depend on which hour is being valued. */
interface Facts {
  supply: number | null;
  liquidity: number | null;
  unsellable: boolean;
  pegged: number | null;
  infoPrice: number | null;
  statsLast: number | null;
  /** N1: the token is in `quote_assets` at all, pegged or floating. */
  quoteAsset: boolean;
}

const factsKey = (networkId: number, tokenKey: string): string => `${networkId}|${tokenKey}`;
const emptyFacts = (): Facts => ({ supply: null, liquidity: null, unsellable: false, pegged: null, infoPrice: null, statsLast: null, quoteAsset: false });

/** `network_id -> token_key[]`, so every `in (…)` stays inside one chain and inside 80 binds. */
function byNetwork(refs: readonly TokenRef[]): Map<number, string[]> {
  const out = new Map<number, Set<string>>();
  for (const r of refs) (out.get(r.networkId) ?? out.set(r.networkId, new Set()).get(r.networkId)!).add(r.tokenKey);
  return new Map([...out].map(([n, keys]) => [n, [...keys]]));
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const positive = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};

/**
 * The `left join tokens / token_info / quote_assets / token_price_hourly` half of both
 * functions, plus `token_price_stats` for the live ladder. One statement per rung per chunk.
 */
async function loadFacts(sql: Sql, refs: readonly TokenRef[], withStats: boolean): Promise<Map<string, Facts>> {
  const out = new Map<string, Facts>();
  const at = (networkId: number, tokenKey: string): Facts => {
    const k = factsKey(networkId, tokenKey);
    const f = out.get(k) ?? emptyFacts();
    out.set(k, f);
    return f;
  };
  for (const [networkId, all] of byNetwork(refs)) {
    for (const keys of chunk(all, IN_CHUNK)) {
      const info = await sql<{ token_key: string; is_honeypot: number | null; can_not_sell: number | null; total_supply: number | null; liquidity_usd: number | null; price_usd: number | null }[]>`
        select token_key, is_honeypot, can_not_sell, total_supply, liquidity_usd, price_usd
          from token_info where network_id = ${networkId} and token_key in (${keys})`;
      for (const r of info) {
        const f = at(networkId, r.token_key);
        f.unsellable = r.is_honeypot === 1 || r.can_not_sell === 1;
        f.supply = positive(r.total_supply);
        f.liquidity = num(r.liquidity_usd);
        f.infoPrice = positive(r.price_usd);
      }
      const toks = await sql<{ token_key: string; total_supply: number | null }[]>`
        select token_key, total_supply from tokens where network_id = ${networkId} and token_key in (${keys})`;
      // `coalesce(nullif(tk.total_supply, 0), nullif(ti.total_supply, 0))`: the token row wins.
      for (const r of toks) {
        const f = at(networkId, r.token_key);
        f.supply = positive(r.total_supply) ?? f.supply;
      }
      const pegs = await sql<{ token_key: string; pegged_usd: number | null }[]>`
        select token_key, pegged_usd from quote_assets
         where network_id = ${networkId} and token_key in (${keys})`;
      for (const r of pegs) {
        const f = at(networkId, r.token_key);
        /* Membership alone exempts the row from the market checks; only a positive peg prices it. */
        f.quoteAsset = true;
        if (typeof r.pegged_usd === "number" && r.pegged_usd > 0) f.pegged = r.pegged_usd;
      }
      // V1d liquidity: the best pair's, from the latest hourly sample, else GMGN's (already set).
      const liq = await sql<{ token_key: string; liquidity_usd: number | null }[]>`
        select token_key, liquidity_usd from (
          select token_key, liquidity_usd, row_number() over (partition by token_key order by hour desc) as rn
            from token_price_hourly where network_id = ${networkId} and token_key in (${keys})
        ) where rn = 1`;
      for (const r of liq) {
        const f = at(networkId, r.token_key);
        f.liquidity = num(r.liquidity_usd) ?? f.liquidity;
      }
      if (!withStats) continue;
      const stats = await sql<{ token_key: string; last_usd: number }[]>`
        select token_key, last_usd from token_price_stats
         where network_id = ${networkId} and token_key in (${keys}) and last_usd > 0`;
      for (const r of stats) at(networkId, r.token_key).statsLast = r.last_usd;
    }
  }
  return out;
}

// ------------------------------------------------------------------ aum_history_build

interface Balance { readonly networkId: number; readonly tokenKey: string; readonly amount: number }

interface ReadingRow { readonly total_usd: number; readonly priced_positions: number | null; readonly total_positions: number | null }

/** `insert … on conflict (handle, hour) do update`, in chunks of 9 rows. Returns rows written. */
async function writeHistory(
  sql: Sql,
  rows: readonly { handle: string; hour: string; v: Valuation; basis: "reading" | "priced" }[],
): Promise<number> {
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  let written = 0;
  await sql.begin(async (tx) => {
    for (const part of chunk(rows, WRITE_CHUNK)) {
      const values = part.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",");
      const params = part.flatMap((r) => [
        r.handle, r.hour, r.v.totalUsd, r.v.suspectUsd, r.v.unsellableUsd,
        r.v.pricedPositions, r.v.totalPositions, r.basis, r.v.reason, now,
      ]);
      written += (await tx.unsafe(
        `insert into aum_history
           (handle, hour, total_usd, suspect_usd, unsellable_usd, priced_positions, total_positions, basis, reason, computed_at)
         values ${values}
         on conflict (handle, hour) do update set
           total_usd = excluded.total_usd, suspect_usd = excluded.suspect_usd,
           unsellable_usd = excluded.unsellable_usd, priced_positions = excluded.priced_positions,
           total_positions = excluded.total_positions, basis = excluded.basis,
           reason = excluded.reason, computed_at = excluded.computed_at`,
        params,
      )).count;
    }
  });
  return written;
}

/**
 * `aum_history_build(p_handle, p_from, p_to)`: every hour from `fromIso` to `toIso` inclusive,
 * a sampled reading first, else a rebuilt one, else the latest chain capture per network before
 * the hour ends, valued on the ladder peg -> hourly (<= 24 h stale) -> that day's close ->
 * token_info (current hour only). Returns hours written.
 */
export async function buildAumHistory(sql: Sql, handle: string, fromIso: string, toIso: string): Promise<number> {
  const first = Math.floor(new Date(fromIso).getTime() / HOUR_MS) * HOUR_MS;
  const last = Math.floor(new Date(toIso).getTime() / HOUR_MS) * HOUR_MS;
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return 0;
  const hours: number[] = [];
  for (let t = first; t <= last; t += HOUR_MS) hours.push(t);
  const windowEnd = new Date(last + HOUR_MS).toISOString();

  // Rule 1: a measurement inside the hour wins — sampled first, else rebuilt, newest first.
  const samples = await sql<{ at: string; basis: string; total_usd: number; priced_positions: number | null; total_positions: number | null }[]>`
    select at, basis, total_usd, priced_positions, total_positions
      from aum_samples
     where handle = ${handle} and basis in ('sampled', 'rebuilt') and total_usd is not null
       and at >= ${new Date(first).toISOString()} and at < ${windowEnd}`;
  const readings = new Map<string, { at: string; basis: string; row: ReadingRow }>();
  for (const s of samples) {
    const h = hourIso(new Date(s.at).getTime());
    const held = readings.get(h);
    const better = !held
      || (s.basis === "sampled" && held.basis !== "sampled")
      || (s.basis === held.basis && s.at > held.at);
    if (better) readings.set(h, { at: s.at, basis: s.basis, row: s });
  }

  // Rule 2: per (hour, network), the latest chain capture before the hour ends.
  const before = await sql<{ network_id: number; captured_at: string | null }[]>`
    select network_id, max(captured_at) as captured_at from holdings
     where handle = ${handle} and source = 'chain' and captured_at < ${new Date(first + HOUR_MS).toISOString()}
     group by network_id`;
  const inside = await sql<{ network_id: number; captured_at: string }[]>`
    select distinct network_id, captured_at from holdings
     where handle = ${handle} and source = 'chain'
       and captured_at >= ${new Date(first + HOUR_MS).toISOString()} and captured_at < ${windowEnd}
     order by captured_at`;
  const latest = new Map<number, string>();
  for (const r of before) if (r.captured_at !== null) latest.set(r.network_id, r.captured_at);
  const pending = [...inside];
  /** (hour index) -> (network_id -> captured_at) as the window is walked forward. */
  const capturesOf: Map<number, string>[] = [];
  for (const t of hours) {
    const end = new Date(t + HOUR_MS).toISOString();
    while (pending.length && pending[0].captured_at < end) {
      const c = pending.shift()!;
      latest.set(c.network_id, c.captured_at);
    }
    capturesOf.push(readings.has(new Date(t).toISOString()) ? new Map() : new Map(latest));
  }

  const used = [...new Set(capturesOf.flatMap((m) => [...m.values()]))];
  const rowsAt = new Map<string, Balance[]>();
  for (const part of chunk(used, IN_CHUNK)) {
    const held = await sql<{ network_id: number; token_key: string; captured_at: string; human_amount: number }[]>`
      select network_id, token_key, captured_at, human_amount from holdings
       where handle = ${handle} and source = 'chain' and human_amount > 0 and captured_at in (${part})`;
    for (const r of held) {
      const k = `${r.network_id}|${r.captured_at}`;
      (rowsAt.get(k) ?? rowsAt.set(k, []).get(k)!).push({ networkId: r.network_id, tokenKey: r.token_key, amount: r.human_amount });
    }
  }

  const refs: TokenRef[] = [...rowsAt.values()].flat().map((b) => ({ networkId: b.networkId, tokenKey: b.tokenKey }));
  const facts = await loadFacts(sql, refs, false);

  // Ladder rungs 2 and 3, for the whole window at once.
  const hourly = new Map<string, { hour: string; usd: number }[]>();
  const daily = new Map<string, number>();
  for (const [networkId, all] of byNetwork(refs)) {
    for (const keys of chunk(all, IN_CHUNK)) {
      const ph = await sql<{ token_key: string; hour: string; usd: number }[]>`
        select token_key, hour, usd from token_price_hourly
         where network_id = ${networkId} and token_key in (${keys}) and usd > 0
           and hour > ${new Date(first - HOURLY_STALE_MS).toISOString()} and hour <= ${new Date(last).toISOString()}
         order by hour`;
      for (const r of ph) {
        const k = factsKey(networkId, r.token_key);
        (hourly.get(k) ?? hourly.set(k, []).get(k)!).push(r);
      }
      const tp = await sql<{ token_key: string; day: string; usd: number }[]>`
        select token_key, day, usd from token_prices
         where network_id = ${networkId} and token_key in (${keys}) and usd > 0
           and day >= ${dayOf(new Date(first).toISOString())} and day <= ${dayOf(new Date(last).toISOString())}`;
      for (const r of tp) daily.set(`${factsKey(networkId, r.token_key)}|${r.day}`, r.usd);
    }
  }

  const currentHour = hourIso(Date.now());
  const out = hours.map((t, i) => {
    const hour = new Date(t).toISOString();
    const reading = readings.get(hour);
    if (reading) {
      return {
        handle, hour, basis: "reading" as const,
        v: {
          totalUsd: reading.row.total_usd, suspectUsd: null, unsellableUsd: null,
          pricedPositions: reading.row.priced_positions ?? 0,
          totalPositions: reading.row.total_positions ?? 0,
          reason: null,
        } satisfies Valuation,
      };
    }
    const balances = [...capturesOf[i]].flatMap(([networkId, at]) => rowsAt.get(`${networkId}|${at}`) ?? []);
    const positions = balances.map((b): Position => {
      const k = factsKey(b.networkId, b.tokenKey);
      const f = facts.get(k) ?? emptyFacts();
      const window = hourly.get(k);
      const sample = window?.reduce<{ hour: string; usd: number } | null>(
        (best, r) => (r.hour <= hour && new Date(r.hour).getTime() > t - HOURLY_STALE_MS && (!best || r.hour > best.hour) ? r : best),
        null,
      );
      const price = f.pegged
        ?? sample?.usd
        ?? daily.get(`${k}|${dayOf(hour)}`)
        ?? (hour === currentHour ? f.infoPrice : null)
        ?? null;
      return { amount: b.amount, price, supply: f.supply, liquidityUsd: f.liquidity,
               unsellable: f.unsellable, quoteAsset: f.quoteAsset };
    });
    return { handle, hour, basis: "priced" as const, v: valueGroup(positions) };
  });
  return await writeHistory(sql, out);
}

// ------------------------------------------------------------------ aum_live_refresh

/** Traders with a wallet, optionally narrowed to `handles` and to those whose live value is stale. */
async function liveTargets(
  sql: Sql, handles: readonly string[] | null, olderThanHours: number | undefined,
): Promise<string[]> {
  const cutoff = olderThanHours === undefined ? null : new Date(Date.now() - olderThanHours * HOUR_MS).toISOString();
  const stale = cutoff === null ? sql`` : sql`
    and not exists (select 1 from aum_live l where l.handle = t.handle and l.at >= ${cutoff})`;
  if (handles === null || handles.length === 0) {
    const all = await sql<{ handle: string }[]>`
      select t.handle from traders t
       where exists (select 1 from wallets w where w.handle = t.handle
                       and (w.sol_address is not null or w.evm_address is not null))${stale}`;
    return all.map((r) => r.handle);
  }
  const out: string[] = [];
  for (const part of chunk([...handles], IN_CHUNK)) {
    const rows = await sql<{ handle: string }[]>`
      select t.handle from traders t
       where t.handle in (${part})
         and exists (select 1 from wallets w where w.handle = t.handle
                       and (w.sol_address is not null or w.evm_address is not null))${stale}`;
    out.push(...rows.map((r) => r.handle));
  }
  return out;
}

/** Handles per `holdings_live` read: the view rolls Solana balances forward per row, so it is kept small. */
// 4, not 20: `holdings_live` rolls transfers forward per row, and 20 traders of it in one
// statement exceeded D1's per-query CPU budget ("D1 DB exceeded its CPU time limit and was
// reset", 17 Sep). D1 runs one statement at a time, so small and many beats large and few.
const LIVE_CHUNK = 4;
/** aum_live is 9 columns; 10 rows is 90 parameters. */
const LIVE_WRITE_CHUNK = 10;

/**
 * `aum_live_refresh(p_handles, p_source, p_older_than)`: revalue `holdings_live` for the
 * targets on the ladder peg -> token_price_stats -> the latest daily close within 7 days ->
 * token_info, upserting `aum_live` and the current hour of `aum_history`. Returns rows upserted.
 */
export async function refreshAumLive(
  sql: Sql, handles: readonly string[] | null, source: string, olderThanHours?: number,
): Promise<number> {
  const targets = await liveTargets(sql, handles, olderThanHours);
  if (!targets.length) return 0;

  const balances = new Map<string, Balance[]>();
  for (const part of chunk(targets, LIVE_CHUNK)) {
    const rows = await sql<{ handle: string; network_id: number; token_key: string; human_amount: number }[]>`
      select handle, network_id, token_key, coalesce(human_amount_live, human_amount) as human_amount
        from holdings_live
       where handle in (${part}) and coalesce(human_amount_live, human_amount) > 0`;
    for (const r of rows) {
      (balances.get(r.handle) ?? balances.set(r.handle, []).get(r.handle)!)
        .push({ networkId: r.network_id, tokenKey: r.token_key, amount: r.human_amount });
    }
  }

  const refs: TokenRef[] = [...balances.values()].flat().map((b) => ({ networkId: b.networkId, tokenKey: b.tokenKey }));
  const facts = await loadFacts(sql, refs, true);

  // Ladder rung 3: the latest daily close within 7 days.
  const today = dayOf(new Date().toISOString());
  const since = dayOf(new Date(Date.now() - DAILY_STALE_DAYS * DAY_MS).toISOString());
  const daily = new Map<string, number>();
  for (const [networkId, all] of byNetwork(refs)) {
    for (const keys of chunk(all, IN_CHUNK)) {
      const tp = await sql<{ token_key: string; usd: number }[]>`
        select token_key, usd from (
          select token_key, usd, row_number() over (partition by token_key order by day desc) as rn
            from token_prices
           where network_id = ${networkId} and token_key in (${keys}) and usd > 0
             and day <= ${today} and day > ${since}
        ) where rn = 1`;
      for (const r of tp) daily.set(factsKey(networkId, r.token_key), r.usd);
    }
  }

  const at = new Date().toISOString();
  const hour = hourIso(Date.now());
  const computed = targets.map((handle) => {
    const positions = (balances.get(handle) ?? []).map((b): Position => {
      const k = factsKey(b.networkId, b.tokenKey);
      const f = facts.get(k) ?? emptyFacts();
      const price = f.pegged ?? f.statsLast ?? daily.get(k) ?? f.infoPrice ?? null;
      return { amount: b.amount, price, supply: f.supply, liquidityUsd: f.liquidity,
               unsellable: f.unsellable, quoteAsset: f.quoteAsset };
    });
    return { handle, v: valueGroup(positions) };
  });

  await sql.begin(async (tx) => {
    for (const part of chunk(computed, LIVE_WRITE_CHUNK)) {
      const values = part.map(() => "(?,?,?,?,?,?,?,?,?)").join(",");
      const params = part.flatMap((c) => [
        c.handle, at, c.v.totalUsd, c.v.suspectUsd, c.v.unsellableUsd,
        c.v.pricedPositions, c.v.totalPositions, c.v.reason, source,
      ]);
      await tx.unsafe(
        `insert into aum_live
           (handle, at, total_usd, suspect_usd, unsellable_usd, priced_positions, total_positions, reason, source)
         values ${values}
         on conflict (handle) do update set
           at = excluded.at, total_usd = excluded.total_usd, suspect_usd = excluded.suspect_usd,
           unsellable_usd = excluded.unsellable_usd, priced_positions = excluded.priced_positions,
           total_positions = excluded.total_positions, reason = excluded.reason, source = excluded.source`,
        params,
      );
    }
  });
  await writeHistory(sql, computed.map((c) => ({ handle: c.handle, hour, v: c.v, basis: "priced" as const })));
  return computed.length;
}
