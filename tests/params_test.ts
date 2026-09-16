import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { isoParam, parseIso } from "../supabase/functions/api/shared/params.ts";

Deno.test("parseIso / isoParam: absent is null, valid is normalised, garbage is a 400", () => {
  assertEquals(isoParam(new URL("http://x/"), "since"), null);
  assertEquals(isoParam(new URL("http://x/?since="), "since"), null);
  assertEquals(isoParam(new URL("http://x/?since=2026-09-17T06:00:00Z"), "since"), "2026-09-17T06:00:00.000Z");
  assertEquals(parseIso("2026-09-17", "since"), "2026-09-17T00:00:00.000Z");
  assertEquals(parseIso(undefined, "since"), null);
  const e = assertThrows(() => parseIso("yesterday", "since"));
  assertEquals((e as { status: number }).status, 400);
});
