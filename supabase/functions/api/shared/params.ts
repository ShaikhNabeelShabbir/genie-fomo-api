import { get } from "../router.ts";
import { badRequest } from "../errors.ts";

/**
 * Read an integer query parameter, or reject it.
 *
 * The old pattern was `Number(url.searchParams.get("limit"))` guarded by `isFinite`, which
 * silently treated anything unparseable as "not supplied" — so `?limit=abc` returned 200 and
 * the whole list, and `?offset=abc` was ignored. A typo produced a full table scan and a
 * confidently wrong page rather than an error naming the mistake.
 *
 * Absent still means the default: `?limit=` omitted returns everything, which is documented.
 * PRESENT-but-invalid is what now fails, because that is a caller error and silence hides it.
 */
export function intParam(
  url: URL,
  name: string,
  opts: { min?: number; max?: number; fallback: number | null },
): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return opts.fallback;

  const v = Number(raw);
  const min = opts.min ?? 0;
  if (!Number.isFinite(v) || !Number.isInteger(v)) {
    throw badRequest(`'${name}' must be a whole number — got '${raw}'`, { parameter: name });
  }
  if (v < min) {
    throw badRequest(`'${name}' must be at least ${min} — got ${v}`, { parameter: name });
  }
  return opts.max !== undefined ? Math.min(v, opts.max) : v;
}

/**
 * T1.5. A decimal bound, for range filters over money columns.
 *
 * Separate from `intParam` because P&L and volume are `numeric` and a caller filtering on
 * `minPnl=1000.50` should not be told it must be a whole number. Same strictness otherwise:
 * BUG-3 established that a parameter we cannot parse is a 400, never a silent default, since
 * an ignored filter returns MORE rows than asked for and looks like data rather than an error.
 */
export function numParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    throw badRequest(`'${name}' must be a number — got '${raw}'`, { parameter: name });
  }
  return v;
}

/**
 * Resolve `?orderBy=` against a whitelist.
 *
 * The value never reaches SQL. It selects a pre-written fragment, so an unknown key is a 400
 * naming the valid set rather than anything that could reach the planner.
 *
 * Ordering direction applies ONLY to the chosen column. Every sort keeps its existing
 * tiebreak, unreversed, because T1.4's cursors resume through a total order — a sort that
 * ties would make pagination skip and repeat rows again, which is the bug that item existed
 * to fix.
 */
export function sortParam(
  url: URL,
  allowed: readonly string[],
  fallback: string,
  /** Per-key default direction. A key absent here defaults to descending. */
  ascByDefault: readonly string[] = [],
): { key: string; desc: boolean } {
  const raw = (url.searchParams.get("orderBy") ?? "").trim();
  const key = raw === "" ? fallback : raw;
  if (!allowed.includes(key)) {
    throw badRequest(`unknown orderBy '${raw}'`, { parameter: "orderBy", valid: allowed });
  }
  const dirRaw = (url.searchParams.get("direction") ?? "").trim().toLowerCase();
  if (dirRaw !== "" && dirRaw !== "asc" && dirRaw !== "desc") {
    throw badRequest(`direction must be 'asc' or 'desc' — got '${dirRaw}'`,
      { parameter: "direction" });
  }
  // Most metrics descend by default because "most" is the interesting end. Rank is the
  // exception and has to be declared, not inferred: rank 1 is the BEST trader, so defaulting
  // it to descending would put the worst of the board first.
  if (dirRaw === "") return { key, desc: !ascByDefault.includes(key) };
  return { key, desc: dirRaw === "desc" };
}

/** '' is not a value. The columns store empty strings where fomo gave nothing. */
export const nonEmpty = (v: string | null | undefined): string | null =>
  v && v.trim() ? v.trim() : null;
