# Data

## Truth-classes

The four truth classes define canonical ownership, not storage location.

| Class | Canonical owner | Local representation | Loss/recovery meaning |
| --- | --- | --- | --- |
| `EXTERNAL_DERIVED_TRUTH` | External source | Provenance-bearing observations and derived/cache views | Reconstructible from sources when available; loss must never delete Argus-owned truth |
| `APP_NATIVE_TRUTH` | Argus | Durable working records, audit evidence, promotion links, schema/lifecycle metadata | Must be recoverable by migration, backup/export, restore, and validation without relying on external reconstruction |
| `SECRETS` | macOS Keychain | Non-secret reference/metadata only | Secret recovery follows Keychain/operator mechanisms, never Argus backup contents |
| `CONFIRMED_PRODUCT_TRUTH` | Target repository | Promotion link plus later observations of canonical artifact/commit | Recoverable from target repository; Argus working copy is not canonical after promotion |

Persistence does not transfer ownership. A persisted external observation remains derived evidence; a repository-backed product decision remains repository-owned even when Argus indexes it.

## DAT-001 App-native-working-records

Durable Argus-owned records include explicit operator working state such as future opportunities, client cases, requirements before promotion, workspace metadata that Argus itself owns, and other records whose loss cannot be reconstructed from external systems.

Each record has a stable typed `record_id`, schema version, creation/update lifecycle metadata, and explicit relationships to canonical external identities rather than display names or paths alone.

## DAT-002 External-observation-ledger

A persisted observation record represents evidence about external truth; it does not own that truth. Each material observation contains at least:

- semantic observation identity;
- canonical source identity;
- canonical subject identity;
- observation kind;
- observed value/evidence or explicit absence;
- `observed_at`;
- source revision/version/ETag when available;
- source-specific freshness policy identity or parameters needed to evaluate it;
- availability semantics;
- confidence/evidence semantics;
- provenance linking the adapter/source evidence used.

Persisting last-known observations enables useful offline inspection. Derived indexes/caches around those observations may be discarded and rebuilt.

## DAT-003 Credential-references

Argus may persist only non-secret metadata such as a stable credential-reference ID, Keychain item/account/service locator that is safe to store, intended external system, and optional descriptive label. Secret bytes, tokens, passwords, private keys, refresh tokens, or equivalent credentials are never part of this entity.

## DAT-004 Audit-evidence

Audit evidence is `APP_NATIVE_TRUTH` for operator-significant Argus-native changes and controlled mutation attempts/results. A material record contains deterministic target identity, intent, authority reference, relevant pre-state identity, attempt time, outcome, post-state/postcondition evidence when available, and links to related app-native records or promotion records.

Audit payloads exclude secret values and do not copy entire external source objects when stable identities/evidence references are sufficient. Audit evidence proves what Argus attempted/observed; it never replaces the external source as canonical truth.

## DAT-005 Promotion-links

A promotion link connects an app-native requirement/decision to its canonical target-product materialization. It retains the source app-native record identity, exact target repository identity, target logical destination, resulting immutable commit/artifact identity, promotion time, and audit reference.

After verified promotion, the link points to `CONFIRMED_PRODUCT_TRUTH`; it does not authorize later edits from the pre-promotion working record.

## DAT-006 Health-attention-view

Health and attention are material ephemeral derived views. They are recomputed from current observations, freshness evaluation, policy, and explicit Argus-owned state. Persisted snapshots may be used for diagnostics, but a snapshot is not canonical health truth and cannot be treated as current without reevaluation.

## Deterministic-identity

Identity is a semantic tuple; physical encoding may be selected later but must preserve these components and comparison rules.

| Subject | Canonical semantic identity |
| --- | --- |
| Repository | source host/provider + immutable repository ID when the source exposes one; normalized owner/name is an alias, not stronger identity |
| Commit | repository identity + full immutable commit SHA |
| Mutable ref | repository identity + canonical full ref name; a particular observed ref state additionally records the resolved commit SHA and observation time |
| Task/revision | repository identity + canonical task path + task ID + task revision + immutable task blob/commit binding when available |
| Local workspace | immutable Argus workspace ID + associated canonical repository identity; filesystem path is mutable metadata only |
| External resource | provider/source identity + account/namespace identity where applicable + resource type + provider-issued immutable resource ID |
| App-native record | record type + immutable Argus-issued record ID; names/content are mutable attributes |
| Observation | source identity + subject identity + observation kind + source revision/version when available + observed-at snapshot identity |
| Promoted requirement | app-native requirement ID + exact target repository identity + resulting canonical artifact/commit identity; the repository artifact becomes canonical product truth |

