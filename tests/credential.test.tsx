import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test } from "vitest";
import type { CredentialReference } from "../src/credentials";
import type { CredentialSecretAdapter } from "../src/keychain";

const roots: string[] = [];
const originalHome = process.env.HOME;

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function rehashExport(document: Record<string, any>): string {
  const body = {
    formatVersion: document.formatVersion,
    schemaVersion: document.schemaVersion,
    exportedAt: document.exportedAt,
    workspaces: document.workspaces,
    credentialReferences: document.credentialReferences,
    repositoryWorktrees: document.repositoryWorktrees,
    repositoryObservations: document.repositoryObservations,
    auditEntries: document.auditEntries,
  };
  document.integrity.digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return JSON.stringify(document);
}

function runSecurity(args: string[]): void {
  const result = spawnSync("/usr/bin/security", args, { encoding: null, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`security ${args[0]} failed with status ${String(result.status)}`);
}

afterEach(async () => {
  process.env.HOME = originalHome;
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("credential reference durability and recovery", () => {
  test("migrates schema 2 forward and keeps credential values structurally absent", async () => {
    const api = await import("../src/workspace-store");
    const dataRoot = await tempDir("argus-credential-migration-");
    await mkdir(dataRoot, { recursive: true });
    const dbPath = path.join(dataRoot, "argus.db");
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(dbPath);
    api.runMigrations(raw, api.MIGRATIONS.slice(0, 2));
    expect(api.readSchemaVersion(raw)).toBe(2);
    raw.close();

    const migrated = api.openStore({ dataRoot });
    expect(api.readSchemaVersion(migrated.db)).toBe(3);
    const columns = (migrated.db.prepare("PRAGMA table_info(credential_references)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toEqual([
      "id",
      "external_system",
      "keychain_service",
      "keychain_account",
      "label",
      "created_at",
      "updated_at",
      "archived_at",
      "version",
    ]);
    expect(columns.some((name) => /(secret|token|password|private[_-]?key)/i.test(name))).toBe(false);
    migrated.close();
  });

  test("creates, lists, versions, archives, exports and restores references with repository state intact", async () => {
    const api = await import("../src/workspace-store");
    const app = await import("../src/workspace-app");
    const ui = await import("../src/workspace-home");
    const sourceRoot = await tempDir("argus-credential-source-");
    const targetRoot = await tempDir("argus-credential-target-");
    const workspaceRoot = await tempDir("argus-credential-workspace-");

    const source = api.openStore({ dataRoot: sourceRoot });
    const workspace = api.createWorkspace(source, { label: "Credential recovery", root: workspaceRoot });
    const first = api.createCredentialReference(source, {
      externalSystem: "GitHub",
      keychainService: "argus.github",
      keychainAccount: "primary",
      label: "Primary GitHub",
    });
    expect(first.version).toBe(1);
    expect(() => api.createCredentialReference(source, {
      externalSystem: "GitHub",
      keychainService: "argus.github",
      keychainAccount: "primary",
    })).toThrow(/already configured/i);
    expect(() => api.archiveCredentialReference(source, first.id, 99)).toThrow(/version conflict/i);
    expect(() => api.archiveCredentialReference(source, "not-a-uuid", 1)).toThrow(/identity is invalid/i);
    expect(() => api.archiveCredentialReference(source, randomUUID(), 1)).toThrow(/not found/i);
    const archived = api.archiveCredentialReference(source, first.id, 1);
    expect(archived.version).toBe(2);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.updatedAt).toBe(archived.archivedAt);
    expect(() => api.archiveCredentialReference(source, first.id, 2)).toThrow(/already archived/i);
    expect(api.listCredentialReferences(source)).toHaveLength(0);
    const archiveAudits = api.listAuditEntries(source).filter((entry) => entry.operation === "credential-reference.archive");
    expect(archiveAudits.filter((entry) => entry.outcome === "rejected")).toHaveLength(4);
    expect(archiveAudits.filter((entry) => entry.outcome === "success")).toHaveLength(1);

    const active = api.createCredentialReference(source, {
      externalSystem: "GitHub",
      keychainService: "argus.github",
      keychainAccount: "secondary",
    });

    const worktreeId = "worktree:credential-recovery-fixture";
    source.db.prepare(`
      INSERT INTO repository_worktrees (
        id, workspace_id, local_path, repository_kind, git_dir, common_dir,
        canonical_repository_identity, github_repository_id, github_alias, github_ref_name,
        remote_name, remote_url, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, 'working-tree', ?, ?, ?, NULL, NULL, 'main', 'origin', ?, ?, ?)
    `).run(
      worktreeId,
      workspace.id,
      workspaceRoot,
      path.join(workspaceRoot, ".git"),
      path.join(workspaceRoot, ".git"),
      "git-common:fixture",
      "https://github.com/acme/fixture.git",
      "2026-09-04T00:00:00.000Z",
      "2026-09-04T00:00:00.000Z",
    );
    source.db.prepare(`
      INSERT INTO repository_observations (
        observation_id, workspace_id, worktree_id, source_identity, subject_identity,
        observation_kind, value_json, absence_reason, observed_at, checked_at,
        availability, freshness, source_version, provenance, conflict_state, conflict_value_json
      ) VALUES (?, ?, ?, ?, ?, 'git.head', ?, NULL, ?, ?, 'AVAILABLE', 'CURRENT', ?, 'fixture', 'NONE', NULL)
    `).run(
      "observation:credential-recovery-fixture",
      workspace.id,
      worktreeId,
      "git:fixture",
      `worktree:${worktreeId}`,
      JSON.stringify("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      "2026-09-04T00:00:00.000Z",
      "2026-09-04T00:00:00.000Z",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    const fixtureValue = `argus-${randomBytes(24).toString("hex")}`;
    const fakeAdapter: CredentialSecretAdapter = {
      consume(_reference, consumer) {
        consumer(Buffer.from(fixtureValue));
        return "AVAILABLE";
      },
    };
    let consumedDigest = "";
    const resolution = api.withCredentialSecret(
      active,
      { operation: "test.consume" },
      (value) => {
        consumedDigest = createHash("sha256").update(value).digest("hex");
      },
      fakeAdapter,
    );
    expect(consumedDigest).toBe(createHash("sha256").update(fixtureValue).digest("hex"));
    expect(resolution).toEqual({
      credentialReferenceId: active.id,
      operation: "test.consume",
      availability: "AVAILABLE",
    });
    expect(JSON.stringify(resolution)).not.toContain(fixtureValue);

    let safeFailure = "";
    try {
      api.withCredentialSecret(active, { operation: "test.failure" }, () => {
        throw new Error(fixtureValue);
      }, fakeAdapter);
    } catch (error) {
      safeFailure = error instanceof Error ? error.message : String(error);
    }
    expect(safeFailure).toBe("Credential consumer failed.");
    expect(safeFailure).not.toContain(fixtureValue);

    const unavailable = api.checkCredentialAvailability(active, { operation: "test.missing" }, {
      consume() {
        return "UNAVAILABLE";
      },
    });
    expect(unavailable.availability).toBe("UNAVAILABLE");

    const adapterFailure = api.checkCredentialAvailability(active, { operation: "test.adapter-failure" }, {
      consume() {
        throw new Error(fixtureValue);
      },
    });
    expect(adapterFailure.availability).toBe("UNAVAILABLE");
    expect(JSON.stringify(adapterFailure)).not.toContain(fixtureValue);

    let malformedConsumerCalled = false;
    const malformedLocator = api.withCredentialSecret(
      { ...active, keychainService: "bad\nservice" },
      { operation: "test.malformed-locator" },
      () => {
        malformedConsumerCalled = true;
      },
      new api.MacOSKeychainAdapter(),
    );
    expect(malformedLocator.availability).toBe("UNAVAILABLE");
    expect(malformedConsumerCalled).toBe(false);

    const home = app.loadWorkspaceHome({ dataRoot: sourceRoot, credentialAdapter: fakeAdapter });
    const markup = renderToStaticMarkup(ui.WorkspaceHome(home));
    expect(markup).toContain("Credential references");
    expect(markup).toContain("AVAILABLE");
    expect(markup).toContain("argus.github");
    expect(markup).not.toContain(fixtureValue);
    expect(markup).not.toMatch(/type=["']password["']/i);
    expect(markup).not.toMatch(/name=["'](?:secret|token|password|privateKey)["']/i);
    expect(markup).not.toMatch(/reveal|copy credential|copy value/i);

    const exported = api.exportState(source);
    expect(exported).not.toContain(fixtureValue);
    expect(JSON.stringify(api.listAuditEntries(source))).not.toContain(fixtureValue);
    const logicalRows = source.db.prepare("SELECT * FROM credential_references ORDER BY id").all();
    expect(JSON.stringify(logicalRows)).not.toContain(fixtureValue);
    const dbBytes = await readFile(source.dbPath);
    expect(dbBytes.includes(Buffer.from(fixtureValue))).toBe(false);

    const diff = spawnSync("git", ["diff", "--no-ext-diff", "HEAD", "--"], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
    });
    expect(diff.status).toBe(0);
    expect(diff.stdout).not.toContain(fixtureValue);
    const reportPath = path.resolve(__dirname, "..", ".agent", "tasks", "TASK-0006", "report.yaml");
    if (existsSync(reportPath)) expect(await readFile(reportPath, "utf8")).not.toContain(fixtureValue);

    source.close();

    const target = api.openStore({ dataRoot: targetRoot });
    api.restoreState(target, exported);
    expect(api.listCredentialReferences(target, { includeArchived: true })).toEqual([
      expect.objectContaining({ id: first.id, archivedAt: expect.any(String), version: 2 }),
      expect.objectContaining({ id: active.id, archivedAt: null, version: 1 }),
    ]);
    const restoredWorktree = target.db.prepare("SELECT id, workspace_id FROM repository_worktrees").get() as { id: string; workspace_id: string };
    expect(restoredWorktree).toEqual({ id: worktreeId, workspace_id: workspace.id });
    const restoredObservation = target.db.prepare("SELECT observation_kind, availability FROM repository_observations").get();
    expect(restoredObservation).toEqual({ observation_kind: "git.head", availability: "AVAILABLE" });

    const duplicateLocator = JSON.parse(exported);
    duplicateLocator.credentialReferences.push({ ...duplicateLocator.credentialReferences.find((item: any) => item.id === active.id), id: randomUUID() });
    expect(() => api.restoreState(target, rehashExport(duplicateLocator))).toThrow(/duplicate active credential locator/i);
    expect(api.listCredentialReferences(target)).toEqual([expect.objectContaining({ id: active.id })]);

    const malformedRelationship = JSON.parse(exported);
    malformedRelationship.repositoryWorktrees[0].workspaceId = randomUUID();
    expect(() => api.restoreState(target, rehashExport(malformedRelationship))).toThrow(/repository workspace relationship/i);

    const forbiddenField = JSON.parse(exported);
    forbiddenField.credentialReferences[0].secretValue = "forbidden";
    expect(() => api.restoreState(target, rehashExport(forbiddenField))).toThrow(/forbidden secret-shaped field/i);
    target.close();
  });
});

describe("native macOS Keychain boundary", () => {
  test("resolves only from a run-owned isolated keychain and deletes the fixture", async () => {
    expect(process.platform).toBe("darwin");
    const api = await import("../src/workspace-store");
    const root = await tempDir("argus-keychain-native-");
    const keychainPath = path.join(root, "fixture.keychain-db");
    const keychainPassword = randomBytes(24).toString("hex");
    const fixtureValue = `argus-native-${randomBytes(32).toString("hex")}`;
    const service = `argus.native.${randomUUID()}`;
    const account = `fixture-${randomUUID()}`;
    const reference: CredentialReference = {
      id: randomUUID(),
      externalSystem: "Native fixture",
      keychainService: service,
      keychainAccount: account,
      label: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
      version: 1,
    };

    try {
      runSecurity(["create-keychain", "-p", keychainPassword, keychainPath]);
      runSecurity(["unlock-keychain", "-p", keychainPassword, keychainPath]);
      runSecurity(["add-generic-password", "-a", account, "-s", service, "-w", fixtureValue, keychainPath]);

      let digest = "";
      const result = api.withCredentialSecret(
        reference,
        { operation: "native.fixture.read" },
        (value) => {
          digest = createHash("sha256").update(value).digest("hex");
        },
        new api.MacOSKeychainAdapter({ keychainPath }),
      );
      expect(result.availability).toBe("AVAILABLE");
      expect(digest).toBe(createHash("sha256").update(fixtureValue).digest("hex"));
      expect(JSON.stringify(result)).not.toContain(fixtureValue);
    } finally {
      if (existsSync(keychainPath)) {
        const deleted = spawnSync("/usr/bin/security", ["delete-keychain", keychainPath], {
          encoding: null,
          stdio: ["ignore", "pipe", "pipe"],
        });
        expect(deleted.status).toBe(0);
      }
    }
    expect(existsSync(keychainPath)).toBe(false);
  });
});

test("Next route creates and archives references without browser-visible credential values", async () => {
  const tempHome = await tempDir("argus-credential-next-home-");
  process.env.HOME = tempHome;
  const route = await import("../app/credentials/route");
  const page = await import("../app/page");
  const app = await import("../src/workspace-app");

  const createResponse = await route.POST(new Request("http://127.0.0.1:3000/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      intent: "create",
      externalSystem: "GitHub",
      keychainService: `argus.route.${randomUUID()}`,
      keychainAccount: "fixture-account",
      label: "Route fixture",
    }),
  }));
  expect(createResponse.status).toBe(303);

  const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({}) }));
  expect(html).toContain("Route fixture");
  expect(html).toContain("UNAVAILABLE");
  expect(html).not.toMatch(/type=["']password["']/i);
  expect(html).not.toMatch(/reveal|copy credential|copy value/i);

  const configured = app.loadWorkspaceHome();
  const credential = configured.credentials[0];
  expect(credential).toBeDefined();
  if (!credential) throw new Error("Credential route fixture was not persisted.");
  const archiveResponse = await route.POST(new Request("http://127.0.0.1:3000/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent: "archive", id: credential.id, version: String(credential.version) }),
  }));
  expect(archiveResponse.status).toBe(303);
  expect(app.loadWorkspaceHome().credentials).toHaveLength(0);
});
