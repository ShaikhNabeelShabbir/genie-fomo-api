import { match, HttpError } from "./router.ts";
import "./routes.ts";

/**
 * genie-fomo API as a Supabase Edge Function.
 *
 * Serves the PARAMETERS.md parameters straight from Postgres. Nothing here calls fomoapi,
 * Helius, Bitquery or Etherscan — those keys belong to the scheduled loaders, so a request
 * costs a query and nothing else, and a thousand visitors cost what one does.
 *
 * Two routes deliberately do NOT live here and stay on the Node service:
 *   /v1/hyperliquid/traders  — a 36MB feed, ~121MB of heap to parse; over the memory budget
 *   anything that fans out   — superseded once K5-K8 read the `trades` table
 */
const KEY = (Deno.env.get("GENIE_API_KEY") ?? "").trim();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
    },
  });

// Supabase supplies the port in production; PORT lets the same file run locally so it can
// be diffed against the Express service.
const port = Number(Deno.env.get("PORT") ?? 8000);

Deno.serve({ port }, async (req) => {
  if (req.method === "OPTIONS") return json({}, 204);

  const url = new URL(req.url);
  // Auth is off unless GENIE_API_KEY is set — same posture as the Node service, so the two
  // can be diffed without one of them refusing the request.
  if (KEY && req.headers.get("x-api-key") !== KEY) {
    return json({ detail: "invalid or missing X-API-Key" }, 401);
  }

  const hit = match(req.method, url.pathname);
  if (!hit) return json({ detail: "not found" }, 404);

  try {
    return json(await hit.handler(hit.params, url));
  } catch (e) {
    if (e instanceof HttpError) return json({ detail: e.message, ...(e.extra ?? {}) }, e.status);
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${url.pathname}: ${msg}`);
    return json({ detail: `internal error: ${msg}` }, 500);
  }
});
