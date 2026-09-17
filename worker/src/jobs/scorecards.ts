import type postgres from "postgres";
import type { Env } from "../env";
import { db } from "../db";
import { type Fetched, type Load, type TradeRow, isFomoDoc, outcomeOf, tradeRow, when } from "./scorecards-core";

/**
 * Scorecard refresh, the Worker half of `.github/workflows/scorecards.yml`:
 * `load_trades.py --converge --stale-hours 72 --source fomoapi.io`, every six hours.
 *
 * Same target SQL, same `trade_loads` bookkeeping, same trades upsert, same stop rules. The
 * python's comments carry the measurements; only the one-line reasons are repeated here.
 */

type Sql = postgres.Sql;
type Target = { handle: string; display_handle: string; source: string | null };

const API = "https://api.fomoapi.io";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const STALE_HOURS = 72;
const SOURCE = "fomoapi.io";
const TRADE_LIMIT = 500;
const MAX_PASSES = 8;
/** MEASURED in load_trades.py: fanout 5 degraded 3 of 5 traders, fanout 2 served 6 of 6. fomo sheds concurrent load. */
const FANOUT = 2;
const FETCH_TIMEOUT_MS = 90_000;
const RETRY_MS = 1_500;
/** The longest one chunk can take (two attempts, each at the timeout): the budget stops a chunk that could not finish in time. */
const CHUNK_WORST_MS = 2 * FETCH_TIMEOUT_MS + RETRY_MS;
/** 15 columns a row; Postgres allows 65,535 bind parameters a statement. */
const INSERT_CHUNK = 1000;

