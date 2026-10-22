import { createServer } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { log, generateRequestId, runRequestIdContext } from "./logging.js";
import type {
  AgentIntent,
  AuthorizationStatus,
  PolicyDecision,
  SimulationResult,
} from "@4evergent/shared";
import { API_ERRORS, type ApiErrorCode } from "./error-codes.js";
import { IntentValidator } from "@4evergent/agent-core";
import { PolicyEngine, DEFAULT_RULES, validatePolicyRules, normalizePolicyRules } from "@4evergent/policy";
import { StellarAdapter } from "@4evergent/agent-core";
import { TransactionPipeline } from "@4evergent/stellar";
import type { Signer } from "@4evergent/stellar";
import { AgentScheduler } from "./scheduler.js";
import { ScheduleExecutionService } from "./schedule-execution.js";
import { ExecutionQueue } from "./execution-queue.js";
import { ExecutionRecoveryService } from "./execution-recovery.js";
import { TransactionStatusReconciler } from "@4evergent/stellar";
import { AccountSequenceCoordinator } from "./account-sequence-coordinator.js";
import type { ExecutionRecord, ExecutionStatus } from "@4evergent/database";
import type { ScheduleExecutionResult } from "./schedule-execution.js";
import {
  InMemoryActivityStore,
  InMemoryApprovalStore,
  InMemoryScheduleStore,
  InMemoryExecutionStore,
  InMemoryAgentStore,
  InMemoryPolicyConfigStore,
  SQLiteActivityStore,
  SQLiteApprovalStore,
  SQLiteScheduleStore,
  SQLiteExecutionStore,
  SQLiteAgentStore,
  MAX_LIMIT,
  SQLitePolicyConfigStore,
  assertNoSecrets,
  validateApprovalTransition,
  ResourceAuthorizationService,
  type AuthorizationContext,
  type ActivityStore,
  type ApprovalStore,
  type ScheduleStore,
  type ExecutionStore,
  type AgentStore,
  type ApprovalStatus,
  type ActivityRecord,
  type PolicyConfigStore,
  createActivity,
  isOffsetAtCeiling,
} from "@4evergent/database";
import type { PolicyRules, Agent, RequestContext, AuthorizationService, AuthProvider, AuthenticatedPrincipal } from "@4evergent/shared";
import { createAuthModule, type PrincipalResolution } from "./auth.js";
import { sweepRetainedData } from "./data-retention.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

interface IntentResponse {
  activityId: string;
  agentId: string;
  status: string;
  policyDecision: PolicyDecision;
  authorizationStatus: AuthorizationStatus;
  simulationResult: SimulationResult | null;
  txHash: string | null;
  error: string | null;
  approvalId?: string;
}

interface ApprovalResponse {
  approvalId: string;
  activityId: string;
  agentId: string;
  status: ApprovalStatus;
  message: string;
}

const agents = new Map<string, Agent>();

export function clearAgents() {
  agents.clear();
}

const APPROVAL_STATUSES = [
  "pending_approval",
  "approved",
  "rejected",
  "expired",
  "executing",
  "submitted",
  "confirmed",
  "failed",
] as const satisfies readonly ApprovalStatus[];

function parseStatusFilter<T extends string>(
  raw: string | null,
  valid: readonly T[]
): { ok: true; status?: T } | { ok: false; error: string } {
  if (raw === null) return { ok: true };
  if ((valid as readonly string[]).includes(raw)) {
    return { ok: true, status: raw as T };
  }
  return {
    ok: false,
    error: `invalid status '${raw}'; valid values: ${valid.join(", ")}`,
  };
}

export interface ServerOptions {
  port: number;
  horizonUrl: string;
  signer: Signer;
  policyRules?: Partial<PolicyRules>;
  activityStore?: ActivityStore;
  approvalStore?: ApprovalStore;
  scheduleStore?: ScheduleStore;
  dbPath?: string;
  deferExecution?: boolean;
  authProvider?: AuthProvider;
  /** Origin allowed for credentialed CORS (the browser app origin). */
  corsOrigin?: string;
  authorizationService?: AuthorizationService;
  /** Enable the background scheduler to execute due schedules. */
  scheduler?: {
    enabled?: boolean;
    intervalMs?: number;
    maxLatenessMs?: number;
    /** Inject a custom scheduler (e.g. for testing). */
    instance?: AgentScheduler;
  };
  /** Execution store — defaults to SQLite if dbPath provided, else in-memory. */
  executionStore?: ExecutionStore;
  /** Agent store — defaults to SQLite if dbPath provided, else in-memory. */
  agentStore?: AgentStore;
  /** Policy configuration store — defaults to SQLite if dbPath provided, else in-memory. */
  policyConfigStore?: import("@4evergent/database").PolicyConfigStore;
  /** Enable the persistent execution queue (opt-in). */
  executionQueue?: {
    enabled?: boolean;
    intervalMs?: number;
    concurrency?: number;
    instance?: ExecutionQueue;
  };
  /** User authentication module (sessions: email / Google / Stellar wallet). */
  authModule?: ReturnType<typeof createAuthModule>;
  /** Periodic cleanup of expired browser sessions and old daily-spending reservations. */
  retention?: {
    enabled?: boolean;
    intervalMs?: number;
    authSessionDays?: number;
    dailySpendingDays?: number;
  };
  /** Enable on-chain transaction status reconciliation (opt-in). */
  reconciliation?: {
    enabled?: boolean;
    intervalMs?: number;
    instance?: import("@4evergent/stellar").TransactionStatusReconciler;
  };
}

