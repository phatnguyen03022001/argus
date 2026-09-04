import { mkdtemp, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

test("bounded discovery recognizes normal repositories and linked worktrees without descending into repositories or symlink cycles", async () => {
  const api = await import("../src/workspace-store");
  const root = await tempDir("argus-repository-discovery-");
  const repo = path.join(root, "repo");
  const linked = path.join(root, "linked");
  const ordinary = path.join(root, "ordinary");
  await mkdir(repo);
  await mkdir(ordinary);
  git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, "tracked.txt"), "tracked\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "fixture"]);
  git(repo, ["worktree", "add", "-b", "linked", linked]);

  const nested = path.join(repo, "nested");
  await mkdir(nested);
  git(nested, ["init", "-b", "nested"]);
  await symlink(root, path.join(ordinary, "cycle"), "dir");

  const discovered = await api.discoverRepositories(root);
  expect(discovered.map((entry) => ({ path: entry.path, kind: entry.kind }))).toEqual([
    { path: await realpath(linked), kind: "linked-worktree" },
    { path: await realpath(repo), kind: "working-tree" },
  ]);
  expect(discovered.some((entry) => entry.path === nested)).toBe(false);
});


test("local Git observation returns raw clean/dirty/branch/upstream evidence and leaves the repository byte-for-byte control state unchanged", async () => {
  const api = await import("../src/workspace-store");
  const root = await tempDir("argus-local-observation-");
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  await mkdir(remote);
  await mkdir(repo);
  git(remote, ["init", "--bare"]);
  git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, "tracked.txt"), "one\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "one"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  await writeFile(path.join(repo, "tracked.txt"), "two\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "two"]);
  await writeFile(path.join(repo, "dirty.txt"), "operator-owned\n", "utf8");

  const before = {
    head: git(repo, ["rev-parse", "HEAD"]),
    refs: git(repo, ["show-ref"]),
    config: await readFile(path.join(repo, ".git", "config"), "utf8"),
    index: await readFile(path.join(repo, ".git", "index")),
    tracked: await readFile(path.join(repo, "tracked.txt"), "utf8"),
    dirty: await readFile(path.join(repo, "dirty.txt"), "utf8"),
  };

  const observed = api.observeLocalRepository({ path: await realpath(repo), kind: "working-tree" });
  expect(observed).toMatchObject({
    head: before.head,
    branch: "main",
    detached: false,
    dirty: true,
    upstream: "origin/main",
    aheadBehind: { ahead: 1, behind: 0 },
  });
  expect(observed.remotes).toEqual([{ name: "origin", url: remote }]);
  expect(observed.gitDir).toBe(path.join(await realpath(repo), ".git"));
  expect(observed.commonDir).toBe(path.join(await realpath(repo), ".git"));

  const after = {
    head: git(repo, ["rev-parse", "HEAD"]),
    refs: git(repo, ["show-ref"]),
    config: await readFile(path.join(repo, ".git", "config"), "utf8"),
    index: await readFile(path.join(repo, ".git", "index")),
    tracked: await readFile(path.join(repo, "tracked.txt"), "utf8"),
    dirty: await readFile(path.join(repo, "dirty.txt"), "utf8"),
  };
  expect(after).toEqual(before);

  expect(() => api.runReadOnlyGit(repo, ["fetch"])).toThrow(/not allowed/i);
  expect(() => api.runReadOnlyGit(repo, ["reset", "--hard", "HEAD"])).toThrow(/not allowed/i);
});

