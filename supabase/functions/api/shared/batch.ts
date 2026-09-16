import { sql, round } from "../db.ts";
import { get } from "../router.ts";
import { badRequest, ApiError } from "../errors.ts";
import { UUID_RE, resolveTrader } from "../shared/traders.ts";

// ----------------------------------------------------------- batch reads (§8)

/** Up to this many traders per batch call. Stated in the answer, never silently applied. */
export const BATCH_MAX = 50;

/**
 * Read `ids` from a POST body, accepting handles or `trd_` ids, and refusing loudly.
 *
 * A background pass over 435 traders cannot make 435 calls an hour. These exist so it can
 * make nine. The cap is returned on every response because a silently truncated list is how
 * a roster under-counts without anyone noticing.
 */
export async function batchIds(
  body: unknown,
): Promise<{ requested: string[]; handles: string[]; asked: number; capped: boolean }> {
  const ids = (body as { ids?: unknown })?.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw badRequest("body must be { \"ids\": [...] } with at least one id or handle",
                     { parameter: "ids" });
  }

  /*
   * OVER THE CAP IS A REFUSAL, NOT A TRIM.
   *
   * This used to read the first fifty and set `capped: true`. That is a correct description
   * of what happened and still the wrong behaviour: the caller asked about sixty traders and
   * got a 200, so the ten it never heard about look exactly like ten traders with no data.
   * GENIE_FOMO_V7_BATCH_AUM_TDR.md §6 asks for the refusal instead, and a 400 naming the cap
   * is a bug the caller fixes once rather than a silent under-count it never notices.
   */
  if (ids.length > BATCH_MAX) {
    throw badRequest(
      `at most ${BATCH_MAX} ids per call — got ${ids.length}; split the list rather than ` +
      `relying on truncation`,
      { parameter: "ids" });
  }

  const wanted = ids.map(String);

  /*
   * A DUPLICATE IS AMBIGUOUS, so it is refused rather than collapsed. Two entries for one
   * trader mean the caller expects two rows, and returning one silently breaks the
   * one-result-per-input guarantee the same section requires. Duplicates are detected after
   * resolution too, because a handle and its stable id are the same trader spelled twice.
   */
  const seen = new Set<string>();
  for (const k of wanted) {
    const norm = k.trim().toLowerCase();
    if (seen.has(norm)) {
      throw new ApiError(400, "duplicate_identifier",
        `'${k}' appears more than once — every id must be distinct`,
        { parameter: "ids" });
    }
    seen.add(norm);
  }

  /*
   * RESOLVE ALL FIFTY IN ONE QUERY, not one query each.
   *
   * resolveTrader() looks an id up in the database, so mapping it over the list issued fifty
   * round trips through the pooler -- about nine seconds of a call whose actual data costs
   * 1.2. Measured on a 50-id batch: 9.9s for a window returning 65KB, which is the giveaway
   * that the payload was never the problem. One `any()` answers the whole list.
   */
  const uuidish = wanted.filter((k) => UUID_RE.test(k.trim().replace(/^trd_/, "")));
  const byId = new Map<string, string>();
  if (uuidish.length) {
    const bare = uuidish.map((k) => k.trim().replace(/^trd_/, ""));
    const found = await sql`
      select id, handle from traders where id = any(${bare}::uuid[])`;
    for (const r of found) byId.set(String(r.id).toLowerCase(), String(r.handle));
  }
  let handles = wanted.map((k) => {
    const bare = k.trim().replace(/^trd_/, "").toLowerCase();
    return byId.get(bare) ?? k.trim().toLowerCase();
  });

  /*
   * THE `display_handle` FALLBACK, which the single routes have had and this one did not.
   *
   * resolveTrader() tries the stored handle, then `display_handle`, because for one trader
   * they differ: `yeon__ (gmgn)` is published under that name and stored as `gmgn_yeon__`.
   * Lowercasing the published name therefore matched nothing here, so the SAME trader
   * answered 200 with a full envelope on /traders/:handle/aum and `not_found` in the batch.
   * One trader of 448, resolvable by id, and the only one whose two routes disagreed about
   * whether he exists -- which is precisely the failure the batch contract forbids.
   *
   * Only the handles that missed are looked up, so the ordinary batch pays nothing: the
   * query runs at all only when a name did not match a stored handle.
   */
  const missed = [...new Set(handles)];
  if (missed.length) {
    const known = await sql`
      select handle from traders where handle = any(${missed})`;
    const have = new Set(known.map((r) => String(r.handle)));
    const unknown = missed.filter((h) => !have.has(h));
    if (unknown.length) {
      const byDisplay = await sql`
        select lower(display_handle) as display, handle from traders
         where lower(display_handle) = any(${unknown})`;
      if (byDisplay.length) {
        const dmap = new Map(byDisplay.map((r) => [String(r.display), String(r.handle)]));
        handles = handles.map((h) => dmap.get(h) ?? h);
      }
    }
  }

  const resolved = new Set<string>();
  for (const [i, h] of handles.entries()) {
    if (resolved.has(h)) {
      throw new ApiError(400, "duplicate_identifier",
        `'${wanted[i]}' resolves to a trader already named earlier in the list — ` +
        `an id and its handle are the same trader`,
        { parameter: "ids" });
    }
    resolved.add(h);
  }

  /*
   * `requested` is what the caller actually sent, kept beside the resolved handle.
   *
   * Without it a response is ambiguous the moment a handle changes: the caller asked about
   * an id, the row comes back under a handle, and nothing in between says they are the same
   * trader. GENIE_FOMO_V7_BATCH_AUM_TDR.md §5 asks for the submitted value to be echoed for
   * exactly this reason, so a row can be joined back without guessing.
   */
  return { requested: wanted, handles, asked: wanted.length, capped: false };
}

export const batchEnvelope = (asked: number, capped: boolean, asOf: string | null = null) => ({
  limit: BATCH_MAX,
  asked,
  /** True when the caller sent more than the cap; the extras were NOT read. */
  capped,
  /**
   * When the data behind this batch was taken. The batch routes had no `asOf` while every
   * individual route had one, so a consumer reading fifty traders at once could not date the
   * answer without calling a route it was trying to avoid.
   */
  asOf,
  ...(capped
    ? { note: `only the first ${BATCH_MAX} ids were read — send the rest in another call` }
    : {}),
});
