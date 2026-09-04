import type { EvidenceAvailability, EvidenceFreshness } from "./repositories";
import type { ObservationConflictState, RepositoryView } from "./repository-observations";

export type RepositoryHealth = "HEALTHY" | "DEGRADED" | "UNKNOWN";
export type RepositoryAttention = "BLOCKING" | "ACTION_REQUIRED" | "DEGRADED" | "INFO" | "HEALTHY";
export type RepositorySyncCondition = "IN_SYNC" | "LOCAL_AHEAD" | "LOCAL_BEHIND" | "DIVERGED" | "MISMATCH_UNCLASSIFIED" | "UNKNOWN";
export type RepositoryReasonCode = "OBSERVATION_CONFLICT" | "DIRTY_WORKTREE" | "DETACHED_HEAD" | "LOCAL_AHEAD" | "LOCAL_BEHIND" | "DIVERGED" | "MISMATCH_UNCLASSIFIED" | "EVIDENCE_UNAVAILABLE" | "EVIDENCE_UNKNOWN" | "EVIDENCE_STALE" | "NO_UPSTREAM";

type EvidenceSummary = {
  availability: EvidenceAvailability;
  freshness: EvidenceFreshness;
  conflictState: ObservationConflictState;
};

export interface RepositoryAssessment {
  health: RepositoryHealth;
  attention: RepositoryAttention;
  syncCondition: RepositorySyncCondition;
  reasons: RepositoryReasonCode[];
  identity: { canonicalRepositoryIdentity: string; localPath: string; githubAlias: string | null };
  evidence: {
    local: EvidenceSummary;
    githubRepository: EvidenceSummary;
    githubRef: EvidenceSummary;
  };
}

const REASON_ORDER: RepositoryReasonCode[] = [
  "OBSERVATION_CONFLICT",
  "DIVERGED",
  "DIRTY_WORKTREE",
  "DETACHED_HEAD",
  "LOCAL_AHEAD",
  "LOCAL_BEHIND",
  "MISMATCH_UNCLASSIFIED",
  "EVIDENCE_UNAVAILABLE",
  "EVIDENCE_UNKNOWN",
  "EVIDENCE_STALE",
  "NO_UPSTREAM",
];

const REASON_ATTENTION: Record<RepositoryReasonCode, RepositoryAttention> = {
  OBSERVATION_CONFLICT: "BLOCKING",
  DIVERGED: "BLOCKING",
  DIRTY_WORKTREE: "ACTION_REQUIRED",
  DETACHED_HEAD: "ACTION_REQUIRED",
  LOCAL_AHEAD: "ACTION_REQUIRED",
  LOCAL_BEHIND: "ACTION_REQUIRED",
  MISMATCH_UNCLASSIFIED: "ACTION_REQUIRED",
  EVIDENCE_UNAVAILABLE: "DEGRADED",
  EVIDENCE_UNKNOWN: "DEGRADED",
  EVIDENCE_STALE: "DEGRADED",
  NO_UPSTREAM: "INFO",
};

const ATTENTION_ORDER: Record<RepositoryAttention, number> = {
  BLOCKING: 0,
  ACTION_REQUIRED: 1,
  DEGRADED: 2,
  INFO: 3,
  HEALTHY: 4,
};

function isCurrent(summary: EvidenceSummary): boolean {
  return summary.availability === "AVAILABLE"
    && summary.freshness === "CURRENT"
    && summary.conflictState === "NONE";
}

function syncCondition(repository: RepositoryView, local: EvidenceSummary, githubRef: EvidenceSummary): RepositorySyncCondition {
  if (!isCurrent(local) || !isCurrent(githubRef) || !repository.local.head || !repository.github.refSha) return "UNKNOWN";
  if (repository.local.head === repository.github.refSha) return "IN_SYNC";

  const expectedUpstream = repository.remoteName && repository.github.refName
    ? `${repository.remoteName}/${repository.github.refName}`
    : null;
  const relation = repository.local.aheadBehind;
  const relationTrusted = Boolean(expectedUpstream && repository.local.upstream === expectedUpstream && relation);
  if (!relationTrusted || !relation || relation.ahead < 0 || relation.behind < 0) return "MISMATCH_UNCLASSIFIED";
  if (relation.ahead > 0 && relation.behind > 0) return "DIVERGED";
  if (relation.ahead > 0 && relation.behind === 0) return "LOCAL_AHEAD";
  if (relation.ahead === 0 && relation.behind > 0) return "LOCAL_BEHIND";
  return "MISMATCH_UNCLASSIFIED";
}

