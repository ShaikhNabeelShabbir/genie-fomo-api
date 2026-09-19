import { sql } from "../db.ts";
import { get } from "../router.ts";
import { badRequest } from "../errors.ts";

/** PARAMETERS.md routes, served from Postgres. See docs/DECISIONS.md#d127 */

export const chainWhere = async (chain: string | null) => {
  if (!chain) return null;
  const [row] = await sql`select network_id from chains where name = ${chain.toLowerCase()}`;
  if (!row) throw badRequest(`unknown chain '${chain}'`);
  return Number(row.network_id);
};

export async function resolveChain(chainKey: string): Promise<{ network_id: number; name: string } | null> {
  if (!chainKey) return null;
  const [c] = await sql`select network_id, name from chains where name = ${chainKey}`;
  if (!c) {
    const all = await sql<{ name: string }[]>`select name from chains order by name`;
    throw badRequest(
      `'chain' must be one of ${all.map((r: { name: string }) => r.name).join(", ")} — got '${chainKey}'`,
      { parameter: "chain" },
    );
  }
  return { network_id: Number(c.network_id), name: String(c.name) };
}

/** Solana's network id, needed to tell the one Solana wallet from the one EVM wallet. */
export const SOLANA_NET = 1399811149;


// ----------------------------------------------------------------- wallets

/** EVERY CHAIN A TRADER USES, independent of any window or any single reading. See docs/DECISIONS.md#d128 */
export type KnownChain = {
  chain: string; networkId: number; wallets: number;
  hasPositions: boolean; historyState: string;
};

export async function knownChainsFor(handles: string[]): Promise<Map<string, KnownChain[]>> {
  const out = new Map<string, KnownChain[]>();
  if (!handles.length) return out;

  /*
   * The `trader_chain_history` rule (a chain is seen if traded on, held on, or sampled on), asked
   * per (handle, chain) so every arm is an index seek. Reading the VIEW with a handle filter
   * aggregated all of `trades`, `holdings_current` and `aum_chain_samples` first: SQLite does not
   * push a filter through a grouped union, so one page of wallets cost a pass over three tables
   * (19 Sep 2026). `limit 2` because the series rule only asks "none, one, or at least two".
   */
  const rows = await sql`
    select * from (
      select p.value as handle, c.name as chain, c.network_id,
             -- The unary + keeps the planner off trades_token_idx (network_id), which reads a whole
             -- chain's trades to find one handle; D1 has no statistics to tell it otherwise.
             exists (select 1 from trades tr
                     where tr.handle = p.value and +tr.network_id = c.network_id) as traded,
             -- EXISTS, not count(*): an aggregate over the compound view materialises all of it.
             exists (select 1 from holdings_current hc
                     where hc.handle = p.value and hc.network_id = c.network_id and hc.human_amount > 0) as positions,
             (select count(*) from (select 1 from aum_chain_samples s
                                    where s.handle = p.value and s.network_id = c.network_id
                                      and s.total_usd is not null limit 2)) as history_points,
             case when c.network_id = ${SOLANA_NET} then w.sol_address is not null
                  else w.evm_address is not null end as has_wallet
      from json_each(${JSON.stringify(handles)}) p
      cross join chains c
      left join wallets w on w.handle = p.value)
    where traded or positions or history_points > 0
    order by handle, chain`;

  for (const r of rows) {
    const h = String(r.handle);
    let a = out.get(h); if (!a) out.set(h, a = []);
    a.push({
      chain: String(r.chain),
      networkId: Number(r.network_id),
      /*
       * One Ethereum-style address serves four chains, so this is 1 whenever the family that
       * reaches this chain is on record, and 0 when the chain is evidenced but the address
       * behind it is not -- which is a real state and worth seeing rather than assuming.
       */
      wallets: Number(r.has_wallet) ? 1 : 0,
      hasPositions: Number(r.positions) > 0,
      /* ready | warming | none by the series' two-point rule, decided in the view. */
      historyState: Number(r.history_points) >= 2 ? "ready" : Number(r.history_points) === 1 ? "warming" : "none",
    });
  }
  return out;
}