When an authoritative source offers a stronger immutable identifier, Argus adopts it rather than inventing a competing primary identity. Display names, mutable branch tips, URLs that can retarget, and local paths alone are insufficient when stronger identity exists.

## Observation-provenance

Observations are append/preserve evidence. A current materialized view may point to one observation as currently preferred, but previous observations remain attributable until their configured local retention/lifecycle action explicitly removes them.

Provenance includes the external source, adapter/capability used, source version evidence when available, observation time, and canonical identities needed to reconstruct why the value was accepted. Confidence describes evidence quality, not optimistic probability: for example `AUTHORITATIVE_SOURCE`, `INFERRED`, or `UNKNOWN` may be implemented later as long as the semantics remain explicit and cannot upgrade unknown evidence silently.

## Freshness-reconciliation

Freshness is source-specific because different sources expose different change rates and version signals. Each observation kind has an explicit freshness policy chosen in the implementation phase that introduces that source. A policy may use immutable version evidence, source timestamps, TTL-style age bounds, or explicit invalidation events, but it must deterministically yield `FRESH`, `STALE`, or `UNKNOWN` at evaluation time.

Reconciliation follows these rules:

1. compare only observations for the same canonical subject and semantic observation kind;
2. prefer stronger canonical source/version evidence over aliases or locally inferred state;
3. within the same authoritative source/version lineage, a newer valid source version supersedes older versions for the current view; when only snapshot time exists, the later successful observation may become current while prior provenance is retained;
4. source unavailability does not overwrite the last successful value with a fabricated null/fresh value;
5. contradictory observations for the same authoritative identity/version yield `CONFLICT` unless stronger immutable evidence resolves the disagreement;
6. stale, unavailable, unknown, or conflicting required inputs propagate into derived health/attention and mutation preconditions rather than being hidden.

## Lifecycle-persistence

`APP_NATIVE_TRUTH`, audit evidence, promotion links, credential references, schema metadata, and persisted last-known observations survive normal application restarts. Derived caches/indexes may be discarded and rebuilt.

Every durable store has an explicit schema version. Writes that span multiple Argus-owned records and their required audit evidence must provide atomicity or an equivalent recoverable commit protocol within the chosen storage technology. No cross-system transaction with GitHub/provider systems is assumed.

## Retention-deletion

The Engineering MVP foundation has no automatic destructive TTL for `APP_NATIVE_TRUTH` or audit evidence. Operator-requested deletion must be explicit, scoped to deterministic identities, and itself auditable when operator-significant. Backups remain independent recovery artifacts until explicitly deleted by the operator.

Derived caches may be evicted at any time. Persisted observations may later adopt bounded retention once a source-specific implementation demonstrates the need, but retention must preserve the evidence needed for active audit/reconciliation obligations. Secret values are never retained by Argus at all.

## Consistency-transactions

Argus-owned mutations use expected record identity/version to avoid silent lost updates. External observations are never rewritten to pretend an external source changed atomically with Argus.

For a consequential external mutation, durable audit intent is committed before the side effect. The result is appended after the external attempt. If the side effect succeeds but outcome/audit completion or postcondition verification fails, the state remains explicitly partial/unverifiable and requires attention; Argus does not invent rollback or success.

## Schema-migration

Schema evolution is forward-migrated. Before a migration that can alter durable app-native representation, Argus creates or requires a recoverable pre-migration backup/export. Migration runs against a known source schema version and either produces a fully validated target schema or leaves the prior valid state recoverable.

A failed migration must not mark the new schema active. Unsupported future-schema data is rejected rather than silently downgraded. Restore imports carry schema version and may be migrated forward through supported steps before activation.

## Backup-restore-data

Backup/export includes all required `APP_NATIVE_TRUTH`, audit/promotion records, non-secret credential references, and enough schema/integrity metadata to validate restoration. It may include persisted observations as convenience/history, but external derived state remains reconstructible and non-authoritative.

Backup/export excludes secret values. Restore is staged and validated for schema compatibility, structural integrity, required identities/relationships, and record completeness before replacing or becoming active durable state. A failed validation leaves the restore inactive and preserves the previously valid state where possible.
