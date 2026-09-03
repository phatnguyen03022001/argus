import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test } from "vitest";

const roots: string[] = [];
const originalHome = process.env.HOME;

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
  process.env.HOME = originalHome;
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

test("Next adapter adds and renders a workspace through the same local capability", async () => {
  const tempHome = await tempDir("argus-next-home-");
  const workspaceRoot = await tempDir("argus-next-workspace-");
  const marker = path.join(workspaceRoot, "operator-owned.txt");
  await writeFile(marker, "unchanged", "utf8");
  git(workspaceRoot, ["init", "-b", "main"]);
  git(workspaceRoot, ["add", "operator-owned.txt"]);
  git(workspaceRoot, ["commit", "-m", "fixture"]);
  const fixtureHead = git(workspaceRoot, ["rev-parse", "HEAD"]);
  process.env.HOME = tempHome;

  const page = await import("../app/page");
  const route = await import("../app/workspaces/route");
  const repositoriesRoute = await import("../app/repositories/route");
  const app = await import("../src/workspace-app");

  const emptyHtml = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({}) }));
  expect(emptyHtml).toContain("No workspaces configured");

  const body = new URLSearchParams({ label: "Adapter Workspace", root: workspaceRoot });
  const response = await route.POST(new Request("http://127.0.0.1:3000/workspaces", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  }));
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("http://127.0.0.1:3000/");

  const populatedHtml = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({}) }));
  expect(populatedHtml).toContain("Adapter Workspace");
  expect(populatedHtml).toContain(workspaceRoot);

  const configured = app.loadWorkspaceHome();
  const workspace = configured.workspaces[0];
  expect(workspace).toBeDefined();
  if (!workspace) throw new Error("Workspace was not persisted.");
  const refresh = await repositoriesRoute.POST(new Request("http://127.0.0.1:3000/repositories", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ workspaceId: workspace.id }),
  }));
  expect(refresh.status).toBe(303);
  expect(refresh.headers.get("location")).toBe("http://127.0.0.1:3000/");

  const repositoryHtml = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({}) }));
  expect(repositoryHtml).toContain("Repository observations");
  expect(repositoryHtml).toContain("working-tree");
  expect(repositoryHtml).toContain("main");
  expect(repositoryHtml).toContain(fixtureHead);
  expect(repositoryHtml).toContain("AVAILABLE");
  expect(repositoryHtml).toContain("CURRENT");
  expect(repositoryHtml).toContain("UNKNOWN");
  expect(git(workspaceRoot, ["rev-parse", "HEAD"])).toBe(fixtureHead);

  const duplicate = await route.POST(new Request("http://127.0.0.1:3000/workspaces", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ label: "Duplicate", root: workspaceRoot }),
  }));
  expect(duplicate.status).toBe(303);
  const duplicateLocation = new URL(duplicate.headers.get("location") ?? "");
  expect(duplicateLocation.searchParams.get("error")).toMatch(/already configured/i);

  const errorHtml = renderToStaticMarkup(await page.default({
    searchParams: Promise.resolve({ error: duplicateLocation.searchParams.get("error") ?? undefined }),
  }));
  expect(errorHtml).toContain("already configured");
  expect(await readFile(marker, "utf8")).toBe("unchanged");

  const expectedDb = path.join(tempHome, "Library", "Application Support", "Argus", "argus.db");
  expect(await readFile(expectedDb)).toBeInstanceOf(Buffer);
});
