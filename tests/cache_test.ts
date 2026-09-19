import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { STALE_AFTER_MS, ttlCache, urlKey } from "../supabase/functions/api/shared/cache.ts";

Deno.test("ttlCache: one build per key inside the TTL", async () => {
  let built = 0;
  const cache = ttlCache<number>(60_000);
  const work = () => Promise.resolve(++built);
  assertEquals(await cache("a", work), 1);
  assertEquals(await cache("a", work), 1);
  assertEquals(await cache("b", work), 2);
  assertEquals(built, 2);
});

Deno.test("ttlCache: a lapsed slot is rebuilt", async () => {
  let built = 0;
  const cache = ttlCache<number>(0);
  const work = () => Promise.resolve(++built);
  assertEquals(await cache("a", work), 1);
  assertEquals(await cache("a", work), 2);
});

Deno.test("ttlCache: the slot count is bounded, because the key is caller-supplied", async () => {
  let built = 0;
  const cache = ttlCache<number>(60_000);
  const work = () => Promise.resolve(++built);
  for (let i = 0; i < 100; i++) await cache(`k${i}`, work);
  assertEquals(built, 100);
  /* The newest key is still held; the oldest was evicted, so it rebuilds. */
  assertEquals(await cache("k99", work), 100);
  assertEquals(await cache("k0", work), 101);
});

Deno.test("urlKey: parameter order cannot miss a hit", () => {
  assertEquals(
    urlKey(new URL("https://x/v2/tokens?limit=5&chain=bsc")),
    urlKey(new URL("https://x/v2/tokens?chain=bsc&limit=5")),
  );
  assertEquals(urlKey(new URL("https://x/v2/tokens")), "/v2/tokens?");
  /* A different path is a different answer, whatever the query. */
  assertEquals(urlKey(new URL("https://x/v2/tokens/momentum?a=1")), "/v2/tokens/momentum?a=1");
});

Deno.test("ttlCache: when the rebuild fails, the expired answer is served; with nothing to serve, the failure is the answer", async () => {
  const cache = ttlCache<string>(0); // every call is a miss
  const original = console.error;
  console.error = () => undefined;
  try {
    assertEquals(await cache("k", () => Promise.resolve("first")), "first");
    assertEquals(await cache("k", () => Promise.reject(new Error("D1_ERROR: D1 DB is overloaded"))), "first");
    assertEquals(await cache("k", () => Promise.resolve("second")), "second");
    await assertRejects(() => cache("never-built", () => Promise.reject(new Error("down"))), Error, "down");
  } finally { console.error = original; }
});

Deno.test("ttlCache: a rebuild that STALLS serves the expired answer at the deadline, and still lands when it finishes", async () => {
  const cache = ttlCache<string>(0);
  const original = console.error;
  console.error = () => undefined;
  try {
    assertEquals(await cache("k", () => Promise.resolve("first")), "first");
    let finish: (v: string) => void = () => undefined;
    const slow = new Promise<string>((resolve) => { finish = resolve; });
    const started = Date.now();
    assertEquals(await cache("k", () => slow), "first");
    const waited = Date.now() - started;
    assertEquals(waited >= STALE_AFTER_MS - 50 && waited < STALE_AFTER_MS + 1500, true, `waited ${waited} ms`);
    finish("late");
    await slow;
    await new Promise((r) => setTimeout(r, 0));
    // The late answer is now the stored one: a rebuild that fails gets IT, not "first".
    assertEquals(await cache("k", () => Promise.reject(new Error("down"))), "late");
  } finally { console.error = original; }
});
