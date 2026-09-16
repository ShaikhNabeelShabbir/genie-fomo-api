import { badRequest } from "../errors.ts";

// ----------------------------------------------------------- the board

/**
 * ISSUE-8. Sub-resources that `/v1/traders?include=` can inline.
 *
 * The reported problem: a consumer mirroring the directory needed 137 traders x 7 sub-routes,
 * ~960 calls, ~30 minutes sequentially. Per-call latency was the symptom; the call COUNT was
 * the cause, and no amount of shaving 2s down divides 960 into something comfortable.
 *
 * Each include is served by ONE set-based query for the whole page, never a loop — measured,
 * 137 traders aggregate in 614ms against 152ms for a single trader, because Postgres does it
 * in one pass. A bulk route that loops would have moved the N+1 server-side and made things
 * worse.
 */
/**
 * T1.4. Cursor pagination.
 *
 * `?offset=` addresses rows by POSITION, which is only correct if the list does not move
 * between calls. Ours moves: the board refreshes nightly and the Helius webhook appends
 * transactions continuously. A row inserted before your offset shifts everything down, so
 * page 2 repeats a row page 1 already gave you; a row removed shifts up and page 2 skips one.
 * Neither is visible to the caller — the sync just ends up wrong.
 *
 * A cursor names WHERE YOU WERE instead of HOW FAR IN. `offset` is kept working, because
 * removing a published parameter to fix a bug nobody reported would break consumers who are
 * fine today; new syncs should use the cursor.
 *
 * The payload is not secret and not signed — it is the sort key, base64url so it survives a
 * query string and so nobody is tempted to hand-assemble one. Tampering yields a 400, never
 * a wrong page.
 */
export const encodeCursor = (parts: (string | number | null)[]): string =>
  btoa(JSON.stringify(parts)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const decodeCursor = (raw: string): (string | number | null)[] => {
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const out = JSON.parse(atob(b64 + "=".repeat((4 - b64.length % 4) % 4)));
    if (!Array.isArray(out)) throw new Error("not an array");
    return out;
  } catch {
    throw badRequest("cursor is malformed — use the nextCursor from a previous response, unmodified",
      { parameter: "cursor" });
  }
};

/**
 * Resume a JS-paged list after the row a cursor names.
 *
 * The board routes fetch the whole ordered list and slice it, so the cursor identifies the
 * anchor ROW rather than encoding a comparable key: resuming at "the row after this one" is
 * exact, and it cannot disagree with the SQL ordering the way a re-implemented comparator
 * could.
 *
 * If the anchor is gone — the nightly refresh dropped that trader or token — we say so
 * instead of guessing. Silently restarting from the top would hand back rows the caller
 * already has and look like duplicates in their data.
 */
export const resumeAfter = <T>(rows: T[], cursor: string | null, id: (r: T) => string): number => {
  if (!cursor) return 0;
  const want = JSON.stringify(decodeCursor(cursor));
  const i = rows.findIndex((r) => JSON.stringify([id(r)]) === want);
  if (i < 0) {
    throw badRequest(
      "cursor no longer matches any row — the list changed since it was issued; restart without a cursor",
      { parameter: "cursor" });
  }
  return i + 1;
};
