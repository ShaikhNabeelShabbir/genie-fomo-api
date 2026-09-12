# TDR: Fomo Trader Identity, Claimable Genie Agents, and Authoritative AUM Charts

Status: Proposed; Genie compatibility work is release-blocking, permanent API expansion follows  
Date: 11 September 2026  
Revision: 3, adds a safe current-contract decoder and separates immediate Genie work from the permanent API contract  
Product and consumer owner: Genie  
External-data owner: Genie-Fomo API team  
Related Genie tasks: #123 and #168  
Related product requirements: `GENIE_FOMO_V7_BATCH_AUM_AND_COVERAGE_PRD.md`

## Product ontology

A human user controls a Genie agent. A Fomo trader is imported as a public trader profile and copy-trading source. The Fomo trader may later prove control of that account by publishing a one-time thesis challenge, then attach the imported profile to their Genie agent.

Product language may present the imported trader as an unclaimed Genie agent. The implementation must still separate the public imported identity from the provisioned platform agent because the current `agents` model requires an owner and carries billing, credits, secrets, schedules, and sandbox behavior.

| Object | Current storage | Identifier | Lifecycle |
| --- | --- | --- | --- |
| Human user | `users` | `users.id` | authenticated account |
| Provisioned Genie agent | `agents` | `agents.id` | user-owned runtime and trading actor |
| Imported trader profile | `nmo_trader_people` | current `person_id`; conceptually `trader_profile_id` | imported, copyable, optionally claimed |
| Fomo identity | column on imported profile today; provider-link table later | opaque `service_id` | provider-owned external identity |
| Claim | new NMO claim tables | challenge/claim IDs | pending, verified, consumed, expired |

The current `person_id` is not an `agents.id`. It is the local primary key for the imported trader profile. Renaming it is optional cleanup; merging it with `agents.id` is not allowed.

First-release cardinality is one claimed Fomo profile per Genie agent and one Genie agent per claimed Fomo profile. If the product later allows one agent to aggregate several public identities, remove only the unique constraint on `agent_id`; do not merge provider identities.

## Architectural decision

Use separate identity, ownership, and provider-link layers:

```text
users.id
   │ owns
   ▼
agents.id ───────────────┐
                         │ claimed_agent_id, nullable before claim
                         ▼
nmo_trader_people.person_id
   │                     │
   │ has many            │ identified externally by
   ▼                     ▼
nmo_trader_wallets   provider=genie-fomo + service_id
                         │
                         ├── handle and profile metadata
                         ├── imported trades and performance
                         └── authoritative AUM responses
```

This preserves three boundaries:

1. Genie-Fomo identifies the external account and owns the imported facts.
2. Genie identifies the durable local trader profile and owns copy relationships and caches.
3. The Genie platform identifies the user-controlled agent and owns execution, billing, and authorization.

## Provider architecture

Genie-Fomo is the primary provider. Fomoscan is a fallback and must not become the main chart, holdings, identity, or claim path.

Recommended module boundary:

```text
genieFomoClient
  ├── readDirectory
  ├── readWallets
  ├── readPortfolio
  ├── readPositions / readPositionsBatch
  ├── readAum / readAumBatch
  └── verifyClaimThesis

fomoscanFallback
  └── explicitly allowed non-authoritative enrichment only

traderDataService
  ├── calls genieFomoClient first
  ├── validates stable identity and contract
  ├── applies the narrow fallback policy
  └── returns data plus provenance
```

The current `fomoscan.ts` contains many `readGenieFomo*` functions. That filename is legacy technical debt and obscures which provider is primary. Extract or rename the primary client as a separate change; do not rewrite working API behavior merely to rename the file during the release-blocking chart fix.

### Fallback matrix

| Operation | Fomoscan fallback allowed? | Reason |
| --- | :---: | --- |
| Resolve stable Fomo trader identity | No | Another provider cannot assert Fomo account identity |
| Verify claim thesis author | No | Ownership proof must come from Fomo |
| Historical AUM points or drawability | No | Mixing histories changes the meaning of the line |
| Provider position quantity | No | A second source may refer to another wallet snapshot |
| Token symbol, name, or icon | Yes | Display enrichment does not change identity or money |
| Separately labeled current price estimate | Yes | Allowed only with source and valuation time |

Fallback is fail-closed:

- do not invoke it after authentication, permission, budget, rate-limit, bad-shape, or identity-ambiguity failures;
- do not use it to turn `null` into zero;
- do not combine fallback totals with Genie-Fomo totals;
- return `source`, `sourceAt`, and `fallbackReason` for every fallback field;
- keep the primary provider's original value and refusal alongside any enrichment.

The existing temporary request by unique handle is still a Genie-Fomo request, not a Fomoscan fallback. It is allowed only after local uniqueness is proven and must be removed when stable-ID routes work.

## Decision summary

Genie will treat Genie-Fomo as the source of truth for trader balance history. Genie will not reconstruct history, interpolate gaps, or invent zero balances. When Genie-Fomo sends `drawing.drawable`, Genie obeys it. When the deployed reduced batch response omits `drawing`, Genie may apply the conservative compatibility rule defined below to exact provider points and must label the result as partial history.

