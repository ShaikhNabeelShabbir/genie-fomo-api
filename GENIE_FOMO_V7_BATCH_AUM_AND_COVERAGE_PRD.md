# PRD: Import Fomo Traders as Claimable Genie Agents with Authoritative AUM Charts

Date: 11 September 2026  
Revision: 3, adds a safe current-contract path and separates launch requirements from the permanent API contract  
Product owner: Genie  
API owner: Genie-Fomo API  
Consumer: Genie NMO trader cards, profiles, copy trading, and agent claims  
Priority: Genie compatibility path is release-blocking; permanent API completeness follows

## Product model

Genie is an agent controlled by a human user or trader. Everyone imported from Fomo is a trader whose public performance and positions can become a copy-trading source in Genie. A Fomo trader may later join Genie, prove control of the Fomo account, and claim that imported identity for their own Genie agent.

The product has four distinct identities:

| Identity | Meaning | Stable key | Owner |
| --- | --- | --- | --- |
| User | The human account controlling Genie | `users.id` | Genie |
| Genie agent | The trading agent the user controls | `agents.id` | Genie |
| Imported trader profile | Genie's durable local record for the Fomo trader and copy source | currently `nmo_trader_people.person_id` | Genie |
| Fomo trader identity | The external account and its data | directory `id`, stored as `service_id` | Genie-Fomo |

The current column name `person_id` means imported trader profile ID. It is not the platform `agents.id` and must not be passed to Genie-Fomo. A later schema cleanup may rename it to `trader_profile_id`; the rename is not required to ship AUM charts.

Before a claim, the imported trader profile is public and copyable but has no platform owner, credits, secrets, sandbox, or trading authority. At claim time it links to a real Genie agent owned by the authenticated user. The public profile, imported history, followers, and copy relationships keep the same local profile ID.

```text
User ──controls──> Genie agent
                       │
                       │ claims
                       ▼
Imported trader profile ──identified at Fomo by──> service_id
          │
          ├── current handle
          ├── wallets
          ├── imported trades and performance
          └── AUM history and chart cache
```

## Identity rules

1. Genie-Fomo's directory `id` is an opaque stable provider identifier. Genie must not assume a UUID format.
2. Genie mints its own imported-profile ID. It is never derived from a handle or provider ID.
3. A directory refresh matches by `service_id` first and wallet second, never by handle.
4. A handle is mutable display data. A rename updates the profile but never rekeys it.
5. Two Fomo accounts may share a folded handle and must remain two profiles.
6. A row with neither a provider ID nor a wallet cannot be registered safely.
7. Charts, imported records, follows, and copy relationships use the local imported-profile ID.
8. Calls to Genie-Fomo use `service_id`.
9. The permanent Genie-Fomo batch contract must return canonical `service_id` so Genie can map results back to local profiles. Until that ships, Genie may map a row by a locally unique normalized handle only; ambiguous rows are refused.
10. Claiming links the imported profile to an owned Genie agent; it does not replace either identifier.

## Source priority

Genie-Fomo is the primary and authoritative provider for imported Fomo traders.

| Data | Primary source | Fallback policy |
| --- | --- | --- |
| Fomo trader ID and handle | Genie-Fomo directory | No identity fallback to a handle or another provider |
| Trader wallets and chain presence | Genie-Fomo | Fallback may add evidence but may not replace provider identity |
| Historical balance/AUM chart | Genie-Fomo | No reconstructed or blended Fomoscan chart |
| Current trader assets and provider valuation | Genie-Fomo positions/portfolio | Optional fallback enrichment must be separately labeled |
| Thesis authorship for a claim | Genie-Fomo | No Fomoscan or handle-based ownership proof |
| User-owned Genie agent balance/assets | Genie's own ledger | No external provider substitutes for the agent ledger |

`fomoscan.ts` is a legacy/fallback module, not the primary product contract. The main path must call Genie-Fomo. A fallback may improve non-authoritative display metadata such as an icon or separately labeled price estimate, but it must never change trader identity, authorize a claim, fabricate AUM, overwrite provider quantities, or silently blend two sources.

## Outcome

Genie must import every Fomo directory trader into one stable, copyable local profile; fetch exact balance history for all registered profiles in batches of at most 50; and associate each answer with the right profile. Genie should consume the reduced batch response already deployed while the API team adds stable row identity and the full AUM envelope.

