import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";

/** Helius webhook receiver — the live half of the transaction feed. See docs/DECISIONS.md#d196 */
const SOLANA = 1399811149;
/**
 * SOL as it appears in `quote_assets` — the system program address. Native lamport movements
 * carry no mint of their own, so they are recorded under this key to be priceable.
 */
const SOL_MINT = "11111111111111111111111111111111";
const url = Deno.env.get("DB_URL") ?? Deno.env.get("SUPABASE_DB_URL") ?? "";
const AUTH = (Deno.env.get("HELIUS_WEBHOOK_SECRET") ?? "").trim();

// max: 1 — a webhook instance handles one payload at a time, and connections held here
// are connections the read API cannot have.
const sql = postgres(url, { max: 1, idle_timeout: 20, prepare: false, ssl: "require" });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ detail: "POST only" }, 405);

  // Without this, anyone who learns the URL can insert rows into the ledger we use to
  // check fomo's claims — which would make the Verified tier worth less than the Reported
  // one. Helius sends it as the `Authorization` header, set at webhook registration.
  if (AUTH && req.headers.get("authorization") !== AUTH) {
    return json({ detail: "unauthorized" }, 401);
  }

  let events: unknown;
  try {
    events = await req.json();
  } catch {
    // Acknowledge: a 500 here would have Helius retry an unparseable body forever.
    return json({ ok: true, skipped: "unparseable body" });
  }
  const list = Array.isArray(events) ? events : [events];

  // Only wallets we actually track. Helius delivers whatever is registered, and a wallet
  // removed from the directory should stop producing rows rather than accumulate orphans.
  const watched = new Set<string>(
    (await sql`select lower(sol_address) as a from wallets where sol_address is not null`)
      .map((r) => r.a as string),
  );

  type Cell = string | number | null;
  type Row = [number, string, string, string, Cell, Cell, Cell, Cell, string, Cell, Cell];
  const rows: Row[] = [];
  let skipped = 0;

  for (const ev of list as any[]) {
    const sig = ev?.signature;
    const ts = num(ev?.timestamp);
    if (!sig || ts === null) { skipped++; continue; }
    const at = new Date(ts * 1000).toISOString();

    for (const t of (ev?.tokenTransfers ?? []) as any[]) {
      const from = String(t?.fromUserAccount ?? "").toLowerCase();
      const to = String(t?.toUserAccount ?? "").toLowerCase();
      const mint = t?.mint ? String(t.mint).toLowerCase() : null;
      const amount = num(t?.tokenAmount);
      if (!mint) { skipped++; continue; }

      // A transfer between two wallets we both watch is TWO rows, one per side — the same
      // event seen from each trader's perspective. Collapsing it would lose one of them.
      for (const [mine, other, dir] of [[from, to, "out"], [to, from, "in"]] as const) {
        if (!watched.has(mine)) continue;
        rows.push([
          SOLANA, sig, mine, at, dir, other || null, mint, amount,
          "helius-webhook", ev?.type ?? null, ev?.source ?? null,
        ]);
      }
    }

    /** The native SOL side of a swap. See docs/DECISIONS.md#d197 */
    for (const t of (ev?.nativeTransfers ?? []) as any[]) {
      const from = String(t?.fromUserAccount ?? "").toLowerCase();
      const to = String(t?.toUserAccount ?? "").toLowerCase();
      const lamports = num(t?.amount);
      // Zero-value entries are bookkeeping, not movement. No other threshold is applied:
      // picking one would silently drop small but real trades, and the Express path
      // deliberately filters on zero alone.
      if (lamports === null || lamports === 0) { skipped++; continue; }

      for (const [mine, other, dir] of [[from, to, "out"], [to, from, "in"]] as const) {
        if (!watched.has(mine)) continue;
        rows.push([
          SOLANA, sig, mine, at, dir, other || null, SOL_MINT, lamports / 1e9,
          "helius-webhook", ev?.type ?? null, ev?.source ?? null,
        ]);
      }
    }
  }

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
      rows.flat() as (string | number | null)[],
    );
  }

  return json({ ok: true, events: list.length, inserted: rows.length, skipped });
});
