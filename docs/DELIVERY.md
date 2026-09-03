# Delivery

## Environments-and-configuration

Phase 0/1 is documentation-only. Repository topology remains `MAIN_ONLY` with `main`; there is no `dev` or `staging` branch and no runtime environment/configuration surface in this milestone.

The product baseline is operator-local macOS. Future runtime configuration must distinguish ordinary non-secret settings from Keychain credential references. Secret values are never placed in repository configuration, environment templates committed to the repository, ordinary Argus persistence, or backups/exports.

Concrete packaging, process layout, storage engine, and provider configuration are selected only in the authorized phase that needs them.

## Milestone-program

The agreed milestone sequence and named boundaries are exactly:

1. `PHASE 0 Reality baseline`
2. `PHASE 1 Vision + ownership closure`
3. `VISION LOCK`
4. `PHASE 2 Local workspace foundation`
5. `PHASE 3 Git / repo control`
6. `PHASE 4 Environment + secrets`
7. `PHASE 5 Providers + resources`
8. `ENGINEERING MVP`
9. `PHASE 6 Authority + task projection`
10. `PHASE 7 Agent execution + continuity`
11. `ENGINEERING V1`
12. `PHASE 8 SF opportunity/client workspace`
13. `PHASE 9 Requirement/scope/commercial control`
14. `PHASE 10 Client project -> engineering -> delivery`
15. `BUSINESS V1`
16. `PHASE 11 Templates + project onboarding`
17. `PHASE 12 Controlled mutations/automation`
18. `PHASE 13 Analytics + governance learning`
19. `PHASE 14 Hardening`

`ENGINEERING MVP` ends after Phase 5. `ENGINEERING V1` ends after Phase 7. `BUSINESS V1` ends after Phase 10.

This is sequencing authority, not an execution DAG. Each later phase depends on the stable semantic boundary produced by earlier required phases, but task decomposition, exact implementation order inside a phase, retries, scheduling, and execution status remain outside this program text.

## Milestone-intent

- **Phase 0** establishes actual repository/external reality and prevents imagined implementation from becoming authority.
- **Phase 1** freezes product ownership, data, identity, reconciliation, durability, interfaces, safety, and milestone scope; `VISION LOCK` opens implementation planning.
- **Phase 2** implements the smallest local workspace foundation consistent with the frozen operator-local model.
- **Phase 3** adds repository/Git observation and control around canonical identity and divergence safety.
- **Phase 4** implements environment boundaries and Keychain-based secret handling without creating a secret vault.
- **Phase 5** integrates provider/resource observation/control boundaries needed for the foundation control plane, completing `ENGINEERING MVP`.
- **Phase 6** projects existing authority/task truth; it does not retroactively expand the Engineering MVP.
- **Phase 7** adds agent execution/continuity under explicit authority, completing `ENGINEERING V1`.
- **Phases 8-10** add opportunity/client, requirement/commercial, and client-delivery workflows, completing `BUSINESS V1`.
- **Phases 11-14** add reusable onboarding/templates, separately controlled automation/mutations, analytics/governance learning, and hardening only after their prerequisite product surfaces exist.

Later milestone names do not pre-authorize their implementation.

## Migration-and-rollback

Documentation-only Phase 0/1 requires no runtime migration. Future app-native schema changes are forward migrations from an identified source schema to a target schema with a recoverable pre-migration backup/export and validation before activation.

A migration failure leaves the prior valid state recoverable and does not mark the new schema active. Rollback of application/runtime versions must not silently open a newer unsupported schema; compatibility must be checked explicitly. External side effects are not assumed reversible merely because local state can roll back.

## Backup-and-restore

Backup/export is an explicit operator recovery boundary for `APP_NATIVE_TRUTH`, audit/promotion records, non-secret credential references, and schema/integrity metadata. Derived caches are optional because they are reconstructible. Secret values are always excluded.

Restore is staged, schema-checked, integrity-checked, and relationship-validated before activation. Supported older backups may be migrated forward through explicit steps. An invalid/corrupt/unsupported restore is rejected without replacing a known-valid active state where possible. Restore success must be verified by reopening/reading the restored logical records and their required identities, not merely by copying bytes.

## Compatibility-and-platform

The current platform constraint is operator-local macOS with macOS Keychain as secret owner. No cloud/multi-user compatibility promise exists in the Engineering MVP foundation.

Durable data uses explicit schema versions. Semantic capability contracts are transport-independent so adapters may change without changing domain meaning. Technology selections such as UI framework, Tauri, ORM, database engine, provider SDK, MCP transport, and agent framework remain deferred until the phase that requires them and must preserve the Phase 0/1 contracts.

## Operational-ownership

| Concern | Operational owner/source |
| --- | --- |
| Target repository state and confirmed product truth | Relevant target GitHub repository/source |
| Argus-owned working records, audit evidence, promotion links, backup/restore | Local Argus/operator |
| Secret values | macOS Keychain/operator |
| External provider resource truth | Relevant provider |
| Freshness/reconciliation/derived health policy | Argus domain semantics, evaluated from source evidence |
| Adapter availability/quota | Current execution environment/source; evidence only, never authority |
| Recovery decision after migration/restore failure | Operator using Argus recovery evidence |

The operator owns local backup/export/restore actions. External source recovery remains the external source's responsibility; Argus can reobserve it but does not claim to restore external truth from its cache.
