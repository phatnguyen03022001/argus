import type { RepositoryView } from "./repository-observations";
import type { WorkspaceRecord } from "./workspaces";

function evidenceStatus(
  availability: string,
  freshness: string,
  conflictState: string,
): string {
  return `${availability} · ${freshness}${conflictState === "CONFLICTED" ? " · CONFLICTED" : ""}`;
}

function observationTime(observedAt: string | null, checkedAt: string | null): string {
  if (!observedAt && !checkedAt) return "not observed";
  if (observedAt === checkedAt) return observedAt ?? checkedAt ?? "not observed";
  return `observed ${observedAt ?? "unknown"} · checked ${checkedAt ?? "unknown"}`;
}

export function WorkspaceHome({
  workspaces,
  repositories = [],
  error,
}: {
  workspaces: WorkspaceRecord[];
  repositories?: RepositoryView[];
  error?: string;
}) {
  const labels = new Map(workspaces.map((workspace) => [workspace.id, workspace.label]));

  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">ARGUS · LOCAL WORKSPACE</p>
        <h1>Workspace foundation</h1>
        <p className="lede">Register existing filesystem roots and observe repository state without changing repository contents or Git state.</p>
      </header>

      {error ? <p className="error" role="alert">{error}</p> : null}

      <section className="panel" aria-labelledby="configured-heading">
        <div className="section-heading">
          <h2 id="configured-heading">Configured workspaces</h2>
          <span>{workspaces.length}</span>
        </div>
        {workspaces.length === 0 ? (
          <p className="empty">No workspaces configured.</p>
        ) : (
          <ul className="workspace-list">
            {workspaces.map((workspace) => (
              <li key={workspace.id} className="workspace-row">
                <div>
                  <strong>{workspace.label}</strong>
                  <code>{workspace.rootPath}</code>
                </div>
                <div className="workspace-actions">
                  <small>v{workspace.version}</small>
                  <form action="/repositories" method="post">
                    <input type="hidden" name="workspaceId" value={workspace.id} />
                    <button type="submit">Refresh repositories</button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="repositories-heading">
        <div className="section-heading">
          <h2 id="repositories-heading">Repository observations</h2>
          <span>{repositories.length}</span>
        </div>
        {repositories.length === 0 ? (
          <p className="empty">No repository observations yet. Refresh a configured workspace to scan it.</p>
        ) : (
          <ul className="repository-list">
            {repositories.map((repository) => {
              const displayIdentity = repository.github.canonicalAlias
                ?? repository.githubAlias
                ?? repository.canonicalRepositoryIdentity;
              const branch = repository.local.detached ? "detached" : (repository.local.branch ?? "unknown");
              const dirty = repository.local.dirty === null ? "unknown" : String(repository.local.dirty);
              const tracking = repository.local.aheadBehind
                ? `ahead=${repository.local.aheadBehind.ahead} behind=${repository.local.aheadBehind.behind}`
                : "not locally provable";
              return (
                <li key={repository.worktreeId} className="repository-row">
                  <div className="repository-title">
                    <div>
                      <small>{labels.get(repository.workspaceId) ?? "Workspace"}</small>
                      <strong>{displayIdentity}</strong>
                      <code>{repository.localPath}</code>
                    </div>
                    <span>{repository.repositoryKind}</span>
                  </div>

                  <dl className="repository-facts">
                    <div><dt>Branch</dt><dd>{branch}</dd></div>
                    <div><dt>Local HEAD</dt><dd><code>{repository.local.head ?? "unknown"}</code></dd></div>
                    <div><dt>Dirty</dt><dd>{dirty}</dd></div>
                    <div><dt>Upstream</dt><dd>{repository.local.upstream ?? "none"}</dd></div>
                    <div><dt>Tracking counts</dt><dd>{tracking}</dd></div>
                    <div><dt>Remote</dt><dd>{repository.remoteName && repository.remoteUrl ? `${repository.remoteName} · ${repository.remoteUrl}` : "none"}</dd></div>
                    <div><dt>GitHub repository ID</dt><dd>{repository.github.repositoryId ?? "unknown"}</dd></div>
                    <div><dt>GitHub default branch</dt><dd>{repository.github.defaultBranch ?? "unknown"}</dd></div>
                    <div><dt>GitHub ref</dt><dd>{repository.github.refName ?? "unknown"}</dd></div>
                    <div><dt>Remote ref SHA</dt><dd><code>{repository.github.refSha ?? "unknown"}</code></dd></div>
                  </dl>

                  <div className="evidence-grid">
                    <div>
                      <small>LOCAL GIT</small>
                      <strong>{evidenceStatus(repository.local.availability, repository.local.freshness, repository.local.conflictState)}</strong>
                      <span>{observationTime(repository.local.observedAt, repository.local.checkedAt)}</span>
                    </div>
                    <div>
                      <small>GITHUB REPOSITORY</small>
                      <strong>{evidenceStatus(repository.github.repositoryAvailability, repository.github.repositoryFreshness, repository.github.repositoryConflictState)}</strong>
                      <span>{observationTime(repository.github.repositoryObservedAt, repository.github.repositoryCheckedAt)}</span>
                    </div>
                    <div>
                      <small>GITHUB REF</small>
                      <strong>{evidenceStatus(repository.github.refAvailability, repository.github.refFreshness, repository.github.refConflictState)}</strong>
                      <span>{observationTime(repository.github.refObservedAt, repository.github.refCheckedAt)}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="add-heading">
        <h2 id="add-heading">Add existing workspace</h2>
        <form action="/workspaces" method="post" className="workspace-form">
          <label>
            Label
            <input name="label" required placeholder="Argus" autoComplete="off" />
          </label>
          <label>
            Filesystem root
            <input name="root" required placeholder="/Users/name/Developer/project" autoComplete="off" />
          </label>
          <button type="submit">Add workspace</button>
        </form>
      </section>
    </main>
  );
}