Genie must not reconstruct, interpolate, fill gaps, or invent balances. When Genie-Fomo returns `drawing.drawable`, Genie must obey it. When the reduced batch response omits `drawing`, Genie may plot only the exact provider points after the conservative compatibility checks in this PRD; it must label the result as partial provider history and must not claim full-window coverage.

A Fomo trader must be able to claim the imported profile for a Genie agent by posting a thesis from that Fomo account containing Genie's one-time verification terms.

## End-to-end product flows

### Directory import

1. Genie requests the Fomo directory with wallets.
2. Each directory row supplies the Fomo `id`, current handle, profile data, and any known wallets.
3. Genie matches the row to an imported profile by Fomo ID, then by wallet.
4. Genie reuses the existing local profile ID or mints a new one.
5. Genie updates mutable display fields and wallet evidence without changing identity.
6. The imported profile immediately becomes available as a public copy-trading source.

### Trader chart

1. The card or profile resolves to one local imported-profile ID.
2. Genie reads the attached Fomo `service_id`.
3. The background warmer requests all eligible traders, at most 50 per batch, for all four windows.
4. Preferred mapping uses returned canonical `service_id`. While the deployed response is handle-only, Genie may map a row only when exactly one registered profile owns that normalized handle. It never maps by array order.
5. Genie caches the provider fields without changing point timestamps or values under the local profile ID and window.
6. If `drawing.drawable` is present, the UI obeys it. If `drawing` is absent, the UI may draw only when at least three strictly ordered provider points have finite timestamps and numeric `totalUsd` values, with breaks at every null or missing bucket and a `Partial provider history` label.
7. One or two usable points remain an insufficient-history state. Genie never manufactures the missing line.

### Trader assets

1. The card or profile resolves to one local imported-profile ID and its Fomo `service_id`.
2. Genie reads `GET /v1/traders/:id/portfolio` for the current total and coverage summary.
3. Genie reads `GET /v1/traders/:id/positions` for the actual asset rows, following cursors until complete or a stated safety cap is reached.
4. Background refreshes use `POST /v1/traders/positions` in groups of at most 50.
5. Every result maps back by canonical Fomo ID and is stored under the local imported-profile ID.
6. The UI sorts known values from largest to smallest, followed by unpriced positions.
7. An unpriced asset remains present with `valueUsd: null` and `whyNoPrice`; it never becomes zero or disappears.

### A Genie agent's own balance and assets

A user-owned Genie agent has a separate live portfolio produced by Genie's own ledger and execution engine:

- the agent's balance chart comes from Genie's recorded balance series;
- current cash and open positions come from the agent ledger;
- current asset values use Genie's live or last-known price with an explicit valuation time;
- failed position reads produce unknown totals, not a cash-only number that looks complete.

When a Fomo profile has been claimed, the product has two truthful portfolios:

1. **Fomo record:** the external trader's imported history and assets from Genie-Fomo.
2. **Genie portfolio:** what the user-controlled Genie agent currently owns and trades in Genie.

These must be shown as separate labeled views. They must not be summed or spliced into one chart because they may cover different wallets, times, chains, and valuation rules.

## What each trader or Genie profile must show

### Balance chart

- current total value and valuation time;
- 1D, 7D, 30D, and All selectors;
- a line when the authoritative source says it is drawable, or under the temporary conservative rule when the reduced response contains at least three exact numeric provider points;
- breaks at gaps rather than interpolation;
- coverage and freshness near the figure;
- an honest warming, unavailable, or insufficient-history state;
- source label: `Fomo record` or `Genie portfolio`.

### Asset list

Each row must show, when known:

- chain;
- token address or mint as identity;
- symbol, name, and icon as display metadata;
- quantity;
- price and price source;
- total position value;
- balance timestamp and price timestamp;
- verified or reported tier;
- why no price is available;
- holding/activity times when supplied.

The summary must show total assets, priced assets, unpriced assets, total measured value, coverage, and whether every page was loaded. Symbols and icons are never asset identity; `(chain, token address)` is.

### Claim through a Fomo thesis

