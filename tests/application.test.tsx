import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Argus Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Argus Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
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
  const repo = path.join(workspaceRoot, "repo");
  await writeFile(marker, "unchanged", "utf8");
  await mkdir(repo);
  git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, "tracked.txt"), "tracked\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "fixture"]);
  git(repo, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);

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

  if (!added.ok) throw new Error("Workspace fixture was not added.");
  const refreshed = await app.refreshWorkspaceRepositoriesRequest(added.workspace.id, {
    dataRoot,
    checkedAt: "2026-09-03T10:00:00.000Z",
    githubRunner: (_command: string, args: string[]) => {
      if (args[1] === "repos/acme/widgets") return { status: 0, stdout: "4242\tAcme/Widgets\tmain\n", stderr: "" };
      if (String(args[1]).endsWith("/git/ref/heads/main")) return { status: 0, stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "unavailable" };
    },
  });
  expect(refreshed.ok).toBe(true);

  const home = app.loadWorkspaceHome({ dataRoot });
  expect(home.workspaces).toHaveLength(1);
  expect(home.repositories).toHaveLength(1);
  const markup = renderToStaticMarkup(ui.WorkspaceHome({
    workspaces: home.workspaces,
    repositories: home.repositories,
    error: duplicate.ok ? undefined : duplicate.error,
  }));
  expect(markup).toContain("Argus Repo");
  expect(markup).toContain(workspaceRoot);
  expect(markup).toContain("Add existing workspace");
  expect(markup).toContain("already configured");
  expect(markup).toContain("Refresh repositories");
  expect(markup).toContain("Repository observations");
  expect(markup).toContain("Acme/Widgets");
  expect(markup).toContain("working-tree");
  expect(markup).toContain("main");
  expect(markup).toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  expect(markup).toContain("CURRENT");
  expect(markup).toContain("AVAILABLE");
  expect(markup).toContain("2026-09-03T10:00:00.000Z");
  expect(markup).not.toMatch(/HEALTHY|LOCAL_AHEAD|REMOTE_AHEAD|DIVERGED|ATTENTION/i);

  const repository = home.repositories[0];
  if (!repository) throw new Error("Repository fixture was not observed.");
  const unavailableMarkup = renderToStaticMarkup(ui.WorkspaceHome({
    workspaces: home.workspaces,
    repositories: [{
      ...repository,
      local: { ...repository.local, availability: "UNAVAILABLE", freshness: "UNKNOWN", conflictState: "CONFLICTED" },
      github: {
        ...repository.github,
        repositoryAvailability: "UNAVAILABLE",
        repositoryFreshness: "UNKNOWN",
        repositoryConflictState: "CONFLICTED",
        refAvailability: "UNAVAILABLE",
        refFreshness: "UNKNOWN",
        refConflictState: "CONFLICTED",
      },
    }],
  }));
  expect(unavailableMarkup).toContain("UNAVAILABLE");
  expect(unavailableMarkup).toContain("UNKNOWN");
  expect(unavailableMarkup).toContain("CONFLICTED");
  expect(await readFile(marker, "utf8")).toBe("unchanged");
});
