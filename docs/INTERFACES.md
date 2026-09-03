# Interfaces

## Capability-contracts

Argus defines semantic interfaces before selecting transports. Every request identifies the semantic capability, canonical target/subject identity, required evidence, and caller intent. Every result reports semantic outcome and evidence independently of connector, command, SDK, MCP, IPC, or protocol mechanics.

Observation and action interfaces use canonical identities from `DATA`. A transport may provide stronger immutable source identifiers; those are normalized into the domain identity rather than exposed as a new product contract.

Authority is never implicit in an interface handle. A caller that can invoke an adapter still must supply or resolve the separate authority required by the requested action.

## IFC-001 Observation-capability

The observation contract accepts a canonical subject identity plus an observation kind and returns either usable source evidence or an explicit availability failure. A successful result includes source identity, subject identity, source version/revision evidence when available, value/evidence, `observed_at`, and confidence/provenance inputs sufficient for source-specific freshness evaluation.

Read retries may occur only when they preserve observation semantics and remain bounded. An unavailable source does not cause a synthetic fresh observation.

## IFC-002 Controlled-mutation-capability

The mutation contract accepts an already-bound mutation envelope containing exact target identity, expected prior state, authority reference, required capability identity, intended bounded change, preview/diff identity where meaningful, and verification requirement.

The adapter returns attempt outcome plus external result identity/evidence. It does not decide that authority exists, widen the mutation, force through drift, or declare product success merely from a transport-level success response. The caller verifies the canonical postcondition separately.

## IFC-003 Requirement-promotion-contract

The promotion contract binds one stable app-native requirement/decision to one exact target repository and canonical destination. It requires expected target prior state, bounded proposed materialization, repository mutation authority, resulting immutable commit/artifact identity, postcondition verification, and a durable promotion/audit link.

The verified repository artifact becomes `CONFIRMED_PRODUCT_TRUTH`. The original Argus working record remains historical `APP_NATIVE_TRUTH`, not an alternate canonical product specification.

## IFC-004 Secret-resolution-contract

The secret-resolution contract accepts a non-secret credential reference and the specific external operation context. It resolves secret material only through macOS Keychain at execution time and exposes the minimum runtime value needed by the authorized adapter.

Secret values are not returned to ordinary persistence, logs, repository artifacts, backups/exports, audit payloads, or product-domain records. Resolution success proves credential availability only; it does not prove action authority.

## Command-and-job-semantics

The Engineering MVP does not define a generic job engine or durable external-mutation queue.

- Observation refreshes are bounded semantic read operations. Duplicate refreshes may create additional provenance-bearing observations but must reconcile deterministically.
- App-native writes use stable record identity and expected record version/state so retries cannot silently overwrite concurrent operator changes.
- External mutations are explicit commands with exact preconditions. Blind automatic retries are forbidden unless the source operation is proven idempotent for the same bound intent and the retry cannot bypass fresh precondition/postcondition requirements.
- Offline mode does not persist a command for later hidden execution. The operator must initiate a new action after live preconditions can again be proven.
- Long-running provider behavior, if introduced later, must remain represented as a source-specific capability result/status rather than requiring a generic workflow orchestrator.

## External-dependencies

The catalog contains the material dependency inventory. This document owns their behavioral assumptions and failure/exit semantics.

## EXT-001 GitHub-and-target-repositories

GitHub and target repositories own repository state and confirmed product truth. GitHub remote refs/objects are canonical repository evidence when GitHub is the repository host. Argus may observe, index, and later perform target-authorized mutations, but cached repository state never outranks the canonical remote.

## EXT-002 Local-Git-and-workspaces

Local Git and filesystem workspaces provide operator-local execution evidence and working copies. A local path is not canonical repository identity. Local dirty/ahead state may contain operator-owned work and must not be reset, adopted, or published merely because Argus discovers it.

## EXT-003 Provider-APIs-and-resources

Provider APIs own provider resource state. Argus observes provider-issued resource identities and state through source-specific adapters. Provider response schemas, SDKs, pagination, rate limits, and authentication mechanics remain adapter concerns; source unavailability or quota failure degrades the observation/action capability rather than changing truth ownership.

## EXT-004 macOS-Keychain

macOS Keychain is the secret-value owner for the operator-local product. Argus persists references/metadata only and resolves secret values at the narrow execution boundary that requires them. No fallback ordinary secret store is part of the foundation.

## Data-exchange-and-trust

External payloads are treated as untrusted observations until canonical identity and expected semantic shape are validated. Adapter normalization must preserve source evidence needed for provenance and must not silently coerce malformed, partial, stale, or ambiguous data into healthy state.

Outgoing mutation data is bounded to the exact authorized target and intended change. Secret material is injected only at the adapter boundary and excluded from diagnostic/audit serialization. App-native identifiers and target canonical identifiers remain distinct even when linked in one operation.

## Dependency-failure-and-exit

- If GitHub/target repository evidence is unavailable or drifts from the expected identity, repository-dependent mutations fail closed; persisted observations remain readable with degraded freshness/availability.
- If local Git/workspace state conflicts with canonical remote evidence, Argus surfaces the divergence and protects unknown local work rather than auto-resetting it.
- If a provider is unavailable, quota-limited, or returns unverifiable state, affected provider observations/actions degrade or fail without inventing success.
- If Keychain cannot resolve a credential reference, the secret-dependent capability is unavailable and no secret fallback is read from ordinary storage.
- Replacing one adapter or SDK is an implementation change as long as the semantic capability/evidence contract remains intact. Exiting an external provider must preserve Argus-owned records and deterministic references needed to explain historical observations/audit evidence.
