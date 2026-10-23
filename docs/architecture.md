# Architecture Decisions

All decisions recorded via the ADR-lite convention. Each entry: **Status | Context | Decision | Consequences.**

## ADR-001: Monorepo with pnpm workspaces

**Status:** Accepted  
**Context:** Need independent contributor workflows across frontend, backend, policy engine, Stellar adapter, shared types, and Soroban contracts.  
**Decision:** Use a pnpm-workspace monorepo at the root with `apps/` and `packages/` layout.  
**Consequences:** Enables independent versioning, incremental builds, and clear ownership boundaries. Soroban contracts live in `contracts/` with their own Cargo workspace.

## ADR-002: Policy engine is pure & deterministic

**Status:** Accepted  
**Context:** The LLM must never have unrestricted wallet authority. Authorization must be separable and auditable.  
**Decision:** Policy engine (`packages/policy`) is a pure function: `evaluate(intent, agentAddress) => PolicyDecision`. No network, no LLM, no randomness. Rules are data (allowlists, limits, thresholds).  
**Consequences:** Policy decisions are fully testable and reproducible. New rules added as data, not code paths.

## ADR-003: Intent-first, never raw transactions

**Status:** Accepted  
**Context:** If the LLM can produce arbitrary transaction blobs, it can bypass the policy layer.  
**Decision:** The LLM produces intents (typed schema). The Stellar adapter constructs transactions from validated intents. No raw blob acceptance from the LLM path.  
**Consequences:** All on-chain actions are schema-bound and policy-checked.

## ADR-004: Simulation before signing

**Status:** Accepted  
**Context:** Transactions should not be signed if they will fail on-chain.  
**Decision:** Every transaction is simulated against the testnet before signing. Simulation results (fee, warnings, errors) are recorded in the activity log.  
**Consequences:** Reduces failed transactions and wasted fees. Simulation failures abort the pipeline.

## ADR-005: Testnet-first, no mainnet assumptions in MVP

**Status:** Accepted  
**Context:** MVP must be safe to deploy and iterate on without risking real value.  
**Decision:** All Stellar interactions default to testnet (`https://horizon-testnet.stellar.org`). Mainnet config is a deploy-time environment variable, never a code assumption.  
**Consequences:** Contributors can run the full pipeline locally without real XLM.

## ADR-006: No project token in MVP

**Status:** Accepted  
**Context:** Tokenomics distracts from the core agent-permission problem and introduces speculative risk.  
**Decision:** MVP contains no token, no token sale, no bonding curve, no speculative mechanics. All actions use XLM or native testnet assets.  
**Consequences:** Avoids regulatory surface and keeps focus on the permissioned-execution layer.

## ADR-007: tsx test runner with explicit `.ts` import extensions

**Status:** Accepted  
**Context:** Node.js ESM (verified on Node 26 during initial development; the supported runtime is Node 22+) requires explicit `.ts` extensions for local imports when running via tsx without a bundler.  
**Decision:** All intra-project relative imports use `.ts` extensions. Test runner is `tsx --test`.  
**Consequences:** Tests run without a separate build step. Production build uses `tsc` which rewrites extensions appropriately, or a bundler handles it.

## ADR-008: Signer abstraction, never LLM-held keys

**Status:** Accepted  
**Context:** A server-held private key that the LLM can ask to sign anything defeats the purpose of the policy engine. The backend must NEVER give the LLM direct signing authority.  
**Decision:** The `Signer` interface abstracts signing authority. The pipeline holds a `Signer` reference; callers never receive one. Initial implementation is `TestnetLocalSigner` (testnet-only, env-loaded, never exposed to LLM). Future implementations (user-wallet, permissioned-agent, hardware/KMS) plug in via the same interface.  
**Consequences:** The LLM can propose intents but cannot sign. Signing is a capability, not a function the LLM can call. Production wallets are swappable without touching the pipeline.

## ADR-009: Transaction pipeline as a single ordered gate chain

