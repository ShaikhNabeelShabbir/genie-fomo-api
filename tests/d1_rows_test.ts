import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { convertRow, insertStatements, parsePgArray, toIsoUtc } from "../scripts/lib/d1_rows.ts";

Deno.test("toIsoUtc: Postgres CSV renderings normalise to UTC millisecond ISO", () => {
  assertEquals(toIsoUtc("2026-09-17 04:25:11.123+00"), "2026-09-17T04:25:11.123Z");
  assertEquals(toIsoUtc("2026-09-17 04:25:11+00"), "2026-09-17T04:25:11.000Z");
  assertEquals(toIsoUtc("2026-09-17 04:25:11.123456+00"), "2026-09-17T04:25:11.123Z");
  assertEquals(toIsoUtc("2026-09-17 04:25:11.5+05:30"), "2026-09-16T22:55:11.500Z");
  assertEquals(toIsoUtc("2026-09-17 04:25:11-0430"), "2026-09-17T08:55:11.000Z");
  assertEquals(toIsoUtc("2026-09-17 04:25:11"), "2026-09-17T04:25:11.000Z");
  assertThrows(() => toIsoUtc("yesterday"), TypeError);
  assertThrows(() => toIsoUtc("2026-13-45 04:25:11+00"), TypeError);
});

Deno.test("parsePgArray: quoting, escapes, NULL, empty", () => {
  assertEquals(parsePgArray("{}"), []);
  assertEquals(parsePgArray('{a,"b c",NULL,"q\\"x",""}'), ["a", "b c", null, 'q"x', ""]);
  assertEquals(parsePgArray('{"a,b",c}'), ["a,b", "c"]);
  assertThrows(() => parsePgArray("a,b"), TypeError);
  assertThrows(() => parsePgArray('{"a}'), TypeError);
});

Deno.test("convertRow: every type in the map", () => {
  const columns = [
    { name: "at", type: "timestamp with time zone" },
    { name: "day", type: "date" },
    { name: "amount", type: "numeric" },
    { name: "ratio", type: "double precision" },
    { name: "small", type: "real" },
    { name: "big", type: "bigint" },
    { name: "n", type: "integer" },
    { name: "yes", type: "boolean" },
    { name: "no", type: "boolean" },
    { name: "raw", type: "jsonb" },
    { name: "id", type: "uuid" },
    { name: "tags", type: "ARRAY" },
    { name: "more", type: "text[]" },
    { name: "note", type: "text" },
    { name: "gone", type: "text" },
  ];
  const fields = [
    "2026-09-17 04:25:11+00",
    "2026-09-17",
    "12.500",
    "1e-7",
    "0.25",
    "9007199254740991",
    "-3",
    "t",
    "f",
    '{"a": [1, 2]}',
    "3f1c2c6e-4a5e-4b0e-9f1e-2a3b4c5d6e7f",
    '{x,"y z"}',
    "{1,NULL}",
    "it's",
    null,
  ];
  assertEquals(convertRow(fields, columns), [
    "2026-09-17T04:25:11.000Z",
    "2026-09-17",
    12.5,
    1e-7,
    0.25,
    9007199254740991,
    -3,
    1,
    0,
    '{"a": [1, 2]}',
    "3f1c2c6e-4a5e-4b0e-9f1e-2a3b4c5d6e7f",
    '["x","y z"]',
    '["1",null]',
    "it's",
    null,
  ]);
});

Deno.test("convertRow: rejects what it cannot represent", () => {
  assertThrows(() => convertRow(["9007199254740992"], [{ name: "b", type: "bigint" }]), RangeError);
  assertThrows(() => convertRow(["1.5"], [{ name: "b", type: "integer" }]), TypeError);
  assertThrows(() => convertRow(["NaN"], [{ name: "r", type: "numeric" }]), TypeError);
  assertThrows(() => convertRow([""], [{ name: "r", type: "numeric" }]), TypeError);
  assertThrows(() => convertRow(["yes"], [{ name: "b", type: "boolean" }]), TypeError);
  assertThrows(() => convertRow(["a", "b"], [{ name: "a", type: "text" }]), RangeError);
});

Deno.test("insertStatements: literals, quoting, NULL", () => {
  assertEquals(
    insertStatements("traders", ["handle", "n", "at"], [["o'neil", 1, null], ["b", 2.5, "x"]]),
    [`insert or ignore into "traders" ("handle","n","at") values ('o''neil',1,NULL),('b',2.5,'x');`],
  );
  assertEquals(insertStatements("t", ["a"], []), []);
});

Deno.test("insertStatements: chunks so no statement exceeds maxBytes", () => {
  const rows = Array.from({ length: 50 }, (_, i) => [`row-${String(i).padStart(3, "0")}`]);
  const statements = insertStatements("t", ["a"], rows, 120);
  const encoder = new TextEncoder();
  assertEquals(statements.length > 1, true);
  for (const statement of statements) assertEquals(encoder.encode(statement).length <= 120, true);
  assertEquals(statements.join("").match(/\('row-/g)?.length, 50);
  assertEquals(statements.at(-1)?.endsWith("('row-049');"), true);
  assertThrows(() => insertStatements("t", ["a"], [["x".repeat(200)]], 120), RangeError);
});
