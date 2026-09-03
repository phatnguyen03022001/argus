import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test } from "vitest";

const roots: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

test("application add/list flow is durable, clear on rejection, and does not mutate the selected directory", async () => {
  const app = await import("../src/workspace-app");
  const ui = await import("../src/workspace-home");
  const dataRoot = await tempDir("argus-app-data-");
  const workspaceRoot = await tempDir("argus-app-workspace-");
  const marker = path.join(workspaceRoot, "operator-owned.txt");
  await writeFile(marker, "unchanged", "utf8");

  const empty = app.loadWorkspaceHome({ dataRoot });
  expect(renderToStaticMarkup(ui.WorkspaceHome({ workspaces: empty.workspaces }))).toContain("No workspaces configured");

  const added = app.addWorkspaceRequest({ label: "Argus Repo", root: workspaceRoot }, { dataRoot });
  expect(added.ok).toBe(true);
  const duplicate = app.addWorkspaceRequest({ label: "Again", root: workspaceRoot }, { dataRoot });
  expect(duplicate).toMatchObject({ ok: false });
  if (!duplicate.ok) expect(duplicate.error).toMatch(/already configured/i);

  const invalid = app.addWorkspaceRequest({ label: "Missing", root: path.join(workspaceRoot, "missing") }, { dataRoot });
  expect(invalid).toMatchObject({ ok: false });
  if (!invalid.ok) expect(invalid.error).toMatch(/does not exist/i);

  const home = app.loadWorkspaceHome({ dataRoot });
  expect(home.workspaces).toHaveLength(1);
  const markup = renderToStaticMarkup(ui.WorkspaceHome({ workspaces: home.workspaces, error: duplicate.ok ? undefined : duplicate.error }));
  expect(markup).toContain("Argus Repo");
  expect(markup).toContain(workspaceRoot);
  expect(markup).toContain("Add existing workspace");
  expect(markup).toContain("already configured");
  expect(markup).not.toMatch(/Git health|repository discovery|GitHub/i);
  expect(await readFile(marker, "utf8")).toBe("unchanged");
});
