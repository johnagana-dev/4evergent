# 4evergent Development Roadmap

| Phase | Goal | Status |
|-------|------|--------|
| 1 | Agent identity types, policy engine, intent validation, Stellar read adapter | Shipped |
| 2 | Full transaction pipeline (construct → simulate → authorize → sign → submit) with Signer abstraction | **Shipped** |
| 3 | Persistent SQLite stores, approval/reject HTTP endpoints, daily limit enforcement from activity state | **Shipped** |
| 4 | React web dashboard (Overview / Agents / Activity / Approvals / Submit Intent) + read-only API endpoints | **Shipped** |
| 5 | Soroban AgentRegistry contract (register/update/deactivate/query) | **Deployed on Testnet** |
| 6 | Soroban Permissions contract (delegation + revocation) | Intentionally **not** deployed (not compiled; needs its own DESIGN pass) |
| 7 | Multi-agent capability discovery & agent-to-agent economy | Future |
| 8 | Agent scheduling & automation | **Shipped** |
| 9 | Persistent execution queue with retry & dead-letter | **Shipped** |
| 10 | Execution queue crash recovery | **Shipped** |
| 11 | Agent self-serve creation & onboarding | **Shipped** |
| 12 | Stellar asset support: issued assets (`PaymentAsset`) & trustlines (`Operation.changeTrust`) | **Shipped** |
| 15 | Manual execution controls: retry and cancel actions with conditional status transitions | **Shipped** |
| 16 | On-chain status reconciliation: poll submitted executions against Horizon | **Shipped** |
| 18A | Execution queue concurrency: atomic CAS status claim (`updateIfStatus`) | **Shipped** |
| 18B | Idempotency protection: `Idempotency-Key` header & unique store reservation | **Shipped** |
| 18C | Ambiguous submission handling: pre-check before blind retry via `submittedHash` | **Shipped** |
| 19A | Documentation baseline & repository health refresh | **Shipped** |
| 21 | Testnet execution safety: network configuration validation guard & `LIVE_SUBMIT` gate | **Shipped** |
| 23 | Financial integrity: atomic daily spending limit table & numeric amount validation | **Shipped** |
| 25 | Account sequence coordinator: per-account serialized transaction signing & submission | **Shipped** |
| 26A | Sequence coordination bypass closure: wrap direct intent & fallback execution paths | **Shipped** |
| 28A | Persistent agent policy configuration: store, schema, and API resolver | **Shipped** |
| 28I | Authentication foundation: `AuthProvider`, `AuthenticatedPrincipal`, dev auth & persistent agent fallback | **Shipped** |
| 28J | Policy engine agent-scoped resolution: evaluation without reservation & rule versioning | **Shipped** |
| 28K | Request-scoped authentication: explicit request context & spoof-proof approver identity | **Shipped** |
| 28L | Request observability: request logging middleware with correlation IDs (`X-Request-Id`) | **Shipped** |
| 28T | Production authentication: `ProductionApiKeyAuthProvider` & fail-closed auth mode selection | **Shipped** |
| 28U | User authentication module: session cookies, passwords, Google OAuth, & Stellar wallet challenge | **Shipped** |
| 28W | Cross-origin resource sharing (CORS): origin validation & credentialed headers | **Shipped** |

## Phase 28 Details (Shipped)

### What was implemented

- **Auth boundary and identity foundation (Phase 28I, 28K, 28T, 28U)**:
  - `AuthProvider` abstraction and `AuthenticatedPrincipal` (`packages/shared/src/auth.ts`).
  - `DevAuthProvider` for local development/testing with fixed/configurable default owners (`packages/shared/src/dev-auth.ts`).
  - `ProductionApiKeyAuthProvider` validating bearer tokens against server-side secret API keys (`packages/shared/src/production-auth.ts`).
  - User authentication module (`apps/api/src/auth.ts`) delivering session cookies (`four_eg_session`), scrypt-hashed passwords, Google OAuth authorization-code flow, and Stellar wallet challenge/verification (SEP-53).
  - Explicit request context propagation (`apps/api/src/index.ts`, Phase 28K): all route handlers receive explicit `ctx: RequestContext`; approver identity is derived directly from the authenticated principal subject (`ctx.principal.subject`), preventing client spoofing.
  - Fail-closed auth mode decision in `apps/api/src/server.ts` (Phase 28T) refusing public execution without valid auth configuration.
