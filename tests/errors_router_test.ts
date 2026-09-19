import { assert, assertEquals } from "jsr:@std/assert@1";
import { get, match, post, requestVersion, rewriteVersion } from "../supabase/functions/api/router.ts";

const { ApiError, classify } = await import("../supabase/functions/api/errors.ts");

Deno.test("classify: our bug is a loud 500, a busy or reset database 503 with a longer wait, an unreachable one 503, never 429", () => {
  /* The two real messages of 17-19 Sep, which were served as 503 "retry shortly" and 500. */
  for (const bug of [
    "D1_ERROR: no such column: ps.last_usd at offset 424: SQLITE_ERROR",
    "d1sql: statement binds 101 parameters, D1 allows 100",
    "D1_ERROR: too many SQL variables at offset 12: SQLITE_ERROR",
    "D1_TYPE_ERROR: Type 'object' not supported for value '[object Object]'",
  ]) assertEquals([classify(new Error(bug)).status, classify(new Error(bug)).code], [500, "internal_error"], bug);
  assertEquals(classify(new TypeError("Cannot read properties of undefined (reading 'x')")).status, 500);
  for (const busy of [
    "D1_ERROR: D1 DB is overloaded. Requests queued for too long.",
    "D1_ERROR: D1 DB exceeded its CPU time limit and was reset.",
    "D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.",
    "too many clients already",
  ]) {
    const err = classify(new Error(busy));
    assertEquals([err.status, err.code, err.retryAfterSeconds], [503, "unavailable", 15], busy);
  }
  const down = classify(new Error("connect ETIMEDOUT"));
  assertEquals([down.status, down.retryAfterSeconds], [503, 5]);
  assertEquals(classify(new Error("D1_ERROR: Network connection lost.")).status, 503);
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

Deno.test("a 5xx is logged with the SAME request id the caller is given, and with its query string", async () => {
  /* 19 Sep: the app team quoted five request ids and none could be found — the id was minted after the log line. */
  const { handle } = await import("../supabase/functions/api/app.ts");
  const { setDefaultSql, getDefaultSql } = await import("../supabase/functions/api/db.ts");
  get("/v1/boom", () => { throw new Error("D1_ERROR: no such column: ps.last_usd at offset 424: SQLITE_ERROR"); });
  const previous = getDefaultSql();
  // The rate limiter's write fails, which it treats as "allow".
  const broken = Object.assign(() => Promise.reject(new Error("no database in this test")), {
    unsafe: () => Promise.reject(new Error("no database")), begin: () => Promise.reject(new Error("no database")), end: () => Promise.resolve(),
  });
  setDefaultSql(broken as never);
  const logged: string[] = [];
  const original = console.error;
  console.error = (...m: unknown[]) => { logged.push(m.join(" ")); };
  try {
    const res = await handle(new Request("https://test.local/v2/boom?limit=100&include=wallets"));
    const body = await res.json();
    assertEquals([res.status, body.error.code], [500, "internal_error"]);
    const rid = res.headers.get("x-request-id");
    assertEquals(body.error.requestId, rid);
    assert(logged.some((l) => l.startsWith(`${rid} GET /v2/boom?limit=100&include=wallets: internal_error`)), logged.join("\n"));
    assert(logged.some((l) => l.startsWith("BUG (deterministic")), "a deterministic SQL fault must be named as a bug in the log");
  } finally {
    console.error = original;
    setDefaultSql(previous);
  }
});
