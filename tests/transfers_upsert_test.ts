import { assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { upsertText } from "../worker/src/jobs/transfers-core.ts";

/** The statement as it was until 19 Sep 2026, verbatim: every conflict was a write. */
const OLD = `insert into transactions
           (network_id, tx_hash, address_key, transfer_key, block_time, direction,
            counterparty, token_key, token_symbol, amount, source, tx_type, tx_source)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?)
         on conflict (network_id, tx_hash, address_key, transfer_key) do update set
           block_time = excluded.block_time, token_symbol = excluded.token_symbol,
           amount = excluded.amount, source = excluded.source,
           tx_type = coalesce(excluded.tx_type, transactions.tx_type),
           tx_source = coalesce(excluded.tx_source, transactions.tx_source),
           ingested_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

type Cell = string | number | null;
const row = (over: Partial<Record<"block_time" | "token_symbol" | "amount" | "source" | "tx_type" | "tx_source", Cell>> = {}): Cell[] => {
  const r = { block_time: "2026-09-19T10:00:00.000Z", token_symbol: "COIN", amount: 5, source: "helius-webhook", tx_type: "SWAP", tx_source: "JUPITER", ...over };
  return [1, "sig1", "so1wallet", "key1", r.block_time, "in", "other", "mint1", r.token_symbol, r.amount, r.source, r.tx_type, r.tx_source];
};
/** What the row holds after the block_time steps; the amount and tx_source steps build on it. */
const LATE = { source: "helius", tx_type: "TRANSFER", token_symbol: "COIN2", block_time: null } as const;

/** [the row written, whether the NEW statement must write it]. */
const STEPS: readonly [Cell[], boolean][] = [
  [row(), true],                                   // first sight
  [row(), false],                                  // the hourly re-read of a row already held
  [row({ source: "helius" }), true],               // the pull claims a webhook row: the next pull stops at it
  [row({ source: "helius", tx_type: null, tx_source: null }), false], // a provider that names no type erases nothing
  [row({ source: "helius", tx_type: "TRANSFER" }), true],
  [row({ source: "helius", tx_type: "TRANSFER", token_symbol: "COIN2" }), true],
  [row({ source: "helius", tx_type: "TRANSFER", token_symbol: "COIN2", block_time: null }), true],
  [row({ source: "helius", tx_type: "TRANSFER", token_symbol: "COIN2", block_time: null }), false],
  [row({ ...LATE, amount: 6 }), true],                                  // a corrected amount is a change
  [row({ ...LATE, amount: 6, tx_source: "RAYDIUM" }), true],            // so is a venue the provider now names
  [row({ ...LATE, amount: 6, tx_source: null }), false],                // and a venue it no longer names erases nothing
];

Deno.test("the transfer upsert: a conflict that changes nothing is not a write, and every other outcome is the old statement's", async () => {
  const [oldDb, newDb] = [await openSchema(), await openSchema()];
  const stored = "select network_id, tx_hash, address_key, transfer_key, block_time, direction, counterparty, token_key, token_symbol, amount, source, tx_type, tx_source from transactions";
  for (const [cells, writes] of STEPS) {
    assertEquals(Number(oldDb.prepare(OLD).run(...cells).changes), 1, "the old statement wrote on every conflict");
    assertEquals(Number(newDb.prepare(upsertText(1)).run(...cells).changes), writes ? 1 : 0);
    assertEquals(newDb.prepare(stored).all(), oldDb.prepare(stored).all());
  }
  const held = STEPS[STEPS.length - 1][0];
  assertEquals(Number(newDb.prepare(upsertText(2)).run(...held, ...held.with(1, "sig2")).changes), 1, "in a two-row statement only the new signature is written");
});
