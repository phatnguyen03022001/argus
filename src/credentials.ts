import { createHash, randomUUID } from "node:crypto";
import { recordAudit } from "./audit";
import type { Store } from "./persistence";

export interface CredentialReference {
  id: string;
  externalSystem: string;
  keychainService: string;
  keychainAccount: string;
  label: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  version: number;
}

export class CredentialReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialReferenceError";
  }
}

function requireMetadata(value: string, field: string, maxLength = 255): string {
  const normalized = value.trim();
  if (!normalized) throw new CredentialReferenceError(`${field} is required.`);
  if (normalized.length > maxLength) throw new CredentialReferenceError(`${field} is too long.`);
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new CredentialReferenceError(`${field} contains unsupported control characters.`);
  }
  return normalized;
}

function optionalLabel(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  return requireMetadata(value, "Credential label");
}

function mapCredentialReference(row: Record<string, unknown>): CredentialReference {
  return {
    id: String(row.id),
    externalSystem: String(row.external_system),
    keychainService: String(row.keychain_service),
    keychainAccount: String(row.keychain_account),
    label: row.label == null ? null : String(row.label),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archivedAt: row.archived_at == null ? null : String(row.archived_at),
    version: Number(row.version),
  };
}

function targetForLocator(service: string, account: string): string {
  return `credential-input:${createHash("sha256").update(`${service}\u0000${account}`).digest("hex")}`;
}

function targetForId(id: string): string {
  return `credential-input:${createHash("sha256").update(id).digest("hex")}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function createCredentialReference(
  store: Store,
  input: { externalSystem: string; keychainService: string; keychainAccount: string; label?: string },
): CredentialReference {
  let externalSystem: string;
  let keychainService: string;
  let keychainAccount: string;
  let label: string | null;
  try {
    externalSystem = requireMetadata(input.externalSystem, "External system");
    keychainService = requireMetadata(input.keychainService, "Keychain service");
    keychainAccount = requireMetadata(input.keychainAccount, "Keychain account");
    label = optionalLabel(input.label);
  } catch (error) {
    recordAudit(store, {
      operation: "credential-reference.create",
      targetIdentity: targetForLocator(input.keychainService, input.keychainAccount),
      outcome: "rejected",
      reason: error instanceof Error ? error.message : "Credential reference validation failed.",
      preRecordId: null,
      preVersion: null,
      postRecordId: null,
      postVersion: null,
    });
    throw error;
  }

  const duplicate = store.db.prepare(`
    SELECT id, version FROM credential_references
    WHERE keychain_service = ? AND keychain_account = ? AND archived_at IS NULL
  `).get(keychainService, keychainAccount) as { id?: string; version?: number } | undefined;
  if (duplicate?.id) {
    const message = "Credential reference locator is already configured.";
    recordAudit(store, {
      operation: "credential-reference.create",
      targetIdentity: String(duplicate.id),
      outcome: "rejected",
      reason: message,
      preRecordId: String(duplicate.id),
      preVersion: duplicate.version == null ? null : Number(duplicate.version),
      postRecordId: null,
      postVersion: null,
    });
    throw new CredentialReferenceError(message);
  }

  const now = new Date().toISOString();
  const credential: CredentialReference = {
    id: randomUUID(),
    externalSystem,
    keychainService,
    keychainAccount,
    label,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    version: 1,
  };

  const commit = store.db.transaction(() => {
    store.db.prepare(`
      INSERT INTO credential_references (
        id, external_system, keychain_service, keychain_account, label,
        created_at, updated_at, archived_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      credential.id,
      credential.externalSystem,
      credential.keychainService,
      credential.keychainAccount,
      credential.label,
      credential.createdAt,
      credential.updatedAt,
      credential.version,
    );
    recordAudit(store, {
      operation: "credential-reference.create",
      targetIdentity: credential.id,
      outcome: "success",
      reason: "Credential reference created.",
      preRecordId: null,
      preVersion: null,
      postRecordId: credential.id,
      postVersion: credential.version,
    });
  });
  commit();
  return credential;
}

