#!/usr/bin/env node
/**
 * Build `trades` rows for GMGN-sourced traders from GMGN's own activity feed.
 *
 * The traders added by load_gmgn_traders.mjs have a wallet and nothing else, so every route
 * that reads `trades` answers empty for them. This fills that in.
 *
 * WHY NOT PURELY ON-CHAIN. Solana would work -- resolve_wallet_swaps.mjs already does it --
 * but step 4a measured that the EVM chains carry essentially no resolvable on-chain swaps
 * (81 swap-shaped groups across all four), so an on-chain-only path would serve Solana and
 * leave the other four chains empty. `wallet_activity` is on the key we already hold and is
 * the same feed axis-api-queries.md specifies as Q4.
 *
 * SHAPE. fomo gives one row per (trader, token) position; this aggregates the per-trade
 * activity into exactly that shape, so `trades` stays one table with one meaning and every
 * existing route works unchanged.
 *
 *   buys   ->  avg_entry_price = Σ cost_usd / Σ token_amount
 *   sells  ->  avg_exit_price  = Σ cost_usd / Σ token_amount
 *              realized_pnl    = Σ (cost_usd - buy_cost_usd)      <- the spec's own formula
 *
 * `unrealized_pnl_usd` is left NULL rather than computed: it needs a current price we do not
 * have for most of these tokens, and 0 would read as "this position is exactly flat".
 *
 *   node scripts/load_gmgn_trades.mjs --limit 5 --dry-run
 *   node scripts/load_gmgn_trades.mjs --pages 15
 */
import pg from "pg";

const DB  = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
const KEY = (process.env.GMGN_API_KEY ?? "").trim();
if (!DB || !KEY) { console.error("DATABASE_URL and GMGN_API_KEY are required"); process.exit(1); }

const CHAINS = { sol: 1399811149, bsc: 56, base: 8453, eth: 1, robinhood: 4663 };
const EVM = ["bsc", "base", "eth", "robinhood"];
const arg = (n,d=null)=>{const i=process.argv.indexOf(`--${n}`);return i>-1&&process.argv[i+1]?process.argv[i+1]:d;};
const DRY   = process.argv.includes("--dry-run");
const LIMIT = Number(arg("limit","0")) || null;
const PAGES = Number(arg("pages","12"));

const pool = new pg.Pool({ connectionString: DB, ssl:{rejectUnauthorized:false}, max: 4 });
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const num = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
/**
 * Postgres rejects \u0000 in a text column outright -- "invalid byte sequence for encoding
 * UTF8" -- and it is not a corrupt response, it is a token whose symbol genuinely contains a
 * null byte. One of them killed this run at trader 25 of 288 and the same thing killed the
 * token crawl at 976 of 1,083. Anything token-authored is scrubbed on the way in.
 */
const clean = v => (typeof v === "string" ? v.replace(/\u0000/g, "").replace(/\\u0000/g, "") || null : (v ?? null));

/** wallet_activity is weight 3 on a rate-20 bucket -> ~6.7 req/s sustained. 320ms is safe. */
async function activity(chain, wallet, cursor) {
  for (let i=1;;i++) {
    try {
      const qs = new URLSearchParams({ timestamp:String(Math.floor(Date.now()/1000)), client_id:crypto.randomUUID(),
        chain, wallet_address: wallet, limit:"100", ...(cursor?{cursor}:{}) });
      const r = await fetch(`https://openapi.gmgn.ai/v1/user/wallet_activity?${qs}`,
        { headers:{ "X-APIKEY":KEY, Accept:"application/json" }, signal:AbortSignal.timeout(30_000) });
      const j = await r.json().catch(()=>null);
      if (r.status===429 || j?.error?.startsWith?.("RATE_LIMIT")) throw Object.assign(new Error("RATE_LIMIT"),{wait:6000*i});
      if (j?.code !== 0) throw new Error(String(j?.msg ?? j?.message ?? `code ${j?.code}`).slice(0,60));
      return j.data ?? {};
    } catch(e) { if (i>=4) throw e; await sleep(e.wait ?? 700*i); }
  }
}

/**
 * Fold one wallet's activity on one chain into per-token positions.
 *
 * transferIn / transferOut are excluded exactly as the spec instructs: they move tokens
 * without being trades, and counting them would invent an entry price out of a gift.
 */
