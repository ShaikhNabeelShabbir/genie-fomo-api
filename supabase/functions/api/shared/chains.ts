import { sql } from "../db.ts";
import { get } from "../router.ts";
import { badRequest } from "../errors.ts";

/**
 * PARAMETERS.md routes, served from Postgres.
 *
 * Two rules carry over from the Express implementation and are the reason several of these
 * queries look more careful than they need to:
 *
 *   A MISSING PRICE IS NOT ZERO.  `value` is nullable and 1,688 of 2,038 rows have none.
 *   SQL's `sum()` skips nulls, which is what we want — but `count(*)` does not, so every
 *   ratio here names the column it counts rather than counting rows.
 *
 *   A RATIO SHIPS WITH ITS DENOMINATOR.  A concentration of 97% computed over 44% of a
 *   portfolio is not a fact about the portfolio, so `coverage` travels with every figure.
 */

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
    const all = await sql`select name from chains order by name`;
    throw badRequest(
      `'chain' must be one of ${all.map((r) => r.name).join(", ")} — got '${chainKey}'`,
      { parameter: "chain" },
    );
  }
  return { network_id: Number(c.network_id), name: String(c.name) };
}

/** Solana's network id, needed to tell the one Solana wallet from the one EVM wallet. */
export const SOLANA_NET = 1399811149;


// ----------------------------------------------------------------- wallets

/**
 * EVERY CHAIN A TRADER USES, independent of any window or any single reading.
 *
 * `aum.chains` lists the chains in the NEWEST reading, which is a fact about that reading and
 * not about the trader -- it showed Solana alone for a trader whose portfolio spans five. A
 * consumer drawing chain switches from it offered 128 of 435 traders fewer switches than the
 * service itself says they use.
 *
 * So the list is built from every place a chain can be evidenced, unioned:
 *   - a chain his wallets have been SEEN trading on (wallet_chain_presence)
 *   - a chain he currently HOLDS something on (holdings_current)
 *   - a chain we hold BALANCE HISTORY for (aum_chain_samples)
 *
 * Set-based over every handle at once, so the batch routes pay one query rather than fifty:
 * measured 116 ms for fifty traders.
 */
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
    ah as (
      select handle, network_id, count(*) filter (where total_usd is not null) as pts
      from aum_chain_samples where handle = any(${handles}) group by 1, 2),
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
