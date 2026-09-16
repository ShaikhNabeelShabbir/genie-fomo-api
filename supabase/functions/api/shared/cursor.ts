import { badRequest } from "../errors.ts";

// ----------------------------------------------------------- the board

/** ISSUE-8. See docs/DECISIONS.md#d129 */
/** T1.4. See docs/DECISIONS.md#d130 */
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

/** Resume a JS-paged list after the row a cursor names. See docs/DECISIONS.md#d131 */
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
