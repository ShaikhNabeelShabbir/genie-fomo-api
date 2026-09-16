import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";
import { setDefaultSql } from "./db.ts";
import { handle } from "./app.ts";

/** The Deno entry: one client for the instance, then serve. The handler is app.ts. */
/**
 * Supabase injects SUPABASE_DB_URL into every Edge Function automatically, pointing at the
 * direct connection — which resolves IPv6-only. That is fine from inside Supabase's own
 * network and unreachable from a laptop, so DB_URL (a secret we set ourselves, pointing at
 * the IPv4 pooler) takes precedence when present. Same file runs in both places.
 */
const url = Deno.env.get("DB_URL") ?? Deno.env.get("SUPABASE_DB_URL") ??
            Deno.env.get("DATABASE_URL") ?? "";
if (!url) throw new Error("SUPABASE_DB_URL is not set");

/** One Postgres connection for the whole function instance. See docs/DECISIONS.md#d003 */
setDefaultSql(postgres(url, {
  /**
   * Deliberately small. Edge Functions scale HORIZONTALLY — every warm instance holds its
   * own pool, so `max` multiplies by instance count. Pointed at the session pooler (5432)
   * with max: 3, five instances exhausted the 15-client limit and every route began
   * returning 500 `EMAXCONNSESSION`. DB_URL is now the transaction pooler (6543), which
   * multiplexes, and this stays low so the same mistake cannot repeat as cheaply.
   */
  max: 2,
  idle_timeout: 20,
  connect_timeout: 15,
  prepare: false,
  /**
   * A route that loses the 15 s race (`ROUTE_TIMEOUT_MS`, app.ts) used to keep its query and
   * its connection running; with `max: 2` two slow routes starved the pool. 14 s so the
   * statement dies just before the race does and the connection is free for the next caller.
   */
  connection: { statement_timeout: 14000 },
  /** Deno verifies TLS against its own trust store and rejects the Supabase pooler's chain with… See docs/DECISIONS.md#d004 */
  ssl: "require",
}));

Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8000) }, handle);
