/**
 * A per-isolate response cache, keyed on the query that produced the body.
 *
 * L2 (v5 fixes, 17 Sep 2026): `/tokens` aggregates the whole holdings view before any limit
 * applies, so `?limit=5` costs what `?limit=500` costs and answered 503 `timeout` twice in a
 * row under load. The answer does not depend on who is asking, so the second caller and every
 * caller after them within the TTL should not pay for it again.
 *
 * Per ISOLATE, not shared: Cloudflare may start a fresh one at any moment and a cold isolate
 * pays full price. That makes this a latency fix, not a correctness one -- see `routes/market.ts`,
 * which says the same of its own. A miss is only ever a slower answer.
 */

/** Slots per cache. A bounded map, because the key carries caller-supplied query strings. */
const MAX_SLOTS = 64;

export interface Cache<T> {
  (key: string, build: () => Promise<T>): Promise<T>;
}

/** A cache with its own TTL; call it with a key and the work to do on a miss. */
export function ttlCache<T>(ttlMs: number): Cache<T> {
  const slots = new Map<string, { at: number; body: T }>();
  return async (key: string, build: () => Promise<T>): Promise<T> => {
    const hit = slots.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.body;
    const body = await build();
    /* Oldest out first: insertion order is Map's, and a refreshed key is deleted before it is set. */
    slots.delete(key);
    if (slots.size >= MAX_SLOTS) slots.delete(slots.keys().next().value as string);
    slots.set(key, { at: Date.now(), body });
    return body;
  };
}

/** The cache key for a URL: path plus its query, sorted so parameter order cannot miss a hit. */
export const urlKey = (url: URL): string => {
  const q = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `${url.pathname}?${q.map(([k, v]) => `${k}=${v}`).join("&")}`;
};
