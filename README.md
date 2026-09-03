# Argus

Argus is an operator-local control plane and engineering workspace. Phase 2 provides the local workspace foundation: durable Argus-owned workspace metadata, schema migrations, audit evidence, versioned export/restore semantics, and a loopback-only UI for registering existing filesystem roots. Phase 3 adds read-only repository/worktree discovery and Git/GitHub observation.

## Local development

Requirements are pinned by repository metadata: Node.js 24 LTS and pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:3000`. The dev and production start scripts bind to `127.0.0.1`; Argus does not intentionally expose a remote control plane.

Runtime state is stored outside the repository at `~/Library/Application Support/Argus/argus.db`. Registering a workspace validates and records its canonical filesystem root. Phase 3 discovery observes existing repository/worktree state without initializing, resetting, writing to, deleting, syncing, or otherwise mutating those repositories.

## Verification

```bash
pnpm verify
```

`pnpm verify` runs TypeScript checks, deterministic Vitest coverage, and the production Next.js build. Tests use isolated temporary data and workspace roots.

## Phase boundary

Argus currently includes the Phase 2 workspace foundation and Phase 3 read-only repository/worktree discovery with Git/GitHub observation. Phase 3 does not classify repository health or attention, and it does not perform Git mutation or sync actions. Environment or secret integration, provider integration, task projection, agent execution, business capabilities, and Phase 4+ surfaces remain out of scope. No `.env` file or secret configuration is required.
