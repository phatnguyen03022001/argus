import type { EvidenceAvailability, EvidenceFreshness } from "./repositories";
import type { ObservationConflictState, RepositoryView } from "./repository-observations";

export type RepositoryHealth = "HEALTHY" | "DEGRADED" | "UNKNOWN";
export type RepositoryAttention = "BLOCKING" | "ACTION_REQUIRED" | "DEGRADED" | "INFO" | "HEALTHY";
export type RepositorySyncCondition = "IN_SYNC" | "LOCAL_AHEAD" | "LOCAL_BEHIND" | "DIVERGED" | "MISMATCH_UNCLASSIFIED" | "UNKNOWN";
export type RepositoryReasonCode = "OBSERVATION_CONFLICT" | "IDENTITY_MISMATCH" | "DIRTY_WORKTREE" | "DETACHED_HEAD" | "LOCAL_AHEAD" | "LOCAL_BEHIND" | "DIVERGED" | "MISMATCH_UNCLASSIFIED" | "EVIDENCE_UNAVAILABLE" | "EVIDENCE_UNKNOWN" | "EVIDENCE_STALE" | "NO_UPSTREAM";
export type SafeSyncPreviewState = "ELIGIBLE" | "NOT_NEEDED" | "BLOCKED" | "UNKNOWN";
export type SafeSyncPreviewReasonCode = "IN_SYNC" | "LOCAL_BEHIND" | "DIRTY_WORKTREE" | "DETACHED_HEAD" | "LOCAL_AHEAD" | "DIVERGED" | "OBSERVATION_CONFLICT" | "IDENTITY_MISMATCH" | "EVIDENCE_UNAVAILABLE" | "EVIDENCE_UNKNOWN" | "EVIDENCE_STALE";

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
    githubRelation?: EvidenceSummary;
  };
}

export interface SafeFastForwardSyncPreview {
  state: SafeSyncPreviewState;
  reasons: SafeSyncPreviewReasonCode[];
  expectedLocalPreHead: string | null;
  expectedGitHubTargetSha: string | null;
}

const REASON_ORDER: RepositoryReasonCode[] = [
  "OBSERVATION_CONFLICT",
  "IDENTITY_MISMATCH",
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
  IDENTITY_MISMATCH: "BLOCKING",
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

function relationSummary(repository: RepositoryView): EvidenceSummary | null {
  const relation = repository.github.relation;
  if (!relation) return null;
  return {
    availability: relation.availability,
    freshness: relation.freshness,
    conflictState: relation.conflictState,
  };
}

function aliasesEqual(left: string | null, right: string | null): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function exactRelationBinding(repository: RepositoryView): boolean {
  const relation = repository.github.relation;
  if (!relation || !repository.local.head || !repository.github.refSha || !repository.github.repositoryId) return false;
  const canonicalAlias = repository.github.canonicalAlias ?? repository.githubAlias;
  if (!aliasesEqual(relation.repositoryAlias, canonicalAlias)) return false;
  if (repository.githubAlias && canonicalAlias && !aliasesEqual(repository.githubAlias, canonicalAlias)) return false;
  if (relation.refName !== repository.github.refName) return false;
  if (relation.localSha !== repository.local.head || relation.githubSha !== repository.github.refSha) return false;
  if (relation.sourceVersion !== `${repository.github.refSha}...${repository.local.head}`) return false;
  if (repository.canonicalRepositoryIdentity !== `github:${repository.github.repositoryId}`) return false;
  return relation.provenance === "system-gh:api:compare";
}

function syncCondition(
  repository: RepositoryView,
  local: EvidenceSummary,
  githubRepository: EvidenceSummary,
  githubRef: EvidenceSummary,
  githubRelation: EvidenceSummary | null,
): RepositorySyncCondition {
  if (!isCurrent(local) || !isCurrent(githubRef) || !repository.local.head || !repository.github.refSha) return "UNKNOWN";
  if ([local, githubRepository, githubRef, ...(githubRelation ? [githubRelation] : [])].some((summary) => summary.conflictState === "CONFLICTED")) return "UNKNOWN";

  if (githubRelation && isCurrent(githubRelation) && isCurrent(githubRepository)) {
    if (!exactRelationBinding(repository)) return "UNKNOWN";
    switch (repository.github.relation?.relation) {
      case "IDENTICAL": return "IN_SYNC";
      case "LOCAL_AHEAD": return "LOCAL_AHEAD";
      case "LOCAL_BEHIND": return "LOCAL_BEHIND";
      case "DIVERGED": return "DIVERGED";
      case "UNKNOWN": return "UNKNOWN";
    }
  }

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
  const currentRelation = relationSummary(repository);
  if (currentRelation && isCurrent(currentRelation) && !exactRelationBinding(repository)) reasons.add("IDENTITY_MISMATCH");
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
  const githubRelation = relationSummary(repository);
  const summaries = [local, githubRepository, githubRef, ...(githubRelation ? [githubRelation] : [])];
  const condition = syncCondition(repository, local, githubRepository, githubRef, githubRelation);
  const reasonSet = evidenceReasons(repository, summaries);

  if (repository.local.dirty === true) reasonSet.add("DIRTY_WORKTREE");
  if (repository.local.detached === true) reasonSet.add("DETACHED_HEAD");
  if (condition === "LOCAL_AHEAD") reasonSet.add("LOCAL_AHEAD");
  if (condition === "LOCAL_BEHIND") reasonSet.add("LOCAL_BEHIND");
  if (condition === "DIVERGED") reasonSet.add("DIVERGED");
  if (condition === "MISMATCH_UNCLASSIFIED") reasonSet.add("MISMATCH_UNCLASSIFIED");
  if (condition === "IN_SYNC" && isCurrent(local) && repository.local.upstream === null) reasonSet.add("NO_UPSTREAM");

  const reasons = REASON_ORDER.filter((reason) => reasonSet.has(reason));
  const requiredUnknown = [local, githubRepository, githubRef].some((summary) => summary.availability !== "AVAILABLE" || summary.freshness === "UNKNOWN")
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
    evidence: {
      local,
      githubRepository,
      githubRef,
      ...(githubRelation ? { githubRelation } : {}),
    },
  };
}

