/**
 * fomoapi.io client — the one source with realized/unrealized P&L per trade.
 *
 * Unlike metrics.ts (pure file arithmetic), everything here costs an API call, so results
 * are cached. Free tier is 10,000 requests/month.
 */

const HOST = process.env.FOMOAPI_BASE ?? "https://api.fomoapi.io";
const KEY = (process.env.FOMOAPI_KEY ?? "").trim();
export const haveFomoapi = () => !!KEY;

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: Banked }>();

export type Banked = {
  /** T1 — money that has actually left the table. */
  bankedUsd: number | null;
  closedTrades: number;
  /** T1 — marks on positions still open. Often unrealisable; never call it "profit". */
  onPaperUsd: number | null;
  openPositions: number;
  /**
   * banked / (banked + on paper), 0..1 — or null when the ratio would be meaningless.
   *
   * Sign discipline matters here. A naive `total !== 0` guard lets realized −$8,000 and
   * unrealized −$2,000 render as "80% banked" for a trader who LOST $10,000. We emit a
   * share only when both sides are positive; every other case gets the dollar figures and
   * no ratio.
   */
  realizedShare: number | null;
  capturedAt: string | null;
  /** fomoapi serves trades live and reports its own unavailability — pass it through. */
  available: boolean;
  note: string | null;
  plain: string;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

const money = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

async function fetchTrades(handle: string, limit: number): Promise<any> {
  const r = await fetch(`${HOST}/v2/users/${encodeURIComponent(handle)}/trades?limit=${limit}`, {
    headers: { authorization: `Bearer ${KEY}`, Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (r.status === 404) return { notFound: true };
  if (!r.ok) throw new Error(`fomoapi HTTP ${r.status}`);
  return r.json();
}

/**
 * T1 — banked versus on paper.
 *
 * The spine of the trust model: a headline profit that is entirely unrealised can be a
 * honeypot mark. The measured case was $95,577,723 of "profit" on $41 of volume, against a
 * cost basis of $9.87, in a token nobody had ever sold.
 */
export async function banked(handle: string, limit = 500): Promise<Banked | null> {
  if (!haveFomoapi()) throw new Error("FOMOAPI_KEY is not set");

  const hit = cache.get(handle.toLowerCase());
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const doc = await fetchTrades(handle, limit);
  if (doc?.notFound) return null;

  // Two response shapes observed in the wild: a full one with counts, and a degraded
  // `{available:false, trades:[], note}` envelope when trades cannot be served.
  const trades: any[] = Array.isArray(doc?.trades) ? doc.trades : [];
  const available = doc?.available !== false;

  let realized = 0;
  let unrealized = 0;
  let closed = 0;
  let open = 0;
  for (const t of trades) {
    const r = Number(t?.realizedPnlUsd);
    const u = Number(t?.unrealizedPnlUsd);
    if (t?.status === "closed") {
      closed++;
      if (Number.isFinite(r)) realized += r;
    } else {
      open++;
      if (Number.isFinite(u)) unrealized += u;
    }
  }

  const any = trades.length > 0;
  // Only a genuinely mixed, positive picture gets a ratio — see the note on realizedShare.
  const share = any && realized > 0 && unrealized > 0
    ? Number((realized / (realized + unrealized)).toFixed(4))
    : null;

  let plain: string;
  if (!available) {
    plain = "fomo could not serve this trader's trades just now, so we cannot say what is banked.";
  } else if (!any) {
    plain = "No trades on record for this trader.";
  } else if (share !== null) {
    plain =
      `Cashed out ${money(realized)} across ${closed} closed trades. ` +
      `${money(unrealized)} is still on paper in ${open} open position${open === 1 ? "" : "s"} ` +
      `— ${Math.round(share * 100)}% of the total is actually banked.`;
  } else if (realized > 0 && unrealized <= 0) {
    plain = `Cashed out ${money(realized)} across ${closed} closed trades, and is currently down ${money(Math.abs(unrealized))} on open positions.`;
  } else if (realized <= 0 && unrealized > 0) {
    plain = `${money(unrealized)} of gains are on paper only — nothing has been banked yet across ${closed} closed trades.`;
  } else {
    plain = `Down ${money(Math.abs(realized))} on closed trades and ${money(Math.abs(unrealized))} on open ones.`;
  }

  const value: Banked = {
    bankedUsd: any ? Number(realized.toFixed(2)) : null,
    closedTrades: closed,
    onPaperUsd: any ? Number(unrealized.toFixed(2)) : null,
    openPositions: open,
    realizedShare: share,
    capturedAt: doc?.capturedAt ?? null,
    available,
    note: doc?.note ?? null,
    plain,
  };
  // Only cache a real answer; a degraded response should be retried.
  if (available && any) cache.set(handle.toLowerCase(), { at: Date.now(), value });
  return value;
}
