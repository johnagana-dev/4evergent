import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  InMemoryScheduleStore,
  SQLiteScheduleStore,
  type ScheduleRecord,
  type ScheduleStore,
} from "@4evergent/database";
import type { AgentIntent } from "@4evergent/shared";
import { ScheduleRecoveryService } from "../src/schedule-recovery.js";
import { AgentScheduler } from "../src/scheduler.js";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import {
  InMemoryActivityStore,
  InMemoryApprovalStore,
  InMemoryExecutionStore,
  InMemoryAgentStore,
} from "@4evergent/database";

function makeIntent(): AgentIntent {
  return {
    type: "payment",
    asset: "XLM",
    destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amount: "10",
    reason: "test scheduled payment",
  };
}

function makeSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId: "agent-a",
    ownerId: "owner-a",
    status: "active",
    intent: makeIntent(),
    scheduleExpression: "0 * * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() - 60000).toISOString(),
    lastRunAt: null,
    lastStartedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const storeHarnesses: Array<{
  name: string;
  create: () => { store: ScheduleStore; cleanup: () => void };
}> = [
  {
    name: "InMemoryScheduleStore",
    create: () => ({
      store: new InMemoryScheduleStore(),
      cleanup: () => {},
    }),
  },
  {
    name: "SQLiteScheduleStore",
    create: () => {
      const dir = mkdtempSync(join(tmpdir(), "4evergent-sched-rec-"));
      const path = join(dir, "test.db");
      const store = new SQLiteScheduleStore(path);
      return {
        store,
        cleanup: () => {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

for (const harness of storeHarnesses) {
  test(`${harness.name}: recovers interrupted schedule where bookkeeping never landed`, async () => {
    const { store, cleanup } = harness.create();
    try {
      const startedAt = "2026-01-01T00:00:00.000Z";
      const schedule = makeSchedule({
        scheduleExpression: "0 * * * *",
        nextRunAt: startedAt,
        lastRunAt: null,
        lastStartedAt: startedAt, // Bookkeeping never landed before process termination
      });
      await store.create(schedule);

      const recovery = new ScheduleRecoveryService(store);
      const result = await recovery.recover();

      assert.equal(result.found, 1);
      assert.equal(result.recovered, 1);
      assert.deepEqual(result.recoveredIds, [schedule.id]);
      assert.equal(result.errors.length, 0);

      const updated = await store.get(schedule.id);
      assert.ok(updated);
      assert.equal(updated.lastStartedAt, null, "in-progress marker cleared");
      assert.equal(updated.lastRunAt, startedAt, "lastRunAt recorded from interrupted attempt");
      assert.ok(
        Date.parse(updated.nextRunAt) > Date.parse(startedAt),
        "nextRunAt advanced to future occurrence"
      );
      assert.equal(updated.status, "active", "status remains active");
    } finally {
      cleanup();
    }
  });

  test(`${harness.name}: normal completion is not treated as interrupted (no false positive)`, async () => {
    const { store, cleanup } = harness.create();
    try {
      const completedAt = "2026-01-01T00:00:00.000Z";
      const schedule = makeSchedule({
        scheduleExpression: "0 * * * *",
        nextRunAt: "2026-01-01T01:00:00.000Z",
        lastRunAt: completedAt,
        lastStartedAt: null, // Normal run cleared marker
      });
      await store.create(schedule);

      const recovery = new ScheduleRecoveryService(store);
      const result = await recovery.recover();

      assert.equal(result.found, 0);
      assert.equal(result.recovered, 0);

      const check = await store.get(schedule.id);
      assert.ok(check);
      assert.equal(check.lastRunAt, completedAt);
      assert.equal(check.nextRunAt, "2026-01-01T01:00:00.000Z");
      assert.equal(check.lastStartedAt, null);
    } finally {
      cleanup();
    }
  });

  test(`${harness.name}: reconciliation is idempotent (running twice produces same result)`, async () => {
    const { store, cleanup } = harness.create();
    try {
      const startedAt = "2026-01-01T00:00:00.000Z";
      const schedule = makeSchedule({
        scheduleExpression: "0 * * * *",
        nextRunAt: startedAt,
        lastRunAt: null,
        lastStartedAt: startedAt,
      });
      await store.create(schedule);

      const recovery = new ScheduleRecoveryService(store);

      // First run recovers
      const result1 = await recovery.recover();
      assert.equal(result1.found, 1);
      assert.equal(result1.recovered, 1);

      const afterFirst = await store.get(schedule.id);

      // Second run is a no-op
      const result2 = await recovery.recover();
      assert.equal(result2.found, 0);
      assert.equal(result2.recovered, 0);
      assert.deepEqual(result2.recoveredIds, []);

      const afterSecond = await store.get(schedule.id);
      assert.deepEqual(afterFirst, afterSecond);
    } finally {
      cleanup();
    }
  });

  test(`${harness.name}: pauses an interrupted schedule when expression cannot advance`, async () => {
    const { store, cleanup } = harness.create();
    try {
      const startedAt = "2026-01-01T00:00:00.000Z";
      const schedule = makeSchedule({
        scheduleExpression: "invalid-cron-expr",
        nextRunAt: startedAt,
        lastRunAt: null,
        lastStartedAt: startedAt,
      });
      await store.create(schedule);

      const recovery = new ScheduleRecoveryService(store);
      const result = await recovery.recover();

      assert.equal(result.found, 1);
      assert.equal(result.recovered, 1);

      const updated = await store.get(schedule.id);
      assert.ok(updated);
      assert.equal(updated.lastStartedAt, null);
      assert.equal(updated.lastRunAt, startedAt);
      assert.equal(updated.status, "paused");
    } finally {
      cleanup();
    }
  });

  test(`${harness.name}: preserves paused or disabled status on interrupted schedule`, async () => {
    const { store, cleanup } = harness.create();
    try {
      const startedAt = "2026-01-01T00:00:00.000Z";
      const schedule = makeSchedule({
        status: "paused",
        nextRunAt: startedAt,
        lastRunAt: null,
        lastStartedAt: startedAt,
      });
      await store.create(schedule);

      const recovery = new ScheduleRecoveryService(store);
      const result = await recovery.recover();

      assert.equal(result.found, 1);
      assert.equal(result.recovered, 1);

      const updated = await store.get(schedule.id);
      assert.ok(updated);
      assert.equal(updated.status, "paused");
      assert.equal(updated.lastStartedAt, null);
      assert.equal(updated.lastRunAt, startedAt);
    } finally {
      cleanup();
    }
  });
}

test("AgentScheduler: sets lastStartedAt before callback and clears it on success", async () => {
  const store = new InMemoryScheduleStore();
  const schedule = makeSchedule({ scheduleExpression: "0 * * * *" });
  await store.create(schedule);

  let observedStartedAt: string | null = null;
  const agentStore = {
    get: async () => ({ id: "agent-a", status: "active", ownerId: "owner-a" }),
  };

  const scheduler = new AgentScheduler(store, agentStore, async (rec) => {
    const current = await store.get(rec.id);
    observedStartedAt = current?.lastStartedAt ?? null;
    return {} as any;
  });

  await scheduler.runDue(new Date().toISOString());

  assert.ok(observedStartedAt, "lastStartedAt was set during callback execution");

  const completed = await store.get(schedule.id);
  assert.equal(completed?.lastStartedAt, null, "lastStartedAt was cleared after successful completion");
  assert.ok(completed?.lastRunAt, "lastRunAt was updated");
});

test("AgentScheduler: clears lastStartedAt and preserves lastRunAt when callback throws", async () => {
  const store = new InMemoryScheduleStore();
  const schedule = makeSchedule({ scheduleExpression: "0 * * * *" });
  await store.create(schedule);

  let observedStartedAt: string | null = null;
  const agentStore = {
    get: async () => ({ id: "agent-a", status: "active", ownerId: "owner-a" }),
  };

  const scheduler = new AgentScheduler(store, agentStore, async (rec) => {
    const current = await store.get(rec.id);
    observedStartedAt = current?.lastStartedAt ?? null;
    throw new Error("simulated callback crash");
  });

  await scheduler.runDue(new Date().toISOString());

  assert.ok(observedStartedAt, "lastStartedAt was set during callback execution");

  const failed = await store.get(schedule.id);
  assert.equal(failed?.lastStartedAt, null, "lastStartedAt cleared on callback failure");
  assert.ok(failed?.lastRunAt, "lastRunAt written on callback failure");
});

test("AgentScheduler: in-flight interrupted run is not re-executed by runDue", async () => {
  const store = new InMemoryScheduleStore();
  const schedule = makeSchedule({
    lastStartedAt: new Date(Date.now() - 10000).toISOString(),
    nextRunAt: new Date(Date.now() - 5000).toISOString(),
  });
  await store.create(schedule);

  let callbackCalled = false;
  const agentStore = {
    get: async () => ({ id: "agent-a", status: "active", ownerId: "owner-a" }),
  };

  const scheduler = new AgentScheduler(store, agentStore, async () => {
    callbackCalled = true;
    return {} as any;
  });

  const executed = await scheduler.runDue(new Date().toISOString());
  assert.equal(executed, 0);
  assert.equal(callbackCalled, false, "interrupted schedule was not re-executed");
});

test("Startup lifecycle: server reconciles interrupted schedules before scheduler ticks", async () => {
  const scheduleStore = new InMemoryScheduleStore();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();
  const executionStore = new InMemoryExecutionStore();
  const agentStore = new InMemoryAgentStore();

  const startedAt = "2026-01-01T00:00:00.000Z";
  const schedule = makeSchedule({
    scheduleExpression: "0 * * * *",
    nextRunAt: startedAt,
    lastRunAt: null,
    lastStartedAt: startedAt, // Simulated crash before server restart
  });
  await scheduleStore.create(schedule);

  let scheduleExecuted = false;
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: {
      getAccountId: () => "GTEST",
      getNetworkPassphrase: () => "Test SDF Network ; September 2015",
      sign: async (tx: any) => tx,
    },
    activityStore,
    approvalStore,
    scheduleStore,
    executionStore,
    agentStore,
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    scheduler: {
      enabled: true,
      instance: new AgentScheduler(
        scheduleStore,
        { get: async () => ({ id: "agent-a", status: "active", ownerId: "owner-a" }) },
        async () => {
          scheduleExecuted = true;
          return {} as any;
        }
      ),
    },
  });

  try {
    // The startup lifecycle runs recovery BEFORE scheduler starts.
    const record = await scheduleStore.get(schedule.id);
    assert.ok(record);
    assert.equal(record.lastStartedAt, null, "recovery ran on startup and cleared in-progress marker");
    assert.equal(record.lastRunAt, startedAt, "recovery recorded lastRunAt");
    assert.ok(Date.parse(record.nextRunAt) > Date.parse(startedAt), "nextRunAt advanced to future");
    assert.equal(scheduleExecuted, false, "interrupted schedule was NOT re-executed upon startup");
  } finally {
    await server.close();
  }
});

test("Recovery failure: scheduler does not start if recovery encounters error", async () => {
  const scheduleStore = new InMemoryScheduleStore();
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();
  const executionStore = new InMemoryExecutionStore();
  const agentStore = new InMemoryAgentStore();

  // Force listInterrupted to throw an error simulating a store failure
  scheduleStore.listInterrupted = async () => {
    throw new Error("simulated database failure during recovery");
  };

  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: {
      getAccountId: () => "GTEST",
      getNetworkPassphrase: () => "Test SDF Network ; September 2015",
      sign: async (tx: any) => tx,
    },
    activityStore,
    approvalStore,
    scheduleStore,
    executionStore,
    agentStore,
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    scheduler: {
      enabled: true,
    },
  });

  try {
    // Because recovery threw an error, scheduler must NOT start
    assert.equal(server.scheduler, null, "scheduler must not start after recovery failure");
  } finally {
    await server.close();
  }
});

test("Bounded pagination: handles more than 50 interrupted schedules across multiple batches", async () => {
  const store = new InMemoryScheduleStore();
  const count = 120;
  const now = new Date("2026-06-01T12:00:00.000Z");

  for (let i = 0; i < count; i++) {
    const startedAt = new Date(now.getTime() - (count - i) * 1000).toISOString();
    await store.create(
      makeSchedule({
        id: `sched-page-${i}`,
        scheduleExpression: "*/10 * * * *",
        timezone: "UTC",
        nextRunAt: startedAt,
        lastRunAt: null,
        lastStartedAt: startedAt,
      })
    );
  }

  const recoveryService = new ScheduleRecoveryService(store, {
    now: () => now,
    batchSize: 50,
  });

  const result = await recoveryService.recover();
  assert.equal(result.found, count, "found all 120 interrupted schedules");
  assert.equal(result.recovered, count, "recovered all 120 interrupted schedules");
  assert.equal(result.errors.length, 0, "no errors during paginated recovery");

  // Verify all records were reconciled and none remain interrupted
  const remaining = await store.listInterrupted(200);
  assert.equal(remaining.length, 0, "no interrupted schedules remain");

  for (let i = 0; i < count; i++) {
    const record = await store.get(`sched-page-${i}`);
    assert.ok(record);
    assert.equal(record!.lastStartedAt, null, "in-progress marker cleared");
    assert.ok(record!.lastRunAt !== null, "lastRunAt recorded");
    assert.ok(Date.parse(record!.nextRunAt) > now.getTime(), "nextRunAt advanced to future");
  }
});

test("Concurrency safety: concurrent recovery operations do not overwrite or duplicate work", async () => {
  const store = new InMemoryScheduleStore();
  const count = 30;
  const now = new Date("2026-06-01T12:00:00.000Z");

  for (let i = 0; i < count; i++) {
    const startedAt = new Date(now.getTime() - i * 1000).toISOString();
    await store.create(
      makeSchedule({
        id: `sched-concurrent-${i}`,
        scheduleExpression: "0 * * * *",
        timezone: "UTC",
        nextRunAt: startedAt,
        lastRunAt: null,
        lastStartedAt: startedAt,
      })
    );
  }

  const service1 = new ScheduleRecoveryService(store, { now: () => now });
  const service2 = new ScheduleRecoveryService(store, { now: () => now });

  // Run two recovery passes simultaneously
  const [res1, res2] = await Promise.all([service1.recover(), service2.recover()]);

  // Together, exactly 'count' records must be recovered, with none duplicated
  const totalRecovered = res1.recovered + res2.recovered;
  assert.equal(totalRecovered, count, "exactly 30 records recovered between the two concurrent workers");

  // All recovered IDs are distinct
  const allIds = new Set([...res1.recoveredIds, ...res2.recoveredIds]);
  assert.equal(allIds.size, count, "every record claimed by exactly one worker");

  // Remaining interrupted is 0
  const remaining = await store.listInterrupted();
  assert.equal(remaining.length, 0);
});

test("Transaction-submission semantics: recovery does not execute intent callback or assume transaction failure", async () => {
  const store = new InMemoryScheduleStore();
  const startedAt = "2026-01-01T00:00:00.000Z";
  const now = new Date("2026-01-01T00:05:00.000Z");

  const schedule = makeSchedule({
    id: "sched-tx-semantics",
    scheduleExpression: "0 * * * *",
    nextRunAt: startedAt,
    lastRunAt: null,
    lastStartedAt: startedAt,
  });
  await store.create(schedule);

  let callbackExecuted = false;
  const scheduler = new AgentScheduler(
    store,
    { get: async () => ({ id: "agent-a", status: "active", ownerId: "owner-a" }) },
    async () => {
      callbackExecuted = true;
      return {} as any;
    }
  );

  const recoveryService = new ScheduleRecoveryService(store, { now: () => now });
  const result = await recoveryService.recover();

  assert.equal(result.recovered, 1);
  assert.equal(callbackExecuted, false, "recovery does NOT execute intent callback or re-submit transaction");

  const reconciled = await store.get("sched-tx-semantics");
  assert.equal(reconciled!.lastRunAt, startedAt, "lastRunAt recorded as crash instant");
  assert.equal(reconciled!.lastStartedAt, null, "in-progress marker cleared");
  assert.ok(Date.parse(reconciled!.nextRunAt) > now.getTime(), "nextRunAt advanced without re-executing");

  // Running due immediately after recovery should NOT execute because nextRunAt is in future
  const executed = await scheduler.runDue(now.toISOString());
  assert.equal(executed, 0);
  assert.equal(callbackExecuted, false);
});

test("AgentScheduler: failed occurrence advances nextRunAt and is not re-executed on next tick", async () => {
  const store = new InMemoryScheduleStore();
  const schedule = makeSchedule({
    id: "sched-fail-retry",
    scheduleExpression: "*/15 * * * *",
    nextRunAt: "2026-06-01T12:00:00.000Z",
  });
  await store.create(schedule);

  let attempts = 0;
  const agentStore = {
    get: async () => ({ id: "agent-a", status: "active", ownerId: "owner-a" }),
  };

  const scheduler = new AgentScheduler(store, agentStore, async () => {
    attempts++;
    // Simulate callback throwing after attempting transaction submission
    throw new Error("simulated submission network timeout");
  });

  // Tick 1 at 12:00:00 - should trigger and fail
  const executed1 = await scheduler.runDue("2026-06-01T12:00:00.000Z");
  assert.equal(executed1, 0, "runDue counts only successful executions");
  assert.equal(attempts, 1, "callback attempted once");

  const recordAfterFail = await store.get("sched-fail-retry");
  assert.ok(recordAfterFail);
  assert.equal(recordAfterFail.lastStartedAt, null, "in-progress marker cleared on error");
  assert.equal(recordAfterFail.lastRunAt, "2026-06-01T12:00:00.000Z", "lastRunAt recorded");
  assert.ok(
    Date.parse(recordAfterFail.nextRunAt) > Date.parse("2026-06-01T12:00:00.000Z"),
    "nextRunAt advanced to future occurrence after failure"
  );

  // Tick 2 at 12:01:00 (1 minute later, next scheduler tick)
  const executed2 = await scheduler.runDue("2026-06-01T12:01:00.000Z");
  assert.equal(executed2, 0);
  assert.equal(
    attempts,
    1,
    "same occurrence is NOT executed again on next tick, preventing duplicate transaction submission"
  );
});
