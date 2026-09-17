import type { Env } from "../env";
import { jobSql, type Sql } from "../sql";
import { type Fetched, type Load, type TradeRow, capturedOf, isFomoDoc, outcomeOf, tradeRow } from "./scorecards-core";
import { chunk } from "./directory-core";

/**
 * Scorecard refresh, the Worker successor of `load_trades.py --stale-hours 72 --source
 * fomoapi.io`, every six hours (the `0 *\/6` cron). One pass per run: every target gets a `trade_loads`
 * row, so the next pass would select nobody; retries are the next cron tick.
 * The python's comments carry the measurements; only the one-line reasons are repeated here.
 */

/** `captured_at` is the ISO-8601 UTC text D1 stores. */
type Target = { handle: string; display_handle: string; source: string | null; captured_at: string | null };

const API = "https://api.fomoapi.io";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const STALE_HOURS = 72;
/** A trader fomo did not move is asked again after this long, not after STALE_HOURS. */
const RETRY_HOURS = 6;
const SOURCE = "fomoapi.io";
const TRADE_LIMIT = 500;
/** MEASURED in load_trades.py: fanout 5 degraded 3 of 5 traders, fanout 2 served 6 of 6. fomo sheds concurrent load. */
const FANOUT = 2;
const FETCH_TIMEOUT_MS = 90_000;
const RETRY_MS = 1_500;
/** The longest one chunk can take (two attempts, each at the timeout): the budget stops a chunk that could not finish in time. */
const CHUNK_WORST_MS = 2 * FETCH_TIMEOUT_MS + RETRY_MS;
/** 15 columns a row; D1 allows 100 bind parameters a statement, so 6 rows fit. */
const INSERT_CHUNK = 6;
/** 3 columns a row, same limit. */
const LOAD_CHUNK = 30;
/** Statements queued before a flush: the shim runs a whole queue as ONE d1 batch, one round trip. */
const BATCH_STATEMENTS = 50;
/** The epoch, as `coalesce(x, 'epoch')` spelled it; ISO text sorts before every real timestamp. */
const EPOCH = "1970-01-01T00:00:00.000Z";

export interface ScorecardsSummary {
  /** Traders due: snapshot older than STALE_HOURS (or none) and not asked within RETRY_HOURS. */
  targeted: number;
  /** Traders fomo answered with a document (possibly empty); `unchanged` counts the ones whose snapshot did not advance. */
  refreshed: number;
  unchanged: number;
  degraded: number;
  notFound: number;
  errored: number;
  /** Trade rows upserted. */
  trades: number;
  /** Traders still past STALE_HOURS when the run ended, whatever fomo answered. */
  remaining: number;
  /** True when the time budget ended the run before convergence. Not an error. */
  stoppedEarly: boolean;
  elapsedMs: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Stale = `max(trades.captured_at)` (fomo's snapshot time, the column the API's `loadedAt`,
 * `staleness` and `/health` judge) older than STALE_HOURS, or no trades at all. Judging
 * `ingested_at` let a re-served snapshot satisfy the job while the API stayed stale.
 */
const stale = (sql: Sql) => sql`
  select * from (
    select t.handle, t.display_handle, t.source,
           (select max(captured_at) from trades where handle = t.handle) as captured_at
    from traders t
    where t.source = ${SOURCE}
  )
  where coalesce(captured_at, ${EPOCH})
        < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${STALE_HOURS} hours`})`;

/** The stale traders not asked within RETRY_HOURS, whatever the last answer was. */
const selectTargets = (sql: Sql) => sql<Target[]>`
  select * from (${stale(sql)}) s
  where coalesce((select max(attempted_at) from trade_loads where handle = s.handle), ${EPOCH})
        < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${RETRY_HOURS} hours`})
  order by s.handle`;

const countStale = async (sql: Sql): Promise<number> =>
  Number((await sql<{ n: number }[]>`select count(*) as n from (${stale(sql)}) s`)[0].n);

/**
 * Issue one statement per item inside a `begin`, flushing every BATCH_STATEMENTS. The shim queues
 * statements between awaits and runs the queue as one d1 batch, so a flush is one round trip.
 */
async function issueBatched<T>(items: readonly T[], issue: (item: T) => PromiseLike<unknown>): Promise<void> {
  let last: PromiseLike<unknown> | undefined;
  for (const [i, item] of items.entries()) {
    last = issue(item);
    if ((i + 1) % BATCH_STATEMENTS === 0) { await last; last = undefined; }
  }
  if (last) await last;
}

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

type PassCounts = { ok: number; unchanged: number; degraded: number; notFound: number; errored: number; trades: number };

