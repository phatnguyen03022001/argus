import { createHash } from "node:crypto";
import path from "node:path";
import { insertAudit, listAuditEntries, recordAudit, type AuditEntry } from "./audit";
import { CURRENT_SCHEMA_VERSION, readSchemaVersion, type Store } from "./persistence";
import { listWorkspaces, type WorkspaceRecord } from "./workspaces";

export const EXPORT_FORMAT_VERSION = 1;

interface ExportBody {
  formatVersion: number;
  schemaVersion: number;
  exportedAt: string;
  workspaces: WorkspaceRecord[];
  auditEntries: AuditEntry[];
}

interface ExportDocument extends ExportBody {
  integrity: { algorithm: "sha256"; digest: string };
}

function digestBody(body: ExportBody): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export function exportState(store: Store): string {
  const body: ExportBody = {
    formatVersion: EXPORT_FORMAT_VERSION,
    schemaVersion: readSchemaVersion(store.db),
    exportedAt: new Date().toISOString(),
    workspaces: listWorkspaces(store, { includeArchived: true }).sort((a, b) => a.id.localeCompare(b.id)),
    auditEntries: listAuditEntries(store).sort((a, b) => a.id.localeCompare(b.id)),
  };
  const document: ExportDocument = {
    ...body,
    integrity: { algorithm: "sha256", digest: digestBody(body) },
  };
  return JSON.stringify(document, null, 2);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid restore field: ${field}.`);
  return value;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireString(value, field);
}

function requireNullableInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value)) throw new Error(`Invalid restore field: ${field}.`);
  return Number(value);
}

function validateRestoreDocument(value: unknown): ExportDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid restore document.");
  const raw = value as Record<string, unknown>;
  if (raw.formatVersion !== EXPORT_FORMAT_VERSION) {
    throw new Error(`Unsupported export format version: ${String(raw.formatVersion)}.`);
  }
  if (raw.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported restore schema version: ${String(raw.schemaVersion)}.`);
  }
  if (!Array.isArray(raw.workspaces) || !Array.isArray(raw.auditEntries)) throw new Error("Invalid restore collections.");
  const exportedAt = requireString(raw.exportedAt, "exportedAt");

  const workspaces: WorkspaceRecord[] = raw.workspaces.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid workspace at index ${index}.`);
    const row = item as Record<string, unknown>;
    if (!isUuid(row.id)) throw new Error(`Invalid workspace identity at index ${index}.`);
    const rootPath = requireString(row.rootPath, `workspaces[${index}].rootPath`);
    if (!path.isAbsolute(rootPath)) throw new Error(`Workspace root must be absolute in restore at index ${index}.`);
    if (!Number.isInteger(row.version) || Number(row.version) < 1) throw new Error(`Invalid workspace version at index ${index}.`);
    return {
      id: row.id,
      label: requireString(row.label, `workspaces[${index}].label`),
      rootPath,
      createdAt: requireString(row.createdAt, `workspaces[${index}].createdAt`),
      updatedAt: requireString(row.updatedAt, `workspaces[${index}].updatedAt`),
      archivedAt: requireNullableString(row.archivedAt, `workspaces[${index}].archivedAt`),
      version: Number(row.version),
    };
  });

  const workspaceIds = new Set<string>();
  const activeRoots = new Set<string>();
  for (const workspace of workspaces) {
    if (workspaceIds.has(workspace.id)) throw new Error(`Duplicate workspace identity in restore: ${workspace.id}.`);
    workspaceIds.add(workspace.id);
    if (workspace.archivedAt === null) {
      if (activeRoots.has(workspace.rootPath)) throw new Error(`Duplicate active workspace root in restore: ${workspace.rootPath}.`);
      activeRoots.add(workspace.rootPath);
    }
  }

  const auditEntries: AuditEntry[] = raw.auditEntries.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid audit entry at index ${index}.`);
    const row = item as Record<string, unknown>;
    if (!isUuid(row.id)) throw new Error(`Invalid audit identity at index ${index}.`);
    if (row.actorCategory !== "operator" && row.actorCategory !== "system") throw new Error(`Invalid audit actor at index ${index}.`);
    if (row.outcome !== "success" && row.outcome !== "rejected") throw new Error(`Invalid audit outcome at index ${index}.`);
    const preRecordId = requireNullableString(row.preRecordId, `auditEntries[${index}].preRecordId`);
    const postRecordId = requireNullableString(row.postRecordId, `auditEntries[${index}].postRecordId`);
    if (preRecordId !== null && !workspaceIds.has(preRecordId)) throw new Error(`Invalid audit pre-record relationship at index ${index}.`);
    if (postRecordId !== null && !workspaceIds.has(postRecordId)) throw new Error(`Invalid audit post-record relationship at index ${index}.`);
    return {
      id: row.id,
      occurredAt: requireString(row.occurredAt, `auditEntries[${index}].occurredAt`),
      actorCategory: row.actorCategory,
      operation: requireString(row.operation, `auditEntries[${index}].operation`),
      targetIdentity: requireString(row.targetIdentity, `auditEntries[${index}].targetIdentity`),
      outcome: row.outcome,
      reason: requireString(row.reason, `auditEntries[${index}].reason`),
      preRecordId,
      preVersion: requireNullableInteger(row.preVersion, `auditEntries[${index}].preVersion`),
      postRecordId,
      postVersion: requireNullableInteger(row.postVersion, `auditEntries[${index}].postVersion`),
    };
  });

  const auditIds = new Set<string>();
  for (const entry of auditEntries) {
    if (auditIds.has(entry.id)) throw new Error(`Duplicate audit identity in restore: ${entry.id}.`);
    auditIds.add(entry.id);
  }

  const integrityRaw = raw.integrity;
  if (!integrityRaw || typeof integrityRaw !== "object" || Array.isArray(integrityRaw)) throw new Error("Restore integrity metadata is missing.");
  const integrity = integrityRaw as Record<string, unknown>;
  if (integrity.algorithm !== "sha256") throw new Error("Unsupported restore integrity algorithm.");
  const digest = requireString(integrity.digest, "integrity.digest");
  const body: ExportBody = {
    formatVersion: EXPORT_FORMAT_VERSION,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt,
    workspaces,
    auditEntries,
  };
  if (digestBody(body) !== digest) throw new Error("Restore integrity validation failed.");

  return { ...body, integrity: { algorithm: "sha256", digest } };
}

