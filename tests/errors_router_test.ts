import { assert, assertEquals } from "jsr:@std/assert@1";
import { get, match, post, requestVersion, rewriteVersion } from "../supabase/functions/api/router.ts";

const { ApiError, classify } = await import("../supabase/functions/api/errors.ts");

Deno.test("classify: pool exhaustion is 429, connection trouble 503, anything else 500", () => {
  assertEquals(classify(new Error("too many clients already")).status, 429);
  assertEquals(classify(new Error("connect ETIMEDOUT")).status, 503);
  const other = classify(new Error("bind message supplies 8 parameters"));
  assertEquals([other.status, other.code], [500, "internal_error"]);
  const own = new ApiError(404, "not_found", "x");
  assertEquals(classify(own), own);
});

Deno.test("router: literal segments beat parameters regardless of declaration order", () => {
  get("/v1/things/:id", () => "param");
  get("/v1/things/special", () => "literal");
  post("/v1/things", () => "posted");
  assertEquals(match("GET", "/v1/things/special")?.handler({}, new URL("http://x")), "literal");
  assertEquals(match("GET", "/v1/things/abc")?.params, { id: "abc" });
  assertEquals(match("POST", "/v1/things")?.handler({}, new URL("http://x")), "posted");
});

Deno.test("router: the /api prefix is stripped and /v1 is optional", () => {
  get("/v1/ping", () => "pong");
  for (const p of ["/api/v1/ping", "/v1/ping", "/ping", "/api/ping"]) {
    assertEquals(match("GET", p)?.handler({}, new URL("http://x")), "pong", p);
  }
  assertEquals(match("GET", "/v1/nope"), null);
});

Deno.test("router: a malformed % sequence in a parameter is a 400, not a 500", () => {
  get("/v1/traders/:handle/aum", () => "aum");
  assertEquals(match("GET", "/v1/traders/a%20b/aum")?.params, { handle: "a b" });
  let caught: unknown = null;
  try { match("GET", "/v1/traders/%E0%A4%A/aum"); } catch (e) { caught = e; }
  assertEquals(caught instanceof ApiError && [caught.status, caught.code], [400, "bad_request"]);
});

Deno.test("router: /v2 matches the same registrations and reports its version", () => {
  get("/v1/echo", () => "v1-registered");
  assertEquals(match("GET", "/v2/echo")?.handler({}, new URL("http://x")), "v1-registered");
  assertEquals(match("GET", "/api/v2/echo")?.handler({}, new URL("http://x")), "v1-registered");
  assertEquals(requestVersion("/v2/traders/x/aum"), "v2");
  assertEquals(requestVersion("/api/v2/health"), "v2");
  assertEquals(requestVersion("/traders/x"), "v1");
  assertEquals(requestVersion("/v3/traders"), "v1");
});

Deno.test("rewriteVersion: v1 links are spelled for v2, nothing else changes", () => {
  const body = '{"links":{"aum":"/v1/traders/x/aum"},"note":"use GET /v1/traders/:handle/aum","addr":"0xv1/nope"}';
  assertEquals(rewriteVersion(body, "v1"), body);
  assertEquals(rewriteVersion(body, "v2"), '{"links":{"aum":"/v2/traders/x/aum"},"note":"use GET /v2/traders/:handle/aum","addr":"0xv1/nope"}');
});

Deno.test("checkRateWithin: a rate-limit write that stalls fails OPEN at its deadline (19 Sep)", async () => {
  /* The write ran before the 15 s race was armed, so a slow database pushed responses to 23-26 s. */
  const { checkRateWithin } = await import("../supabase/functions/api/errors.ts");
  const { setDefaultSql, getDefaultSql } = await import("../supabase/functions/api/db.ts");
  const previous = getDefaultSql();
  const never = new Promise(() => {});
  // A client whose every statement hangs: the tagged call returns a thenable that never settles.
  const hung = Object.assign(() => ({ then: (r: unknown, j: unknown) => never.then(r as never, j as never) }), {
    unsafe: () => never, begin: () => never, end: () => Promise.resolve(),
  });
  setDefaultSql(hung as never);
  try {
    const started = Date.now();
    const state = await checkRateWithin("test-key", 50);
    assertEquals(state.scope, "unlimited");
    assert(Date.now() - started < 1000, "must return at the deadline, not wait for the database");
  } finally {
    /* The client is module-global and Deno runs every test file in one process. */
    setDefaultSql(previous);
  }
});
