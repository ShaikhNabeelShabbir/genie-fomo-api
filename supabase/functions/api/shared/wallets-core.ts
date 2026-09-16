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
    /**
     * WHY THIS TRADER HAS NO ADDRESS — the difference between "we never looked" and
     * "the source is still working on it".
     *
     * Seven traders are published with no wallet, and until now the answer said nothing about
     * why. Asked of fomoapi directly on 16 September, they are not one problem but two:
     * three (`zeri_term`, `bamblewood8`, `qwerty888`) come back `status: "resolving"` — the
     * upstream has not finished resolving them and there is no address to fetch. The other
     * four have dropped off every fomoapi window entirely and are stale directory entries.
     *
     * Those are opposite facts about the same blank screen. One will fix itself; the other
     * never will.
     *
     * Both report `unresolved_upstream` today, which is as far as the stored data can
     * separate them: all seven have no `wallets` row at all, and fomoapi's own
     * `wallets.status` is not something we keep. Telling `resolving` from `delisted` means
     * storing that status on the directory load — worth doing, and a change to the loader
     * rather than to this route.
     */
    walletState: (ok(t.sol_address as string) || ok(t.evm_address as string))
      ? "on_record"
      : "unresolved_upstream",
    tier: (t.evm_confidence || t.sol_confidence) ? "verified" : "reported",
    confidence: { evm: t.evm_confidence ?? null, solana: t.sol_confidence ?? null },
    ...(bad ? { warning: `${bad} stored address(es) are malformed and were withheld` } : {}),
    /**
     * EVERY CHAIN THIS TRADER USES, window-independent and stable.
     *
     * `wallets[].chains` says where each ADDRESS has been seen; this says where the TRADER
     * is, which is the list chain tags and per-chain switches are drawn from. They differ:
     * a chain can carry positions or balance history without a trade we observed.
     *
     * Null rather than [] when the caller did not ask for it to be resolved, so an absent
     * list is never read as a trader on no chains.
     */
    knownChains,
  };
}