Genie will treat a Fomo thesis containing a unique Genie challenge as proof that the claimant currently controls the Fomo account. A public Fomo ID or handle alone is never proof.

The API team must make these changes for the permanent contract. They are not all prerequisites for Genie to consume the current reduced response:

1. Make stable directory IDs work on every AUM route that V7 documents as accepting an ID or handle. Treat them as opaque strings rather than assuming a UUID format.
2. Return canonical stable identity on every batch row. A display handle is not identity.
3. Make each successful batch result contain the complete individual AUM response, including the service's `drawing`, gap, coverage, basis, tier, and refusal fields. These rich fields are required for full-fidelity explanations and coverage claims, not for a partial chart made only from exact provider points.
4. Return exactly one explicit success or failure result per requested identifier. Do not silently omit rows.
5. Repair the upstream history/sampling path for the affected traders. Their current service-owned histories contain only one or two usable points and are correctly marked non-drawable.
6. Publish captured contract fixtures and keep batch and individual results equivalent for the same trader and window.
7. Provide a stable-ID thesis read or claim-verification contract so Genie can verify thesis authorship and time.

Genie has separate implementation work now: #168 must accept the deployed reduced, handle-only row under strict uniqueness checks instead of rejecting the whole response for missing `row.id` and rich envelope fields. Its current `nmo_trader_people` row is also not linked to a platform `agents` row, and it has no thesis-claim state machine. Local compatibility does not solve missing upstream history, permanent identity, or thesis-author evidence.

## Identity structure

### Genie-owned imported profile

Keep `nmo_trader_people.person_id` as the stable local imported-profile ID for the current release. Add:

```sql
ALTER TABLE nmo_trader_people
  ADD COLUMN IF NOT EXISTS claimed_agent_id TEXT NULL REFERENCES agents(id),
  ADD COLUMN IF NOT EXISTS claimed_at BIGINT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_nmo_trader_people_claimed_agent
  ON nmo_trader_people(claimed_agent_id)
  WHERE claimed_agent_id IS NOT NULL;
```

The existing unique index on non-null `service_id` remains mandatory. The local profile owns NMO relationships and caches. `claimed_agent_id` attaches it to the user-controlled platform agent without rekeying either side.

If Genie later supports multiple external trader providers per agent, move `service_id` into a provider-link table:

```sql
CREATE TABLE trader_external_identities (
  trader_profile_id TEXT NOT NULL REFERENCES nmo_trader_people(person_id),
  provider TEXT NOT NULL,
  provider_trader_id TEXT NOT NULL,
  current_handle TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (provider, provider_trader_id),
  UNIQUE (trader_profile_id, provider)
);
```

This normalization is not required for the first Genie-Fomo release. It is the target if another provider is added.

### Registration algorithm

For each directory row `{id, handle, wallets}`:

```text
providerId = trim(id), kept opaque
walletKeys = normalize each wallet according to its address family

byProvider = local profile whose service_id == providerId
byWallet   = local profile owning any walletKey

if byProvider and byWallet identify different profiles:
    refuse automatic merge; record identity conflict for review
else if byProvider exists:
    update mutable handle/profile fields; attach only unconflicted wallets
else if byWallet exists:
    attach providerId if the existing profile has none; update display fields
else if providerId exists or at least one wallet exists:
    mint random local person_id and insert the profile
else:
    refuse registration because the row cannot be found again safely
```

The local ID is random and stable only inside Genie's database. The provider ID is stable across Genie installations. Neither is derived from the handle.

### Rename and collision behavior

- A provider-ID match with a new handle is a rename. Update display data only.
- Two provider IDs with the same folded handle remain two imported profiles.
- A handle may be used as a temporary AUM address only after Genie proves exactly one local profile currently owns that folded handle.
- Handle fallback must disappear after stable provider-ID routing is deployed.

### Runtime chart addressing

```text
UI trader card/profile
  -> resolves local imported-profile ID
  -> reads attached service_id
  -> sends service_id to Genie-Fomo
  -> preferred: maps returned canonical service_id to the same local profile ID
  -> temporary: maps returned handle only when exactly one local profile owns it
  -> caches exact AUM under (local profile ID, window)
  -> obeys drawing.drawable when present
  -> otherwise renders only >=3 exact numeric provider points as partial history
```

Genie's local profile ID must never be sent to Genie-Fomo. Genie-Fomo's ID must never replace `agents.id` or the local imported-profile ID.

## Balance-chart and asset architecture

There are two portfolio domains. They share UI components but not money or storage.

| View | Identity | Balance history source | Current assets source |
| --- | --- | --- | --- |
| Imported Fomo trader record | local imported-profile ID mapped to Fomo `service_id` | Genie-Fomo AUM | Genie-Fomo portfolio and positions |
| User-owned Genie portfolio | `agents.id` | Genie ledger balance series | Genie cash ledger and open-position ledger |

