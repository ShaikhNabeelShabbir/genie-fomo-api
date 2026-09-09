#!/usr/bin/env node
/**
 * T3d · Token fundamentals from GMGN `/v1/token/info` into `token_info`.
 *
 * Only tokens our traders actually hold are fetched — 1,095 of 3,112 known tokens. GMGN's
 * limit is 1 request per second per IP, so a full pass is about 18 minutes; the pacing below
 * is deliberate and not a knob worth turning up.
 *
 * The whole response is stored in `raw`. One call carries the fundamentals (T3d), the holder
 * concentration (T3b), the creator signals (T3c) and the wallet tags (T3e), so keeping the
 * document means those three become a query against this table instead of three more
 * 18-minute crawls.
 *
 *   node scripts/load_token_info.mjs                 # tokens never fetched, then stalest first
 *   node scripts/load_token_info.mjs --limit 20      # smoke test
 *   node scripts/load_token_info.mjs --stale-hours 0 # refresh everything
 *   node scripts/load_token_info.mjs --chain solana
 */
import pg from "pg";

const DB = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
const KEY = (process.env.GMGN_API_KEY ?? "").trim();
if (!DB) { console.error("DATABASE_URL is not set"); process.exit(1); }
if (!KEY) { console.error("GMGN_API_KEY is not set"); process.exit(1); }

/**
 * Our chain names are not GMGN's. Two differ and the rest pass through — verified live
 * against a real held token on each of the five chains we carry.
 */
const CHAIN_CODE = { solana: "sol", ethereum: "eth", bsc: "bsc", base: "base", robinhood: "robinhood" };

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const LIMIT = Number(arg("limit", "0")) || null;
const CHAIN = arg("chain", null);
const STALE_HOURS = Number(arg("stale-hours", "20"));

const pool = new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 2 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/**
 * Postgres `jsonb` cannot hold a \u0000, and memecoin names are full of them.
 *
 * The run died on token 976 of 1,083 with "unsupported Unicode escape sequence" — one name
 * carrying an escaped null byte, which rejected that insert and killed the process partway
 * through a 20-minute crawl. Stripping the escape keeps the rest of the document intact;
 * dropping the token would lose real fundamentals over a character in its name.
 */
const jsonForPg = (v) => JSON.stringify(v).replace(/\\u0000/g, "");

/** Same problem in the plain text columns, where a raw NUL is equally unstorable. */
const clean = (v) =>
  typeof v === "string" ? v.replace(/\u0000/g, "").replace(/\\u0000/g, "") : (v ?? null);