function fold(acts, networkId) {
  const byToken = new Map();
  for (const a of acts) {
    const kind = a.event_type ?? a.type;
    if (kind !== "buy" && kind !== "sell") continue;
    const addr = a.token?.address; if (!addr) continue;
    const key = addr.toLowerCase();
    const rec = byToken.get(key) ?? { address: addr, symbol: clean(a.token?.symbol),
      supply: num(a.token?.total_supply), qtyIn:0, costIn:0, qtyOut:0, proceeds:0, basis:0,
      firstBuy:null, lastSell:null, buys:0, sells:0 };
    const qty = num(a.token_amount) ?? 0, usd = num(a.cost_usd);
    const ts = a.timestamp ? Number(a.timestamp)*1000 : null;
    if (kind === "buy") {
      rec.buys++; rec.qtyIn += qty; if (usd !== null) rec.costIn += usd;
      if (ts && (rec.firstBuy===null || ts < rec.firstBuy)) rec.firstBuy = ts;
    } else {
      rec.sells++; rec.qtyOut += qty;
      if (usd !== null) rec.proceeds += usd;
      const b = num(a.buy_cost_usd); if (b !== null) rec.basis += b;
      if (ts && (rec.lastSell===null || ts > rec.lastSell)) rec.lastSell = ts;
    }
    rec.supply ??= num(a.token?.total_supply);
    byToken.set(key, rec);
  }
  const out = [];
  for (const [key, r] of byToken) {
    // Sold essentially everything they bought -> the position is closed. 1% absorbs the
    // rounding in a UI-unit amount; it is not a tolerance for a real residual.
    const closed = r.qtyIn > 0 && r.qtyOut >= r.qtyIn * 0.99;
    out.push({
      network_id: networkId, token_key: key, token_address: r.address, token_symbol: r.symbol,
      status: closed ? "closed" : "open",
      amount: r.qtyIn > 0 ? r.qtyIn : (r.qtyOut || null),
      // A $0 price means "we could not value it", never "they got in for nothing".
      avg_entry_price: r.qtyIn > 0 && r.costIn > 0 ? r.costIn / r.qtyIn : null,
      avg_exit_price:  r.qtyOut > 0 && r.proceeds > 0 ? r.proceeds / r.qtyOut : null,
      realized_pnl_usd: r.sells > 0 && r.basis > 0 ? r.proceeds - r.basis : null,
      opened_at: r.firstBuy ? new Date(r.firstBuy).toISOString() : null,
      closed_at: closed && r.lastSell ? new Date(r.lastSell).toISOString() : null,
      total_supply: r.supply,
    });
  }
  return out;
}

