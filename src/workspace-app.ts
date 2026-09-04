import {
  archiveCredentialReference,
  createCredentialReference,
  listCredentialReferences,
  type CredentialReference,
} from "./credentials";
import {
  archiveEnvironmentProfile,
  createEnvironmentProfile,
  listEnvironmentProfiles,
  type EnvironmentProfile,
} from "./environments";
import {
  checkCredentialAvailability,
  MacOSKeychainAdapter,
  type CredentialAvailability,
  type CredentialSecretAdapter,
} from "./keychain";
import {
  listNeonProjectViews,
  refreshNeonProjectObservation,
  NeonObservationError,
  type NeonFetch,
  type NeonProjectObservation,
} from "./neon";
import {
  listRepositoryViews,
  refreshWorkspaceRepositories,
  type RepositoryView,
} from "./repository-observations";
import type { ProcessRunner } from "./repositories";
import { openStore } from "./persistence";
import { createWorkspace, listWorkspaces, type WorkspaceRecord } from "./workspaces";

export interface WorkspaceAppOptions {
  dataRoot?: string;
  credentialAdapter?: CredentialSecretAdapter;
}

export interface RepositoryRefreshRequestOptions extends WorkspaceAppOptions {
  checkedAt?: string;
  githubRunner?: ProcessRunner;
}

export interface NeonProjectRefreshRequestOptions extends WorkspaceAppOptions {
  checkedAt?: string;
  fetchImpl?: NeonFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface CredentialReferenceView extends CredentialReference {
  availability: CredentialAvailability;
}

export interface EnvironmentProfileView extends Omit<EnvironmentProfile, "credentialBindings"> {
  credentialBindings: Array<EnvironmentProfile["credentialBindings"][number] & { availability: CredentialAvailability }>;
}

export type AddWorkspaceResult =
  | { ok: true; workspace: WorkspaceRecord }
  | { ok: false; error: string };

export type CreateCredentialReferenceResult =
  | { ok: true; credential: CredentialReference }
  | { ok: false; error: string };

export type ArchiveCredentialReferenceResult =
  | { ok: true; credential: CredentialReference }
  | { ok: false; error: string };

export type CreateEnvironmentProfileResult =
  | { ok: true; environment: EnvironmentProfile }
  | { ok: false; error: string };

export type ArchiveEnvironmentProfileResult =
  | { ok: true; environment: EnvironmentProfile }
  | { ok: false; error: string };

export type RefreshNeonProjectResult =
  | { ok: true; project: NeonProjectObservation }
  | { ok: false; error: string };

export type RefreshWorkspaceRepositoriesResult =
  | { ok: true; repositories: RepositoryView[] }
  | { ok: false; error: string };

export function loadWorkspaceHome(options: WorkspaceAppOptions = {}): {
  workspaces: WorkspaceRecord[];
  repositories: RepositoryView[];
  credentials: CredentialReferenceView[];
  environments: EnvironmentProfileView[];
  neonProjects: NeonProjectObservation[];
} {
  const store = openStore(options);
  try {
    const workspaces = listWorkspaces(store);
    const adapter = options.credentialAdapter ?? new MacOSKeychainAdapter();
    const allCredentials = listCredentialReferences(store, { includeArchived: true });
    const activeCredentials = allCredentials.filter((credential) => credential.archivedAt === null);
    const credentials = activeCredentials.map((credential) => ({
      ...credential,
      availability: checkCredentialAvailability(
        credential,
        { operation: "credential.availability" },
        adapter,
      ).availability,
    }));
    const credentialById = new Map(allCredentials.map((credential) => [credential.id, credential]));
    const environments = listEnvironmentProfiles(store).map((environment) => ({
      ...environment,
      credentialBindings: environment.credentialBindings.map((binding) => {
        const credential = credentialById.get(binding.credentialReferenceId);
        const availability = !credential || credential.archivedAt !== null
          ? "UNAVAILABLE" as const
          : checkCredentialAvailability(
            credential,
            { operation: "environment.credential-availability" },
            adapter,
          ).availability;
        return { ...binding, availability };
      }),
    }));
    return {
      workspaces,
      repositories: workspaces.flatMap((workspace) => listRepositoryViews(store, workspace.id)),
      credentials,
      environments,
      neonProjects: listNeonProjectViews(store),
    };
  } finally {
    store.close();
  }
}

export function addWorkspaceRequest(
  input: { label: string; root: string },
  options: WorkspaceAppOptions = {},
): AddWorkspaceResult {
  const store = openStore(options);
  try {
    return { ok: true, workspace: createWorkspace(store, input) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Workspace could not be added." };
  } finally {
    store.close();
  }
}

export function createCredentialReferenceRequest(
  input: { externalSystem: string; keychainService: string; keychainAccount: string; label?: string },
  options: WorkspaceAppOptions = {},
): CreateCredentialReferenceResult {
  const store = openStore(options);
  try {
    return { ok: true, credential: createCredentialReference(store, input) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Credential reference could not be added." };
  } finally {
    store.close();
  }
}

export function archiveCredentialReferenceRequest(
  id: string,
  expectedVersion: number,
  options: WorkspaceAppOptions = {},
): ArchiveCredentialReferenceResult {
  const store = openStore(options);
  try {
    return { ok: true, credential: archiveCredentialReference(store, id, expectedVersion) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Credential reference could not be archived." };
  } finally {
    store.close();
  }
}

function safeRefreshError(error: unknown): string {
  if (error instanceof Error && /^(Active workspace not found|Repository discovery exceeded)/.test(error.message)) {
    return error.message;
  }
  return "Repository refresh failed; retained observations were not replaced.";
}

export async function refreshWorkspaceRepositoriesRequest(
  workspaceId: string,
  options: RepositoryRefreshRequestOptions = {},
): Promise<RefreshWorkspaceRepositoriesResult> {
  const store = openStore(options);
  try {
    const repositories = await refreshWorkspaceRepositories(store, workspaceId, {
      checkedAt: options.checkedAt,
      githubRunner: options.githubRunner,
    });
    return { ok: true, repositories };
  } catch (error) {
    return { ok: false, error: safeRefreshError(error) };
  } finally {
    store.close();
  }
}

export function createEnvironmentProfileRequest(
  input: {
    workspaceId: string;
    environmentName: string;
    label?: string;
    settings: Array<{ key: string; value: unknown }>;
    credentialBindings: Array<{ key: string; credentialReferenceId: string }>;
  },
  options: WorkspaceAppOptions = {},
): CreateEnvironmentProfileResult {
  const store = openStore(options);
  try {
    return { ok: true, environment: createEnvironmentProfile(store, input) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Environment profile could not be added." };
  } finally {
    store.close();
  }
}

export function archiveEnvironmentProfileRequest(
  id: string,
  expectedVersion: number,
  options: WorkspaceAppOptions = {},
): ArchiveEnvironmentProfileResult {
  const store = openStore(options);
  try {
    return { ok: true, environment: archiveEnvironmentProfile(store, id, expectedVersion) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Environment profile could not be archived." };
  } finally {
    store.close();
  }
}

export async function refreshNeonProjectRequest(
  environmentProfileId: string,
  options: NeonProjectRefreshRequestOptions = {},
): Promise<RefreshNeonProjectResult> {
  const store = openStore(options);
  try {
    const project = await refreshNeonProjectObservation(store, environmentProfileId, {
      credentialAdapter: options.credentialAdapter,
      checkedAt: options.checkedAt,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
    });
    return { ok: true, project };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof NeonObservationError
        ? error.message
        : "Neon project refresh failed.",
    };
  } finally {
    store.close();
  }
}
