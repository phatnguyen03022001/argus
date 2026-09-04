import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test } from "vitest";
import type { CredentialSecretAdapter } from "../src/keychain";

const roots: string[] = [];
const originalHome = process.env.HOME;
const runtimeFixtureSecret = `argus-env-${randomBytes(32).toString("hex")}`;

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
    environmentProfiles: document.environmentProfiles,
    repositoryWorktrees: document.repositoryWorktrees,
    repositoryObservations: document.repositoryObservations,
    auditEntries: document.auditEntries,
  };
  document.integrity.digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return JSON.stringify(document);
}

afterEach(async () => {
  process.env.HOME = originalHome;
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("workspace environment profiles", () => {
  test("migrates schema 3 forward with branch-independent profile, setting, and credential-binding tables", async () => {
    const api = await import("../src/workspace-store");
    const dataRoot = await tempDir("argus-environment-migration-");
    const Database = (await import("better-sqlite3")).default;
    const dbPath = path.join(dataRoot, "argus.db");
    const raw = new Database(dbPath);
    api.runMigrations(raw, api.MIGRATIONS.slice(0, 3));
    expect(api.readSchemaVersion(raw)).toBe(3);
    raw.close();

    const migrated = api.openStore({ dataRoot });
    expect(api.readSchemaVersion(migrated.db)).toBe(4);
    const profileColumns = (migrated.db.prepare("PRAGMA table_info(environment_profiles)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(profileColumns).toEqual([
      "id", "workspace_id", "environment_name", "label", "created_at", "updated_at", "archived_at", "version",
    ]);
    expect(profileColumns.some((name) => /(branch|ref|secret|token|password|private[_-]?key|api[_-]?key)/i.test(name))).toBe(false);
    const settingColumns = (migrated.db.prepare("PRAGMA table_info(environment_settings)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(settingColumns).toEqual(["profile_id", "setting_key", "value_json"]);
    const bindingColumns = (migrated.db.prepare("PRAGMA table_info(environment_credential_bindings)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(bindingColumns).toEqual(["profile_id", "binding_key", "credential_reference_id"]);
    migrated.close();
  });

  test("creates, lists, validates, versions, and archives profiles atomically within one workspace", async () => {
    const api = await import("../src/workspace-store");
    const dataRoot = await tempDir("argus-environment-domain-");
    const workspaceRoot = await tempDir("argus-environment-workspace-");
    const secondWorkspaceRoot = await tempDir("argus-environment-workspace-2-");
    const store = api.openStore({ dataRoot });
    const workspace = api.createWorkspace(store, { label: "Primary", root: workspaceRoot });
    const secondWorkspace = api.createWorkspace(store, { label: "Secondary", root: secondWorkspaceRoot });
    const credential = api.createCredentialReference(store, {
      externalSystem: "GitHub",
      keychainService: `argus.environment.${randomUUID()}`,
      keychainAccount: "primary",
      label: "GitHub primary",
    });

    const created = api.createEnvironmentProfile(store, {
      workspaceId: workspace.id,
      environmentName: "production",
      label: "Production",
      settings: [
        { key: "LOG_LEVEL", value: "info" },
        { key: "RETRY_COUNT", value: 3 },
        { key: "FEATURE_ENABLED", value: true },
        { key: "OPTIONAL_VALUE", value: null },
      ],
      credentialBindings: [{ key: "GITHUB_CREDENTIAL", credentialReferenceId: credential.id }],
    });
    expect(created).toMatchObject({ workspaceId: workspace.id, environmentName: "production", version: 1, archivedAt: null });
    expect(created.settings).toEqual([
      { key: "FEATURE_ENABLED", value: true },
      { key: "LOG_LEVEL", value: "info" },
      { key: "OPTIONAL_VALUE", value: null },
      { key: "RETRY_COUNT", value: 3 },
    ]);
    expect(created.credentialBindings).toEqual([{ key: "GITHUB_CREDENTIAL", credentialReferenceId: credential.id }]);
    expect(() => api.archiveCredentialReference(store, credential.id, credential.version)).toThrow(/active environment profile/i);
    expect(api.listCredentialReferences(store)).toEqual([expect.objectContaining({ id: credential.id, archivedAt: null, version: 1 })]);

    expect(() => api.createEnvironmentProfile(store, {
      workspaceId: workspace.id,
      environmentName: "production",
      settings: [],
      credentialBindings: [],
    })).toThrow(/already configured/i);
    expect(() => api.createEnvironmentProfile(store, {
      workspaceId: secondWorkspace.id,
      environmentName: "production",
      settings: [],
      credentialBindings: [],
    })).not.toThrow();

    const invalidCases = [
      { settings: [{ key: "", value: "x" }], credentialBindings: [], pattern: /key is required/i },
      { settings: [{ key: "BAD\nKEY", value: "x" }], credentialBindings: [], pattern: /control character/i },
      { settings: [{ key: "API_KEY", value: "do-not-store" }], credentialBindings: [], pattern: /credential binding/i },
      { settings: [{ key: "NESTED", value: { nope: true } }], credentialBindings: [], pattern: /scalar/i },
      { settings: [{ key: "DUP", value: "a" }, { key: "DUP", value: "b" }], credentialBindings: [], pattern: /duplicate setting key/i },
      { settings: [], credentialBindings: [{ key: "DUP", credentialReferenceId: credential.id }, { key: "DUP", credentialReferenceId: credential.id }], pattern: /duplicate credential binding key/i },
      { settings: [{ key: "COLLIDE", value: "x" }], credentialBindings: [{ key: "COLLIDE", credentialReferenceId: credential.id }], pattern: /collides/i },
      { settings: [], credentialBindings: [{ key: "MISSING", credentialReferenceId: randomUUID() }], pattern: /active credential reference/i },
    ];
    for (const invalid of invalidCases) {
      const before = api.listEnvironmentProfiles(store, { includeArchived: true }).length;
      expect(() => api.createEnvironmentProfile(store, {
        workspaceId: workspace.id,
        environmentName: `invalid-${randomUUID()}`,
        settings: invalid.settings,
        credentialBindings: invalid.credentialBindings,
      })).toThrow(invalid.pattern);
      expect(api.listEnvironmentProfiles(store, { includeArchived: true })).toHaveLength(before);
    }

    const archivedCredential = api.createCredentialReference(store, {
      externalSystem: "GitHub",
      keychainService: `argus.environment.${randomUUID()}`,
      keychainAccount: "archived",
    });
    api.archiveCredentialReference(store, archivedCredential.id, archivedCredential.version);
    expect(() => api.createEnvironmentProfile(store, {
      workspaceId: workspace.id,
      environmentName: "archived-credential",
      settings: [],
      credentialBindings: [{ key: "GITHUB_CREDENTIAL", credentialReferenceId: archivedCredential.id }],
    })).toThrow(/active credential reference/i);

    expect(() => api.archiveEnvironmentProfile(store, created.id, 99)).toThrow(/version conflict/i);
    const archived = api.archiveEnvironmentProfile(store, created.id, 1);
    expect(archived.version).toBe(2);
    expect(archived.archivedAt).not.toBeNull();
    expect(api.listEnvironmentProfiles(store).some((profile: { id: string }) => profile.id === created.id)).toBe(false);
    expect(api.listEnvironmentProfiles(store, { includeArchived: true }).some((profile: { id: string; version: number }) => profile.id === created.id && profile.version === 2)).toBe(true);
    store.close();
  });

  test("exports and restores exact environment relationships while rejecting malformed or orphaned state without secret reconstruction", async () => {
    const api = await import("../src/workspace-store");
    const sourceRoot = await tempDir("argus-environment-export-");
    const targetRoot = await tempDir("argus-environment-restore-");
    const workspaceRoot = await tempDir("argus-environment-recovery-workspace-");
    const source = api.openStore({ dataRoot: sourceRoot });
    const workspace = api.createWorkspace(source, { label: "Recovery", root: workspaceRoot });
    const credential = api.createCredentialReference(source, {
      externalSystem: "GitHub",
      keychainService: `argus.environment.${randomUUID()}`,
      keychainAccount: "recovery",
    });
    const fixtureSecret = runtimeFixtureSecret;
    expect(() => api.createEnvironmentProfile(source, {
      workspaceId: workspace.id,
      environmentName: "rejected-secret",
      settings: [{ key: "PRIVATE_KEY", value: fixtureSecret }],
      credentialBindings: [],
    })).toThrow(/credential binding/i);
    const profile = api.createEnvironmentProfile(source, {
      workspaceId: workspace.id,
      environmentName: "staging",
      settings: [{ key: "REGION", value: "asia-southeast1" }],
      credentialBindings: [{ key: "GITHUB_CREDENTIAL", credentialReferenceId: credential.id }],
    });

    const exported = api.exportState(source);
    expect(exported).not.toContain(fixtureSecret);
    expect(JSON.stringify(api.listAuditEntries(source))).not.toContain(fixtureSecret);
    expect(JSON.stringify(source.db.prepare("SELECT * FROM environment_profiles").all())).not.toContain(fixtureSecret);
    expect(JSON.stringify(source.db.prepare("SELECT * FROM environment_settings").all())).not.toContain(fixtureSecret);
    expect(JSON.stringify(source.db.prepare("SELECT * FROM environment_credential_bindings").all())).not.toContain(fixtureSecret);
    expect((await readFile(source.dbPath)).includes(Buffer.from(fixtureSecret))).toBe(false);

    const app = await import("../src/workspace-app");
    const ui = await import("../src/workspace-home");
    const fakeAdapter: CredentialSecretAdapter = {
      consume(_reference, consumer) {
        consumer(Buffer.from(fixtureSecret));
        return "AVAILABLE";
      },
    };
    const markup = renderToStaticMarkup(ui.WorkspaceHome(app.loadWorkspaceHome({ dataRoot: sourceRoot, credentialAdapter: fakeAdapter })));
    expect(markup).not.toContain(fixtureSecret);
    const diff = spawnSync("git", ["diff", "--no-ext-diff", "HEAD", "--"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
    expect(diff.status).toBe(0);
    expect(diff.stdout).not.toContain(fixtureSecret);
    const reportPath = path.resolve(__dirname, "..", ".agent", "tasks", "TASK-0007", "report.yaml");
    if (existsSync(reportPath)) expect(await readFile(reportPath, "utf8")).not.toContain(fixtureSecret);
    source.close();

    const target = api.openStore({ dataRoot: targetRoot });
    api.restoreState(target, exported);
    expect(api.listEnvironmentProfiles(target)).toEqual([
      expect.objectContaining({
        id: profile.id,
        workspaceId: workspace.id,
        environmentName: "staging",
        settings: [{ key: "REGION", value: "asia-southeast1" }],
        credentialBindings: [{ key: "GITHUB_CREDENTIAL", credentialReferenceId: credential.id }],
      }),
    ]);

    const orphaned = JSON.parse(exported);
    orphaned.environmentProfiles[0].workspaceId = randomUUID();
    expect(() => api.restoreState(target, rehashExport(orphaned))).toThrow(/environment workspace relationship/i);
    expect(api.listEnvironmentProfiles(target)).toEqual([expect.objectContaining({ id: profile.id })]);

    const duplicate = JSON.parse(exported);
    duplicate.environmentProfiles.push({ ...duplicate.environmentProfiles[0], id: randomUUID() });
    expect(() => api.restoreState(target, rehashExport(duplicate))).toThrow(/duplicate active environment name/i);

    const missingCredential = JSON.parse(exported);
    missingCredential.environmentProfiles[0].credentialBindings[0].credentialReferenceId = randomUUID();
    expect(() => api.restoreState(target, rehashExport(missingCredential))).toThrow(/environment credential relationship/i);

    const archivedBinding = JSON.parse(exported);
    const boundCredential = archivedBinding.credentialReferences.find((item: any) => item.id === credential.id);
    boundCredential.archivedAt = "2026-09-04T00:00:00.000Z";
    boundCredential.updatedAt = boundCredential.archivedAt;
    boundCredential.version = 2;
    expect(() => api.restoreState(target, rehashExport(archivedBinding))).toThrow(/active credential reference/i);

    const forbidden = JSON.parse(exported);
    forbidden.environmentProfiles[0].settings.push({ key: "TOKEN", value: "forbidden" });
    expect(() => api.restoreState(target, rehashExport(forbidden))).toThrow(/credential binding/i);

    const forbiddenField = JSON.parse(exported);
    forbiddenField.environmentProfiles[0].apiKey = "forbidden";
    expect(() => api.restoreState(target, rehashExport(forbiddenField))).toThrow(/forbidden secret-shaped field/i);
    target.close();
  });

  test("UI and route expose profile metadata and availability without secret handling or apply/materialize actions", async () => {
    const tempHome = await tempDir("argus-environment-next-home-");
    const workspaceRoot = await tempDir("argus-environment-next-workspace-");
    process.env.HOME = tempHome;
    const api = await import("../src/workspace-store");
    const app = await import("../src/workspace-app");
    const ui = await import("../src/workspace-home");
    const route = await import("../app/environments/route");
    const store = api.openStore();
    const workspace = api.createWorkspace(store, { label: "Environment UI", root: workspaceRoot });
    const credential = api.createCredentialReference(store, {
      externalSystem: "GitHub",
      keychainService: `argus.environment.${randomUUID()}`,
      keychainAccount: "ui",
      label: "UI credential",
    });
    store.close();

    const rejectedSecretResponse = await route.POST(new Request("http://127.0.0.1:3000/environments", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        intent: "create",
        workspaceId: workspace.id,
        environmentName: "rejected-http-secret",
        settings: `API_KEY=${runtimeFixtureSecret}`,
        credentialBindings: "",
      }),
    }));
    expect(rejectedSecretResponse.status).toBe(303);
    expect(rejectedSecretResponse.headers.get("location")).not.toContain(runtimeFixtureSecret);
    expect(await rejectedSecretResponse.text()).not.toContain(runtimeFixtureSecret);

    const createResponse = await route.POST(new Request("http://127.0.0.1:3000/environments", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        intent: "create",
        workspaceId: workspace.id,
        environmentName: "preview",
        label: "Preview",
        settings: "REGION=asia-southeast1\nLOG_LEVEL=info",
        credentialBindings: `GITHUB_CREDENTIAL=${credential.id}`,
      }),
    }));
    expect(createResponse.status).toBe(303);

    const fakeAdapter: CredentialSecretAdapter = {
      consume(_reference, consumer) {
        consumer(Buffer.from(runtimeFixtureSecret));
        return "AVAILABLE";
      },
    };
    const home = app.loadWorkspaceHome({ credentialAdapter: fakeAdapter });
    expect(home.environments).toHaveLength(1);
    const markup = renderToStaticMarkup(ui.WorkspaceHome(home));
    expect(markup).toContain("Environment profiles");
    expect(markup).toContain("Environment UI");
    expect(markup).toContain("preview");
    expect(markup).toContain("REGION");
    expect(markup).toContain("asia-southeast1");
    expect(markup).toContain("GITHUB_CREDENTIAL");
    expect(markup).toContain(credential.id);
    expect(markup).toContain("AVAILABLE");
    expect(markup).not.toContain(runtimeFixtureSecret);
    expect(markup).not.toMatch(/type=["']password["']/i);
    expect(markup).not.toMatch(/name=["'](?:secret|token|password|privateKey|apiKey)["']/i);
    expect(markup).not.toMatch(/reveal|copy value|materialize|apply environment|sync environment/i);

    const environment = home.environments[0];
    if (!environment) throw new Error("Environment route fixture was not persisted.");
    const archiveResponse = await route.POST(new Request("http://127.0.0.1:3000/environments", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "archive", id: environment.id, version: String(environment.version) }),
    }));
    expect(archiveResponse.status).toBe(303);
    expect(app.loadWorkspaceHome({ credentialAdapter: fakeAdapter }).environments).toHaveLength(0);

    const reportPath = path.resolve(__dirname, "..", ".agent", "tasks", "TASK-0007", "report.yaml");
    if (existsSync(reportPath)) expect(await readFile(reportPath, "utf8")).not.toContain(runtimeFixtureSecret);
  });
});
