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
  process.env.HOME = tempHome;

  const page = await import("../app/page");
  const route = await import("../app/workspaces/route");

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