export async function createApiServer(options: ServerOptions) {
  const store: ActivityStore =
    options.activityStore ??
    (options.dbPath ? new SQLiteActivityStore(options.dbPath) : new InMemoryActivityStore());
  const approvals: ApprovalStore =
    options.approvalStore ??
    (options.dbPath ? new SQLiteApprovalStore(options.dbPath) : new InMemoryApprovalStore());
  const schedules: ScheduleStore =
    options.scheduleStore ??
    (options.dbPath ? new SQLiteScheduleStore(options.dbPath) : new InMemoryScheduleStore());
  const agentStore: AgentStore =
    options.agentStore ??
    (options.dbPath ? new SQLiteAgentStore(options.dbPath) : new InMemoryAgentStore());

  // Phase 28A: Policy configuration store (agent-scoped)
  const policyConfigStore: PolicyConfigStore =
    options.policyConfigStore ??
    (options.dbPath ? new SQLitePolicyConfigStore(options.dbPath) : new InMemoryPolicyConfigStore());

  const defaultAuthzCtx: AuthorizationContext = {
    activityStore: store,
    approvalStore: approvals,
    scheduleStore: schedules,
    agents: agents as Map<string, { id: string; ownerId: string }>,
  };
  const authorizationService: AuthorizationService =
    options.authorizationService ?? new ResourceAuthorizationService(defaultAuthzCtx);

  // Phase 28K-1: Authentication Boundary
  // USER AUTH (session cookie) is resolved by the authModule when provided;
  // the bearer AuthProvider remains the machine/API-key fallback.
  const authProvider = options.authProvider;
  const authModule = options.authModule ?? null;
  const als = new AsyncLocalStorage<RequestContext>();

  async function authenticateRequest(req: any, method: string): Promise<PrincipalResolution> {
    if (authModule) {
      return authModule.authenticate(req, method);
    }
    if (!authProvider) return { principal: null, via: null, csrfFail: false };
    const principal = await authProvider.authenticate({
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    return { principal, via: principal ? "fallback" : null, csrfFail: false };
  }

  function principalToContext(principal: AuthenticatedPrincipal | null): RequestContext {
    if (principal) {
      return { principal, ownerId: principal.ownerId };
    }
    return { principal: null, ownerId: null };
  }

  // Phase 28K-2: No Proxy. All handlers receive ctx explicitly.
  // Any remaining `ctx` usage will fail loudly in development.
  void als;

  // Phase 28A: Create policy resolver that loads agent-specific rules
  // Falls back to DEFAULT_RULES if no custom policy exists for the agent
  const getRules = async (agentId: string): Promise<PolicyRules> => {
    const custom = await policyConfigStore.get(agentId);
    // If agent has persisted policy, use it (highest precedence).
    // Otherwise, deep-merge startup options.policyRules over DEFAULT_RULES
    // so nested fields (maxTxAmount, dailySpendingLimit, txTypeRestrictions)
    // are properly combined rather than overwritten.
    return custom ?? normalizePolicyRules(options.policyRules ?? {});
  };

  const pipeline = new TransactionPipeline({
    horizonUrl: options.horizonUrl,
    networkPassphrase: TESTNET_PASSPHRASE,
    signer: options.signer,
    activityStore: store,
    approvalStore: approvals,
    policyRules: options.policyRules,
    policyResolver: getRules,
  });

  // Phase 28J: PolicyEngine in API uses the SAME resolver
  const policy = new PolicyEngine(options.policyRules, store as any, getRules);
  const adapter = new StellarAdapter(options.horizonUrl);

  // Phase 28I: Agent existence check with persistent fallback.
  // Mirrors ResourceAuthorizationService.resolveAgent so handlers can find
  // agents that survive a server restart (present in agentStore but not in
  // the session-scoped in-memory `agents` Map).
  async function agentExists(agentId: string): Promise<boolean> {
    if (agents.has(agentId)) return true;
    const dbAgent = await agentStore.get(agentId);
    if (dbAgent) {
      agents.set(agentId, dbAgent);
      return true;
    }
    return false;
  }

  // --- Account sequence coordinator (Phase 25) ---
  // Serializes sequence-sensitive execution for the SAME Stellar source account.
  // Different accounts remain concurrent.
  const sequenceCoordinator = new AccountSequenceCoordinator();

  // --- Execution queue setup ---
  const executionStore: ExecutionStore =
    options.executionStore ??
    (options.dbPath ? new SQLiteExecutionStore(options.dbPath) : new InMemoryExecutionStore());

  // --- Execution recovery setup ---
  const recoveryService = new ExecutionRecoveryService(executionStore);
  let executionQueue: ExecutionQueue | null = null;
  let reconciler: import("@4evergent/stellar").TransactionStatusReconciler | null = null;

  // Run crash recovery BEFORE starting the queue worker.
  if (options.executionQueue?.enabled) {
    try {
      const recoveryResult = await recoveryService.recover();
      if (recoveryResult.found > 0) {
        console.log(
          `[execution-recovery] recovered ${recoveryResult.recovered}/${recoveryResult.found} stuck executions`
        );
      }
    } catch (err) {
      console.error("[execution-recovery] recovery failed:", err);
    }
  }

  // --- Transaction status reconciliation setup ---
  if (options.reconciliation?.enabled) {
    const statusProvider: import("@4evergent/stellar").TransactionStatusProvider = {
      getStatus: (txHash: string) => adapter.getTransactionStatus(txHash),
    };
    reconciler =
      options.reconciliation.instance ??
      new TransactionStatusReconciler(executionStore, statusProvider, {
        intervalMs: options.reconciliation.intervalMs,
      });
    reconciler.start();
    console.log("[reconciler] started, interval:", options.reconciliation.intervalMs ?? 30_000, "ms");
  }

  if (options.executionQueue?.enabled) {
    const getSourceAccount = async () => {
      const account = await adapter.getAccount(options.signer.getAccountId());
      return {
        accountId: () => account.address,
        sequenceNumber: () => account.sequence,
        incrementSequenceNumber: () => {},
      };
    };

    const pipelineExecutor = async (
      record: ExecutionRecord,
      context?: import("./execution-queue.js").ExecutionContext
    ) => {
      // Phase 25: Wrap sequence-sensitive execution in account-scoped lock.
      //
      // WHY: Two concurrent executions using the SAME Stellar source account
      // could read the same Horizon sequence and build transactions with the
      // same sequence number. One would fail at Horizon with "unexpected
      // sequence". The lock serializes the critical section (read sequence →
      // build → simulate → sign → submit) per Stellar account.
      //
      // The coordination key is the signer's Stellar public key (G...), which
      // is stable per server instance. All executions through this API server
      // share the same signer → same Stellar account → serialized. Different
      // server instances (different signers) are not affected.
      //
      // getSourceAccount() is called INSIDE the lock to prevent the race where
      // two executions read the same sequence before either acquires the lock.
      const accountId = options.signer.getAccountId();
      return sequenceCoordinator.runExclusive(accountId, async () => {
        if (context?.signal?.aborted) {
          const err = new Error("Execution was cancelled");
          err.name = "AbortError";
          throw err;
        }
        try {
          const sourceAccount = await getSourceAccount();
          if (context?.signal?.aborted) {
            const err = new Error("Execution was cancelled");
            err.name = "AbortError";
            throw err;
          }
          const outcome = await pipeline.execute({
            intent: record.intent,
            sourceAccount,
            activityId: record.activityId ?? undefined,
            signal: context?.signal,
            onBeforeSubmit: () => {
              context?.onBeforeSubmit?.();
            },
          });
          const txHash = (outcome as { txHash?: string }).txHash;
          if (txHash) {
            context?.onSubmitted?.(txHash);
          }
          return {
            record,
            success: outcome.status === "submitted",
            status: outcome.status,
            error: outcome.message,
            errorClass: outcome.status === "rejected" ? "permanent" as const : "transient" as const,
            txHash,
            submittedHash: txHash ?? null,
            activityId: (outcome as { activityId?: string }).activityId ?? record.activityId ?? undefined,
          };
        } catch (err: unknown) {
          if (context?.signal?.aborted) {
            if (record.activityId && options.activityStore) {
              try {
                await options.activityStore.update(record.activityId, {
                  status: "failed",
                  error: "cancelled by user",
                  updatedAt: new Date().toISOString(),
                });
              } catch {
                // ActivityStore update failure is non-critical
              }
            }
            throw err;
          }
          // Pipeline failed before persisting activity (e.g., source account load failure).
          // Update the pre-created ActivityRecord to reflect the failure so the
          // activity record is not left in "pending" indefinitely.
          if (record.activityId && options.activityStore) {
            try {
              await options.activityStore.update(record.activityId, {
                status: "failed",
                error: err instanceof Error ? err.message : String(err),
                updatedAt: new Date().toISOString(),
              });
            } catch {
              // ActivityStore update failure is non-critical — execution record still tracks the error.
            }
          }
          return {
            record,
            success: false,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            errorClass: "transient" as const,
            activityId: record.activityId ?? undefined,
          };
        }
      });
    };

    const preCheck = async (txHash: string) => {
      const status = await adapter.getTransactionStatus(txHash);
      if (status === "confirmed" || status === "failed") return "found" as const;
      if (status === "not_found") return "not_found" as const;
      return "network_error" as const;
    };

    executionQueue =
      options.executionQueue.instance ??
      new ExecutionQueue(executionStore, pipelineExecutor, getSourceAccount, {
        intervalMs: options.executionQueue.intervalMs,
        concurrency: options.executionQueue.concurrency,
        preCheck,
      });

    executionQueue.start();
    console.log("[execution-queue] started, interval:", options.executionQueue.intervalMs ?? 10_000, "ms");
  }

  // --- Scheduler setup ---
  // The scheduler executes due schedules via the SAME pipeline as manual intents.
  // It is opt-in: only starts if options.scheduler.enabled is true.
  let scheduler: AgentScheduler | null = null;
  if (options.scheduler?.enabled) {
    const scheduleExecution = new ScheduleExecutionService({
      activityStore: store,
      approvalStore: approvals,
      getSourceAccount: async () => {
        const account = await adapter.getAccount(options.signer.getAccountId());
        return {
          accountId: () => account.address,
          sequenceNumber: () => account.sequence,
          incrementSequenceNumber: () => {},
        };
      },
      pipelineExecutor: (input) => pipeline.execute(input) as any,
    });

    const agentStatusStore = {
      get: async (id: string) => {
        // Fast path: in-memory map (covers agents registered this session).
        const agent = agents.get(id);
        if (agent) return { id: agent.id, status: agent.status, ownerId: agent.ownerId };
        // Fallback: persistent store (covers agents surviving a restart).
        // Mirrors ResourceAuthorizationService.resolveAgent logic so the
        // scheduler and authorization layer agree on agent status.
        if (agentStore) {
          const dbAgent = await agentStore.get(id);
          if (dbAgent) return { id: dbAgent.id, status: dbAgent.status, ownerId: dbAgent.ownerId };
        }
        return null;
      },
    };

    scheduler =
      options.scheduler.instance ??
      new AgentScheduler(
        schedules,
        agentStatusStore,
        async (schedule) => {
          // If execution queue is enabled, enqueue; otherwise fall back to
          // direct ScheduleExecutionService invocation.
          if (executionQueue) {
            const now = new Date().toISOString();
            // Pre-create ActivityRecord for audit trail; the pipeline will
            // update this record (not create a duplicate) when activityId is passed.
            const activityId = crypto.randomUUID();
            if (store) {
              const activityRecord = createActivity(
                schedule.agentId,
                schedule.ownerId,
                schedule.intent,
                { result: "allow", reason: "schedule enqueued", rule: "scheduler", intent: schedule.intent }
              );
              activityRecord.id = activityId;
              activityRecord.status = "pending";
              activityRecord.authorizationStatus = "not_required";
              await store.record(activityRecord);
            }
            const executionRecord: ExecutionRecord = {
              id: crypto.randomUUID(),
              ownerId: schedule.ownerId,
              agentId: schedule.agentId,
              approvalId: null,
              activityId: activityId,
              intent: schedule.intent,
              status: "queued",
              policyDecision: null,
              simulationResult: null,
              txHash: null,
              submittedHash: null,
              error: null,
              attempt: 0,
              nextRetryAt: null,
              startedAt: null,
              completedAt: null,
              errorClass: null,
              createdAt: now,
              updatedAt: now,
            };
            void executionQueue.enqueue(executionRecord);
            return {
              status: "submitted",
              message: "schedule enqueued for execution",
              policyDecision: {
                result: "allow",
                reason: "schedule enqueued",
                rule: "scheduler",
                intent: schedule.intent,
              },
              simulationResult: null,
              txHash: null as unknown as string,
              activityId: undefined,
              approvalId: undefined,
            } as ScheduleExecutionResult;
          }
          return scheduleExecution.executeSchedule(schedule);
        },
        { intervalMs: options.scheduler.intervalMs, maxLatenessMs: options.scheduler.maxLatenessMs }
      );

    scheduler.start();
    console.log("[scheduler] started, interval:", options.scheduler.intervalMs ?? 60_000, "ms");
  }

  let retentionTimer: ReturnType<typeof setInterval> | null = null;
  let retentionRunning = false;
  if (options.retention?.enabled !== false) {
    const intervalMs = Number.isFinite(options.retention?.intervalMs) && options.retention!.intervalMs! > 0
      ? options.retention!.intervalMs!
      : 24 * 60 * 60_000;
    const sessionDays = Number.isFinite(options.retention?.authSessionDays) && options.retention!.authSessionDays! >= 0
      ? options.retention!.authSessionDays!
      : 30;
    const spendingDays = Number.isFinite(options.retention?.dailySpendingDays) && options.retention!.dailySpendingDays! >= 0
      ? options.retention!.dailySpendingDays!
      : 90;
    const sweepRetention = async () => {
      if (retentionRunning) return;
      retentionRunning = true;
      try {
        const result = await sweepRetainedData({
          store,
          authModule,
          now: Date.now(),
          authSessionDays: sessionDays,
          dailySpendingDays: spendingDays,
          batchSize: 500,
        });
        console.log(`[retention] sweep complete: auth_sessions=${result.authSessionsRemoved}, daily_spending=${result.dailySpendingRemoved}`);
      } catch (err) {
        console.error("[retention] sweep failed:", err);
      } finally {
        retentionRunning = false;
      }
    };
    void sweepRetention();
    retentionTimer = setInterval(() => { void sweepRetention(); }, intervalMs);
    retentionTimer.unref?.();
  }

  // CORS configuration — configurable via CORS_ORIGIN environment variable.
  // Supports multiple origins: CORS_ORIGIN=https://app.example.com,https://preview.vercel.app
  const corsOrigins: string[] = (() => {
    const raw = process.env.CORS_ORIGIN ?? options.corsOrigin;
    if (!raw) return [];
    return raw.split(',').map((o: string) => o.trim()).filter(Boolean);
  })();

  function getCorsOrigin(req: any): string | null {
    if (corsOrigins.length === 0) return null;
    const origin = req.headers?.origin;
    if (!origin || typeof origin !== 'string') return null;
    if (corsOrigins.includes(origin)) return origin;
    return null;
  }

  const server = createServer(async (req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // Phase 28L: Request logging with correlation IDs.
    // Assigned before any handler runs so every response — including
    // OPTIONS preflights and 401/404 errors — carries X-Request-Id.
    const suppliedId = req.headers["x-request-id"];
    const requestId = generateRequestId(
      Array.isArray(suppliedId) ? suppliedId[0] : suppliedId,
    );
    res.setHeader("X-Request-Id", requestId);

    const requestStart = Date.now();
    let ownerId: string | null = null;
    let logged = false;

    const originalEnd = res.end.bind(res);
    res.end = function (...args: any[]) {
      if (!logged) {
        logged = true;
        const durationMs = Date.now() - requestStart;
        const status = res.statusCode || 0;
        log(status >= 500 ? "error" : "info", "request completed", {
          method,
          path: new URL(url, "http://localhost").pathname,
          status,
          durationMs,
          requestId,
          ownerId,
        });
      }
      return originalEnd(...args);
    };

    // Handle CORS preflight (OPTIONS) — does NOT bypass authentication for
    // actual API requests. Preflight is unauthenticated but returns no data.
    if (method === "OPTIONS") {
      const origin = getCorsOrigin(req);
      if (origin) {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Requested-With",
          "Access-Control-Allow-Credentials": "true",
          "Vary": "Origin",
        });
      } else {
        res.writeHead(204);
      }
      res.end();
      return;
    }

    // Phase 28W: CORS — echo allowed origin on actual responses.
    // Intercepts writeHead so CORS headers are added without modifying every handler.
    const corsOrigin = getCorsOrigin(req);
    if (corsOrigin) {
      const originalWriteHead = res.writeHead.bind(res);
      res.writeHead = function(status: number, headers?: any) {
        if (typeof status === 'object') {
          headers = status;
          status = 200;
        }
        const merged = { ...(headers ?? {}), 'Access-Control-Allow-Origin': corsOrigin, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' };
        return originalWriteHead(status, merged);
      };
    }

    // Phase 28U: USER AUTH routes (/auth/*) — handled before the auth gate.
    // These are the login/session endpoints (register, login, challenge,
    // verify, google start/callback, logout, me, config).
    if (authModule) {
      const handled = await authModule.handleRoutes(req, res, url, method);
      if (handled) return;
    }

    // Phase 28K-1: Authenticate and create request-scoped context
    const resolution = await authenticateRequest(req, method);
    const requestScopedCtx = principalToContext(resolution.principal);
    ownerId = requestScopedCtx.ownerId;

    return runRequestIdContext(requestId, () => {
    return als.run(requestScopedCtx, () => {
      // Health check is public
      if (method === "GET" && url === "/health") {
        return json(res, { status: "ok", signerAccountId: options.signer.getAccountId() });
      }

      // CSRF guard: a valid session principal that failed the custom-header
      // check must not be able to mutate state. Checked BEFORE the generic
      // 401 gate so forged (cross-site) writes surface as 403, while an
      // unauthenticated request still gets 401.
      if (resolution.csrfFail) {
        return apiError(res, "CSRF_FAILED");
      }

      // Protected endpoints require authentication
      if (!requestScopedCtx.ownerId) {
        return apiError(res, "UNAUTHORIZED");
      }

      if (method === "POST" && url === "/agents") {
      return handleCreateAgent(requestScopedCtx, req, res);
    }
    if (method === "POST" && /^\/agents\/[^/]+\/intents$/.test(url)) {
      return handleIntent(requestScopedCtx, req, res);
    }
    if (method === "POST" && /^\/approvals\/[^/]+\/(approve|reject)$/.test(url)) {
      const isApprove = url.endsWith("/approve");
      return isApprove ? handleApprove(requestScopedCtx, req, res) : handleReject(requestScopedCtx, req, res);
    }
    if (method === "GET" && url === "/health") {
      return json(res, { status: "ok", signerAccountId: options.signer.getAccountId() });
    }
    if (method === "GET" && /^\/agents\/[^/]+\/policy$/.test(url)) {
      return handleGetPolicy(requestScopedCtx, req, res);
    }
    if (method === "PUT" && /^\/agents\/[^/]+\/policy$/.test(url)) {
      return handlePutPolicy(requestScopedCtx, req, res);
    }

    if (method === "GET" && /^\/agents(\?.*)?$/.test(url)) {
      return handleListAgents(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+$/.test(url)) {
      return handleGetAgent(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/activity(\?.*)?$/.test(url)) {
      return handleAgentActivity(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/activity\/[^/]+$/.test(url)) {
      return handleActivityDetail(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/approvals(\?.*)?$/.test(url)) {
      return handleAgentApprovals(requestScopedCtx, req, res);
    }
    if (method === "PATCH" && /^\/agents\/[^/]+\/status$/.test(url)) {
      return handleUpdateAgentStatus(requestScopedCtx, req, res);
    }
    if (method === "PATCH" && /^\/agents\/[^/]+$/.test(url)) {
      return handleUpdateAgent(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/schedules(\?.*)?$/.test(url)) {
      return handleListSchedules(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/schedules\/[^/]+$/.test(url)) {
      return handleGetSchedule(requestScopedCtx, req, res);
    }
    if (method === "POST" && /^\/agents\/[^/]+\/schedules$/.test(url)) {
      return handleCreateSchedule(requestScopedCtx, req, res);
    }
    if (method === "PATCH" && /^\/agents\/[^/]+\/schedules\/[^/]+$/.test(url)) {
      return handleUpdateSchedule(requestScopedCtx, req, res);
    }
    if (method === "DELETE" && /^\/agents\/[^/]+\/schedules\/[^/]+$/.test(url)) {
      return handleDeleteSchedule(requestScopedCtx, req, res);
    }
    if (method === "POST" && /^\/agents\/[^/]+\/schedules\/[^/]+\/(pause|resume|disable)$/.test(url)) {
      return handleScheduleAction(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/activity(\?.*)?$/.test(url)) {
      return handleListActivity(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/approvals\/[^/]+$/.test(url)) {
      return handleGetApproval(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/approvals(\?.*)?$/.test(url)) {
      return handleListApprovals(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/executions(\?.*)?$/.test(url)) {
      return handleAgentExecutions(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/spending(\?.*)?$/.test(url)) {
      return handleGetAgentSpending(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/executions(\?.*)?$/.test(url)) {
      return handleListExecutions(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/executions\/[^/]+$/.test(url)) {
      return handleExecutionDetail(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/agent-queue(\?.*)?$/.test(url)) {
      return handleQueueStatus(requestScopedCtx, req, res);
    }
    if (method === "GET" && /^\/overview\/attention$/.test(url)) {
      return handleGetOverviewAttention(requestScopedCtx, req, res);
    }
    if (method === "POST" && /^\/executions\/[^/]+\/retry$/.test(url)) {
      return handleRetryExecution(requestScopedCtx, req, res);
    }
    if (method === "POST" && /^\/executions\/[^/]+\/cancel$/.test(url)) {
      return handleCancelExecution(requestScopedCtx, req, res);
    }
    apiError(res, "NOT_FOUND");
    }); // End als.run
    }); // End runRequestIdContext
  });

  async function handleListAgents(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const capability = urlObj.searchParams.get("capability");
    const hasLimit = urlObj.searchParams.has("limit");
    const rawLimit = urlObj.searchParams.get("limit");

    let limit: number | undefined;
    if (hasLimit) {
      // Empty string, non-numeric, or fractional values are rejected.
      if (rawLimit === null || rawLimit.trim() === "") {
        return apiError(res, "VALIDATION_ERROR", { message: "limit must be a valid integer" });
      }
      const parsed = Number(rawLimit);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        return apiError(res, "VALIDATION_ERROR", { message: "limit must be a valid integer" });
      }
      limit = Math.max(1, Math.min(MAX_LIMIT, parsed));
    }

    const all = capability !== null
      ? await agentStore.listByCapability(ctx.ownerId!, capability, limit)
      : await agentStore.listByOwner(ctx.ownerId!, limit);

    const agentList = all.map((a) => ({
      id: a.id,
      displayName: a.displayName,
      description: a.description,
      ownerId: a.ownerId,
      stellarAddress: a.stellarAddress,
      capabilities: a.capabilities,
      status: a.status,
      active: a.active,
      createdAt: a.createdAt,
    }));
    return json(res, { agents: agentList });
  }

  async function handleCreateAgent(ctx: RequestContext, req: any, res: any) {
    let body: unknown;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return apiError(res, "INVALID_JSON");
    }

    const b = body as Record<string, unknown>;
    const displayName = b.displayName;
    if (typeof displayName !== "string" || displayName.trim().length === 0) {
      return apiError(res, "VALIDATION_ERROR", { message: "displayName is required" });
    }
    if (displayName.trim().length > 100) {
      return apiError(res, "VALIDATION_ERROR", { message: "displayName must be 100 characters or fewer" });
    }

    let description = "";
    if (b.description !== undefined) {
      if (typeof b.description !== "string") {
        return apiError(res, "VALIDATION_ERROR", { message: "description must be a string" });
      }
      if (b.description.length > 500) {
        return apiError(res, "VALIDATION_ERROR", { message: "description must be 500 characters or fewer" });
      }
      description = b.description;
    }

    let capabilities: string[] = [];
    if (b.capabilities !== undefined) {
      if (!Array.isArray(b.capabilities) || !b.capabilities.every((c) => typeof c === "string")) {
        return apiError(res, "VALIDATION_ERROR", { message: "capabilities must be an array of strings" });
      }
      if (b.capabilities.length > 32) {
        return apiError(res, "VALIDATION_ERROR", { message: "capabilities must be 32 entries or fewer" });
      }
      const trimmedCaps: string[] = [];
      const seen = new Set<string>();
      for (const cap of b.capabilities) {
        const trimmed = cap.trim();
        if (trimmed.length === 0) {
          return apiError(res, "VALIDATION_ERROR", { message: "capability entries cannot be empty" });
        }
        if (trimmed.length > 32) {
          return apiError(res, "VALIDATION_ERROR", { message: "capability entries must be 32 characters or fewer" });
        }
        if (seen.has(trimmed)) {
          return apiError(res, "VALIDATION_ERROR", { message: "capabilities must not contain duplicate entries" });
        }
        seen.add(trimmed);
        trimmedCaps.push(trimmed);
      }
      capabilities = trimmedCaps;
    }

    let stellarAddress = "";
    if (b.stellarAddress !== undefined) {
      if (typeof b.stellarAddress !== "string") {
        return apiError(res, "VALIDATION_ERROR", { message: "stellarAddress must be a string" });
      }
      stellarAddress = b.stellarAddress;
    }

    const agent = await agentStore.create({
      displayName: displayName.trim(),
      description,
      capabilities,
      ownerId: ctx.ownerId!,
      stellarAddress,
    });

    // Backward compatibility: keep in-memory map in sync
    agents.set(agent.id, agent);

    return json(res, { agent }, 201);
  }

  async function handleAgentActivity(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/activity$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");
    const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(urlObj.searchParams.get("offset") ?? 0) || 0);
    const all = await store.listByAgent(agentId, limit + 1, offset);
    const activity = all.slice(0, limit);
    const hasMore = all.length > limit && !isOffsetAtCeiling(offset);
    return json(res, { agentId, activity, hasMore });
  }

  async function handleListApprovals(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const statusFilter = parseStatusFilter(urlObj.searchParams.get("status"), APPROVAL_STATUSES);
    if (!statusFilter.ok) return apiError(res, "VALIDATION_ERROR", { message: statusFilter.error });
    const limit = Math.max(1, Math.min(200, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(urlObj.searchParams.get("offset") ?? 0) || 0);
    const rows = await approvals.listByOwner(ctx.ownerId!, limit, offset, statusFilter.status);
    const total = await approvals.countByOwner(ctx.ownerId!, statusFilter.status);
    // `truncated`: more matching rows exist beyond this page.
    // `hasMore`: the client can actually fetch them (offset ceiling ends pagination).
    const truncated = offset + rows.length < total;
    const hasMore = truncated && !isOffsetAtCeiling(offset);
    return json(res, { approvals: rows, hasMore, truncated, total });
  }

  async function handleGetApproval(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/approvals\/([^/]+)$/);
    const approvalId = match?.[1];
    if (!approvalId) return apiError(res, "INVALID_PATH_PARAM");
    const canAccess = await authorizationService.canAccessApproval(ctx, approvalId);
    if (!canAccess) return apiError(res, "APPROVAL_NOT_FOUND");
    const approval = await approvals.get(approvalId);
    if (!approval) return apiError(res, "APPROVAL_NOT_FOUND");
    return json(res, { approval });
  }


  async function handleGetPolicy(ctx: RequestContext, req: any, res: any) {
    const agentId = extractAgentIdFromPolicyUrl(req.url);
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");

    if (!(await agentExists(agentId))) return apiError(res, "AGENT_NOT_FOUND");
    const canAccess = await authorizationService.canAccessAgent(ctx, agentId);
    if (!canAccess) return apiError(res, "AGENT_NOT_FOUND");

    const metadata = await policyConfigStore.getWithMetadata(agentId);
    if (metadata) {
      return json(res, {
        agentId,
        policy: metadata.rules,
        version: metadata.version,
        updatedAt: metadata.updatedAt,
      });
    }
    // No custom policy — return DEFAULT_RULES with version indicator
    return json(res, { agentId, policy: DEFAULT_RULES, version: 0, updatedAt: null });
  }

  async function handlePutPolicy(ctx: RequestContext, req: any, res: any) {
    const agentId = extractAgentIdFromPolicyUrl(req.url);
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");

    if (!(await agentExists(agentId))) return apiError(res, "AGENT_NOT_FOUND");
    const canAccess = await authorizationService.canAccessAgent(ctx, agentId);
    if (!canAccess) return apiError(res, "AGENT_NOT_FOUND");

    let body: unknown;
    try {
      const text = await readBody(req);
      body = JSON.parse(text);
    } catch {
      return apiError(res, "INVALID_JSON");
    }

    if (typeof body !== "object" || body === null) {
      return apiError(res, "VALIDATION_ERROR", { message: "policy must be an object" });
    }

    const validation = validatePolicyRules(body);
    if (!validation.valid) {
      return apiError(res, "VALIDATION_ERROR", { message: "invalid policy", details: validation.errors });
    }

    const normalized = normalizePolicyRules(body as Partial<PolicyRules>);
    const result = await policyConfigStore.upsert(agentId, ctx.ownerId!, normalized);
    return json(res, { agentId, policy: result.rules, version: result.version });
  }

  function extractAgentIdFromPolicyUrl(url: string): string | null {
    const match = url.match(/^\/agents\/([^/]+)\/policy$/);
    return match?.[1] ?? null;
  }


  async function handleGetAgent(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");
    const agent = await agentStore.getForOwner(agentId, ctx.ownerId!);
    if (!agent) return apiError(res, "AGENT_NOT_FOUND");
    return json(res, {
      id: agent.id,
      displayName: agent.displayName,
      description: agent.description,
      ownerId: agent.ownerId,
      stellarAddress: agent.stellarAddress,
      capabilities: agent.capabilities,
      status: agent.status,
      active: agent.active,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    });
  }

  async function handleGetAgentSpending(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/spending$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");
    const rules = await getRules(agentId);
    const spending: Record<string, { used: number; limit: string; remaining: number }> = {};
    for (const asset of Object.keys(rules.dailySpendingLimit)) {
      const limitStr = rules.dailySpendingLimit[asset] ?? "0";
      const limitNum = parseFloat(limitStr);
      if (isNaN(limitNum)) continue;
      const used = (await store.getDailySpending(agentId, asset)) ?? 0;
      spending[asset] = {
        used,
        limit: limitStr,
        remaining: Math.max(limitNum - used, 0),
      };
    }
    return json(res, { agentId, spending });
  }

  async function handleActivityDetail(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/activity\/([^/]+)$/);
    const agentId = match?.[1];
    const activityId = match?.[2];
    if (!agentId || !activityId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");
    const activity = await store.getForOwner(activityId, ctx.ownerId!);
    if (!activity) return apiError(res, "ACTIVITY_NOT_FOUND");
    return json(res, { activity });
  }

  async function handleAgentApprovals(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/approvals$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");
    const statusFilter = parseStatusFilter(urlObj.searchParams.get("status"), APPROVAL_STATUSES);
    if (!statusFilter.ok) return apiError(res, "VALIDATION_ERROR", { message: statusFilter.error });
    const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(urlObj.searchParams.get("offset") ?? 0) || 0);
    const rows =
      statusFilter.status === undefined
        ? await approvals.listByAgent(agentId, limit + 1, offset)
        : await approvals.listByStatus(agentId, statusFilter.status, limit + 1, offset);
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit && !isOffsetAtCeiling(offset);
    return json(res, { agentId, approvals: page, hasMore });
  }

  async function handleUpdateAgentStatus(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/status$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const canChange = await authorizationService.canChangeAgentStatus(ctx, agentId);
    if (!canChange) return apiError(res, "AGENT_NOT_FOUND");
    let body: unknown;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return apiError(res, "INVALID_JSON");
    }
    const status = (body as any)?.status;
    if (!["active", "paused", "disabled"].includes(status)) {
      return apiError(res, "VALIDATION_ERROR", { message: "invalid status" });
    }
    const agent = await agentStore.update(agentId, { status: status as any });
    if (!agent) return apiError(res, "AGENT_NOT_FOUND");
    return json(res, { id: agent.id, status: agent.status });
  }

  async function handleUpdateAgent(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");

    let body: unknown;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return apiError(res, "INVALID_JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return apiError(res, "VALIDATION_ERROR", { message: "body must be an object" });
    }
    const b = body as Record<string, unknown>;

    if (b.status !== undefined) {
      return apiError(res, "VALIDATION_ERROR", { message: "status cannot be updated here; use PATCH /agents/:id/status" });
    }
    if (b.stellarAddress !== undefined) {
      return apiError(res, "VALIDATION_ERROR", { message: "stellarAddress is immutable" });
    }

    const patch: Partial<Agent> = {};

    if (b.displayName !== undefined) {
      if (typeof b.displayName !== "string" || b.displayName.trim().length === 0) {
        return apiError(res, "VALIDATION_ERROR", { message: "displayName must be a non-empty string" });
      }
      if (b.displayName.trim().length > 100) {
        return apiError(res, "VALIDATION_ERROR", { message: "displayName must be 100 characters or fewer" });
      }
      patch.displayName = b.displayName.trim();
    }

    if (b.description !== undefined) {
      if (typeof b.description !== "string") {
        return apiError(res, "VALIDATION_ERROR", { message: "description must be a string" });
      }
      if (b.description.length > 500) {
        return apiError(res, "VALIDATION_ERROR", { message: "description must be 500 characters or fewer" });
      }
      patch.description = b.description;
    }

    if (b.capabilities !== undefined) {
      if (!Array.isArray(b.capabilities) || !b.capabilities.every((c) => typeof c === "string")) {
        return apiError(res, "VALIDATION_ERROR", { message: "capabilities must be an array of strings" });
      }
      if (b.capabilities.length > 32) {
        return apiError(res, "VALIDATION_ERROR", { message: "capabilities must be 32 entries or fewer" });
      }
      const trimmedCaps: string[] = [];
      const seen = new Set<string>();
      for (const cap of b.capabilities) {
        const trimmed = cap.trim();
        if (trimmed.length === 0) {
          return apiError(res, "VALIDATION_ERROR", { message: "capability entries cannot be empty" });
        }
        if (trimmed.length > 32) {
          return apiError(res, "VALIDATION_ERROR", { message: "capability entries must be 32 characters or fewer" });
        }
        if (seen.has(trimmed)) {
          return apiError(res, "VALIDATION_ERROR", { message: "capabilities must not contain duplicate entries" });
        }
        seen.add(trimmed);
        trimmedCaps.push(trimmed);
      }
      patch.capabilities = trimmedCaps;
    }

    const agent = await agentStore.update(agentId, patch);
    if (!agent) return apiError(res, "AGENT_NOT_FOUND");
    agents.set(agent.id, agent);
    return json(res, {
      id: agent.id,
      displayName: agent.displayName,
      description: agent.description,
      ownerId: agent.ownerId,
      stellarAddress: agent.stellarAddress,
      capabilities: agent.capabilities,
      status: agent.status,
      active: agent.active,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    });
  }

  async function handleListSchedules(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");
    const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(urlObj.searchParams.get("offset") ?? 0) || 0);
    const all = await schedules.listByAgent(agentId, limit + 1, offset);
    const page = all.slice(0, limit);
    const hasMore = all.length > limit && !isOffsetAtCeiling(offset);
    return json(res, { agentId, schedules: page, hasMore });
  }

  async function handleGetSchedule(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules\/([^/]+)$/);
    const agentId = match?.[1];
    const scheduleId = match?.[2];
    if (!agentId || !scheduleId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");
    const schedule = await schedules.get(scheduleId);
    if (!schedule || schedule.ownerId !== ctx.ownerId!) {
      return apiError(res, "SCHEDULE_NOT_FOUND");
    }
    return json(res, { schedule });
  }

  async function handleCreateSchedule(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const canCreate = await authorizationService.canCreateSchedule(ctx, agentId);
    if (!canCreate) return apiError(res, "AGENT_NOT_FOUND");

    let body: unknown;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return apiError(res, "INVALID_JSON");
    }

    const intent = (body as any)?.intent;
    const scheduleExpression = (body as any)?.scheduleExpression;
    const timezone = (body as any)?.timezone ?? "UTC";

    const { validateScheduleExpression, validateScheduleIntent } = await import("@4evergent/database");

    const intentValidation = validateScheduleIntent(intent);
    if (!intentValidation.valid) {
      return apiError(res, "VALIDATION_ERROR", { message: intentValidation.error });
    }

    const exprValidation = validateScheduleExpression(scheduleExpression, timezone);
    if (!exprValidation.valid) {
      return apiError(res, "VALIDATION_ERROR", { message: exprValidation.error });
    }

    const now = new Date().toISOString();
    const schedule = await schedules.create({
      id: crypto.randomUUID(),
      agentId,
      ownerId: ctx.ownerId!,
      status: "active",
      intent,
      scheduleExpression,
      timezone,
      nextRunAt: exprValidation.nextRunAt ?? now,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    });

    return json(res, { schedule }, 201);
  }

  async function handleUpdateSchedule(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules\/([^/]+)$/);
    const agentId = match?.[1];
    const scheduleId = match?.[2];
    if (!agentId || !scheduleId) return apiError(res, "INVALID_PATH_PARAM");
    const canUpdate = await authorizationService.canUpdateSchedule(ctx, scheduleId);
    if (!canUpdate) return apiError(res, "AGENT_NOT_FOUND");

    let body: unknown;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return apiError(res, "INVALID_JSON");
    }

    const schedule = await schedules.get(scheduleId);
    if (!schedule) return apiError(res, "SCHEDULE_NOT_FOUND");

    const patch: any = {};
    if ((body as any)?.scheduleExpression !== undefined) {
      const { validateScheduleExpression } = await import("@4evergent/database");
      const result = validateScheduleExpression((body as any)?.scheduleExpression, schedule.timezone);
      if (!result.valid) return apiError(res, "VALIDATION_ERROR", { message: result.error });
      patch.scheduleExpression = (body as any).scheduleExpression;
      patch.nextRunAt = result.nextRunAt ?? schedule.nextRunAt;
    }

    const updated = await schedules.update(scheduleId, patch);
    return json(res, { schedule: updated });
  }

  async function handleDeleteSchedule(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules\/([^/]+)$/);
    const agentId = match?.[1];
    const scheduleId = match?.[2];
    if (!agentId || !scheduleId) return apiError(res, "INVALID_PATH_PARAM");
    const canDelete = await authorizationService.canDeleteSchedule(ctx, scheduleId);
    if (!canDelete) return apiError(res, "AGENT_NOT_FOUND");
    const deleted = await schedules.delete(scheduleId);
    if (!deleted) return apiError(res, "SCHEDULE_NOT_FOUND");
    return json(res, { deleted: true });
  }

  async function handleScheduleAction(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules\/([^/]+)\/(pause|resume|disable)$/);
    const agentId = match?.[1];
    const scheduleId = match?.[2];
    const action = match?.[3] as "pause" | "resume" | "disable";
    if (!agentId || !scheduleId || !action) return apiError(res, "INVALID_PATH_PARAM");

    let allowed: boolean;
    if (action === "pause") {
      allowed = await authorizationService.canPauseSchedule(ctx, scheduleId);
    } else if (action === "resume") {
      allowed = await authorizationService.canResumeSchedule(ctx, scheduleId);
    } else {
      allowed = await authorizationService.canDisableSchedule(ctx, scheduleId);
    }
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");

    const schedule = await schedules.get(scheduleId);
    if (!schedule) return apiError(res, "SCHEDULE_NOT_FOUND");

    if (!SCHEDULE_TRANSITIONS[schedule.status]?.includes(action)) {
      return apiError(res, "SCHEDULE_INVALID_TRANSITION", { message: `cannot ${action} schedule in status '${schedule.status}'` });
    }

    const status = action === "pause" ? "paused" : action === "resume" ? "active" : "disabled";
    const updated = await schedules.update(scheduleId, { status });
    return json(res, { schedule: updated });
  }

  async function handleAgentExecutions(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/executions$/);
    const agentId = match?.[1];
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");
    const allowed = await authorizationService.canAccessAgent(ctx, agentId);
    if (!allowed) return apiError(res, "AGENT_NOT_FOUND");
    const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(urlObj.searchParams.get("offset") ?? 0) || 0);
    const all = await executionStore.listByAgent(agentId, limit + 1, offset);
    const executions = all.slice(0, limit);
    const hasMore = all.length > limit && !isOffsetAtCeiling(offset);
    return json(res, { agentId, executions, hasMore });
  }

  async function handleExecutionDetail(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/executions\/([^/]+)$/);
    const executionId = match?.[1];
    if (!executionId) return apiError(res, "INVALID_PATH_PARAM");
    const execution = await executionStore.getForOwner(executionId, ctx.ownerId!);
    if (!execution) return apiError(res, "EXECUTION_NOT_FOUND");
    return json(res, { execution });
  }

  async function handleQueueStatus(ctx: RequestContext, _req: any, res: any) {
    if (!executionQueue) {
      return apiError(res, "EXECUTION_QUEUE_DISABLED");
    }
    const execCounts = await executionStore.countByOwner(ctx.ownerId!);
    const byStatus: Record<string, number> = {};
    for (const [status, count] of Object.entries(execCounts)) {
      if (count > 0) byStatus[status] = count;
    }
    return json(res, {
      running: executionQueue.isRunning(),
      byStatus,
    });
  }


  async function handleGetOverviewAttention(ctx: RequestContext, _req: any, res: any) {
    const ownerId = ctx.ownerId!;
    const pendingApprovals = await approvals.countByOwner(ownerId, "pending_approval");
    const execCounts: Record<ExecutionStatus, number> =
      await executionStore.countByOwner(ownerId);
    return json(res, {
      pendingApprovals,
      failedExecutions: execCounts.failed ?? 0,
      deadLetterExecutions: execCounts.dead_letter ?? 0,
      retryingExecutions: execCounts.queued ?? 0,
      stuckExecutions: execCounts.executing ?? 0,
    });
  }

  // ===== Global owner-scoped listing endpoints (N+1 elimination) =====
  // These exist so Web/CLI consumers can fetch all of an owner's executions
  // or activity in ONE request instead of N+1 per-agent requests. Owner
  // isolation is enforced by the store's listByOwner(ctx.ownerId, limit).

  async function handleListExecutions(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(urlObj.searchParams.get("offset") ?? 0) || 0);
    const all = await executionStore.listByOwner(ctx.ownerId!, limit + 1, offset);
    const executions = all.slice(0, limit);
    const hasMore = all.length > limit && !isOffsetAtCeiling(offset);
    return json(res, { executions, hasMore });
  }

  async function handleListActivity(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(urlObj.searchParams.get("offset") ?? 0) || 0);
    const all = await store.listByOwner(ctx.ownerId!, limit + 1, offset);
    const activity = all.slice(0, limit);
    const hasMore = all.length > limit && !isOffsetAtCeiling(offset);
    return json(res, { activity, hasMore });
  }

  async function handleRetryExecution(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/executions\/([^/]+)\/retry$/);
    const executionId = match?.[1];
    if (!executionId) return apiError(res, "INVALID_PATH_PARAM");

    if (!executionQueue) {
      return apiError(res, "EXECUTION_QUEUE_DISABLED");
    }

    const execution = await executionStore.getForOwner(executionId, ctx.ownerId!);
    if (!execution) return apiError(res, "EXECUTION_NOT_FOUND");

    if (execution.status !== "failed" && execution.status !== "dead_letter") {
      return apiError(res, "INVALID_EXECUTION_STATE", { message: `cannot retry execution in status '${execution.status}'` });
    }

    const maxRetries = executionQueue["retryPolicy"]?.maxRetries ?? 3;
    if (execution.attempt >= maxRetries) {
      return apiError(res, "MAX_RETRIES_REACHED", { message: `max retry attempts (${maxRetries}) reached` });
    }

    const result = await executionQueue.retry(executionId, maxRetries);
    if (result.status === "not_found") return apiError(res, "EXECUTION_NOT_FOUND");
    if (result.status === "invalid_state") return apiError(res, "INVALID_EXECUTION_STATE", { message: `cannot retry execution in status '${execution.status}'` });
    if (result.status === "max_retries_reached") return apiError(res, "MAX_RETRIES_REACHED", { message: `max retry attempts (${maxRetries}) reached` });
    if (result.status === "conflict") return apiError(res, "EXECUTION_CONFLICT");

    return json(res, { execution: result.execution, message: "execution queued for retry" });
  }

  async function handleCancelExecution(ctx: RequestContext, req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/executions\/([^/]+)\/cancel$/);
    const executionId = match?.[1];
    if (!executionId) return apiError(res, "INVALID_PATH_PARAM");

    if (!executionQueue) {
      return apiError(res, "EXECUTION_QUEUE_DISABLED");
    }

    const execution = await executionStore.getForOwner(executionId, ctx.ownerId!);
    if (!execution) return apiError(res, "EXECUTION_NOT_FOUND");

    if (execution.status !== "queued" && execution.status !== "executing") {
      return apiError(res, "INVALID_EXECUTION_STATE", { message: `cannot cancel execution in status '${execution.status}'` });
    }

    const result = await executionQueue.cancel(executionId);
    if (result.status === "not_found") return apiError(res, "EXECUTION_NOT_FOUND");
    if (result.status === "invalid_state") {
      const current = await executionStore.get(executionId);
      const currentStatus = current?.status ?? execution.status;
      let msg: string;
      if (currentStatus !== "executing") {
        msg = `cannot cancel execution in status '${currentStatus}'`;
      } else if (result.reason === "not_in_flight") {
        msg = "cannot cancel execution: execution is not actively running on this worker";
      } else {
        msg = "cannot cancel execution: pipeline has already begun submitting transaction";
      }
      return apiError(res, "INVALID_EXECUTION_STATE", { message: msg });
    }
    if (result.status === "conflict") return apiError(res, "EXECUTION_CONFLICT");

    return json(res, { execution: result.execution, message: "execution cancelled" });
  }

  async function handleIntent(ctx: RequestContext, req: any, res: any) {
    const agentId = extractAgentId(req.url);
    if (!agentId) return apiError(res, "INVALID_PATH_PARAM");

    let body: unknown;
    try {
      const text = await readBody(req);
      body = JSON.parse(text);
    } catch {
      return apiError(res, "INVALID_JSON");
    }

    if (isRawTransaction(body)) {
      return apiError(res, "RAW_TRANSACTION_REJECTED");
    }

    let intent: AgentIntent;
    try {
      intent = parseIntent(body);
    } catch (e) {
      return apiError(res, "VALIDATION_ERROR", { message: (e as Error).message });
    }

    const validation = IntentValidator.validate(intent);
    if (!validation.valid) {
      return apiError(res, "VALIDATION_ERROR", { message: `Intent validation failed: ${validation.error}` });
    }

    if (!(await agentExists(agentId))) return apiError(res, "AGENT_NOT_FOUND");
    const canSubmit = await authorizationService.canSubmitIntent(ctx, agentId);
    if (!canSubmit) return apiError(res, "AGENT_NOT_FOUND");

    // Agent status admission boundary: only ACTIVE agents accept NEW intents.
    // Reads the CURRENT status from the persistent agent store so a paused or
    // disabled agent is rejected before policy evaluation, activity records,
    // or execution-queue entries are created. In-flight executions are not
    // affected — this gate only applies at intent submission time.
    const agent = await agentStore.get(agentId);
    if (!agent) return apiError(res, "AGENT_NOT_FOUND");
    if (agent.status !== "active") {
      return apiError(res, "AGENT_NOT_ACTIVE", { message: `agent is ${agent.status}; new intents are rejected` });
    }

    // Idempotency key from header (scoped to owner+agent)
    const idempotencyKey = extractHeader(req, "Idempotency-Key");
    if (idempotencyKey) {
      // Enforce bounded key length to prevent abuse
      if (idempotencyKey.length > 256) {
        return apiError(res, "IDEMPOTENCY_KEY_INVALID");
      }
      const existing = await store.getByIdempotencyKey(ctx.ownerId!, agentId, idempotencyKey);
      if (existing) {
        // Same key + different intent → conflict
        const existingIntentJson = JSON.stringify(existing.intent);
        const newIntentJson = JSON.stringify(intent);
        if (existingIntentJson !== newIntentJson) {
          return apiError(res, "IDEMPOTENCY_CONFLICT");
        }
        // Duplicate request → return existing activity (idempotent success)
        return json(res, toIntentResponse(existing), 200);
      }
    }

    const decision = await policy.evaluate(intent, agentId);

    if (decision.result === "deny") {
      const outcome = await pipeline.execute({ intent, sourceAccount: { agentId, ownerId: ctx.ownerId } as any, idempotencyKey });
      const denied = outcome.activityId ? await store.get(outcome.activityId) : null;
      return json(res, toIntentResponse(denied!), 403);
    }

    if (decision.result === "requires_approval") {
      const outcome = await pipeline.execute({ intent, sourceAccount: { agentId, ownerId: ctx.ownerId } as any, idempotencyKey });
      if (outcome.status === "requires_approval" && outcome.activityId) {
        const pending = await store.get(outcome.activityId);
        assertNoSecrets(pending!);
        return json(res, { ...toIntentResponse(pending!), approvalId: outcome.approvalId }, 202);
      }
      const pending = await store.get(outcome.activityId ?? "");
      return json(res, toIntentResponse(pending!), 202);
    }

    // ALLOW → full execution path
    // Phase 26A: Sequence coordinator MUST wrap the entire sequence-sensitive
    // execution including getSourceAccount(). The coordinator key is the
    // Stellar public key (options.signer.getAccountId()).
    //
    // WHY: Without this, two concurrent ALLOW intents for the same Stellar
    // account could read the same Horizon sequence and build transactions with
    // the same sequence number. One would fail at Horizon.
    //
    // getSourceAccount() is called INSIDE the lock to prevent the race where
    // both executions read the sequence before either acquires the lock.
    const accountId = options.signer.getAccountId();
    const outcome = await sequenceCoordinator.runExclusive(accountId, async () => {
      let sourceAccount: any;
      try {
        const account = await adapter.getAccount(options.signer.getAccountId());
        sourceAccount = {
          accountId: () => account.address,
          sequenceNumber: () => account.sequence,
          incrementSequenceNumber: () => {},
          agentId,
          ownerId: ctx.ownerId!,
        };
      } catch (e) {
        throw new Error(`Unable to load source account: ${(e as Error).message}`);
      }

      return pipeline.execute({ intent, sourceAccount, idempotencyKey });
    }).catch((e: any) => {
      return { status: "failed", message: e?.message ?? "Unknown error" } as any;
    });

    // Handle the failure case from getSourceAccount() inside the lock
    if (outcome.status === "failed") {
      const failed = makeActivity(intent, agentId, ctx.ownerId!, decision, "failed", null, outcome.message ?? "Unknown error");
      failed.idempotencyKey = idempotencyKey;
      await store.record(failed);
      return json(res, toIntentResponse(failed), 502);
    }

    if (outcome.status === "submitted") {
      if (outcome.activityId) {
        const submitted = await store.get(outcome.activityId);
        if (submitted) {
          assertNoSecrets(submitted);
          return json(res, toIntentResponse(submitted), 200);
        }
      }
      // Fallback: pipeline returned submitted but no activity id (store-less mode)
      return json(res, {
        activityId: "",
        agentId,
        status: "submitted",
        policyDecision: decision,
        authorizationStatus: "approved",
        simulationResult: outcome.simulationResult,
        txHash: outcome.txHash,
        error: null,
      }, 200);
    }

    if (outcome.status === "simulation_failed") {
      const failed = outcome.activityId ? await store.get(outcome.activityId) : null;
      return json(res, toIntentResponse(failed!), 422);
    }

    const rejected = outcome.activityId ? await store.get(outcome.activityId) : null;
    return json(res, toIntentResponse(rejected!), 403);
  }

  async function handleApprove(ctx: RequestContext, req: any, res: any) {
    const approvalId = extractApprovalId(req.url);
    if (!approvalId) return apiError(res, "INVALID_PATH_PARAM");

    let body: unknown = {};
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return apiError(res, "INVALID_JSON");
    }

    if (isRawTransaction(body)) {
      return approvalError(res, "RAW_TRANSACTION_REJECTED", { approvalId, activityId: "", status: "rejected", message: "raw XDR and transaction blobs are not accepted at the approve endpoint" });
    }

    // Phase 28K-2: Actor from authenticated principal subject
    const approver = ctx.principal?.subject ?? ctx.ownerId!;

    const approval = await approvals.get(approvalId);
    if (!approval) {
      return approvalError(res, "APPROVAL_NOT_FOUND", { approvalId, activityId: "", status: "rejected", message: "approval not found" });
    }

    const canApprove = await authorizationService.canApprove(ctx, approvalId);
    if (!canApprove) return approvalError(res, "APPROVAL_NOT_FOUND", { approvalId, activityId: "", status: "rejected", message: "approval not found" });

    const transitionError = validateApprovalTransition(approval.status, "approved");
    if (transitionError) {
      return approvalError(res, "APPROVAL_INVALID_STATE", { approvalId, activityId: approval.activityId, status: approval.status, message: `cannot approve: ${transitionError}` });
    }

    if (approval.expiresAt && new Date(approval.expiresAt) < new Date()) {
      await approvals.update(approvalId, { status: "expired", expiredAt: new Date().toISOString() });
      return approvalError(res, "APPROVAL_EXPIRED", { approvalId, activityId: approval.activityId, status: "expired", message: "approval expired" });
    }

    await approvals.update(approvalId, { status: "approved", approvedAt: new Date().toISOString(), approver: approver ?? null });

    // Enqueue for execution via the persistent execution queue.
    // If the queue is not enabled, fall back to setImmediate (Phase 8 behavior).
    if (options.deferExecution) {
      // execution deferred intentionally — no action taken here
    } else if (executionQueue) {
      const now = new Date().toISOString();
      const executionRecord: ExecutionRecord = {
        id: crypto.randomUUID(),
        ownerId: approval.ownerId,
        agentId: approval.agentId,
        approvalId,
        activityId: approval.activityId,
        intent: approval.intent,
        status: "queued",
        policyDecision: approval.policyDecision,
        simulationResult: null,
        txHash: null,
        submittedHash: null,
        error: null,
        attempt: 0,
        nextRetryAt: null,
        startedAt: null,
        completedAt: null,
        errorClass: null,
        createdAt: now,
        updatedAt: now,
      };
      void executionQueue.enqueue(executionRecord);
    } else {
      // Fallback: Phase 8 fire-and-forget behavior
      // Phase 26A: Must also use sequence coordinator
      const accountId = options.signer.getAccountId();
      setImmediate(() => {
        sequenceCoordinator.runExclusive(accountId, async () => {
          return pipeline.executeApproved(approvalId, approver);
        }).catch(() => {});
      });
    }

    return json(res, toApprovalResponse(approvalId, approval.activityId, "approved", "approval accepted; transaction queued for execution"), 200);

  }

  async function handleReject(ctx: RequestContext, req: any, res: any) {
    const approvalId = extractApprovalId(req.url);
    if (!approvalId) return apiError(res, "INVALID_PATH_PARAM");

    let body: unknown = {};
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return apiError(res, "INVALID_JSON");
    }

    if (isRawTransaction(body)) {
      return approvalError(res, "RAW_TRANSACTION_REJECTED", { approvalId, activityId: "", status: "rejected", message: "raw XDR and transaction blobs are not accepted at the reject endpoint" });
    }

    const approval = await approvals.get(approvalId);
    if (!approval) {
      return approvalError(res, "APPROVAL_NOT_FOUND", { approvalId, activityId: "", status: "rejected", message: "approval not found" });
    }

    const canReject = await authorizationService.canReject(ctx, approvalId);
    if (!canReject) return approvalError(res, "APPROVAL_NOT_FOUND", { approvalId, activityId: "", status: "rejected", message: "approval not found" });

    const transitionError = validateApprovalTransition(approval.status, "rejected");
    if (transitionError) {
      return approvalError(res, "APPROVAL_INVALID_STATE", { approvalId, activityId: approval.activityId, status: approval.status, message: `cannot reject: ${transitionError}` });
    }

    await approvals.update(approvalId, { status: "rejected", rejectedAt: new Date().toISOString() });
    await store.update(approval.activityId, { status: "rejected", authorizationStatus: "denied_by_policy", error: "approval rejected by human" });

    return json(res, toApprovalResponse(approvalId, approval.activityId, "rejected", "approval rejected"), 200);
  }

  function toIntentResponse(rec: ActivityRecord): IntentResponse {
    return {
      activityId: rec.id,
      agentId: rec.agentId,
      status: rec.status,
      policyDecision: rec.policyDecision,
      authorizationStatus: rec.authorizationStatus ?? "not_required",
      simulationResult: rec.simulationResult,
      txHash: rec.txHash,
      error: rec.error,
    };
  }

  // Approve/reject errors keep the ApprovalResponse fields (including `message`)
  // and add the structured `code` and `error` so every error carries a code.
  function approvalError(res: any, code: ApiErrorCode, r: { approvalId: string; activityId: string; status: ApprovalStatus; message: string }) {
    const def = API_ERRORS[code];
    return json(res, { code, error: r.message, ...toApprovalResponse(r.approvalId, r.activityId, r.status, r.message) }, def.status);
  }

  function toApprovalResponse(approvalId: string, activityId: string, status: ApprovalStatus, message: string): ApprovalResponse {
    return { approvalId, activityId, agentId: "", status, message };
  }

  return {
    server,
    // Bind host is configurable so the server can be hosted behind a container
    // or reverse proxy. Defaults to loopback: local development and the test
    // suite stay reachable only from this machine unless a caller explicitly
    // opts into a wider bind. See apps/api/src/server.ts — production startup
    // fails closed when HOST is non-loopback and API_KEYS is unset.
    listen: (port: number, host: string = "127.0.0.1") =>
      new Promise<void>((resolve) => server.listen(port, host, resolve)),
    close: () => new Promise<void>((resolve) => {
      if (scheduler) {
        scheduler.stop();
        console.log("[scheduler] stopped");
      }
      if (executionQueue) {
        executionQueue.stop();
        console.log("[execution-queue] stopped");
      }
      if (reconciler) {
        reconciler.stop();
        console.log("[reconciler] stopped");
      }
      if (retentionTimer) {
        clearInterval(retentionTimer);
        retentionTimer = null;
      }
      // Abort lingering keep-alive connections so the server actually shuts
      // down (Node's http close() waits for active sockets otherwise).
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
    registerAgent: (agent: Agent) => {
      agents.set(agent.id, agent);
      void agentStore.create({
        id: agent.id,
        displayName: agent.displayName,
        description: agent.description,
        capabilities: agent.capabilities,
        ownerId: agent.ownerId,
        stellarAddress: agent.stellarAddress,
        status: agent.status,
      }).catch(() => {});
    },
    store,
    approvals,
    executionStore,
    agentStore,
    scheduler,
    executionQueue,
    recoveryService,
  };
}

function makeActivity(
  intent: AgentIntent,
  agentId: string,
  ownerId: string,
  policyDecision: PolicyDecision,
  status: string,
  authorizationStatus: string | null,
  error: string | null
): ActivityRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId,
    ownerId,
    intent,
    policyDecision,
    authorizationStatus: authorizationStatus as any,
    simulationResult: null,
    txHash: null,
    status: status as any,
    error,
    createdAt: now,
    updatedAt: now,
  };
}