When an imported profile is claimed, both views remain available and are labeled `Fomo record` and `Genie portfolio`. Never concatenate their series, add their totals, or silently switch sources when one is unavailable.

### Imported trader balance chart

Primary upstream calls:

```http
GET /v1/traders/:serviceId/aum?window=1d|1w|1m|all
POST /v1/traders/aum
```

Processing path:

```text
registered profile
  -> read service_id
  -> request Genie-Fomo AUM
  -> decode either the permanent full contract or the current reduced projection
  -> map by canonical id, or temporarily by a locally unique returned handle
  -> preserve every provider field received; leave omitted facts unknown
  -> cache under (local profile ID, window, provider hour)
  -> return normalized AUM plus local identity/provenance and contract-mode envelope
  -> obey an explicit drawing verdict; otherwise apply the conservative compatibility rule
```

The card/profile may read a current-hour cache. The background pass warms all registered profiles with non-null `service_id` in batches of at most 50 for all four windows. It is not limited to followed traders or a fixed roster sample.

The permanent chart response should expose:

- local imported-profile ID and external provider ID;
- source `genie-fomo` and provider response time;
- `window`, `step`, `from`, `to`, and `trackedSince`;
- current total and per-point totals;
- point basis, tier, and coverage;
- response coverage, chain totals, gaps, status, reach, and progress;
- service-owned `drawing` and refusal fields.

The current reduced response is also consumable when it contains `handle`, `trackedSince`, `count`, `now`, and `points`. Fields absent from that response stay null/unknown. The consumer may take `window` from its own request, but it must not invent provider `step`, requested bounds, reach, coverage, basis, gaps, refusal reasons, or drawability.

No Fomoscan, Birdeye, Bitquery, Helius, or locally reconstructed history may replace missing Genie-Fomo AUM points.

### Imported trader assets

Primary upstream calls:

```http
GET /v1/traders/:serviceId/portfolio
GET /v1/traders/:serviceId/positions?limit=200&cursor=<opaque>
POST /v1/traders/positions
```

`portfolio` supplies the summary. `positions` supplies the asset rows. Follow individual cursors until `nextCursor` is null or the documented safety limit is reached. A short read remains usable only when returned with `complete: false`; it must not be described as the full portfolio.

Required internal asset shape:

```ts
type ImportedTraderAsset = {
  traderProfileId: string;
  serviceId: string;
  chain: string;
  tokenAddress: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  amount: number | null;
  balanceAt: string | null;
  tier: string | null;
  providerPriceUsd: number | null;
  providerPriceSource: string | null;
  providerPricedAt: string | null;
  providerValueUsd: number | null;
  whyNoPrice: string | null;
};
```

Asset identity is `(chain, tokenAddress)`. Symbols, names, and icons are mutable display metadata.

Display rules:

1. Sort provider-valued positions descending by `providerValueUsd`.
2. Keep unpriced positions after them rather than dropping them.
3. Show total positions, provider-priced positions, unpriced positions, coverage, and completeness.
4. Preserve provider amount, price, value, provenance, and timestamps exactly.
5. Fallback metadata or price enrichment must be a separate field with its own source and timestamp.
6. Never use an enriched sum to rewrite Genie-Fomo's portfolio total or AUM chart.

### User-owned Genie balance chart and assets

The owned-agent path does not call Genie-Fomo merely because the agent has a claimed Fomo profile.

```text
agents.id
  -> Genie cash ledger
  -> Genie open-position ledger
  -> live or last-known Genie price marks
  -> Genie's recorded balance series
  -> /api/nmo/balance?range=1d|7d|30d|all
```

The current total is cash plus valued open positions. A failed holdings read makes the total unknown; it must not return cash alone as if it were complete. Every asset includes chain, mint, quantity, cost, current value, P&L, valuation time, and metadata when known.

The owned-agent chart and positions remain keyed by `agents.id`. The imported Fomo record remains keyed by the local imported-profile ID. `claimed_agent_id` links them for navigation and ownership but does not merge their ledgers.

### Cache and refresh policy

| Data | Refresh | Cache key | Failure behavior |
| --- | --- | --- | --- |
| Imported AUM | provider cadence, currently hourly | `(trader_profile_id, window)` | retain last truthful answer with freshness; never fabricate |
| Imported assets | background pass plus explicit refresh policy | `trader_profile_id` plus provider snapshot | retain last complete page set; label stale or partial |
| Genie balance | each ledger mutation plus measurement cadence | `(agents.id, range)` | return unknown when ledger cannot answer |
| Genie assets | ledger mutation and live marks | `(agents.id, chain, mint)` | keep position; mark value unknown when no price |

Shared caches must be safe across app processes. A stale background owner cannot overwrite a newer answer, and a failed response cannot replace a successful answer from the same provider hour.

## Claim structure

### Claim challenge table

Recommended first-release schema:

```sql
CREATE TABLE nmo_trader_claim_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  trader_profile_id TEXT NOT NULL REFERENCES nmo_trader_people(person_id),
  service_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  issued_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'expired', 'cancelled'))
);
```

