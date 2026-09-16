import { sql } from "../db.ts";

/**
 * Resolve a path segment that may be a handle OR a stable id.
 *
 * `handle` is a display name and people change them; `id` is the uuid that never moves. Both
 * are accepted on EVERY per-trader route so a consumer can key on the stable one without
 * losing the readable one.
 *
 * This existed before and was wired into two routes out of ten. The other eight looked the
 * path segment up as a handle directly, so the id printed by the directory answered 404 on
 * the route the directory exists to point at -- exactly the failure
 * GENIE_FOMO_V7_BATCH_AUM_AND_COVERAGE_PRD.md reports as its first blocker. A resolver that
 * only some routes call is not a resolver, so it is now the single way in.
 *
 * Both spellings of the id are accepted, with and without the `trd_` prefix, because both
 * have been published and a consumer holding either must keep working.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveTrader(key: string): Promise<string> {
  const k = key.trim();
  // A uuid, with or without the `trd_` prefix the plugin team uses.
  const bare = k.replace(/^trd_/, "");
  if (UUID_RE.test(bare)) {
    const [r] = await sql`select handle from traders where id = ${bare}::uuid`;
    if (r) return r.handle as string;
  }

  /*
   * THE DIRECTORY'S OWN HANDLE HAS TO WORK, and for one trader it did not.
   *
   * `display_handle` is what every listing shows, and it is usually identical to `handle`.
   * It is not for `yeon__ (gmgn)`: two traders arrived sharing one folded handle, so a
   * migration appended the source to the display name to tell them apart. The directory then
   * published a name that this resolver could not resolve -- the only trader of 435 who
   * could not be charted at all, and the failure was ours, not the caller's.
   *
   * Tried only after the plain handle misses, so the ordinary case still costs no query.
   */
  const lower = k.toLowerCase();
  const [exact] = await sql`select handle from traders where handle = ${lower}`;
  if (exact) return exact.handle as string;

  const [byDisplay] = await sql`
    select handle from traders where lower(display_handle) = ${lower} limit 1`;
  if (byDisplay) return byDisplay.handle as string;

  /*
   * A LEADING `@` IS HOW PEOPLE WRITE A HANDLE, and it 404s today.
   *
   * We store handles bare. The consumer's own report names every trader `@unipcs` in its
   * prose and `unipcs` in its curl lines -- the same trader, one spelling of which does not
   * resolve. Tried last, after the bare handle and the display handle, so a handle that
   * genuinely begins with `@` still wins on its own terms.
   */
  if (lower.startsWith("@")) {
    const [at] = await sql`select handle from traders where handle = ${lower.slice(1)}`;
    if (at) return at.handle as string;
  }

  return lower;
}
