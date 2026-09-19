import { assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { handle } from "../supabase/functions/api/app.ts";
import "../supabase/functions/api/routes.ts";

/*
 * claims F5: the ladder's hourly and GMGN rungs had no age limit, so with DexScreener refusing us
 * /positions priced a coin at a days-old figure and summed it as current. A price past its
 * rung's age is no price: the row reads null (absent), never 0, and leaves the total.
 */

const db = await openSchema();
const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
const ago = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

const get = async (path: string): Promise<Record<string, unknown>> => {
  const res = await handle(new Request(`https://test.local/v2${path}`, { headers: { "user-agent": "positions-price-age-test/1.0" } }));
  assertEquals(res.status, 200, await res.clone().text());
  return await res.json();
};

Deno.test("/positions and the batch: an aged hourly or GMGN price is null, the rung below it still prices", async () => {
  run("insert into traders (handle, display_handle, id) values ('aged','AGED','id-aged')");
  run("insert into wallets (handle, evm_address) values ('aged','0xWaged')");
  const readAt = ago(2); // ONE capture: holdings_current keeps only the newest captured_at
  for (const k of ["0xoldstats", "0xoldinfo", "0xclose", "0xfresh"]) {
    run("insert into tokens (network_id, address, token_key, total_supply) values (1,?,?,1000000)", k, k);
    run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, source) values ('aged',1,?,?,1,'chain')", k, readAt);
  }
  const stats = (k: string, usd: number, hoursAgo: number): void =>
    run("insert into token_price_stats (network_id, token_key, ath_usd, ath_at, last_usd, last_at, drawdown_share) values (1,?,9,?,?,?,0)", k, ago(hoursAgo), usd, ago(hoursAgo));
  stats("0xoldstats", 500, 50);
  run("insert into token_info (network_id, token_key, price_usd, fetched_at) values (1,'0xoldinfo',200,?)", ago(9 * 24));
  stats("0xclose", 500, 50);
  run("insert into token_prices (network_id, token_key, day, usd, source) values (1,'0xclose',?,3,'t')", ago(0).slice(0, 10));
  stats("0xfresh", 5, 23);

  const priced = (rows: unknown): unknown[] => (rows as Record<string, unknown>[])
    .map((r) => [r.address ?? r.tokenAddress, r.priceUsd, r.priceSource, r.valueUsd]).sort();
  const expected = [
    ["0xclose", 3, "token_prices", 3],
    ["0xfresh", 5, "token_price_stats", 5],
    ["0xoldinfo", null, null, null],
    ["0xoldstats", null, null, null],
  ];
  const one = await get("/traders/aged/positions");
  assertEquals(priced(one.entries), expected);
  assertEquals(one.totalValueUsd, 8);

  const res = await handle(new Request("https://test.local/v2/traders/positions", {
    method: "POST", headers: { "content-type": "application/json", "user-agent": "positions-price-age-test/1.0" },
    body: JSON.stringify({ ids: ["aged"] }),
  }));
  assertEquals(res.status, 200, await res.clone().text());
  const batch = await res.json() as { traders: Record<string, unknown>[] };
  assertEquals(priced(batch.traders[0].positions), expected);
});

Deno.test("/positions: a directory row whose market price aged out keeps its reported entry price, as when no rung carries one", async () => {
  /* Declared, not decided: Field_Contracts lets fomo_reported_entry survive an ABSENT rung; whether it should survive an AGED one is the owner's call. */
  run("insert into traders (handle, display_handle, id) values ('dironly','DIRONLY','id-dironly')");
  run("insert into wallets (handle, evm_address) values ('dironly','0xWdironly')");
  run("insert into tokens (network_id, address, token_key, total_supply) values (1,'0xentry','0xentry',1000000)");
  run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, price, value, source, price_source, priced_at) values ('dironly',1,'0xentry',?,4,2,8,'fomo','fomo_reported_entry',?)", ago(1), ago(20 * 24));
  run("insert into token_price_stats (network_id, token_key, ath_usd, ath_at, last_usd, last_at, drawdown_share) values (1,'0xentry',900,?,500,?,0)", ago(50), ago(50));

  const one = await get("/traders/dironly/positions");
  const [row] = one.entries as Record<string, unknown>[];
  assertEquals([row.priceUsd, row.priceSource, row.valueUsd, one.totalValueUsd], [2, "fomo_reported_entry", 8, 8]);
});
