import { assessRepository, repositoryReasonText, safeFastForwardSyncPreview, sortRepositoryAssessments } from "./repository-assessment";
import type { RepositoryView } from "./repository-observations";
import type { NeonProjectObservation } from "./neon";
import type { CredentialReferenceView, EnvironmentProfileView } from "./workspace-app";
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
  credentials = [],
  environments = [],
  neonProjects = [],
  error,
}: {
  workspaces: WorkspaceRecord[];
  repositories?: RepositoryView[];
  credentials?: CredentialReferenceView[];
  environments?: EnvironmentProfileView[];
  neonProjects?: NeonProjectObservation[];
  error?: string;
}) {
  const labels = new Map(workspaces.map((workspace) => [workspace.id, workspace.label]));
  const assessments = new Map(repositories.map((repository) => [repository.worktreeId, assessRepository(repository)]));
  const needsAttention = sortRepositoryAssessments([...assessments.values()])
    .filter((assessment) => assessment.attention !== "HEALTHY");

  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">ARGUS · LOCAL WORKSPACE</p>
        <h1>Workspace foundation</h1>
        <p className="lede">Register existing filesystem roots and observe repository state without changing repository contents or Git state.</p>
      </header>

      {error ? <p className="error" role="alert">{error}</p> : null}

      <section className="panel" aria-labelledby="credentials-heading">
        <div className="section-heading">
          <h2 id="credentials-heading">Credential references</h2>
          <span>{credentials.length}</span>
        </div>
        <p className="empty">Argus stores locator metadata only. Availability is checked through macOS Keychain.</p>
        {credentials.length === 0 ? (
          <p className="empty">No credential references configured.</p>
        ) : (
          <ul className="workspace-list">
            {credentials.map((credential) => (
              <li key={credential.id} className="workspace-row">
                <div>
                  <strong>{credential.label ?? credential.externalSystem}</strong>
                  <small>{credential.externalSystem}</small>
                  <code>{credential.keychainService} · {credential.keychainAccount}</code>
                </div>
                <div className="workspace-actions">
                  <strong>{credential.availability}</strong>
                  <small>v{credential.version}</small>
                  <form action="/credentials" method="post">
                    <input type="hidden" name="intent" value="archive" />
                    <input type="hidden" name="id" value={credential.id} />
                    <input type="hidden" name="version" value={credential.version} />
                    <button type="submit">Archive reference</button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form action="/credentials" method="post" className="workspace-form">
          <input type="hidden" name="intent" value="create" />
          <label>
            External system
            <input name="externalSystem" required placeholder="GitHub" autoComplete="off" />
          </label>
          <label>
            Keychain service
            <input name="keychainService" required placeholder="argus.github" autoComplete="off" />
          </label>
          <label>
            Keychain account
            <input name="keychainAccount" required placeholder="account" autoComplete="off" />
          </label>
          <label>
            Label (optional)
            <input name="label" placeholder="Primary GitHub" autoComplete="off" />
          </label>
          <button type="submit">Add credential reference</button>
        </form>
      </section>

      <section className="panel" aria-labelledby="environments-heading">
        <div className="section-heading">
          <h2 id="environments-heading">Environment profiles</h2>
          <span>{environments.length}</span>
        </div>
        {environments.length === 0 ? (
          <p className="empty">No environment profiles configured.</p>
        ) : (
          <ul className="workspace-list">
            {environments.map((environment) => (
              <li key={environment.id} className="workspace-row">
                <div>
                  <strong>{environment.label ?? environment.environmentName}</strong>
                  <small>{labels.get(environment.workspaceId) ?? environment.workspaceId} · {environment.environmentName}</small>
                  {environment.settings.map((setting) => (
                    <code key={setting.key}>{setting.key}={String(setting.value)}</code>
                  ))}
                  {environment.credentialBindings.map((binding) => (
                    <code key={binding.key}>{binding.key} → {binding.credentialReferenceId} · {binding.availability}</code>
                  ))}
                </div>
                <div className="workspace-actions">
                  <small>v{environment.version}</small>
                  <form action="/environments" method="post">
                    <input type="hidden" name="intent" value="archive" />
                    <input type="hidden" name="id" value={environment.id} />
                    <input type="hidden" name="version" value={environment.version} />
                    <button type="submit">Archive environment</button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form action="/environments" method="post" className="workspace-form">
          <input type="hidden" name="intent" value="create" />
          <label>
            Workspace
            <select name="workspaceId" required defaultValue="">
              <option value="" disabled>Select workspace</option>
              {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.label}</option>)}
            </select>
          </label>
          <label>
            Environment name
            <input name="environmentName" required placeholder="production" autoComplete="off" />
          </label>
          <label>
            Label (optional)
            <input name="label" placeholder="Production" autoComplete="off" />
          </label>
          <label>
            Settings (one KEY=VALUE per line)
            <textarea name="settings" rows={3} placeholder={"REGION=asia-southeast1\nLOG_LEVEL=info"} />
          </label>
          <label>
            Credential bindings (one KEY=REFERENCE_ID per line)
            <textarea name="credentialBindings" rows={3} placeholder="GITHUB_CREDENTIAL=reference-id" />
          </label>
          <button type="submit" disabled={workspaces.length === 0}>Add environment profile</button>
        </form>
      </section>

      <section className="panel" aria-labelledby="neon-heading">
        <div className="section-heading">
          <h2 id="neon-heading">Neon project observation</h2>
          <span>{neonProjects.length}</span>
        </div>
        <p className="empty">Read-only project metadata from the exact Neon project configured by an active environment profile.</p>
        {neonProjects.length === 0 ? (
          <p className="empty">No active environment profile has both NEON_PROJECT_ID and NEON_API_KEY configured.</p>
        ) : (
          <ul className="repository-list">
            {neonProjects.map((project) => (
              <li key={project.environmentProfileId} className="repository-row">
                <div className="repository-title">
                  <div>
                    <small>{labels.get(project.workspaceId) ?? project.workspaceId} · {project.environmentName}</small>
                    <strong>{project.name ?? project.configuredProjectId}</strong>
                    <code>{project.configuredProjectId}</code>
                  </div>
                  <span>{project.status ?? "not observed"}</span>
                </div>
                <dl className="repository-facts">
                  <div><dt>Provider project ID</dt><dd><code>{project.providerProjectId ?? "not observed"}</code></dd></div>
                  <div><dt>Availability</dt><dd>{project.availability}</dd></div>
                  <div><dt>Freshness</dt><dd>{project.freshness}</dd></div>
                  <div><dt>Observed</dt><dd>{project.observedAt ?? "not observed"}</dd></div>
                  <div><dt>Checked</dt><dd>{project.checkedAt ?? "not checked"}</dd></div>
                  <div><dt>Region</dt><dd>{project.metadata.regionId ?? "unknown"}</dd></div>
                  <div><dt>Platform</dt><dd>{project.metadata.platformId ?? "unknown"}</dd></div>
                  <div><dt>Postgres</dt><dd>{project.metadata.pgVersion ?? "unknown"}</dd></div>
                  <div><dt>Source</dt><dd><code>{project.sourceEndpoint}</code></dd></div>
                  <div><dt>Last failure</dt><dd>{project.failureKind ?? "none"}</dd></div>
                </dl>
                <form action="/neon" method="post">
                  <input type="hidden" name="environmentProfileId" value={project.environmentProfileId} />
                  <button type="submit">Refresh Neon project</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

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

      <section className="panel" aria-labelledby="attention-heading">
        <div className="section-heading">
          <h2 id="attention-heading">Needs attention</h2>
          <span>{needsAttention.length}</span>
        </div>
        {needsAttention.length === 0 ? (
          <p className="empty">No repositories currently need attention.</p>
        ) : (
          <ul className="repository-list">
            {needsAttention.map((assessment) => (
              <li key={`${assessment.identity.canonicalRepositoryIdentity}:${assessment.identity.localPath}`} className="repository-row">
                <div className="repository-title">
                  <div>
                    <strong>{assessment.identity.githubAlias ?? assessment.identity.canonicalRepositoryIdentity}</strong>
                    <code>{assessment.identity.localPath}</code>
                  </div>
                  <span>{assessment.attention}</span>
                </div>
                <dl className="repository-facts">
                  <div><dt>Health</dt><dd>{assessment.health}</dd></div>
                  <div><dt>Sync</dt><dd>{assessment.syncCondition}</dd></div>
                  <div><dt>Attention</dt><dd>{assessment.attention}</dd></div>
                </dl>
                <ul>
                  {assessment.reasons.map((reason) => (
                    <li key={reason}><code>{reason}</code> · {repositoryReasonText(reason)}</li>
                  ))}
                </ul>
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
              const assessment = assessments.get(repository.worktreeId) ?? assessRepository(repository);
              const displayIdentity = repository.github.canonicalAlias
                ?? repository.githubAlias
                ?? repository.canonicalRepositoryIdentity;
              const branch = repository.local.detached ? "detached" : (repository.local.branch ?? "unknown");
              const dirty = repository.local.dirty === null ? "unknown" : String(repository.local.dirty);
              const tracking = repository.local.aheadBehind
                ? `ahead=${repository.local.aheadBehind.ahead} behind=${repository.local.aheadBehind.behind}`
                : "not locally provable";
              const relation = repository.github.relation;
              const preview = safeFastForwardSyncPreview(repository);
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
                    <div><dt>Health</dt><dd>{assessment.health}</dd></div>
                    <div><dt>Sync</dt><dd>{assessment.syncCondition}</dd></div>
                    <div><dt>Attention</dt><dd>{assessment.attention}</dd></div>
                    <div><dt>Reasons</dt><dd>{assessment.reasons.length ? assessment.reasons.join(", ") : "none"}</dd></div>
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
                    <div><dt>GitHub relation</dt><dd>{relation?.relation ?? "UNKNOWN"}</dd></div>
                    <div><dt>Relation repository</dt><dd>{relation?.repositoryAlias ?? "unknown"}</dd></div>
                    <div><dt>Relation ref</dt><dd>{relation?.refName ?? "unknown"}</dd></div>
                    <div><dt>Relation local SHA</dt><dd><code>{relation?.localSha ?? "unknown"}</code></dd></div>
                    <div><dt>Relation GitHub SHA</dt><dd><code>{relation?.githubSha ?? "unknown"}</code></dd></div>
                    <div><dt>Relation source version</dt><dd><code>{relation?.sourceVersion ?? "unknown"}</code></dd></div>
                    <div><dt>Relation provenance</dt><dd>{relation?.provenance ?? "unknown"}</dd></div>
                    <div><dt>Safe sync preview</dt><dd>{preview.state}</dd></div>
                    <div><dt>Preview reasons</dt><dd>{preview.reasons.join(", ") || "none"}</dd></div>
                    <div><dt>Expected local pre-HEAD</dt><dd><code>{preview.expectedLocalPreHead ?? "unknown"}</code></dd></div>
                    <div><dt>Expected GitHub target SHA</dt><dd><code>{preview.expectedGitHubTargetSha ?? "unknown"}</code></dd></div>
                  </dl>

                  {assessment.reasons.length ? (
                    <ul>
                      {assessment.reasons.map((reason) => (
                        <li key={reason}><code>{reason}</code> · {repositoryReasonText(reason)}</li>
                      ))}
                    </ul>
                  ) : null}

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
                    <div>
                      <small>GITHUB RELATION</small>
                      <strong>{relation ? evidenceStatus(relation.availability, relation.freshness, relation.conflictState) : "UNKNOWN · UNKNOWN"}</strong>
                      <span>{relation ? observationTime(relation.observedAt, relation.checkedAt) : "not observed"}</span>
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
