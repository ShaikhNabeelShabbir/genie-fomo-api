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

  const rows = await sql`
    with hs as (
      select handle, network_id, count(*) filter (where human_amount > 0) as pos
      from holdings_current where handle = any(${handles}) group by 1, 2),
    /* Only chain rows that answered with a figure: the sampler's definition of a known chain (aum-sample/index.ts). */
    ah as (
      select handle, network_id, count(*) as pts
      from aum_chain_samples where handle = any(${handles}) and total_usd is not null group by 1, 2),
    pr as (
      select handle, network_id from wallet_chain_presence where handle = any(${handles})),
    seen as (
      select handle, network_id from pr
      union select handle, network_id from hs where pos > 0
      union select handle, network_id from ah),
    fam as (
      select t.handle,
             (w.sol_address is not null) as has_sol,
             (w.evm_address is not null) as has_evm
      from traders t left join wallets w using (handle)
      where t.handle = any(${handles}))
    select s.handle, c.name as chain, s.network_id,
           coalesce(hs.pos, 0) as positions,
           coalesce(ah.pts, 0) as history_points,
           case when s.network_id = ${SOLANA_NET} then fam.has_sol else fam.has_evm end
             as has_wallet
    from seen s
    join chains c using (network_id)
    join fam on fam.handle = s.handle
    left join hs on hs.handle = s.handle and hs.network_id = s.network_id
    left join ah on ah.handle = s.handle and ah.network_id = s.network_id
    order by s.handle, c.name`;

  for (const r of rows) {
    const h = String(r.handle);
    let a = out.get(h); if (!a) out.set(h, a = []);
    const pts = Number(r.history_points);
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
      /*
       * Whether this chain can be drawn on its own, by the same two-point rule the series
       * uses. `none` is not `warming`: one has never produced a reading, the other has.
       */
      historyState: pts >= 2 ? "ready" : (pts === 1 ? "warming" : "none"),
    });
  }
  return out;
}
