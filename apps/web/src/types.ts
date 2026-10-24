// Shared API types remain the source of truth. Dashboard projections below
// derive their fields from shared types instead of maintaining copied lists.
import type {
  Agent as SharedAgent,
  AgentIntent as SharedAgentIntent,
  ActivityRecord as SharedActivityRecord,
  PolicyDecision as SharedPolicyDecision,
  ScheduleStatus,
  SimulationResult,
} from '@4evergent/shared';

export type {
  PolicyRules,
  ActivityStatus,
  ScheduleStatus,
  AuthorizationStatus,
  AgentStatus,
  IntentType,
  SimulationResult,
  PaymentIntent as SubmitPaymentIntent,
  TrustlineIntent as SubmitTrustlineIntent,
} from '@4evergent/shared';

type UnionKeys<T> = T extends unknown ? keyof T : never;
type UnionValue<T, K extends PropertyKey> =
  T extends unknown ? K extends keyof T ? T[K] : never : never;

// Tables read optional fields across intent kinds. Retain the discriminated
// union, while allowing those fields to be read without duplicating its shape.
export type AgentIntent = SharedAgentIntent & {
  [K in UnionKeys<SharedAgentIntent>]?: UnionValue<SharedAgentIntent, K>;
};
export type PolicyDecision = Omit<SharedPolicyDecision, 'intent'> & { intent: AgentIntent };
export type ActivityRecord = Omit<SharedActivityRecord, 'intent' | 'policyDecision'> & {
  intent: AgentIntent;
  policyDecision: PolicyDecision;
};

// API responses normalize optional agent fields, and omit internal metadata.
export type AgentRecord = Omit<SharedAgent, 'metadata'> &
  Required<Pick<SharedAgent, 'description' | 'stellarAddress' | 'capabilities'>>;

export interface ScheduleRecord {
  id: string;
  agentId: string;
  ownerId: string;
  status: ScheduleStatus;
  intent: {
    type: string;
    asset?: string;
    amount?: string;
    destination?: string;
    reason?: string;
  };
  scheduleExpression: string;
  timezone: string;
  nextRunAt: string;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
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

export type ExecutionStatus =
  | "queued"
  | "executing"
  | "submitted"
  | "confirmed"
  | "failed"
  | "dead_letter"
  | "cancelled";

export interface ExecutionRecord {
  id: string;
  ownerId: string;
  agentId: string;
  approvalId: string | null;
  activityId: string | null;
  intent: AgentIntent & { assetDetails?: { code?: string; issuer?: string | null } };
  status: ExecutionStatus;
  policyDecision: PolicyDecision | null;
  simulationResult: SimulationResult | null;
  txHash: string | null;
  error: string | null;
  attempt: number;
  nextRetryAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorClass: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueSummary {
  running: boolean;
  byStatus: Record<string, number>;
}

export interface ApiError {
  error: string;
}
