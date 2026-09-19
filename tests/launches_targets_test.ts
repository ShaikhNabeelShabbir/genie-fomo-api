import { assert, assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { getDefaultSql } from "../supabase/functions/api/db.ts";
import { launchTargets } from "../worker/src/jobs/launches-core.ts";

const SOLANA = 1399811149, BASE = 8453;

/** The statement as shipped until 19 Sep 2026, verbatim but for the bound chain: two left joins over derived tables SQLite does not index. */
const SHIPPED = `
  select tk.address, tk.token_key, tk.created_at
    from tokens tk
    left join (select distinct network_id, token_key from holdings_current) h
      on h.network_id = tk.network_id and h.token_key = tk.token_key
    left join (select distinct network_id, token_key from transactions
                where network_id = ${SOLANA}
                  and block_time > strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')) t
      on t.network_id = tk.network_id and t.token_key = tk.token_key
   where tk.network_id = ${SOLANA}
     and (tk.launch_read_at is null or tk.graduated = 0)
     and (h.token_key is not null or t.token_key is not null)
   order by tk.launch_read_at, tk.address`;

Deno.test("launchTargets: the same rows in the same order as the shipped joins, and every token seeks", async () => {
  const prepared: string[] = [];
  const db = await openSchema((text) => prepared.push(text));
  const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
  const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();
  for (const h of ["a", "b", "c"]) run("insert into traders (handle, display_handle, id) values (?,?,?)", h, h, `id-${h}`);
  for (let i = 0; i < 240; i++) {
    const key = `mint${String(i).padStart(3, "0")}`;
    // Read state cycles through never read, read and on its curve, read and graduated, read and not pump.fun.
    const [readAt, graduated] = [[null, null], [ago(1 + i % 5), 0], [ago(2), 1], [ago(3), null]][i % 4] as [string | null, number | null];
    run("insert into tokens (network_id, address, token_key, launch_read_at, graduated, created_at) values (?,?,?,?,?,?)", SOLANA, key, key, readAt, graduated, i % 8 === 1 ? ago(40) : null);
    if (i % 10 === 0) run("insert into tokens (network_id, address, token_key) values (?,?,?)", BASE, key, key);   // a Base twin of the same key
    const hold = (handle: string, net: number, source: string, capturedAt: string): void =>
      run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, source) values (?,?,?,?,5,?)", handle, net, key, capturedAt, source);
    if (i % 3 === 0) hold("a", SOLANA, "chain", ago(0.1));             // held now, read on chain
    if (i % 3 === 0 && i % 2 === 0) hold("b", SOLANA, "chain", ago(0.2)); // held twice: still one target
    if (i % 7 === 0) hold("a", SOLANA, "chain", ago(9));               // only in a superseded capture: not held
    if (i % 5 === 0) hold("c", SOLANA, "fomo", ago(0.5));              // fomo-reported, no chain read for c
    if (i % 10 === 0 && i % 20 === 0) hold("c", BASE, "fomo", ago(0.5)); // held on Base only under the twin key
    const move = (net: number, at: string | null): void =>
      run("insert into transactions (network_id, tx_hash, address_key, transfer_key, block_time, token_key, source) values (?,?,?,?,?,?,'t')", net, `tx${net}-${i}-${at}`, "w", "k", at, key);
    if (i % 4 === 1) move(SOLANA, ago(3));
    if (i % 4 === 1) move(SOLANA, ago(4));                             // moved twice: still one target
    if (i % 6 === 2) move(SOLANA, ago(45));                            // outside the 30 days
    if (i % 9 === 2) move(SOLANA, null);
    if (i % 10 === 0) move(BASE, ago(1));                              // moved on Base only
  }
  const shipped = db.prepare(SHIPPED).all() as { address: string; token_key: string; created_at: string | null }[];
  const rows = await launchTargets(getDefaultSql()!, SOLANA);
  assert(shipped.length > 50 && shipped.length < 240, `the seed must admit some and refuse some, saw ${shipped.length}`);
  assertEquals(rows.map((r) => ({ ...r })), shipped.map((r) => ({ ...r })));

  // The plan of the statement AS PREPARED: each set is an in-list the tokens seek, and no derived table is scanned per token.
  const plan = (db.prepare(`explain query plan ${prepared.find((t) => t.includes("launch_read_at"))}`).all(SOLANA, SOLANA, SOLANA) as { detail: string }[]).map((r) => r.detail);
  assertEquals(plan.filter((d) => d.includes("LEFT-JOIN")), [], plan.join(" | "));
  assertEquals(plan.filter((d) => d.startsWith("LIST SUBQUERY")).length, 2, plan.join(" | "));
});
