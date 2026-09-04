import { createHash } from "node:crypto";
import type { Store } from "./persistence";
import {
  discoverRepositories,
  normalizeGitHubRemoteUrl,
  observeGitHubCommitRelation,
  observeGitHubRemote,
  observeLocalRepository,
  type EvidenceAvailability,
  type EvidenceFreshness,
  type ProcessRunner,
} from "./repositories";
import { listWorkspaces } from "./workspaces";

export type ObservationConflictState = "NONE" | "CONFLICTED";

export interface ExternalObservationInput {
  workspaceId: string;
  worktreeId: string;
  sourceIdentity: string;
  subjectIdentity: string;
  kind: string;
  value: unknown | null;
  absenceReason: string | null;
  observedAt: string;
  checkedAt: string;
  availability: EvidenceAvailability;
  freshness: EvidenceFreshness;
  sourceVersion: string | null;
  provenance: string;
}

export interface ExternalObservationRecord extends ExternalObservationInput {
  eventId: number;
  observationId: string;
  conflictState: ObservationConflictState;
  conflictValue: unknown | null;
}

interface ObservationRow {
  event_id: number;
  observation_id: string;
  workspace_id: string;
  worktree_id: string;
  source_identity: string;
  subject_identity: string;
  observation_kind: string;
  value_json: string | null;
  absence_reason: string | null;
  observed_at: string;
  checked_at: string;
  availability: EvidenceAvailability;
  freshness: EvidenceFreshness;
  source_version: string | null;
  provenance: string;
  conflict_state: ObservationConflictState;
  conflict_value_json: string | null;
}

