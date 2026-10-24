import { DatabaseSync } from "node:sqlite";
import type { AgentIntent } from "@4evergent/shared";
import type { ScheduleStore, ScheduleRecord } from "./schedule-types.js";
import { getSharedConnection, closeSharedConnection } from "./shared-connection.js";
import { clampOffset, clampLimit } from "./pagination.js";

/**
 * InMemoryScheduleStore — process-local schedule log.
 *
 * LIMITATION: not durable. Records are lost when the process exits.
 */
export class InMemoryScheduleStore implements ScheduleStore {
  private records = new Map<string, ScheduleRecord>();

  async create(record: ScheduleRecord): Promise<ScheduleRecord> {
    const rec: ScheduleRecord = {
      ...record,
      lastStartedAt: record.lastStartedAt ?? null,
    };
    this.records.set(rec.id, rec);
    return rec;
  }

  async get(id: string): Promise<ScheduleRecord | null> {
    return this.records.get(id) ?? null;
  }

  async listByAgent(agentId: string, limit = 50, offset = 0): Promise<ScheduleRecord[]> {
    const safeOffset = clampOffset(offset);
    return [...this.records.values()]
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
      .slice(safeOffset, safeOffset + clampLimit(limit));
  }

  async listByOwner(ownerId: string, limit = 50, offset = 0): Promise<ScheduleRecord[]> {
    const safeOffset = clampOffset(offset);
    return [...this.records.values()]
      .filter((r) => r.ownerId === ownerId)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
      .slice(safeOffset, safeOffset + clampLimit(limit));
  }

  async listDue(before: string, limit = 50): Promise<ScheduleRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.status === "active" && r.nextRunAt <= before)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
      .slice(0, limit);
  }

  async listInterrupted(limit = 50, offset = 0): Promise<ScheduleRecord[]> {
    const safeOffset = clampOffset(offset);
    return [...this.records.values()]
      .filter((r) => r.lastStartedAt !== null && r.lastStartedAt !== undefined)
      .sort((a, b) => (a.lastStartedAt ?? "").localeCompare(b.lastStartedAt ?? ""))
      .slice(safeOffset, safeOffset + clampLimit(limit, 50));
  }

  async update(id: string, patch: Partial<ScheduleRecord>): Promise<ScheduleRecord | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    const updated: ScheduleRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      lastStartedAt: patch.lastStartedAt !== undefined ? patch.lastStartedAt : (existing.lastStartedAt ?? null),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, updated);
    return updated;
  }

  async updateIfLastStartedAt(
    id: string,
    expectedLastStartedAt: string | null,
    patch: Partial<ScheduleRecord>
  ): Promise<ScheduleRecord | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    const current = existing.lastStartedAt ?? null;
    if (current !== expectedLastStartedAt) return null;

    const updated: ScheduleRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      lastStartedAt: patch.lastStartedAt !== undefined ? patch.lastStartedAt : (existing.lastStartedAt ?? null),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