function apiError(res: any, code: ApiErrorCode, opts: { message?: string; details?: unknown } = {}) {
  const def = API_ERRORS[code];
  const body: Record<string, unknown> = { code, error: opts.message ?? def.message };
  if (opts.details !== undefined) body.details = opts.details;
  return json(res, body, def.status);
}

/**
 * Legal schedule actions per current status. No-ops (pause when paused,
 * resume when active, disable when disabled) are rejected so callers get a
 * signal that nothing changed. `disabled` stays reversible via resume,
 * matching the dashboard's Resume button for disabled schedules.
 */
const SCHEDULE_TRANSITIONS: Record<string, ReadonlyArray<"pause" | "resume" | "disable">> = {
  active: ["pause", "disable"],
  paused: ["resume", "disable"],
  disabled: ["resume"],
};

function json(res: any, body: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function extractHeader(req: any, name: string): string | null {
  const raw = req.headers?.[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] || null;
  if (typeof raw === "string") return raw;
  return null;
}

function extractAgentId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/^\/agents\/([^/]+)\/intents$/);
  return match?.[1] ?? null;
}

function extractApprovalId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/^\/approvals\/([^/]+)\/(approve|reject)$/);
  return match?.[1] ?? null;
}

function isRawTransaction(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.xdr === "string" ||
    typeof b.envelope === "string" ||
    typeof b.transaction === "string" ||
    Array.isArray(b.operations) ||
    typeof b.tx_blob === "string"
  );
}

