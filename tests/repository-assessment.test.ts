import { expect, test } from "vitest";
import { assessRepository, sortRepositoryAssessments, type RepositoryAssessment } from "../src/repository-assessment";
import type { RepositoryView } from "../src/repository-observations";

const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function repository(overrides: Partial<RepositoryView> = {}): RepositoryView {
  const base: RepositoryView = {
    worktreeId: "worktree:1",
    workspaceId: "workspace:1",
    localPath: "/workspace/acme-widgets",
    repositoryKind: "working-tree",
    gitDir: "/workspace/acme-widgets/.git",
    commonDir: "/workspace/acme-widgets/.git",
    canonicalRepositoryIdentity: "github:4242",
    remoteName: "origin",
    remoteUrl: "https://github.com/acme/widgets.git",
    githubAlias: "acme/widgets",
    local: {
      head: A,
      branch: "main",
      detached: false,
      dirty: false,
      remotes: [{ name: "origin", url: "https://github.com/acme/widgets.git" }],
      upstream: "origin/main",
      aheadBehind: { ahead: 0, behind: 0 },
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
      refSha: A,
      refAvailability: "AVAILABLE",
      refFreshness: "CURRENT",
      refObservedAt: "2026-09-04T08:00:00.000Z",
      refCheckedAt: "2026-09-04T08:00:00.000Z",
      refConflictState: "NONE",
    },
  };
  return {
    ...base,
    ...overrides,
    local: { ...base.local, ...(overrides.local ?? {}) },
    github: { ...base.github, ...(overrides.github ?? {}) },
  };
}

test("repository assessment classifies the sync matrix from current exact local/ref evidence", () => {
  const cases: Array<[string, RepositoryView, RepositoryAssessment["syncCondition"]]> = [
    ["in sync", repository(), "IN_SYNC"],
    ["local ahead", repository({ local: { ...repository().local, head: B, aheadBehind: { ahead: 2, behind: 0 } } }), "LOCAL_AHEAD"],
    ["local behind", repository({ local: { ...repository().local, head: B, aheadBehind: { ahead: 0, behind: 3 } } }), "LOCAL_BEHIND"],
    ["diverged", repository({ local: { ...repository().local, head: B, aheadBehind: { ahead: 1, behind: 1 } } }), "DIVERGED"],
    ["unequal unclassified", repository({ local: { ...repository().local, head: B, upstream: null, aheadBehind: null } }), "MISMATCH_UNCLASSIFIED"],
    ["unknown without current ref", repository({ github: { ...repository().github, refFreshness: "STALE" } }), "UNKNOWN"],
  ];

  for (const [label, input, expected] of cases) {
    expect(assessRepository(input).syncCondition, label).toBe(expected);
  }
});

test("repository assessment applies fail-closed health and attention semantics with stable reasons", () => {
  expect(assessRepository(repository())).toMatchObject({
    health: "HEALTHY", attention: "HEALTHY", syncCondition: "IN_SYNC", reasons: [],
  });

  expect(assessRepository(repository({ local: { ...repository().local, upstream: null, aheadBehind: null } }))).toMatchObject({
    health: "HEALTHY", attention: "INFO", syncCondition: "IN_SYNC", reasons: ["NO_UPSTREAM"],
  });

  expect(assessRepository(repository({ local: { ...repository().local, dirty: true } }))).toMatchObject({
    health: "DEGRADED", attention: "ACTION_REQUIRED", reasons: ["DIRTY_WORKTREE"],
  });

  expect(assessRepository(repository({ local: { ...repository().local, detached: true, branch: null, upstream: null, aheadBehind: null } }))).toMatchObject({
    health: "DEGRADED", attention: "ACTION_REQUIRED", reasons: ["DETACHED_HEAD", "NO_UPSTREAM"],
  });

  expect(assessRepository(repository({ local: { ...repository().local, head: B, aheadBehind: { ahead: 1, behind: 1 } } }))).toMatchObject({
    health: "DEGRADED", attention: "BLOCKING", syncCondition: "DIVERGED", reasons: ["DIVERGED"],
  });

  expect(assessRepository(repository({ local: { ...repository().local, availability: "UNAVAILABLE", freshness: "STALE" } }))).toMatchObject({
    health: "UNKNOWN", attention: "DEGRADED", syncCondition: "UNKNOWN", reasons: ["EVIDENCE_UNAVAILABLE", "EVIDENCE_STALE"],
  });

  expect(assessRepository(repository({ github: { ...repository().github, repositoryAvailability: "UNKNOWN", repositoryFreshness: "UNKNOWN" } }))).toMatchObject({
    health: "UNKNOWN", attention: "DEGRADED", reasons: ["EVIDENCE_UNKNOWN"],
  });

  expect(assessRepository(repository({ github: { ...repository().github, refConflictState: "CONFLICTED" } }))).toMatchObject({
    health: "DEGRADED", attention: "BLOCKING", syncCondition: "UNKNOWN", reasons: ["OBSERVATION_CONFLICT"],
  });

  expect(assessRepository(repository({
    local: { ...repository().local, dirty: true, detached: true, branch: null, upstream: null, aheadBehind: null },
    github: { ...repository().github, repositoryFreshness: "STALE" },
  }))).toMatchObject({
    health: "DEGRADED",
    attention: "ACTION_REQUIRED",
    reasons: ["DIRTY_WORKTREE", "DETACHED_HEAD", "EVIDENCE_STALE", "NO_UPSTREAM"],
  });
});

test("repository assessment carries inspectable evidence summary and deterministic attention ordering", () => {
  const healthy = assessRepository(repository({ localPath: "/z", canonicalRepositoryIdentity: "github:9" }));
  const actionB = assessRepository(repository({
    localPath: "/b",
    canonicalRepositoryIdentity: "github:2",
    local: { ...repository().local, dirty: true },
  }));
  const actionA = assessRepository(repository({
    localPath: "/a",
    canonicalRepositoryIdentity: "github:1",
    local: { ...repository().local, detached: true, branch: null, upstream: null, aheadBehind: null },
  }));
  const blocking = assessRepository(repository({
    localPath: "/c",
    canonicalRepositoryIdentity: "github:3",
    github: { ...repository().github, refConflictState: "CONFLICTED" },
  }));

  expect(healthy.evidence).toMatchObject({
    local: { availability: "AVAILABLE", freshness: "CURRENT", conflictState: "NONE" },
    githubRepository: { availability: "AVAILABLE", freshness: "CURRENT", conflictState: "NONE" },
    githubRef: { availability: "AVAILABLE", freshness: "CURRENT", conflictState: "NONE" },
  });
  expect(healthy.identity).toEqual({ canonicalRepositoryIdentity: "github:9", localPath: "/z", githubAlias: "Acme/Widgets" });
  expect(sortRepositoryAssessments([healthy, actionB, actionA, blocking]).map((item) => item.identity.localPath)).toEqual([
    "/c", "/a", "/b", "/z",
  ]);
});
