import { assertEquals } from "jsr:@std/assert@1";

// db.ts reads DB_URL at import; `deno task test` sets a dummy so the pure helpers load.
const { sellFlags, unsellable } = await import("../supabase/functions/api/shared/positions-core.ts");

Deno.test("V2: honeypot / cannot-sell flags mark a row unsellable; unjudged stays null", () => {
  assertEquals(unsellable({ is_honeypot: true, can_not_sell: null }), true);
  assertEquals(unsellable({ is_honeypot: false, can_not_sell: true }), true);
  assertEquals(unsellable({ is_honeypot: null, can_not_sell: null }), false);
  assertEquals(sellFlags({ is_honeypot: null, can_not_sell: null }), { isHoneypot: false, canSell: null });
  assertEquals(sellFlags({ is_honeypot: true, can_not_sell: true }), { isHoneypot: true, canSell: false });
  assertEquals(sellFlags({ is_honeypot: false, can_not_sell: false }), { isHoneypot: false, canSell: true });
});