export function listCredentialReferences(
  store: Store,
  options: { includeArchived?: boolean } = {},
): CredentialReference[] {
  const sql = options.includeArchived
    ? "SELECT * FROM credential_references ORDER BY created_at, id"
    : "SELECT * FROM credential_references WHERE archived_at IS NULL ORDER BY created_at, id";
  return (store.db.prepare(sql).all() as Record<string, unknown>[]).map(mapCredentialReference);
}

export function archiveCredentialReference(
  store: Store,
  id: string,
  expectedVersion: number,
): CredentialReference {
  if (!isUuid(id)) {
    const message = "Credential reference identity is invalid.";
    recordAudit(store, {
      operation: "credential-reference.archive",
      targetIdentity: targetForId(id),
      outcome: "rejected",
      reason: message,
      preRecordId: null,
      preVersion: null,
      postRecordId: null,
      postVersion: null,
    });
    throw new CredentialReferenceError(message);
  }

  const row = store.db.prepare("SELECT * FROM credential_references WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) {
    const message = `Credential reference not found: ${id}`;
    recordAudit(store, {
      operation: "credential-reference.archive",
      targetIdentity: id,
      outcome: "rejected",
      reason: message,
      preRecordId: null,
      preVersion: null,
      postRecordId: null,
      postVersion: null,
    });
    throw new CredentialReferenceError(message);
  }
  const current = mapCredentialReference(row);
  if (current.archivedAt !== null) {
    const message = `Credential reference is already archived: ${id}`;
    recordAudit(store, {
      operation: "credential-reference.archive",
      targetIdentity: id,
      outcome: "rejected",
      reason: message,
      preRecordId: id,
      preVersion: current.version,
      postRecordId: null,
      postVersion: null,
    });
    throw new CredentialReferenceError(message);
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1 || current.version !== expectedVersion) {
    const message = "Credential reference version conflict.";
    recordAudit(store, {
      operation: "credential-reference.archive",
      targetIdentity: id,
      outcome: "rejected",
      reason: message,
      preRecordId: id,
      preVersion: current.version,
      postRecordId: null,
      postVersion: null,
    });
    throw new CredentialReferenceError(message);
  }

  const activeEnvironmentBinding = store.db.prepare(`
    SELECT environment_profiles.id
    FROM environment_credential_bindings
    JOIN environment_profiles ON environment_profiles.id = environment_credential_bindings.profile_id
    WHERE environment_credential_bindings.credential_reference_id = ?
      AND environment_profiles.archived_at IS NULL
    LIMIT 1
  `).get(id) as { id?: string } | undefined;
  if (activeEnvironmentBinding?.id) {
    const message = "Credential reference is bound to an active environment profile.";
    recordAudit(store, {
      operation: "credential-reference.archive", targetIdentity: id, outcome: "rejected", reason: message,
      preRecordId: id, preVersion: current.version, postRecordId: null, postVersion: null,
    });
    throw new CredentialReferenceError(message);
  }

  const now = new Date().toISOString();
  const archived: CredentialReference = {
    ...current,
    updatedAt: now,
    archivedAt: now,
    version: current.version + 1,
  };
  const commit = store.db.transaction(() => {
    const result = store.db.prepare(`
      UPDATE credential_references
      SET updated_at = ?, archived_at = ?, version = ?
      WHERE id = ? AND archived_at IS NULL AND version = ?
    `).run(archived.updatedAt, archived.archivedAt, archived.version, id, expectedVersion);
    if (result.changes !== 1) throw new CredentialReferenceError("Credential reference version conflict.");
    recordAudit(store, {
      operation: "credential-reference.archive",
      targetIdentity: id,
      outcome: "success",
      reason: "Credential reference archived.",
      preRecordId: id,
      preVersion: current.version,
      postRecordId: id,
      postVersion: archived.version,
    });
  });
  commit();
  return archived;
}
