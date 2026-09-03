# Architecture

## SYS-001 Argus-local-control-plane

Argus is one operator-local system boundary. Its semantic responsibilities are:

- maintain Argus-owned durable working state;
- represent observations of external truth with deterministic identity, provenance, availability, and freshness;
- derive explainable health/attention views;
- expose semantic observation and mutation capabilities independent of transport;
- resolve only non-secret credential references through the platform secret boundary;
- preserve audit and promotion traceability;
- fail closed when authority, capability, identity, preconditions, or verification are insufficient.

Argus does not own the external systems it observes and does not become a proxy authority merely because it can reach them.

## Runtime-topology

The frozen topology is conceptual, not a framework selection:

`operator -> local Argus boundary -> semantic capability boundary -> source-specific adapters -> GitHub / target repositories / local Git / provider APIs`

A separate platform boundary resolves credential references from macOS Keychain. Argus-owned durable state and persisted external observations live locally under an implementation selected later. There is no cloud control plane, multi-user coordination service, central queue, shared registry, or always-on server required by the foundation.

Phase 0/1 does not define process layout, UI toolkit, database process, IPC mechanism, HTTP API, MCP server, background worker, or packaging model.

## Ownership-routing

Every material datum enters the architecture with an ownership class before persistence or mutation rules are applied:

- external source evidence -> `EXTERNAL_DERIVED_TRUTH` observation;
- explicit operator working record/audit/promotion trace -> `APP_NATIVE_TRUTH`;
- credential value -> `SECRETS`, resolved only through Keychain;
- accepted target-product decision -> `CONFIRMED_PRODUCT_TRUTH` in the target repository.

Adapters may translate transport data into semantic observations or execute already-authorized semantic actions. They may not redefine ownership, freshness, authority, or mutation policy.

## Communication-boundaries

The product-domain contract exchanges semantic requests/results using canonical identities and domain states. Transport-specific concerns such as GitHub connector schemas, Agent Runtime commands, local CLI arguments, future MCP messages, provider SDK objects, HTTP payloads, or process IPC are adapter details.

An adapter result must be normalized into one of two categories:

1. **observation result:** source identity, subject identity, source version when available, value/evidence, observation time, availability, and confidence inputs; or
2. **action result:** exact target identity, attempted intent, external result identity/evidence, and enough information to verify the required postcondition.

Transport errors never directly become product success or health states.

## Semantic-capability-boundary

A semantic capability answers **what can currently be observed or done** on a particular target class. Examples include `observe_repository_state`, `observe_provider_resource`, `resolve_secret_reference`, `preview_target_change`, and `apply_bounded_target_change`.

Capability availability is runtime evidence. Authority is a separate proof that a particular action is permitted. The product must require both when both are relevant. A credential is an input to some capability; it is not authority.

Future adapters may use GitHub connectors, Agent Runtime, local Git tools, provider clients, or MCP transports. The domain contract must remain valid if one adapter is replaced by another that provides equivalent semantics and evidence.

## Controlled-mutation-boundary

The architecture treats external mutation as a guarded boundary rather than a generic command bus. The domain layer must bind exact target identity, expected prior state, authority reference, required semantic capability, intended bounded change, and verification requirement before delegation to an adapter.

The adapter performs only the bound effect and returns evidence. The domain then verifies the postcondition against the canonical target. Cross-system atomicity is not assumed. A successful API response without required postcondition evidence is not product success.

There is no generic orchestrator, durable external mutation queue, automatic force path, or broad cleanup primitive in the Engineering MVP foundation.

## Failure-and-recovery-boundaries

- External source unavailability degrades observations but does not corrupt Argus-owned state.
- Local derived-cache loss is reconstructible and must not destroy app-native records.
- App-native persistence/migration failure blocks normal activation until the original or restored state is validated.
- Keychain unavailability blocks secret-dependent capabilities without causing secret fallback into ordinary storage.
- External drift invalidates mutation preconditions and requires re-observation.
- Audit intent must be durable before consequential side effects; outcome evidence may record partial/failed/unverifiable execution truthfully.

## Build-buy-defer

Foundation build/buy boundaries are deliberately narrow:

- GitHub, target repositories, local Git, provider systems, and macOS Keychain remain external owners; Argus integrates with them rather than reimplementing them.
- Argus owns its domain semantics, app-native working state, provenance/reconciliation model, derived views, promotion traceability, and controlled-mutation policy.
- Transport implementations and storage implementations are selected in their authorized later phases. No current evidence justifies a generic adapter framework, plugin registry, queue, workflow engine, or distributed service.

## Technology-deferrals

The following implementation choices are intentionally deferred and are not Phase 0/1 blockers because their semantic contracts are frozen here:

- UI framework and desktop shell, including whether Tauri is used;
- storage/database engine, schema toolkit, and ORM;
- concrete local process/IPC layout;
- GitHub/provider client libraries or SDKs;
- whether any capability is transported through MCP;
- agent framework or execution framework;
- packaging/update mechanism.

These choices are admitted only when the phase that needs them begins. They must preserve deterministic identity, ownership classes, offline/freshness behavior, Keychain secret ownership, recoverable app-native data, transport-independent capability semantics, and fail-closed controlled mutation.

## Security-trust-boundaries

The local OS/user session, Argus persistence, Keychain, target repositories, GitHub, local Git working state, provider APIs, and execution adapters are distinct trust boundaries. External data and adapter results are untrusted until bound to canonical identity and validated for the expected semantic shape. Secret values cross only the minimum runtime boundary needed for the specific external operation and must not be copied into logs, audit payloads, repository artifacts, ordinary persistence, or exports.
