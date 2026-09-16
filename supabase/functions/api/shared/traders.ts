import { sql } from "../db.ts";

/** Resolve a path segment that may be a handle OR a stable id. See docs/DECISIONS.md#d180 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveTrader(key: string): Promise<string> {
  const k = key.trim();
  // A uuid, with or without the `trd_` prefix the plugin team uses.
  const bare = k.replace(/^trd_/, "");
  if (UUID_RE.test(bare)) {
    const [r] = await sql`select handle from traders where id = ${bare}::uuid`;
    if (r) return r.handle as string;
  }

  /** THE DIRECTORY'S OWN HANDLE HAS TO WORK, and for one trader it did not. See docs/DECISIONS.md#d181 */
  const lower = k.toLowerCase();
  const [exact] = await sql`select handle from traders where handle = ${lower}`;
  if (exact) return exact.handle as string;

  const [byDisplay] = await sql`
    select handle from traders where lower(display_handle) = ${lower} limit 1`;
  if (byDisplay) return byDisplay.handle as string;

  /** A LEADING `@` IS HOW PEOPLE WRITE A HANDLE, and it 404s today. See docs/DECISIONS.md#d182 */
  if (lower.startsWith("@")) {
    const [at] = await sql`select handle from traders where handle = ${lower.slice(1)}`;
    if (at) return at.handle as string;
  }

  return lower;
}
