import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { WorkspaceHome } from "../src/workspace-home";
import type { RepositoryView } from "../src/repository-observations";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function repository(input: {
  worktreeId: string;
  localPath: string;
  identity: string;
  dirty?: boolean;
  upstream?: string | null;
  conflict?: boolean;
}): RepositoryView {
  return {
    worktreeId: input.worktreeId,
    workspaceId: "workspace:1",
    localPath: input.localPath,
    repositoryKind: "working-tree",
    gitDir: `${input.localPath}/.git`,
    commonDir: `${input.localPath}/.git`,
    canonicalRepositoryIdentity: input.identity,
    remoteName: "origin",
    remoteUrl: "https://github.com/acme/widgets.git",
    githubAlias: "acme/widgets",
    local: {
      head: SHA,
      branch: "main",
      detached: false,
      dirty: input.dirty ?? false,
      remotes: [{ name: "origin", url: "https://github.com/acme/widgets.git" }],
      upstream: input.upstream === undefined ? "origin/main" : input.upstream,
      aheadBehind: input.upstream === null ? null : { ahead: 0, behind: 0 },
      availability: "AVAILABLE",
      freshness: "CURRENT",
      observedAt: "2026-09-04T08:00:00.000Z",
      checkedAt: "2026-09-04T08:00:00.000Z",
      conflictState: "NONE",
    },
    github: {
      repositoryId: "4242",
      canonicalAlias: "Acme/Widgets",
      defaultBranch: "main",
      repositoryAvailability: "AVAILABLE",
      repositoryFreshness: "CURRENT",
      repositoryObservedAt: "2026-09-04T08:00:00.000Z",
      repositoryCheckedAt: "2026-09-04T08:00:00.000Z",
      repositoryConflictState: "NONE",
      refName: "main",
      refSha: SHA,
      refAvailability: "AVAILABLE",
      refFreshness: "CURRENT",
      refObservedAt: "2026-09-04T08:00:00.000Z",
      refCheckedAt: "2026-09-04T08:00:00.000Z",
      refConflictState: input.conflict ? "CONFLICTED" : "NONE",
    },
  };
}

test("Needs attention is severity ordered while raw repository evidence remains inspectable", () => {
  const repositories = [
    repository({ worktreeId: "info", localPath: "/z-info", identity: "github:9", upstream: null }),
    repository({ worktreeId: "action", localPath: "/b-action", identity: "github:2", dirty: true }),
    repository({ worktreeId: "blocking", localPath: "/c-blocking", identity: "github:3", conflict: true }),
  ];
  const markup = renderToStaticMarkup(WorkspaceHome({
    workspaces: [{ id: "workspace:1", label: "Repositories", rootPath: "/workspace", createdAt: "2026-09-04T08:00:00.000Z", updatedAt: "2026-09-04T08:00:00.000Z", archivedAt: null, version: 1 }],
    repositories,
  }));

  expect(markup).toContain("Needs attention");
  expect(markup).toContain("BLOCKING");
  expect(markup).toContain("ACTION_REQUIRED");
  expect(markup).toContain("INFO");
  expect(markup).toContain("OBSERVATION_CONFLICT");
  expect(markup).toContain("DIRTY_WORKTREE");
  expect(markup).toContain("NO_UPSTREAM");

  const attentionStart = markup.indexOf("Needs attention");
  const rawStart = markup.indexOf("Repository observations");
  const attentionMarkup = markup.slice(attentionStart, rawStart);
  expect(attentionMarkup.indexOf("/c-blocking")).toBeLessThan(attentionMarkup.indexOf("/b-action"));
  expect(attentionMarkup.indexOf("/b-action")).toBeLessThan(attentionMarkup.indexOf("/z-info"));

  expect(markup.slice(rawStart)).toContain("Local HEAD");
  expect(markup.slice(rawStart)).toContain("GitHub ref");
  expect(markup.slice(rawStart)).toContain("2026-09-04T08:00:00.000Z");
});

test("repository UI surfaces canonical relation and safe-sync preview with exact SHAs without adding a mutation control", () => {
  const remoteSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const behind = repository({ worktreeId: "behind", localPath: "/behind", identity: "github:4242" });
  behind.local.aheadBehind = { ahead: 5, behind: 0 };
  behind.github.refSha = remoteSha;
  behind.github.relation = {
    relation: "LOCAL_BEHIND",
    repositoryAlias: "Acme/Widgets",
    refName: "main",
    localSha: SHA,
    githubSha: remoteSha,
    availability: "AVAILABLE",
    freshness: "CURRENT",
    observedAt: "2026-09-04T08:01:00.000Z",
    checkedAt: "2026-09-04T08:01:00.000Z",
    conflictState: "NONE",
    sourceVersion: `${remoteSha}...${SHA}`,
    provenance: "system-gh:api:compare",
  };

  const markup = renderToStaticMarkup(WorkspaceHome({
    workspaces: [{ id: "workspace:1", label: "Repositories", rootPath: "/workspace", createdAt: "2026-09-04T08:00:00.000Z", updatedAt: "2026-09-04T08:00:00.000Z", archivedAt: null, version: 1 }],
    repositories: [behind],
  }));

  expect(markup).toContain("GitHub relation");
  expect(markup).toContain("LOCAL_BEHIND");
  expect(markup).toContain("Safe sync preview");
  expect(markup).toContain("ELIGIBLE");
  expect(markup).toContain("Expected local pre-HEAD");
  expect(markup).toContain("Expected GitHub target SHA");
  expect(markup).toContain(SHA);
  expect(markup).toContain(remoteSha);
  expect(markup).toContain("system-gh:api:compare");
  expect((markup.match(/<button/g) ?? []).length).toBe(3);
});
