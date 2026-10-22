import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearAgents, createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import type { Signer } from "@4evergent/stellar";
import type { PolicyRules } from "@4evergent/shared";
import type { AddressInfo } from "node:net";

class MockSigner implements Signer {
  private id: string;
  constructor(id: string) {
    this.id = id.startsWith("G") ? id : `G${id.padEnd(55, "A").slice(0, 55)}`;
  }
  getAccountId(): string { return this.id; }
  getNetworkPassphrase(): string { return "Test SDF Network ; September 2015"; }
  async sign(transaction: any): Promise<any> {
    transaction.signatures = [{ hint: Buffer.from("mock"), signature: Buffer.from("sig") }];
    return transaction;
  }
}

const BASE_RULES: Partial<PolicyRules> = {
  maxTxAmount: { XLM: "1000" },
  requireHumanApprovalForAmountAbove: "10",
};

function makeAgent(id: string, ownerId: string, status = "active") {
  return {
    id,
    displayName: `Agent ${id}`,
    description: "test agent",
    ownerId,
    stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    capabilities: ["payment"],
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    active: true,
    metadata: {},
  };
}

async function startServer(opts: { authProvider: DevAuthProvider }) {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("test-agent"),
    policyRules: BASE_RULES,
    deferExecution: true,
    authProvider: opts.authProvider,
  });

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
    registerAgent: (agent: any) => void;
  }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        registerAgent: (agent: any) => server.registerAgent(agent),
      });
    });
  });
}

async function get(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

async function patch(baseUrl: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  clearAgents();
});

test("AUTHZ: PATCH /agents/:id/status — owner can pause/resume", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));
  try {
    const res = await patch(baseUrl, "/agents/agent-a/status", { status: "paused" });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "paused");

    const check = await get(baseUrl, "/agents/agent-a");
    assert.equal(check.status, 200);
    assert.equal(check.body.status, "paused");
  } finally {
    await close();
  }
});

test("AUTHZ: PATCH /agents/:id/status — non-owner cannot change status", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-b", "owner-b"));
  try {
    const res = await patch(baseUrl, "/agents/agent-b/status", { status: "paused" });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("AUTHZ: PATCH /agents/:id/status — invalid status", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));
  try {
    const res = await patch(baseUrl, "/agents/agent-a/status", { status: "bogus" });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("AUTHZ: GET /agents/:id — owner can read own agent", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a", "paused"));
  try {
    const res = await get(baseUrl, "/agents/agent-a");
    assert.equal(res.status, 200);
    assert.equal(res.body.id, "agent-a");
    assert.equal(res.body.status, "paused");
  } finally {
    await close();
  }
});

test("AUTHZ: GET /agents/:id — non-owner cannot read", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-b", "owner-b"));
  try {
    const res = await get(baseUrl, "/agents/agent-b");
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("AUTHZ: GET /agents/:id/activity/:activityId — owner can read own activity", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));

  const intentRes = await fetch(`${baseUrl}/agents/agent-a/intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "50",
      reason: "detail test",
    }),
  });
  const body = await intentRes.json();
  const activityId = body.activityId;

  try {
    const res = await get(baseUrl, `/agents/agent-a/activity/${activityId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.activity.id, activityId);
  } finally {
    await close();
  }
});

test("AUTHZ: GET /agents/:id/activity/:activityId — non-owner cannot read", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-b", "owner-b"));
  try {
    const res = await get(baseUrl, `/agents/agent-b/activity/some-id`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("AUTHZ: GET /agents/:id/approvals — owner can list own agent approvals", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));

  await fetch(`${baseUrl}/agents/agent-a/intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "50",
      reason: "approvals test",
    }),
  });

  try {
    const res = await get(baseUrl, "/agents/agent-a/approvals");
    assert.equal(res.status, 200);
    assert.equal(res.body.approvals.length, 1);
    assert.equal(res.body.agentId, "agent-a");
  } finally {
    await close();
  }
});

test("AUTHZ: GET /agents/:id/approvals — non-owner cannot list", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-b", "owner-b"));
  try {
    const res = await get(baseUrl, "/agents/agent-b/approvals");
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// Agent status admission boundary — new intents
// ---------------------------------------------------------------------------

async function postIntent(baseUrl: string, agentId: string) {
  const res = await fetch(`${baseUrl}/agents/${agentId}/intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      // amount 50 ≥ approvalThreshold(10) so the pipeline returns 202
      // requires_approval — fully offline and deterministic, no Horizon
      // submission attempted under deferExecution.
      amount: "50",
      reason: "status boundary test",
    }),
  });
  return { status: res.status, body: await res.json() };
}

