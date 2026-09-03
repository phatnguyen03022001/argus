import { randomUUID } from "node:crypto";
import type { SqliteDatabase, Store } from "./persistence";

export interface AuditEntry {
  id: string;
  occurredAt: string;
  actorCategory: "operator" | "system";
  operation: string;
  targetIdentity: string;
  outcome: "success" | "rejected";
  reason: string;
  preRecordId: string | null;
  preVersion: number | null;
  postRecordId: string | null;
  postVersion: number | null;
}

function mapAudit(row: Record<string, unknown>): AuditEntry {
  return {
    id: String(row.id),
    occurredAt: String(row.occurred_at),
    actorCategory: String(row.actor_category) as AuditEntry["actorCategory"],
    operation: String(row.operation),
    targetIdentity: String(row.target_identity),
    outcome: String(row.outcome) as AuditEntry["outcome"],
    reason: String(row.reason),
    preRecordId: row.pre_record_id == null ? null : String(row.pre_record_id),
    preVersion: row.pre_version == null ? null : Number(row.pre_version),
    postRecordId: row.post_record_id == null ? null : String(row.post_record_id),
    postVersion: row.post_version == null ? null : Number(row.post_version),
  };
}

export function insertAudit(db: SqliteDatabase, entry: AuditEntry): void {
  db.prepare(`
    INSERT INTO audit_entries (
      id, occurred_at, actor_category, operation, target_identity, outcome, reason,
      pre_record_id, pre_version, post_record_id, post_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.id,
    entry.occurredAt,
    entry.actorCategory,
    entry.operation,
    entry.targetIdentity,
    entry.outcome,
    entry.reason,
    entry.preRecordId,
    entry.preVersion,
    entry.postRecordId,
    entry.postVersion,
  );
}

export function recordAudit(
  store: Store,
  input: Omit<AuditEntry, "id" | "occurredAt" | "actorCategory"> & { actorCategory?: AuditEntry["actorCategory"] },
): void {
  insertAudit(store.db, {
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    actorCategory: input.actorCategory ?? "operator",
    operation: input.operation,
    targetIdentity: input.targetIdentity,
    outcome: input.outcome,
    reason: input.reason,
    preRecordId: input.preRecordId,
    preVersion: input.preVersion,
    postRecordId: input.postRecordId,
    postVersion: input.postVersion,
  });
}

export function listAuditEntries(store: Store): AuditEntry[] {
  return (store.db.prepare("SELECT * FROM audit_entries ORDER BY occurred_at, id").all() as Record<string, unknown>[]).map(mapAudit);
}
