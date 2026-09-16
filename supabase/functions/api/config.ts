import { store } from "./db.ts";

type DenoLike = { env: { get(name: string): string | undefined } };

/**
 * One config read for both runtimes: the per-request store on Workers (`runWith` carries the
 * Worker `env`), the process environment on Deno. Read where the value is used, never at
 * import — Workers have no env at module scope. See docs/CLOUDFLARE_MIGRATION.md §5.2
 */
export const cfg = (name: string): string | undefined =>
  store()?.env[name] ?? (globalThis as { Deno?: DenoLike }).Deno?.env.get(name);
