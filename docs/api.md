# 4evergent HTTP API Reference

Current API surface of `apps/api`, accurate to the source at
`apps/api/src/index.ts`. All examples use placeholders — never real
credentials.

## Authentication

All endpoints except `GET /health` require authentication.

- **Development mode** (default): `DevAuthProvider` authenticates every
  request as the development owner (`DEV_OWNER_ID`, default `operator`).
  No `Authorization` header needed.
- **Production mode**: set `API_KEYS` (format
  `key:ownerId[:subject]`, comma-separated). Requests must send
  `Authorization: Bearer <key>`. Invalid/missing credentials → `401`.
  See [security-model.md](security-model.md) — API Authentication.

Unauthenticated requests to protected endpoints return
`{"code":"UNAUTHORIZED","error":"unauthorized"}` with status `401`.

## User Authentication (Browser Sessions)

In addition to API-key auth for machine clients, the API supports
browser-based user sessions for humans. Sessions live in an HttpOnly,
SameSite=Lax cookie named `four_eg_session`. Three login methods are
supported: email+password, Google OAuth, and Stellar wallet signature.

CSRF protection: cookie-authenticated state-changing requests must carry
the `X-Requested-With` header. Bearer/API-key requests are unaffected.

The design decisions behind this model — cookie vs token, the three providers
and their separation from `API_KEYS` machine auth, the Stellar challenge
binding, the single-process in-memory state, and session persistence — are
recorded as ADRs 016–019 in [architecture.md](architecture.md). Rate limiting
for the login endpoints is ADR-020 (Proposed).

### GET /auth/config

Public. Returns which login methods the server has enabled:

```json
{
  "email": true,
  "google": true,
  "stellar": true,
  "allowRegistration": true
}
```

### POST /auth/register

Create a new email+password account. Only available when
`allowRegistration` is `true`.

Body: `{ "email": string (required), "password": string (required, min 8 chars), "displayName"?: string }`

- `201` → `{ "user": { "id", "email", "displayName" } }` — session cookie is set
- `400` → invalid JSON / missing fields / password too short
- `409` → email already registered
- `403` → registration disabled

### POST /auth/login/email

Login with email+password.

Body: `{ "email": string (required), "password": string (required) }`

- `200` → `{ "user": { "id", "email", "displayName" } }` — session cookie is set
- `401` → invalid email or password

### GET /auth/me

Get the current logged-in user (from session cookie).

- `200` → `{ "user": { "id", "email", "displayName", "stellarPublicKey" } }`
- `401` → not logged in

### POST /auth/logout

Invalidate the current session.

- `200` → `{ "ok": true }` — session cookie is cleared

### GET /auth/google/start

Start Google OAuth flow. Redirects to Google's authorization endpoint.

### GET /auth/google/callback

Google OAuth callback. Exchanges the authorization code for a token,
creates/fetches the user, and sets the session cookie.

### POST /auth/stellar/challenge

Request a Stellar signature challenge.

Body: `{ "publicKey": string (required, Stellar address) }`

- `200` → `{ "challenge": string }` — the user signs this with their wallet
- `400` → invalid Stellar address

### POST /auth/stellar/verify

Verify a Stellar signature and log the user in.

Body: `{ "publicKey": string (required), "signature": string (required), "challenge": string (required) }`

- `200` → `{ "user": { "id", "stellarPublicKey", "displayName" } }` — session cookie is set
- `400` → invalid signature / expired challenge

## Ownership

All data is owner-scoped. Requests only see records owned by the
authenticated `ownerId`. Access to another owner's resource returns
`404` (not `403`) to avoid leaking existence.

## General error behavior

Every error response is JSON of the form `{"code": "<CODE>", "error": "<message>"}`
with an appropriate 4xx/5xx status. `code` is the stable, machine-readable
contract; `error` is human-readable and may change. `VALIDATION_ERROR` may also
carry a `details` field with field-specific messages. Unknown paths return
`{"code":"NOT_FOUND","error":"Not found"}` with `404`. Approve and reject errors additionally keep
the approval fields (`approvalId`, `activityId`, `status`, `message`). Request bodies are limited to 1 MB.

### Error codes

