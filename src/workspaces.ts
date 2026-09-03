import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { recordAudit } from "./audit";
import type { Store } from "./persistence";

export interface WorkspaceRecord {
  id: string;
  label: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  version: number;
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

function canonicalRoot(input: string): string {
  const raw = input.trim();
  if (!raw) throw new WorkspaceError("Workspace root is required.");
  const absolute = path.resolve(raw);
  let resolved: string;
  try {
    resolved = realpathSync(absolute);
  } catch {
    throw new WorkspaceError(`Workspace root does not exist: ${absolute}`);
  }
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new WorkspaceError(`Workspace root does not exist: ${absolute}`);
  }
  if (!stats.isDirectory()) throw new WorkspaceError(`Workspace root must be a directory: ${resolved}`);
  return resolved;
}

function targetForInput(root: string): string {
  const normalized = path.resolve(root.trim() || ".");
  return `workspace-input:${createHash("sha256").update(normalized).digest("hex")}`;
}

function mapWorkspace(row: Record<string, unknown>): WorkspaceRecord {
  return {
    id: String(row.id),
    label: String(row.label),
    rootPath: String(row.root_path),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
    version: Number(row.version),
  };
}

function requireLabel(label: string): string {
  const value = label.trim();
  if (!value) throw new WorkspaceError("Workspace label is required.");
  return value;
}

export function createWorkspace(store: Store, input: { label: string; root: string }): WorkspaceRecord {
  let rootPath: string;
  let label: string;
  try {
    label = requireLabel(input.label);
    rootPath = canonicalRoot(input.root);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workspace validation failed.";
    recordAudit(store, {
      operation: "workspace.create",
      targetIdentity: targetForInput(input.root),
      outcome: "rejected",
      reason: message,
      preRecordId: null,
      preVersion: null,
      postRecordId: null,
      postVersion: null,
    });
    throw error;
  }

  const duplicate = store.db
    .prepare("SELECT id, version FROM workspaces WHERE root_path = ? AND archived_at IS NULL")
    .get(rootPath) as { id?: string; version?: number } | undefined;
  if (duplicate?.id) {
    const message = `Workspace root is already configured: ${rootPath}`;
    recordAudit(store, {
      operation: "workspace.create",
      targetIdentity: String(duplicate.id),
      outcome: "rejected",
      reason: message,
      preRecordId: String(duplicate.id),
      preVersion: duplicate.version == null ? null : Number(duplicate.version),
      postRecordId: null,
      postVersion: null,
    });
    throw new WorkspaceError(message);
  }

  const now = new Date().toISOString();
  const workspace: WorkspaceRecord = {
    id: randomUUID(),
    label,
    rootPath,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    version: 1,
  };

  const commit = store.db.transaction(() => {
    store.db.prepare(`
      INSERT INTO workspaces (id, label, root_path, created_at, updated_at, archived_at, version)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `).run(workspace.id, workspace.label, workspace.rootPath, workspace.createdAt, workspace.updatedAt, workspace.version);
    recordAudit(store, {
      operation: "workspace.create",
      targetIdentity: workspace.id,
      outcome: "success",
      reason: "Workspace created.",
      preRecordId: null,
      preVersion: null,
      postRecordId: workspace.id,
      postVersion: workspace.version,
    });
  });
  commit();
  return workspace;
}

export function updateWorkspace(
  store: Store,
  id: string,
  input: { label?: string; root?: string },
): WorkspaceRecord {
  const currentRow = store.db.prepare("SELECT * FROM workspaces WHERE id = ? AND archived_at IS NULL").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!currentRow) throw new WorkspaceError(`Workspace not found: ${id}`);
  const current = mapWorkspace(currentRow);

  let label = current.label;
  let rootPath = current.rootPath;
  try {
    if (input.label !== undefined) label = requireLabel(input.label);
    if (input.root !== undefined) rootPath = canonicalRoot(input.root);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workspace validation failed.";
    recordAudit(store, {
      operation: "workspace.update",
      targetIdentity: id,
      outcome: "rejected",
      reason: message,
      preRecordId: id,
      preVersion: current.version,
      postRecordId: null,
      postVersion: null,
    });
    throw error;
  }

  const duplicate = store.db
    .prepare("SELECT id FROM workspaces WHERE root_path = ? AND archived_at IS NULL AND id <> ?")
    .get(rootPath, id) as { id?: string } | undefined;
  if (duplicate?.id) {
    const message = `Workspace root is already configured: ${rootPath}`;
    recordAudit(store, {
      operation: "workspace.update",
      targetIdentity: id,
      outcome: "rejected",
      reason: message,
      preRecordId: id,
      preVersion: current.version,
      postRecordId: null,
      postVersion: null,
    });
    throw new WorkspaceError(message);
  }

  const updated: WorkspaceRecord = {
    ...current,
    label,
    rootPath,
    updatedAt: new Date().toISOString(),
    version: current.version + 1,
  };
  const commit = store.db.transaction(() => {
    store.db.prepare(`
      UPDATE workspaces
      SET label = ?, root_path = ?, updated_at = ?, version = ?
      WHERE id = ? AND archived_at IS NULL
    `).run(updated.label, updated.rootPath, updated.updatedAt, updated.version, id);
    recordAudit(store, {
      operation: "workspace.update",
      targetIdentity: id,
      outcome: "success",
      reason: "Workspace metadata updated.",
      preRecordId: id,
      preVersion: current.version,
      postRecordId: id,
      postVersion: updated.version,
    });
  });
  commit();
  return updated;
}

export function listWorkspaces(store: Store, options: { includeArchived?: boolean } = {}): WorkspaceRecord[] {
  const sql = options.includeArchived
    ? "SELECT * FROM workspaces ORDER BY created_at, id"
    : "SELECT * FROM workspaces WHERE archived_at IS NULL ORDER BY created_at, id";
  return (store.db.prepare(sql).all() as Record<string, unknown>[]).map(mapWorkspace);
}