The raw token is shown once and should not be stored after issuance. Generate at least 128 bits of entropy. Bind the challenge to a 30-minute window by default.

### Claim evidence table

```sql
CREATE TABLE nmo_trader_claims (
  trader_profile_id TEXT PRIMARY KEY REFERENCES nmo_trader_people(person_id),
  agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  provider_trader_id TEXT NOT NULL,
  thesis_id TEXT NOT NULL,
  thesis_published_at BIGINT NOT NULL,
  thesis_text_sha256 TEXT NOT NULL,
  provider_request_id TEXT,
  verified_at BIGINT NOT NULL,
  UNIQUE (provider, provider_trader_id)
);
```

Store an evidence hash and stable thesis metadata, not an unrestricted copy of user content.

### Thesis terms

Recommended human-readable template:

```text
I am claiming my Genie agent. Verification: genie-claim-v1_<random-token>
```

The verifier must define exact normalization. Recommended rules:

- compare the challenge as one whitespace-delimited, case-sensitive token;
- permit surrounding prose;
- normalize line endings and Unicode to NFC before searching;
- do not lowercase or trim characters inside the token;
- reject edits published before the challenge's `issued_at` unless the provider supplies a trustworthy edit timestamp after issuance.

### Claim transaction

After Genie-Fomo verifies the thesis:

1. Lock the challenge row, imported profile row, selected `agents` row, and any existing claim.
2. Confirm the challenge is pending, unexpired, unused, and bound to all four IDs.
3. Confirm the authenticated user still owns the selected Genie agent.
4. Confirm the imported profile still carries the same `service_id`.
5. Confirm no other agent has claimed the profile and the selected agent has not claimed another Fomo profile.
6. Insert the evidence row.
7. Set `claimed_agent_id` and `claimed_at` on the imported profile.
8. Mark the challenge consumed.
9. Commit once. A retry returns the already-completed result without creating another claim.

Deleting the thesis after a completed claim does not silently revoke ownership. Transfer, dispute, and revocation require a separate explicit policy and audit trail.

If the submitted Fomo ID is not already in Genie's imported directory, Genie must first resolve it through a stable-ID directory/profile route and register the imported profile using the normal ID-and-wallet algorithm. Claim verification must never create a profile from a handle alone.

## Why an API change is still required

The current live API can power a restricted compatibility path for locally unique handles. It cannot yet give Genie a permanent, identity-safe, full-fidelity batch result.

| Problem | Confirmed live behavior | Local boundary |
| --- | --- | --- |
| Stable provider-ID lookup mismatch | `GET /v1/traders/:id/aum?window=1w` returns `404 not_found` for current directory IDs; the same request by handle returns `200` | Genie can use a unique-handle bridge, but cannot fix the provider resolver |
| Batch identity loss | A batch requested with stable provider IDs returns rows identified only by `handle` | Genie can safely accept only handles with exactly one local owner; renamed or colliding rows remain unavailable |
| Reduced batch contract | Rows contain only `handle`, `trackedSince`, `count`, `now`, and `points` | Genie can plot exact points conservatively, but cannot claim provider-certified coverage, cadence, basis, gaps, or drawability when those fields are omitted |
| No explicit row contract for failures | V7 does not define a one-result-per-input success/failure union | Missing rows cannot be distinguished from truncation, resolver failure, or an API bug |
| Insufficient upstream history | The reported traders have only one or two usable points; missing history is marked `chains_unrebuildable` | Genie must not fabricate historical balances or override `drawing.drawable` |
| No documented thesis verification | Parameter Routes V7 exposes no thesis-read or claim-verification route | Genie cannot prove which stable Fomo account authored the challenge thesis |

## Confirmed examples

The directory returns these stable identities:

| Handle | Stable Genie-Fomo directory ID |
| --- | --- |
| `gmgn_0x03703d46` | `07177ef1-82fe-4855-953c-d4bb31b7d39a` |
| `gmgn_0x0fa3a520` | `7a6ae341-2844-48d7-a3a0-5e76133a72e8` |

Individual AUM requests by those provider IDs return `404`; requests by the corresponding handles return `200`. The current values happen to be UUID-shaped, but consumers must treat the field as an opaque stable string.

The live batch route accepts the provider IDs and returns `200`, but each result loses the provider ID and omits these individual-AUM fields:

```text
window, step, stepMs, from, to, status, reach, drawing, progress,
gaps, coverage, chains, refused, plain
```

The current upstream history is:

| Trader | Window | Usable points | Missing points | Service verdict |
| --- | ---: | ---: | ---: | --- |
| `gmgn_0x03703d46` | 1D | 1 | 0 | `warming` |
| `gmgn_0x03703d46` | 7D | 1 | 6 | `too_few_points` |
| `gmgn_0x03703d46` | 30D | 1 | 28 | `too_few_points` |
| `gmgn_0x03703d46` | All | 1 | 30 | `too_few_points` |
| `gmgn_0x0fa3a520` | 1D | 1 | 0 | `warming` |
| `gmgn_0x0fa3a520` | 7D | 2 | 5 | `too_few_points` |
| `gmgn_0x0fa3a520` | 30D | 2 | 27 | `too_few_points` |
| `gmgn_0x0fa3a520` | All | 2 | 29 | `too_few_points` |