function evidenceReasons(repository: RepositoryView, summaries: EvidenceSummary[]): Set<RepositoryReasonCode> {
  const reasons = new Set<RepositoryReasonCode>();
  if (summaries.some((summary) => summary.conflictState === "CONFLICTED")) reasons.add("OBSERVATION_CONFLICT");
  if (summaries.some((summary) => summary.availability === "UNAVAILABLE")) reasons.add("EVIDENCE_UNAVAILABLE");
  if (summaries.some((summary) => summary.availability === "UNKNOWN" || summary.freshness === "UNKNOWN")) reasons.add("EVIDENCE_UNKNOWN");
  if (summaries.some((summary) => summary.freshness === "STALE")) reasons.add("EVIDENCE_STALE");
  if (!repository.local.head || !repository.github.refSha || repository.github.repositoryId === null) reasons.add("EVIDENCE_UNKNOWN");
  return reasons;
}

function highestAttention(reasons: RepositoryReasonCode[]): RepositoryAttention {
  if (reasons.length === 0) return "HEALTHY";
  return reasons.reduce<RepositoryAttention>((highest, reason) => (
    ATTENTION_ORDER[REASON_ATTENTION[reason]] < ATTENTION_ORDER[highest]
      ? REASON_ATTENTION[reason]
      : highest
  ), "HEALTHY");
}

export function assessRepository(repository: RepositoryView): RepositoryAssessment {
  const local: EvidenceSummary = {
    availability: repository.local.availability,
    freshness: repository.local.freshness,
    conflictState: repository.local.conflictState,
  };
  const githubRepository: EvidenceSummary = {
    availability: repository.github.repositoryAvailability,
    freshness: repository.github.repositoryFreshness,
    conflictState: repository.github.repositoryConflictState,
  };
  const githubRef: EvidenceSummary = {
    availability: repository.github.refAvailability,
    freshness: repository.github.refFreshness,
    conflictState: repository.github.refConflictState,
  };
  const summaries = [local, githubRepository, githubRef];
  const condition = syncCondition(repository, local, githubRef);
  const reasonSet = evidenceReasons(repository, summaries);

  if (repository.local.dirty === true) reasonSet.add("DIRTY_WORKTREE");
  if (repository.local.detached === true) reasonSet.add("DETACHED_HEAD");
  if (condition === "LOCAL_AHEAD") reasonSet.add("LOCAL_AHEAD");
  if (condition === "LOCAL_BEHIND") reasonSet.add("LOCAL_BEHIND");
  if (condition === "DIVERGED") reasonSet.add("DIVERGED");
  if (condition === "MISMATCH_UNCLASSIFIED") reasonSet.add("MISMATCH_UNCLASSIFIED");
  if (condition === "IN_SYNC" && isCurrent(local) && repository.local.upstream === null) reasonSet.add("NO_UPSTREAM");

  const reasons = REASON_ORDER.filter((reason) => reasonSet.has(reason));
  const requiredUnknown = summaries.some((summary) => summary.availability !== "AVAILABLE" || summary.freshness === "UNKNOWN")
    || !repository.local.head
    || !repository.github.refSha
    || repository.github.repositoryId === null;
  const healthy = !requiredUnknown
    && summaries.every(isCurrent)
    && repository.local.dirty === false
    && repository.local.detached === false
    && condition === "IN_SYNC";
  const health: RepositoryHealth = requiredUnknown ? "UNKNOWN" : healthy ? "HEALTHY" : "DEGRADED";

  return {
    health,
    attention: highestAttention(reasons),
    syncCondition: condition,
    reasons,
    identity: {
      canonicalRepositoryIdentity: repository.canonicalRepositoryIdentity,
      localPath: repository.localPath,
      githubAlias: repository.github.canonicalAlias ?? repository.githubAlias,
    },
    evidence: { local, githubRepository, githubRef },
  };
}

export function sortRepositoryAssessments(items: RepositoryAssessment[]): RepositoryAssessment[] {
  return [...items].sort((left, right) => {
    const severity = ATTENTION_ORDER[left.attention] - ATTENTION_ORDER[right.attention];
    if (severity !== 0) return severity;
    const identity = left.identity.canonicalRepositoryIdentity.localeCompare(right.identity.canonicalRepositoryIdentity);
    if (identity !== 0) return identity;
    return left.identity.localPath.localeCompare(right.identity.localPath);
  });
}

export function repositoryReasonText(reason: RepositoryReasonCode): string {
  switch (reason) {
    case "OBSERVATION_CONFLICT": return "Required observations conflict.";
    case "DIRTY_WORKTREE": return "Worktree has local changes.";
    case "DETACHED_HEAD": return "HEAD is detached.";
    case "LOCAL_AHEAD": return "Local ref is ahead of the observed GitHub ref.";
    case "LOCAL_BEHIND": return "Local ref is behind the observed GitHub ref.";
    case "DIVERGED": return "Local and observed GitHub refs have diverged.";
    case "MISMATCH_UNCLASSIFIED": return "Local and GitHub SHAs differ without trustworthy relation counts.";
    case "EVIDENCE_UNAVAILABLE": return "Required evidence is unavailable.";
    case "EVIDENCE_UNKNOWN": return "Required evidence is unknown.";
    case "EVIDENCE_STALE": return "Required evidence is stale.";
    case "NO_UPSTREAM": return "No local upstream is configured; exact SHA comparison still proves sync.";
  }
}