- **Persistent agent-scoped policy configuration (Phase 28A, 28J)**:
  - `PolicyConfigStore` interface and `SQLitePolicyConfigStore` with `policy_configs` table (`packages/database/src/policy-config-store.ts`). Monotonically increasing policy versions.
  - Policy resolver in transaction pipeline and API server loading custom agent rules with fallback to default rules.
  - `PolicyEngine.evaluateWithoutReservation()` (`packages/policy/src/engine.ts`, Phase 28J) allowing policy checks without duplicate daily-limit reservation on execution of approved intents.
  - Validation rules (`packages/policy/src/validation.ts`) ensuring policy limits, asset restrictions, and rule schemas are well-formed.
- **Observability and cross-origin controls (Phase 28L, 28W)**:
  - Request logging middleware generating or propagating correlation IDs via `X-Request-Id` (`apps/api/src/index.ts`, Phase 28L).
  - CORS middleware supporting configurable origins, preflight `OPTIONS` handling, and allowed origins on authenticated responses (Phase 28W).

## Phase 25 & 26A Details (Shipped)

### What was implemented

- **AccountSequenceCoordinator** (`apps/api/src/account-sequence-coordinator.ts`, Phase 25):
  - In-process per-account promise chain that serializes the critical sequence-sensitive pipeline section: Horizon sequence fetch → build transaction → simulate → sign → submit.
  - Keyed by Stellar public key (`G...`); different accounts execute concurrently without blocking each other.
- **Direct & Fallback Execution Wrap** (`apps/api/src/index.ts`, Phase 26A):
  - Closes sequence-collision bypasses where direct ALLOW intents or queue-disabled approval fallbacks previously submitted outside the coordinator.
  - All Stellar transaction submission paths (direct intent execution, queued worker execution, and synchronous fallback) run inside `AccountSequenceCoordinator.runExclusive()`.
  - Sequence accounts are acquired inside the lock to ensure sequence numbers remain strictly linear.

## Phase 23 Details (Shipped)

### What was implemented

- **Atomic daily spending table** (`packages/database/src/sqlite-store.ts`):
  - Dedicated `daily_spending` table with compound primary key `(agent_id, asset, day)`.
  - Atomic reservation using single-statement conditional SQL `UPDATE ... WHERE total + amount <= limit`.
  - Eliminates read-then-write race conditions where concurrent requests could exceed configured daily limits.
- **Atomic idempotency reservation**:
  - `idx_activities_idempotency` unique index on `(owner_id, agent_id, idempotency_key)`.
  - Winning transaction inserts the row; concurrent duplicates receive constraint violation and read the winner's result.
- **Strict amount validation** (`packages/policy/src/engine.ts`):
  - Policy evaluation rejects non-numeric, zero, negative, and infinite amounts at step 0.

## Phase 21 Details (Shipped)

### What was implemented

- **Stellar network safety guard** (`packages/stellar/src/network-guard.ts`):
  - Strict validation of Horizon URL and network passphrase combinations.
  - Only Stellar Testnet is permitted for execution; Mainnet URLs and passphrases are explicitly rejected.
  - Startup checks fail-closed on unknown or mismatched network configurations.
- **Live submission gate** (`packages/stellar/src/submitter.ts`):
  - Submissions require explicit `LIVE_SUBMIT=1` environment opt-in.
  - Unset or falsy values prevent outbound transactions from reaching Horizon.
- **Secret isolation**:
  - Verified no secret keys or mnemonics appear in logs, error payloads, API responses, or SQLite records.

## Phase 18A-C Details (Shipped)

### What was implemented