The service reports the missing historical points as `chains_unrebuildable`. `drawing.drawable: false` is therefore correct for the individual responses and Genie must obey it. The reduced-response compatibility path still cannot display these two lines because they contain fewer than three usable points. The API team must improve truthful coverage before these specific charts can appear.

## Genie compatibility implementation available now

Genie does not need to wait for every rich AUM field before it consumes the deployed batch projection. #168 should implement two decoder modes.

### Full mode

Use full mode when each row contains canonical `id` and the complete AUM object:

- match by `service_id`;
- preserve the complete provider response;
- obey `drawing.drawable` and `drawing.reason`;
- expose provider coverage, gaps, reach, basis, tiers, and refusal text.

### Reduced compatibility mode

Use reduced mode only when the top-level response has valid `limit`, `asked`, and `capped: false`, and every returned row contains the deployed projection.

1. Build an expected normalized-handle map from the same frozen directory/profile snapshot used to form the `service_id` request.
2. Reject a response handle unless it maps to exactly one requested `service_id` and exactly one local profile in that snapshot. Refuse a new handle until a directory refresh confirms the rename.
3. Reject duplicate response handles, unknown handles, extra rows, omitted rows, count mismatches, and capped batches. Never join by array position.
4. Take `window` only from the validated request context.
5. Parse `points[].at` and `points[].totalUsd` without altering either value. Timestamps must be valid and strictly increasing. `totalUsd` may be null; null breaks the line.
6. Preserve valid `trackedSince`, `count`, and `now`. Treat omitted rich fields as unknown, not as defaults.
7. If the row contains an explicit `drawing` verdict, obey it. `drawable: false` always wins.
8. If `drawing` is absent, draw only when one contiguous segment contains at least three finite timestamps with numeric `totalUsd` values. Label the chart `Partial provider history` and display its actual first and last returned timestamps. Do not claim the requested window is fully covered.
9. One or two usable points produce `insufficient_history`, not a fabricated line.
10. Cache by local imported-profile ID and requested window, with provenance `genie-fomo` and `contractMode: reduced_handle_v7`.

Suggested normalized seam:

```ts
type AumContractMode = "full_id_v2" | "reduced_handle_v7";

type NormalizedTraderAum = {
  traderProfileId: string;
  serviceId: string;
  handle: string;
  requestedWindow: "1d" | "1w" | "1m" | "all";
  contractMode: AumContractMode;
  trackedSince: string | null;
  now: {
    at: string | null;
    totalUsd: number | null;
  } | null;
  count: number | null;
  points: Array<{
    at: string;
    totalUsd: number | null;
    basis: "sampled" | "rebuilt" | null;
  }>;
  drawing: {
    drawable: boolean;
    reason: string | null;
    authority: "provider" | "genie_conservative_compatibility";
  };
  omittedProviderFields: string[];
};
```

This normalization does not reconstruct AUM. It plots only balances Genie-Fomo returned. The local rule answers whether an existing set of exact points is minimally displayable; it never creates a point or declares full coverage.

## Required API design

### 1. Use one resolver for IDs and handles

All documented trader routes must resolve either:

- the opaque stable ID returned by the trader directory; or
- the current exact handle.

The resolver must return the same canonical trader record for both inputs. A renamed handle must not change the stable provider ID.

At minimum, this must work for:

```http
GET /v1/traders/:id-or-handle/aum?window=1d|1w|1m|all
POST /v1/traders/aum
```

### 2. Return a versioned, identity-safe permanent batch contract

Recommended request:

```http
POST /v1/traders/aum
Content-Type: application/json

{
  "contractVersion": 2,
  "ids": [
    "07177ef1-82fe-4855-953c-d4bb31b7d39a",
    "gmgn_0x0fa3a520"
  ],
  "window": "1w"
}
```

Recommended response:

```json
{
  "contractVersion": 2,
  "limit": 50,
  "asked": 2,
  "capped": false,
  "window": "1w",
  "traders": [
    {
      "ok": true,
      "requested": "07177ef1-82fe-4855-953c-d4bb31b7d39a",
      "id": "07177ef1-82fe-4855-953c-d4bb31b7d39a",
      "handle": "gmgn_0x03703d46",
      "aum": {
        "handle": "gmgn_0x03703d46",
        "window": "1w",
        "step": "1d",
        "stepMs": 86400000,
        "from": "2026-09-05T00:00:00.000Z",
        "to": "2026-09-11T00:00:00.000Z",
        "trackedSince": "2026-09-10T00:00:00.000Z",
        "status": "warming",
        "reach": {},
        "drawing": {
          "drawable": false,
          "reason": "too_few_points"
        },
        "progress": {},
        "gaps": [],
        "coverage": {},
        "now": {},
        "count": 7,
        "points": [],
        "chains": [],
        "refused": null,
        "plain": null
      }
    },
    {
      "ok": false,
      "requested": "gmgn_0x0fa3a520",
      "id": "7a6ae341-2844-48d7-a3a0-5e76133a72e8",
      "handle": "gmgn_0x0fa3a520",
      "error": {
        "code": "temporarily_unavailable",
        "detail": "History read failed",
        "requestId": "request-id-for-api-logs"
      }
    }
  ]
}
```