test("STATUS: active agent accepts new intents (existing behavior unchanged)", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a", "active"));
  try {
    const res = await postIntent(baseUrl, "agent-a");
    // Active agent: intent passes status gate and enters the pipeline.
    // amount 50 ≥ threshold(10) → requires_approval → 202 with approvalId.
    assert.equal(res.status, 202);
    assert.equal(res.body.agentId, "agent-a");
    assert.ok(res.body.approvalId, "approval id must be created for active agent");
  } finally {
    await close();
  }
});

test("STATUS: paused agent rejects new intents with 409", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a", "paused"));
  try {
    const res = await postIntent(baseUrl, "agent-a");
    assert.equal(res.status, 409);
    assert.match(res.body.error, /paused/);

    // No activity record may exist for the rejected intent.
    const activity = await get(baseUrl, "/agents/agent-a/activity");
    assert.equal(activity.body.activity.length, 0, "no activity for paused agent");
  } finally {
    await close();
  }
});

test("STATUS: disabled agent rejects new intents with 409", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a", "disabled"));
  try {
    const res = await postIntent(baseUrl, "agent-a");
    assert.equal(res.status, 409);
    assert.match(res.body.error, /disabled/);

    // No activity record may exist for the rejected intent.
    const activity = await get(baseUrl, "/agents/agent-a/activity");
    assert.equal(activity.body.activity.length, 0, "no activity for disabled agent");
  } finally {
    await close();
  }
});

test("STATUS: paused via PATCH then submit is rejected (lifecycle change applies live)", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a", "active"));
  try {
    // Active: accepted into the pipeline.
    const before = await postIntent(baseUrl, "agent-a");
    assert.equal(before.status, 202);

    // Pause the agent.
    const paused = await patch(baseUrl, "/agents/agent-a/status", { status: "paused" });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.status, "paused");

    // New intent is now rejected — current status read from the store.
    const after = await postIntent(baseUrl, "agent-a");
    assert.equal(after.status, 409);
    assert.match(after.body.error, /paused/);

    // Resume — new intents flow again.
    const resumed = await patch(baseUrl, "/agents/agent-a/status", { status: "active" });
    assert.equal(resumed.status, 200);
    const resumedIntent = await postIntent(baseUrl, "agent-a");
    assert.equal(resumedIntent.status, 202);
  } finally {
    await close();
  }
});

test("STATUS: owner isolation — cannot bypass enforcement via another owner's agent", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-b", "owner-b", "paused"));
  try {
    // owner-a submitting to owner-b's paused agent: 404 (ownership), not 409,
    // so the status gate never leaks cross-owner state.
    const res = await postIntent(baseUrl, "agent-b");
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("STATUS: paused agent intent creates no execution-queue entry", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a", "paused"));
  try {
    const res = await postIntent(baseUrl, "agent-a");
    assert.equal(res.status, 409);

    // No execution record may exist for this agent — rejection happens
    // before any execution record or queue processing is created.
    const executions = await get(baseUrl, "/agents/agent-a/executions");
    assert.equal(executions.status, 200);
    assert.equal(executions.body.executions.length, 0, "no execution records after rejection");
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// GET /agents — list response must carry the persisted agent status
// Regression: handleListAgents previously omitted `status`, forcing CLI to
// collapse disabled→paused and dashboard to render an empty badge.
// ---------------------------------------------------------------------------

function findAgent(list: any[], id: string) {
  return list.find((a) => a.id === id);
}

test("LIST: active agent includes status 'active'", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-active", "owner-a", "active"));
  try {
    const res = await get(baseUrl, "/agents");
    assert.equal(res.status, 200);
    const a = findAgent(res.body.agents, "agent-active");
    assert.ok(a, "agent-active present in list");
    assert.equal(a.status, "active");
    assert.equal(a.active, true);
  } finally {
    await close();
  }
});

test("LIST: paused agent includes status 'paused'", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-paused", "owner-a", "paused"));
  try {
    const res = await get(baseUrl, "/agents");
    const a = findAgent(res.body.agents, "agent-paused");
    assert.ok(a, "agent-paused present in list");
    assert.equal(a.status, "paused");
    // status (not the active boolean) is what distinguishes paused/disabled.
    assert.equal(a.active, false);
  } finally {
    await close();
  }
});

test("LIST: disabled agent includes status 'disabled' (distinct from paused)", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-disabled", "owner-a", "disabled"));
  try {
    const res = await get(baseUrl, "/agents");
    const a = findAgent(res.body.agents, "agent-disabled");
    assert.ok(a, "agent-disabled present in list");
    assert.equal(a.status, "disabled");
    assert.equal(a.active, false);
    // The exact bug: disabled must not be reported as paused.
    assert.notEqual(a.status, "paused");
  } finally {
    await close();
  }
});

test("LIST: all three statuses coexist and are distinguishable", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-active", "owner-a", "active"));
  registerAgent(makeAgent("agent-paused", "owner-a", "paused"));
  registerAgent(makeAgent("agent-disabled", "owner-a", "disabled"));
  try {
    const res = await get(baseUrl, "/agents");
    const byId = Object.fromEntries(
      res.body.agents.map((a: any) => [a.id, a.status])
    );
    assert.equal(byId["agent-active"], "active");
    assert.equal(byId["agent-paused"], "paused");
    assert.equal(byId["agent-disabled"], "disabled");
  } finally {
    await close();
  }
});

