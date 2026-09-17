import { assertEquals } from "jsr:@std/assert@1";
import { md5, numericText, transferKey } from "../supabase/functions/_shared/md5.ts";

// RFC 1321 test suite vectors; `transfer_key` rows written by Postgres must keep matching.

Deno.test("md5: RFC 1321 vectors", () => {
  assertEquals(md5(""), "d41d8cd98f00b204e9800998ecf8427e");
  assertEquals(md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
  assertEquals(md5("message digest"), "f96b697d7cb7938d525a2f31aaf161d0");
  assertEquals(md5("abcdefghijklmnopqrstuvwxyz"), "c3fcd3d76192e4007dfb496cca67e13b");
  assertEquals(
    md5("12345678901234567890123456789012345678901234567890123456789012345678901234567890"),
    "57edf4a22be3c955ac49da2e2107b67a",
  );
});

Deno.test("md5: spans several 64-byte blocks and handles UTF-8", () => {
  assertEquals(md5("a".repeat(1000)), "cabe45dcc9ae5b66ba86600cca6b8ba8");
  assertEquals(md5("é"), "66ddcd97cfdeabb2f6fb8a999b4bc76f");
});

Deno.test("numericText: JS exponent notation expands the way Postgres printed numeric::text", () => {
  assertEquals(numericText(5), "5");
  assertEquals(numericText(1.5), "1.5");
  assertEquals(numericText(0.000001), "0.000001");
  assertEquals(numericText(1e-9), "0.000000001");
  assertEquals(numericText(-1.25e-7), "-0.000000125");
  assertEquals(numericText(1e21), "1000000000000000000000");
  assertEquals(numericText(1.5e21), "1500000000000000000000");
  assertEquals(numericText(0), "0");
});

Deno.test("transferKey: the Postgres digest of (token, direction, counterparty, amount)", () => {
  // select md5(coalesce('mint','')||'|'||coalesce('in','')||'|'||coalesce('cp','')||'|'||coalesce(5::numeric::text,''))
  assertEquals(transferKey("mint", "in", "cp", 5), md5("mint|in|cp|5"));
  assertEquals(transferKey(null, null, null, null), md5("|||"));
  assertEquals(transferKey("mint", "out", null, 1e-9), md5("mint|out||0.000000001"));
});
