import { createHash } from "node:crypto";
import path from "node:path";
import { insertAudit, listAuditEntries, recordAudit, type AuditEntry } from "./audit";
import { listCredentialReferences, type CredentialReference } from "./credentials";
import { listEnvironmentProfiles, type EnvironmentProfile, type EnvironmentSettingValue } from "./environments";
import { CURRENT_SCHEMA_VERSION, readSchemaVersion, type Store } from "./persistence";
import { listWorkspaces, type WorkspaceRecord } from "./workspaces";

export const EXPORT_FORMAT_VERSION = 1;

type RepositoryKind = "working-tree" | "linked-worktree";
type Availability = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
type Freshness = "CURRENT" | "STALE" | "UNKNOWN";
type ConflictState = "NONE" | "CONFLICTED";

interface RepositoryWorktreeBackup {
  id: string;
  workspaceId: string;
  localPath: string;
  repositoryKind: RepositoryKind;
  gitDir: string;
  commonDir: string;
  canonicalRepositoryIdentity: string;
  githubRepositoryId: string | null;
  githubAlias: string | null;
  githubRefName: string | null;
  remoteName: string | null;
  remoteUrl: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface RepositoryObservationBackup {
  eventId: number;
  observationId: string;
  workspaceId: string;
  worktreeId: string;
  sourceIdentity: string;
  subjectIdentity: string;
  kind: string;
  valueJson: string | null;
  absenceReason: string | null;
  observedAt: string;
  checkedAt: string;
  availability: Availability;
  freshness: Freshness;
  sourceVersion: string | null;
  provenance: string;
  conflictState: ConflictState;
  conflictValueJson: string | null;
}

interface ExportBody {
  formatVersion: number;
  schemaVersion: number;
  exportedAt: string;
  workspaces: WorkspaceRecord[];
  credentialReferences: CredentialReference[];
  environmentProfiles: EnvironmentProfile[];
  repositoryWorktrees: RepositoryWorktreeBackup[];
  repositoryObservations: RepositoryObservationBackup[];
  auditEntries: AuditEntry[];
}

interface ExportDocument extends ExportBody {
  integrity: { algorithm: "sha256"; digest: string };
}

function digestBody(body: ExportBody): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function listRepositoryWorktrees(store: Store): RepositoryWorktreeBackup[] {
  const rows = store.db.prepare("SELECT * FROM repository_worktrees ORDER BY id").all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    localPath: String(row.local_path),
    repositoryKind: String(row.repository_kind) as RepositoryKind,
    gitDir: String(row.git_dir),
    commonDir: String(row.common_dir),
    canonicalRepositoryIdentity: String(row.canonical_repository_identity),
    githubRepositoryId: row.github_repository_id == null ? null : String(row.github_repository_id),
    githubAlias: row.github_alias == null ? null : String(row.github_alias),
    githubRefName: row.github_ref_name == null ? null : String(row.github_ref_name),
    remoteName: row.remote_name == null ? null : String(row.remote_name),
    remoteUrl: row.remote_url == null ? null : String(row.remote_url),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
  }));
}

function listRepositoryObservations(store: Store): RepositoryObservationBackup[] {
  const rows = store.db.prepare("SELECT * FROM repository_observations ORDER BY event_id").all() as Record<string, unknown>[];
  return rows.map((row) => ({
    eventId: Number(row.event_id),
    observationId: String(row.observation_id),
    workspaceId: String(row.workspace_id),
    worktreeId: String(row.worktree_id),
    sourceIdentity: String(row.source_identity),
    subjectIdentity: String(row.subject_identity),
    kind: String(row.observation_kind),
    valueJson: row.value_json == null ? null : String(row.value_json),
    absenceReason: row.absence_reason == null ? null : String(row.absence_reason),
    observedAt: String(row.observed_at),
    checkedAt: String(row.checked_at),
    availability: String(row.availability) as Availability,
    freshness: String(row.freshness) as Freshness,
    sourceVersion: row.source_version == null ? null : String(row.source_version),
    provenance: String(row.provenance),
    conflictState: String(row.conflict_state) as ConflictState,
    conflictValueJson: row.conflict_value_json == null ? null : String(row.conflict_value_json),
  }));
}