- **Atomic execution claim (Phase 18A)**:
  - `updateIfStatus(queued→executing)` conditional status update in `ExecutionStore`.
  - Prevents competing queue worker instances or async tasks from claiming and running the same execution record.
- **Idempotency protection (Phase 18B)**:
  - `Idempotency-Key` / `X-Idempotency-Key` header support on `POST /agents/:id/intents`.
  - Scoped by `(owner_id, agent_id, idempotency_key)`. Replaying with the same key returns the existing outcome; mismatched intent parameters yield 409 Conflict.
- **Ambiguous submission guard (Phase 18C)**:
  - `submittedHash` computed and stored prior to Horizon submission.
  - Before retrying failed executions, `ExecutionQueue` pre-checks Horizon status. If the transaction was already accepted or network state is ambiguous, blind retry is blocked.

## Phase 12 Details (Shipped)

### What was implemented

- **Stellar Classic Issued Asset Support**:
  - `PaymentAsset` interface (`packages/shared/src/types.ts`) supporting native `XLM` and issued assets (`{ code, issuer }`).
  - `buildPayment` updated to handle non-native assets via Stellar SDK `Asset`.
  - Policy engine normalization for issued assets (`CODE:ISSUER`).
- **Trustline Operations**:
  - `TrustlineIntent` handling in transaction builder via `Operation.changeTrust`.
  - Policy evaluation and approval gating for trustline establishment (`trustline:ASSET:ISSUER`).
- **Frontend & API Integration**:
  - Intent validation and submission forms supporting asset code, issuer, and trustline limit inputs.
  - Detailed documentation in `docs/capabilities.md`.

## Phase 11 Details (Shipped)

### What was implemented

- **AgentStore** (`packages/database/src/agent-types.ts`, `agent-store.ts`): `AgentStore` interface + InMemory + SQLite via `node:sqlite`, schema version 1. Exposes `create`, `get`, `getForOwner`, `listByOwner`, `update`, `delete` with owner-scoped queries.
- **POST /agents endpoint** (`apps/api/src/index.ts`): validates `displayName` (required, ≤100 chars), `description`, `capabilities` (array of strings), `stellarAddress` (string). Binds to `requestCtx.ownerId`, persists via `AgentStore`, returns 201 with `agent` record.
- **Frontend Agents page** (`apps/web/src/pages/Agents.tsx`): empty state with "Create Agent" button, modal form with loading/validation/API error/success handling. Updated `api.ts` with `createAgent()` method. Added modal/form CSS to `styles.css`.
- **Shared types** (`packages/shared/src/types.ts`): `CreateAgentInput`, `CreateAgentRequest` matching API request shape.
- **Backward compatibility**: existing `registerAgent()` now syncs to both in-memory Map and persistent store. All test helpers using `registerAgent()` continue to work.
- **ADR-013** in `docs/architecture.md`
- 18 new tests (10 API agent-create, 8 DB agent-store)

## Phase 8 Details (Shipped)

### What was implemented

- **AgentScheduler** (`apps/api/src/scheduler.ts`): polls `ScheduleStore.listDue()` on configurable interval (default 60s), executes due schedules via typed callback, updates lastRunAt/nextRunAt, failure isolation per schedule, start/stop lifecycle
- **ScheduleExecutionService** (`apps/api/src/schedule-execution.ts`): runs a scheduled intent through the SAME `TransactionPipeline.execute()` as manual intents; rebuilds `sourceAccount` from signer via `StellarAdapter`
- **API server wiring** (`apps/api/src/index.ts`): scheduler opt-in via `options.scheduler.enabled`, integrated into server lifecycle (start/stop), typed callback returns `ScheduleExecutionResult`
- **ScheduleExecutionResult** (`apps/api/src/schedule-execution.ts`): result type merging PipelineOutcome with scheduler-specific fields
- 10 scheduler tests + 4 integration tests

## Phase 9 Details (Shipped)

### What was implemented