test("production local Git observation leaves stale-stat repositories byte-for-byte unchanged", async () => {
  const api = await import("../src/workspace-store");
  const root = await tempDir("argus-stale-stat-observation-");
  const repo = path.join(root, "repo");
  await mkdir(repo);
  git(repo, ["init", "-b", "main"]);
  const tracked = path.join(repo, "tracked.txt");
  await writeFile(tracked, "tracked\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "fixture"]);
  git(repo, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);

  // Only mtime changes: default `git status` can refresh this stale index entry.
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(tracked, staleTime, staleTime);
  const before = {
    index: await readFile(path.join(repo, ".git", "index")),
    head: git(repo, ["rev-parse", "HEAD"]),
    refs: git(repo, ["show-ref"]),
    config: await readFile(path.join(repo, ".git", "config"), "utf8"),
    tracked: await readFile(tracked, "utf8"),
    remotes: git(repo, ["remote", "-v"]),
  };

  api.observeLocalRepository({ path: await realpath(repo), kind: "working-tree" });

  const after = {
    index: await readFile(path.join(repo, ".git", "index")),
    head: git(repo, ["rev-parse", "HEAD"]),
    refs: git(repo, ["show-ref"]),
    config: await readFile(path.join(repo, ".git", "config"), "utf8"),
    tracked: await readFile(tracked, "utf8"),
    remotes: git(repo, ["remote", "-v"]),
  };
  expect(after).toEqual(before);
});

test("local Git observation represents detached state explicitly", async () => {
  const api = await import("../src/workspace-store");
  const root = await tempDir("argus-detached-observation-");
  const repo = path.join(root, "repo");
  await mkdir(repo);
  git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, "tracked.txt"), "one\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "one"]);
  git(repo, ["checkout", "--detach"]);

  const observed = api.observeLocalRepository({ path: await realpath(repo), kind: "working-tree" });
  expect(observed.branch).toBeNull();
  expect(observed.detached).toBe(true);
  expect(observed.upstream).toBeNull();
  expect(observed.aheadBehind).toBeNull();
});