interface WorktreeRow {
  id: string;
  workspace_id: string;
  local_path: string;
  repository_kind: "working-tree" | "linked-worktree";
  git_dir: string;
  common_dir: string;
  canonical_repository_identity: string;
  github_repository_id: string | null;
  github_alias: string | null;
  github_ref_name: string | null;
  remote_name: string | null;
  remote_url: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface RepositoryView {
  worktreeId: string;
  workspaceId: string;
  localPath: string;
  repositoryKind: "working-tree" | "linked-worktree";
  gitDir: string;
  commonDir: string;
  canonicalRepositoryIdentity: string;
  remoteName: string | null;
  remoteUrl: string | null;
  githubAlias: string | null;
  local: {
    head: string | null;
    branch: string | null;
    detached: boolean | null;
    dirty: boolean | null;
    remotes: Array<{ name: string; url: string }> | null;
    upstream: string | null;
    aheadBehind: { ahead: number; behind: number } | null;
    availability: EvidenceAvailability;
    freshness: EvidenceFreshness;
    observedAt: string | null;
    checkedAt: string | null;
    conflictState: ObservationConflictState;
  };
  github: {
    repositoryId: string | null;
    canonicalAlias: string | null;
    defaultBranch: string | null;
    repositoryAvailability: EvidenceAvailability;
    repositoryFreshness: EvidenceFreshness;
    repositoryObservedAt: string | null;
    repositoryCheckedAt: string | null;
    repositoryConflictState: ObservationConflictState;
    refName: string | null;
    refSha: string | null;
    refAvailability: EvidenceAvailability;
    refFreshness: EvidenceFreshness;
    refObservedAt: string | null;
    refCheckedAt: string | null;
    refConflictState: ObservationConflictState;
    relation?: {
      relation: "IDENTICAL" | "LOCAL_AHEAD" | "LOCAL_BEHIND" | "DIVERGED" | "UNKNOWN";
      repositoryAlias: string | null;
      refName: string | null;
      localSha: string | null;
      githubSha: string | null;
      availability: EvidenceAvailability;
      freshness: EvidenceFreshness;
      observedAt: string | null;
      checkedAt: string | null;
      conflictState: ObservationConflictState;
      sourceVersion: string | null;
      provenance: string | null;
    };
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicIdentity(prefix: string, ...parts: string[]): string {
  return `${prefix}:${sha256(parts.join("\u0000"))}`;
}

function observationIdentity(sourceIdentity: string, subjectIdentity: string, kind: string): string {
  return deterministicIdentity("observation", sourceIdentity, subjectIdentity, kind);
}

function encodeValue(value: unknown | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

function decodeValue(value: string | null): unknown | null {
  return value === null ? null : JSON.parse(value);
}

function mapObservation(row: ObservationRow): ExternalObservationRecord {
  return {
    eventId: Number(row.event_id),
    observationId: row.observation_id,
    workspaceId: row.workspace_id,
    worktreeId: row.worktree_id,
    sourceIdentity: row.source_identity,
    subjectIdentity: row.subject_identity,
    kind: row.observation_kind,
    value: decodeValue(row.value_json),
    absenceReason: row.absence_reason,
    observedAt: row.observed_at,
    checkedAt: row.checked_at,
    availability: row.availability,
    freshness: row.freshness,
    sourceVersion: row.source_version,
    provenance: row.provenance,
    conflictState: row.conflict_state,
    conflictValue: decodeValue(row.conflict_value_json),
  };
}

function latestAvailableObservation(store: Store, observationId: string): ObservationRow | undefined {
  return store.db.prepare(`
    SELECT * FROM repository_observations
    WHERE observation_id = ? AND availability = 'AVAILABLE'
    ORDER BY event_id DESC
    LIMIT 1
  `).get(observationId) as ObservationRow | undefined;
}

function insertObservation(
  store: Store,
  input: ExternalObservationInput,
  observationId: string,
  valueJson: string | null,
  absenceReason: string | null,
  observedAt: string,
  freshness: EvidenceFreshness,
  sourceVersion: string | null,
  conflictState: ObservationConflictState,
  conflictValueJson: string | null,
): ExternalObservationRecord {
  const result = store.db.prepare(`
    INSERT INTO repository_observations (
      observation_id, workspace_id, worktree_id, source_identity, subject_identity,
      observation_kind, value_json, absence_reason, observed_at, checked_at,
      availability, freshness, source_version, provenance, conflict_state, conflict_value_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    observationId,
    input.workspaceId,
    input.worktreeId,
    input.sourceIdentity,
    input.subjectIdentity,
    input.kind,
    valueJson,
    absenceReason,
    observedAt,
    input.checkedAt,
    input.availability,
    freshness,
    sourceVersion,
    input.provenance,
    conflictState,
    conflictValueJson,
  );
  const row = store.db.prepare("SELECT * FROM repository_observations WHERE event_id = ?").get(Number(result.lastInsertRowid)) as ObservationRow;
  return mapObservation(row);
}

export function persistExternalObservation(store: Store, input: ExternalObservationInput): ExternalObservationRecord {
  const observationId = observationIdentity(input.sourceIdentity, input.subjectIdentity, input.kind);
  const latestAvailable = latestAvailableObservation(store, observationId);
  const requestedValue = encodeValue(input.value);

  if (input.availability !== "AVAILABLE") {
    if (latestAvailable) {
      return insertObservation(
        store,
        input,
        observationId,
        latestAvailable.value_json,
        latestAvailable.absence_reason,
        latestAvailable.observed_at,
        "STALE",
        latestAvailable.source_version,
        latestAvailable.conflict_state,
        latestAvailable.conflict_value_json,
      );
    }
    return insertObservation(
      store,
      input,
      observationId,
      requestedValue,
      input.absenceReason,
      input.observedAt,
      "UNKNOWN",
      input.sourceVersion,
      "NONE",
      null,
    );
  }

  const sameVersionConflict = Boolean(
    latestAvailable
      && input.sourceVersion !== null
      && latestAvailable.source_version === input.sourceVersion
      && (latestAvailable.value_json !== requestedValue || latestAvailable.absence_reason !== input.absenceReason),
  );
  if (sameVersionConflict && latestAvailable) {
    return insertObservation(
      store,
      input,
      observationId,
      latestAvailable.value_json,
      latestAvailable.absence_reason,
      input.observedAt,
      input.freshness,
      input.sourceVersion,
      "CONFLICTED",
      requestedValue,
    );
  }

  return insertObservation(
    store,
    input,
    observationId,
    requestedValue,
    input.absenceReason,
    input.observedAt,
    input.freshness,
    input.sourceVersion,
    "NONE",
    null,
  );
}

export function listObservationHistory(store: Store, observationId: string): ExternalObservationRecord[] {
  return (store.db.prepare(`
    SELECT * FROM repository_observations
    WHERE observation_id = ?
    ORDER BY event_id
  `).all(observationId) as ObservationRow[]).map(mapObservation);
}

function latestObservationForKind(store: Store, worktreeId: string, kind: string): ExternalObservationRecord | null {
  const row = store.db.prepare(`
    SELECT * FROM repository_observations
    WHERE worktree_id = ? AND observation_kind = ?
    ORDER BY event_id DESC
    LIMIT 1
  `).get(worktreeId, kind) as ObservationRow | undefined;
  return row ? mapObservation(row) : null;
}

function primaryRemote(remotes: Array<{ name: string; url: string }>): { name: string; url: string } | null {
  return remotes.find((remote) => remote.name === "origin" && normalizeGitHubRemoteUrl(remote.url) !== null)
    ?? remotes.find((remote) => normalizeGitHubRemoteUrl(remote.url) !== null)
    ?? remotes.find((remote) => remote.name === "origin")
    ?? remotes[0]
    ?? null;
}

function requireWorkspace(store: Store, workspaceId: string): { id: string; rootPath: string } {
  const workspace = listWorkspaces(store).find((candidate) => candidate.id === workspaceId);
  if (!workspace) throw new Error(`Active workspace not found: ${workspaceId}`);
  return workspace;
}

function existingWorktreeByPath(store: Store, workspaceId: string, localPath: string): WorktreeRow | undefined {
  return store.db.prepare(`
    SELECT * FROM repository_worktrees
    WHERE workspace_id = ? AND local_path = ?
  `).get(workspaceId, localPath) as WorktreeRow | undefined;
}

function upsertWorktree(store: Store, input: {
  id: string;
  workspaceId: string;
  localPath: string;
  repositoryKind: "working-tree" | "linked-worktree";
  gitDir: string;
  commonDir: string;
  canonicalRepositoryIdentity: string;
  githubRepositoryId: string | null;
  githubAlias: string | null;
  githubRefName: string | null;
  remoteName: string | null;
  remoteUrl: string | null;
  checkedAt: string;
}): void {
  store.db.prepare(`
    INSERT INTO repository_worktrees (
      id, workspace_id, local_path, repository_kind, git_dir, common_dir,
      canonical_repository_identity, github_repository_id, github_alias, github_ref_name,
      remote_name, remote_url, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, local_path) DO UPDATE SET
      repository_kind = excluded.repository_kind,
      git_dir = excluded.git_dir,
      common_dir = excluded.common_dir,
      canonical_repository_identity = excluded.canonical_repository_identity,
      github_repository_id = excluded.github_repository_id,
      github_alias = excluded.github_alias,
      github_ref_name = excluded.github_ref_name,
      remote_name = excluded.remote_name,
      remote_url = excluded.remote_url,
      last_seen_at = excluded.last_seen_at
  `).run(
    input.id,
    input.workspaceId,
    input.localPath,
    input.repositoryKind,
    input.gitDir,
    input.commonDir,
    input.canonicalRepositoryIdentity,
    input.githubRepositoryId,
    input.githubAlias,
    input.githubRefName,
    input.remoteName,
    input.remoteUrl,
    input.checkedAt,
    input.checkedAt,
  );
}

function persistLocalObservations(store: Store, input: {
  workspaceId: string;
  worktreeId: string;
  commonIdentity: string;
  canonicalRepositoryIdentity: string;
  checkedAt: string;
  local: ReturnType<typeof observeLocalRepository>;
  repositoryKind: "working-tree" | "linked-worktree";
  localPath: string;
}): void {
  const sourceIdentity = `git:${input.commonIdentity}`;
  const subjectIdentity = `worktree:${input.worktreeId}`;
  const shared = {
    workspaceId: input.workspaceId,
    worktreeId: input.worktreeId,
    sourceIdentity,
    subjectIdentity,
    observedAt: input.checkedAt,
    checkedAt: input.checkedAt,
    availability: "AVAILABLE" as const,
    freshness: "CURRENT" as const,
    sourceVersion: null,
    provenance: "system-git:read-only",
  };
  const facts: Array<{ kind: string; value: unknown | null; absenceReason: string | null; sourceVersion: string | null }> = [
    {
      kind: "git.identity",
      value: {
        localPath: input.localPath,
        repositoryKind: input.repositoryKind,
        gitDir: input.local.gitDir,
        commonDir: input.local.commonDir,
        canonicalRepositoryIdentity: input.canonicalRepositoryIdentity,
      },
      absenceReason: null,
      sourceVersion: null,
    },
    { kind: "git.head", value: input.local.head, absenceReason: null, sourceVersion: input.local.head },
    { kind: "git.branch", value: input.local.branch, absenceReason: input.local.branch === null ? "detached" : null, sourceVersion: null },
    { kind: "git.detached", value: input.local.detached, absenceReason: null, sourceVersion: null },
    { kind: "git.dirty", value: input.local.dirty, absenceReason: null, sourceVersion: null },
    { kind: "git.remotes", value: input.local.remotes, absenceReason: input.local.remotes.length === 0 ? "no-remotes" : null, sourceVersion: null },
    { kind: "git.upstream", value: input.local.upstream, absenceReason: input.local.upstream === null ? "no-upstream" : null, sourceVersion: null },
    { kind: "git.ahead-behind", value: input.local.aheadBehind, absenceReason: input.local.aheadBehind === null ? "not-locally-provable" : null, sourceVersion: null },
  ];
  for (const fact of facts) persistExternalObservation(store, { ...shared, ...fact });
}

function persistGitHubObservations(store: Store, input: {
  workspaceId: string;
  worktreeId: string;
  knownRepositoryId: string | null;
  githubAlias: string | null;
  refName: string | null;
  checkedAt: string;
  github: ReturnType<typeof observeGitHubRemote>;
  relation: ReturnType<typeof observeGitHubCommitRelation>;
}): void {
  const repositorySourceIdentity = input.knownRepositoryId
    ? `github:${input.knownRepositoryId}`
    : input.githubAlias
      ? `github-alias:${input.githubAlias.toLowerCase()}`
      : `github-unresolved:${input.worktreeId}`;
  const repositorySubjectIdentity = input.knownRepositoryId
    ? `github:${input.knownRepositoryId}`
    : input.githubAlias
      ? `github-alias:${input.githubAlias.toLowerCase()}`
      : `worktree:${input.worktreeId}`;
  const repositoryValue = input.github.repository.id
    ? {
        id: input.github.repository.id,
        canonicalAlias: input.github.repository.canonicalAlias,
        defaultBranch: input.github.repository.defaultBranch,
      }
    : null;
  persistExternalObservation(store, {
    workspaceId: input.workspaceId,
    worktreeId: input.worktreeId,
    sourceIdentity: repositorySourceIdentity,
    subjectIdentity: repositorySubjectIdentity,
    kind: "github.repository",
    value: repositoryValue,
    absenceReason: input.github.repository.reason,
    observedAt: input.checkedAt,
    checkedAt: input.checkedAt,
    availability: input.github.repository.availability,
    freshness: input.github.repository.freshness,
    sourceVersion: null,
    provenance: input.github.provenance,
  });

  const refName = input.github.ref.name ?? input.refName;
  const refSubjectIdentity = `${repositorySubjectIdentity}:ref:${refName ?? "unknown"}`;
  persistExternalObservation(store, {
    workspaceId: input.workspaceId,
    worktreeId: input.worktreeId,
    sourceIdentity: repositorySourceIdentity,
    subjectIdentity: refSubjectIdentity,
    kind: "github.ref",
    value: input.github.ref.sha ? { name: refName, sha: input.github.ref.sha } : null,
    absenceReason: input.github.ref.reason,
    observedAt: input.checkedAt,
    checkedAt: input.checkedAt,
    availability: input.github.ref.availability,
    freshness: input.github.ref.freshness,
    sourceVersion: input.github.ref.sha,
    provenance: input.github.provenance,
  });

  persistExternalObservation(store, {
    workspaceId: input.workspaceId,
    worktreeId: input.worktreeId,
    sourceIdentity: repositorySourceIdentity,
    subjectIdentity: `${refSubjectIdentity}:relation`,
    kind: "github.relation",
    value: {
      relation: input.relation.relation,
      repositoryAlias: input.relation.repositoryAlias,
      refName: input.relation.refName,
      localSha: input.relation.localSha,
      githubSha: input.relation.githubSha,
    },
    absenceReason: input.relation.reason,
    observedAt: input.checkedAt,
    checkedAt: input.checkedAt,
    availability: input.relation.availability,
    freshness: input.relation.freshness,
    sourceVersion: input.relation.sourceVersion,
    provenance: input.relation.provenance,
  });
}

function markUndiscoveredWorktree(store: Store, row: WorktreeRow, checkedAt: string): void {
  const commonIdentity = deterministicIdentity("git-common", row.common_dir);
  const sourceIdentity = `git:${commonIdentity}`;
  const subjectIdentity = `worktree:${row.id}`;
  const localKinds = [
    "git.identity",
    "git.head",
    "git.branch",
    "git.detached",
    "git.dirty",
    "git.remotes",
    "git.upstream",
    "git.ahead-behind",
  ];
  for (const kind of localKinds) {
    persistExternalObservation(store, {
      workspaceId: row.workspace_id,
      worktreeId: row.id,
      sourceIdentity,
      subjectIdentity,
      kind,
      value: null,
      absenceReason: "repository-not-discovered",
      observedAt: checkedAt,
      checkedAt,
      availability: "UNAVAILABLE",
      freshness: "UNKNOWN",
      sourceVersion: null,
      provenance: "system-git:read-only",
    });
  }

  const githubSourceIdentity = row.github_repository_id
    ? `github:${row.github_repository_id}`
    : row.github_alias
      ? `github-alias:${row.github_alias.toLowerCase()}`
      : `github-unresolved:${row.id}`;
  const githubSubjectIdentity = row.github_repository_id
    ? `github:${row.github_repository_id}`
    : row.github_alias
      ? `github-alias:${row.github_alias.toLowerCase()}`
      : `worktree:${row.id}`;
  persistExternalObservation(store, {
    workspaceId: row.workspace_id,
    worktreeId: row.id,
    sourceIdentity: githubSourceIdentity,
    subjectIdentity: githubSubjectIdentity,
    kind: "github.repository",
    value: null,
    absenceReason: "repository-not-discovered",
    observedAt: checkedAt,
    checkedAt,
    availability: "UNKNOWN",
    freshness: "UNKNOWN",
    sourceVersion: null,
    provenance: "system-gh:not-attempted",
  });
  persistExternalObservation(store, {
    workspaceId: row.workspace_id,
    worktreeId: row.id,
    sourceIdentity: githubSourceIdentity,
    subjectIdentity: `${githubSubjectIdentity}:ref:${row.github_ref_name ?? "unknown"}`,
    kind: "github.ref",
    value: null,
    absenceReason: "repository-not-discovered",
    observedAt: checkedAt,
    checkedAt,
    availability: "UNKNOWN",
    freshness: "UNKNOWN",
    sourceVersion: null,
    provenance: "system-gh:not-attempted",
  });
  persistExternalObservation(store, {
    workspaceId: row.workspace_id,
    worktreeId: row.id,
    sourceIdentity: githubSourceIdentity,
    subjectIdentity: `${githubSubjectIdentity}:ref:${row.github_ref_name ?? "unknown"}:relation`,
    kind: "github.relation",
    value: null,
    absenceReason: "repository-not-discovered",
    observedAt: checkedAt,
    checkedAt,
    availability: "UNKNOWN",
    freshness: "UNKNOWN",
    sourceVersion: null,
    provenance: "system-gh:not-attempted",
  });
}

export async function refreshWorkspaceRepositories(
  store: Store,
  workspaceId: string,
  options: { checkedAt?: string; githubRunner?: ProcessRunner } = {},
): Promise<RepositoryView[]> {
  const workspace = requireWorkspace(store, workspaceId);
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const discovered = await discoverRepositories(workspace.rootPath);
  const previousWorktrees = store.db.prepare(`
    SELECT * FROM repository_worktrees
    WHERE workspace_id = ?
  `).all(workspace.id) as WorktreeRow[];

  const refresh = store.db.transaction((repositories: typeof discovered) => {
    const discoveredPaths = new Set(repositories.map((repository) => repository.path));
    for (const repository of repositories) {
      const local = observeLocalRepository(repository);
      const remote = primaryRemote(local.remotes);
      const existing = existingWorktreeByPath(store, workspace.id, repository.path);
      const worktreeId = existing?.id ?? deterministicIdentity("worktree", workspace.id, repository.path);
      const github = remote
        ? observeGitHubRemote(remote.url, local.branch, options.githubRunner)
        : observeGitHubRemote("", local.branch, options.githubRunner);
      const currentGithubId = github.repository.availability === "AVAILABLE" ? github.repository.id : null;
      const knownGithubId = currentGithubId ?? existing?.github_repository_id ?? null;
      const commonIdentity = deterministicIdentity("git-common", local.commonDir);
      const canonicalRepositoryIdentity = knownGithubId ? `github:${knownGithubId}` : commonIdentity;
      const githubAlias = github.repository.canonicalAlias
        ?? github.alias
        ?? existing?.github_alias
        ?? null;
      const refName = github.ref.name ?? existing?.github_ref_name ?? local.branch;
      const relation = observeGitHubCommitRelation({
        alias: github.alias,
        canonicalAlias: github.repository.canonicalAlias,
        refName,
        localSha: local.head,
        githubSha: github.ref.sha,
        runner: options.githubRunner,
      });

      upsertWorktree(store, {
        id: worktreeId,
        workspaceId: workspace.id,
        localPath: repository.path,
        repositoryKind: repository.kind,
        gitDir: local.gitDir,
        commonDir: local.commonDir,
        canonicalRepositoryIdentity,
        githubRepositoryId: knownGithubId,
        githubAlias,
        githubRefName: refName,
        remoteName: remote?.name ?? null,
        remoteUrl: remote?.url ?? null,
        checkedAt,
      });
      persistLocalObservations(store, {
        workspaceId: workspace.id,
        worktreeId,
        commonIdentity,
        canonicalRepositoryIdentity,
        checkedAt,
        local,
        repositoryKind: repository.kind,
        localPath: repository.path,
      });
      persistGitHubObservations(store, {
        workspaceId: workspace.id,
        worktreeId,
        knownRepositoryId: knownGithubId,
        githubAlias,
        refName,
        checkedAt,
        github,
        relation,
      });
    }
    for (const previous of previousWorktrees) {
      if (!discoveredPaths.has(previous.local_path)) markUndiscoveredWorktree(store, previous, checkedAt);
    }
  });
  refresh(discovered);
  return listRepositoryViews(store, workspaceId);
}

function observationValue<T>(record: ExternalObservationRecord | null): T | null {
  return record?.value == null ? null : record.value as T;
}

function defaultAvailability(record: ExternalObservationRecord | null): EvidenceAvailability {
  return record?.availability ?? "UNKNOWN";
}

function defaultFreshness(record: ExternalObservationRecord | null): EvidenceFreshness {
  return record?.freshness ?? "UNKNOWN";
}

function defaultConflict(record: ExternalObservationRecord | null): ObservationConflictState {
  return record?.conflictState ?? "NONE";
}

export function listRepositoryViews(store: Store, workspaceId: string): RepositoryView[] {
  const rows = store.db.prepare(`
    SELECT * FROM repository_worktrees
    WHERE workspace_id = ?
    ORDER BY local_path, id
  `).all(workspaceId) as WorktreeRow[];

  return rows.map((row) => {
    const head = latestObservationForKind(store, row.id, "git.head");
    const branch = latestObservationForKind(store, row.id, "git.branch");
    const detached = latestObservationForKind(store, row.id, "git.detached");
    const dirty = latestObservationForKind(store, row.id, "git.dirty");
    const remotes = latestObservationForKind(store, row.id, "git.remotes");
    const upstream = latestObservationForKind(store, row.id, "git.upstream");
    const aheadBehind = latestObservationForKind(store, row.id, "git.ahead-behind");
    const githubRepository = latestObservationForKind(store, row.id, "github.repository");
    const githubRef = latestObservationForKind(store, row.id, "github.ref");
    const githubRelation = latestObservationForKind(store, row.id, "github.relation");
    const repositoryValue = observationValue<{ id: string; canonicalAlias: string | null; defaultBranch: string | null }>(githubRepository);
    const refValue = observationValue<{ name: string | null; sha: string }>(githubRef);
    const relationValue = observationValue<{
      relation: "IDENTICAL" | "LOCAL_AHEAD" | "LOCAL_BEHIND" | "DIVERGED" | "UNKNOWN";
      repositoryAlias: string | null;
      refName: string | null;
      localSha: string | null;
      githubSha: string | null;
    }>(githubRelation);

    return {
      worktreeId: row.id,
      workspaceId: row.workspace_id,
      localPath: row.local_path,
      repositoryKind: row.repository_kind,
      gitDir: row.git_dir,
      commonDir: row.common_dir,
      canonicalRepositoryIdentity: row.canonical_repository_identity,
      remoteName: row.remote_name,
      remoteUrl: row.remote_url,
      githubAlias: row.github_alias,
      local: {
        head: observationValue<string>(head),
        branch: observationValue<string>(branch),
        detached: observationValue<boolean>(detached),
        dirty: observationValue<boolean>(dirty),
        remotes: observationValue<Array<{ name: string; url: string }>>(remotes),
        upstream: observationValue<string>(upstream),
        aheadBehind: observationValue<{ ahead: number; behind: number }>(aheadBehind),
        availability: defaultAvailability(head),
        freshness: defaultFreshness(head),
        observedAt: head?.observedAt ?? null,
        checkedAt: head?.checkedAt ?? null,
        conflictState: defaultConflict(head),
      },
      github: {
        repositoryId: row.github_repository_id ?? repositoryValue?.id ?? null,
        canonicalAlias: repositoryValue?.canonicalAlias ?? row.github_alias,
        defaultBranch: repositoryValue?.defaultBranch ?? null,
        repositoryAvailability: defaultAvailability(githubRepository),
        repositoryFreshness: defaultFreshness(githubRepository),
        repositoryObservedAt: githubRepository?.observedAt ?? null,
        repositoryCheckedAt: githubRepository?.checkedAt ?? null,
        repositoryConflictState: defaultConflict(githubRepository),
        refName: refValue?.name ?? row.github_ref_name,
        refSha: refValue?.sha ?? null,
        refAvailability: defaultAvailability(githubRef),
        refFreshness: defaultFreshness(githubRef),
        refObservedAt: githubRef?.observedAt ?? null,
        refCheckedAt: githubRef?.checkedAt ?? null,
        refConflictState: defaultConflict(githubRef),
        relation: {
          relation: relationValue?.relation ?? "UNKNOWN",
          repositoryAlias: relationValue?.repositoryAlias ?? null,
          refName: relationValue?.refName ?? row.github_ref_name,
          localSha: relationValue?.localSha ?? null,
          githubSha: relationValue?.githubSha ?? null,
          availability: defaultAvailability(githubRelation),
          freshness: defaultFreshness(githubRelation),
          observedAt: githubRelation?.observedAt ?? null,
          checkedAt: githubRelation?.checkedAt ?? null,
          conflictState: defaultConflict(githubRelation),
          sourceVersion: githubRelation?.sourceVersion ?? null,
          provenance: githubRelation?.provenance ?? null,
        },
      },
    };
  });
}