**Status:** Accepted  
**Context:** Multiple gates (validation → policy → authorization → construction → simulation → signing → submission) must run in order. Any shortcut (e.g., allowing callers to invoke the signer directly) creates a bypass.  
**Decision:** `TransactionPipeline.execute()` is the ONLY public entry point. It runs each gate in sequence and stops at the first failure. No individual step is exposed as a public method that callers can chain arbitrarily.  
**Consequences:** The gate order is structural, not conventional. Tests can prove that a policy DENY, a failed simulation, or an approval-required state cannot reach the signer.

## ADR-010: Activity log records decisions, not secrets

**Status:** Accepted  
**Context:** The activity log must be auditable (shareable with operators, displayed in the UI) but must never leak key material.  
**Decision:** `ActivityRecord` stores `policyDecision`, `authorizationStatus`, `simulationResult`, `txHash`, and `error`. It has NO field for private keys, seeds, or mnemonics. The store's `record()` method runs `assertNoSecrets()` before persisting.  
**Consequences:** The activity log can be safely returned through the API and shown in the frontend without redaction.

## ADR-011: SQLite-backed persistence via node:sqlite

**Status:** Accepted
**Context:** Phase 3 needs durable activity and approval storage without introducing an external database dependency.
**Decision:** `SQLiteActivityStore` and `SQLiteApprovalStore` in `packages/database/src/sqlite-store.ts` use Node.js built-in `node:sqlite` (`DatabaseSync`). Schema is versioned in `_meta` (version 1). The default API server auto-selects SQLite when `dbPath` is provided; otherwise falls back to in-memory stores. No external `better-sqlite3` or server process.
**Consequences:** Single dependency (Node.js stdlib), file-backed persistence with cross-restart durability tested via reopen simulation. `initSchema()` idempotent. Partial unique index `idx_approvals_activity_one` enforces one PENDING_APPROVAL per activity.

## ADR-012: Persistent Execution Queue for Retry & Dead-Letter

**Status:** Accepted | Phase 9 | 2026-09-16

**Context:** Phase 8 used `setImmediate` for fire-and-forget execution after approval. If the process exits or execution throws, the approval stays in `approved`/`executing` state with no retry or recovery. Scheduled intents also had no persistent execution record.

**Decision:** Introduce `ExecutionStore` (InMemory + SQLite via `node:sqlite`) and `ExecutionQueue` that:
- Persists execution records with full state: `queued → executing → submitted → confirmed → failed → dead_letter`
- Retries transient failures (network/Horizon/submission errors) with exponential backoff (baseDelayMs \* 2^attempt, capped at maxDelayMs)
- Moves permanent failures (policy deny, invalid intent, validation error) directly to `dead_letter`
- Bounded retries: max 3 (configurable) after which execution moves to `dead_letter`
- Duplicate safety: atomic conditional update CAS (`updateIfStatus(queued→executing)`) ensures only one worker can claim a queued execution
- Owner-scoped: all execution records are tied to `ownerId`, endpoints enforce owner isolation via `getForOwner/listByOwner`
- Recovery: `ExecutionRecoveryService` scans stuck `executing` records on startup and re-queues them via `nextRetryAt`; `ScheduleRecoveryService` reconciles interrupted schedule runs before the scheduler ticks (ADR-022)
- Approval boundary: execution records carry `approvalId`; the queue does NOT bypass approval — it only executes after approval has been recorded

**Consequences:**
- Execution state survives process restarts (when SQLite store is configured)
- Transient failures are automatically retried with backoff
- Permanent failures are visible in `dead_letter` for manual intervention
- Scheduler (Phase 8) and approval flow both enqueue through the same queue
- Exactly-once is not guaranteed (single-process SQLite provides at-most-once deduplication via atomic status claims); document as known limitation
- Recovery: `ExecutionRecoveryService` scans stuck `executing` records on startup and re-queues them via `nextRetryAt`; `ScheduleRecoveryService` reconciles interrupted schedule runs before the scheduler ticks (ADR-022)

## ADR-013: Agent Self-Serve Creation

**Status:** Accepted | Phase 11 | 2026-09-16

**Context:** Users could not create agents from the web UI. Agents had to be registered programmatically via `registerAgent()` on the API server instance, which required backend-only bootstrap. The `agents` Map was in-memory only and lost on restart.

