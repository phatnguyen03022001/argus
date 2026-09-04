# Argus

Argus is an operator-local control plane and engineering workspace. Phase 2 provides the local workspace foundation: durable Argus-owned workspace metadata, schema migrations, audit evidence, versioned export/restore semantics, and a loopback-only UI for registering existing filesystem roots. Phase 3 adds read-only repository/worktree discovery, Git/GitHub observation, and derived repository health, sync condition, and operator-attention assessment. Phase 4 includes durable non-secret credential references and workspace-scoped environment profiles while macOS Keychain remains the sole owner of credential values.

## Local development

Requirements are pinned by repository metadata: Node.js 24 LTS and pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:3000`. The dev and production start scripts bind to `127.0.0.1`; Argus does not intentionally expose a remote control plane.

Runtime state is stored outside the repository at `~/Library/Application Support/Argus/argus.db`. Registering a workspace validates and records its canonical filesystem root. Phase 3 discovery observes existing repository/worktree state without initializing, resetting, writing to, deleting, syncing, or otherwise mutating those repositories. Credential-reference records contain only Argus identity, intended external system, Keychain service/account locator metadata, optional label, lifecycle timestamps, and version. Workspace-scoped environment profiles keep ordinary scalar settings separate from credential-reference bindings, use explicit environment names independent of Git branches/refs, and persist only credential-reference IDs for credential-bearing configuration. Availability checks read referenced Keychain items through a narrow in-process boundary and expose only `AVAILABLE` or `UNAVAILABLE`; credential values are not stored, exported, audited, rendered, or returned by ordinary application results.

## Verification

```bash
pnpm verify
```

`pnpm verify` runs TypeScript checks, deterministic Vitest coverage, and the production Next.js build. Tests use isolated temporary data and workspace roots.

## Phase boundary

Argus currently includes the Phase 2 workspace foundation, Phase 3 read-only repository/worktree discovery with Git/GitHub observation, and Phase 4 credential-reference/Keychain plus workspace environment-profile configuration boundaries. Phase 3 derives repository health, sync condition, attention, and reason codes from current observations without persisting them as source truth; it does not perform Git mutation or sync actions. Phase 4 stores credential references plus explicit workspace-scoped environment names, ordinary non-secret scalar settings, and credential-reference bindings; Keychain availability/resolution remains read-only and scoped to an in-process consumer. Argus does not create, rotate, revoke, copy, reveal, or persist credential values; it does not infer environments from Git branches, materialize `.env` files, apply/sync environment configuration, or implement provider/OAuth/cloud-vault integration. Task projection, agent execution, business capabilities, provider/resource integration, deployment mapping, and Phase 5+ surfaces remain out of scope.