async function main() {
  const c = await pool.connect();
  try {
    const { rows: targets } = await c.query(`
      select t.handle, w.sol_address, w.evm_address
      from traders t join wallets w on w.handle = t.handle
      where t.source = 'gmgn'
        and not exists (select 1 from trades tr where tr.handle = t.handle)
      order by t.handle ${LIMIT ? `limit ${LIMIT}` : ""}`);
    console.log(`${targets.length} GMGN trader(s) with no trades yet${DRY?"  [DRY RUN]":""}`);
    if (!targets.length) return;

    const capturedAt = new Date();
    let done=0, totalRows=0, withTrades=0, failed=0;
    for (const t of targets) {
      const rows = [];
      const jobs = [];
      if (t.sol_address) jobs.push(["sol", t.sol_address]);
      if (t.evm_address) for (const ch of EVM) jobs.push([ch, t.evm_address]);

      for (const [chain, wallet] of jobs) {
        const acts = [];
        let cursor = null;
        for (let p=0; p<PAGES; p++) {
          let d; try { d = await activity(chain, wallet, cursor); } catch { break; }
          const a = d.activities ?? []; acts.push(...a);
          cursor = d.next; if (!cursor || !a.length) break;
          await sleep(320);
        }
        if (acts.length) rows.push(...fold(acts, CHAINS[chain]));
        await sleep(320);
      }

      done++;
      if (rows.length) {
        if (!DRY) try {
          // tokens first: `holdings` has an FK to it and the scorecard reads total_supply
          // from it, so a supply GMGN handed us is worth keeping.
          await c.query(`
            insert into tokens (network_id, address, symbol, total_supply, supply_source, supply_read_at)
            select * from unnest($1::bigint[],$2::text[],$3::text[],$4::numeric[],$5::text[],$6::timestamptz[])
            on conflict (network_id, token_key) do update
              set total_supply = coalesce(tokens.total_supply, excluded.total_supply),
                  supply_source = coalesce(tokens.supply_source, excluded.supply_source),
                  supply_read_at = coalesce(tokens.supply_read_at, excluded.supply_read_at),
                  symbol = coalesce(tokens.symbol, excluded.symbol)`,
            [rows.map(()=>0).map((_,i)=>rows[i].network_id), rows.map(r=>r.token_address),
             rows.map(r=>r.token_symbol), rows.map(r=>r.total_supply),
             rows.map(r=>r.total_supply!==null?'gmgn_activity':null),
             rows.map(r=>r.total_supply!==null?capturedAt:null)]);
          await c.query(`
            insert into trades (trade_id, handle, network_id, token_address, token_key, token_symbol,
                                status, amount, avg_entry_price, avg_exit_price, realized_pnl_usd,
                                opened_at, closed_at, captured_at)
            select 'gmgn:'||$1||':'||n||':'||k, $1, n, a, k, s, st, am, ep, xp, pn, op, cl, $2
            from unnest($3::bigint[],$4::text[],$5::text[],$6::text[],$7::text[],$8::numeric[],
                        $9::numeric[],$10::numeric[],$11::numeric[],$12::timestamptz[],$13::timestamptz[])
                 as u(n,a,k,s,st,am,ep,xp,pn,op,cl)
            on conflict (trade_id) do update set
              status=excluded.status, amount=excluded.amount,
              avg_entry_price=excluded.avg_entry_price, avg_exit_price=excluded.avg_exit_price,
              realized_pnl_usd=excluded.realized_pnl_usd, opened_at=excluded.opened_at,
              closed_at=excluded.closed_at, captured_at=excluded.captured_at`,
            [t.handle, capturedAt, rows.map(r=>r.network_id), rows.map(r=>r.token_address),
             rows.map(r=>r.token_key), rows.map(r=>r.token_symbol), rows.map(r=>r.status),
             rows.map(r=>r.amount), rows.map(r=>r.avg_entry_price), rows.map(r=>r.avg_exit_price),
             rows.map(r=>r.realized_pnl_usd), rows.map(r=>r.opened_at), rows.map(r=>r.closed_at)]);
          withTrades++; totalRows += rows.length;
        } catch (e) {
          // One trader's bad row must not cost the remaining hundreds. It is skipped and
          // named, so a rerun picks it up once the cause is understood.
          failed++;
          console.log(`[${String(done).padStart(3)}/${targets.length}] ${t.handle.padEnd(22)} SKIPPED — ${String(e.message).slice(0,60)}`);
          continue;
        }
        else { withTrades++; totalRows += rows.length; }
      }
      console.log(`[${String(done).padStart(3)}/${targets.length}] ${t.handle.padEnd(22)} ${String(rows.length).padStart(4)} positions`);
    }
    console.log(`\n${withTrades} of ${done} traders produced trades · ${totalRows} positions · ${failed} skipped`);

    if (!DRY) {
      /*
       * A stats row so the board can rank them. rank and followers stay NULL -- they are
       * fomo-leaderboard concepts with no on-chain equivalent, and inventing a rank would
       * put a GMGN trader on fomo's ladder as if fomo had placed them there.
       */
      const { rowCount } = await c.query(`
        insert into trader_stats (handle, captured_at, pnl_usd, volume_usd, trade_count)
        select tr.handle, $1,
               sum(tr.realized_pnl_usd),
               sum(coalesce(tr.amount * tr.avg_entry_price, 0)),
               count(*)::int
        from trades tr join traders t on t.handle = tr.handle
        where t.source = 'gmgn'
        group by tr.handle
        on conflict (handle, captured_at) do update
          set pnl_usd = excluded.pnl_usd, volume_usd = excluded.volume_usd,
              trade_count = excluded.trade_count`, [capturedAt]);
      console.log(`wrote ${rowCount} trader_stats rows`);
    }
  } finally { c.release(); await pool.end(); }
}
main().catch(e=>{console.error(e);process.exit(1);});