- **ExecutionStore** (`packages/database/src/execution-types.ts`, `execution-store.ts`): `ExecutionRecord` with full lifecycle status (`queued → executing → submitted → confirmed → failed → dead_letter`), InMemory + SQLite via `node:sqlite`, schema version 1. Exposes `listDue`, `listByOwner`, `listByAgent`, `getForOwner`,atomic `update`
- **ExecutionQueue** (`apps/api/src/execution-queue.ts`): polls due records, transitions to `executing`, invokes pipeline executor, moves to terminal state or schedules retry with backoff. Bounded concurrency, duplicate safety via status-claim guard
- **Error classification** (`packages/database/src/execution-policy.ts`): transient (network/Horizon/submission) vs permanent (policy deny, validation, auth). Bounded retry (max 3, configurable) with exponential backoff capped at maxDelayMs. Permanent failures short-circuit to dead_letter
- **API server integration** (`apps/api/src/index.ts`): approve enqueues `ExecutionRecord` (preserving `approvalId`) instead of fire-and-forget; scheduler enqueues with `activityId`; owner-scoped read endpoints `GET /agents/:id/executions`, `GET /executions/:id`, `GET /agent-queue`; `createApiServer` returns `executionStore`, `executionQueue`
- **ADR-012** in `docs/architecture.md`
- 20 new tests (enqueue+process, retry→dead_letter, transient→retry, permanent→no retry, crash recovery, duplicate safety, error classification, backoff formula, owner isolation, approval boundary, scheduler+manual regression)

## Phase 10 Details (Shipped)

### What was implemented

- **Crash recovery query** (`packages/database/src/execution-types.ts`, `execution-store.ts`): `ExecutionStore.listStuckExecuting()` returns records with `status === "executing"` ordered by `created_at ASC`; implemented in both InMemory and SQLite stores
- **ExecutionRecoveryService** (`apps/api/src/execution-recovery.ts`): startup recovery service with `recover()` method — scans stuck executions, re-fetches each for idempotency guard, transitions to `failed` with immediate `nextRetryAt`, preserves `attempt`/`errorClass`, does NOT create duplicates, does NOT execute transactions
- **Startup lifecycle** (`apps/api/src/index.ts`): `createApiServer()` is now `async`; recovery runs BEFORE queue worker starts eliminating race condition (store init → recovery scan → worker start); all test files updated to `await createApiServer()`; `recoveryService` exposed via return value
- **ADR-012** updated in `docs/architecture.md` with crash recovery details
- 10 new tests (executing→failed, retry count preserved, terminal states untouched, no duplicates, idempotent second call, queue reprocesses recovered record, owner isolation, queue disabled no worker, nextRetryAt immediately eligible, startedAt cleared)

## Phase 2 Details (Shipped)

### What was implemented

- **Signer interface** (`packages/stellar/src/signer.ts`): abstraction with `getAccountId()`, `getNetworkPassphrase()`, `sign()`. No key-exposing methods.
- **TestnetLocalSigner** (`packages/stellar/src/testnet-local-signer.ts`): testnet-only development signer. Loads from env, never exposes secrets, never committed.
- **StellarTransactionBuilder** (`packages/stellar/src/transaction-builder.ts`): constructs unsigned Stellar transactions from validated `PaymentIntent` only. Does NOT accept raw XDR or arbitrary operation arrays. MVP supports XLM payments only.
- **StellarSimulator** (`packages/stellar/src/simulator.ts`): mandatory simulation gate. Calls real Horizon API (`fetchBaseFee`, `accounts().accountId()`). No fake results. A failed simulation prevents signing.
- **StellarSubmitter** (`packages/stellar/src/submitter.ts`): submits signed transactions. Rejects unsigned transactions (no signatures).
- **TransactionPipeline** (`packages/stellar/src/pipeline.ts`): orchestrates the ordered gate chain — validate → policy → authorize → construct → simulate → sign → submit → record. The only public entry point.
- **Activity storage** (`packages/database/src/index.ts`): in-memory activity log with `assertNoSecrets()` guard. Records intent, policy decision, authorization status, simulation result, tx hash, status, timestamps.
- **API server** (`apps/api/src/index.ts`): `POST /agents/:id/intents` endpoint implementing the full pipeline. Returns 400 for malformed/raw input, 403 for policy DENY, 202 for requires_approval, 200 for submitted. `GET /health` endpoint.
- **Security tests** (15 tests): verify DENY prevents construction, failed simulation prevents signing, amount above limit never reaches signer, unauthorized asset/destination never reach signer, approval-required never reaches signer before approval, signer interface has no key-exposing methods.
- **Integration tests** (10 tests): verify API rejects raw XDR, returns 403 for denied intents, 202 for approval-required, 400 for unsupported intent types, records activity for all outcomes, never leaks secrets in responses.

