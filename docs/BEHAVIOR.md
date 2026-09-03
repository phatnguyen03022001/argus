# Behavior

## Semantic-behaviors

Argus behavior is evidence-driven and fail-closed. Reads may use persisted observations when their provenance and freshness state are shown. Consequential writes require exact target identity, explicit authority, current capability, verified preconditions, and postcondition evidence. Unknown, stale, unavailable, or conflicting evidence is never silently converted into a healthy or successful state.

## Observation-state-model

A material external observation has separate availability and freshness semantics.

- `AVAILABLE` means the source supplied usable evidence for the requested subject.
- `UNAVAILABLE` means the source could not currently supply it.
- `UNKNOWN` means Argus has insufficient evidence to classify availability.
- `FRESH` means a source-specific freshness policy still accepts the observation at evaluation time.
- `STALE` means a previously usable observation has exceeded that policy or a known invalidating event occurred.
- `UNKNOWN` freshness means the system cannot prove the observation is fresh or stale.
- `CONFLICT` is a reconciliation result when authoritative evidence that should agree does not agree and no stronger canonical evidence resolves it.

Availability and freshness are not aliases. A source can be unavailable while a persisted last-known observation exists, and that observation can be stale or freshness-unknown.

Later observations may supersede the current view only according to the reconciliation rules in `DATA`; they do not erase prior provenance.

## Behavioral-invariants

1. External observation never changes the canonical owner of the observed truth.
2. Mutable display names, branch tips, or local paths do not replace stronger canonical identities.
3. Freshness is evaluated from explicit source policy and observation evidence, not from UI recency alone.
4. Derived health/attention is recomputable from inspectable inputs and is not mutable source truth.
5. Credentials, adapter availability, and action authority remain independent predicates.
6. A mutation cannot report success until its required postcondition is verified.
7. A failed or unverifiable mutation records the truthful partial outcome and does not fabricate rollback or success.
8. Offline mode never queues a hidden durable external mutation for later execution.
9. Promotion does not leave Argus as the sole canonical owner of accepted product truth.

## Derived-health-and-attention

Health and attention are deterministic views over current observations, provenance, freshness, explicit policy, and Argus-owned operator state.

A derived result contains at least a state, reason codes, the identities of relevant inputs, and their freshness/availability summary. A healthy result is permitted only when every input required by that health policy is available and sufficiently fresh. Stale, unavailable, unknown, or conflicting required evidence yields a corresponding non-healthy/unknown/attention state rather than an optimistic default.

Attention may indicate a condition that requires operator inspection, refresh, recovery, or a later authorized action. It never creates an implicit task, queue, mutation authorization, or autonomous side effect.

## Offline-semantics

When external connectivity is unavailable:

- `APP_NATIVE_TRUTH` remains readable and editable according to its local lifecycle rules.
- persisted last-known observations remain readable with their original provenance and a currently evaluated stale/unknown/unavailable indication;
- derived views are recomputed from those explicitly degraded inputs;
- refresh operations report unavailability rather than rewriting last-known evidence as fresh;
- operations requiring live target identity, current preconditions, credential resolution, or postcondition verification fail closed before the external side effect;
- no durable deferred external-mutation queue is created in the Engineering MVP.

## Requirement-promotion

Opportunity/client/requirement working state is `APP_NATIVE_TRUTH` until the operator explicitly accepts a requirement for a target product.

Promotion requires a stable app-native requirement identity, exact target repository identity, target destination/anchor semantics, authority for the repository change, expected target prior state, a bounded preview/diff when meaningful, successful repository materialization, exact resulting commit/artifact identity, and durable promotion/audit evidence.

Only after the target repository change is verified does the accepted product decision become `CONFIRMED_PRODUCT_TRUTH`. Argus may retain the original working record and a promotion link for history, but the target repository becomes canonical for the accepted decision. Later product changes must observe or mutate that repository truth rather than silently editing the old working copy as if it remained canonical.

## Controlled-mutation

