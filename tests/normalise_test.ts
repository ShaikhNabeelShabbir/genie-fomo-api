import { assertEquals } from "jsr:@std/assert@1";
import { normalise, render, renderKeys } from "../scripts/lib/normalise.ts";

Deno.test("normalise: asOf and liveRead are dropped at the top level only", () => {
  assertEquals(normalise({ asOf: "x", liveRead: true, nested: { asOf: "kept" }, a: 1 }), {
    nested: { asOf: "kept" },
    a: 1,
  });
});

Deno.test("normalise: *ageSeconds / *AgeSeconds keys go at any depth", () => {
  assertEquals(
    normalise({ priceAgeSeconds: 1, ageSeconds: 2, rows: [{ balanceAgeSeconds: 3, ageSecondsLater: 4 }] }),
    { rows: [{ ageSecondsLater: 4 }] },
  );
});

Deno.test("normalise: requestId, requestedFrom, pipelineLastSuccessAt are exact-key matches", () => {
  assertEquals(
    normalise({ requestId: "r", requestedFrom: "f", pipelineLastSuccessAt: "p", xrequestId: "kept", updatedAt: "kept" }),
    { xrequestId: "kept", updatedAt: "kept" },
  );
});

Deno.test("normalise: from/to go when they are timestamps and stay when they are addresses", () => {
  assertEquals(
    normalise({
      from: "2026-09-16T00:00:00Z",
      to: "2026-09-17T00:00:00.000Z",
      transfers: [{ from: "0xabc", to: "0xdef" }],
    }),
    { transfers: [{ from: "0xabc", to: "0xdef" }] },
  );
});

Deno.test("normalise: /v2/ folds to /v1/ in every string, arrays included, keys untouched", () => {
  assertEquals(
    normalise({ links: ["/v2/traders/x", "https://h/v2/a/v2/b"], self: "/v2/fields", "/v2/key": "/v3/x" }),
    { links: ["/v1/traders/x", "https://h/v1/a/v1/b"], self: "/v1/fields", "/v2/key": "/v3/x" },
  );
});

Deno.test("normalise: scalars and arrays at the top level pass through", () => {
  assertEquals(normalise("/v2/x"), "/v1/x");
  assertEquals(normalise([{ asOf: "kept at depth" }]), [{ asOf: "kept at depth" }]);
  assertEquals(normalise(null), null);
});

Deno.test("render: jq -S layout: sorted keys, two-space indent, empty containers inline", () => {
  assertEquals(
    render({ b: [], a: { d: null, c: [1, "x"] }, e: {}, f: true }),
    '{\n  "a": {\n    "c": [\n      1,\n      "x"\n    ],\n    "d": null\n  },\n  "b": [],\n  "e": {},\n  "f": true\n}\n',
  );
});

Deno.test("render: jq number and string spelling (uppercase exponent, escaped DEL)", () => {
  assertEquals(
    render([1e-7, 1.5e21, 0.000001, 100, -1.5, "a\x7fb\n\"/é"]),
    [
      "[",
      "  1E-7,",
      "  1.5E+21,",
      "  0.000001,",
      "  100,",
      "  -1.5,",
      '  "a\\u007fb\\u0001\\n\\"/é"',
      "]",
      "",
    ].join("\n"),
  );
});

Deno.test("renderKeys: the sorted top-level key list", () => {
  assertEquals(
    renderKeys({ rows: 1, apiVersion: "v1", staleFeeds: [] }),
    '[\n  "apiVersion",\n  "rows",\n  "staleFeeds"\n]\n',
  );
});