| Code | HTTP | Description |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing or invalid credentials. |
| `CSRF_FAILED` | 403 | Session request failed the CSRF header check. |
| `NOT_FOUND` | 404 | Unknown route. |
| `AGENT_NOT_FOUND` | 404 | The agent does not exist or is not owned by the caller. |
| `APPROVAL_NOT_FOUND` | 404 | The approval does not exist or is not owned by the caller. |
| `EXECUTION_NOT_FOUND` | 404 | The execution does not exist or is not owned by the caller. |
| `SCHEDULE_NOT_FOUND` | 404 | The schedule does not exist or is not owned by the caller. |
| `ACTIVITY_NOT_FOUND` | 404 | The activity record does not exist or is not owned by the caller. |
| `EXECUTION_QUEUE_DISABLED` | 404 | The execution queue is not enabled on this server. |
| `INVALID_PATH_PARAM` | 400 | A path identifier is missing or malformed. |
| `INVALID_JSON` | 400 | The request body is not valid JSON. |
| `VALIDATION_ERROR` | 400 | A field failed validation; see message and optional details. |
| `RAW_TRANSACTION_REJECTED` | 400 | Raw transaction payloads are not accepted. |
| `IDEMPOTENCY_KEY_INVALID` | 400 | The Idempotency-Key header is too long. |
| `IDEMPOTENCY_CONFLICT` | 409 | The Idempotency-Key was already used with a different intent. |
| `AGENT_NOT_ACTIVE` | 409 | The agent is paused or disabled. |
| `INVALID_EXECUTION_STATE` | 409 | The execution status does not allow the requested action. |
| `MAX_RETRIES_REACHED` | 409 | The execution has used all retry attempts. |
| `APPROVAL_INVALID_STATE` | 409 | The approval status does not allow the requested approve or reject. |
| `SCHEDULE_INVALID_TRANSITION` | 409 | The schedule status does not allow the requested pause, resume or disable. |
| `EXECUTION_CONFLICT` | 409 | The execution changed concurrently. |
| `APPROVAL_EXPIRED` | 410 | The approval passed its expiry before it was approved. |

---

## OpenAPI document

A machine-readable OpenAPI 3 description of this API lives at
[`openapi/openapi.json`](../openapi/openapi.json). It is maintained by hand
(not generated) and guarded by `pnpm check:openapi`
(`scripts/check-openapi.mjs`), which parses the router chain in
`apps/api/src/index.ts` and fails, in CI and locally, if a served route is
missing from the document or a documented route is not served. A checker was
chosen over a generator because the router is a hand-written `if` chain with
no route table to generate from, and the task forbids changing source.

Excluded on purpose: the nine `/auth/*` browser session routes
(`apps/api/src/auth.ts`). They use cookie sessions and redirects rather than
the Bearer integration surface. The document lists them under
`x-excluded-routes`, and the check verifies that list matches `auth.ts`.

## Health

### GET /health

Public (no authentication). Returns `{"status":"ok","signerAccountId":"G..."}`.

---

## Agents

### POST /agents

Create an agent. Auth: any authenticated owner.

Body: `{ "displayName": string (required, ≤100 chars, trimmed), "description"?: string (optional, ≤500 chars), "capabilities"?: string[] (optional, ≤32 entries, each ≤32 chars, trimmed, non-empty, unique), "stellarAddress"?: string }`