### Phase 3 Details (Shipped)

### What was implemented

- **SQLite-backed persistent stores** (`packages/database/src/sqlite-store.ts`): `SQLiteActivityStore` and `SQLiteApprovalStore` backed by Node.js built-in `node:sqlite` (Node 22+; verified on Node 26.7). Schema versioned in `_meta` table (version 1); `initSchema()` is idempotent. Activity and approval records persist across process restarts (tested via reopen simulation). The unique partial index `idx_approvals_activity_one` enforces at most one `PENDING_APPROVAL` per activity id.
- **Approval HTTP endpoints** (`apps/api/src/index.ts`): `POST /approvals/:id/approve` and `POST /approvals/:id/reject` implement stateful transitions with `validateApprovalTransition()` guard. Approve marks record `approved` then fires `pipeline.executeApproved()` async via `setImmediate` (skippable via `deferExecution: true`). Reject rejects only from `pending_approval` state.
- **Daily spending limit enforcement** (`packages/policy/src/engine.ts`): `PolicyEngine.evaluate()` is now `async` and accepts an `ActivityStore`. `getDailySpent()` reads the current UTC day's `submitted` activities for the agent and deducts from the daily limit. Read-then-write; no transactional lock.
- **Pipeline integration** (`packages/stellar/src/pipeline.ts`): `TransactionPipeline` accepts optional `activityStore`/`approvalStore` in constructor. `execute()` records every outcome (denied/submitted/failed/simulation_failed). New `executeApproved(approvalId, approver)` method reconstructs the intent from the stored approval, re-runs construction+simulation+signing+submission, and updates the approval status to `submitted`/`failed`/`expired`/`executing`.
- **API server auto-selects store** (`apps/api/src/index.ts`): if `dbPath` provided → SQLite stores; else → in-memory. `assertNoSecrets()` invoked on every record returned through the API.
- **Security tests** (15 tests): all pass. Tests prove daily limit deny when cumulative exceeded, daily limit allow when under cap, executeApproved rejects nonexistent/pending/expired, double-approval is blocked, raw XDR injection is rejected at approve/reject endpoints.
- **API approval integration tests** (10 tests): all pass. Approve/reject lifecycle, 404 for unknown approval, 409 for double-approve and approve-then-reject, XDR injection rejected, no secret leakage in responses.

### Known Limitations

