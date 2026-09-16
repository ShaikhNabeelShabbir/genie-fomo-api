import { get } from "../router.ts";
import { badRequest } from "../errors.ts";

/** Read an integer query parameter, or reject it. See docs/DECISIONS.md#d132 */
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

/** T1.5. See docs/DECISIONS.md#d133 */
export function numParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    throw badRequest(`'${name}' must be a number — got '${raw}'`, { parameter: name });
  }
  return v;
}

/** Resolve `?orderBy=` against a whitelist. See docs/DECISIONS.md#d134 */
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