test("GitHub remote observation normalizes common aliases, resolves immutable identity/ref evidence, and never returns runner secrets", async () => {
  const api = await import("../src/workspace-store");
  expect(api.normalizeGitHubRemoteUrl("https://github.com/acme/widgets.git")).toBe("acme/widgets");
  expect(api.normalizeGitHubRemoteUrl("git@github.com:acme/widgets.git")).toBe("acme/widgets");
  expect(api.normalizeGitHubRemoteUrl("ssh://git@github.com/acme/widgets.git")).toBe("acme/widgets");
  expect(api.normalizeGitHubRemoteUrl("https://gitlab.com/acme/widgets.git")).toBeNull();

  const calls: string[][] = [];
  const runner = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (args[1] === "repos/acme/widgets") {
      return { status: 0, stdout: "4242\tAcme/Widgets\tmain\n", stderr: "" };
    }
    if (args[1] === "repos/acme/widgets/git/ref/heads/topic%2Fread-only") {
      return { status: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };

  const observed = api.observeGitHubRemote("git@github.com:acme/widgets.git", "topic/read-only", runner);
  expect(observed).toMatchObject({
    alias: "acme/widgets",
    repository: {
      id: "4242",
      canonicalAlias: "Acme/Widgets",
      defaultBranch: "main",
      availability: "AVAILABLE",
      freshness: "CURRENT",
    },
    ref: {
      name: "topic/read-only",
      sha: "0123456789abcdef0123456789abcdef01234567",
      availability: "AVAILABLE",
      freshness: "CURRENT",
    },
  });
  expect(calls).toHaveLength(2);
  expect(calls.every(([command]) => command === "gh")).toBe(true);
  expect(() => api.runReadOnlyGh(["api", "repos/acme/widgets", "--method", "POST"], runner)).toThrow(/not allowed/i);

  const unavailable = api.observeGitHubRemote(
    "https://github.com/acme/widgets.git",
    "main",
    () => ({ status: 1, stdout: "", stderr: "auth failed SENSITIVE_STDERR_SENTINEL" }),
  );
  expect(unavailable.repository).toMatchObject({ availability: "UNAVAILABLE", freshness: "UNKNOWN" });
  expect(unavailable.ref).toMatchObject({ availability: "UNAVAILABLE", freshness: "UNKNOWN" });
  expect(JSON.stringify(unavailable)).not.toContain("SENSITIVE_STDERR_SENTINEL");

  let nonGithubCalls = 0;
  const nonGithub = api.observeGitHubRemote("ssh://git@gitlab.com/acme/widgets.git", "main", () => {
    nonGithubCalls += 1;
    return { status: 0, stdout: "", stderr: "" };
  });
  expect(nonGithub.repository).toMatchObject({ availability: "UNKNOWN", freshness: "UNKNOWN" });
  expect(nonGithubCalls).toBe(0);
});


test("repository refresh adopts immutable GitHub identity, persists current evidence, and retains last-known values as stale after a failed refresh", async () => {
  const api = await import("../src/workspace-store");
  const dataRoot = await tempDir("argus-repository-store-");
  const workspaceRoot = await tempDir("argus-repository-workspace-");
  const repo = path.join(workspaceRoot, "repo");
  const linked = path.join(workspaceRoot, "linked");
  await mkdir(repo);
  git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, "tracked.txt"), "one\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "one"]);
  git(repo, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
  git(repo, ["worktree", "add", "-b", "linked", linked]);

  const unavailableRunner = () => ({ status: 1, stdout: "", stderr: "SENSITIVE_REFRESH_SENTINEL" });
  const successRunner = (_command: string, args: string[]) => {
    if (args[1] === "repos/acme/widgets") {
      return { status: 0, stdout: "4242\tAcme/Widgets\tmain\n", stderr: "" };
    }
    if (String(args[1]).includes("/git/ref/heads/")) {
      const sha = String(args[1]).endsWith("linked")
        ? "2222222222222222222222222222222222222222"
        : "1111111111111111111111111111111111111111";
      return { status: 0, stdout: `${sha}\n`, stderr: "" };
    }
    if (String(args[1]).includes("/compare/")) {
      return { status: 0, stdout: "behind\n", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };

  const store = api.openStore({ dataRoot });
  expect(api.readSchemaVersion(store.db)).toBe(api.CURRENT_SCHEMA_VERSION);
  const workspace = api.createWorkspace(store, { label: "Repositories", root: workspaceRoot });

  await api.refreshWorkspaceRepositories(store, workspace.id, {
    checkedAt: "2026-09-03T07:00:00.000Z",
    githubRunner: unavailableRunner,
  });
  const localOnly = api.listRepositoryViews(store, workspace.id);
  expect(localOnly).toHaveLength(2);
  expect(localOnly.every((entry) => entry.canonicalRepositoryIdentity.startsWith("git-common:"))).toBe(true);
  expect(localOnly.every((entry) => entry.github.repositoryAvailability === "UNAVAILABLE")).toBe(true);
  expect(JSON.stringify(localOnly)).not.toContain("SENSITIVE_REFRESH_SENTINEL");

  await api.refreshWorkspaceRepositories(store, workspace.id, {
    checkedAt: "2026-09-03T07:01:00.000Z",
    githubRunner: successRunner,
  });
  const current = api.listRepositoryViews(store, workspace.id);
  expect(current).toHaveLength(2);
  expect(current.every((entry) => entry.canonicalRepositoryIdentity === "github:4242")).toBe(true);
  expect(current.every((entry) => entry.github.repositoryId === "4242")).toBe(true);
  expect(current.every((entry) => entry.github.repositoryFreshness === "CURRENT")).toBe(true);
  expect(current.every((entry) => entry.github.refFreshness === "CURRENT")).toBe(true);
  expect(current.map((entry) => entry.github.refSha).sort()).toEqual([
    "1111111111111111111111111111111111111111",
    "2222222222222222222222222222222222222222",
  ]);
  expect(current.every((entry) => entry.github.relation!.relation === "LOCAL_BEHIND")).toBe(true);
  expect(current.every((entry) => entry.github.relation!.availability === "AVAILABLE")).toBe(true);
  expect(current.every((entry) => entry.github.relation!.freshness === "CURRENT")).toBe(true);
  expect(current.every((entry) => entry.github.relation!.localSha === entry.local.head)).toBe(true);
  expect(current.every((entry) => entry.github.relation!.githubSha === entry.github.refSha)).toBe(true);
  expect(current.every((entry) => entry.github.relation!.sourceVersion === `${entry.github.refSha}...${entry.local.head}`)).toBe(true);
  store.close();

  const reopened = api.openStore({ dataRoot });
  await api.refreshWorkspaceRepositories(reopened, workspace.id, {
    checkedAt: "2026-09-03T07:02:00.000Z",
    githubRunner: unavailableRunner,
  });
  const stale = api.listRepositoryViews(reopened, workspace.id);
  expect(stale.every((entry) => entry.canonicalRepositoryIdentity === "github:4242")).toBe(true);
  expect(stale.every((entry) => entry.github.repositoryAvailability === "UNAVAILABLE")).toBe(true);
  expect(stale.every((entry) => entry.github.repositoryFreshness === "STALE")).toBe(true);
  expect(stale.every((entry) => entry.github.refAvailability === "UNAVAILABLE")).toBe(true);
  expect(stale.every((entry) => entry.github.refFreshness === "STALE")).toBe(true);
  expect(stale.every((entry) => entry.github.repositoryObservedAt === "2026-09-03T07:01:00.000Z")).toBe(true);
  expect(stale.every((entry) => entry.github.repositoryCheckedAt === "2026-09-03T07:02:00.000Z")).toBe(true);
  expect(stale.map((entry) => entry.github.refSha).sort()).toEqual([
    "1111111111111111111111111111111111111111",
    "2222222222222222222222222222222222222222",
  ]);
  expect(stale.every((entry) => entry.github.relation!.relation === "LOCAL_BEHIND")).toBe(true);
  expect(stale.every((entry) => entry.github.relation!.availability === "UNAVAILABLE")).toBe(true);
  expect(stale.every((entry) => entry.github.relation!.freshness === "STALE")).toBe(true);
  expect(stale.every((entry) => entry.github.relation!.checkedAt === "2026-09-03T07:02:00.000Z")).toBe(true);
  reopened.close();
});

test("observation reconciliation preserves contradictory same-version evidence as an explicit conflict", async () => {
  const api = await import("../src/workspace-store");
  const dataRoot = await tempDir("argus-repository-conflict-");
  const workspaceRoot = await tempDir("argus-repository-conflict-workspace-");
  const repo = path.join(workspaceRoot, "repo");
  await mkdir(repo);
  git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, "tracked.txt"), "one\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "one"]);

  const store = api.openStore({ dataRoot });
  const workspace = api.createWorkspace(store, { label: "Conflict", root: workspaceRoot });
  await api.refreshWorkspaceRepositories(store, workspace.id, { checkedAt: "2026-09-03T08:00:00.000Z" });
  const [repository] = api.listRepositoryViews(store, workspace.id);
  expect(repository).toBeDefined();
  if (!repository) throw new Error("Repository fixture was not discovered.");

  const first = api.persistExternalObservation(store, {
    workspaceId: workspace.id,
    worktreeId: repository.worktreeId,
    sourceIdentity: "fixture:source",
    subjectIdentity: repository.canonicalRepositoryIdentity,
    kind: "fixture.conflict",
    value: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    absenceReason: null,
    observedAt: "2026-09-03T08:01:00.000Z",
    checkedAt: "2026-09-03T08:01:00.000Z",
    availability: "AVAILABLE",
    freshness: "CURRENT",
    sourceVersion: "immutable-version-1",
    provenance: "fixture:read-only",
  });
  const second = api.persistExternalObservation(store, {
    workspaceId: workspace.id,
    worktreeId: repository.worktreeId,
    sourceIdentity: "fixture:source",
    subjectIdentity: repository.canonicalRepositoryIdentity,
    kind: "fixture.conflict",
    value: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    absenceReason: null,
    observedAt: "2026-09-03T08:02:00.000Z",
    checkedAt: "2026-09-03T08:02:00.000Z",
    availability: "AVAILABLE",
    freshness: "CURRENT",
    sourceVersion: "immutable-version-1",
    provenance: "fixture:read-only",
  });
  expect(second.observationId).toBe(first.observationId);
  expect(second.conflictState).toBe("CONFLICTED");
  expect(second.value).toEqual({ sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  expect(second.conflictValue).toEqual({ sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
  const history = api.listObservationHistory(store, first.observationId);
  expect(history).toHaveLength(2);
  expect(history[0]?.conflictState).toBe("NONE");
  expect(history[1]?.conflictState).toBe("CONFLICTED");
  store.close();
});


test("Git remote normalization strips URL userinfo and query material before observation leaves the process boundary", async () => {
  const api = await import("../src/workspace-store");
  expect(api.sanitizeGitRemoteUrl("https://operator-user:operator-pass@github.com/acme/widgets.git?auth=opaque-value")).toBe(
    "https://github.com/acme/widgets.git",
  );
  expect(api.sanitizeGitRemoteUrl("ssh://git@github.com/acme/widgets.git")).toBe("ssh://git@github.com/acme/widgets.git");

  const root = await tempDir("argus-sanitized-remote-");
  const repo = path.join(root, "repo");
  await mkdir(repo);
  git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, "tracked.txt"), "one\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "one"]);
  git(repo, ["remote", "add", "origin", "https://operator-user:operator-pass@github.com/acme/widgets.git?auth=opaque-value"]);

  const observed = api.observeLocalRepository({ path: await realpath(repo), kind: "working-tree" });
  expect(observed.remotes).toEqual([{ name: "origin", url: "https://github.com/acme/widgets.git" }]);
  expect(JSON.stringify(observed)).not.toContain("operator-pass");
  expect(JSON.stringify(observed)).not.toContain("opaque-value");
});

test("a repository that cannot be rediscovered keeps last-known observations but marks them stale instead of current", async () => {
  const api = await import("../src/workspace-store");
  const dataRoot = await tempDir("argus-missing-repository-store-");
  const workspaceRoot = await tempDir("argus-missing-repository-workspace-");
  const repo = path.join(workspaceRoot, "repo");
  const movedRoot = await tempDir("argus-missing-repository-moved-");
  const moved = path.join(movedRoot, "repo");
  await mkdir(repo);
  git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, "tracked.txt"), "one\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "one"]);

  const store = api.openStore({ dataRoot });
  const workspace = api.createWorkspace(store, { label: "Missing repository", root: workspaceRoot });
  await api.refreshWorkspaceRepositories(store, workspace.id, { checkedAt: "2026-09-03T09:00:00.000Z" });
  const [current] = api.listRepositoryViews(store, workspace.id);
  expect(current?.local.freshness).toBe("CURRENT");
  const knownHead = current?.local.head;

  await import("node:fs/promises").then(({ rename }) => rename(repo, moved));
  await api.refreshWorkspaceRepositories(store, workspace.id, { checkedAt: "2026-09-03T09:01:00.000Z" });
  const [stale] = api.listRepositoryViews(store, workspace.id);
  expect(stale?.local.head).toBe(knownHead);
  expect(stale?.local.availability).toBe("UNAVAILABLE");
  expect(stale?.local.freshness).toBe("STALE");
  expect(stale?.local.observedAt).toBe("2026-09-03T09:00:00.000Z");
  expect(stale?.local.checkedAt).toBe("2026-09-03T09:01:00.000Z");
  expect(stale?.github.repositoryFreshness).toBe("UNKNOWN");
  expect(stale?.github.repositoryAvailability).toBe("UNKNOWN");
  store.close();
});


test("mutable local facts refresh normally at the same HEAD instead of becoming false conflicts", async () => {
  const api = await import("../src/workspace-store");
  const dataRoot = await tempDir("argus-mutable-local-store-");
  const workspaceRoot = await tempDir("argus-mutable-local-workspace-");
  const repo = path.join(workspaceRoot, "repo");
  await mkdir(repo);
  git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, "tracked.txt"), "one\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "one"]);
  const immutableHead = git(repo, ["rev-parse", "HEAD"]);

  const store = api.openStore({ dataRoot });
  const workspace = api.createWorkspace(store, { label: "Mutable local facts", root: workspaceRoot });
  await api.refreshWorkspaceRepositories(store, workspace.id, { checkedAt: "2026-09-03T09:10:00.000Z" });
  const sourceVersions = store.db.prepare(`
    SELECT observation_kind, source_version
    FROM repository_observations
    WHERE observation_kind IN (
      'git.identity', 'git.head', 'git.branch', 'git.detached',
      'git.dirty', 'git.remotes', 'git.upstream', 'git.ahead-behind'
    )
    ORDER BY event_id
  `).all() as Array<{ observation_kind: string; source_version: string | null }>;
  expect(Object.fromEntries(sourceVersions.map((row) => [row.observation_kind, row.source_version]))).toEqual({
    "git.identity": null,
    "git.head": immutableHead,
    "git.branch": null,
    "git.detached": null,
    "git.dirty": null,
    "git.remotes": null,
    "git.upstream": null,
    "git.ahead-behind": null,
  });
  await writeFile(path.join(repo, "untracked.txt"), "dirty\n", "utf8");
  await api.refreshWorkspaceRepositories(store, workspace.id, { checkedAt: "2026-09-03T09:11:00.000Z" });
  const latestDirty = store.db.prepare(`
    SELECT value_json, source_version, conflict_state
    FROM repository_observations
    WHERE observation_kind = 'git.dirty'
    ORDER BY event_id DESC
    LIMIT 1
  `).get() as { value_json: string; source_version: string | null; conflict_state: string };
  expect(JSON.parse(latestDirty.value_json)).toBe(true);
  expect(latestDirty.source_version).toBeNull();
  expect(latestDirty.conflict_state).toBe("NONE");
  store.close();
});

test("GitHub commit relation normalizes exact compare semantics and fails closed on malformed, unavailable, or identity-mismatched evidence", async () => {
  const api = await import("../src/workspace-store");
  const localSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const githubSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const cases = [
    ["identical", "IDENTICAL"],
    ["ahead", "LOCAL_AHEAD"],
    ["behind", "LOCAL_BEHIND"],
    ["diverged", "DIVERGED"],
  ] as const;

  for (const [status, expected] of cases) {
    const calls: string[][] = [];
    const observed = api.observeGitHubCommitRelation({
      alias: "acme/widgets",
      canonicalAlias: "Acme/Widgets",
      refName: "main",
      localSha,
      githubSha,
      runner: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return { status: 0, stdout: `${status}\n`, stderr: "" };
      },
    });
    expect(observed).toMatchObject({
      relation: expected,
      repositoryAlias: "Acme/Widgets",
      refName: "main",
      localSha,
      githubSha,
      availability: "AVAILABLE",
      freshness: "CURRENT",
      provenance: "system-gh:api:compare",
    });
    expect(observed.sourceVersion).toBe(`${githubSha}...${localSha}`);
    expect(calls).toEqual([["gh", "api", `repos/acme/widgets/compare/${githubSha}...${localSha}`, "--jq", ".status"]]);
  }

  const malformed = api.observeGitHubCommitRelation({
    alias: "acme/widgets",
    canonicalAlias: "Acme/Widgets",
    refName: "main",
    localSha,
    githubSha,
    runner: () => ({ status: 0, stdout: "sideways\n", stderr: "" }),
  });
  expect(malformed).toMatchObject({ relation: "UNKNOWN", availability: "UNAVAILABLE", freshness: "UNKNOWN", reason: "gh-compare-response-invalid" });

  const unavailable = api.observeGitHubCommitRelation({
    alias: "acme/widgets",
    canonicalAlias: "Acme/Widgets",
    refName: "main",
    localSha,
    githubSha,
    runner: () => ({ status: 1, stdout: "", stderr: "SECRET_SENTINEL" }),
  });
  expect(unavailable).toMatchObject({ relation: "UNKNOWN", availability: "UNAVAILABLE", freshness: "UNKNOWN", reason: "gh-api-unavailable" });
  expect(JSON.stringify(unavailable)).not.toContain("SECRET_SENTINEL");

  let mismatchCalls = 0;
  const mismatch = api.observeGitHubCommitRelation({
    alias: "acme/widgets",
    canonicalAlias: "other/widgets",
    refName: "main",
    localSha,
    githubSha,
    runner: () => {
      mismatchCalls += 1;
      return { status: 0, stdout: "identical\n", stderr: "" };
    },
  });
  expect(mismatch).toMatchObject({ relation: "UNKNOWN", availability: "UNAVAILABLE", freshness: "UNKNOWN", reason: "github-identity-mismatch" });
  expect(mismatchCalls).toBe(0);
});
