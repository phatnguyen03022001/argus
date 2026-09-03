# Quality

## Authentication

The Engineering MVP is operator-local and does not introduce a multi-user identity system. Access to the local application is bounded by the operator's macOS user/session and future platform packaging controls. Authentication to external systems uses credentials resolved from macOS Keychain through non-secret references.

External authentication proves identity to that external system only. It never substitutes for target-specific action authority inside Argus.

## Authorization-and-trust

Authorization is evaluated at the resource/action boundary. A consequential action must bind exact target identity, explicit authority reference, intended mutation, and expected prior state before any external side effect.

The operator, Argus-owned persistence, Keychain, GitHub/target repositories, local Git/workspaces, provider APIs, and adapters are separate trust boundaries. Capability availability, credential availability, observed state, freshness, health, and authority are separate facts. No one of them implies another.

## Secrets-and-sensitive-operations

Secret values, credentials, tokens, private keys, and equivalent material must never be persisted in ordinary app-native data, repository artifacts, logs, backups/exports, audit payloads, or derived observation caches. Only non-secret Keychain references/metadata may be durable in Argus.

Sensitive operations use redaction-by-construction: domain/audit objects do not contain secret fields, adapters receive secret values only at the narrow operation boundary, and failure diagnostics refer to credential identity/availability without echoing the value.

Destructive cleanup, force mutation, authority bypass, or hidden autonomous side effects are not foundation capabilities.

## Privacy-and-sensitive-data

Argus is local-first. App-native opportunity/client/requirement records may contain commercially or personally sensitive operator data in later phases, so ordinary exports/backups and local persistence must be treated as operator-sensitive even when they contain no credentials.

The foundation requires no cloud telemetry or external analytics. If later phases add analytics, that is a separately authorized product decision and must not silently upload app-native records or secret-adjacent metadata.

## Timeouts-retries-recovery

External reads and refreshes use bounded timeout/retry policies appropriate to each source. Retries must preserve semantic identity and cannot convert unavailable evidence into a fresh result.

External mutations are not blindly retried. A retry is permitted only when the same bound intent is proven idempotent or the source exposes a safe idempotency mechanism, and exact preconditions plus postcondition verification still hold. Ambiguous side effects require reconciliation/attention rather than repetition.

Recovery for app-native storage follows the migration/backup/restore rules in `DATA` and `DELIVERY`. Offline mode never becomes a hidden retry queue for external mutations.

## Concurrency-and-drift

Argus-owned writes use expected record identity/version or an equivalent optimistic concurrency guard. External mutations use expected canonical prior state. If either changes before the guarded write, the operation fails closed and must be reevaluated from fresh evidence.

No cross-system transaction is assumed. A partial external outcome is recorded and reconciled explicitly; concurrency pressure must not be hidden behind last-write-wins behavior that erases operator work or external drift.

## Performance-and-resources

Correctness and provenance outrank a faster stale answer. Derived indexes/caches may improve local responsiveness but are disposable and may never contain the only copy of Argus-owned truth.

External polling/refresh must be bounded and source-aware rather than continuous by default. The Engineering MVP requires no always-on cloud service, worker fleet, distributed cache, generic queue, or background orchestrator. Resource choices should remain proportional to a single-operator local control plane.

## Observability

Material operator-significant Argus-native changes and controlled mutation attempts/results produce audit evidence with deterministic identities, intent/authority reference, relevant pre/post identity, outcome, and time. Derived health/attention exposes reason codes and input identities/freshness so a degraded state can be explained.

Diagnostics distinguish source unavailable, stale, unknown, conflict, authority missing, capability missing, side-effect failed, and postcondition unverifiable. Logs/audit/diagnostics exclude secret values.

## Testing-evidence

Future runtime work must provide evidence at the boundary where the failure can occur:

- deterministic domain tests for repository/resource/task/workspace identity, source-specific freshness, reconciliation precedence/conflicts, and derived health/attention propagation;
- persistence tests for schema versioning, forward migration, pre-migration recovery, backup/export completeness, restore, restore validation, corruption/failure handling, and cache-loss independence from `APP_NATIVE_TRUTH`;
- contract tests for each semantic capability adapter, including normalization of unavailable/malformed/partial source responses and proof that transport mechanics do not leak into domain contracts;
- mutation safety tests against fixtures/fakes for exact identity drift, missing authority, missing capability, stale preconditions, failed/ambiguous side effects, idempotency boundaries, unverifiable postconditions, and secret-free audit evidence;
- requirement-promotion tests proving target materialization is verified before ownership is treated as `CONFIRMED_PRODUCT_TRUTH`;
- bounded integration tests for real Git/Keychain/provider boundaries when required to prove behavior mocks cannot establish;
- no destructive tests against operator production repositories, provider resources, credentials, or local workspaces.

Phase 0/1 adds documentation only; no runtime test harness is created by this task.

## Security-negative-scenarios

Security verification must prove at least these negative paths when the corresponding runtime appears: ordinary data/export/audit serialization cannot contain secret values; a valid credential with absent authority cannot mutate a target; an adapter with available capability cannot widen the requested target/change; stale target identity blocks mutation; malformed external identity cannot be accepted as canonical; and production-state destructive fixtures are not used as tests.

## Cost-and-usage

The foundation assumes no paid always-on service. Local computation and source calls should be bounded and observable. A later provider integration may incur source-specific cost, but capability availability and cost/quota evidence must be explicit; a cheaper path never justifies weaker identity, freshness, authority, secret handling, or verification.
