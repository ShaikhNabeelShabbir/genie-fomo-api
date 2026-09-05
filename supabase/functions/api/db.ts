import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";

/**
 * One Postgres connection for the whole function instance.
 *
 * Edge Functions are Deno, not Node, so none of `src/` runs here — this is a parallel
 * implementation whose job is to produce byte-identical output to the Express API. Every
 * route is diffed against it before it ships.
 *
 * `prepare: false` is required, not optional: SUPABASE_DB_URL points at the transaction
 * pooler when port 6543 is used, and transaction-mode pooling does not support prepared
 * statements. With it left on, queries fail intermittently under load rather than
 * immediately, which is the worst way to find out.
 */
/**
 * Supabase injects SUPABASE_DB_URL into every Edge Function automatically, pointing at the
 * direct connection — which resolves IPv6-only. That is fine from inside Supabase's own
 * network and unreachable from a laptop, so DB_URL (a secret we set ourselves, pointing at
 * the IPv4 pooler) takes precedence when present. Same file runs in both places.
 */
const url = Deno.env.get("DB_URL") ?? Deno.env.get("SUPABASE_DB_URL") ??
            Deno.env.get("DATABASE_URL") ?? "";
if (!url) throw new Error("SUPABASE_DB_URL is not set");

export const sql = postgres(url, {
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
   * Deno verifies TLS against its own trust store and rejects the Supabase pooler's chain
   * with `UnknownIssuer`, where Node's `rejectUnauthorized: false` simply skipped the
   * check. `require` still encrypts; it just does not demand a chain Deno cannot build.
   *
   * In a deployed Edge Function the database is reached inside Supabase's own network, so
   * this only matters when running the file locally to diff it against the Node service.
   */
  ssl: "require",
});

/**
 * pg returns `numeric` as a string so it cannot lose precision. Everything downstream does
 * arithmetic, so it is converted once, here — and a null stays null. Coercing a missing
 * value to 0 is the single failure mode this whole codebase is built to avoid: 1,688 of
 * 2,038 holdings carry no price, and treating those as zero silently changes concentration,
 * cash share, chain value and every coverage figure.
 */
export const n = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
};

/** Round for presentation only, never before a comparison. */
export const round = (v: number | null, dp = 2): number | null =>
  v === null ? null : Number(v.toFixed(dp));