1. An authenticated user selects their Genie agent and the imported Fomo trader profile.
2. Genie creates a cryptographically random, single-use challenge bound to the user, Genie agent, local trader profile, Fomo `service_id`, and expiry.
3. Genie gives the user exact thesis terms containing a fixed human-readable statement and the unique challenge token.
4. The user posts that thesis from the Fomo account being claimed.
5. Genie asks Genie-Fomo to find or verify the thesis by stable Fomo account ID.
6. Genie verifies the author ID, exact challenge, publication time, expiry, and unused state.
7. In one database transaction, Genie consumes the challenge and links the imported trader profile to the user's Genie agent.
8. The same imported history, followers, copy relationships, and local profile ID remain in place.

Merely entering a public Fomo ID is not proof. A fixed phrase without a random challenge is also not proof because an old thesis could be replayed.

## Current live gaps and permanent-contract blockers

### 1. Stable directory IDs are not accepted by the individual AUM route

The directory currently returns stable provider IDs, including:

- `gmgn_0x03703d46` -> `07177ef1-82fe-4855-953c-d4bb31b7d39a`
- `gmgn_0x0fa3a520` -> `7a6ae341-2844-48d7-a3a0-5e76133a72e8`

Live requests to `GET /v1/traders/:id/aum?window=1w` return `404 not_found` for those IDs. The same route addressed by handle returns `200`.

Required behavior: every route documented as accepting an ID or handle must accept the stable directory ID. Current IDs happen to be UUID-shaped; the contract must define them as opaque strings.

### 2. The batch AUM response loses stable identity and most of the AUM contract

This live request succeeds:

```http
POST /v1/traders/aum
Content-Type: application/json

{
  "ids": [
    "07177ef1-82fe-4855-953c-d4bb31b7d39a",
    "7a6ae341-2844-48d7-a3a0-5e76133a72e8"
  ],
  "window": "1w"
}
```

The response reports `limit: 50`, `asked: 2`, and `capped: false`, but each `traders[]` row contains only:

```text
handle, trackedSince, count, now, points
```

It does not return the stable trader ID or the full individual AUM fields:

```text
window, step, stepMs, from, to, status, reach, drawing, progress,
gaps, coverage, chains, refused, plain
```

Genie cannot safely associate duplicate or renamed handles through this response, use the service's drawing verdict, or preserve omitted gap and refusal detail. This blocks complete identity-safe coverage, but it does not have to block every chart: Genie can consume rows whose handles are locally unique and plot exact provider points under the conservative rule below.

## What is required now versus required permanently

The full individual AUM envelope is the target contract, not a prerequisite for drawing every basic chart.

| Capability | Required for compatibility release now | Required permanent API contract |
| --- | --- | --- |
| Row association | Returned handle that matches exactly one requested `service_id` and local profile in the frozen directory snapshot | Submitted `requested` plus canonical stable `id` on every row |
| Line data | At least three strictly ordered `{at, totalUsd}` provider points | Full points with basis, tier, refusal, and coverage |
| Window | Known from the request | Echoed by the response |
| Drawability | Obey provider verdict when present; otherwise apply the conservative three-point rule and label partial history | Provider-owned `drawing.drawable` and reason |
| Bounds and cadence | Do not invent them; derive only the actual first/last returned timestamps for internal display | Provider `step`, `stepMs`, `from`, `to`, and `reach` |
| Missing data | Preserve null points and break the line | Explicit `gaps`, `coverage`, `refused`, and `plain` |
| Current total | Use provider `now` when structurally valid; otherwise omit it | Full `now`, chain totals, tier, and valuation coverage |

The compatibility path must:

1. Request Genie-Fomo, never Fomoscan, Birdeye, Bitquery, or Helius for the AUM line.
2. Build an expected-handle map from the same frozen directory/profile snapshot used to form the `service_id` request.
3. Accept a handle-only row only when its normalized handle matches exactly one requested `service_id` and exactly one registered local profile. A rename not yet present in the snapshot is refused until the directory refreshes.
4. Refuse duplicate response handles, unknown handles, omitted rows, capped responses, and count mismatches.
5. Preserve the provider's point timestamps and values exactly.
6. Treat absent `basis`, coverage, drawability, gap, and refusal fields as unknown, not inferred facts.
7. Never describe the returned points as complete 1D, 7D, 30D, or All coverage unless the provider says so.
8. Replace this bridge with canonical-ID mapping when the identity-safe contract ships.

This path makes currently usable provider histories visible without pretending that a mutable handle is durable identity. It cannot make a one-point or two-point history into a chart.

