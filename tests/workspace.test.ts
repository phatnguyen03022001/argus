import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const roots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("workspace identity and durability", () => {
  test("canonicalizes roots, rejects invalid duplicates, and preserves identity across metadata changes", async () => {
    const api = await import("../src/workspace-store");
    const dataRoot = await tempDir("argus-data-");
    const workspaceParent = await tempDir("argus-workspaces-");
    const firstRoot = path.join(workspaceParent, "first");
    const secondRoot = path.join(workspaceParent, "second");
    const symlinkRoot = path.join(workspaceParent, "first-link");
    const filePath = path.join(workspaceParent, "file.txt");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    await symlink(firstRoot, symlinkRoot, "dir");
    await writeFile(filePath, "do-not-touch", "utf8");

    const store = api.openStore({ dataRoot });
    const created = api.createWorkspace(store, { label: "Primary", root: symlinkRoot });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.rootPath).toBe(await realpath(firstRoot));
    expect(created.version).toBe(1);

    expect(() => api.createWorkspace(store, { label: "Duplicate", root: firstRoot })).toThrow(/already configured/i);
    expect(() => api.createWorkspace(store, { label: "Missing", root: path.join(workspaceParent, "missing") })).toThrow(/does not exist/i);
    expect(() => api.createWorkspace(store, { label: "File", root: filePath })).toThrow(/directory/i);

    const updated = api.updateWorkspace(store, created.id, { label: "Renamed", root: secondRoot });
    expect(updated.id).toBe(created.id);
    expect(updated.label).toBe("Renamed");
    expect(updated.rootPath).toBe(await realpath(secondRoot));
    expect(updated.version).toBe(2);
    expect(await readFile(filePath, "utf8")).toBe("do-not-touch");
    store.close();

    const reopened = api.openStore({ dataRoot });
    const persisted = api.listWorkspaces(reopened);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ id: created.id, label: "Renamed", version: 2 });
    reopened.close();
  });
});

describe("schema migration semantics", () => {
  test("initializes schema, rejects unsupported versions, and rolls back a failing forward migration", async () => {
    const api = await import("../src/workspace-store");
    const dataRoot = await tempDir("argus-migration-");
    const store = api.openStore({ dataRoot });
    expect(api.readSchemaVersion(store.db)).toBe(api.CURRENT_SCHEMA_VERSION);

    expect(() => api.runMigrations(store.db, [
      ...api.MIGRATIONS,
      {
        version: 4,
        up(db: typeof store.db) {
          db.exec("CREATE TABLE should_rollback (id TEXT PRIMARY KEY)");
          throw new Error("intentional migration failure");
        },
      },
    ])).toThrow(/intentional migration failure/i);
    expect(api.readSchemaVersion(store.db)).toBe(3);
    const rollbackProbe = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'").get();
    expect(rollbackProbe).toBeUndefined();

    store.db.prepare("UPDATE schema_meta SET version = 99 WHERE id = 1").run();
    store.close();
    expect(() => api.openStore({ dataRoot })).toThrow(/unsupported schema version/i);
  });

  test("rejects an unrecognized non-empty database instead of treating it as fresh", async () => {
    const api = await import("../src/workspace-store");
    const dataRoot = await tempDir("argus-invalid-schema-");
    await mkdir(dataRoot, { recursive: true });
    const dbPath = path.join(dataRoot, "argus.db");
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(dbPath);
    raw.exec("CREATE TABLE foreign_state (id TEXT PRIMARY KEY)");
    raw.close();
    expect(() => api.openStore({ dataRoot })).toThrow(/unrecognized schema state/i);
  });
});

describe("export, restore, and audit", () => {
  test("round-trips app-native state and leaves a valid store untouched on invalid restore", async () => {
    const api = await import("../src/workspace-store");
    const sourceData = await tempDir("argus-export-source-");
    const targetData = await tempDir("argus-export-target-");
    const workspaceRoot = await tempDir("argus-export-workspace-");
    const existingRoot = await tempDir("argus-existing-workspace-");

    const source = api.openStore({ dataRoot: sourceData });
    const sourceWorkspace = api.createWorkspace(source, { label: "Exported", root: workspaceRoot });
    expect(() => api.createWorkspace(source, { label: "Duplicate", root: workspaceRoot })).toThrow();
    const exported = api.exportState(source);
    const exportedObject = JSON.parse(exported);
    expect(exportedObject).toMatchObject({ formatVersion: 1, schemaVersion: 3 });
    expect(exportedObject.integrity).toMatchObject({ algorithm: "sha256" });
    source.close();

    const target = api.openStore({ dataRoot: targetData });
    const existing = api.createWorkspace(target, { label: "Existing", root: existingRoot });

    const tampered = JSON.parse(exported);
    tampered.workspaces[0].label = "Tampered";
    expect(() => api.restoreState(target, JSON.stringify(tampered))).toThrow(/integrity/i);
    expect(api.listWorkspaces(target)).toEqual([expect.objectContaining({ id: existing.id, label: "Existing" })]);

    const unsupported = JSON.parse(exported);
    unsupported.formatVersion = 999;
    expect(() => api.restoreState(target, JSON.stringify(unsupported))).toThrow(/unsupported export format/i);
    expect(api.listWorkspaces(target)).toEqual([expect.objectContaining({ id: existing.id })]);

    api.restoreState(target, exported);
    const restored = api.listWorkspaces(target);
    expect(restored).toEqual([expect.objectContaining({ id: sourceWorkspace.id, label: "Exported" })]);

    const audits = api.listAuditEntries(target);
    expect(audits.some((entry) => entry.operation === "workspace.create" && entry.outcome === "success")).toBe(true);
    const rejectedDuplicate = audits.find((entry) => entry.operation === "workspace.create" && entry.outcome === "rejected");
    expect(rejectedDuplicate).toMatchObject({ preRecordId: sourceWorkspace.id, preVersion: 1 });
    expect(audits.some((entry) => entry.operation === "state.restore" && entry.outcome === "success")).toBe(true);
    expect(audits.some((entry) => entry.operation === "state.restore" && entry.outcome === "rejected")).toBe(true);
    for (const entry of audits) {
      expect(entry.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entry.actorCategory).toMatch(/^(operator|system)$/);
      expect(entry.targetIdentity.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(Object.keys(entry).some((key) => /secret|token|credential/i.test(key))).toBe(false);
    }
    target.close();
  });
});
