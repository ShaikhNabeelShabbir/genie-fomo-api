#!/usr/bin/env node
/**
 * Discover traders from GMGN and add them to the EXISTING tables.
 *
 * Every trader we carry today came from fomo, and fomo will not serve anyone outside its own
 * top 100. GMGN tags two public wallet lists -- KOLs and "smart money" -- and both are on the
 * key we already hold. This turns those into rows in `traders` and `wallets`, which is all the
 * existing routes need to start answering for them.
 *
 * NO NEW TABLES. The schema already fits: `traders` requires only handle and display_handle,
 * `trades` only trade_id/handle/captured_at, and `trader_stats` tolerates a missing row -- 37
 * of 137 fomo traders have none today, so every route already handles it.
 *
 * IDENTITY. A person is their twitter handle when GMGN gives us one, so the same human's
 * Solana and EVM wallets land on ONE trader row rather than five. Without a twitter handle the
 * wallet itself is the identity, prefixed so it can never collide with a fomo handle.
 *
 *   node scripts/load_gmgn_traders.mjs --discover          # poll, then insert
 *   node scripts/load_gmgn_traders.mjs --rounds 8          # poll harder (the feed is a stream)
 *   node scripts/load_gmgn_traders.mjs --dry-run
 */
import pg from "pg";

const DB  = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
const KEY = (process.env.GMGN_API_KEY ?? "").trim();
if (!DB)  { console.error("DATABASE_URL is not set"); process.exit(1); }
if (!KEY) { console.error("GMGN_API_KEY is not set"); process.exit(1); }

const CHAINS = { sol: 1399811149, bsc: 56, base: 8453, eth: 1, robinhood: 4663 };
const arg  = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i+1] ? process.argv[i+1] : d; };
const DRY    = process.argv.includes("--dry-run");
const ROUNDS = Number(arg("rounds", "4"));

const pool = new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 4 });

/**
 * GMGN returns "" -- not null -- for a wallet with no twitter handle and no name, and `??`
 * only catches null. That shipped 163 traders whose display_handle was the empty string, so
 * /v1/traders/:handle answered 200 with a blank name. Empty is missing; say so once, here.
 */