### 3. V7 has no documented thesis-verification route

The latest supplied Parameter Routes V7 document contains no route that lets Genie read or verify a thesis authored by a stable Fomo trader ID. Without that contract, Genie cannot complete the ownership proof safely.

The API team must provide either:

- a server-to-server claim-verification route that verifies author, text, and publication time; or
- a thesis-read route whose response includes stable author ID, stable thesis ID, exact body, publication time, and deletion/visibility state.

The handle printed beside a thesis is not sufficient author identity.

### 4. Batch positions also need identity-safe results

V7 documents `POST /v1/traders/positions`, but its example identifies each row only by handle. Genie needs the same `requested`, canonical `id`, explicit row success/failure, cap, cost, and no-silent-omission guarantees as batch AUM.

The individual `portfolio`, `positions`, and `wallets` routes must also accept the stable Fomo ID. Genie must not address assets by handle in the steady state.

## Required asset contract

For one imported trader:

```http
GET /v1/traders/:id/portfolio
GET /v1/traders/:id/positions?limit=200&cursor=<opaque>
```

For background refresh:

```http
POST /v1/traders/positions
Content-Type: application/json

{
  "contractVersion": 2,
  "ids": ["<stable-fomo-id-1>", "<stable-fomo-id-2>"]
}
```

Each successful batch row must contain:

- `requested`, canonical `id`, current `handle`, and `ok: true`;
- complete positions or an explicit pagination boundary;
- total position count and priced-position count;
- `totalValueUsd`, preserved as null when nothing was valued;
- per-position chain, token address, amount, balance time, tier, price, price source, price time, value, and `whyNoPrice`;
- coverage, `limit`, `capped`, and any next cursor;
- the same values the individual positions route returns for the same snapshot.

Each failed row must return `ok: false` with `requested`, resolved identity when known, stable error code, and request ID. A `200` batch must still contain exactly one result per input.

Genie may attach locally known symbols, names, icons, or a separately labeled price estimate. It may not alter provider quantities, overwrite provider provenance, or use an enriched asset sum to rewrite Genie-Fomo's AUM history.

## Permanent batch contract

`POST /v1/traders/aum` must satisfy all of the following:

1. Accept 1 to 50 stable directory IDs or handles.
2. Return exactly one result for every requested item.
3. Return the canonical stable directory `id` on every successful row.
4. Return the submitted value as `requested`, so a response remains unambiguous after a rename.
5. Return the complete AUM object used by `GET /v1/traders/:id/aum` without reducing or recomputing it.
6. Preserve `null` totals, gaps, sampled/rebuilt basis, tiers, coverage, chain totals, refusal reasons, and the service's `drawing` verdict exactly.
7. Keep `limit`, `asked`, and `capped` on every batch response.
8. Return `X-Cost-Units` and all rate-limit headers on every successful response.
9. Never identify a row only by display handle.
10. Do not silently omit failed traders.

Recommended response shape:

```json
{
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
        "from": "...",
        "to": "...",
        "trackedSince": "...",
        "status": "ready",
        "reach": {},
        "drawing": {},
        "progress": null,
        "gaps": [],
        "coverage": {},
        "now": {},
        "count": 7,
        "points": [],
        "chains": [],
        "refused": null,
        "plain": null
      }
    }
  ]
}
```

For a trader that cannot be answered, return an explicit result rather than omitting it:

```json
{
  "ok": false,
  "requested": "unknown-id",
  "id": null,
  "handle": null,
  "error": {
    "code": "not_found",
    "detail": "..."
  }
}
```

Input order may be preserved for convenience, but order is not an identity guarantee. `requested` and canonical `id` are required for the permanent contract. The temporary compatibility path joins only on a locally unique returned handle and refuses every ambiguous row.

## Historical coverage required for the reported traders

The individual AUM route currently returns honest but non-drawable history for both traders shown in Genie:

| Trader | Window | Usable numeric points | Missing points | Service verdict |
| --- | ---: | ---: | ---: | --- |
| `gmgn_0x03703d46` | 1D | 1 | 0 | `warming` |
| `gmgn_0x03703d46` | 7D | 1 | 6 | `too_few_points` |
| `gmgn_0x03703d46` | 30D | 1 | 28 | `too_few_points` |
| `gmgn_0x03703d46` | All | 1 | 30 | `too_few_points` |
| `gmgn_0x0fa3a520` | 1D | 1 | 0 | `warming` |
| `gmgn_0x0fa3a520` | 7D | 2 | 5 | `too_few_points` |
| `gmgn_0x0fa3a520` | 30D | 2 | 27 | `too_few_points` |
| `gmgn_0x0fa3a520` | All | 2 | 29 | `too_few_points` |

