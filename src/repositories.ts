import { spawnSync } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export type RepositoryKind = "working-tree" | "linked-worktree";

export interface DiscoveredRepository {
  path: string;
  kind: RepositoryKind;
}

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  ".turbo",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

const MAX_VISITED_DIRECTORIES = 4096;

async function gitMarkerKind(directory: string): Promise<RepositoryKind | null> {
  try {
    const marker = await lstat(path.join(directory, ".git"));
    if (marker.isDirectory()) return "working-tree";
    if (marker.isFile()) return "linked-worktree";
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function discoverRepositories(workspaceRoot: string): Promise<DiscoveredRepository[]> {
  const root = await realpath(workspaceRoot);
  const pending = [root];
  const discovered: DiscoveredRepository[] = [];
  let visited = 0;

  while (pending.length > 0) {
    const directory = pending.shift();
    if (!directory) break;
    visited += 1;
    if (visited > MAX_VISITED_DIRECTORIES) {
      throw new Error(`Repository discovery exceeded ${MAX_VISITED_DIRECTORIES} directories.`);
    }

    const kind = await gitMarkerKind(directory);
    if (kind) {
      discovered.push({ path: directory, kind });
      continue;
    }

    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
      pending.push(path.join(directory, entry.name));
    }
  }

  return discovered.sort((left, right) => left.path.localeCompare(right.path));
}


export interface LocalGitObservation {
  gitDir: string;
  commonDir: string;
  head: string;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
  remotes: Array<{ name: string; url: string }>;
  upstream: string | null;
  aheadBehind: { ahead: number; behind: number } | null;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type ProcessRunner = (command: string, args: string[], cwd?: string) => CommandResult;

const EXACT_GIT_OBSERVATION_COMMANDS = new Set([
  "rev-parse --git-dir",
  "rev-parse --git-common-dir",
  "rev-parse HEAD",
  "symbolic-ref --quiet --short HEAD",
  "status --porcelain=v1 --untracked-files=normal",
  "remote",
  "rev-parse --abbrev-ref --symbolic-full-name @{upstream}",
  "rev-list --left-right --count HEAD...@{upstream}",
]);

function gitObservationArgsAllowed(args: string[]): boolean {
  const joined = args.join(" ");
  if (EXACT_GIT_OBSERVATION_COMMANDS.has(joined)) return true;
  return args.length === 3
    && args[0] === "remote"
    && args[1] === "get-url"
    && Boolean(args[2])
    && !args[2].startsWith("-");
}

function executeGit(cwd: string, args: string[]): CommandResult {
  if (!gitObservationArgsAllowed(args)) {
    throw new Error(`Git observation command is not allowed: git ${args.join(" ")}`);
  }
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

export function runReadOnlyGit(cwd: string, args: string[]): string {
  const result = executeGit(cwd, args);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function optionalGit(cwd: string, args: string[]): string | null {
  const result = executeGit(cwd, args);
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

export function observeLocalRepository(repository: DiscoveredRepository): LocalGitObservation {
  const gitDirOutput = runReadOnlyGit(repository.path, ["rev-parse", "--git-dir"]);
  const commonDirOutput = runReadOnlyGit(repository.path, ["rev-parse", "--git-common-dir"]);
  const head = runReadOnlyGit(repository.path, ["rev-parse", "HEAD"]);
  const branch = optionalGit(repository.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const status = runReadOnlyGit(repository.path, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  const remoteNames = runReadOnlyGit(repository.path, ["remote"])
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  const remotes = remoteNames.map((name) => ({
    name,
    url: sanitizeGitRemoteUrl(runReadOnlyGit(repository.path, ["remote", "get-url", name])),
  }));
  const upstream = optionalGit(repository.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  let aheadBehind: LocalGitObservation["aheadBehind"] = null;
  if (upstream) {
    const counts = optionalGit(repository.path, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    if (counts) {
      const [aheadText, behindText] = counts.split(/\s+/);
      const ahead = Number(aheadText);
      const behind = Number(behindText);
      if (Number.isInteger(ahead) && Number.isInteger(behind)) aheadBehind = { ahead, behind };
    }
  }

  return {
    gitDir: path.resolve(repository.path, gitDirOutput),
    commonDir: path.resolve(repository.path, commonDirOutput),
    head,
    branch,
    detached: branch === null,
    dirty: status.length > 0,
    remotes,
    upstream,
    aheadBehind,
  };
}



export function sanitizeGitRemoteUrl(remoteUrl: string): string {
  const value = remoteUrl.trim();
  if (/^git@github\.com:[^\s]+$/i.test(value)) return value;
  try {
    const parsed = new URL(value);
    parsed.search = "";
    parsed.hash = "";
    if (parsed.protocol === "ssh:" && parsed.username === "git" && !parsed.password) {
      return parsed.toString();
    }
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return value;
  }
}

export type EvidenceAvailability = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
export type EvidenceFreshness = "CURRENT" | "STALE" | "UNKNOWN";

export interface GitHubRepositoryEvidence {
  id: string | null;
  canonicalAlias: string | null;
  defaultBranch: string | null;
  availability: EvidenceAvailability;
  freshness: EvidenceFreshness;
  reason: string | null;
}

export interface GitHubRefEvidence {
  name: string | null;
  sha: string | null;
  availability: EvidenceAvailability;
  freshness: EvidenceFreshness;
  reason: string | null;
}

export interface GitHubRemoteObservation {
  alias: string | null;
  repository: GitHubRepositoryEvidence;
  ref: GitHubRefEvidence;
  provenance: "system-gh:api";
}

const GITHUB_REPOSITORY_JQ = "[.id,.full_name,.default_branch] | @tsv";
const GITHUB_REF_JQ = ".object.sha";

function githubAliasFromParts(owner: string, repository: string): string | null {
  const safePart = /^[A-Za-z0-9_.-]+$/;
  if (!owner || !repository || !safePart.test(owner) || !safePart.test(repository)) return null;
  if (owner === "." || owner === ".." || repository === "." || repository === "..") return null;
  return `${owner}/${repository.replace(/\.git$/i, "")}`;
}

export function normalizeGitHubRemoteUrl(remoteUrl: string): string | null {
  const sanitized = sanitizeGitRemoteUrl(remoteUrl);
  const scpStyle = sanitized.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (scpStyle) return githubAliasFromParts(scpStyle[1] ?? "", scpStyle[2] ?? "");

  try {
    const parsed = new URL(sanitized);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length !== 2) return null;
    return githubAliasFromParts(parts[0] ?? "", parts[1] ?? "");
  } catch {
    return null;
  }
}

function systemProcessRunner(command: string, args: string[], cwd?: string): CommandResult {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function ghObservationArgsAllowed(args: string[]): boolean {
  if (args.length !== 4 || args[0] !== "api" || args[2] !== "--jq") return false;
  if (args[3] !== GITHUB_REPOSITORY_JQ && args[3] !== GITHUB_REF_JQ) return false;
  const resource = args[1] ?? "";
  return /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/git\/ref\/heads\/[A-Za-z0-9%_.-]+)?$/.test(resource);
}

export function runReadOnlyGh(
  args: string[],
  runner: ProcessRunner = systemProcessRunner,
): { ok: boolean; stdout: string; reason: string | null } {
  if (!ghObservationArgsAllowed(args)) {
    throw new Error(`GitHub observation command is not allowed: gh ${args.join(" ")}`);
  }
  const result = runner("gh", args);
  if (result.error || result.status !== 0) {
    return { ok: false, stdout: "", reason: "gh-api-unavailable" };
  }
  return { ok: true, stdout: result.stdout.trim(), reason: null };
}

function unavailableGitHubObservation(
  alias: string | null,
  availability: EvidenceAvailability,
  reason: string,
  refName: string | null = null,
): GitHubRemoteObservation {
  return {
    alias,
    repository: {
      id: null,
      canonicalAlias: null,
      defaultBranch: null,
      availability,
      freshness: "UNKNOWN",
      reason,
    },
    ref: {
      name: refName,
      sha: null,
      availability,
      freshness: "UNKNOWN",
      reason,
    },
    provenance: "system-gh:api",
  };
}

export function observeGitHubRemote(
  remoteUrl: string,
  localBranch: string | null,
  runner: ProcessRunner = systemProcessRunner,
): GitHubRemoteObservation {
  const alias = normalizeGitHubRemoteUrl(remoteUrl);
  if (!alias) return unavailableGitHubObservation(null, "UNKNOWN", "non-github-remote", localBranch);

  const repositoryResult = runReadOnlyGh(
    ["api", `repos/${alias}`, "--jq", GITHUB_REPOSITORY_JQ],
    runner,
  );
  if (!repositoryResult.ok) return unavailableGitHubObservation(alias, "UNAVAILABLE", repositoryResult.reason ?? "gh-api-unavailable", localBranch);

  const [id = "", canonicalAlias = "", defaultBranch = ""] = repositoryResult.stdout.split("\t");
  if (!/^\d+$/.test(id) || !normalizeGitHubRemoteUrl(`https://github.com/${canonicalAlias}.git`) || !defaultBranch) {
    return unavailableGitHubObservation(alias, "UNAVAILABLE", "gh-repository-response-invalid", localBranch);
  }

  const repository: GitHubRepositoryEvidence = {
    id,
    canonicalAlias,
    defaultBranch,
    availability: "AVAILABLE",
    freshness: "CURRENT",
    reason: null,
  };
  const refName = localBranch || defaultBranch;
  const encodedRef = encodeURIComponent(refName);
  const refResult = runReadOnlyGh(
    ["api", `repos/${alias}/git/ref/heads/${encodedRef}`, "--jq", GITHUB_REF_JQ],
    runner,
  );
  const ref: GitHubRefEvidence = refResult.ok && /^[0-9a-f]{40}$/i.test(refResult.stdout)
    ? { name: refName, sha: refResult.stdout, availability: "AVAILABLE", freshness: "CURRENT", reason: null }
    : { name: refName, sha: null, availability: "UNAVAILABLE", freshness: "UNKNOWN", reason: refResult.ok ? "gh-ref-response-invalid" : (refResult.reason ?? "gh-api-unavailable") };

  return { alias, repository, ref, provenance: "system-gh:api" };
}
