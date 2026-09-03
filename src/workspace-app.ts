import { openStore } from "./persistence";
import { createWorkspace, listWorkspaces, type WorkspaceRecord } from "./workspaces";

export interface WorkspaceAppOptions {
  dataRoot?: string;
}

export type AddWorkspaceResult =
  | { ok: true; workspace: WorkspaceRecord }
  | { ok: false; error: string };

export function loadWorkspaceHome(options: WorkspaceAppOptions = {}): { workspaces: WorkspaceRecord[] } {
  const store = openStore(options);
  try {
    return { workspaces: listWorkspaces(store) };
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
