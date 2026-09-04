import { expect, test } from "vitest";
import { assessRepository, safeFastForwardSyncPreview, sortRepositoryAssessments, type RepositoryAssessment } from "../src/repository-assessment";
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


function repositoryWithRelation(
  relation: "IDENTICAL" | "LOCAL_AHEAD" | "LOCAL_BEHIND" | "DIVERGED" | "UNKNOWN",
  overrides: Partial<RepositoryView> = {},
): RepositoryView {
  const input = repository(overrides);
  input.github.relation = {
    relation,
    repositoryAlias: input.github.canonicalAlias,
    refName: input.github.refName,
    localSha: input.local.head,
    githubSha: input.github.refSha,
    availability: "AVAILABLE",
    freshness: "CURRENT",
    observedAt: "2026-09-04T08:00:00.000Z",
    checkedAt: "2026-09-04T08:00:00.000Z",
    conflictState: "NONE",
    sourceVersion: input.local.head && input.github.refSha ? `${input.github.refSha}...${input.local.head}` : null,
    provenance: "system-gh:api:compare",
  };
  return input;
}

test("current GitHub canonical relation overrides stale local tracking counts but never stronger conflict evidence", () => {
  const behind = repositoryWithRelation("LOCAL_BEHIND", {
    local: { ...repository().local, head: B, aheadBehind: { ahead: 7, behind: 0 } },
    github: { ...repository().github, refSha: A },
  });
  expect(assessRepository(behind)).toMatchObject({
    syncCondition: "LOCAL_BEHIND",
    reasons: ["LOCAL_BEHIND"],
  });

  const conflicted = repositoryWithRelation("LOCAL_BEHIND", {
    local: { ...repository().local, head: B, aheadBehind: { ahead: 7, behind: 0 } },
    github: { ...repository().github, refSha: A },
  });
  if (!conflicted.github.relation) throw new Error("relation fixture missing");
  conflicted.github.relation.conflictState = "CONFLICTED";
  expect(assessRepository(conflicted)).toMatchObject({
    attention: "BLOCKING",
    syncCondition: "UNKNOWN",
    reasons: ["OBSERVATION_CONFLICT"],
  });
});

test("safe fast-forward sync preview is exact and fail-closed across eligibility, no-op, and blocker states", () => {
  const behind = repositoryWithRelation("LOCAL_BEHIND", {
    local: { ...repository().local, head: A, aheadBehind: { ahead: 9, behind: 0 } },
    github: { ...repository().github, refSha: B },
  });
  expect(safeFastForwardSyncPreview(behind)).toEqual({
    state: "ELIGIBLE",
    reasons: ["LOCAL_BEHIND"],
    expectedLocalPreHead: A,
    expectedGitHubTargetSha: B,
  });

  expect(safeFastForwardSyncPreview(repositoryWithRelation("IDENTICAL"))).toEqual({
    state: "NOT_NEEDED",
    reasons: ["IN_SYNC"],
    expectedLocalPreHead: A,
    expectedGitHubTargetSha: A,
  });

  const dirty = repositoryWithRelation("LOCAL_BEHIND", { local: { ...repository().local, dirty: true }, github: { ...repository().github, refSha: B } });
  expect(safeFastForwardSyncPreview(dirty)).toMatchObject({ state: "BLOCKED", reasons: ["DIRTY_WORKTREE"] });

  const detached = repositoryWithRelation("LOCAL_BEHIND", { local: { ...repository().local, detached: true, branch: null, upstream: null }, github: { ...repository().github, refSha: B } });
  expect(safeFastForwardSyncPreview(detached)).toMatchObject({ state: "BLOCKED", reasons: ["DETACHED_HEAD"] });

  const ahead = repositoryWithRelation("LOCAL_AHEAD", { github: { ...repository().github, refSha: B } });
  expect(safeFastForwardSyncPreview(ahead)).toMatchObject({ state: "BLOCKED", reasons: ["LOCAL_AHEAD"] });

  const diverged = repositoryWithRelation("DIVERGED", { github: { ...repository().github, refSha: B } });
  expect(safeFastForwardSyncPreview(diverged)).toMatchObject({ state: "BLOCKED", reasons: ["DIVERGED"] });

  const stale = repositoryWithRelation("LOCAL_BEHIND", { github: { ...repository().github, refSha: B } });
  if (!stale.github.relation) throw new Error("relation fixture missing");
  stale.github.relation.freshness = "STALE";
  expect(safeFastForwardSyncPreview(stale)).toMatchObject({ state: "UNKNOWN", reasons: ["EVIDENCE_STALE"] });

  const unavailable = repositoryWithRelation("LOCAL_BEHIND", { github: { ...repository().github, refSha: B } });
  if (!unavailable.github.relation) throw new Error("relation fixture missing");
  unavailable.github.relation.availability = "UNAVAILABLE";
  unavailable.github.relation.freshness = "STALE";
  expect(safeFastForwardSyncPreview(unavailable)).toMatchObject({ state: "UNKNOWN", reasons: ["EVIDENCE_UNAVAILABLE", "EVIDENCE_STALE"] });

  const conflicted = repositoryWithRelation("LOCAL_BEHIND", { github: { ...repository().github, refSha: B } });
  if (!conflicted.github.relation) throw new Error("relation fixture missing");
  conflicted.github.relation.conflictState = "CONFLICTED";
  expect(safeFastForwardSyncPreview(conflicted)).toMatchObject({ state: "BLOCKED", reasons: ["OBSERVATION_CONFLICT"] });

  const mismatch = repositoryWithRelation("LOCAL_BEHIND", { github: { ...repository().github, refSha: B } });
  if (!mismatch.github.relation) throw new Error("relation fixture missing");
  mismatch.github.relation.repositoryAlias = "other/widgets";
  expect(safeFastForwardSyncPreview(mismatch)).toMatchObject({ state: "BLOCKED", reasons: ["IDENTITY_MISMATCH"] });
});
