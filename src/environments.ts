import { createHash, randomUUID } from "node:crypto";
import { recordAudit } from "./audit";
import type { Store } from "./persistence";

export type EnvironmentSettingValue = string | number | boolean | null;

export interface EnvironmentSetting {
  key: string;
  value: EnvironmentSettingValue;
}

export interface EnvironmentCredentialBinding {
  key: string;
  credentialReferenceId: string;
}

export interface EnvironmentProfile {
  id: string;
  workspaceId: string;
  environmentName: string;
  label: string | null;
  settings: EnvironmentSetting[];
  credentialBindings: EnvironmentCredentialBinding[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  version: number;
}

export class EnvironmentProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentProfileError";
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requireMetadata(value: string, field: string, maxLength = 255): string {
  const normalized = value.trim();
  if (!normalized) throw new EnvironmentProfileError(`${field} is required.`);
  if (normalized.length > maxLength) throw new EnvironmentProfileError(`${field} is too long.`);
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new EnvironmentProfileError(`${field} contains unsupported control characters.`);
  }
  return normalized;
}

function optionalLabel(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  return requireMetadata(value, "Environment label");
}

function requireKey(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new EnvironmentProfileError(`${field} key is required.`);
  if (normalized.length > 255) throw new EnvironmentProfileError(`${field} key is too long.`);
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new EnvironmentProfileError(`${field} key contains unsupported control characters.`);
  }
  return normalized;
}

function designatesCredentialMaterial(key: string): boolean {
  return /(password|token|secret|private[_\- ]?key|api[_\- ]?key)/i.test(key);
}

function requireSettingValue(value: unknown): EnvironmentSettingValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new EnvironmentProfileError("Environment setting values must be scalar JSON values.");
}

function targetForInput(workspaceId: string, environmentName: string): string {
  return `environment-input:${createHash("sha256").update(`${workspaceId}\u0000${environmentName}`).digest("hex")}`;
}

function targetForId(id: string): string {
  return `environment-input:${createHash("sha256").update(id).digest("hex")}`;
}

function mapProfile(store: Store, row: Record<string, unknown>): EnvironmentProfile {
  const id = String(row.id);
  const settings = (store.db.prepare(`
    SELECT setting_key, value_json FROM environment_settings
    WHERE profile_id = ? ORDER BY setting_key
  `).all(id) as Array<{ setting_key: string; value_json: string }>).map((setting) => ({
    key: String(setting.setting_key),
    value: JSON.parse(String(setting.value_json)) as EnvironmentSettingValue,
  }));
  const credentialBindings = (store.db.prepare(`
    SELECT binding_key, credential_reference_id FROM environment_credential_bindings
    WHERE profile_id = ? ORDER BY binding_key
  `).all(id) as Array<{ binding_key: string; credential_reference_id: string }>).map((binding) => ({
    key: String(binding.binding_key),
    credentialReferenceId: String(binding.credential_reference_id),
  }));
  return {
    id,
    workspaceId: String(row.workspace_id),
    environmentName: String(row.environment_name),
    label: row.label == null ? null : String(row.label),
    settings,
    credentialBindings,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
    version: Number(row.version),
  };
}

function activeWorkspaceExists(store: Store, workspaceId: string): boolean {
  return Boolean(store.db.prepare("SELECT 1 FROM workspaces WHERE id = ? AND archived_at IS NULL").get(workspaceId));
}

function activeCredentialExists(store: Store, credentialReferenceId: string): boolean {
  return Boolean(store.db.prepare("SELECT 1 FROM credential_references WHERE id = ? AND archived_at IS NULL").get(credentialReferenceId));
}

function reject(store: Store, operation: string, targetIdentity: string, message: string): never {
  recordAudit(store, {
    operation,
    targetIdentity,
    outcome: "rejected",
    reason: message,
    preRecordId: null,
    preVersion: null,
    postRecordId: null,
    postVersion: null,
  });
  throw new EnvironmentProfileError(message);
}

