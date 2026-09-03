# Argus

Argus is an operator-local control plane and engineering workspace. Phase 2 provides the local workspace foundation only: durable Argus-owned workspace metadata, schema migrations, audit evidence, versioned export/restore semantics, and a loopback-only UI for registering existing filesystem roots.

## Local development

Requirements are pinned by repository metadata: Node.js 24 LTS and pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:3000`. The dev and production start scripts bind to `127.0.0.1`; Argus does not intentionally expose a remote control plane in Phase 2.

Runtime state is stored outside the repository at `~/Library/Application Support/Argus/argus.db`. Registering a workspace validates and records its canonical filesystem root; Argus does not scan, initialize, reset, write to, or delete the selected directory in Phase 2.

## Verification

```bash
pnpm verify
```

`pnpm verify` runs TypeScript checks, deterministic Vitest coverage, and the production Next.js build. Tests use isolated temporary data and workspace roots.

## Phase boundary

Phase 2 does not perform Git or GitHub discovery/control, environment or secret integration, provider integration, task projection, agent execution, or other Phase 3+ behavior. No `.env` file or secret configuration is required.