**Decision:** Introduce `AgentStore` abstraction (InMemory + SQLite via `node:sqlite`) and `POST /agents` endpoint. The endpoint validates input, binds the agent to `requestCtx.ownerId`, persists via `AgentStore`, and returns the created record. Existing `registerAgent()` now syncs to both the in-memory Map (for backward compatibility with scheduler and authorization) and the persistent store. `handleListAgents` and `handleGetAgent` now read from `AgentStore` instead of the in-memory Map.

**Consequences:**
- Users can create agents from the Agents page without backend bootstrap
- Agents survive API restart when SQLite store is configured
- Owner isolation enforced via existing `ResourceAuthorizationService`
- Backward compatible: existing test helpers using `registerAgent()` still work
- No production authentication — `requestContext.ownerId` is set server-side (existing limitation)
- `AgentRecord` has no secret fields by construction

## ADR-014: Bounded retention sweeps for transient data

**Status:** Accepted

**Context:** Expired authentication sessions and historical daily-spending reservations accumulated indefinitely. The former exposed stale tokens in storage; the latter had no readers once its UTC day passed. Cleanup must not starve request traffic.

**Decision:** Sweep sessions 30 days after `expires_at` and daily-spending rows older than 90 UTC days, once per day. Each indexed delete is limited to 500 rows per table and runs as a short autocommit statement. Operators can set the two retention-day environment variables, change the interval, disable the worker, or set either day window to zero to retain that table forever. The idempotency table remains outside this policy and belongs to #109.

**Consequences:** Transient storage is bounded over repeated sweeps without a schema migration or a long-held write transaction. A large backlog drains in batches. Recent expired sessions and the current spending day remain available; setting a zero window explicitly keeps all rows.

## ADR-015: agent-registry rewritten from scaffold to deployed contract

**Status:** Accepted | 2026-09-28

**Context:** `contracts/agent-registry` was originally committed as an unimplemented scaffold: `DESIGN.md` described intent and API mapping only, with no authorization, no validation, and no state semantics. The contract has since been implemented and deployed to Testnet (see `docs/testnet.md` for the contract ID and wasm hash). The scaffold-era `DESIGN.md` still claimed "No implementation yet" and described a contract that no longer exists, misleading contributors who read it first.