async function fetchGmgn(path, code, address) {
  const qs = new URLSearchParams({
    chain: code,
    address,
    timestamp: String(Math.floor(Date.now() / 1000)),
    client_id: crypto.randomUUID(),
  });
  const r = await fetch(`https://openapi.gmgn.ai${path}?${qs}`, {
    headers: { "X-APIKEY": KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => null);
  if (j?.error === "RATE_LIMIT_EXCEEDED") throw new Error("RATE_LIMIT");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (j?.code !== 0) throw new Error(String(j?.message ?? j?.error ?? "gmgn error").slice(0, 80));
  return j.data;
}

const fetchInfo = (code, address) => fetchGmgn("/v1/token/info", code, address);
const fetchSecurity = (code, address) => fetchGmgn("/v1/token/security", code, address);

/**
 * T3a. Normalise a security response for the chain it came from.
 *
 * GMGN answers with every field on every chain, including the ones that do not apply, and the
 * inapplicable ones come back as `false` rather than null. Verified live on all five chains
 * we carry:
 *
 *   EVM (eth/bsc/base/robinhood)  is_honeypot / is_open_source / is_renounced are real;
 *                                 renounced_mint and renounced_freeze_account are FALSE, but
 *                                 mint and freeze authorities are Solana concepts
 *   Solana                        the mirror — honeypot / open-source / renounced are NULL
 *                                 (not assessed), mint/freeze carry the real signal
 *
 * Passing those falses through would publish "mint authority not renounced" about a chain
 * with no mint authority — a scary-sounding claim about something that cannot be true or
 * false there. Inapplicable checks are stored NULL, which everywhere in this API means "we do
 * not know", never "safe".
 */
function normaliseSecurity(chain, d) {
  const sol = chain === "solana";
  const bool = (v) => (v === null || v === undefined || v === "" ? null : Boolean(v));
  const dec = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  return {
    is_honeypot: sol ? null : bool(d.is_honeypot),
    is_open_source: sol ? null : bool(d.is_open_source),
    is_renounced: sol ? null : bool(d.is_renounced),
    renounced_mint: sol ? bool(d.renounced_mint) : null,
    renounced_freeze: sol ? bool(d.renounced_freeze_account) : null,
    is_blacklisted: sol ? null : bool(d.is_blacklist),
    // can_not_sell is a count in their payload, not a flag.
    can_not_sell: dec(d.can_not_sell) === null ? null : dec(d.can_not_sell) > 0,
    buy_tax: dec(d.buy_tax),
    sell_tax: dec(d.sell_tax),
    rug_ratio: dec(d.rug_ratio),
    burn_ratio: dec(d.burn_ratio),
  };
}

async function main() {
  const c = await pool.connect();
  try {
    const { rows: targets } = await c.query(
      `select h.network_id, h.token_key, tk.address, ch.name as chain
         from holdings_current h
         join tokens tk  on tk.network_id = h.network_id and tk.token_key = h.token_key
         join chains ch  on ch.network_id = h.network_id
         left join quote_assets q
           on q.network_id = h.network_id and q.token_key = h.token_key
         left join token_info ti
           on ti.network_id = h.network_id and ti.token_key = h.token_key
        where q.token_key is null
          ${CHAIN ? "and ch.name = $1" : ""}
          -- Either half being stale is reason to refetch: security has its own timestamp
          -- and can be missing on a token whose fundamentals are current.
          and (ti.fetched_at is null or ti.security_fetched_at is null
               or ti.fetched_at < now() - ($${CHAIN ? 2 : 1} * interval '1 hour')
               or ti.security_fetched_at < now() - ($${CHAIN ? 2 : 1} * interval '1 hour'))
        group by 1,2,3,4, ti.fetched_at, ti.security_fetched_at
        -- Never-fetched first, then stalest. A run that is cut short still leaves the set
        -- more complete than it found it rather than re-refreshing the same head.
        order by ti.security_fetched_at asc nulls first, ti.fetched_at asc nulls first, h.token_key`,
      CHAIN ? [CHAIN, STALE_HOURS] : [STALE_HOURS],
    );

    const work = LIMIT ? targets.slice(0, LIMIT) : targets;
    if (!work.length) { console.log("nothing to fetch — every held token is fresh"); return; }

    // Two endpoints per token — fundamentals then security — at 1 request/second each.
    const mins = Math.ceil(work.length * 2.2 / 60);
    console.log(`fetching ${work.length} token(s) at 1/s — about ${mins} min`);

    let ok = 0, failed = 0, priced = 0, secFailed = 0;
    for (const [i, t] of work.entries()) {
      const code = CHAIN_CODE[t.chain];
      if (!code) { failed++; continue; }

      let d = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { d = await fetchInfo(code, t.address); break; }
        catch (e) {
          // Their limiter is per IP and we are the only caller, so a 429 means we drifted
          // too fast rather than that the token is unavailable. Back off and retry; anything
          // else is this token's problem and is recorded, not retried forever.
          if (String(e.message) === "RATE_LIMIT") { await sleep(3000); continue; }
          if (attempt === 2) console.log(`  ${t.chain}/${String(t.address).slice(0,10)}… ${e.message}`);
          break;
        }
      }
      if (!d) { failed++; await sleep(1100); continue; }

      /**
       * Security is a second endpoint, so a second request and a second second of pacing.
       * It is allowed to fail on its own: fundamentals are still worth storing without it,
       * and `security_fetched_at` stays null so the next pass retries just the security half.
       */
      await sleep(1100);
      let sec = null;
      try { sec = normaliseSecurity(t.chain, await fetchSecurity(code, t.address)); }
      catch (e) {
        if (String(e.message) === "RATE_LIMIT") {
          await sleep(3000);
          try { sec = normaliseSecurity(t.chain, await fetchSecurity(code, t.address)); } catch { /* counted below */ }
        }
      }
      if (!sec) secFailed++;

      const price = num(d?.price?.price);
      const circ = num(d.circulating_supply);
      /**
       * Market cap is always ours: GMGN returned `market_cap` on 0 of 1,095 tokens, so this
       * is price x circulating supply every time.
       *
       * Bounded, because the arithmetic stays correct long after the result stops meaning
       * anything. One token mints 10^76 units at 1.8e-25 each, giving a "market cap" of
       * ~1.8e51 — which sorted straight to rank 1 on a board ordered by market cap. Above
       * $10 trillion the figure is an artifact of token supply rather than a valuation
       * (Apple is ~$4T; all of crypto is ~$3T), so it is recorded as NULL and the price and
       * supply that produced it are still published for anyone who wants to judge for
       * themselves.
       */
      const rawMc = num(d.market_cap) ?? (price !== null && circ !== null ? price * circ : null);
      const mc = rawMc !== null && rawMc <= 1e13 ? rawMc : null;

      try {
        await c.query(
        `insert into token_info (network_id, token_key, symbol, name, price_usd, liquidity_usd,
           market_cap_usd, total_supply, circulating_supply, max_supply, holder_count,
           top_10_holder_rate, raw, source, fetched_at,
           is_honeypot, buy_tax, sell_tax, is_open_source, is_renounced, renounced_mint,
           renounced_freeze, rug_ratio, burn_ratio, is_blacklisted, can_not_sell,
           security_fetched_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'gmgn',now(),
                 $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
                 case when $25::boolean then now() else null end)
         on conflict (network_id, token_key) do update set
           symbol=excluded.symbol, name=excluded.name, price_usd=excluded.price_usd,
           liquidity_usd=excluded.liquidity_usd, market_cap_usd=excluded.market_cap_usd,
           total_supply=excluded.total_supply, circulating_supply=excluded.circulating_supply,
           max_supply=excluded.max_supply, holder_count=excluded.holder_count,
           top_10_holder_rate=excluded.top_10_holder_rate, raw=excluded.raw,
           fetched_at=now(),
           -- Only overwrite security when this run actually fetched it. A failed security
           -- call must leave yesterday's answer standing rather than blanking a honeypot
           -- flag that was true.
           is_honeypot      = case when $25::boolean then excluded.is_honeypot      else token_info.is_honeypot end,
           buy_tax          = case when $25::boolean then excluded.buy_tax          else token_info.buy_tax end,
           sell_tax         = case when $25::boolean then excluded.sell_tax         else token_info.sell_tax end,
           is_open_source   = case when $25::boolean then excluded.is_open_source   else token_info.is_open_source end,
           is_renounced     = case when $25::boolean then excluded.is_renounced     else token_info.is_renounced end,
           renounced_mint   = case when $25::boolean then excluded.renounced_mint   else token_info.renounced_mint end,
           renounced_freeze = case when $25::boolean then excluded.renounced_freeze else token_info.renounced_freeze end,
           rug_ratio        = case when $25::boolean then excluded.rug_ratio        else token_info.rug_ratio end,
           burn_ratio       = case when $25::boolean then excluded.burn_ratio       else token_info.burn_ratio end,
           is_blacklisted   = case when $25::boolean then excluded.is_blacklisted   else token_info.is_blacklisted end,
           can_not_sell     = case when $25::boolean then excluded.can_not_sell     else token_info.can_not_sell end,
           security_fetched_at = case when $25::boolean then now() else token_info.security_fetched_at end`,
        [
          t.network_id, t.token_key, clean(d.symbol), clean(d.name), price,
          num(d.liquidity), mc, num(d.total_supply), circ, num(d.max_supply),
          num(d.holder_count), num(d?.stat?.top_10_holder_rate), jsonForPg(d),
          sec?.is_honeypot ?? null, sec?.buy_tax ?? null, sec?.sell_tax ?? null,
          sec?.is_open_source ?? null, sec?.is_renounced ?? null, sec?.renounced_mint ?? null,
          sec?.renounced_freeze ?? null, sec?.rug_ratio ?? null, sec?.burn_ratio ?? null,
          sec?.is_blacklisted ?? null, sec?.can_not_sell ?? null,
          sec !== null,
        ],
      );
      } catch (e) {
        // One unstorable token must not end the run. It is counted and named, and the next
        // pass retries it because `fetched_at` stays null.
        failed++;
        console.log(`  ${t.chain}/${String(t.address).slice(0, 10)}… store failed: ${String(e.message).slice(0, 60)}`);
        await sleep(1100);
        continue;
      }
      ok++;
      if (price !== null) priced++;
      if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${work.length} · ${ok} ok · ${failed} failed`);
      await sleep(1100);
    }

    console.log(
      `\ndone · ${ok} stored (${priced} with a price) · ${failed} failed` +
      ` · ${secFailed} without security`,
    );
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