The missing historical points are returned with `refused: chains_unrebuildable`.

Required behavior:

- Keep returning `drawing.drawable: false` until the service has enough truthful points. Genie must obey that explicit verdict.
- Repair or extend chain history coverage so these traders eventually receive enough verified or explicitly rebuilt points for the service itself to return `drawing.drawable: true`.
- Do not replace missing history with zero, forward-fill it, interpolate it, or label locally inferred values as sampled.
- Ensure the batch response and individual response return the same AUM truth for the same trader and window.

## Required thesis-verification contract

Recommended server-to-server API:

```http
POST /v1/trader-claims/verify
Content-Type: application/json
Authorization: Bearer <Genie server credential>

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

Required behavior:

1. Resolve `traderId` as the stable Fomo directory ID, not a handle.
2. Match the exact challenge as a standalone token after documented whitespace normalization.
3. Accept only a thesis authored by that same stable Fomo ID.
4. Accept only a thesis published at or after `notBefore`.
5. Return `verified: false` without leaking unrelated private thesis data when no match exists.
6. Return stable evidence sufficient for Genie's audit log.
7. Authenticate this route for server-to-server use and rate-limit it.

The API does not decide which Genie user or agent receives the claim. Genie owns the challenge binding and performs the final transaction.

## Genie claim requirements

Genie must:

1. Generate at least 128 bits of cryptographically random challenge entropy.
2. Store only a hash of the challenge where practical.
3. Bind it to exactly one authenticated `user_id`, one `agents.id`, one local imported-profile ID, and one Fomo `service_id`.
4. Expire it after 30 minutes by default.
5. Permit only one successful use.
6. Recheck that the Genie agent is still owned by the requesting user before committing.
7. Enforce one active claim per imported Fomo profile.
8. Preserve stable profile history and copy relationships after the claim.
9. Record thesis ID, publication time, evidence hash, verification time, and request ID for audit.
10. Require a new proof and an explicit transfer policy for any later ownership change.

## Ownership split

| Work | Genie | Genie-Fomo API |
| --- | :---: | :---: |
| Mint and retain local imported-profile ID | Yes | No |
| Mint and own Genie `agents.id` | Yes | No |
| Store user-to-agent ownership | Yes | No |
| Return stable Fomo trader ID | No | Yes |
| Resolve Fomo ID consistently on AUM routes | No | Yes |
| Consume the current reduced AUM response using unique-handle safeguards | Yes | No |
| Return complete, identity-safe batch AUM | No | Yes |
| Produce truthful historical AUM and drawability | No | Yes |
| Return complete, identity-safe portfolio and positions | No | Yes |
| Preserve asset quantity, valuation provenance, coverage, and pagination | No | Yes |
| Generate and bind claim challenge | Yes | No |
| Prove a thesis was authored by a stable Fomo ID | No | Yes |
| Consume challenge and attach profile to agent | Yes | No |
| Provision credits, secrets, or sandbox after claim | Yes | No |

## Acceptance tests

### Genie compatibility acceptance, before the API expansion

1. A reduced handle-only batch maps a row only when the returned handle matches exactly one requested `service_id` and one local profile in the frozen snapshot.
2. At least three valid provider points produce a chart labeled `Partial provider history`.
3. A duplicate, missing, unknown, ambiguous, or renamed-but-unrefreshed returned handle is refused rather than attached to a profile.
4. A reduced response with one or two usable points remains an insufficient-history state.
5. When `drawing.drawable: false` is present, Genie does not draw even if three numeric points exist.
6. Missing rich fields remain unknown; Genie does not synthesize basis, coverage, reach, gaps, refusal reasons, or provider drawability.
7. A null point breaks the line and never becomes zero.
8. A capped, short, extra-row, or count-mismatched batch cannot replace an existing good cache entry.

### Permanent contract and product acceptance

1. A stable opaque ID from `GET /v1/traders?include=wallets` works on `GET /v1/traders/:id/aum`.
2. A batch containing stable provider IDs returns the same canonical IDs.
3. Two traders sharing the same folded handle remain distinguishable by ID.
4. For each successful row, `row.aum` deep-equals the individual AUM response for the same ID and window, apart from request metadata.
5. All four windows work: `1d`, `1w`, `1m`, and `all`.
6. A 50-ID request returns `asked: 50`, `capped: false`, and 50 explicit results.
7. Unknown IDs produce explicit row-level failures and do not remove successful rows.
8. Null totals, gaps, coverage, tiers, basis, refusal reasons, and drawing verdicts survive unchanged.
9. `X-Cost-Units`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `RateLimit-Scope` are present.
10. The two reported traders become drawable only after their returned history genuinely satisfies the service's own drawing rules.
11. Re-importing an unchanged directory mints no new local profile IDs.
12. Renaming a Fomo handle preserves both the Fomo ID and local imported-profile ID.
13. A handle collision never merges two profiles or maps one trader's AUM onto another.
14. A thesis with the right phrase but the wrong stable author ID cannot claim the profile.
15. A thesis containing an expired, previously used, or differently bound challenge cannot claim the profile.
16. A valid thesis challenge links the imported profile to the selected, still-owned Genie agent exactly once.
17. Claiming preserves imported history, followers, and existing copy relationships.
18. Individual portfolio and positions routes accept the same stable provider ID as AUM.
19. A 50-trader positions batch returns 50 identity-matched success or failure rows.
20. Every asset keeps chain, token address, amount, valuation provenance, timestamps, and `whyNoPrice`.
21. Paged or capped assets are visibly incomplete and never presented as the entire portfolio.
22. Two coins sharing a symbol but not `(chain, token address)` remain distinct.
23. A claimed profile shows `Fomo record` and `Genie portfolio` separately and never adds them together.
24. Fomoscan or another fallback cannot replace Genie-Fomo history, identity, quantities, or claim evidence.

## Consumer rollout

### Phase 1: Genie compatibility path, without waiting for the API expansion

1. Save the current real reduced batch response as a contract fixture.
2. Update #168's decoder to accept that projection and join only on a locally unique returned handle.
3. Preserve exact provider points and add the conservative chart rule and partial-history label.
4. Run Genie's AUM consumer, cache, collision, omission, and type checks.
5. Land the #123/#168 commits into `feat/fomo` and verify them on an isolated port before changing the shared testing app.
6. Restart the local application on port 4536 only through the designated landing flow and without replacing its data.
7. Verify the For You card and trader profile for all four windows. Expect traders with fewer than three usable points to remain chartless.

### Phase 2: Permanent API contract

1. Save one real identity-safe success response and one mixed success/failure response as fixtures.
2. Switch Genie's decoder to canonical-ID mapping and the provider's full AUM envelope.
3. Remove the handle-only compatibility bridge after deployment coverage is confirmed.
4. Re-run the chart, identity, cache, and runtime checks for all four windows.
5. Add the claim tables and server-side challenge flow without provisioning unowned platform agents.
6. Integrate the deployed Fomo thesis-verification contract.
7. Verify a full test claim and all replay, expiry, wrong-author, and double-claim failures.

## Not acceptable

- Treating a handle-only row as permanent identity, or accepting it when the handle is not locally unique.
- Returning asset rows without canonical trader identity, coverage, or completeness.
- Dropping unpriced assets or converting their unknown value to zero.
- Combining a Fomo record with a Genie agent's live portfolio.
- Treating Fomoscan as the primary trader-data provider.
- Silently replacing Genie-Fomo AUM or quantities with fallback data.
- Treating a handle as proof of identity or ownership.
- Claiming an account from a fixed phrase without a unique, short-lived challenge.
- Creating hundreds of ownerless platform agents with credits, keys, or sandboxes during directory import.
- Replacing the local imported-profile ID with either `agents.id` or the Fomo `service_id`.
- Making Genie reconstruct or interpolate trader balance history.
- Drawing from one or two points, drawing through missing/null buckets, overriding an explicit `drawing.drawable: false`, or calling compatibility data full-window coverage.
- Silently dropping a trader from a batch.
- Accepting a successful batch whose rows cannot be mapped one-to-one by canonical ID or the temporary unique-handle rule.
- Declaring the API complete while the individual and batch routes return different AUM truth.
