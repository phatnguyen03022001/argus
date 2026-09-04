import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 4;
export type SqliteDatabase = InstanceType<typeof Database>;

export interface Migration {
  version: number;
  up(db: SqliteDatabase): void;
}

export interface Store {
  db: SqliteDatabase;
  dataRoot: string;
  dbPath: string;
  close(): void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE schema_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL CHECK (version >= 1)
        );

        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          root_path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          version INTEGER NOT NULL CHECK (version >= 1)
        );

        CREATE UNIQUE INDEX workspaces_active_root_unique
          ON workspaces(root_path)
          WHERE archived_at IS NULL;

        CREATE TABLE audit_entries (
          id TEXT PRIMARY KEY,
          occurred_at TEXT NOT NULL,
          actor_category TEXT NOT NULL CHECK (actor_category IN ('operator', 'system')),
          operation TEXT NOT NULL,
          target_identity TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('success', 'rejected')),
          reason TEXT NOT NULL,
          pre_record_id TEXT,
          pre_version INTEGER,
          post_record_id TEXT,
          post_version INTEGER
        );
      `);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE repository_worktrees (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          local_path TEXT NOT NULL,
          repository_kind TEXT NOT NULL CHECK (repository_kind IN ('working-tree', 'linked-worktree')),
          git_dir TEXT NOT NULL,
          common_dir TEXT NOT NULL,
          canonical_repository_identity TEXT NOT NULL,
          github_repository_id TEXT,
          github_alias TEXT,
          github_ref_name TEXT,
          remote_name TEXT,
          remote_url TEXT,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          UNIQUE (workspace_id, local_path)
        );

        CREATE INDEX repository_worktrees_canonical_identity_idx
          ON repository_worktrees(canonical_repository_identity);

        CREATE TABLE repository_observations (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          observation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          worktree_id TEXT NOT NULL,
          source_identity TEXT NOT NULL,
          subject_identity TEXT NOT NULL,
          observation_kind TEXT NOT NULL,
          value_json TEXT,
          absence_reason TEXT,
          observed_at TEXT NOT NULL,
          checked_at TEXT NOT NULL,
          availability TEXT NOT NULL CHECK (availability IN ('AVAILABLE', 'UNAVAILABLE', 'UNKNOWN')),
          freshness TEXT NOT NULL CHECK (freshness IN ('CURRENT', 'STALE', 'UNKNOWN')),
          source_version TEXT,
          provenance TEXT NOT NULL,
          conflict_state TEXT NOT NULL CHECK (conflict_state IN ('NONE', 'CONFLICTED')),
          conflict_value_json TEXT,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY (worktree_id) REFERENCES repository_worktrees(id) ON DELETE CASCADE
        );

        CREATE INDEX repository_observations_identity_idx
          ON repository_observations(observation_id, event_id);

        CREATE INDEX repository_observations_worktree_kind_idx
          ON repository_observations(worktree_id, observation_kind, event_id);
      `);
    },
  },
  {
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE credential_references (
          id TEXT PRIMARY KEY,
          external_system TEXT NOT NULL,
          keychain_service TEXT NOT NULL,
          keychain_account TEXT NOT NULL,
          label TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          version INTEGER NOT NULL CHECK (version >= 1)
        );

        CREATE UNIQUE INDEX credential_references_active_locator_unique
          ON credential_references(keychain_service, keychain_account)
          WHERE archived_at IS NULL;
      `);
    },
  },
  {
    version: 4,
    up(db) {
      db.exec(`
        CREATE TABLE environment_profiles (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          environment_name TEXT NOT NULL,
          label TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          version INTEGER NOT NULL CHECK (version >= 1),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX environment_profiles_active_name_unique
          ON environment_profiles(workspace_id, environment_name)
          WHERE archived_at IS NULL;

        CREATE TABLE environment_settings (
          profile_id TEXT NOT NULL,
          setting_key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          PRIMARY KEY (profile_id, setting_key),
          FOREIGN KEY (profile_id) REFERENCES environment_profiles(id) ON DELETE CASCADE
        );

        CREATE TABLE environment_credential_bindings (
          profile_id TEXT NOT NULL,
          binding_key TEXT NOT NULL,
          credential_reference_id TEXT NOT NULL,
          PRIMARY KEY (profile_id, binding_key),
          FOREIGN KEY (profile_id) REFERENCES environment_profiles(id) ON DELETE CASCADE,
          FOREIGN KEY (credential_reference_id) REFERENCES credential_references(id)
        );
      `);
    },
  },
];

function tableNames(db: SqliteDatabase): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String((row as { name: string }).name));
}

export function readSchemaVersion(db: SqliteDatabase): number {
  const tables = tableNames(db);
  if (!tables.includes("schema_meta")) {
    if (tables.length === 0) return 0;
    throw new Error("Unrecognized schema state: non-empty database has no schema metadata.");
  }

  const row = db.prepare("SELECT version FROM schema_meta WHERE id = 1").get() as { version?: number } | undefined;
  if (!row || !Number.isInteger(row.version) || Number(row.version) < 1) {
    throw new Error("Invalid schema state: schema metadata is missing or malformed.");
  }
  return Number(row.version);
}

export function runMigrations(db: SqliteDatabase, migrations: Migration[] = MIGRATIONS): void {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (let index = 0; index < ordered.length; index += 1) {
    const expected = index + 1;
    if (ordered[index]?.version !== expected) {
      throw new Error(`Invalid migration sequence: expected version ${expected}.`);
    }
  }

  let current = readSchemaVersion(db);
  const latest = ordered.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new Error(`Unsupported schema version ${current}; latest supported version is ${latest}.`);
  }

  for (const migration of ordered) {
    if (migration.version <= current) continue;
    if (migration.version !== current + 1) {
      throw new Error(`Missing migration from schema version ${current} to ${current + 1}.`);
    }

    const apply = db.transaction(() => {
      migration.up(db);
      if (migration.version === 1) {
        db.prepare("INSERT INTO schema_meta (id, version) VALUES (1, ?)").run(migration.version);
      } else {
        const result = db.prepare("UPDATE schema_meta SET version = ? WHERE id = 1").run(migration.version);
        if (result.changes !== 1) throw new Error("Failed to persist schema version.");
      }
    });
    apply();
    current = migration.version;
  }
}

export function defaultDataRoot(): string {
  return path.join(os.homedir(), "Library", "Application Support", "Argus");
}

export function openStore(options: { dataRoot?: string } = {}): Store {
  const dataRoot = path.resolve(options.dataRoot ?? defaultDataRoot());
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const dbPath = path.join(dataRoot, "argus.db");
  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    db,
    dataRoot,
    dbPath,
    close() {
      if (db.open) db.close();
    },
  };
}