export interface ScorecardsSummary {
  passes: number;
  /** Targets on the first pass. */
  targeted: number;
  /** Traders fomo answered with a document (possibly empty) across all passes. */
  refreshed: number;
  degraded: number;
  notFound: number;
  errored: number;
  /** Trade rows upserted. */
  trades: number;
  /** Targets still stale when the run ended. Zero means converged. */
  remaining: number;
  /** True when the time budget ended the run before convergence. Not an error. */
  stoppedEarly: boolean;
  elapsedMs: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Who to fetch: traders whose newest trade row, or newest `loaded` attempt, is older than
 * STALE_HOURS. SELF-CONVERGING: a served trader drops out, a degraded one stays selected.
 * `source` keeps the loop off traders fomo answers `available: false` for every time.
 */
const selectTargets = (sql: Sql) => sql<Target[]>`
  select t.handle, t.display_handle, t.source from traders t
  where greatest((select max(x.ingested_at) from trades x where x.handle = t.handle),
                 (select max(l.attempted_at) from trade_loads l
                   where l.handle = t.handle and l.outcome = 'loaded'),
                 'epoch'::timestamptz) < now() - (${STALE_HOURS} * interval '1 hour')
    and (${SOURCE}::text is null or t.source = ${SOURCE})
  order by t.handle`;

/** One trader's trades, with a single retry on transport, non-2xx, or fomo's degraded envelope. */
async function fetchTrades(handle: string, key: string): Promise<Fetched> {
  const url = `${API}/v2/users/${encodeURIComponent(handle)}/trades?limit=${TRADE_LIMIT}`;
  const headers = { authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": UA };
  for (const attempt of [1, 2]) {
    let r: Response;
    try {
      r = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (e) {
      if (attempt === 2) return { kind: "error", detail: (e as Error).message.slice(0, 120) };
      await sleep(RETRY_MS);
      continue;
    }
    if (r.status === 404) return { kind: "not_found" };
    if (!r.ok) {
      if (attempt === 2) return { kind: "error", detail: `HTTP ${r.status}` };
      await sleep(RETRY_MS);
      continue;
    }
    const body: unknown = await r.json().catch(() => undefined);
    if (!isFomoDoc(body)) return { kind: "error", detail: "malformed document" };
    if (body.available === false && attempt === 1) { await sleep(RETRY_MS); continue; }
    return { kind: "doc", doc: body };
  }
  return { kind: "error", detail: "unreachable" };
}

/** Fetch in chunks of FANOUT until the list ends or the budget would not fit another chunk. Index-aligned with `targets`. */
async function fetchAll(targets: Target[], key: string, outOfTime: () => boolean): Promise<Fetched[]> {
  const out: Fetched[] = [];
  for (let i = 0; i < targets.length && !outOfTime(); i += FANOUT) {
    out.push(...await Promise.all(targets.slice(i, i + FANOUT).map((t) => fetchTrades(t.display_handle, key))));
  }
  return out;
}

type PassCounts = { ok: number; degraded: number; notFound: number; errored: number; trades: number };

/** Record every attempt in `trade_loads` FIRST, then upsert what came back. */
async function writePass(sql: Sql, targets: Target[], fetched: Fetched[], netOf: ReadonlyMap<string, number>): Promise<PassCounts> {
  const c: PassCounts = { ok: 0, degraded: 0, notFound: 0, errored: 0, trades: 0 };
  const loads: (Load & { handle: string })[] = [];
  const rows: TradeRow[] = [];
  const symbols = new Map<string, { net: number; key: string; sym: string }>();
  fetched.forEach((f, i) => {
    const { handle, source } = targets[i];
    loads.push({ handle, ...outcomeOf(f, source) });
    if (f.kind === "error") { c.errored++; return; }
    if (f.kind === "not_found") { c.notFound++; return; }
    if (f.doc.available === false) { c.degraded++; return; }
    c.ok++;
    const captured = when(f.doc.capturedAt) ?? new Date();
    for (const t of f.doc.trades ?? []) {
      const row = tradeRow(t, handle, netOf, captured);
      if (!row) continue;
      rows.push(row);
      /* The holdings feed carries no symbols; trades do. Only for tokens already on a known chain. */
      if (row.token_key && row.token_symbol && row.network_id !== null) {
        symbols.set(`${row.network_id}:${row.token_key}`, { net: row.network_id, key: row.token_key, sym: row.token_symbol });
      }
    }
  });
  /* Written BEFORE the trades so a fetch that returned nothing still leaves a trace. */
  if (loads.length) await sql`insert into trade_loads ${sql(loads, "handle", "outcome", "detail")}`;
  if (!rows.length) return c;
  await sql.begin(async (tx) => {
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx`
        insert into trades ${tx(rows.slice(i, i + INSERT_CHUNK),
          "trade_id", "handle", "network_id", "token_address", "token_key",
          "token_symbol", "status", "amount", "avg_entry_price", "avg_exit_price",
          "realized_pnl_usd", "unrealized_pnl_usd", "opened_at", "closed_at", "captured_at")}
        on conflict (trade_id) do update set
          status = excluded.status, amount = excluded.amount,
          avg_entry_price = excluded.avg_entry_price, avg_exit_price = excluded.avg_exit_price,
          realized_pnl_usd = excluded.realized_pnl_usd,
          unrealized_pnl_usd = excluded.unrealized_pnl_usd,
          closed_at = excluded.closed_at, captured_at = excluded.captured_at,
          ingested_at = now()`;
    }
    for (const s of symbols.values()) {
      await tx`update tokens set symbol = ${s.sym} where network_id = ${s.net} and token_key = ${s.key}`;
    }
  });
  c.trades = rows.length;
  return c;
}

/**
 * Make passes until one fetches nothing new, the budget runs out, or MAX_PASSES. Throws only
 * when no trader could be refreshed at all, so the cron shows a failed invocation.
 */
export async function runScorecards(env: Env, budgetMs: number): Promise<ScorecardsSummary> {
  const key = (env.FOMOAPI_KEY ?? "").trim();
  if (!key) throw new Error("FOMOAPI_KEY is not set; refusing to run the scorecard refresh");
  const started = Date.now();
  const outOfTime = () => Date.now() - started + CHUNK_WORST_MS > budgetMs;
  const sql = db(env);
  const s: ScorecardsSummary = {
    passes: 0, targeted: 0, refreshed: 0, degraded: 0, notFound: 0, errored: 0,
    trades: 0, remaining: 0, stoppedEarly: false, elapsedMs: 0,
  };
  try {
    /* token_key -> network_id: the trades feed carries a token address but no networkId. */
    const netOf = new Map<string, number>(
      (await sql<{ token_key: string; network_id: string | number }[]>`select token_key, network_id from tokens`)
        .map((r) => [r.token_key, Number(r.network_id)]),
    );
    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      const targets = await selectTargets(sql);
      if (!targets.length) break;
      if (pass === 1) s.targeted = targets.length;
      s.passes = pass;
      const fetched = await fetchAll(targets, key, outOfTime);
      const c = await writePass(sql, targets, fetched, netOf);
      s.refreshed += c.ok; s.degraded += c.degraded; s.notFound += c.notFound;
      s.errored += c.errored; s.trades += c.trades;
      if (fetched.length < targets.length) { s.stoppedEarly = true; break; }
      if (c.ok === 0) {
        /* fomo will not serve these right now. A failure only if nothing was refreshed at all. */
        if (s.refreshed === 0) {
          throw new Error(`no trader could be refreshed across ${pass} pass(es) of ${s.targeted} target(s) — fomoapi is not answering`);
        }
        break;
      }
    }
    s.remaining = (await selectTargets(sql)).length;
    s.elapsedMs = Date.now() - started;
    return s;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