function recordRestoreRejection(store: Store, error: unknown): never {
  const message = error instanceof Error ? error.message : "Restore validation failed.";
  recordAudit(store, {
    actorCategory: "operator",
    operation: "state.restore",
    targetIdentity: "argus-store",
    outcome: "rejected",
    reason: message,
    preRecordId: null,
    preVersion: readSchemaVersion(store.db),
    postRecordId: null,
    postVersion: null,
  });
  throw error;
}

export function restoreState(store: Store, serialized: string): void {
  let document: ExportDocument;
  try {
    document = validateRestoreDocument(JSON.parse(serialized));
  } catch (error) {
    recordRestoreRejection(store, error);
  }

  const retainedRecoveryAudit = listAuditEntries(store).filter((entry) => entry.operation === "state.restore");

  const replace = store.db.transaction(() => {
    store.db.prepare("DELETE FROM audit_entries").run();
    store.db.prepare("DELETE FROM workspaces").run();

    const insertWorkspace = store.db.prepare(`
      INSERT INTO workspaces (id, label, root_path, created_at, updated_at, archived_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const workspace of document.workspaces) {
      insertWorkspace.run(
        workspace.id,
        workspace.label,
        workspace.rootPath,
        workspace.createdAt,
        workspace.updatedAt,
        workspace.archivedAt,
        workspace.version,
      );
    }

    const importedAuditIds = new Set(document.auditEntries.map((entry) => entry.id));
    for (const entry of document.auditEntries) insertAudit(store.db, entry);
    for (const entry of retainedRecoveryAudit) {
      if (!importedAuditIds.has(entry.id)) insertAudit(store.db, entry);
    }
    recordAudit(store, {
      actorCategory: "operator",
      operation: "state.restore",
      targetIdentity: "argus-store",
      outcome: "success",
      reason: "Validated state restore applied.",
      preRecordId: null,
      preVersion: CURRENT_SCHEMA_VERSION,
      postRecordId: null,
      postVersion: CURRENT_SCHEMA_VERSION,
    });
  });

  try {
    replace();
  } catch (error) {
    recordRestoreRejection(store, error);
  }
}