export function exportState(store: Store): string {
  const body: ExportBody = {
    formatVersion: EXPORT_FORMAT_VERSION,
    schemaVersion: readSchemaVersion(store.db),
    exportedAt: new Date().toISOString(),
    workspaces: listWorkspaces(store, { includeArchived: true }).sort((a, b) => a.id.localeCompare(b.id)),
    credentialReferences: listCredentialReferences(store, { includeArchived: true }).sort((a, b) => a.id.localeCompare(b.id)),
    environmentProfiles: listEnvironmentProfiles(store, { includeArchived: true }).sort((a, b) => a.id.localeCompare(b.id)),
    repositoryWorktrees: listRepositoryWorktrees(store),
    repositoryObservations: listRepositoryObservations(store),
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

function requireMetadata(value: unknown, field: string): string {
  const normalized = requireString(value, field).trim();
  if (!normalized || normalized.length > 255 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`Invalid restore field: ${field}.`);
  }
  return normalized;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireString(value, field);
}

function requireNullableMetadata(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireMetadata(value, field);
}

function requireNullableInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value)) throw new Error(`Invalid restore field: ${field}.`);
  return Number(value);
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`Invalid restore field: ${field}.`);
  return Number(value);
}

function requireAbsolutePath(value: unknown, field: string): string {
  const result = requireString(value, field);
  if (!path.isAbsolute(result)) throw new Error(`Restore path must be absolute: ${field}.`);
  return result;
}

function requireJsonString(value: unknown, field: string): string | null {
  if (value === null) return null;
  const result = requireString(value, field);
  try {
    JSON.parse(result);
  } catch {
    throw new Error(`Invalid restore JSON field: ${field}.`);
  }
  return result;
}

function requireEnvironmentKey(value: unknown, field: string, allowCredentialDesignation: boolean): string {
  const key = requireString(value, field).trim();
  if (!key || key.length > 255 || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new Error(`Invalid restore field: ${field}.`);
  }
  if (!allowCredentialDesignation && /(password|token|secret|private[_\- ]?key|api[_\- ]?key)/i.test(key)) {
    throw new Error(`Environment setting ${key} must use a credential binding.`);
  }
  return key;
}

