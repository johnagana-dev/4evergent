// Client-side types mirroring the API responses.
// These intentionally omit all secret, XDR, and transaction-blob fields.
// The API is the source of truth — types here are for frontend ergonomics.

export interface PolicyRules {
  maxTxAmount: Record<string, string>;
  dailySpendingLimit: Record<string, string>;
  allowedAssets: string[];
  allowedDestinations: string[];
  allowedContractIds: string[];
  txTypeRestrictions: Record<string, boolean>;
  approvalThreshold: string;
  requireHumanApprovalForAmountAbove: string;
}

export type ActivityStatus =
  | "pending"
  | "rejected"
  | "requires_approval"
  | "approved"
  | "signed"
  | "submitted"
  | "failed";

export type ScheduleStatus = "active" | "paused" | "disabled";

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

export type AuthorizationStatus =
  | "not_required"
  | "pending_approval"
  | "approved"
  | "denied_by_policy"
  | "denied_by_simulation";

export type ApprovalStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "expired"
  | "executing"
  | "submitted"
  | "confirmed"
  | "failed";

export type AgentStatus = "active" | "paused" | "disabled";

export type IntentType = "payment" | "trustline" | "contract_call" | "account_settings";

export interface AgentIntent {
  type: IntentType;
  asset?: string;
  amount?: string;
  destination?: string;
  reason?: string;
  memo?: string;
  [key: string]: unknown;
}

export interface PolicyDecision {
  result: "allow" | "deny" | "requires_approval";
  reason: string;
  rule: string;
  intent: AgentIntent;
}

export interface SimulationResult {
  success: boolean;
  fee: string;
  operations: number;
  warnings: string[];
  error?: string;
}

export interface AgentRecord {
  id: string;
  displayName: string;
  description: string;
  ownerId: string;
  stellarAddress: string;
  capabilities: string[];
  status: AgentStatus;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityRecord {
  id: string;
  agentId: string;
  ownerId: string;
  intent: AgentIntent;
  policyDecision: PolicyDecision;
  authorizationStatus: AuthorizationStatus | null;
  simulationResult: SimulationResult | null;
  txHash: string | null;
  status: ActivityStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

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

export interface SubmitPaymentIntent {
  type: "payment";
  asset: string;
  assetDetails?: {
    code: string;
    issuer: string | null;
  };
  destination: string;
  amount: string;
  reason: string;
  memo?: string;
}

export interface SubmitTrustlineIntent {
  type: "trustline";
  assetCode: string;
  issuer: string;
  limit?: string;
  reason: string;
}
