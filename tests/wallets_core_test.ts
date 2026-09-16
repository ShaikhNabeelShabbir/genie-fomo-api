import { assertEquals } from "jsr:@std/assert@1";

const { linkedBody } = await import("../supabase/functions/api/shared/wallets-core.ts");

Deno.test("gap 5b: linkedBody prefers the case-preserved address and falls back to the key", () => {
  const row = {
    chain: "solana", address: null, address_key: "abc123", linked_from_address_key: "def456",
    link_kind: "funded_by", first_seen_at: "2026-09-10T00:00:00Z", evidence_tx: "5sig", watch: true,
  };
  assertEquals(linkedBody(row), {
    chain: "solana", address: "abc123", linkedFrom: "def456", kind: "funded_by",
    firstSeenAt: "2026-09-10T00:00:00.000Z", evidenceTx: "5sig", watch: true,
  });
  const cased = linkedBody({ ...row, address: "AbC123", first_seen_at: null, evidence_tx: null, watch: false });
  assertEquals([cased.address, cased.firstSeenAt, cased.evidenceTx, cased.watch], ["AbC123", null, null, false]);
});
