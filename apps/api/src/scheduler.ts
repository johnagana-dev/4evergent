import type { ScheduleRecord } from "@4evergent/database";
import type { SchedulerConfig, ExecutionContext } from "./scheduler-types.js";
import type { ScheduleExecutionResult } from "./schedule-execution.js";

type AgentInfo = { id: string; status: string; ownerId: string };

export class AgentScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private clock: () => Date;
  private intervalMs: number;
  private maxLatenessMs: number;

  constructor(
    private scheduleStore: { get(id: string): Promise<ScheduleRecord | null>; listDue(before: string, limit?: number): Promise<ScheduleRecord[]>; update(id: string, patch: Partial<ScheduleRecord>): Promise<ScheduleRecord | null>; delete(id: string): Promise<boolean> },
    private agentStore: { get(id: string): Promise<AgentInfo | null> },
    private executeCallback: (schedule: ScheduleRecord, ctx: ExecutionContext) => Promise<ScheduleExecutionResult>,
    config: SchedulerConfig = {}
  ) {
    this.clock = config.clock ?? (() => new Date());
    this.intervalMs = config.intervalMs ?? 60_000;
    this.maxLatenessMs = config.maxLatenessMs ?? 5 * 60_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async runDue(nowIso?: string): Promise<number> {
    const now = nowIso ?? this.clock().toISOString();
    const due = await this.scheduleStore.listDue(now, 100);
    let executed = 0;

    for (const schedule of due) {
      if (schedule.status !== "active") continue;

      const agent = await this.agentStore.get(schedule.agentId);
      if (!agent || agent.status !== "active") continue;

      // Duplicate trigger guard: skip if already ran at this exact timestamp
      if (schedule.lastRunAt && schedule.lastRunAt === now) continue;

      const scheduledAt = Date.parse(schedule.nextRunAt);
      const latenessMs = Date.parse(now) - scheduledAt;
      if (Number.isFinite(scheduledAt) && latenessMs > this.maxLatenessMs) {
        const { validateScheduleExpression } = await import("@4evergent/database");
        const next = validateScheduleExpression(schedule.scheduleExpression, schedule.timezone);
        const nextRunAt = next.valid && next.nextRunAt && Date.parse(next.nextRunAt) > Date.parse(now)
          ? next.nextRunAt
          : null;
        if (nextRunAt) {
          await this.scheduleStore.update(schedule.id, { nextRunAt, lastRunAt: now });
        } else {
          // Never leave an unadvanceable occurrence active: it would remain
          // due on every poll. Pause it so an operator can correct the
          // expression before the scheduler considers it again.
          await this.scheduleStore.update(schedule.id, { status: "paused", lastRunAt: now });
          console.error(
            `[scheduler] paused stale schedule ${schedule.id}: could not compute a future occurrence${next.error ? ` (${next.error})` : ""}`
          );
        }
        console.warn(`[scheduler] skipped stale schedule ${schedule.id}: ${Math.round(latenessMs / 1000)}s late (limit ${Math.round(this.maxLatenessMs / 1000)}s)`);
        continue;
      }

      try {
        await this.runSchedule(schedule, now);
        executed++;
      } catch (err) {
        console.error(`[scheduler] schedule ${schedule.id} failed:`, err);
      }
    }

    return executed;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.runDue();
    } catch (err) {
      console.error("[scheduler] tick error:", err);
    }

    if (!this.running) return;

    this.timer = setTimeout(() => {
      void this.tick();
    }, this.intervalMs);
  }

  private async runSchedule(schedule: ScheduleRecord, nowIso: string): Promise<void> {
    try {
      await this.executeCallback(schedule, { executedAt: nowIso });

      const { validateScheduleExpression } = await import("@4evergent/database");
      const result = validateScheduleExpression(schedule.scheduleExpression, schedule.timezone);

      await this.scheduleStore.update(schedule.id, {
        lastRunAt: nowIso,
        ...(result.valid ? { nextRunAt: result.nextRunAt ?? schedule.nextRunAt } : {}),
      });
    } catch (err) {
      await this.scheduleStore.update(schedule.id, { lastRunAt: nowIso });
      throw err;
    }
  }
}
