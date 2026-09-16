import { assertEquals } from "jsr:@std/assert@1";
import { get, match, post } from "../supabase/functions/api/router.ts";

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