The values above illustrate the shape, not expected production balances.

### 3. Return identity-safe portfolio and positions

All asset routes documented as accepting an ID or handle must resolve the same stable provider ID:

```http
GET /v1/traders/:id/portfolio
GET /v1/traders/:id/positions?limit=<n>&cursor=<opaque>
POST /v1/traders/positions
```

The batch positions response must use the same envelope as batch AUM:

```json
{
  "contractVersion": 2,
  "limit": 50,
  "asked": 2,
  "capped": false,
  "traders": [
    {
      "ok": true,
      "requested": "<submitted-provider-id>",
      "id": "<canonical-provider-id>",
      "handle": "<current-handle>",
      "positions": [],
      "positionCount": 0,
      "pricedPositionCount": 0,
      "totalValueUsd": 0,
      "coverage": {},
      "complete": true,
      "nextCursor": null
    }
  ]
}
```

Each position must preserve `chain`, token address, amount, `balanceAt`, tier, `priceUsd`, `priceSource`, `pricedAt`, `valueUsd`, and `whyNoPrice`. A null total means the provider could not value the portfolio; a measured empty portfolio is zero.

The API must state whether one batch row contains the whole position set or a page. If paged, return a per-row cursor and make repeated pages snapshot-consistent. Never label a partial row complete.

### 4. Preserve the individual response exactly

For every successful row:

```text
batchRow.aum deep-equals GET /v1/traders/{batchRow.id}/aum?window={window}
```

Request metadata may differ. AUM data may not be projected, renamed, recomputed, or summarized in the batch route.

Fields that must survive unchanged include:

- requested window, step, bounds, and timestamps;
- `null` totals;
- every point's `basis`, `tier`, `refused`, and coverage;
- response-level coverage and chain totals;
- gaps and their reasons;
- status, reach, and progress;
- `drawing.drawable` and `drawing.reason`;
- `refused` and `plain` service explanations.

### 5. Guarantee one result per request item

For a valid request of N identifiers, return exactly N result rows.

Each row must include:

- `requested`: the exact submitted identifier;
- canonical `id` when resolution succeeds;
- current `handle` when resolution succeeds;
- either `ok: true` plus `aum`, or `ok: false` plus `error`.

Preserving input order is useful but not an identity guarantee. Genie will join on `requested` and canonical `id`, never on array position or handle alone.

Duplicate request identifiers should be rejected with `400 duplicate_identifier`. The API must not collapse them silently.

### 6. Define whole-request and row-level errors

Whole-request failures:

| Condition | HTTP status | Required behavior |
| --- | ---: | --- |
| Invalid JSON or body shape | 400 | Reject the whole request |
| Unsupported window | 400 | Name allowed values |
| Zero identifiers | 400 | Do not return an empty success |
| More than 50 identifiers | 400 | Do not truncate or set `capped: true` silently |
| Duplicate identifiers | 400 | Return `duplicate_identifier` |
| Authentication failure, if auth is added | 401 or 403 | Reject the whole request |
| Budget exhausted | 429 | Include cost and retry headers |
| Service unavailable | 503 | Include `requestId` and retry guidance |

Row-level failures inside a successful `200` batch:

- `not_found`
- `temporarily_unavailable`
- `history_unavailable`
- another stable, documented code owned by the API

The API must not return a `200` response with fewer than `asked` rows.

### 7. Keep cost and throttling observable

Every successful batch response must include:

```text
X-Cost-Units
RateLimit-Limit
RateLimit-Remaining
RateLimit-Reset
RateLimit-Scope
```

The API team must document whether cost is charged per HTTP call, requested trader, resolved trader, returned point, or a combination. Partial row failures must have deterministic accounting.

### 8. Repair service-owned historical coverage

The API team must investigate why historical reconstruction returns `chains_unrebuildable` for the two confirmed traders and their registered wallets.

Required outcome:

- identify the affected chain or provider for every refused point;
- distinguish permanently unavailable history from retryable ingestion failure;
- run or repair the service-side backfill where truthful source data exists;
- keep gaps explicit where source data does not exist;
- let the daily sampler advance history according to the documented cadence;
- return `drawing.drawable: true` only when the API's own criteria are genuinely satisfied.

The requirement is truthful chartable history, not a forced green status. If history cannot be recovered, the API must return a stable refusal reason and enough structured detail for Genie to explain why no chart exists.

### 9. Add stable-ID thesis verification

Parameter Routes V7 does not document a thesis route. Genie-Fomo must provide either a thesis-read contract or the recommended server-side verifier:

```http
POST /v1/trader-claims/verify
Authorization: Bearer <Genie server credential>
Content-Type: application/json

{
  "traderId": "7a6ae341-2844-48d7-a3a0-5e76133a72e8",
  "challenge": "genie-claim-v1_<random-token>",
  "notBefore": "2026-09-11T20:00:00.000Z"
}
```

```json
{
  "verified": true,
  "trader": {
    "id": "7a6ae341-2844-48d7-a3a0-5e76133a72e8",
    "handle": "gmgn_0x0fa3a520"
  },
  "evidence": {
    "thesisId": "opaque-stable-thesis-id",
    "publishedAt": "2026-09-11T20:04:00.000Z",
    "matchedChallenge": "genie-claim-v1_<random-token>",
    "textSha256": "hex-encoded-hash",
    "visible": true,
    "deleted": false
  }
}
```

Required semantics:

- Author matching uses the stable provider ID, never the handle.
- The challenge match follows the documented normalization rules.
- The thesis must have been published after `notBefore`.
- The route returns stable thesis evidence and a provider request ID.
- A negative result reveals no unrelated thesis content.
- The route is authenticated, rate-limited, and auditable.
- Genie-Fomo verifies only provider-side authorship. Genie decides local ownership and consumes the challenge.

## Data invariants

1. Canonical `id` is immutable and unique.
2. Handle is mutable display data and is never a permanent cache or join key. The temporary reduced decoder may use it only as a one-request correlation key after proving local uniqueness.
3. Each accepted request produces one explicit result.
4. `asked` equals the number of submitted identifiers.
5. Requests of 1 through 50 identifiers return `capped: false`.
6. The API rejects requests larger than 50 instead of truncating them.
7. Null remains null. It never becomes zero.
8. Gaps remain gaps. They are never forward-filled or interpolated.
9. `sampled` and `rebuilt` retain their exact service meanings.
10. The batch endpoint and individual endpoint return the same AUM truth.
11. An explicit Genie-Fomo drawability verdict is authoritative. If the reduced response omits it, Genie may use only the documented conservative rule and must label the result partial provider history.
12. The Fomo provider ID remains opaque and stable across handle changes.
13. A claim challenge can match only a thesis authored by the requested stable provider ID.
14. Imported Fomo balances and user-owned Genie balances are separate ledgers and are never summed.
15. An imported asset is identified by chain and token address, never symbol or icon.
16. An unpriced asset remains present and contributes unknown, not zero, value.
17. Batch positions results map one-to-one by canonical provider ID just like batch AUM.

## Compatibility and rollout

### Phase 0: consume the deployed projection now

1. Add `reduced_handle_v7` decoding to #168.
2. Keep canonical-ID/full-envelope decoding as `full_id_v2`.
3. Warm every registered profile, not only followed profiles or a sample roster.
4. Refuse ambiguous handles and incomplete batches without replacing a previously good cache entry.
5. Show exact provider points only under the conservative rule and partial-history label.
6. Land and runtime-test the Genie change independently of the API expansion.

### Phase 1: migrate to the permanent contract

The new responses wrap full AUM data under `aum` and add identity-safe positions rows, so the API must version both batch contracts. The recommended migration is:

1. Accept `contractVersion: 2` on the existing batch route.
2. Keep the current V7 projection temporarily for requests without that field.
3. Publish a retirement date for the projected response.
4. After Genie confirms production use of version 2, remove the old projection in the next documented API version.

If the API team prefers a new endpoint instead, `/v2/traders/aum` is acceptable if it follows this TDR exactly. Do not change the contract silently under the existing response without a compatibility plan.

## Genie compatibility acceptance tests

These tests can pass before the permanent API change:

1. A current reduced batch fixture with unique handles maps every returned row to the expected requested `service_id` and local profile.
2. Three strictly increasing numeric provider points draw with `contractMode: reduced_handle_v7` and a `Partial provider history` label.
3. One or two numeric points return `insufficient_history` and no line.
4. A null point breaks the rendered series and is never converted to zero.
5. Duplicate, ambiguous, renamed-but-unrefreshed, unknown, extra, or omitted handles are refused.
6. `asked` mismatch, a short result, or `capped: true` cannot replace an existing good cache entry.
7. An explicit provider `drawing.drawable: false` prevents drawing even when three numeric points exist.
8. Missing `step`, bounds, reach, coverage, basis, gaps, refusal, and drawing metadata remain unknown.
9. The compatibility pass warms every eligible registered trader, independent of follows or roster samples.
10. No Fomoscan, Birdeye, Bitquery, Helius, interpolation, or local balance reconstruction contributes a chart point.

## API acceptance tests

The permanent API change is complete only when all tests pass against the deployed service.

### Identity and resolver

1. Read a stable provider ID from the directory.
2. Call individual AUM by provider ID and by handle for the same window.
3. Assert both return `200`, the same canonical identity, and equivalent AUM.
4. Rename a test trader's handle and assert the provider ID remains valid.
5. Assert two traders with the same folded handle remain distinguishable by provider ID.

