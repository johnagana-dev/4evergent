import type {
  ActivityRecord,
  AgentIntent,
  AuthorizationStatus,
  PolicyDecision,
  SimulationResult,
  ScheduleStatus,
} from "@4evergent/shared";
import { clampOffset, clampLimit } from "./pagination.js";

/**
 * ActivityStore — persistence interface for the transaction activity log.
 *
 * The store is keyed by activity id and records the FULL decision trail for
 * every intent the pipeline touches, including the ones it rejects. It NEVER
 * stores private keys, seeds, or mnemonics — the ActivityRecord type has no
 * field for secret material, by construction.
 */
export interface ActivityStore {
  record(record: ActivityRecord): Promise<void>;
  get(id: string): Promise<ActivityRecord | null>;
  listByAgent(agentId: string, limit?: number, offset?: number): Promise<ActivityRecord[]>;
  listByStatus(agentId: string, status: string, limit?: number, offset?: number): Promise<ActivityRecord[]>;
  listAll(limit?: number, offset?: number): Promise<ActivityRecord[]>;
  listByOwner(ownerId: string, limit?: number, offset?: number): Promise<ActivityRecord[]>;
  getForOwner(id: string, ownerId: string): Promise<ActivityRecord | null>;
  update(id: string, patch: Partial<ActivityRecord>): Promise<ActivityRecord | null>;
  getByIdempotencyKey(ownerId: string, agentId: string, key: string): Promise<ActivityRecord | null>;
  recordIdempotent(key: string, record: ActivityRecord): Promise<{ record: ActivityRecord; created: boolean }>;
  /** Atomically reserve daily spending. Returns true if reservation succeeded, false if limit would be exceeded. */
  reserveDailySpending(agentId: string, asset: string, amount: string, limit: string, now?: Date): Promise<boolean>;
  /** Get current day's total spent for an agent. */
  getDailySpending(agentId: string, asset: string, now?: Date): Promise<number | null>;
  /** Remove at most `limit` rows with a UTC day earlier than cutoffDay. */
  sweepDailySpending(cutoffDay: string, limit?: number): Promise<number>;
}

/**
 * ApprovalStore — persistence interface for transaction approval records.
 *
 * State machine:
 *   PENDING_APPROVAL → APPROVED → EXECUTING → SUBMITTED/CONFIRMED/FAILED
 *   PENDING_APPROVAL → REJECTED
 *   PENDING_APPROVAL → EXPIRED
 *
 * Approval records NEVER store private keys, transaction blobs, or XDR.
 */
export interface ApprovalStore {
  record(record: ApprovalRecord): Promise<void>;
  get(id: string): Promise<ApprovalRecord | null>;
  /** List approvals for an agent. `status` filters at the store level so that
   *  `offset`/`limit` page over the FILTERED set, not the unfiltered one. */
  listByAgent(agentId: string, limit?: number, offset?: number, status?: string): Promise<ApprovalRecord[]>;
  listByStatus(agentId: string, status: string, limit?: number, offset?: number): Promise<ApprovalRecord[]>;
  listAll(limit?: number, offset?: number): Promise<ApprovalRecord[]>;
  /** List approvals for an owner. `status` filters at the store level (see listByAgent). */
  listByOwner(ownerId: string, limit?: number, offset?: number, status?: string): Promise<ApprovalRecord[]>;
  /** Count approvals for an owner. `status` filters at the store level (see listByOwner).
   *  Unlike list*, this is never capped, so callers get the true total. */
  countByOwner(ownerId: string, status?: string): Promise<number>;
  getForOwner(id: string, ownerId: string): Promise<ApprovalRecord | null>;
  update(id: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | null>;
}

export type ApprovalStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "expired"
  | "executing"
  | "submitted"
  | "confirmed"
  | "failed";

export interface ApprovalRecord {
  id: string;
  activityId: string;
  agentId: string;
  ownerId: string;
  intent: AgentIntent;
  policyDecision: PolicyDecision;
  status: ApprovalStatus;
  requestedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  expiredAt: string | null;
  approver: string | null;
  expiresAt: string | null;
  txHash: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * InMemoryApprovalStore — process-local approval log.
 *
 * LIMITATION: not durable. Records are lost when the process exits.
 */
export class InMemoryApprovalStore implements ApprovalStore {
  private records = new Map<string, ApprovalRecord>();

  async record(record: ApprovalRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    return this.records.get(id) ?? null;
  }

  async listByAgent(agentId: string, limit = 50, offset = 0, status?: string): Promise<ApprovalRecord[]> {
    const safeOffset = clampOffset(offset);
    return [...this.records.values()]
      .filter((r) => r.agentId === agentId && (status === undefined || r.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(safeOffset, safeOffset + clampLimit(limit));
  }

  async listByStatus(agentId: string, status: string, limit = 50, offset = 0): Promise<ApprovalRecord[]> {
    const safeOffset = clampOffset(offset);
    return [...this.records.values()]
      .filter((r) => r.agentId === agentId && r.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(safeOffset, safeOffset + clampLimit(limit));
  }

  async listAll(limit = 50, offset = 0): Promise<ApprovalRecord[]> {
    const safeOffset = clampOffset(offset);
    return [...this.records.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(safeOffset, safeOffset + clampLimit(limit));
  }

  async listByOwner(ownerId: string, limit = 50, offset = 0, status?: string): Promise<ApprovalRecord[]> {
    const safeOffset = clampOffset(offset);
    return [...this.records.values()]
      .filter((r) => r.ownerId === ownerId && (status === undefined || r.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(safeOffset, safeOffset + clampLimit(limit));
  }

  async countByOwner(ownerId: string, status?: string): Promise<number> {
    let n = 0;
    for (const r of this.records.values()) {
      if (r.ownerId === ownerId && (status === undefined || r.status === status)) n++;
    }
    return n;
  }
}
