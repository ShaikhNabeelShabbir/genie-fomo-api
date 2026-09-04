import fs from "node:fs";
import path from "node:path";

import * as directory from "./directory.js";
import { WALLETS_FILE } from "./settings.js";
import { chainName, isQuoteAsset } from "./metrics.js";

/**
 * Snapshot archive — the only way to answer "what changed?".
 *
 * Every other parameter is a function of the current file. K2 (momentum) is not: it is a
 * function of two files taken at different times, and no amount of cleverness recovers it
 * from one. So this keeps a compact index of past snapshots and diffs the newest two.
 *
 * What is stored is deliberately tiny — token -> handles, no prices, no amounts. A full
 * copy of the directory is ~2MB; this is a few tens of KB, which matters because these
 * accumulate and because the useful comparison is membership, not valuation.
 *
 * Caveat for deployment: on a platform with an ephemeral filesystem (Render's free tier
 * included) anything written here is lost on redeploy. To make momentum survive, the
 * archive directory has to be committed by the same pipeline that refreshes the directory
 * file, or moved to durable storage. Until two snapshots exist, the route says so rather
 * than inventing a baseline.
 */

const DIR = path.join(path.dirname(WALLETS_FILE), "snapshots");

type Snapshot = {
  capturedAt: string;
  traders: number;
  /** "<networkId>:<tokenAddress>" -> handles holding it. Quote assets excluded. */
  tokens: Record<string, string[]>;
};

const stamp = (ms: number | undefined): string =>
  new Date(typeof ms === "number" ? (ms < 1e12 ? ms * 1000 : ms) : Date.now())
    .toISOString()
    .replace(/[:.]/g, "-");

function index(): Snapshot {
  const traders = directory.all();
  const tokens: Record<string, string[]> = {};
  for (const t of traders) {
    if (!t.handle) continue;
    for (const h of t.holdings ?? []) {
      if (!h.tokenAddress || h.networkId === undefined) continue;
      if (isQuoteAsset(h.tokenAddress)) continue;
      const key = `${h.networkId}:${h.tokenAddress.toLowerCase()}`;
      (tokens[key] ??= []).push(t.handle);
    }
  }
  for (const k of Object.keys(tokens)) tokens[k] = [...new Set(tokens[k])];
  const meta = directory.meta() as { generated_at?: number };
  return {
    capturedAt: new Date(
      typeof meta.generated_at === "number"
        ? meta.generated_at < 1e12
          ? meta.generated_at * 1000
          : meta.generated_at
        : Date.now(),
    ).toISOString(),
    traders: traders.filter((t) => t.handle).length,
    tokens,
  };
}

function files(): string[] {
  if (!fs.existsSync(DIR)) return [];
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

/**
 * Write today's snapshot if this directory build has not been archived yet.
 *
 * Keyed on the directory's own `generated_at`, so restarting the server ten times does not
 * produce ten identical archives and a momentum of zero.
 */
export function archive(): { written: boolean; file: string; total: number } {
  const meta = directory.meta() as { generated_at?: number };
  const name = `${stamp(meta.generated_at)}.json`;
  const target = path.join(DIR, name);
  if (fs.existsSync(target)) return { written: false, file: name, total: files().length };

  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index()));
  fs.renameSync(tmp, target);
  return { written: true, file: name, total: files().length };
}

const read = (f: string): Snapshot => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));

export type MomentumRow = {
  tokenAddress: string;
  networkId: number;
  chain: string;
  holders: number;
  previousHolders: number;
  /** K2 — the number this whole module exists for. */
  change: number;
  gained: string[];
  lost: string[];
  isNew: boolean;
  plain: string;
};

/**
 * K2 — which tokens leaders moved into or out of between the two most recent snapshots.
 *
 * Returns `available: false` rather than an empty board when there is only one snapshot:
 * "no tokens gained holders" and "we have nothing to compare against" are completely
 * different statements and must never render the same.
 */
export function momentum(): {
  available: boolean;
  from: string | null;
  to: string | null;
  spanHours: number | null;
  snapshots: number;
  rows: MomentumRow[];
  plain: string;
} {
  const fs_ = files();
  if (fs_.length < 2) {
    return {
      available: false,
      from: null,
      to: null,
      spanHours: null,
      snapshots: fs_.length,
      rows: [],
      plain:
        `Momentum needs two snapshots to compare and we have ${fs_.length}. ` +
        `The archive grows each time the directory file is rebuilt with a new timestamp.`,
    };
  }

  const prev = read(fs_[fs_.length - 2]);
  const curr = read(fs_[fs_.length - 1]);
  const keys = new Set([...Object.keys(prev.tokens), ...Object.keys(curr.tokens)]);

  const rows: MomentumRow[] = [];
  for (const key of keys) {
    const before = prev.tokens[key] ?? [];
    const after = curr.tokens[key] ?? [];
    const change = after.length - before.length;
    const gained = after.filter((h) => !before.includes(h));
    const lost = before.filter((h) => !after.includes(h));
    if (!gained.length && !lost.length) continue;

    const [net, addr] = [Number(key.split(":")[0]), key.slice(key.indexOf(":") + 1)];
    rows.push({
      tokenAddress: addr,
      networkId: net,
      chain: chainName(net),
      holders: after.length,
      previousHolders: before.length,
      change,
      gained,
      lost,
      isNew: before.length === 0,
      plain:
        before.length === 0
          ? `New — ${after.length} leader${after.length === 1 ? "" : "s"} opened a position since the last snapshot.`
          : change > 0
          ? `+${change} holders (${before.length} to ${after.length}).`
          : change < 0
          ? `${change} holders (${before.length} to ${after.length}).`
          : `Same holder count, but ${gained.length} in and ${lost.length} out.`,
    });
  }
  rows.sort((a, b) => b.change - a.change || b.holders - a.holders);

  const span = (Date.parse(curr.capturedAt) - Date.parse(prev.capturedAt)) / 3_600_000;
  return {
    available: true,
    from: prev.capturedAt,
    to: curr.capturedAt,
    spanHours: Number.isFinite(span) ? Number(span.toFixed(1)) : null,
    snapshots: fs_.length,
    rows,
    plain: rows.length
      ? `${rows.filter((r) => r.change > 0).length} tokens gained holders and ` +
        `${rows.filter((r) => r.change < 0).length} lost them since the previous snapshot.`
      : "No holder changes between the two most recent snapshots.",
  };
}
