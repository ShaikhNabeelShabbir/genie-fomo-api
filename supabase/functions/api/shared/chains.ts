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

  /* `trader_chain_history` (migration 20260917230000) is the one definition of a seen chain. */
  const rows = await sql`
    select h.handle, h.chain, h.network_id, h.positions, h.history_state,
           case when h.network_id = ${SOLANA_NET} then w.sol_address is not null
                else w.evm_address is not null end as has_wallet
    from trader_chain_history h
    left join wallets w using (handle)
    where h.handle = any(${handles})
    order by h.handle, h.chain`;

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
      wallets: r.has_wallet === true ? 1 : 0,
      hasPositions: Number(r.positions) > 0,
      /* ready | warming | none by the series' two-point rule, decided in the view. */
      historyState: String(r.history_state),
    });
  }
  return out;
}