function requireEnvironmentSettingValue(value: unknown, field: string): EnvironmentSettingValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Invalid restore scalar field: ${field}.`);
}

function assertNoSecretShapedKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretShapedKeys(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(secret|token|password|private[_-]?key|api[_-]?key)/i.test(key)) {
      throw new Error("Restore document contains a forbidden secret-shaped field.");
    }
    assertNoSecretShapedKeys(child);
  }
}

function validateRestoreDocument(value: unknown): ExportDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid restore document.");
  assertNoSecretShapedKeys(value);
  const raw = value as Record<string, unknown>;
  if (raw.formatVersion !== EXPORT_FORMAT_VERSION) {
    throw new Error(`Unsupported export format version: ${String(raw.formatVersion)}.`);
  }
  if (raw.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported restore schema version: ${String(raw.schemaVersion)}.`);
  }
  if (
    !Array.isArray(raw.workspaces)
    || !Array.isArray(raw.credentialReferences)
    || !Array.isArray(raw.environmentProfiles)
    || !Array.isArray(raw.repositoryWorktrees)
    || !Array.isArray(raw.repositoryObservations)
    || !Array.isArray(raw.auditEntries)
  ) throw new Error("Invalid restore collections.");
  const exportedAt = requireString(raw.exportedAt, "exportedAt");

  const workspaces: WorkspaceRecord[] = raw.workspaces.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid workspace at index ${index}.`);
    const row = item as Record<string, unknown>;
    if (!isUuid(row.id)) throw new Error(`Invalid workspace identity at index ${index}.`);
    const rootPath = requireAbsolutePath(row.rootPath, `workspaces[${index}].rootPath`);
    return {
      id: row.id,
      label: requireString(row.label, `workspaces[${index}].label`),
      rootPath,
      createdAt: requireString(row.createdAt, `workspaces[${index}].createdAt`),
      updatedAt: requireString(row.updatedAt, `workspaces[${index}].updatedAt`),
      archivedAt: requireNullableString(row.archivedAt, `workspaces[${index}].archivedAt`),
      version: requirePositiveInteger(row.version, `workspaces[${index}].version`),
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

  const appNativeIds = new Set(workspaceIds);
  const credentialReferences: CredentialReference[] = raw.credentialReferences.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid credential reference at index ${index}.`);
    const row = item as Record<string, unknown>;
    if (!isUuid(row.id)) throw new Error(`Invalid credential reference identity at index ${index}.`);
    if (appNativeIds.has(row.id)) throw new Error(`Duplicate app-native identity in restore: ${row.id}.`);
    const credential: CredentialReference = {
      id: row.id,
      externalSystem: requireMetadata(row.externalSystem, `credentialReferences[${index}].externalSystem`),
      keychainService: requireMetadata(row.keychainService, `credentialReferences[${index}].keychainService`),
      keychainAccount: requireMetadata(row.keychainAccount, `credentialReferences[${index}].keychainAccount`),
      label: requireNullableMetadata(row.label, `credentialReferences[${index}].label`),
      createdAt: requireString(row.createdAt, `credentialReferences[${index}].createdAt`),
      updatedAt: requireString(row.updatedAt, `credentialReferences[${index}].updatedAt`),
      archivedAt: requireNullableString(row.archivedAt, `credentialReferences[${index}].archivedAt`),
      version: requirePositiveInteger(row.version, `credentialReferences[${index}].version`),
    };
    appNativeIds.add(credential.id);
    return credential;
  });

  const activeLocators = new Set<string>();
  for (const credential of credentialReferences) {
    if (credential.archivedAt !== null) continue;
    const locator = `${credential.keychainService}\u0000${credential.keychainAccount}`;
    if (activeLocators.has(locator)) throw new Error("Duplicate active credential locator in restore.");
    activeLocators.add(locator);
  }

  const credentialIds = new Set(credentialReferences.map((credential) => credential.id));
  const credentialById = new Map(credentialReferences.map((credential) => [credential.id, credential]));
  const environmentProfiles: EnvironmentProfile[] = raw.environmentProfiles.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid environment profile at index ${index}.`);
    const row = item as Record<string, unknown>;
    if (!isUuid(row.id)) throw new Error(`Invalid environment profile identity at index ${index}.`);
    if (appNativeIds.has(row.id)) throw new Error(`Duplicate app-native identity in restore: ${row.id}.`);
    const workspaceId = requireString(row.workspaceId, `environmentProfiles[${index}].workspaceId`);
    if (!workspaceIds.has(workspaceId)) throw new Error(`Invalid environment workspace relationship at index ${index}.`);
    if (!Array.isArray(row.settings) || !Array.isArray(row.credentialBindings)) {
      throw new Error(`Invalid environment collections at index ${index}.`);
    }
    const settingKeys = new Set<string>();
    const settings = row.settings.map((setting, settingIndex) => {
      if (!setting || typeof setting !== "object" || Array.isArray(setting)) throw new Error(`Invalid environment setting at index ${index}:${settingIndex}.`);
      const rawSetting = setting as Record<string, unknown>;
      const key = requireEnvironmentKey(rawSetting.key, `environmentProfiles[${index}].settings[${settingIndex}].key`, false);
      if (settingKeys.has(key)) throw new Error(`Duplicate environment setting key in restore: ${key}.`);
      settingKeys.add(key);
      return { key, value: requireEnvironmentSettingValue(rawSetting.value, `environmentProfiles[${index}].settings[${settingIndex}].value`) };
    }).sort((a, b) => a.key.localeCompare(b.key));
    const bindingKeys = new Set<string>();
    const credentialBindings = row.credentialBindings.map((binding, bindingIndex) => {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error(`Invalid environment credential binding at index ${index}:${bindingIndex}.`);
      const rawBinding = binding as Record<string, unknown>;
      const key = requireEnvironmentKey(rawBinding.key, `environmentProfiles[${index}].credentialBindings[${bindingIndex}].key`, true);
      if (bindingKeys.has(key)) throw new Error(`Duplicate environment credential binding key in restore: ${key}.`);
      if (settingKeys.has(key)) throw new Error(`Environment setting and credential binding key collide in restore: ${key}.`);
      const credentialReferenceId = requireString(rawBinding.credentialReferenceId, `environmentProfiles[${index}].credentialBindings[${bindingIndex}].credentialReferenceId`);
      if (!credentialIds.has(credentialReferenceId)) throw new Error(`Invalid environment credential relationship at index ${index}:${bindingIndex}.`);
      bindingKeys.add(key);
      return { key, credentialReferenceId };
    }).sort((a, b) => a.key.localeCompare(b.key));
    const profile: EnvironmentProfile = {
      id: row.id,
      workspaceId,
      environmentName: requireMetadata(row.environmentName, `environmentProfiles[${index}].environmentName`),
      label: requireNullableMetadata(row.label, `environmentProfiles[${index}].label`),
      settings,
      credentialBindings,
      createdAt: requireString(row.createdAt, `environmentProfiles[${index}].createdAt`),
      updatedAt: requireString(row.updatedAt, `environmentProfiles[${index}].updatedAt`),
      archivedAt: requireNullableString(row.archivedAt, `environmentProfiles[${index}].archivedAt`),
      version: requirePositiveInteger(row.version, `environmentProfiles[${index}].version`),
    };
    if (profile.archivedAt === null) {
      for (const binding of profile.credentialBindings) {
        if (credentialById.get(binding.credentialReferenceId)?.archivedAt !== null) {
          throw new Error(`Environment credential binding must reference an active credential reference at index ${index}.`);
        }
      }
    }
    appNativeIds.add(profile.id);
    return profile;
  });

  const environmentIds = new Set<string>();
  const activeEnvironmentNames = new Set<string>();
  for (const profile of environmentProfiles) {
    if (environmentIds.has(profile.id)) throw new Error(`Duplicate environment profile identity in restore: ${profile.id}.`);
    environmentIds.add(profile.id);
    if (profile.archivedAt === null) {
      const key = `${profile.workspaceId}\u0000${profile.environmentName}`;
      if (activeEnvironmentNames.has(key)) throw new Error("Duplicate active environment name in restore.");
      activeEnvironmentNames.add(key);
    }
  }

  const repositoryWorktrees: RepositoryWorktreeBackup[] = raw.repositoryWorktrees.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid repository worktree at index ${index}.`);
    const row = item as Record<string, unknown>;
    const workspaceId = requireString(row.workspaceId, `repositoryWorktrees[${index}].workspaceId`);
    if (!workspaceIds.has(workspaceId)) throw new Error(`Invalid repository workspace relationship at index ${index}.`);
    const repositoryKind = row.repositoryKind;
    if (repositoryKind !== "working-tree" && repositoryKind !== "linked-worktree") {
      throw new Error(`Invalid repository kind at index ${index}.`);
    }
    return {
      id: requireString(row.id, `repositoryWorktrees[${index}].id`),
      workspaceId,
      localPath: requireAbsolutePath(row.localPath, `repositoryWorktrees[${index}].localPath`),
      repositoryKind,
      gitDir: requireAbsolutePath(row.gitDir, `repositoryWorktrees[${index}].gitDir`),
      commonDir: requireAbsolutePath(row.commonDir, `repositoryWorktrees[${index}].commonDir`),
      canonicalRepositoryIdentity: requireString(row.canonicalRepositoryIdentity, `repositoryWorktrees[${index}].canonicalRepositoryIdentity`),
      githubRepositoryId: requireNullableString(row.githubRepositoryId, `repositoryWorktrees[${index}].githubRepositoryId`),
      githubAlias: requireNullableString(row.githubAlias, `repositoryWorktrees[${index}].githubAlias`),
      githubRefName: requireNullableString(row.githubRefName, `repositoryWorktrees[${index}].githubRefName`),
      remoteName: requireNullableString(row.remoteName, `repositoryWorktrees[${index}].remoteName`),
      remoteUrl: requireNullableString(row.remoteUrl, `repositoryWorktrees[${index}].remoteUrl`),
      firstSeenAt: requireString(row.firstSeenAt, `repositoryWorktrees[${index}].firstSeenAt`),
      lastSeenAt: requireString(row.lastSeenAt, `repositoryWorktrees[${index}].lastSeenAt`),
    };
  });

  const worktreeIds = new Set<string>();
  const workspacePaths = new Set<string>();
  const worktreeWorkspace = new Map<string, string>();
  for (const worktree of repositoryWorktrees) {
    if (worktreeIds.has(worktree.id)) throw new Error(`Duplicate repository worktree identity in restore: ${worktree.id}.`);
    worktreeIds.add(worktree.id);
    worktreeWorkspace.set(worktree.id, worktree.workspaceId);
    const key = `${worktree.workspaceId}\u0000${worktree.localPath}`;
    if (workspacePaths.has(key)) throw new Error("Duplicate repository worktree path in restore.");
    workspacePaths.add(key);
  }

  const repositoryObservations: RepositoryObservationBackup[] = raw.repositoryObservations.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid repository observation at index ${index}.`);
    const row = item as Record<string, unknown>;
    const workspaceId = requireString(row.workspaceId, `repositoryObservations[${index}].workspaceId`);
    const worktreeId = requireString(row.worktreeId, `repositoryObservations[${index}].worktreeId`);
    if (!workspaceIds.has(workspaceId) || !worktreeIds.has(worktreeId) || worktreeWorkspace.get(worktreeId) !== workspaceId) {
      throw new Error(`Invalid repository observation relationship at index ${index}.`);
    }
    const availability = row.availability;
    if (availability !== "AVAILABLE" && availability !== "UNAVAILABLE" && availability !== "UNKNOWN") {
      throw new Error(`Invalid repository observation availability at index ${index}.`);
    }
    const freshness = row.freshness;
    if (freshness !== "CURRENT" && freshness !== "STALE" && freshness !== "UNKNOWN") {
      throw new Error(`Invalid repository observation freshness at index ${index}.`);
    }
    const conflictState = row.conflictState;
    if (conflictState !== "NONE" && conflictState !== "CONFLICTED") {
      throw new Error(`Invalid repository observation conflict state at index ${index}.`);
    }
    return {
      eventId: requirePositiveInteger(row.eventId, `repositoryObservations[${index}].eventId`),
      observationId: requireString(row.observationId, `repositoryObservations[${index}].observationId`),
      workspaceId,
      worktreeId,
      sourceIdentity: requireString(row.sourceIdentity, `repositoryObservations[${index}].sourceIdentity`),
      subjectIdentity: requireString(row.subjectIdentity, `repositoryObservations[${index}].subjectIdentity`),
      kind: requireString(row.kind, `repositoryObservations[${index}].kind`),
      valueJson: requireJsonString(row.valueJson, `repositoryObservations[${index}].valueJson`),
      absenceReason: requireNullableString(row.absenceReason, `repositoryObservations[${index}].absenceReason`),
      observedAt: requireString(row.observedAt, `repositoryObservations[${index}].observedAt`),
      checkedAt: requireString(row.checkedAt, `repositoryObservations[${index}].checkedAt`),
      availability,
      freshness,
      sourceVersion: requireNullableString(row.sourceVersion, `repositoryObservations[${index}].sourceVersion`),
      provenance: requireString(row.provenance, `repositoryObservations[${index}].provenance`),
      conflictState,
      conflictValueJson: requireJsonString(row.conflictValueJson, `repositoryObservations[${index}].conflictValueJson`),
    };
  });

  const eventIds = new Set<number>();
  for (const observation of repositoryObservations) {
    if (eventIds.has(observation.eventId)) throw new Error(`Duplicate repository observation event in restore: ${observation.eventId}.`);
    eventIds.add(observation.eventId);
  }

  const auditEntries: AuditEntry[] = raw.auditEntries.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid audit entry at index ${index}.`);
    const row = item as Record<string, unknown>;
    if (!isUuid(row.id)) throw new Error(`Invalid audit identity at index ${index}.`);
    if (row.actorCategory !== "operator" && row.actorCategory !== "system") throw new Error(`Invalid audit actor at index ${index}.`);
    if (row.outcome !== "success" && row.outcome !== "rejected") throw new Error(`Invalid audit outcome at index ${index}.`);
    const preRecordId = requireNullableString(row.preRecordId, `auditEntries[${index}].preRecordId`);
    const postRecordId = requireNullableString(row.postRecordId, `auditEntries[${index}].postRecordId`);
    if (preRecordId !== null && !appNativeIds.has(preRecordId)) throw new Error(`Invalid audit pre-record relationship at index ${index}.`);
    if (postRecordId !== null && !appNativeIds.has(postRecordId)) throw new Error(`Invalid audit post-record relationship at index ${index}.`);
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
    credentialReferences,
    environmentProfiles,
    repositoryWorktrees,
    repositoryObservations,
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
    store.db.prepare("DELETE FROM repository_observations").run();
    store.db.prepare("DELETE FROM repository_worktrees").run();
    store.db.prepare("DELETE FROM audit_entries").run();
    store.db.prepare("DELETE FROM environment_credential_bindings").run();
    store.db.prepare("DELETE FROM environment_settings").run();
    store.db.prepare("DELETE FROM environment_profiles").run();
    store.db.prepare("DELETE FROM credential_references").run();
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

    const insertCredential = store.db.prepare(`
      INSERT INTO credential_references (
        id, external_system, keychain_service, keychain_account, label,
        created_at, updated_at, archived_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const credential of document.credentialReferences) {
      insertCredential.run(
        credential.id,
        credential.externalSystem,
        credential.keychainService,
        credential.keychainAccount,
        credential.label,
        credential.createdAt,
        credential.updatedAt,
        credential.archivedAt,
        credential.version,
      );
    }

    const insertEnvironment = store.db.prepare(`
      INSERT INTO environment_profiles (
        id, workspace_id, environment_name, label, created_at, updated_at, archived_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEnvironmentSetting = store.db.prepare(`
      INSERT INTO environment_settings (profile_id, setting_key, value_json) VALUES (?, ?, ?)
    `);
    const insertEnvironmentBinding = store.db.prepare(`
      INSERT INTO environment_credential_bindings (profile_id, binding_key, credential_reference_id) VALUES (?, ?, ?)
    `);
    for (const profile of document.environmentProfiles) {
      insertEnvironment.run(
        profile.id, profile.workspaceId, profile.environmentName, profile.label,
        profile.createdAt, profile.updatedAt, profile.archivedAt, profile.version,
      );
      for (const setting of profile.settings) insertEnvironmentSetting.run(profile.id, setting.key, JSON.stringify(setting.value));
      for (const binding of profile.credentialBindings) insertEnvironmentBinding.run(profile.id, binding.key, binding.credentialReferenceId);
    }

    const insertWorktree = store.db.prepare(`
      INSERT INTO repository_worktrees (
        id, workspace_id, local_path, repository_kind, git_dir, common_dir,
        canonical_repository_identity, github_repository_id, github_alias, github_ref_name,
        remote_name, remote_url, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const worktree of document.repositoryWorktrees) {
      insertWorktree.run(
        worktree.id,
        worktree.workspaceId,
        worktree.localPath,
        worktree.repositoryKind,
        worktree.gitDir,
        worktree.commonDir,
        worktree.canonicalRepositoryIdentity,
        worktree.githubRepositoryId,
        worktree.githubAlias,
        worktree.githubRefName,
        worktree.remoteName,
        worktree.remoteUrl,
        worktree.firstSeenAt,
        worktree.lastSeenAt,
      );
    }

    const insertObservation = store.db.prepare(`
      INSERT INTO repository_observations (
        event_id, observation_id, workspace_id, worktree_id, source_identity, subject_identity,
        observation_kind, value_json, absence_reason, observed_at, checked_at,
        availability, freshness, source_version, provenance, conflict_state, conflict_value_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const observation of document.repositoryObservations) {
      insertObservation.run(
        observation.eventId,
        observation.observationId,
        observation.workspaceId,
        observation.worktreeId,
        observation.sourceIdentity,
        observation.subjectIdentity,
        observation.kind,
        observation.valueJson,
        observation.absenceReason,
        observation.observedAt,
        observation.checkedAt,
        observation.availability,
        observation.freshness,
        observation.sourceVersion,
        observation.provenance,
        observation.conflictState,
        observation.conflictValueJson,
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
