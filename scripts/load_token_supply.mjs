/**
 * Read token supply so an average entry PRICE can be published as a market CAP.
 *
 * The consuming team reads entry on screen as "$717K MC", not as a per-token price, and
 * cannot safely do the conversion themselves: they measured one coin whose implied supply
 * moved 12.45% in a single day, so their multiplier and ours would disagree with no way to
 * tell which was right. Storing the supply WE used — with the time we read it and the
 * source — makes the two reconcilable instead of merely different.
 *
 * Free and keyless-ish on both sides:
 *   Solana  getTokenSupply via Helius (one call per mint, returns amount + decimals)
 *   EVM     totalSupply() + decimals() via the public RPC already in settings.ts
 *
 *   node scripts/load_token_supply.mjs            # every token that needs one
 *   node scripts/load_token_supply.mjs --limit 20
 */
import { EVM_CHAINS, SOLANA_NETWORK_ID } from "../dist/settings.js";
import { Pool } from "pg";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i+1] : d; };
const LIMIT = arg("limit", null);
const FANOUT = Number(arg("fanout", 5));
const HELIUS = (process.env.HELIUS_SOLANA_KEY ?? process.env.HELIUS_KEY ?? "").trim();

/**
 * Prefer the TRANSACTION pooler (6543) over the session pooler (5432).
 *
 * Session mode holds one Postgres connection per client for the life of the connection and
 * caps at 15. This script opening 4 alongside horizontally-scaled Edge Functions exhausted
 * that pool mid-run — the workflow died with EMAXCONNSESSION and the live API 500'd with it.
 * Transaction mode multiplexes, and every query here is a single statement per checkout,
 * which is exactly the shape it suits.
 */
const url = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
if (!url) { console.error("SUPABASE_DB_URL is not set"); process.exit(1); }
const pool = new Pool({ connectionString: url, max: 4, ssl: { rejectUnauthorized: false } });

async function batches(items, n, work) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i+n).map(work)));
  return out;
}

async function solanaSupply(mint) {
  const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenSupply", params: [mint] }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json();
  const v = j?.result?.value;
  if (!v || v.uiAmount === null || v.uiAmount === undefined) return null;
  return { supply: Number(v.uiAmount), decimals: Number(v.decimals), source: "helius" };
}

async function evmCall(rpc, to, data) {
  const r = await fetch(rpc, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json();
  return typeof j?.result === "string" && j.result !== "0x" ? j.result : null;
}

async function evmSupply(networkId, address) {
  const cfg = EVM_CHAINS[networkId];
  if (!cfg) return null;
  // totalSupply() = 0x18160ddd, decimals() = 0x313ce567
  const [rawSupply, rawDecimals] = await Promise.all([
    evmCall(cfg.rpc, address, "0x18160ddd"),
    evmCall(cfg.rpc, address, "0x313ce567"),
  ]);
  if (!rawSupply) return null;
  const decimals = rawDecimals ? Number(BigInt(rawDecimals)) : 18;
  // Scale with BigInt first: a raw supply can exceed Number's safe integer range, and
  // converting before dividing silently loses precision on exactly the large-supply memecoins
  // this is for.
  const scaled = Number(BigInt(rawSupply)) / 10 ** decimals;
  if (!Number.isFinite(scaled) || scaled <= 0) return null;
  return { supply: scaled, decimals, source: "rpc" };
}

async function main() {
  // Only tokens where a supply would actually be used: something has an entry price for it.
  let sql = `
    select tk.network_id, tk.address, tk.token_key
    from tokens tk
    where tk.total_supply is null
      and exists (select 1 from trades t
                  where t.network_id = tk.network_id and t.token_key = tk.token_key
                    and t.avg_entry_price > 0)
    order by tk.network_id, tk.address`;
  if (LIMIT) sql += ` limit ${Number(LIMIT)}`;
  const { rows } = await pool.query(sql);
  console.log(`resolving supply for ${rows.length} tokens (fanout ${FANOUT})`);

  let ok = 0, miss = 0, done = 0;
  const found = [];
  await batches(rows, FANOUT, async (t) => {
    const net = Number(t.network_id);
    let res = null;
    try {
      res = net === SOLANA_NETWORK_ID ? await solanaSupply(t.address) : await evmSupply(net, t.address);
    } catch { res = null; }
    done++;
    if (res) { ok++; found.push([res.supply, res.decimals, res.source, net, t.token_key]); }
    else miss++;
    if (done % 50 === 0) console.log(`  [${done}/${rows.length}] ${ok} resolved, ${miss} unknown`);
  });

  if (found.length) {
    const c = await pool.connect();
    try {
      for (const f of found) {
        await c.query(
          `update tokens set total_supply=$1, decimals=$2, supply_source=$3, supply_read_at=now()
           where network_id=$4 and token_key=$5`, f);
      }
    } finally { c.release(); }
  }
  const { rows: [tot] } = await pool.query("select count(total_supply)::int n from tokens");
  console.log(`\nresolved ${ok} · unknown ${miss} · tokens with a supply now: ${tot.n}`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
