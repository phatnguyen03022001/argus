# Decisions

## Material-decisions

These decisions close Phase 0/1 semantics. The catalog owns decision IDs, short outcomes, and reversibility; this document owns context, alternatives, rationale, and consequences.

## DEC-001 Operator-local-control-plane

**Context.** Argus needs to unify engineering visibility without competing with existing repositories/providers. Alternatives were a cloud/multi-user control plane, an authoritative mirror, or an operator-local control plane that observes canonical sources.

**Rationale.** The operator-local boundary is the smallest design that supports the current objective while keeping GitHub/target/provider truth canonical and avoiding distributed identity, tenancy, and synchronization problems before evidence requires them.

**Consequences.** Local/offline behavior matters; external observations need freshness/provenance; later cloud/multi-user work would be a new product decision. The architecture choice is costly to reverse only if later product scope changes materially, not because a framework is locked now.

## DEC-002 Four-truth-class-ownership

**Context.** External observations, Argus working records, credentials, and accepted target requirements have materially different owners and recovery rules. Treating them as one database truth would duplicate SSOT or lose app-native data.

**Rationale.** Exactly four classes—`EXTERNAL_DERIVED_TRUTH`, `APP_NATIVE_TRUTH`, `SECRETS`, and `CONFIRMED_PRODUCT_TRUTH`—make ownership non-overlapping while still allowing traceable references across boundaries.

**Consequences.** Persistence cannot transfer ownership; cache loss and app-native loss have different severity; secret references are not secret values; promoted product truth becomes repository-owned. Changing this boundary later is costly because it affects data safety and mutation semantics.

## DEC-003 Deterministic-identity-and-reconciliation

**Context.** Display names, branch tips, paths, and timestamps are convenient but can retarget or conflict. Reconciliation and controlled mutation require stable targets and preserved evidence.

**Rationale.** Canonical source IDs and immutable SHAs/resource IDs are preferred whenever available. Observations retain source, subject identity, value/evidence, `observed_at`, freshness/availability/confidence inputs, and provenance; conflicts remain explicit.

**Consequences.** Adapters must normalize stronger source identity rather than invent aliases as primaries. Stale/unavailable/unknown/conflict states propagate into health and mutation gates. This semantic choice is costly to relax because weaker identity could corrupt traceability.

## DEC-004 App-native-durability-independent-of-storage

**Context.** Once Argus owns opportunities, client/requirement working records, audit evidence, or promotion links, their loss cannot be repaired by re-fetching GitHub/provider state. Selecting a database now would be premature.

**Rationale.** Freeze storage-independent guarantees—schema versioning, forward migration, pre-migration recovery, backup/export, staged restore, restore validation, corruption/failure handling, and cache separation—while deferring engine/ORM selection.

**Consequences.** Any later storage implementation must prove these guarantees. Derived caches stay disposable. Storage technology remains reversible while the durability contract is intentionally costly to weaken.

## DEC-005 Keychain-secret-ownership

**Context.** Argus needs credentials for external systems but ordinary app-native persistence, logs, exports, and audit evidence are broader surfaces than a platform secret store.

**Rationale.** macOS Keychain owns secret values; Argus stores only non-secret references/metadata and resolves values at the narrow adapter boundary.

**Consequences.** Backups/exports cannot restore secret values; missing Keychain items disable affected capabilities; credentials never grant action authority. Replacing Keychain ownership would be costly because it changes the security boundary.

## DEC-006 Transport-independent-capabilities

**Context.** Current/future execution may use GitHub connectors, Agent Runtime, local tools, provider clients, or MCP without those mechanisms being stable product concepts.

**Rationale.** Product/domain contracts describe semantic capabilities and evidence, with transports behind adapters. Capability availability is explicitly separate from action authority.

**Consequences.** Adapter replacement is local if semantics/evidence remain stable. A connector schema, SDK object, command invocation, or MCP message cannot become canonical product data. This choice is reversible in implementation detail but stable as a domain boundary.

## DEC-007 Fail-closed-controlled-mutation

**Context.** External systems can drift, partially fail, or return transport success without proving the intended target state. Generic command execution or offline queuing would hide these risks.

**Rationale.** Controlled mutation binds exact target, expected prior state, explicit authority, current capability, intended bounded change, preview where meaningful, durable audit intent, execution outcome, and verified postcondition. Missing/stale/unverifiable evidence blocks success.

**Consequences.** There is no broad destructive cleanup, force path, hidden autonomous side effect, generic orchestrator, or durable offline external-mutation queue in the Engineering MVP. This safety contract is costly to relax.

## DEC-008 Requirement-to-product-promotion

**Context.** Opportunity/client/requirement working state belongs in Argus, but accepted product decisions must become repository-authoritative so engineering does not depend on a private second specification.

**Rationale.** Requirements remain `APP_NATIVE_TRUTH` until explicit acceptance, then are materialized through a traceable repository mutation and verified immutable target identity.

**Consequences.** Argus retains source working history and promotion links, while the target repository becomes canonical for the accepted decision. Later changes observe/mutate the target truth instead of silently editing the old working record.

## DEC-009 Milestone-boundaries

**Context.** The product program spans engineering control-plane work, agent/task execution, later business workflow, automation, analytics, and hardening. Treating all of it as one MVP would create premature coupling.

**Rationale.** `ENGINEERING MVP` ends at Phase 5, `ENGINEERING V1` at Phase 7, and `BUSINESS V1` at Phase 10; the full Phase 0-14 order is persisted in `DELIVERY` only as sequencing intent.

**Consequences.** Phase 6+ authority/agent work cannot leak into Engineering MVP, and business/automation/analytics cannot justify Phase 0/1 framework choices. The sequence may be revised only through later target authority, not generated runtime orchestration.

## DEC-010 Implementation-technology-deferred

**Context.** Phase 0/1 has no runtime evidence requiring a UI framework, Tauri, ORM, database engine, MCP transport, provider SDK, agent framework, queue, or workflow engine.

**Rationale.** Selecting these now would convert reversible implementation choices into accidental architecture. Their semantic constraints and decision timing are already explicit in the owning documents, so they do not block Phase 2.

**Consequences.** Each implementation phase chooses only the technology it materially needs and verifies compatibility with frozen ownership, identity, durability, offline, secret, capability, and mutation contracts. Deferral is reversible and does not mean the design is unknown.

## Unknown-closure

There are no open Phase 0/1 `DESIGN` unknowns after these decisions and the eight authority-domain specifications are applied. In particular, ownership, identity, provenance/freshness, offline behavior, durability/recovery, secret handling, audit evidence, capability/authority separation, promotion, mutation safety, testing boundaries, and Engineering MVP scope are resolved enough to begin Phase 2 planning.

Implementation-local choices intentionally deferred by `DEC-010` are not hidden design blockers: their semantic constraints are frozen, and their decision time is the first authorized implementation phase that materially requires them. If later evidence reveals a contradiction in a frozen boundary, documentation closure reopens and target authority must resolve it before dependent consequential work proceeds.
