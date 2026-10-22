import type { AgentIntent, ScheduleStatus } from "@4evergent/shared";

export interface ScheduleRecord {
  id: string;
  agentId: string;
  ownerId: string;
  status: ScheduleStatus;
  intent: AgentIntent;
  scheduleExpression: string;
  timezone: string;
  nextRunAt: string;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleStore {
  create(record: ScheduleRecord): Promise<ScheduleRecord>;
  get(id: string): Promise<ScheduleRecord | null>;
  listByAgent(agentId: string, limit?: number, offset?: number): Promise<ScheduleRecord[]>;
  listByOwner(ownerId: string, limit?: number, offset?: number): Promise<ScheduleRecord[]>;
  listDue(before: string, limit?: number): Promise<ScheduleRecord[]>;
  update(id: string, patch: Partial<ScheduleRecord>): Promise<ScheduleRecord | null>;
  delete(id: string): Promise<boolean>;
}
