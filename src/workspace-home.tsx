import type { WorkspaceRecord } from "./workspaces";

export function WorkspaceHome({ workspaces, error }: { workspaces: WorkspaceRecord[]; error?: string }) {
  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">ARGUS · LOCAL WORKSPACE</p>
        <h1>Workspace foundation</h1>
        <p className="lede">Register existing filesystem roots without changing their contents.</p>
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
                <small>v{workspace.version}</small>
              </li>
            ))}
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