### Batch equivalence

For each of `1d`, `1w`, `1m`, and `all`:

1. Submit a mixed list of provider IDs and handles.
2. Assert `asked` equals the request length.
3. Assert the response contains exactly one row per submitted identifier.
4. Assert every resolved row contains `requested`, canonical `id`, and current `handle`.
5. Assert each `row.aum` deep-equals the individual GET response for `row.id` and the same window.

### Limits and failures

1. A 50-identifier request returns 50 explicit results and `capped: false`.
2. A 51-identifier request returns `400` and no partial data.
3. An unknown identifier returns an explicit `ok: false` row without removing successful rows.
4. Duplicate identifiers return `400 duplicate_identifier`.
5. Null totals, gaps, tiers, basis, refusal reasons, drawing verdicts, and coverage survive unchanged.
6. Required cost and rate-limit headers are present.

### Portfolio and assets

1. `portfolio`, `positions`, and batch positions accept stable provider IDs.
2. A batch of 50 provider IDs returns exactly 50 explicit result rows and `capped: false`.
3. Every successful row returns canonical provider ID, coverage, completeness, and all documented positions.
4. A paged position response provides a stable cursor and does not repeat or lose assets within one snapshot.
5. Every position preserves chain, token address, quantity, timestamps, tier, provider price provenance, value, and no-price reason.
6. A measured empty portfolio returns zero; a portfolio that could not be valued returns null.
7. Two assets with the same symbol on different chains or addresses remain distinct.
8. The sum shown for fallback-enriched assets is never substituted for provider AUM.

### Historical coverage

1. Exercise both reported trader IDs through all four windows.
2. Prove each returned point against the service's source data or mark it as explicitly rebuilt according to the API's existing rules.
3. Assert gaps and refusals remain explicit.
4. Assert `drawing.drawable` remains false while there are too few truthful points.
5. Assert it becomes true only after the service's documented drawing threshold is met.

### Thesis claim verification

1. A thesis from the requested stable Fomo ID containing the exact live challenge verifies.
2. The same text posted by another Fomo account does not verify.
3. A thesis published before `notBefore` does not verify.
4. A partial, case-changed, expired, or already-consumed token does not complete a Genie claim.
5. A handle rename between challenge issuance and verification does not break stable-ID author matching.
6. The response returns stable thesis evidence without exposing unrelated content.

## Required API delivery package

The API engineer should hand Genie all of the following:

1. Deployment identifier and deployment time.
2. Updated Parameter Routes documentation.
3. One real version-2 success fixture using stable provider IDs.
4. One real mixed success/failure fixture.
5. One real response for each supported window.
6. Header capture proving cost and rate-limit reporting.
7. A coverage report for the two affected trader IDs, including any remaining `chains_unrebuildable` reasons.
8. A thesis-verification fixture for success, wrong author, no match, and provider failure.
9. Authentication, cost, and rate-limit documentation for the thesis-verification route.
10. Individual and batch positions fixtures covering complete, paged, partial, empty, and unpriced portfolios.

## Genie-owned work

These are not API-engineer tasks:

1. Update #168 now to support both `reduced_handle_v7` and `full_id_v2`.
2. Store AUM by Genie's local imported-profile ID while retaining the stable Genie-Fomo ID as external identity.
3. Preserve the service response without reconstruction.
4. Obey explicit provider drawability; otherwise apply the conservative reduced-contract rule and label the chart partial.
5. Test handle collisions, handle renames, unknown/duplicate/omitted rows, null points, one/two/three-point histories, and explicit `drawable: false`.
6. Land the approved #123/#168 work into the branch running the app.
7. Restart the local app on port 4536 only through the designated landing flow and without replacing its data.
8. Verify For You cards and trader profiles for 1D, 7D, 30D, and All.
9. After the permanent API contract deploys, switch successful rows to canonical-ID correlation and remove the handle bridge after coverage is confirmed.
10. Add claim challenge and evidence tables.
11. Add the authenticated challenge-issuance and verification routes.
12. Link a verified imported profile to an already user-owned Genie agent in one transaction.
13. Do not provision an ownerless platform agent during directory import.

## Definition of done

The compatibility chart work is done when Genie consumes the deployed reduced response, safely maps only unique handles, preserves exact provider points, draws only qualifying partial histories, and keeps one-point, two-point, ambiguous, incomplete, and explicitly non-drawable rows out of the chart.

The permanent API portion is done when stable IDs work everywhere; AUM and positions batches are identity-safe and contract-equivalent to their individual routes; assets retain coverage, completeness, and valuation provenance; failures are explicit; the two reported traders either have truthful drawable history or a precise service-owned explanation of why that history cannot exist; and Genie can verify a challenge thesis against a stable Fomo author ID.

The trader-agent product is not done until Genie consumes the deployed contracts, the running application contains the #123/#168 chart changes, and a Fomo trader can complete a replay-safe thesis claim without losing imported identity or history.
