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

/** With an expired answer in hand, a rebuild gets this long before the expired answer is served instead. */
export const STALE_AFTER_MS = 3000;

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
    const store = (body: T): T => {
      /* Oldest out first: insertion order is Map's, and a refreshed key is deleted before it is set. */
      slots.delete(key);
      if (slots.size >= MAX_SLOTS) slots.delete(slots.keys().next().value as string);
      slots.set(key, { at: Date.now(), body });
      return body;
    };
    if (!hit) return store(await build());
    /*
     * An expired answer exists. A database that cannot rebuild it — it throws, or it stalls past
     * STALE_AFTER_MS — must not take away the one we have: the expired body is still the newest
     * truth this isolate knows, and its own timestamps say how old it is (consumer ask, 18 Sep
     * 2026: "keep it serving while the database is down"). A late rebuild still lands in the slot.
     */
    const rebuilt = build().then(store);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<void>((resolve) => { timer = setTimeout(resolve, STALE_AFTER_MS); });
    const served = (why: string): T => {
      console.error(`cache: ${key} ${why}; serving the answer from ${Math.round((Date.now() - hit.at) / 1000)} s ago`);
      return hit.body;
    };
    return Promise.race([
      rebuilt.catch((e: unknown) => served(`could not be rebuilt (${e instanceof Error ? e.message.slice(0, 120) : String(e)})`)),
      stalled.then(() => served(`was not rebuilt within ${STALE_AFTER_MS} ms`)),
    ]).finally(() => clearTimeout(timer));
  };
}

/** The cache key for a URL: path plus its query, sorted so parameter order cannot miss a hit. */
export const urlKey = (url: URL): string => {
  const q = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `${url.pathname}?${q.map(([k, v]) => `${k}=${v}`).join("&")}`;
};