export function createEnvironmentProfile(
  store: Store,
  input: {
    workspaceId: string;
    environmentName: string;
    label?: string;
    settings: Array<{ key: string; value: unknown }>;
    credentialBindings: Array<{ key: string; credentialReferenceId: string }>;
  },
): EnvironmentProfile {
  const targetIdentity = targetForInput(input.workspaceId, input.environmentName);
  let workspaceId: string;
  let environmentName: string;
  let label: string | null;
  let settings: EnvironmentSetting[];
  let credentialBindings: EnvironmentCredentialBinding[];
  try {
    workspaceId = input.workspaceId.trim();
    if (!isUuid(workspaceId) || !activeWorkspaceExists(store, workspaceId)) {
      throw new EnvironmentProfileError("Active workspace not found for environment profile.");
    }
    environmentName = requireMetadata(input.environmentName, "Environment name");
    label = optionalLabel(input.label);

    const settingKeys = new Set<string>();
    settings = input.settings.map((item) => {
      const key = requireKey(item.key, "Environment setting");
      if (designatesCredentialMaterial(key)) {
        throw new EnvironmentProfileError(`Environment setting ${key} must use a credential binding.`);
      }
      if (settingKeys.has(key)) throw new EnvironmentProfileError(`Duplicate setting key: ${key}.`);
      settingKeys.add(key);
      return { key, value: requireSettingValue(item.value) };
    }).sort((a, b) => a.key.localeCompare(b.key));

    const bindingKeys = new Set<string>();
    credentialBindings = input.credentialBindings.map((item) => {
      const key = requireKey(item.key, "Credential binding");
      if (bindingKeys.has(key)) throw new EnvironmentProfileError(`Duplicate credential binding key: ${key}.`);
      if (settingKeys.has(key)) throw new EnvironmentProfileError(`Credential binding key collides with environment setting key: ${key}.`);
      const credentialReferenceId = item.credentialReferenceId.trim();
      if (!isUuid(credentialReferenceId) || !activeCredentialExists(store, credentialReferenceId)) {
        throw new EnvironmentProfileError(`Credential binding ${key} must reference an active credential reference.`);
      }
      bindingKeys.add(key);
      return { key, credentialReferenceId };
    }).sort((a, b) => a.key.localeCompare(b.key));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Environment profile validation failed.";
    reject(store, "environment-profile.create", targetIdentity, message);
  }

  const duplicate = store.db.prepare(`
    SELECT id, version FROM environment_profiles
    WHERE workspace_id = ? AND environment_name = ? AND archived_at IS NULL
  `).get(workspaceId, environmentName) as { id?: string; version?: number } | undefined;
  if (duplicate?.id) {
    const message = "Environment name is already configured for this workspace.";
    recordAudit(store, {
      operation: "environment-profile.create",
      targetIdentity: String(duplicate.id),
      outcome: "rejected",
      reason: message,
      preRecordId: String(duplicate.id),
      preVersion: duplicate.version == null ? null : Number(duplicate.version),
      postRecordId: null,
      postVersion: null,
    });
    throw new EnvironmentProfileError(message);
  }

  const now = new Date().toISOString();
  const profile: EnvironmentProfile = {
    id: randomUUID(),
    workspaceId,
    environmentName,
    label,
    settings,
    credentialBindings,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    version: 1,
  };

  const commit = store.db.transaction(() => {
    store.db.prepare(`
      INSERT INTO environment_profiles (
        id, workspace_id, environment_name, label, created_at, updated_at, archived_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(profile.id, profile.workspaceId, profile.environmentName, profile.label, profile.createdAt, profile.updatedAt, profile.version);
    const insertSetting = store.db.prepare(`
      INSERT INTO environment_settings (profile_id, setting_key, value_json) VALUES (?, ?, ?)
    `);
    for (const setting of profile.settings) insertSetting.run(profile.id, setting.key, JSON.stringify(setting.value));
    const insertBinding = store.db.prepare(`
      INSERT INTO environment_credential_bindings (profile_id, binding_key, credential_reference_id) VALUES (?, ?, ?)
    `);
    for (const binding of profile.credentialBindings) insertBinding.run(profile.id, binding.key, binding.credentialReferenceId);
    recordAudit(store, {
      operation: "environment-profile.create",
      targetIdentity: profile.id,
      outcome: "success",
      reason: "Environment profile created.",
      preRecordId: null,
      preVersion: null,
      postRecordId: profile.id,
      postVersion: profile.version,
    });
  });
  commit();
  return profile;
}

export function listEnvironmentProfiles(
  store: Store,
  options: { includeArchived?: boolean; workspaceId?: string } = {},
): EnvironmentProfile[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (!options.includeArchived) clauses.push("archived_at IS NULL");
  if (options.workspaceId) {
    clauses.push("workspace_id = ?");
    params.push(options.workspaceId);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = store.db.prepare(`SELECT * FROM environment_profiles${where} ORDER BY workspace_id, environment_name, id`).all(...params) as Record<string, unknown>[];
  return rows.map((row) => mapProfile(store, row));
}

export function archiveEnvironmentProfile(store: Store, id: string, expectedVersion: number): EnvironmentProfile {
  if (!isUuid(id)) reject(store, "environment-profile.archive", targetForId(id), "Environment profile identity is invalid.");
  const row = store.db.prepare("SELECT * FROM environment_profiles WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) reject(store, "environment-profile.archive", id, `Environment profile not found: ${id}`);
  const current = mapProfile(store, row);
  if (current.archivedAt !== null) {
    const message = `Environment profile is already archived: ${id}`;
    recordAudit(store, {
      operation: "environment-profile.archive",
      targetIdentity: id,
      outcome: "rejected",
      reason: message,
      preRecordId: id,
      preVersion: current.version,
      postRecordId: null,
      postVersion: null,
    });
    throw new EnvironmentProfileError(message);
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1 || current.version !== expectedVersion) {
    const message = "Environment profile version conflict.";
    recordAudit(store, {
      operation: "environment-profile.archive",
      targetIdentity: id,
      outcome: "rejected",
      reason: message,
      preRecordId: id,
      preVersion: current.version,
      postRecordId: null,
      postVersion: null,
    });
    throw new EnvironmentProfileError(message);
  }

  const now = new Date().toISOString();
  const archived = { ...current, updatedAt: now, archivedAt: now, version: current.version + 1 };
  const commit = store.db.transaction(() => {
    const result = store.db.prepare(`
      UPDATE environment_profiles SET updated_at = ?, archived_at = ?, version = ?
      WHERE id = ? AND archived_at IS NULL AND version = ?
    `).run(archived.updatedAt, archived.archivedAt, archived.version, id, expectedVersion);
    if (result.changes !== 1) throw new EnvironmentProfileError("Environment profile version conflict.");
    recordAudit(store, {
      operation: "environment-profile.archive",
      targetIdentity: id,
      outcome: "success",
      reason: "Environment profile archived.",
      preRecordId: id,
      preVersion: current.version,
      postRecordId: id,
      postVersion: archived.version,
    });
  });
  commit();
  return archived;
}
