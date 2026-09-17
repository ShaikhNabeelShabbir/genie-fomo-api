import type { Env } from "./env";
import { db } from "./db";
import { handle } from "../../supabase/functions/api/app.ts";
import { runWith } from "../../supabase/functions/api/db.ts";

/**
 * /v1/* on Workers: the SAME api modules as the Deno function. A client per request (§4.3),
 * handed to `db.ts`'s AsyncLocalStorage store together with the Worker env so every
 * `sql\`…\`` and `cfg()` inside `handle` resolves to this request's. See docs/CLOUDFLARE_MIGRATION.md §5.2
 */
/** This deployment is the v2 contract. v1 stays on Supabase; answering it here would fork it. */
const V2 = /^(\/api)?\/v2(\/|$)/;

export async function api(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!V2.test(new URL(req.url).pathname)) {
    return Response.json({
      error: {
        code: "not_found",
        detail: "this deployment serves /v2/*; /v1/* is the Supabase deployment",
        hint: "same routes, prefixed /v2 — e.g. /v2/traders/:handle/aum",
      },
    }, { status: 404 });
  }
  if (!env.HYPERDRIVE) {
    return Response.json({ error: "not_configured", detail: "HYPERDRIVE binding is parked" }, { status: 503 });
  }
  const sql = db(env);
  // The store carries string vars only; the binding stays on `env` for `db()`.
  const { HYPERDRIVE: _binding, DB: _db, ...vars } = env;
  try {
    return await runWith({ sql, env: vars }, () => handle(req));
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}
