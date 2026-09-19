import type { Env } from "./env";
import { jobSql } from "./sql";
import { GMGN_MISS_RETRY_AGO, GMGN_STALE_AGO, applyRelayResults, infoTargets, parseRelayResults } from "./jobs/tokens-core";

/** Coins handed out per request, at most: a reader gets through ~700 in 25 minutes at GMGN's pace. */
const QUEUE_MAX = 1000;

/**
 * GMGN IS READ SOMEWHERE ELSE AND WRITTEN HERE (19 Sep 2026). GMGN answers 429 to this Worker
 * before its key is checked: the limit is per IP and a Worker shares its outgoing IPs. So a reader
 * with an address of its own (scripts/gmgn_reader.ts) asks `GET /jobs/gmgn_queue` what is due,
 * reads it, and posts to `POST /jobs/gmgn_results`. Every D1 write stays here, in the code the
 * Worker's own job uses. Both routes are behind `JOB_SECRET`; index.ts checks it before this runs.
 */
export async function gmgnRelay(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const sql = jobSql(env);
  try {
    if (url.pathname === "/jobs/gmgn_queue" && req.method === "GET") {
      const asked = Number(url.searchParams.get("limit") ?? 300);
      const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, QUEUE_MAX) : 300;
      const targets = await infoTargets(sql, GMGN_STALE_AGO, GMGN_MISS_RETRY_AGO);
      return Response.json({ due: targets.length, targets: targets.slice(0, limit) });
    }
    if (url.pathname === "/jobs/gmgn_results" && req.method === "POST") {
      const body: unknown = await req.json().catch(() => null);
      const { ok, rejected } = parseRelayResults(body);
      if (!ok.length && rejected.length) return Response.json({ error: "nothing acceptable in the body", rejected }, { status: 400 });
      return Response.json({ ...(await applyRelayResults(sql, ok)), rejected });
    }
    return Response.json({ error: "GET /jobs/gmgn_queue or POST /jobs/gmgn_results" }, { status: 405 });
  } catch (e) {
    console.error(`gmgn relay: ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ error: "the relay failed; see the Worker log" }, { status: 500 });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
