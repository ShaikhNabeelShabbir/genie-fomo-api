import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";

type Sql = postgres.Sql;

/**
 * The client is resolved PER CALL, not at import. On Deno `index.ts` builds one client for
 * the instance and registers it with `setDefaultSql`; on Workers a client only exists inside
 * a request, so `worker/src/api.ts` wraps each request in `runWith({ sql, env }, …)` and
 * every `sql\`…\`` call site resolves it through AsyncLocalStorage. Same modules on both
 * runtimes, no per-call threading. See docs/CLOUDFLARE_MIGRATION.md §5.2
 */
export type Store = { sql: Sql; env: Readonly<Record<string, string | undefined>> };
const als = new AsyncLocalStorage<Store>();
let defaultSql: Sql | undefined;

export const store = (): Store | undefined => als.getStore();
export const setDefaultSql = (client: Sql): void => { defaultSql = client; };
export const runWith = <T>(s: Store, fn: () => T): T => als.run(s, fn);

const current = (): Sql => {
  const s = als.getStore()?.sql ?? defaultSql;
  if (!s) throw new Error("no database client: call setDefaultSql() or wrap the call in runWith()");
  return s;
};

/** Tagged-template calls and member access both land on whichever client is current. */
export const sql: Sql = new Proxy(function () {} as unknown as Sql, {
  apply: (_t, _self, args: unknown[]) =>
    Reflect.apply(current() as unknown as (...a: unknown[]) => unknown, undefined, args),
  get: (_t, prop) => {
    const c = current() as unknown as Record<string | symbol, unknown>;
    const v = c[prop];
    return typeof v === "function" ? v.bind(c) : v;
  },
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