interface ScheduleRow {
  id: string;
  agent_id: string;
  owner_id: string;
  status: string;
  intent_json: string;
  schedule_expression: string;
  timezone: string;
  next_run_at: string;
  last_run_at: string | null;
  last_started_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * SQLiteScheduleStore — persistent ScheduleStore backed by SQLite.
 *
 * Uses Node.js built-in node:sqlite (Node 22+, stable in Node 26). No external
 * database server required. Data persists across process restarts in a file
 * at the path provided to the constructor.
 *
 * Schema is versioned in _meta (schema_version = 3). initSchema() is
 * idempotent and safe to call on every construction.
 */
export class SQLiteScheduleStore implements ScheduleStore {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = getSharedConnection(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);

      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        schedule_expression TEXT NOT NULL,
        timezone TEXT NOT NULL,
        next_run_at TEXT NOT NULL,
        last_run_at TEXT,
        last_started_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_schedules_agent ON schedules(agent_id);
      CREATE INDEX IF NOT EXISTS idx_schedules_owner ON schedules(owner_id);
      CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status);
      CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run_at);
      CREATE INDEX IF NOT EXISTS idx_schedules_last_started ON schedules(last_started_at);
    `);

    try {
      this.db.exec("ALTER TABLE schedules ADD COLUMN last_started_at TEXT");
    } catch {
      // Column already exists or table was created with the column
    }
  }

  async create(record: ScheduleRecord): Promise<ScheduleRecord> {
    this.db
      .prepare(
        `INSERT INTO schedules
         (id, agent_id, owner_id, status, intent_json, schedule_expression, timezone, next_run_at, last_run_at, last_started_at, created_at, updated_at)
         VALUES (@id, @agent_id, @owner_id, @status, @intent_json, @schedule_expression, @timezone, @next_run_at, @last_run_at, @last_started_at, @created_at, @updated_at)`
      )
      .run({
        id: record.id,
        agent_id: record.agentId,
        owner_id: record.ownerId,
        status: record.status,
        intent_json: JSON.stringify(record.intent),
        schedule_expression: record.scheduleExpression,
        timezone: record.timezone,
        next_run_at: record.nextRunAt,
        last_run_at: record.lastRunAt,
        last_started_at: record.lastStartedAt ?? null,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      });
    return { ...record, lastStartedAt: record.lastStartedAt ?? null };
  }

  async get(id: string): Promise<ScheduleRecord | null> {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as unknown as ScheduleRow | undefined;
    return row ? rowToScheduleRecord(row) : null;
  }

  async listByAgent(agentId: string, limit = 50, offset = 0): Promise<ScheduleRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM schedules WHERE agent_id = ? ORDER BY next_run_at ASC LIMIT ? OFFSET ?")
      .all(agentId, clampLimit(limit), clampOffset(offset)) as unknown as ScheduleRow[];
    return rows.map((r) => rowToScheduleRecord(r));
  }

  async listByOwner(ownerId: string, limit = 50, offset = 0): Promise<ScheduleRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM schedules WHERE owner_id = ? ORDER BY next_run_at ASC LIMIT ? OFFSET ?")
      .all(ownerId, clampLimit(limit), clampOffset(offset)) as unknown as ScheduleRow[];
    return rows.map((r) => rowToScheduleRecord(r));
  }

  async listDue(before: string, limit = 50): Promise<ScheduleRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM schedules WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?")
      .all(before, limit) as unknown as ScheduleRow[];
    return rows.map((r) => rowToScheduleRecord(r));
  }

  async listInterrupted(limit = 50, offset = 0): Promise<ScheduleRecord[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM schedules WHERE last_started_at IS NOT NULL ORDER BY last_started_at ASC LIMIT ? OFFSET ?"
      )
      .all(clampLimit(limit, 50), clampOffset(offset)) as unknown as ScheduleRow[];
    return rows.map((r) => rowToScheduleRecord(r));
  }

  async update(id: string, patch: Partial<ScheduleRecord>): Promise<ScheduleRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const updated: ScheduleRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      lastStartedAt: patch.lastStartedAt !== undefined ? patch.lastStartedAt : existing.lastStartedAt,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `UPDATE schedules SET
           status = @status, intent_json = @intent_json, schedule_expression = @schedule_expression,
           timezone = @timezone, next_run_at = @next_run_at, last_run_at = @last_run_at,
           last_started_at = @last_started_at, updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id: updated.id,
        status: updated.status,
        intent_json: JSON.stringify(updated.intent),
        schedule_expression: updated.scheduleExpression,
        timezone: updated.timezone,
        next_run_at: updated.nextRunAt,
        last_run_at: updated.lastRunAt,
        last_started_at: updated.lastStartedAt ?? null,
        updated_at: updated.updatedAt,
      });
    return updated;
  }

  async updateIfLastStartedAt(
    id: string,
    expectedLastStartedAt: string | null,
    patch: Partial<ScheduleRecord>
  ): Promise<ScheduleRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const current = existing.lastStartedAt ?? null;
    if (current !== expectedLastStartedAt) return null;

    const updated: ScheduleRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      lastStartedAt: patch.lastStartedAt !== undefined ? patch.lastStartedAt : existing.lastStartedAt,
      updatedAt: new Date().toISOString(),
    };

    if (expectedLastStartedAt === null) {
      const result = this.db
        .prepare(
          `UPDATE schedules SET
             status = @status, intent_json = @intent_json, schedule_expression = @schedule_expression,
             timezone = @timezone, next_run_at = @next_run_at, last_run_at = @last_run_at,
             last_started_at = @last_started_at, updated_at = @updated_at
           WHERE id = @id AND last_started_at IS NULL`
        )
        .run({
          id: updated.id,
          status: updated.status,
          intent_json: JSON.stringify(updated.intent),
          schedule_expression: updated.scheduleExpression,
          timezone: updated.timezone,
          next_run_at: updated.nextRunAt,
          last_run_at: updated.lastRunAt,
          last_started_at: updated.lastStartedAt ?? null,
          updated_at: updated.updatedAt,
        });
      if (Number(result.changes) === 0) return null;
      return updated;
    }

    const result = this.db
      .prepare(
        `UPDATE schedules SET
           status = @status, intent_json = @intent_json, schedule_expression = @schedule_expression,
           timezone = @timezone, next_run_at = @next_run_at, last_run_at = @last_run_at,
           last_started_at = @last_started_at, updated_at = @updated_at
         WHERE id = @id AND last_started_at = @expected_last_started_at`
      )
      .run({
        id: updated.id,
        status: updated.status,
        intent_json: JSON.stringify(updated.intent),
        schedule_expression: updated.scheduleExpression,
        timezone: updated.timezone,
        next_run_at: updated.nextRunAt,
        last_run_at: updated.lastRunAt,
        last_started_at: updated.lastStartedAt ?? null,
        updated_at: updated.updatedAt,
        expected_last_started_at: expectedLastStartedAt,
      });

    if (Number(result.changes) === 0) return null;
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
    return result.changes > 0;
  }

  close(): void {
    closeSharedConnection(this.dbPath);
  }
}

function rowToScheduleRecord(r: ScheduleRow): ScheduleRecord {
  return {
    id: r.id,
    agentId: r.agent_id,
    ownerId: r.owner_id,
    status: r.status as ScheduleRecord["status"],
    intent: JSON.parse(r.intent_json) as AgentIntent,
    scheduleExpression: r.schedule_expression,
    timezone: r.timezone,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastStartedAt: r.last_started_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
