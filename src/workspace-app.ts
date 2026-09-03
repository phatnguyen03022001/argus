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
}

export interface RepositoryRefreshRequestOptions extends WorkspaceAppOptions {
  checkedAt?: string;
  githubRunner?: ProcessRunner;
}

export type AddWorkspaceResult =
  | { ok: true; workspace: WorkspaceRecord }
  | { ok: false; error: string };

export type RefreshWorkspaceRepositoriesResult =
  | { ok: true; repositories: RepositoryView[] }
  | { ok: false; error: string };

export function loadWorkspaceHome(options: WorkspaceAppOptions = {}): {
  workspaces: WorkspaceRecord[];
  repositories: RepositoryView[];
} {
  const store = openStore(options);
  try {
    const workspaces = listWorkspaces(store);
    return {
      workspaces,
      repositories: workspaces.flatMap((workspace) => listRepositoryViews(store, workspace.id)),
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
