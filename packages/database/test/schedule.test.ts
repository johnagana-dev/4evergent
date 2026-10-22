import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  SQLiteScheduleStore,
  InMemoryScheduleStore,
} from "../src/index.js";
import type { AgentIntent, PolicyDecision } from "@4evergent/shared";

function makeIntent(amount = "10"): AgentIntent {
  return {
    type: "payment",
    asset: "XLM",
    destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amount,
    reason: "test schedule",
  };
}

function _makeDecision(): PolicyDecision {
  return { result: "allow", reason: "test", rule: "test", intent: makeIntent() };
}

function makeSchedule(overrides: any = {}) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId: "agent-a",
    ownerId: "owner-a",
    status: "active",
    intent: makeIntent(),
    scheduleExpression: "0 * * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() + 60000).toISOString(),
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("InMemory: create/get schedule round-trips", async () => {
  const store = new InMemoryScheduleStore();
  const schedule = makeSchedule();
  await store.create(schedule);
  const got = await store.get(schedule.id);
  assert.deepEqual(got, schedule);
});

test("SQLite: create/get schedule round-trips", async () => {
  const dir = mkdtempSync(join(tmpdir(), "4evergent-sched-"));
  const path = join(dir, "test.db");
  try {
    const store = new SQLiteScheduleStore(path);
    const schedule = makeSchedule();
    await store.create(schedule);
    const got = await store.get(schedule.id);
    assert.ok(got);
    assert.equal(got!.id, schedule.id);
    assert.equal(got!.agentId, schedule.agentId);
    assert.equal(got!.ownerId, schedule.ownerId);
    assert.equal(got!.status, schedule.status);
    assert.equal(got!.scheduleExpression, schedule.scheduleExpression);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("InMemory: listByAgent returns only that agent's schedules", async () => {
  const store = new InMemoryScheduleStore();
  const s1 = makeSchedule({ id: "s1", agentId: "agent-a" });
  const s2 = makeSchedule({ id: "s2", agentId: "agent-a" });
  const s3 = makeSchedule({ id: "s3", agentId: "agent-b" });
  await store.create(s1);
  await store.create(s2);
  await store.create(s3);

  const listA = await store.listByAgent("agent-a");
  assert.equal(listA.length, 2);
  assert.ok(listA.every((s) => s.agentId === "agent-a"));

  const listB = await store.listByAgent("agent-b");
  assert.equal(listB.length, 1);
  assert.equal(listB[0]!.id, "s3");
});

test("InMemory: listByOwner returns only that owner's schedules", async () => {
  const store = new InMemoryScheduleStore();
  const s1 = makeSchedule({ id: "s1", ownerId: "owner-a" });
  const s2 = makeSchedule({ id: "s2", ownerId: "owner-b" });
  await store.create(s1);
  await store.create(s2);

  const listA = await store.listByOwner("owner-a");
  assert.equal(listA.length, 1);
  assert.equal(listA[0]!.id, "s1");
});

test("InMemory: listDue returns only active schedules with nextRunAt <= before", async () => {
  const store = new InMemoryScheduleStore();
  const now = new Date();
  const past = new Date(now.getTime() - 60000).toISOString();
  const future = new Date(now.getTime() + 3600000).toISOString();

  const s1 = makeSchedule({ id: "s1", nextRunAt: past, status: "active" });
  const s2 = makeSchedule({ id: "s2", nextRunAt: future, status: "active" });
  const s3 = makeSchedule({ id: "s3", nextRunAt: past, status: "paused" });
  const s4 = makeSchedule({ id: "s4", nextRunAt: past, status: "disabled" });
  await store.create(s1);
  await store.create(s2);
  await store.create(s3);
  await store.create(s4);

  const due = await store.listDue(now.toISOString());
  assert.equal(due.length, 1);
  assert.equal(due[0]!.id, "s1");
});

test("InMemory: update modifies schedule", async () => {
  const store = new InMemoryScheduleStore();
  const schedule = makeSchedule();
  await store.create(schedule);

  const updated = await store.update(schedule.id, { status: "paused" });
  assert.ok(updated);
  assert.equal(updated!.status, "paused");

  const got = await store.get(schedule.id);
  assert.equal(got!.status, "paused");
});

test("InMemory: delete removes schedule", async () => {
  const store = new InMemoryScheduleStore();
  const schedule = makeSchedule();
  await store.create(schedule);

  const deleted = await store.delete(schedule.id);
  assert.equal(deleted, true);

  const got = await store.get(schedule.id);
  assert.equal(got, null);
});

test("SQLite: schedule survives reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "4evergent-sched-persist-"));
  const path = join(dir, "test.db");
  try {
    const store1 = new SQLiteScheduleStore(path);
    const schedule = makeSchedule();
    await store1.create(schedule);
    store1.close();

    const store2 = new SQLiteScheduleStore(path);
    const got = await store2.get(schedule.id);
    assert.ok(got);
    assert.equal(got!.id, schedule.id);
    assert.equal(got!.agentId, schedule.agentId);
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("InMemory: listAll returns empty when no schedules", async () => {
  const store = new InMemoryScheduleStore();
  const due = await store.listDue(new Date().toISOString());
  assert.deepEqual(due, []);
});

// ===== SQLite update() regression test =====
// Verifies that SQLiteScheduleStore.update() performs a proper partial
// UPDATE — persisting only the patched fields (scheduleExpression, nextRunAt)
// while preserving all others read back from disk via get().
test("SQLite: update preserves all fields except scheduleExpression and nextRunAt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "4evergent-sched-update-"));
  const path = join(dir, "test.db");
  try {
    const store = new SQLiteScheduleStore(path);

    const createdAt = "2026-01-01T00:00:00.000Z";
    const updatedAt = "2026-01-01T00:00:00.000Z";
    const oldExpression = "0 * * * *";
    const oldNextRun = "2026-06-15T10:00:00.000Z";
    const newExpression = "*/15 * * * *";
    const newNextRun = "2026-06-15T10:15:00.000Z";

    const schedule = makeSchedule({
      id: "sched-update-test",
      agentId: "agent-a",
      ownerId: "owner-a",
      status: "active",
      intent: makeIntent("42"),
      scheduleExpression: oldExpression,
      timezone: "UTC",
      nextRunAt: oldNextRun,
      lastRunAt: null,
      createdAt,
      updatedAt,
    });
    await store.create(schedule);

    // Patch only scheduleExpression and nextRunAt — exactly what the
    // handleUpdateSchedule handler sends.
    const result = await store.update(schedule.id, {
      scheduleExpression: newExpression,
      nextRunAt: newNextRun,
    });
    assert.ok(result);

    // Read back from disk to verify the UPDATE statement wrote correctly.
    const got = await store.get(schedule.id);
    assert.ok(got, "schedule should still exist after update");

    // Fields that MUST be preserved (unchanged by PATCH).
    assert.equal(got!.id, "sched-update-test", "id preserved");
    assert.equal(got!.agentId, "agent-a", "agentId preserved");
    assert.equal(got!.ownerId, "owner-a", "ownerId preserved");
    assert.equal(got!.status, "active", "status preserved");
    assert.equal(got!.timezone, "UTC", "timezone preserved");
    assert.equal(got!.intent.type, "payment", "intent.type preserved");
    assert.equal(got!.intent.asset, "XLM", "intent.asset preserved");
    assert.equal(got!.intent.amount, "42", "intent.amount preserved");
    assert.equal(got!.intent.destination, "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "intent.destination preserved");
    assert.equal(got!.intent.reason, "test schedule", "intent.reason preserved");
    assert.equal(got!.createdAt, createdAt, "createdAt preserved");
    assert.equal(got!.lastRunAt, null, "lastRunAt preserved");

    // Fields that MUST be updated by PATCH.
    assert.equal(got!.scheduleExpression, newExpression, "scheduleExpression updated");
    assert.equal(got!.nextRunAt, newNextRun, "nextRunAt updated");

    // updatedAt should have changed (SQLiteScheduleStore sets it in update()).
    assert.notEqual(got!.updatedAt, updatedAt, "updatedAt changed");

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