/** Record every attempt in `trade_loads` FIRST, then upsert what came back. */
async function writePass(sql: Sql, targets: Target[], fetched: Fetched[], netOf: ReadonlyMap<string, number>): Promise<PassCounts> {
  const c: PassCounts = { ok: 0, unchanged: 0, degraded: 0, notFound: 0, errored: 0, trades: 0 };
  const loads: (Load & { handle: string })[] = [];
  const rows: TradeRow[] = [];
  const symbols = new Map<string, { net: number; key: string; sym: string }>();
  const now = new Date();
  fetched.forEach((f, i) => {
    const { handle, source, captured_at } = targets[i];
    const load = outcomeOf(f, source, captured_at === null ? null : new Date(captured_at), now);
    loads.push({ handle, ...load });
    if (f.kind === "error") { c.errored++; return; }
    if (f.kind === "not_found") { c.notFound++; return; }
    if (f.doc.available === false) { c.degraded++; return; }
    if (load.outcome === "unchanged") c.unchanged++; else c.ok++;
    const captured = capturedOf(f.doc, now);
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
  if (loads.length) {
    await sql.begin((tx) => issueBatched(chunk(loads, LOAD_CHUNK), (part) => tx.unsafe(
      `insert into trade_loads (handle, outcome, detail) values ${part.map(() => "(?,?,?)").join(",")}`,
      part.flatMap((l) => [l.handle, l.outcome, l.detail]),
    )));
  }
  if (!rows.length) return c;
  await sql.begin(async (tx) => {
    await issueBatched(chunk(rows, INSERT_CHUNK), (part) => tx.unsafe(
      `insert into trades
         (trade_id, handle, network_id, token_address, token_key,
          token_symbol, status, amount, avg_entry_price, avg_exit_price,
          realized_pnl_usd, unrealized_pnl_usd, opened_at, closed_at, captured_at)
       values ${part.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}
       on conflict (trade_id) do update set
         status = excluded.status, amount = excluded.amount,
         avg_entry_price = excluded.avg_entry_price, avg_exit_price = excluded.avg_exit_price,
         realized_pnl_usd = excluded.realized_pnl_usd,
         unrealized_pnl_usd = excluded.unrealized_pnl_usd,
         closed_at = excluded.closed_at, captured_at = excluded.captured_at,
         ingested_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      part.flatMap((r) => [
        r.trade_id, r.handle, r.network_id, r.token_address, r.token_key,
        r.token_symbol, r.status, r.amount, r.avg_entry_price, r.avg_exit_price,
        r.realized_pnl_usd, r.unrealized_pnl_usd, r.opened_at, r.closed_at, r.captured_at,
      ]),
    ));
    await issueBatched([...symbols.values()], (s) =>
      tx`update tokens set symbol = ${s.sym} where network_id = ${s.net} and token_key = ${s.key}`);
  });
  c.trades = rows.length;
  return c;
}

/** One pass over the due traders. Throws only when fomo answered nobody, so the cron shows a failed invocation. */
export async function runScorecards(env: Env, budgetMs: number): Promise<ScorecardsSummary> {
  const key = (env.FOMOAPI_KEY ?? "").trim();
  if (!key) throw new Error("FOMOAPI_KEY is not set; refusing to run the scorecard refresh");
  const started = Date.now();
  const outOfTime = () => Date.now() - started + CHUNK_WORST_MS > budgetMs;
  const sql = jobSql(env);
  const s: ScorecardsSummary = {
    targeted: 0, refreshed: 0, unchanged: 0, degraded: 0, notFound: 0, errored: 0,
    trades: 0, remaining: 0, stoppedEarly: false, elapsedMs: 0,
  };
  try {
    /* token_key -> network_id: the trades feed carries a token address but no networkId. */
    const netOf = new Map<string, number>(
      (await sql<{ token_key: string; network_id: number }[]>`select token_key, network_id from tokens`)
        .map((r) => [r.token_key, r.network_id]),
    );
    const targets = await selectTargets(sql);
    s.targeted = targets.length;
    if (targets.length) {
      const fetched = await fetchAll(targets, key, outOfTime);
      const c = await writePass(sql, targets, fetched, netOf);
      s.refreshed = c.ok + c.unchanged; s.unchanged = c.unchanged; s.degraded = c.degraded;
      s.notFound = c.notFound; s.errored = c.errored; s.trades = c.trades;
      s.stoppedEarly = fetched.length < targets.length;
      if (s.refreshed === 0 && fetched.length > 0) {
        throw new Error(`no trader could be refreshed of ${fetched.length} asked — fomoapi is not answering`);
      }
    }
    s.remaining = await countStale(sql);
    s.elapsedMs = Date.now() - started;
    return s;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
