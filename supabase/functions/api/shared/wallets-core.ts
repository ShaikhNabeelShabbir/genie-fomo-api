import { sql } from "../db.ts";
import { nonEmpty } from "../shared/params.ts";
import { KnownChain } from "../shared/chains.ts";

/** Wallet rows for many traders at once, for the ISSUE-8 bulk route. */
export const walletRows = (handles: string[]) => sql`
  select t.handle, t.id, t.display_handle, t.handle_changed_at, t.source,
         t.name, t.bio, t.avatar, t.twitter,
         w.evm_address, w.sol_address, w.evm_source, w.sol_source,
         w.evm_confidence, w.sol_confidence, w.last_seen_at
  from traders t left join wallets w using (handle)
  where t.handle = any(${handles})`;

/** Gap 5b. Wallets this trader funded from his known one (`linked_wallets`), watched by the webhook. */
export const linkedRows = (handle: string) => sql`
  select c.name as chain, lw.address, lw.address_key, lw.linked_from_address_key, lw.link_kind,
         lw.first_seen_at, lw.evidence_tx, lw.watch
  from linked_wallets lw join chains c on c.network_id = lw.network_id
  where lw.handle = ${handle}
  order by lw.first_seen_at nulls last, lw.address_key`;

/** One `linked_wallets` row. `address` is the case-preserved spelling when resolved, else the key. */
export const linkedBody = (r: Record<string, unknown>) => ({
  chain: String(r.chain),
  address: String(r.address ?? r.address_key),
  linkedFrom: String(r.linked_from_address_key),
  // funded_by (seen funding it from the known wallet) | submitted (claimed via POST /wallets).
  kind: String(r.link_kind),
  firstSeenAt: r.first_seen_at ? new Date(String(r.first_seen_at)).toISOString() : null,
  evidenceTx: (r.evidence_tx as string | null) ?? null,
  watch: Boolean(r.watch),
});

/** W1. How an address was found: a straight mapping of `wallets.*_source` (fomoapi's own `src_*`). */
export const resolvedBy = (source: unknown): string | null =>
  source === "fomoapi.io" ? "fomoapi" : (source ? String(source) : null);

/** Shared by the single route and the bulk route, so the two cannot diverge. */
// deno-lint-ignore no-explicit-any
export function walletsBody(t: any, knownChains: KnownChain[] | null = null) {
  // Shape-checked before publishing. fomo's own evm/sol fields are empty for all 100
  // traders; these come from fomoapi's resolution and are REPORTED, not verified — see
  // PARAMETERS.md section 5. Verification writes into the *_confidence columns.
  const ok = (a: string | null) =>
    !!a && (/^0x[0-9a-fA-F]{40}$/.test(a.trim()) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a.trim()));
  const bad = [t.evm_address, t.sol_address].filter((a) => a && !ok(a as string)).length;

  return {
    handle: t.display_handle,
    name: t.name ?? null,
    bio: nonEmpty(t.bio as string | null),
    banner: null,
    profilePicture: nonEmpty(t.avatar as string | null),
    twitter: nonEmpty(t.twitter as string | null),
    solanaAddress: ok(t.sol_address as string) ? t.sol_address : null,
    evmAddress: ok(t.evm_address as string) ? t.evm_address : null,
    source: t.evm_source ?? t.sol_source ?? null,
    /** WHY THIS TRADER HAS NO ADDRESS — the difference between "we never looked" and "the source… See docs/DECISIONS.md#d186 */
    walletState: (ok(t.sol_address as string) || ok(t.evm_address as string))
      ? "on_record"
      : "unresolved_upstream",
    tier: (t.evm_confidence || t.sol_confidence) ? "verified" : "reported",
    confidence: { evm: t.evm_confidence ?? null, solana: t.sol_confidence ?? null },
    /** W1. Per wallet: `fomoapi` | `gmgn` | `submitted`, or the raw source word. */
    resolvedBy: { evm: resolvedBy(t.evm_source), solana: resolvedBy(t.sol_source) },
    /** W1. Always null: no fingerprint count is stored anywhere in the schema. */
    fingerprintMatches: null,
    ...(bad ? { warning: `${bad} stored address(es) are malformed and were withheld` } : {}),
    /** EVERY CHAIN THIS TRADER USES, window-independent and stable. See docs/DECISIONS.md#d187 */
    knownChains,
  };
}
