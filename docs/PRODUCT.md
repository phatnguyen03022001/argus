# Product

## Objective

Argus is an operator-local control plane and engineering workspace. It gives one operator a coherent view of repositories, Git state, task authority, provider resources, local workspaces, and Argus-owned working records without becoming a second source of truth for systems that already own their state.

Argus must make current evidence, freshness, ownership, authority, capability availability, and required attention explicit enough that later controlled actions can fail closed instead of guessing. Confirmed product truth is projected back into the relevant target repository; secret values remain outside ordinary Argus data.

## Reality-baseline

Phase 0 starts from a deliberately minimal repository. GitHub remote state is canonical repository truth, topology is `MAIN_ONLY`, and `main` is the only canonical branch. The repository currently authorizes foundation documentation only. There is no runtime source tree, dependency manifest, deployment surface, framework selection, database selection, provider integration, or execution engine to preserve as accidental architecture.

This absence is intentional evidence: Phase 0/1 may define semantic boundaries required for later implementation, but it must not preselect implementation mechanics that belong to Phase 2 or later.

## Product-boundary

Argus is local software for a single operator. It may observe and reconcile external engineering state; maintain explicit Argus-native working records; resolve non-secret credential references through the operating-system secret store; derive explainable health and attention views; and, in later authorized phases, perform controlled promotions or mutations through semantic capabilities.

Argus is not an authoritative mirror of GitHub, target repositories, local Git, provider APIs, or agent-* repositories. It is also not the canonical home of accepted target-product requirements. A cached or indexed copy exists to improve local operation, not to acquire ownership.

## ACT-001 Operator

The operator is the human who owns the local Argus workspace, decides when app-native working records become accepted product truth, supplies or references valid external authority, and initiates or approves consequential actions according to the relevant target authority.

## ROL-001 Operator-role

The operator role may inspect Argus-native state and observed external state, manage Argus-owned working records, request refreshes, inspect derived health/attention reasons, initiate explicit promotions, and initiate controlled mutations only when the action separately has sufficient authority and capability.

Possession of a credential, local machine access, or availability of an execution adapter does not itself authorize mutation.

## Product-capabilities

The foundation defines these semantic product capabilities without implementing them:

1. **Observe and reconcile external state.** Resolve deterministic target identity, obtain source evidence, preserve provenance, evaluate freshness/availability, and expose conflicts instead of flattening them.
2. **Maintain Argus-native working state.** Persist operator-owned records with explicit schema, migration, backup/export, restore, and lifecycle guarantees independent of storage technology.
3. **Expose explainable health and attention.** Derive views from current observations, provenance, freshness, policy, and explicit operator-owned state. Reasons and inputs remain inspectable.
4. **Operate usefully offline.** Read Argus-owned durable records and persisted last-known observations while clearly marking external evidence stale or unavailable. Live-precondition actions fail closed.
5. **Resolve secret references safely.** Store only non-secret references/metadata in Argus; secret values remain owned by macOS Keychain.
6. **Promote accepted requirements to product truth.** Move accepted decisions/requirements from app-native working state into the relevant target repository through a traceable controlled boundary.
7. **Describe controlled mutations.** Bind exact target identity, expected prior state, authority, capability, intended change, verification, and audit evidence before any later runtime may perform an external mutation.

## Truth-ownership

Argus recognizes exactly four truth classes:

| Class | Canonical owner | Argus may persist | Argus may mutate |
| --- | --- | --- | --- |
| `EXTERNAL_DERIVED_TRUTH` | The observed source: GitHub, target/agent repositories, local Git, provider APIs, or another external system | Provenance-bearing observations and caches needed for local/offline views | Only through a separately authorized controlled mutation; cached copies never become source truth |
| `APP_NATIVE_TRUTH` | Argus | Durable operator-owned working records, audit evidence, promotion links, schema metadata, and other explicitly Argus-owned state | Yes, through Argus-native lifecycle rules and audit requirements |
| `SECRETS` | macOS Keychain | Non-secret credential references and descriptive metadata only | Secret lifecycle is performed through the Keychain boundary; secret availability is not action authority |
| `CONFIRMED_PRODUCT_TRUTH` | The relevant target repository after acceptance/promotion | Traceability links and observations of the canonical repository artifact | Argus may only change it through target-authorized repository mutation; Argus never remains the sole canonical owner |

The classes are intentionally non-overlapping. A record can reference another class without changing ownership. For example, an app-native requirement may reference an external repository and a Keychain credential reference; once promoted, the accepted product decision is canonical in the target repository while Argus retains only working history and traceability.

## Scope

The current closed-world milestone is **Phase 0 Reality baseline + Phase 1 Vision and ownership closure**. It freezes product boundary, truth ownership, deterministic identity, observation/reconciliation semantics, derived health/attention, offline behavior, app-native durability, secret and audit boundaries, transport-independent capabilities, requirement promotion, controlled-mutation semantics, future testing boundaries, and the milestone program.

`VISION LOCK` means those foundation semantics are stable enough to begin Phase 2 without a blocking design unknown. It does not mean implementation technology is selected.

The Engineering MVP includes completion through Phase 5 only:

`Phase 0 Reality baseline -> Phase 1 Vision + ownership closure -> VISION LOCK -> Phase 2 Local workspace foundation -> Phase 3 Git / repo control -> Phase 4 Environment + secrets -> Phase 5 Providers + resources -> ENGINEERING MVP`.

Phase 6 and later authority/task projection, agent execution, business workflow, automation, and analytics are outside the Engineering MVP.

## Non-goals

Phase 0/1 explicitly does not authorize or choose:

- a `dev` or `staging` branch;
- runtime implementation or executable behavior;
- UI framework, Tauri, ORM, database engine, MCP transport, provider SDK, agent framework, queue, workflow engine, or orchestrator;
- cloud or multi-user control-plane architecture;
- a duplicated GitHub/repository/provider source of truth;
- a replacement secret vault;
- autonomous destructive mutation, force mutation, or hidden side effects;
- a durable offline external-mutation queue;
- SF/business workflow implementation, analytics implementation, or Phase 2+ functionality;
- generated program/DAG/registry machinery or framework-shaped abstractions justified only by hypothetical scale.

## Domain-and-external-constraints

- GitHub remote state is canonical repository truth for repositories governed through GitHub.
- Canonical source IDs and immutable revisions outrank display names, mutable branch tips, and local paths when stronger identity exists.
- macOS Keychain owns secret values. Ordinary persistence, repository artifacts, logs, exports/backups, and audit payloads must exclude them.
- External systems can be unavailable, stale, partially observed, or concurrently changed. Argus must represent those states rather than infer freshness or success.
- The operator-local product must remain useful without network access for Argus-owned data and persisted last-known observations, while live-precondition actions remain disabled.
- External mutation authority is source-specific and target-specific. Capability availability and credentials never manufacture authority.
- Technology choices intentionally deferred by this milestone must be selected only when their implementation phase begins and only if they preserve these frozen semantic boundaries.