function parseIntent(body: unknown): AgentIntent {
  if (typeof body !== "object" || body === null) throw new Error("intent must be an object");
  const b = body as Record<string, unknown>;
  if (typeof b.type !== "string") throw new Error("intent.type is required");
  switch (b.type) {
    case "payment": {
      if (typeof b.asset !== "string") throw new Error("payment.asset is required");
      if (typeof b.destination !== "string") throw new Error("payment.destination is required");
      if (typeof b.amount !== "string") throw new Error("payment.amount is required as string");
      if (typeof b.reason !== "string") throw new Error("payment.reason is required");
      let validatedDetails: { code: string; issuer: string | null } | undefined;
      const assetDetails = (b.assetDetails as { code?: unknown; issuer?: unknown } | undefined);
      if (assetDetails !== undefined) {
        if (typeof assetDetails.code !== "string" || assetDetails.code.length < 1 || assetDetails.code.length > 12) {
          throw new Error("payment.assetDetails.code must be a Stellar asset code (1-12 characters)");
        }
        if (assetDetails.code === "XLM") {
          if (assetDetails.issuer != null && assetDetails.issuer !== "") {
            throw new Error("payment.assetDetails.issuer must be null for XLM");
          }
          validatedDetails = { code: "XLM", issuer: null };
        } else {
          if (typeof assetDetails.issuer !== "string" || !assetDetails.issuer.startsWith("G") || assetDetails.issuer.length !== 56) {
            throw new Error("payment.assetDetails.issuer must be a valid Stellar address (G...)");
          }
          validatedDetails = { code: assetDetails.code, issuer: assetDetails.issuer };
        }
      }
      return {
        type: "payment",
        asset: b.asset,
        assetDetails: validatedDetails,
        destination: b.destination,
        amount: b.amount,
        reason: b.reason,
        memo: typeof b.memo === "string" ? b.memo : undefined,
      };
    }
    case "trustline": {
      if (typeof b.assetCode !== "string" || b.assetCode.length < 1 || b.assetCode.length > 12) {
        throw new Error("trustline.assetCode must be a Stellar asset code (1-12 characters)");
      }
      if (b.assetCode === "XLM") throw new Error("XLM cannot be used as a trustline asset");
      if (typeof b.issuer !== "string" || !b.issuer.startsWith("G") || b.issuer.length !== 56) {
        throw new Error("trustline.issuer must be a valid Stellar address (G...)");
      }
      if (typeof b.reason !== "string") throw new Error("trustline.reason is required");
      return {
        type: "trustline",
        assetCode: b.assetCode,
        issuer: b.issuer,
        limit: typeof b.limit === "string" && b.limit.trim().length > 0 ? b.limit : undefined,
        reason: b.reason,
      };
    }
    case "contract_call":
      throw new Error(`intent type '${b.type}' is not yet supported by the transaction pipeline`);
    case "account_settings": {
      if (typeof b.setting !== "string" || b.setting.trim().length === 0) {
        throw new Error("account_settings.setting is required");
      }
      if (typeof b.reason !== "string") throw new Error("account_settings.reason is required");
      return {
        type: "account_settings",
        setting: b.setting,
        value: b.value,
        reason: b.reason,
      };
    }
    default:
      throw new Error(`unknown intent type: ${b.type}`);
  }
}

void TESTNET_PASSPHRASE;