export function safeFastForwardSyncPreview(repository: RepositoryView): SafeFastForwardSyncPreview {
  const assessment = assessRepository(repository);
  const relation = repository.github.relation;
  const result = (state: SafeSyncPreviewState, reasons: SafeSyncPreviewReasonCode[]): SafeFastForwardSyncPreview => ({
    state,
    reasons,
    expectedLocalPreHead: repository.local.head,
    expectedGitHubTargetSha: repository.github.refSha,
  });

  if (assessment.reasons.includes("OBSERVATION_CONFLICT")) return result("BLOCKED", ["OBSERVATION_CONFLICT"]);
  if (assessment.reasons.includes("IDENTITY_MISMATCH")) return result("BLOCKED", ["IDENTITY_MISMATCH"]);
  if (repository.local.dirty === true) return result("BLOCKED", ["DIRTY_WORKTREE"]);
  if (repository.local.detached === true) return result("BLOCKED", ["DETACHED_HEAD"]);

  if (!relation) return result("UNKNOWN", ["EVIDENCE_UNKNOWN"]);
  const evidenceReasons: SafeSyncPreviewReasonCode[] = [];
  if (relation.availability === "UNAVAILABLE") evidenceReasons.push("EVIDENCE_UNAVAILABLE");
  else if (relation.availability === "UNKNOWN") evidenceReasons.push("EVIDENCE_UNKNOWN");
  if (relation.freshness === "STALE") evidenceReasons.push("EVIDENCE_STALE");
  else if (relation.freshness === "UNKNOWN" && !evidenceReasons.includes("EVIDENCE_UNKNOWN")) evidenceReasons.push("EVIDENCE_UNKNOWN");
  if (evidenceReasons.length > 0) return result("UNKNOWN", evidenceReasons);

  if (!exactRelationBinding(repository)) return result("BLOCKED", ["IDENTITY_MISMATCH"]);
  if (assessment.reasons.includes("EVIDENCE_UNAVAILABLE")) return result("UNKNOWN", ["EVIDENCE_UNAVAILABLE"]);
  if (assessment.reasons.includes("EVIDENCE_UNKNOWN")) return result("UNKNOWN", ["EVIDENCE_UNKNOWN"]);
  if (assessment.reasons.includes("EVIDENCE_STALE")) return result("UNKNOWN", ["EVIDENCE_STALE"]);

  if (assessment.syncCondition === "LOCAL_AHEAD") return result("BLOCKED", ["LOCAL_AHEAD"]);
  if (assessment.syncCondition === "DIVERGED") return result("BLOCKED", ["DIVERGED"]);
  if (assessment.syncCondition === "IN_SYNC" && relation.relation === "IDENTICAL") return result("NOT_NEEDED", ["IN_SYNC"]);
  if (
    assessment.syncCondition === "LOCAL_BEHIND"
    && relation.relation === "LOCAL_BEHIND"
    && repository.local.dirty === false
    && repository.local.detached === false
  ) return result("ELIGIBLE", ["LOCAL_BEHIND"]);

  return result("UNKNOWN", ["EVIDENCE_UNKNOWN"]);
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
    case "IDENTITY_MISMATCH": return "Current GitHub relation binding does not match the exact repository, ref, or SHA identity.";
    case "DIRTY_WORKTREE": return "Worktree has local changes.";
    case "DETACHED_HEAD": return "HEAD is detached.";
    case "LOCAL_AHEAD": return "Local ref is ahead of the observed GitHub ref.";
    case "LOCAL_BEHIND": return "Local ref is behind the observed GitHub ref.";
    case "DIVERGED": return "Local and observed GitHub refs have diverged.";
    case "MISMATCH_UNCLASSIFIED": return "Local and GitHub SHAs differ without trustworthy relation evidence.";
    case "EVIDENCE_UNAVAILABLE": return "Required evidence is unavailable.";
    case "EVIDENCE_UNKNOWN": return "Required evidence is unknown.";
    case "EVIDENCE_STALE": return "Required evidence is stale.";
    case "NO_UPSTREAM": return "No local upstream is configured; exact SHA comparison still proves sync.";
  }
}
