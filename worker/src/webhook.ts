import type { Env } from "./env";
import { jobSql, type Sql } from "./sql";
import { chunk } from "./jobs/directory-core";
import { transferKey } from "../../supabase/functions/_shared/md5.ts";
import { addressKeys, shapeRows, type Row } from "./helius";

/** 12 columns a row; 7 rows is 84 of D1's 100 bound parameters a statement. */
const INSERT_ROWS = 7;
/** Ids per `in (…)`, leaving room for the rest of the clause. */
const IN_CHUNK = 80;

/**
 * Revalue the traders whose wallets just moved (aum_live). Logged, never thrown: the
 * transfers are already inserted and must not be reported lost.
 */
async function refreshLive(sql: Sql, keys: readonly string[]): Promise<void> {
  try {
    // Mark only. Refreshing here ran holdings_live once per push (~40/min) and saturated the
    // database on 17 Sep; the aum_live_flush cron refreshes the marked traders every minute.
    // SQLite has no data-modifying CTE, so the handles are read first and marked second.
    const handles = new Set<string>();
    for (const part of chunk([...keys], IN_CHUNK)) {
      const rows = await sql<{ handle: string }[]>`
        select distinct handle from wallets where sol_address_key in (${part})`;
      for (const r of rows) handles.add(r.handle);
    }
    const at = new Date().toISOString();
    for (const part of chunk([...handles], IN_CHUNK / 2)) {
      await sql.unsafe(
        `insert into aum_live_dirty (handle, marked_at) values ${part.map(() => "(?,?)").join(",")}
         on conflict (handle) do update set marked_at = excluded.marked_at`,
        part.flatMap((h) => [h, at]),
      );
    }
    console.log("webhook aum_live:", { marked: handles.size });
  } catch (e) {
    console.error("webhook aum_live:", e instanceof Error ? e.message : String(e));
  }
}

/** The Worker side of the Helius receiver; the payload shaping is in helius.ts. See docs/CLOUDFLARE_MIGRATION.md §9 */
async function insert(env: Env, events: unknown): Promise<void> {
  const sql = jobSql(env);
  try {
    // Only wallets we actually track. Helius delivers whatever is registered, and a wallet
    // removed from the directory should stop producing rows rather than accumulate orphans.
    const watched = new Set<string>(
      (await sql<{ a: string }[]>`select lower(sol_address) as a from wallets where sol_address is not null`)
        .map((r) => r.a),
    );
    const { rows, skipped } = shapeRows(events, watched);

    // transfer_key is the md5 of the same four fields the migration digested; neither SQLite
    // nor Web Crypto has md5, so _shared/md5.ts computes it here and the webhook and the
    // backfill still agree about what makes a row unique.
    const keyed = rows.map((r: Row): unknown[] => [
      r[0], r[1], r[2],
      transferKey(r[6] as string | null, r[4] as string | null, r[5] as string | null, r[7] as number | null),
      r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10],
    ]);
    for (const part of chunk(keyed, INSERT_ROWS)) {
      await sql.unsafe(
        `insert into transactions
           (network_id, tx_hash, address_key, transfer_key, block_time, direction,
            counterparty, token_key, amount, source, tx_type, tx_source)
         values ${part.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}
         on conflict (network_id, tx_hash, address_key, transfer_key) do update set
           block_time = excluded.block_time, amount = excluded.amount,
           tx_type = coalesce(excluded.tx_type, transactions.tx_type),
           tx_source = coalesce(excluded.tx_source, transactions.tx_source),
           ingested_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        part.flat(),
      );
    }
    // The response no longer carries these counts (§9); the log is where they live now.
    console.log("webhook insert:", { inserted: rows.length, skipped });
    if (rows.length) await refreshLive(sql, addressKeys(rows));
  } finally {
    // Already running under ctx.waitUntil, so awaiting the close here is the same thing.
    await sql.end({ timeout: 5 });
  }
}

export async function webhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method !== "POST") return Response.json({ detail: "POST only" }, { status: 405 });
  if (!env.DB) {
    // Helius must not be pointed here until this is gone; a 503 makes it retry rather than drop.
    return Response.json({ error: "not_configured", detail: "D1 binding DB is parked" }, { status: 503 });
  }

  // Without this, anyone who learns the URL can insert rows into the ledger we use to
  // check fomo's claims — which would make the Verified tier worth less than the Reported
  // one. Helius sends it as the `Authorization` header, set at webhook registration.
  const auth = (env.HELIUS_WEBHOOK_SECRET ?? "").trim();
  if (auth && req.headers.get("authorization") !== auth) {
    return Response.json({ detail: "unauthorized" }, { status: 401 });
  }

  let events: unknown;
  try {
    events = await req.json();
  } catch {
    // Acknowledge: a 500 here would have Helius retry an unparseable body forever.
    return Response.json({ ok: true, skipped: "unparseable body" });
  }

  // Answer fast: a non-2xx makes Helius retry, so slow work here becomes duplicate
  // deliveries. Acknowledge, then insert. A failed insert is only visible in the log,
  // so the .catch is not optional. See docs/CLOUDFLARE_MIGRATION.md §9
  ctx.waitUntil(insert(env, events).catch((e: unknown) => console.error("webhook insert:", e)));
  return Response.json({ ok: true });
}
