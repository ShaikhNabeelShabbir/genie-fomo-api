import type { Env } from "./env";
import { db } from "./db";
import { addressKeys, shapeRows } from "./helius";

/**
 * Revalue the traders whose wallets just moved (aum_live, migration 20260918030000). Logged,
 * never thrown: the transfers are already inserted and must not be reported lost.
 */
async function refreshLive(sql: ReturnType<typeof db>, keys: readonly string[]): Promise<void> {
  try {
    const handles = (await sql<{ handle: string }[]>`
      select distinct handle from wallets where sol_address_key = any(${keys})`).map((r) => r.handle);
    if (!handles.length) return;
    const [row] = await sql<{ n: number }[]>`select aum_live_refresh(${handles}::text[], 'webhook', interval '5 minutes') as n`;
    console.log("webhook aum_live:", { handles: handles.length, refreshed: Number(row?.n ?? 0) });
  } catch (e) {
    console.error("webhook aum_live:", e instanceof Error ? e.message : String(e));
  }
}

/** The Worker side of the Helius receiver; the payload shaping is in helius.ts. See docs/CLOUDFLARE_MIGRATION.md §9 */
async function insert(env: Env, events: unknown): Promise<void> {
  const sql = db(env);
  try {
    // Only wallets we actually track. Helius delivers whatever is registered, and a wallet
    // removed from the directory should stop producing rows rather than accumulate orphans.
    const watched = new Set<string>(
      (await sql<{ a: string }[]>`select lower(sol_address) as a from wallets where sol_address is not null`)
        .map((r) => r.a),
    );
    const { rows, skipped } = shapeRows(events, watched);

    if (rows.length) {
      // transfer_key is computed in SQL from the same expression the migration defines, so
      // the webhook and the backfill can never disagree about what makes a row unique.
      const values = rows.map((_, i) => {
        const b = i * 11;
        return `($${b+1},$${b+2},$${b+3},` +
          `md5(coalesce($${b+7},'')||'|'||coalesce($${b+5},'')||'|'||coalesce($${b+6},'')||'|'||coalesce($${b+8}::text,'')),` +
          `$${b+4}::timestamptz,$${b+5},$${b+6},$${b+7},$${b+8}::numeric,$${b+9},$${b+10},$${b+11})`;
      }).join(",");
      await sql.unsafe(
        `insert into transactions
           (network_id, tx_hash, address_key, transfer_key, block_time, direction,
            counterparty, token_key, amount, source, tx_type, tx_source)
         values ${values}
         on conflict (network_id, tx_hash, address_key, transfer_key) do update set
           block_time = excluded.block_time, amount = excluded.amount,
           tx_type = coalesce(excluded.tx_type, transactions.tx_type),
           tx_source = coalesce(excluded.tx_source, transactions.tx_source),
           ingested_at = now()`,
        rows.flat(),
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
  if (!env.HYPERDRIVE) {
    // Helius must not be pointed here until this is gone; a 503 makes it retry rather than drop.
    return Response.json({ error: "not_configured", detail: "HYPERDRIVE binding is parked" }, { status: 503 });
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