- `201` → `{ "agent": AgentRecord }` (bound to caller's `ownerId`)
- `400` → invalid JSON / missing `displayName` / `displayName` too long (>100 chars) / `description` not a string or too long (>500 chars) / `capabilities` not string array, too many entries (>32), entry too long (>32 chars), empty entry after trimming, or duplicate entries / `stellarAddress` not a string

### GET /agents

List caller's agents, with optional filtering by capability and limit clamping.

Query parameters:
- `capability` (string, optional): Filter agents by exact capability match. Case-sensitive.
- `limit` (number, optional): Maximum agents to return (clamped between 1 and 200, default 200).

Returns `{ "agents": AgentRecord[] }`.

Each returned `AgentRecord` includes its full `capabilities` string array. If no agents match the given `capability` (or the caller owns no agents), the endpoint returns `200` with `{ "agents": [] }` — never `404` or `500`.

Filtering is executed directly in the store layer (both SQLite and InMemory), preserving owner isolation: a query never returns agents owned by another caller, and filtering operates across the owner's full agent set before the limit is applied.

### Capability Discovery

To support multi-agent capability discovery and agent-to-agent negotiation (Phase 7 prerequisite), agents advertise their capabilities as string arrays (`capabilities: string[]`), which can be queried via `GET /agents?capability=<name>`.

Match semantics:
- **Exact match**: The query matches agent capabilities exactly. Substrings or prefixes (e.g. querying `pay` to match `payment`) are rejected to avoid ambiguous matches.
- **Case-sensitive**: Identifiers must match case exactly (`payment` does not match `Payment`).
- **Store-level filtering**: Filtering is executed in the store query (`SQLiteAgentStore` via `EXISTS (SELECT 1 FROM json_each(agents.capabilities_json) WHERE value = ?)` and `InMemoryAgentStore` via array membership). Filtering does not rely on post-filtering a capped handler list.
- **Empty results**: If no agents have the specified capability, returns `200` with `{ "agents": [] }`.

### GET /agents/:id

Get one agent (owner-scoped). `404` if not found or not owned.

### PATCH /agents/:id/status

Body: `{ "status": "active" | "paused" | "disabled" }`

- `200` → `{ "id", "status" }`
- `400` → invalid status / invalid JSON
- `404` → not found or not owned

### PATCH /agents/:id

Update an agent's metadata fields (owner-scoped). Only the fields present in
the body are changed; omitted fields are left untouched.

Body (all fields optional, at least one required):

- `displayName` — non-empty string, ≤100 chars (trimmed).
- `description` — string, ≤500 chars.
- `capabilities` — array of strings, ≤32 entries, each ≤32 chars (trimmed,
  non-empty, unique).

`status` and `stellarAddress` are **not** mutable on this route. Use
`PATCH /agents/:id/status` for status changes; `stellarAddress` is immutable
after creation because changing the signer address has security implications.
Unknown fields are rejected.

- `200` → `{ "agent": AgentRecord }`
- `400` → invalid JSON / no updatable fields / a field failed validation
- `404` → not found or not owned

---

## Intents

### POST /agents/:id/intents

Submit a typed intent for execution. The core endpoint.

Body: an `AgentIntent` union member (`packages/shared/src/types.ts`):

- `payment`: `{ type, asset, assetDetails?, destination, amount, reason, memo? }`
- `trustline`: `{ type, assetCode, issuer, limit?, reason }`
- `contract_call`: `{ type, contractId, function, args, reason }`
- `account_settings`: `{ type, setting, value, reason }`

Headers: optional `Idempotency-Key` (≤256 chars, scoped to owner+agent).
Same key + same intent → returns the original activity (`200`).
Same key + different intent → `409`.

Agent status admission: the agent must be `active`. A `paused` or
`disabled` agent rejects new intents before any activity, approval,
execution, or queue record is created:

- `409` → `{ "error": "agent is paused; new intents are rejected" }`
- `409` → `{ "error": "agent is disabled; new intents are rejected" }`

Existing approvals and in-flight executions are unaffected by a status
change — the gate applies to new intents only.

Behavior (policy decision):

- Policy `deny` → `403` with intent response recording the denial
- Policy `requires_approval` → `202` with `approvalId` in the response
- Policy `allow` → executes: `200` (submitted, includes `txHash`),
  `422` (simulation failed), `502` (source account load failed),
  `403` (rejected)

Response (success/denied): `{ "activityId", "agentId", "status",
"policyDecision", "authorizationStatus", "simulationResult",
"txHash", "error" }`

Raw XDR / transaction blobs in the body are rejected with `400`
(typed intents only — no raw transaction acceptance by design).

---

## Approvals

### POST /approvals/:id/approve

Approve a pending approval. Owner-scoped (`canApprove`). The approver
identity is taken from the authenticated principal's `subject`.

- `200` → `{ approvalId, activityId, agentId:"", status:"approved",
  message }` — execution is enqueued (persistent queue) or deferred
- `409` → `APPROVAL_INVALID_STATE` (e.g. already approved)
- `410` → `APPROVAL_EXPIRED`
- `404` → `APPROVAL_NOT_FOUND` (not found or not owned)

Each error body carries `code` and `error` plus the approval-response fields
(`approvalId`, `activityId`, `status`, `message`).

Raw XDR in body → `400` `RAW_TRANSACTION_REJECTED`.

### POST /approvals/:id/reject

Reject a pending approval. Owner-scoped (`canReject`).

- `200` → approval-response shaped, status `rejected`
- `409` → invalid state transition
- `404` → not found or not owned (approval-response shaped)

Raw XDR in body → `400` with `{"message": ...}`.

### GET /approvals

List caller's approvals (most recent 50). Query: `?status=<status>`
optional filter. Returns `{ "approvals": ApprovalRecord[] }`.

### GET /agents/:id/approvals

List approvals for one agent (owner-scoped). Query: `?status=` filter.
Returns `{ "agentId", "approvals": ApprovalRecord[] }`.

---

## Activity

### GET /agents/:id/activity

List activity records for an agent (owner-scoped).
Query: `?limit=` (default 50, clamped 1–100).
Returns `{ "agentId", "activity": ActivityRecord[] }`.

### GET /agents/:id/activity/:activityId

Single activity record (owner-scoped). `404` if not found/not owned.
Returns `{ "activity": ActivityRecord }`.

---

## Policy

### `PolicyRules`

`PolicyRules` is the complete policy shape returned by `GET /agents/:id/policy`.
`PUT /agents/:id/policy` may omit fields: the API validates the supplied values
and fills omitted fields from `DEFAULT_RULES` before storing them. The
[policy limits table](security-model.md#spending-limits) summarizes the spending
limits; the details below define the request fields.

Amounts in `maxTxAmount`, `dailySpendingLimit`, `approvalThreshold`, and
`requireHumanApprovalForAmountAbove` are JSON strings in the TypeScript type.
The validator also accepts JSON numbers for these fields. Amounts must be finite;
`maxTxAmount` entries must be greater than zero, while daily limits and approval
thresholds may be zero or greater.

| Field | Type | Meaning and format | Default |
|---|---|---|---|
| `maxTxAmount` | `Record<string, string>` | Per-transaction maximum, keyed by policy asset identifier. Each configured value must be positive. | `{ "XLM": "100" }` |
| `dailySpendingLimit` | `Record<string, string>` | Per-agent daily limit, keyed by policy asset identifier. Each value must be non-negative. | `{ "XLM": "500" }` |
| `allowedAssets` | `string[]` | Asset identifiers permitted by the policy. An empty array disables this allowlist check. | `["XLM"]` |
| `allowedDestinations` | `string[]` | Payment destination account IDs. Entries must be 56-character strings beginning with `G`; an empty array disables the destination check. | `[]` |
| `allowedContractIds` | `string[]` | Contract IDs permitted for contract calls. Entries must be non-empty strings; an empty array disables this allowlist check. | `[]` |
| `txTypeRestrictions` | `Record<string, boolean>` | Supported keys are `payment`, `trustline`, `contract_call`, and `account_settings`. A type is permitted only when its value is `true`; unknown keys are invalid. | `{ "payment": true, "trustline": true, "contract_call": false, "account_settings": false }` |
| `approvalThreshold` | `string` | Compatibility alias for the human-approval amount gate. If the canonical field below is omitted, normalization uses this value for it. | `"50"` |
| `requireHumanApprovalForAmountAbove` | `string` | Effective human-approval threshold read by the policy engine. Amounts equal to or greater than this threshold require approval. | `"50"` |

`maxTxAmount` and `dailySpendingLimit` keys, and `allowedAssets` entries, use
the policy engine's normalized asset names: `XLM` for native XLM and
`CODE:ISSUER` for an issued asset. This follows the
[`PaymentAsset` representation](capabilities.md#asset-representation): native
XLM has no issuer, while an issued asset is identified by its code and issuer.
For trustline intents, the engine's identifier is
`trustline:CODE:ISSUER`. When an exact per-asset spending-limit key is absent,
the engine also supports a `native` fallback key. See
[`extractAsset` and the policy checks](../packages/policy/src/engine.ts).

`approvalThreshold` is retained as a compatibility alias. Normalization copies
it to `requireHumanApprovalForAmountAbove` when the latter is omitted, and copies
the canonical value back when only the canonical field is supplied. If both are
provided with different values, the engine uses
`requireHumanApprovalForAmountAbove`; it compares the transaction amount with
`>=`, so an amount exactly at that effective threshold requires approval. See
[`normalizePolicyRules`](../packages/policy/src/validation.ts) and the
[approval check](../packages/policy/src/engine.ts). The zero-value validation
boundary is tracked separately in [PR #101](https://github.com/naninu123/4evergent/pull/101).

Example complete request body using the defaults:

```json
{
  "maxTxAmount": { "XLM": "100" },
  "dailySpendingLimit": { "XLM": "500" },
  "allowedAssets": ["XLM"],
  "allowedDestinations": [],
  "allowedContractIds": [],
  "txTypeRestrictions": {
    "payment": true,
    "trustline": true,
    "contract_call": false,
    "account_settings": false
  },
  "approvalThreshold": "50",
  "requireHumanApprovalForAmountAbove": "50"
}
```

The field types and defaults come from [`PolicyRules` and `DEFAULT_RULES`](../packages/policy/src/types.ts);
the accepted values and the invalid-policy response are defined by
[`validatePolicyRules`](../packages/policy/src/validation.ts).

### GET /agents/:id/policy

Get the agent's effective policy rules (owner-scoped). Returns
`{ "agentId", "policy": PolicyRules, "version": number, "updatedAt" }`.
Agents without a custom policy return `DEFAULT_RULES` with `version: 0`.

### PUT /agents/:id/policy

Set the agent's policy (owner-scoped). Body: a `PolicyRules` object.
Validated by `validatePolicyRules`; normalized before storage.

- `200` → `{ "agentId", "policy", "version" }`
- `400` → `{"error":"invalid policy","details":[...]}` / invalid JSON /
  body not an object

---

## Schedules

### POST /agents/:id/schedules

Create a schedule (owner-scoped). Body:

`{ "intent": AgentIntent, "scheduleExpression": "<cron-like>",
"timezone"?: string (default "UTC") }`

Intent and expression are validated (`validateScheduleIntent`,
`validateScheduleExpression`); invalid input → `400` with the
validator's error message. `201` → `{ "schedule": ScheduleRecord }`.

### GET /agents/:id/schedules

List schedules for an agent (owner-scoped). Query: `?limit=`
(default 50, clamped 1–100). Returns `{ "agentId", "schedules": [] }`.

### GET /agents/:id/schedules/:scheduleId

Single schedule (owner-scoped). Returns `{ "schedule": ScheduleRecord }`.

### PATCH /agents/:id/schedules/:scheduleId

Update a schedule's `scheduleExpression` (re-validated against the
schedule's timezone). `200` → `{ "schedule" }`.

### DELETE /agents/:id/schedules/:scheduleId

Delete a schedule. `200` → `{ "deleted": true }`.

### POST /agents/:id/schedules/:scheduleId/pause | /resume | /disable

Transition schedule status (`paused` / `active` / `disabled`).
`200` → `{ "schedule" }`.

The current status is validated before writing. A transition that is not
legal, including a no-op, returns `409` with
`{ "error": "cannot <action> schedule in status '<current>'" }` and the
schedule is left unchanged. No-ops are rejected rather than treated as
idempotent so callers get a signal that nothing changed.

| Current status | pause | resume | disable |
|---|---|---|---|
| `active` | `200` (paused) | `409` | `200` (disabled) |
| `paused` | `409` | `200` (active) | `200` (disabled) |
| `disabled` | `409` | `200` (active) | `409` |

`disabled` is reversible: `resume` is accepted from `disabled`, which matches
the dashboard's Resume button. Making it terminal would be a design decision
for the maintainers (see #6 and #7 for the agent-side equivalent).

### Missed schedule runs

An occurrence due now or no more than five minutes ago follows the normal
execution path and still passes policy and approval checks. An occurrence more
than five minutes late is logged and skipped; the scheduler advances the
schedule to its next cron occurrence rather than replaying every missed
interval. Configure the grace period with `SCHEDULER_MAX_LATENESS_MS` (default
`300000` milliseconds). This single-run grace window avoids unbounded payment
bursts after downtime while preserving near-on-time schedules. If the cron
expression is invalid or cannot produce a strictly future occurrence during
recovery, the scheduler pauses that schedule and logs the reason. Correct the
expression before resuming it.

---

## Executions

Execution records are created when an approved intent is enqueued for
on-chain execution (retry, dead-letter, reconciliation).

### GET /agents/:id/executions

List executions for an agent (owner-scoped). Query: `?limit=`
(default 50, clamped 1–100). Returns `{ "agentId", "executions": [] }`.

### GET /executions/:id

Single execution (owner-scoped via `getForOwner`). Returns
`{ "execution": ExecutionRecord }`.

### POST /executions/:id/retry

Retry a `failed` or `dead_letter` execution. Requires the execution
queue to be enabled. Cancelled executions cannot be retried.

- `200` → `{ "execution", "message": "execution queued for retry" }`
- `409` → wrong status (e.g. attempting to retry a `cancelled` execution) / max retries reached / state conflict
- `404` → not found / queue not enabled

### POST /executions/:id/cancel

Cancel a `queued` or `executing` execution. Requires the queue.
Transitions the execution to the terminal `cancelled` status with `error: "cancelled by user"`.
Cancelled executions represent intentional operator stops (a value-safety control) and
cannot be retried via `/executions/:id/retry`. They are reported under `cancelled` in status
summaries and are not counted as failed or dead-letter executions in overview counters.

- `200` → `{ "execution", "message": "execution cancelled" }` (returned execution has `status: "cancelled"`)
- `409` → wrong status / conflict
- `404` → not found / queue not enabled

> **Migration note**: Existing historical records carrying `status: "dead_letter"` with
> `error: "cancelled by user"` (from prior releases where manual cancellations transitioned to
> `dead_letter`) are intentionally not silently reclassified to `cancelled`. They remain stored
> as `dead_letter` to preserve historical record integrity. Operators inspecting historical data
> will continue to see `dead_letter` for older cancellations. All cancellations performed going
> forward will transition to the distinct `cancelled` terminal status.

### GET /agent-queue

Queue summary for the caller's executions. Returns
`{ "running": boolean, "byStatus": Record<string, number> }`.
`404` with `{"code":"EXECUTION_QUEUE_DISABLED",...}` if the queue is off.

---

## Dashboard (owner-scoped listing endpoints)

These three endpoints were added as dashboard convenience routes to eliminate
N+1 fetch patterns. All are owner-scoped: every request must be authenticated
and only returns data belonging to the authenticated `ownerId`.

### GET /activity

List all activity records across every agent owned by the caller.

**Auth:** required (owner-scoped).

Query parameters:

| Parameter | Default | Max | Description |
|---|---|---|---|
| `limit` | `50` | `100` | Maximum number of records to return. Values outside 1–100 are clamped. |

Response `200`:

```json
{
  "activity": [ActivityRecord]
}
```

`ActivityRecord` fields are defined in `packages/shared/src/types.ts`.

---

### GET /agents/:id/spending

Return the current day's spending breakdown for a single agent,
computed from the agent's active policy rules and the day's reserved
spending totals.

**Auth:** required (owner-scoped). `404` if the agent is not found or not
owned by the caller.

Response `200`:

```json
{
  "agentId": "<id>",
  "spending": {
    "XLM": {
      "used": 12.5,
      "limit": "500",
      "remaining": 487.5
    }
  }
}
```

The `spending` value is a `Record<string, { used: number; limit: string; remaining: number }>`.
Each key is a policy asset identifier (e.g. `XLM`, `CODE:ISSUER`). Only
assets listed in the agent's `dailySpendingLimit` policy appear in the
response. `remaining` is clamped to `0` — it will never be negative.

---

### GET /overview/attention

Return headline counters for items that need the owner's attention.
All counts are owner-scoped — they reflect the authenticated owner's
data only.

**Auth:** required (owner-scoped).

Response `200`:

```json
{
  "pendingApprovals": 3,
  "failedExecutions": 1,
  "deadLetterExecutions": 0,
  "retryingExecutions": 2,
  "stuckExecutions": 0
}
```

| Field | Description |
|---|---|
| `pendingApprovals` | Approvals in `pending_approval` state owned by the caller. |
| `failedExecutions` | Executions in `failed` state. |
| `deadLetterExecutions` | Executions in `dead_letter` state. |
| `retryingExecutions` | Executions in `queued` state (awaiting retry). |
| `stuckExecutions` | Executions in `executing` state (may be hung). |

---

## Typed TypeScript client

The private workspace package [`@4evergent/client`](../packages/client/README.md)
provides a typed, dependency-free client for these routes. It uses Node.js 22+
built-in `fetch`, accepts a base URL and optional bearer token, and throws
`ApiError` with the HTTP status and parsed API error body for non-2xx responses.
Authentication and `/auth/*` flows remain the caller's responsibility.

The client follows the documented API surface with these method names:

| Documented route | Client method |
|---|---|
| `GET /health` | `health` |
| `POST /agents` | `createAgent` |
| `GET /agents` | `listAgents` |
| `GET /agents/:id` | `getAgent` |
| `PATCH /agents/:id/status` | `updateAgentStatus` |
| `PATCH /agents/:id` | `updateAgent` |
| `POST /agents/:id/intents` | `submitIntent` |
| `GET /approvals` | `listApprovals` |
| `GET /approvals/:id` | `getApproval` |
| `GET /agents/:id/approvals` | `listAgentApprovals` |
| `POST /approvals/:id/approve` | `approve` |
| `POST /approvals/:id/reject` | `reject` |
| `GET /agents/:id/activity` | `listAgentActivity` |
| `GET /agents/:id/activity/:activityId` | `getAgentActivity` |
| `GET /activity` | `listActivity` |
| `GET /agents/:id/policy` | `getPolicy` |
| `PUT /agents/:id/policy` | `updatePolicy` |
| `POST /agents/:id/schedules` | `createSchedule` |
| `GET /agents/:id/schedules` | `listSchedules` |
| `GET /agents/:id/schedules/:scheduleId` | `getSchedule` |
| `PATCH /agents/:id/schedules/:scheduleId` | `updateSchedule` |
| `DELETE /agents/:id/schedules/:scheduleId` | `deleteSchedule` |
| `POST /agents/:id/schedules/:scheduleId/pause` | `pauseSchedule` |
| `POST /agents/:id/schedules/:scheduleId/resume` | `resumeSchedule` |
| `POST /agents/:id/schedules/:scheduleId/disable` | `disableSchedule` |
| `GET /agents/:id/executions` | `listAgentExecutions` |
| `GET /executions` | `listExecutions` |
| `GET /executions/:id` | `getExecution` |
| `POST /executions/:id/retry` | `retryExecution` |
| `POST /executions/:id/cancel` | `cancelExecution` |
| `GET /agent-queue` | `queueStatus` |
| `GET /agents/:id/spending` | `getAgentSpending` |
| `GET /overview/attention` | `overviewAttention` |

Schedule pause, resume, and disable are separate methods because they are
separate documented action paths. Shared domain types such as `Agent`,
`AgentIntent`, `ActivityRecord`, and `PolicyRules` come from
`@4evergent/shared`; record and response types absent from shared are declared
in the client package.

## Notes

- Response shapes above are the primary success shapes; record fields
  (`AgentRecord`, `ActivityRecord`, `ApprovalRecord`, `ScheduleRecord`,
  `ExecutionRecord`, `PolicyRules`) are defined in
  `packages/shared/src/types.ts` and `packages/database/src/*-types.ts`.
- This API is served by `apps/api` (`pnpm --filter @4evergent/api start`,
  default port 3000). Configuration via environment — see
  [testnet.md](testnet.md) and `.env.example`.

---

## Hosted runtime (production deployment)

The API is a **long-running, stateful Node.js service**. It is not a serverless
function and does not support scale-to-zero. Any hosting choice must satisfy
the requirements below; this document does not endorse a specific provider.

### Runtime requirements

- **Node.js 22 or newer.** `apps/api` and the `@4evergent/database` stores use
  the built-in `node:sqlite` module (Node 22+). The repository pins
  `pnpm@10.34.5` (root `packageManager`) and Node 22 (`.nvmrc`).
- **One instance only.** Sequence-sensitive Stellar submission is serialized by
  an in-process coordinator (`AccountSequenceCoordinator`), and the execution
  queue and reconciler run as in-process timers. Running two instances against
  the same database would allow duplicate workers and conflicting sequence
  numbers. Do not autoscale horizontally.

### Required environment

| Variable | Required | Notes |
|---|---|---|
| `STELLAR_TESTNET_SECRET_KEY` | yes | Testnet signing key, read at startup by `TestnetLocalSigner`. Never bake into an image. |
| `STELLAR_HORIZON_URL` | no | Defaults to `https://horizon-testnet.stellar.org`. **Must contain `testnet`** or startup fails. |
| `HOST` | yes in a container | Bind address. Use `0.0.0.0` to be reachable outside the container/network namespace. Defaults to `127.0.0.1` (loopback only). |
| `PORT` | usually | Defaults to `3000`. Most platforms inject this. |
| `DATABASE_PATH` | yes in production | SQLite file path. Omit it and all records live in memory and are lost on restart. Mount a **persistent** volume at this path. |
| `API_KEYS` | yes unless deliberately public | `key:ownerId[:subject]`, comma-separated. Enables `ProductionApiKeyAuthProvider`; every protected endpoint then requires `Authorization: Bearer <key>`. |
| `CORS_ORIGIN` | when the frontend is cross-origin | Comma-separated exact browser origins. Unset ⇒ no `Access-Control-Allow-Origin` header ⇒ browsers block the calls. |
| `LIVE_SUBMIT` | no | `1` enables real Testnet submission. Off by default. |
| `ALLOW_DEV_AUTH` | no | See "Authentication fail-closed" below. |

### Authentication fail-closed

Development auth (`DevAuthProvider`) authenticates **every** request as a single
default owner with no credentials. To keep local development simple while
preventing an accidental public exposure, startup refuses to run when:

- `HOST` is not loopback (`127.0.0.1`, `localhost`, `::1`), **and**
- `API_KEYS` is not set, **and**
- `ALLOW_DEV_AUTH` is not `1`.

That combination exits with a `FATAL` error rather than serving an
unauthenticated API on a public interface. Setting `ALLOW_DEV_AUTH=1` is an
explicit operator opt-in and must not be used for a real deployment.

### Persistent filesystem

`DATABASE_PATH` must live on storage that survives restarts and redeploys —
a container volume or attached disk. An ephemeral container filesystem loses
agents, activities, approvals, schedules, executions, and policy config on every
restart, and the SQLite file cannot be reliably shared between instances.

### Background workers

`apps/api/src/server.ts` starts, in-process:

- an **execution queue** (polls for due executions every 10s, with retry and
  dead-letter semantics), and
- a **transaction status reconciler** (polls Horizon every 30s for submitted
  transactions).

Startup also runs `ExecutionRecoveryService.recover()` to re-queue records left
in `executing` by an unclean shutdown. These timers require a process that stays
alive; a platform that freezes or suspends idle processes will delay execution
and reconciliation. Note also that the process has no `SIGTERM`/`SIGINT` handler,
so a platform that stops hard on shutdown can interrupt in-flight work — the
startup recovery pass is what repairs that on the next boot.

### Not supported: serverless and scale-to-zero

This API must not be deployed to a request-scoped serverless or scale-to-zero
platform. The blockers are structural, not configuration:

- file-backed SQLite (no shared database service),
- long-lived in-process timers (queue, reconciler, scheduler),
- in-process sequence serialization for Stellar submissions,
- a persistent single-instance process model.

Deploy it as a long-running service with a persistent volume. The Dockerfile in
`apps/api/Dockerfile` builds a provider-neutral image for that purpose:

```
docker build -f apps/api/Dockerfile -t 4evergent-api .
```

It runs the repository's own start script (`pnpm --filter @4evergent/api start`
→ `node apps/api/dist/server.js`) and takes all configuration from the runtime
environment. No provider-specific configuration is included.

### Frontend integration

The dashboard (`apps/web`) is a static Vite SPA. Set `VITE_API_BASE` at build
time to the API's public origin, and set the API's `CORS_ORIGIN` to the
frontend's origin. The two are configured independently — the frontend must not
rely on same-origin `/api` proxying. See `.env.example`.
### Data retention

The server sweeps expired `auth_sessions` and old `daily_spending` reservations
once per day by default. Expired session rows are retained for 30 days after
`expires_at`; spending rows are retained for 90 UTC days. Rows are deleted in
batches of at most 500 per table, using the expiry and day indexes, so each
autocommit statement has bounded work and does not hold a long-running write
transaction. A sweep logs the number removed from each table.

Configure the policy with `AUTH_SESSION_RETENTION_DAYS`,
`DAILY_SPENDING_RETENTION_DAYS`, and `DATA_RETENTION_INTERVAL_MS`. Set either
table's day window to `0` to keep its rows forever, or set
`DATA_RETENTION_ENABLED=0` to disable the worker. Session retention begins
after expiration; a live session is never removed. Daily-spending rows for the
cutoff UTC date or newer remain available, including the current day.