**Decision:** Treat `contracts/agent-registry/src/lib.rs` as the source of truth and rewrite `contracts/agent-registry/DESIGN.md` as a post-rewrite design document grounded in the deployed code. The rewrite documents the four entrypoints (`register`, `update_metadata`, `deactivate`, `query`), the `AgentInfo`/`DataKey` data model, the 9-variant `Error` enum, and the TTL policy. Authorization was added to all three mutating entrypoints: each calls `caller.require_auth()` as its first statement, and `register` additionally calls `stellar_address.require_auth()` to bind the on-chain identity to the Stellar account. Open design questions (events #5, id character set #4, validation hardening #8, anti-squatting #7, upgrade path #104, deactivate irreversibility #6, TTL policy #19) are referenced, not decided.

**Consequences:**
- `DESIGN.md` matches the deployed contract; every claim is checkable against `src/lib.rs` with file+line citations.
- The pre-rewrite scaffold description is removed; the deployed contract is the only documented behaviour.
- Authorization is now part of the documented contract surface: mutating entrypoints require the owner's signature, and `register` binds the agent to the Stellar address that authorized it.
- Open questions remain explicitly open; the document does not present #6, #7, or #19 as settled.
- No contract behaviour, validation, events, TTL, or permissions-crate code was changed by this decision; it is documentation-only.
- Deploy commands and the authoritative contract ID/wasm hash stay in `docs/testnet.md` and are linked, not duplicated.

## ADR-016: Bounded missed schedule runs

**Status:** Accepted

**Context:** A process restart can leave scheduled value-moving work overdue. Replaying every missed cron interval creates a burst, while silently running an old occurrence leaves operators unaware of downtime.

**Decision:** Run occurrences due now or up to five minutes late. Skip older occurrences, log the schedule ID and lateness, and advance the schedule to its next cron occurrence. If the expression is invalid or cannot yield a future occurrence, pause the schedule and log the reason so an operator can correct it. Configure the grace period with `SCHEDULER_MAX_LATENESS_MS` (default `300000`).

**Consequences:** Restart recovery cannot generate an unbounded catch-up burst. A skipped run is visible in server logs; users needing a longer grace period can configure it. Normal on-time execution retains the existing policy and approval pipeline.

## ADR-017: Browser sessions use an HttpOnly cookie, not a token

**Status:** Accepted

**Context:** The dashboard (`apps/web`) needs a session for a human user across page loads and reloads. The two candidate designs were a bearer token held by the frontend (localStorage/sessionStorage) or an opaque server-side session referenced by a cookie. A token in web storage is readable by any script that reaches the page, so an XSS in the dashboard becomes a full credential theft; a cookie marked `HttpOnly` is not exposed to script at all. Logout also has to mean something: with a self-contained token the server cannot revoke it before expiry, so "logged out" would be a client-side fiction.

**Decision:** Browser sessions are opaque 32-byte random tokens (`randomBytes(32).toString("hex")`, `apps/api/src/auth.ts:385`) held in an `HttpOnly` cookie named `four_eg_session` (`apps/api/src/auth.ts:38`, cookie built at `apps/api/src/auth.ts:366-376`). The token is a lookup key into a server-side session record; no user identity, role, or claim is encoded in it. `Path=/`, `SameSite=Lax` by default (`COOKIE_SAMESITE`, `apps/api/src/auth.ts:367`), and `Secure` when the request is TLS or `x-forwarded-proto: https` (`cookieSecure()`, `apps/api/src/auth.ts:358-364`). Session lifetime is `SESSION_TTL_SECONDS`, default 86400 (24h), clamped to the range 60s–30d (`apps/api/src/auth.ts:344`). Logout deletes the server-side record, so the cookie stops resolving immediately (`apps/api/src/auth.ts`, `/auth/logout`).

**Consequences:** A stolen cookie is a bearer credential, but script injection cannot read it. Session revocation is real and immediate. Because the cookie is sent automatically, state-changing requests need a second CSRF layer: cookie-authenticated non-GET/HEAD/OPTIONS requests must carry the `X-Requested-With` header (`apps/api/src/auth.ts:23`, enforced at `apps/api/src/auth.ts:737`); `SameSite=Lax` is the first layer, the header is the second. Machine clients (CLI, service integrations) keep using the `Authorization: Bearer` path — see ADR-018. Cross-site cookie use requires `COOKIE_SAMESITE=none`, which forces `Secure` and is opt-in only (`apps/api/src/auth.ts:374`).

## ADR-018: Three human identity providers, kept separate from API-key machine auth

**Status:** Accepted

**Context:** Humans log in from the browser; services call the API programmatically. These have different credential models: a human proves control of an email inbox, a Google account, or a Stellar keypair, while a machine client is handed a pre-shared secret. Reusing one mechanism for both would either force humans to manage long random secrets or give machine keys human-shaped session semantics.

**Decision:** The user-auth module (`apps/api/src/auth.ts`, wired at `apps/api/src/index.ts:52` and mounted before the auth gate at `apps/api/src/index.ts:596-597`) implements three providers, all converging on the same session cookie:

- **Email + password** — scrypt (Node default N=16384, r=8, p=1, 64-byte key) with a per-user 16-byte random salt, compared with `timingSafeEqual` (`apps/api/src/auth.ts:289-296`). Registration is open by default (`ALLOW_REGISTRATION`, default `1`).
- **Stellar wallet signature** — a server-issued, single-use, expiring challenge is signed by the user's keypair; only the public key is ever stored (`apps/api/src/auth.ts`, `/auth/stellar/challenge` + `/auth/stellar/verify`). See ADR-019.
- **Google OAuth authorization-code flow** — server-side code exchange at `https://oauth2.googleapis.com/token`, `id_token` verified against Google's JWKS for issuer, audience (`clientId`), and nonce (`apps/api/src/auth.ts:686-698`). The `client_secret` never leaves the server.

Machine clients are unchanged: `API_KEYS` maps a bearer secret to exactly one server-configured `ownerId` (`docs/security-model.md`, "API Authentication"). The two paths are ordered, not merged — the session principal takes precedence and the bearer provider is the fallback, never the reverse (`apps/api/src/auth.ts:8-11`, resolution at `apps/api/src/index.ts:164-172`).

**Consequences:** A human session and a machine key are never interchangeable credentials. Adding a fourth provider means adding a branch that produces the same session record, not a new session model. Email registration being open is a deliberate bootstrap choice for a testnet MVP with no invite system; the documented upgrade path is `allowRegistration=false` plus a seeded admin (`apps/api/src/auth.ts:25-26`).

## ADR-019: Stellar challenge binds purpose, account, domain, id, time, and nonce

**Status:** Accepted

**Context:** A wallet signature alone proves "the holder of this key signed these bytes". Without binding, a signature captured for one purpose could be replayed for another, on a lookalike site, or indefinitely. The login flow needs the signature to be valid for exactly one authentication attempt on exactly this service.

**Decision:** The challenge message is a fixed multi-line string built by `buildStellarChallengeMessage()` (`apps/api/src/auth.ts:300-317`) binding seven fields: a purpose line ("4evergent authentication challenge"), the `account` public key, the `domain` (`STELLAR_DOMAIN`, default derived from `WEB_ORIGIN`'s hostname), the server-generated `challenge` id, `issued` and `expires` timestamps, and a server `nonce`. The challenge is stored server-side with its expiry and consumed on use: `/auth/stellar/verify` rejects a challenge that is unknown, already used, expired, or bound to a different public key (`apps/api/src/auth.ts:576-578`), and marks it used even on success (`apps/api/src/auth.ts:624`). Signature verification accepts both raw ed25519 over the message and the SEP-53 `sha256("Stellar Signed Message:\n" + message)` digest form that Freighter produces (`apps/api/src/auth.ts:600-615`).

**Consequences:** A signature is replayable only within its own challenge window, for its own account, on its own domain — cross-service and cross-site replay fail on the domain binding. The `domain` string is the anti-phishing anchor: it must match the service the user believes they are using, which is why it is configuration (`STELLAR_DOMAIN`) and not a hardcoded hostname. Challenge state is in-memory, so the single-use guarantee is per-process — see ADR-020.

## ADR-020: OAuth and challenge state is in-memory, so the API is single-process

**Status:** Accepted

**Context:** The OAuth `state`/`nonce` pair and the pending Stellar challenges must be readable by whichever process handles the callback. A shared store (Redis, SQLite) would allow horizontal scaling but adds an external dependency to a deployment that currently runs one API process against a local SQLite file.

**Decision:** Pending OAuth states and Stellar challenges live in process-local `Map`s (`apps/api/src/auth.ts:352-355`). OAuth state expires after 10 minutes (`apps/api/src/auth.ts:646`); challenges expire per their own TTL. Both are deleted on first use regardless of outcome (`apps/api/src/auth.ts:667`, `:624`). Session records, by contrast, are persisted to the `auth_sessions` SQLite table when `DATABASE_PATH` is set, with an in-memory fallback when it is not (`apps/api/src/auth.ts:180-193`).

**Consequences:** Running more than one API instance behind a load balancer breaks login: a callback or challenge verification can land on a process that never saw the state, and the single-use guarantee does not hold across processes. This is stated as a real limitation, not hidden — horizontal scaling requires moving this state to a shared store first. Sessions themselves survive a restart when SQLite is configured, and expired sessions are swept by the retention worker (ADR-014) via `sweepExpiredSessions()` (`apps/api/src/auth.ts:774`).

## ADR-021: In-memory rate limiting for the credential endpoints

**Status:** Accepted

**Context:** The credential-taking endpoints (`/auth/login/email`, `/auth/register`, `/auth/stellar/challenge`, `/auth/stellar/verify`) are handled before the API-key gate and had no counter, cooldown, or per-source tracking, so passwords could be guessed without bound. The module's state is already in-memory (`UserStore`/`SessionStore` fall back to `Map`s, pending OAuth states and Stellar challenges live in `Map`s), the deployment is a single stateful Node process, and adding a runtime dependency is out of scope.

**Decision:** Add a dependency-free sliding-window limiter (`apps/api/src/rate-limit.ts`) applied per credential endpoint. It is keyed by client IP (`req.socket.remoteAddress`, or the first `X-Forwarded-For` hop when `AUTH_TRUST_PROXY=1` is explicitly set), bounded in memory (window-pruned timestamps, per-key history capped at the limit, key map capped at `AUTH_RATE_LIMIT_MAX_KEYS` with oldest-first eviction), and safe to reset (a successful email sign-in within budget clears the source counter). Over-limit requests get `429 { error: "rate_limited" }` with a `Retry-After` header, distinct from `401 invalid_credentials`. Limits and window are env-configurable (`AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_SECONDS`) with conservative defaults of 10 attempts / 60s.

When `AUTH_TRUST_PROXY=1` is enabled, the trusted reverse proxy MUST be configured to overwrite or safely sanitize client-supplied forwarding headers so that an attacker cannot prepend a forged IP. Furthermore, rate limiting checks occur prior to credential verification; once a source hits the 429 threshold, subsequent requests are shed early to protect server CPU from scrypt exhaustion until the sliding window slides past.

**Consequences:**
- Brute-force / credential-stuffing attempts are slowed and a client can distinguish "slow down" from "wrong password".
- No new runtime dependency; no schema or persistence change.
- **Locality constraint:** state is per-process and in-memory, so it is not shared across instances and resets on restart. Horizontally scaled deployments get `max × processes` effective rate; a shared store is a separate, larger change.
- IP-keyed limits share a bucket behind NAT/proxies and can be evaded by rotating source addresses; CAPTCHA/MFA/account lockout remain out of scope.
- Shedding over-limit requests before scrypt prevents CPU DoS, but means locked-out sources cannot reset until the window expires.
- The existing `401 invalid_credentials` response and user-enumeration defence are unchanged.

## ADR-022: Interrupted Schedule Run Detection & Crash Recovery

**Status:** Accepted

**Context:** The scheduler executes value-moving agent work on recurring cron-like expressions. If a process terminates mid-execution while `executeCallback` is in flight (before `lastRunAt` and `nextRunAt` are updated), the schedule record on disk remains with its old `nextRunAt`. Upon restart, the scheduler treats the occurrence as never executed and runs it a second time, risking a double spend.

**Decision:**
- Record an in-progress marker (`lastStartedAt`) in `ScheduleRecord` before invoking the callback.
- On successful completion: write `lastRunAt`, advance `nextRunAt`, and clear `lastStartedAt: null` in a single store update.
- On callback failure: write `lastRunAt`, clear `lastStartedAt: null`, and rethrow (preserving the existing failure path).
- On server restart: run `ScheduleRecoveryService` before the scheduler starts ticking. The service scans for interrupted schedules (`lastStartedAt IS NOT NULL`), sets `lastRunAt` to `lastStartedAt`, advances `nextRunAt` to the next future occurrence (or pauses if the expression cannot advance), and clears `lastStartedAt: null` atomically via compare-and-swap (`updateIfLastStartedAt`).
- Bounded recovery: recovery scans in batches and paginates through all interrupted schedules, ensuring systems with >50 interrupted records are completely reconciled.
- Strict startup dependency: if recovery fails or encounters record errors, the scheduler is not started, preventing inadvertent retriggering.
- Transaction-submission recovery semantics: a process crash does not establish whether an in-flight transaction was accepted by the Stellar network. Recovery does NOT assume the transaction failed (re-running it could cause a duplicate transaction / double spend), nor does it assume successful on-chain finality. Instead, recovery treats the schedule occurrence as reconciled without re-triggering, advancing `nextRunAt` to the next interval. On-chain transaction status reconciliation is handled independently by the `TransactionStatusReconciler` / execution store pipeline.
- Defend in-depth: `AgentScheduler.runDue` skips schedules with `lastStartedAt` set, preventing concurrent or repeated execution of in-flight occurrences.

**Consequences:**
- Interrupted schedule runs are safely detected and reconciled on restart without double execution or duplicate transactions.
- Normally completed or callback-failed schedules clear the marker immediately, ensuring no false positives that would skip legitimate future occurrences.
- State transitions are atomic and concurrency-safe via `updateIfLastStartedAt` CAS across both in-memory and SQLite stores.
- Bounded recovery guarantees all interrupted records are reconciled across multiple pages.
- The scheduler never starts if recovery fails or has unrecovered records.
- Transaction finality is not conflated with process crash recovery.