const blank = v => (typeof v === "string" && v.trim() === "" ? null : (v ?? null));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** kol and smartmoney are weight 1 on a rate-20 bucket; 900ms is far inside it. */
async function gmgn(path, extra = {}, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const qs = new URLSearchParams({ timestamp: String(Math.floor(Date.now()/1000)), client_id: crypto.randomUUID(), ...extra });
      const r = await fetch(`https://openapi.gmgn.ai${path}?${qs}`,
        { headers: { "X-APIKEY": KEY, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      const j = await r.json().catch(() => null);
      if (j?.error === "RATE_LIMIT_EXCEEDED" || j?.error === "RATE_LIMIT_BANNED" || r.status === 429) {
        // Their docs are explicit: retrying inside the cooldown extends the ban.
        throw Object.assign(new Error("RATE_LIMIT"), { wait: 6000 * i });
      }
      if (j?.code !== 0) throw new Error(String(j?.msg ?? j?.message ?? `code ${j?.code}`).slice(0, 60));
      return j.data;
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(e.wait ?? 900 * i);
    }
  }
}

/**
 * A handle that is stable, readable, and cannot collide with fomo's namespace.
 *
 * Twitter handles are the natural key and match what a reader expects to see, but a GMGN KOL
 * could share a handle with a fomo trader; `taken` is checked so we never merge two different
 * people into one row on a name coincidence.
 */
function handleFor(person, taken) {
  const tw = person.twitter?.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (tw && !taken.has(tw)) return tw;
  if (tw && !taken.has(`gmgn_${tw}`)) return `gmgn_${tw}`;
  return `gmgn_${person.wallets[0].wallet.slice(0, 10).toLowerCase()}`;
}

async function discover() {
  const found = new Map();
  for (const chain of Object.keys(CHAINS)) {
    for (const ep of ["/v1/user/kol", "/v1/user/smartmoney"]) {
      for (let i = 0; i < ROUNDS; i++) {
        let list;
        try { list = (await gmgn(ep, { chain, limit: "100" }))?.list ?? []; }
        catch (e) { console.log(`  ${chain}/${ep.split("/").pop()} failed: ${e.message}`); break; }
        for (const x of list) {
          if (!x.maker) continue;
          const k = `${chain}|${x.maker}`;
          if (found.has(k)) continue;
          found.set(k, { chain, wallet: x.maker,
            twitter: blank(x.maker_info?.twitter_username),
            name: blank(x.maker_info?.twitter_name) ?? blank(x.maker_info?.name),
            avatar: blank(x.maker_info?.avatar),
            tags: x.maker_info?.tags ?? [] });
        }
        await sleep(900);
      }
    }
    console.log(`  ${chain.padEnd(10)} running total ${found.size} wallets`);
  }
  return [...found.values()];
}

/** Collapse wallets into people. One twitter handle is one person across every chain. */
function group(rows) {
  const people = new Map();
  for (const r of rows) {
    const id = r.twitter ? `tw:${r.twitter.toLowerCase()}` : `w:${r.wallet}`;
    const p = people.get(id) ?? { twitter: r.twitter, name: r.name, avatar: r.avatar, tags: new Set(), wallets: [] };
    p.name ??= r.name; p.avatar ??= r.avatar;
    for (const t of r.tags) p.tags.add(t);
    p.wallets.push({ chain: r.chain, wallet: r.wallet });
    people.set(id, p);
  }
  return [...people.values()];
}

async function main() {
  console.log(`discovering across ${Object.keys(CHAINS).length} chains, ${ROUNDS} rounds each${DRY ? "  [DRY RUN]" : ""}`);
  const people = group(await discover());
  console.log(`\n${people.length} distinct people from the two GMGN lists`);

  const c = await pool.connect();
  try {
    const { rows: ex } = await c.query(`select handle from traders`);
    const taken = new Set(ex.map((r) => r.handle));
    console.log(`${taken.size} handles already in the directory`);

    const traders = [], wallets = [];
    for (const p of people) {
      const handle = handleFor(p, taken);
      if (taken.has(handle)) continue;             // already added by an earlier run
      taken.add(handle);
      const sol = p.wallets.find((w) => w.chain === "sol")?.wallet ?? null;
      const evm = p.wallets.find((w) => w.chain !== "sol")?.wallet ?? null;
      if (!sol && !evm) continue;                  // `wallets` requires an address, rightly
      traders.push({ handle, display_handle: blank(p.twitter) ?? handle, name: blank(p.name),
                     avatar: p.avatar, bio: [...p.tags].join(", ") || null, twitter: p.twitter });
      wallets.push({ handle, sol, evm });
    }
    console.log(`${traders.length} new, ${people.length - traders.length} already present or unusable`);
    if (DRY || !traders.length) { console.log(DRY ? "\n[DRY RUN] nothing written" : "nothing to add"); return; }

    await c.query("begin");
    await c.query(`
      insert into traders (handle, display_handle, name, avatar, bio, twitter, source)
      select *, 'gmgn' from unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[])
      on conflict (handle) do nothing`,
      [traders.map(t=>t.handle), traders.map(t=>t.display_handle), traders.map(t=>t.name),
       traders.map(t=>t.avatar), traders.map(t=>t.bio), traders.map(t=>t.twitter)]);
    await c.query(`
      insert into wallets (handle, sol_address, sol_source, evm_address, evm_source)
      select h, s, case when s is not null then 'gmgn' end,
                e, case when e is not null then 'gmgn' end
      from unnest($1::text[],$2::text[],$3::text[]) as t(h,s,e)
      on conflict (handle) do nothing`,
      [wallets.map(w=>w.handle), wallets.map(w=>w.sol), wallets.map(w=>w.evm)]);
    await c.query("commit");

    const { rows: [tot] } = await c.query(
      `select count(*) filter (where source='gmgn')::int gmgn,
              count(*) filter (where source<>'gmgn')::int fomo, count(*)::int all_traders from traders`);
    console.log(`\ntraders now: ${tot.all_traders}  (fomo ${tot.fomo} · gmgn ${tot.gmgn})`);
  } catch (e) { await c.query("rollback").catch(()=>{}); throw e; }
  finally { c.release(); await pool.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
