import { assertEquals } from "jsr:@std/assert@1";
import { bondingCurveAddress, decodeCurve, PUMP_PROGRAM } from "../supabase/functions/_shared/pumpfun.ts";
import { base58Decode, base58Encode, findProgramAddress, isOnCurve } from "../supabase/functions/_shared/solana_pda.ts";

// Live accounts read on 17 Sep 2026 (docs/LAUNCH_METADATA.md).
const FRESH = "F7f4N2DYrGAAENhH488DAAGsI/wGAAAAAHjF+1HRAgABAAAAAAAAAACAxqR+jQMAAJGeENILkcl8RIGFb9p7IFjn+H4B2EbaobK3gduBUdFnAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const GRADUATED = "F7f4N2DYrGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAxqR+jQMAAVluheW10XvHMiZPkFp9lzrDqRS0OSrDCsQEhS7mkAAiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

Deno.test("solana_pda: base58 round trip, a program id is on the curve, the global PDA matches", async () => {
  assertEquals(base58Encode(base58Decode(PUMP_PROGRAM)), PUMP_PROGRAM);
  assertEquals(isOnCurve(base58Decode(PUMP_PROGRAM)), true);
  const pda = await findProgramAddress([new TextEncoder().encode("global")], PUMP_PROGRAM);
  assertEquals(pda.address, "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
  assertEquals(isOnCurve(base58Decode(pda.address)), false);
});

Deno.test("bondingCurveAddress: the PDA pump.fun derives for a mint", async () => {
  const mints: [string, string][] = [
    ["iG8wRS2S8LRVQQnUhYTDmbv5i9VF9tGQzbTo65Ppump", "B14UGdKJR4jEs8q6GYUA9vSi1NKZa7fHnNGTf9tMFrqA"],
    ["2NEPGSZ3GUiWL7ZYRyrnSveFNqvewAy3oEGK7Zxapump", "DgUkPv3uSN9HLKgYd36sh26koyPLRNXYQ4k2Fxzi7t1R"],
  ];
  for (const [mint, curve] of mints) {
    assertEquals(await bondingCurveAddress(mint), curve);
  }
});

Deno.test("decodeCurve: untouched curve is 0, graduated curve is 1, other bytes are null", () => {
  assertEquals(decodeCurve(b64(FRESH)), { progress: 0, graduated: false });
  assertEquals(decodeCurve(b64(GRADUATED)), { progress: 1, graduated: true });
  assertEquals(decodeCurve(new Uint8Array(64)), null);
  // Half the real reserves sold: 396,550,000 tokens left of 793,100,000.
  const half = b64(FRESH);
  new DataView(half.buffer).setBigUint64(24, 396_550_000_000_000n, true);
  assertEquals(decodeCurve(half), { progress: 0.5, graduated: false });
});
