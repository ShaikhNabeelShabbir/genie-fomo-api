#!/usr/bin/env node
/**
 * Find wallets a tracked trader funded from his known Solana wallet (workflow gap 5b, W-J).
 *
 * A native SOL transfer OUT of a tracked wallet to an address that is not tracked and not a
 * known program or exchange is a funding candidate. It becomes a `linked_wallets` row
 * (`link_kind = 'funded_by'`) once the address looks used: a second transfer with it as
 * counterparty, or a first transfer of at least --min-sol.
 *
 * transactions.counterparty is stored lowercased and Helius refuses a lowercased base58
 * address, so the case-preserved spelling is read back from the evidence transaction (one
 * getTransaction per link) when HELIUS_SOLANA_KEY is set; without it the row is written with
 * `address` null and stays off the webhook until a later run resolves it.
 *
 *   node scripts/link_wallets.mjs --dry-run
 *   node scripts/link_wallets.mjs --min-sol 0.1
 */
import pg from "pg";
import { rpc, SOLANA_NETWORK_ID, SOL_MINT } from "./lib/chain_reads.mjs";

const DB = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
if (!DB) { console.error("DATABASE_URL is not set"); process.exit(1); }
const HELIUS = (process.env.HELIUS_SOLANA_KEY ?? process.env.HELIUS_KEY ?? "").trim();
const DRY = process.argv.includes("--dry-run");
const minArg = process.argv.indexOf("--min-sol");
const MIN_SOL = minArg > -1 ? Number(process.argv[minArg + 1]) : 0.05;
if (!Number.isFinite(MIN_SOL) || MIN_SOL <= 0) { console.error("--min-sol must be a positive number"); process.exit(1); }

/** Below this a native transfer is rent or dust (an ATA costs ~0.00204 SOL), never funding. */
const DUST_SOL = 0.003;

// ponytail: a seed list of programs and exchange hot wallets, lowercased to match
// transactions.counterparty. Extend as false links show up; a labels feed would replace it.
const DENY = [
  "11111111111111111111111111111111",              // system program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",   // token program
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",   // token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",  // associated token program
  "ComputeBudget111111111111111111111111111111",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",   // jupiter v6
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",  // raydium amm v4
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",   // pump.fun
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",  // binance hot wallet
  "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS",  // coinbase hot wallet
].map((a) => a.toLowerCase());

const CANDIDATES = `
  with tracked as (
    select handle, sol_address_key as k from wallets where sol_address_key is not null
  ),
  funding as (
    select w.handle, t.address_key as from_key, t.counterparty as to_key,
           t.tx_hash, t.block_time, t.amount
    from transactions t
    join tracked w on w.k = t.address_key
    where t.network_id = $1 and t.token_key = $2 and t.direction = 'out'
      and t.counterparty is not null
      and t.amount >= $3
      and t.counterparty <> all($4::text[])
      and not exists (select 1 from tracked x where x.k = t.counterparty)
  ),
  first_funding as (
    select distinct on (handle, to_key) handle, from_key, to_key, tx_hash, block_time, amount
    from funding order by handle, to_key, block_time asc nulls last
  ),
  touches as (
    select x.counterparty as k, count(*)::int as n
    from transactions x
    where x.network_id = $1 and x.counterparty in (select to_key from first_funding)
    group by x.counterparty
  )
  select f.handle, f.from_key, f.to_key, f.tx_hash, f.block_time, f.amount, coalesce(tc.n, 0) as touches
  from first_funding f
  left join touches tc on tc.k = f.to_key
  left join linked_wallets lw
    on lw.handle = f.handle and lw.network_id = $1 and lw.address_key = f.to_key
  where lw.address_key is null
    and (f.amount >= $5 or coalesce(tc.n, 0) >= 2)
  order by f.handle, f.block_time`;

/** The case-preserved spelling of `key` among the accounts of `sig`, or null. */
async function resolveCase(sig, key) {
  if (!HELIUS) return null;
  const res = await rpc(`https://mainnet.helius-rpc.com/?api-key=${HELIUS}`, {
    jsonrpc: "2.0", id: 1, method: "getTransaction",
    params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
  });
  const loaded = res?.result?.meta?.loadedAddresses ?? {};
  const keys = [
    ...(res?.result?.transaction?.message?.accountKeys ?? []).map((k) => k?.pubkey ?? k),
    ...(loaded.writable ?? []), ...(loaded.readonly ?? []),
  ];
  return keys.find((k) => typeof k === "string" && k.toLowerCase() === key) ?? null;
}

const pool = new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 1 });
async function main() {
  const c = await pool.connect();
  try {
    await c.query("set statement_timeout='0'");
    const { rows } = await c.query(CANDIDATES, [SOLANA_NETWORK_ID, SOL_MINT, DUST_SOL, DENY, MIN_SOL]);
    console.log(`${rows.length} new funded wallet(s) (min ${MIN_SOL} SOL or a second touch)`);
    if (DRY) {
      for (const r of rows) console.log(`  ${r.handle} -> ${r.to_key}  ${r.amount} SOL  touches ${r.touches}  ${r.tx_hash}`);
      return;
    }
    for (const r of rows) {
      await c.query(
        `insert into linked_wallets
           (handle, network_id, address_key, linked_from_address_key, link_kind, first_seen_at, evidence_tx)
         values ($1, $2, $3, $4, 'funded_by', $5, $6)
         on conflict (handle, network_id, address_key) do nothing`,
        [r.handle, SOLANA_NETWORK_ID, r.to_key, r.from_key, r.block_time, r.tx_hash]);
    }
    console.log(`wrote ${rows.length} linked_wallets rows`);

    // Second pass, so a row written without a key (or whose lookup failed) is retried nightly.
    const pending = await c.query(
      `select address_key, evidence_tx from linked_wallets
       where network_id = $1 and address is null and evidence_tx is not null limit 200`,
      [SOLANA_NETWORK_ID]);
    if (!HELIUS) { console.warn(`! HELIUS_SOLANA_KEY not set: ${pending.rows.length} row(s) stay off the webhook`); return; }
    let resolved = 0;
    for (const r of pending.rows) {
      const address = await resolveCase(r.evidence_tx, r.address_key).catch((e) => {
        console.warn(`  ! ${r.evidence_tx}: ${e.message}`); return null;
      });
      if (!address) continue;
      await c.query(`update linked_wallets set address = $1 where network_id = $2 and address_key = $3`,
                    [address, SOLANA_NETWORK_ID, r.address_key]);
      resolved++;
    }
    console.log(`resolved ${resolved} of ${pending.rows.length} pending address spellings`);
  } finally {
    c.release();
  }
}

main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