A controlled mutation is a future semantic contract, not runtime behavior in Phase 0/1. The complete pre-effect gate is:

1. resolve exact target identity;
2. resolve expected prior state/preconditions from sufficiently fresh authoritative evidence;
3. resolve an explicit authority reference that permits the intended mutation;
4. prove the required semantic capability is currently available;
5. bind the intended bounded change and preview/diff when meaningful;
6. persist durable audit intent containing no secret values before performing a consequential external side effect.

After execution, Argus records the execution outcome and independently verifies the required postcondition. Drift, missing authority, missing capability, stale/unknown preconditions, failed side effect, or unverifiable postcondition prevents a success result. Blind retries, force mutation, broad destructive cleanup, and hidden autonomous side effects are outside the contract.

## Failure-semantics

| Scenario | Required behavior |
| --- | --- |
| Fresh authoritative observation | Use it in the current view and retain provenance |
| Stale persisted observation | Show last-known value as stale; never label it fresh/healthy |
| Source unavailable | Preserve last-known observation if present; mark source unavailable and block live-precondition writes |
| Conflicting authoritative evidence | Surface `CONFLICT`, identify competing evidence, and block affected health/mutation decisions until resolved |
| Cache loss | Rebuild derived/external views when sources return; never lose `APP_NATIVE_TRUTH` |
| App-native migration failure | Leave original durable state recoverable, stop opening the migrated store as successful, and require recovery/restore handling |
| Restore validation failure | Reject the restore as active state; preserve evidence and current valid state where possible |
| Missing Keychain secret | Report credential unavailable; do not read a secret from backups/logs/config and do not infer authority |
| Exact target identity drift | Reject the mutation and require fresh observation/preview/authority evaluation |
| Missing authority | Reject before side effect even if adapter and credentials are available |
| Missing capability | Reject before side effect even if authority exists |
| Failed external side effect | Record failed attempt; do not report success |
| Unverifiable postcondition | Record outcome as unverifiable/attention-required; do not report success |
| Audit persistence unavailable before consequential side effect | Reject the mutation before the side effect |

## Critical-flows

The catalog identifies four material Phase 0/1 flows. They specify semantics only; no runtime workflow engine is implied.

## FLW-001 Observe-and-reconcile

Resolve source and subject identity, acquire source evidence when available, create a provenance-bearing observation, evaluate source-specific freshness, reconcile it with prior observations, then derive explainable health/attention. Source failure preserves last-known evidence but degrades availability/freshness truthfully.

## FLW-002 Promote-requirement

Resolve the app-native requirement and exact target repository, preview the proposed canonical product change, prove authority/capability/preconditions, apply the repository mutation in a later authorized phase, verify the resulting target identity, then persist promotion and audit evidence. Canonical product ownership transfers to the repository only after verification.

## FLW-003 Controlled-external-mutation

Resolve exact target and expected prior state, prove authority and capability, persist audit intent, execute exactly the bounded change, verify postcondition, and record outcome. Any stale or unverifiable gate fails closed.

## FLW-004 Offline-inspection

Load Argus-owned durable records and persisted last-known observations without requiring network access, reevaluate freshness at the current time, derive degraded but explainable views, and disable actions whose live preconditions cannot be proven.

## Foundation-acceptance

Phase 0/1 is behaviorally closed only when the documented scenarios distinguish fresh, stale, unavailable, unknown, and conflicting evidence; preserve offline readability; separate cache loss from native data loss; define migration/restore failures; enforce the Keychain boundary; keep health/attention explainable; and fail closed for requirement promotion and controlled mutation when identity, authority, capability, preconditions, side effects, postconditions, or audit evidence are invalid.

## Human-control

The operator remains the decision owner for accepting working requirements into product truth and for initiating consequential actions within target authority. Argus may recommend attention or present a preview, but it does not turn attention into an action, silently widen scope, force a target update, bypass a target repository, or perform destructive cleanup because an adapter can technically do so.