- **Signer**: `TestnetLocalSigner` is testnet-only. `UserWalletSigner`, `AgentPermissionSigner`, `HardwareSigner`, `KmsSigner` are NOT implemented — the interface is ready but the implementations are deferred.
- **Approval persistence**: Phase 3 ships with `SQLiteApprovalStore`, but the in-memory fallback (`InMemoryApprovalStore`) still loses records on restart if `dbPath` is not configured.
- **Cross-agent approval isolation**: Enforced via `ResourceAuthorizationService` and request-scoped authentication (see Phase 28K).
- **Async fire-and-forget**: Superceded in Phase 9 by `ExecutionQueue` with retries and dead-letter handling.
- **Activity persistence**: `SQLiteActivityStore` provides persistent storage when `dbPath` is configured.
- **Agent registry**: Persisted in `AgentStore` (Phase 11) with fallback resolution.
- **Daily spending limit race**: Addressed in Phase 23 via atomic single-statement update on `daily_spending` table.
- **Simulation**: For classic (non-Soroban) transactions, Horizon has no dry-run API. Simulation checks sequence, fee, balance, and envelope validity — but signature correctness is only checked at submission time. For Soroban contract calls, the Soroban-RPC `simulateTransaction` endpoint should be used (not yet implemented).
- **Transaction types**: XLM payments, issued assets, and trustline operations are supported (Phase 12). Account settings are supported. Contract invocation remains denied by default.
- **Mainnet**: Not tested. The pipeline asserts the network passphrase of the signer matches the signer passphrase, and `TestnetLocalSigner` is wired to the testnet passphrase in the pipeline constructor.
- **Soroban contracts**: `agent-registry` is compiled, tested (15 unit tests) and deployed to Stellar Testnet — see `docs/testnet.md`. `permissions` is intentionally **not** deployed: it is excluded from the contracts workspace, is not compiled or tested, lacks authorization checks, and needs its own DESIGN pass before any work resumes (`contracts/permissions/README.md`).
- **No KMS/HSM or user-custodied signer**: Production wallet implementations are deferred.
- **Live testnet submission**: Gated behind `LIVE_SUBMIT=1` and network configuration validation (Phase 21).

### Live Testnet Calls

No live Stellar testnet calls were executed during Phase 2 and Phase 3 implementation. All tests use deterministic mocks and in-process HTTP servers. The simulation and submission code paths call real Horizon APIs, but they are only reachable through the pipeline after policy ALLOW (which the test suite gates via DENY or requires_approval). A live testnet smoke test (`packages/stellar/test/live-smoke.ts`) is present but excluded from the default suite; run it manually with `npx tsx test/live-smoke.ts` when a funded testnet account is available.

## Phase 4 Details (Shipped)

### What was implemented

- **Web dashboard** (`apps/web`): React + TypeScript + Vite single-page app.
  - Overview page: signer account ID, agent count, network/pipeline status.
  - Agents page: list registered agents (id, name, address, capabilities, active status).
  - Activity page: aggregated activity records across agents (id, agent, intent type, amount, status, timestamp).
  - Approvals page: pending approval list with Approve and Reject buttons (reject requires confirmation dialog).
  - Submit Intent page: XLM payment intent form with client-side validation (amount positive, destination G..., reason ≥ 3 chars).
  - Navigation via sidebar tabs.
  - Loading, empty, and error states on all data-driven pages.
- **API read endpoints** (`apps/api/src/index.ts`):
  - `GET /agents` — public agent list (no secret fields).
  - `GET /agents/:id/activity?limit=N` — persisted activity per agent (limit clamped 1–100).
  - `GET /approvals?status=<status>` — approval list, optional status filter.
- **Store interface** (`packages/database/src/index.ts`): added `listAll(limit?)` to `ActivityStore` and `ApprovalStore`, implemented in all 4 store variants (in-memory + SQLite).
- **Frontend tests** (`apps/web/src/pages/__tests__/Approvals.test.tsx`): 6 vitest + RTL tests covering loading, empty state, approval row rendering, approve action, reject confirmation, reject cancel.
- **API tests** (`apps/api/test/read-endpoints.test.ts`): 9 tests covering agents list, empty list, activity retrieval, limit param, approvals list, status filtering, secret/XDR leak checks.

### Known Limitations (Phase 4 additions)

- **Frontend trust boundary**: The dashboard never receives private keys, seeds, secrets, or raw XDR. All policy evaluation, signing, and submission remain server-side.
- **Approval ownership**: Approve/reject endpoints are authenticated and owner-scoped (request-scoped authentication via `Authorization` header; `canApprove`/`canReject` verify the caller owns the agent). Detailed in Phase 28 (request-scoped auth).
- **Intent submission**: The Submit page supports XLM payment and trustline intents (Phase 12). No UI for contract_call, account_settings, or raw XDR.
- **Frontend does NOT bypass the approval state machine** — Approve/Reject buttons call the same backend endpoints that enforce transitions.