test("LIST: live status change via PATCH is reflected in list", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a", "active"));
  try {
    let res = await get(baseUrl, "/agents");
    assert.equal(findAgent(res.body.agents, "agent-a").status, "active");

    await patch(baseUrl, "/agents/agent-a/status", { status: "disabled" });

    res = await get(baseUrl, "/agents");
    assert.equal(findAgent(res.body.agents, "agent-a").status, "disabled");
  } finally {
    await close();
  }
});

test("LIST: owner isolation unchanged — cross-owner agent absent, no status leak", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-mine", "owner-a", "active"));
  registerAgent(makeAgent("agent-theirs", "owner-b", "paused"));
  try {
    const res = await get(baseUrl, "/agents");
    const ids = res.body.agents.map((a: any) => a.id);
    assert.ok(ids.includes("agent-mine"), "own agent present");
    assert.ok(!ids.includes("agent-theirs"), "cross-owner agent must not appear");
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// PATCH /agents/:id — general metadata update
// ---------------------------------------------------------------------------

test("PATCH /agents/:id — owner can update displayName, description, capabilities", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));
  try {
    const res = await patch(baseUrl, "/agents/agent-a", {
      displayName: "Renamed Agent",
      description: "updated description",
      capabilities: ["payment", "transfer"],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.displayName, "Renamed Agent");
    assert.equal(res.body.description, "updated description");
    assert.deepEqual(res.body.capabilities, ["payment", "transfer"]);

    const check = await get(baseUrl, "/agents/agent-a");
    assert.equal(check.status, 200);
    assert.equal(check.body.displayName, "Renamed Agent");
    assert.equal(check.body.description, "updated description");
    assert.deepEqual(check.body.capabilities, ["payment", "transfer"]);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id — partial update leaves other fields untouched", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));
  try {
    const res = await patch(baseUrl, "/agents/agent-a", { description: "only desc" });
    assert.equal(res.status, 200);
    assert.equal(res.body.description, "only desc");
    assert.equal(res.body.displayName, "Agent agent-a");
    assert.deepEqual(res.body.capabilities, ["payment"]);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id — over-length displayName returns 400", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));
  try {
    const res = await patch(baseUrl, "/agents/agent-a", {
      displayName: "x".repeat(101),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id — empty displayName returns 400", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));
  try {
    const res = await patch(baseUrl, "/agents/agent-a", { displayName: "" });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id — over-length description returns 400", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));
  try {
    const res = await patch(baseUrl, "/agents/agent-a", {
      description: "x".repeat(1001),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id — over-length capabilities array returns 400", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));
  try {
    const res = await patch(baseUrl, "/agents/agent-a", {
      capabilities: Array.from({ length: 33 }, (_, i) => `cap${i}`),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id — over-length capability string returns 400", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));
  try {
    const res = await patch(baseUrl, "/agents/agent-a", {
      capabilities: ["x".repeat(33)],
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id — non-string capability item returns 400", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));
  try {
    const res = await patch(baseUrl, "/agents/agent-a", {
      capabilities: [123 as unknown as string],
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id — status field is rejected on this route", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));
  try {
    const res = await patch(baseUrl, "/agents/agent-a", { status: "paused" });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id — non-owner patch returns 404", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-b", "owner-b"));
  try {
    const res = await patch(baseUrl, "/agents/agent-b", {
      displayName: "Hijacked",
    });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id — nonexistent agent returns 404", async () => {
  const { baseUrl, close } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  try {
    const res = await patch(baseUrl, "/agents/does-not-exist", {
      displayName: "Ghost",
    });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("PATCH /agents/:id — unknown fields are ignored", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));
  try {
    const res = await patch(baseUrl, "/agents/agent-a", {
      displayName: "Kept",
      unknownField: "ignored",
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.displayName, "Kept");
    assert.equal(res.body.unknownField, undefined);
  } finally {
    await close();
  }
});
