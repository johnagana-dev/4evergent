# 4evergent

**4evergent** — Autonomous AI Agents on Stellar.

An open-source framework for deploying AI agents that hold permissioned Stellar wallets and execute on-chain actions through a deterministic authorization pipeline. The agent's LLM proposes *intents*, and an independent policy engine decides whether each intent is allowed, denied, or requires human approval.

> **Testnet-first.** No mainnet assumptions in the MVP. No project token. No speculative tokenomics.

---

## Table of Contents

1. [What 4evergent is](#what-4evergent-is)
2. [Why AI agents need permissioned blockchain actions](#why-ai-agents-need-permissioned-blockchain-actions)
3. [Why Stellar](#why-stellar)
4. [Architecture](#architecture)
5. [Security model](#security-model)
6. [Local development](#local-development)
7. [Testnet setup](#testnet-setup)
8. [Adding a new agent capability](#adding-a-new-agent-capability)
9. [Roadmap](#roadmap)
10. [HTTP API reference and OpenAPI document](docs/api.md#openapi-document)

---

## What 4evergent is

4evergent is a framework for running AI agents — software entities with an LLM-driven decision layer — that can act on the Stellar network. Each agent has a persistent identity, a Stellar address, and a set of declared capabilities.

The key invariant: **the LLM never holds unrestricted authority over a wallet.** The LLM produces a strongly typed intent. That intent flows through:

```
Agent → Intent → Schema validation → Policy evaluation
→ Stellar transaction construction → Simulation → Approval gate
→ Signing → Submission → Confirmation → Activity record
```

A deterministic policy engine — independent of the LLM — decides authorization. Transactions are simulated before signing. Spending limits, allowed assets, allowed contract IDs, and approval thresholds are explicit.

## Why AI agents need permissioned blockchain actions

An autonomous LLM with direct wallet access can be manipulated, jailbroken, or simply drift toward unintended behavior. Giving an LLM unrestricted signing authority is equivalent to handing a stranger your private key.

4evergent enforces a strict separation of concerns:
- **LLM layer**: produces natural-language intents translated into typed schema.
- **Policy layer**: deterministic rules evaluate every intent — no ML, no heuristics.
- **Execution layer**: simulation-first, with human-in-the-loop for high-value actions.

This lets agents act autonomously within a bounded envelope, while the owner retains control over spending, destination, and asset restrictions.

## Why Stellar

Stellar is purpose-built for asset issuance and payments with native low-fee, fast-finality design. Its architecture is ideal for an agent economy:

- **Native asset**: XLM settles any action without wrapping.
- **Federated consensus**: no proof-of-stake staking requirements.
- **Soroban smart contracts**: WASM-based, memory-safe, with native support for complex contracts.
- **Built-in token standard**: no Solidity-style approval race conditions for basic payments.
- **Low, predictable fees**: cents or less per operation.

## Architecture

```
4evergent/
├── apps/
│   ├── web/              # React + TS frontend (agent dashboard)
│   ├── api/              # Express-style backend API
│   └── cli/              # Operator CLI (HTTP client) — see [docs/cli.md](docs/cli.md)
├── packages/
│   ├── agent-core/      # Agent runtime, intent validation, Stellar adapter
│   ├── policy/           # Deterministic authorization engine
│   ├── stellar/          # Transaction construction + simulation + submission + reconciliation + network guard
│   ├── database/         # In-memory + SQLite stores (activity, approvals, agents, executions)
│   └── shared/           # Shared types & schemas
├── contracts/            # Rust workspace (own Cargo.lock, pinned toolchain)
│   ├── agent-registry/   # Soroban contract (agent identity on-chain) — deployed on Testnet
│   └── permissions/      # Soroban authorization primitives (experimental, not in workspace)
├── docs/
│   ├── architecture.md
│   ├── security-model.md
│   ├── capabilities.md
│   ├── roadmap.md
│   ├── testnet.md
│   └── cli.md
└── README.md
```

**MVP vertical slice** (verified, runnable):

```
Create Agent → Persist Agent → Display Agent → Read Stellar Account
→ Generate Payment Intent → Evaluate Policy → Simulate Transaction
→ Require Approval → Execute on Testnet → Record Activity
```

Everything outside this slice is marked as **Future Work** in source comments.

## Security model

See [docs/security-model.md](docs/security-model.md) for the full write-up.

Key guarantees:
- **No unrestricted wallet authority**: the LLM cannot sign or broadcast directly.
- **Policy engine is independent**: pure functions, no network or LLM calls.
- **Simulation before execution**: every transaction is simulated against the testnet before signing.
- **Explicit allowlists**: assets, destinations, contract IDs, and transaction types are deny-by-default.
- **Spending limits**: per-transaction and per-day ceilings per asset.
- **Approval thresholds**: amounts above a configurable limit require human approval.
- **Key management**: private keys never in source, env examples, logs, or tests.
- **Frontend/backend trust boundary**: the frontend never receives secret material; all signing happens server-side through a hardened path.
- **API authentication**: development mode auto-authenticates a single owner; production mode requires `Authorization: Bearer <key>` with keys configured server-side via `API_KEYS` (format `key:ownerId[:subject]`, comma-separated). See [docs/security-model.md](docs/security-model.md) — API Authentication.

## Local development

```bash
# clone
git clone https://github.com/naninu123/4evergent
cd 4evergent

# install (Node 22+, pnpm 10+, frozen lockfile for reproducible builds)
pnpm install --frozen-lockfile

# run the same checks as CI (build, lint, typecheck, then tests)
pnpm verify
```

`pnpm verify` runs the repository checks in CI order and stops at the first failure. Dependencies must be installed first.

### Prerequisites

- **Node.js >= 22** (required for `node:sqlite` built-in module)
- **pnpm >= 10** (workspace package manager; matches CI)

### Run the API server (Testnet)

```bash
# Option A: put STELLAR_TESTNET_SECRET_KEY in .env (loaded automatically)
cp .env.example .env   # then edit .env

# Option B: export it in your shell
export STELLAR_TESTNET_SECRET_KEY=S...  # your testnet secret key

# Build and start
pnpm build
pnpm --filter @4evergent/api start

# Or run directly
node apps/api/dist/server.js
```

The server starts on `http://localhost:3000`. See [docs/testnet.md](docs/testnet.md) for the full Testnet workflow including funding, simulation, and live submission (`LIVE_SUBMIT=1`).
For startup failures and connection troubleshooting, see [docs/troubleshooting.md](docs/troubleshooting.md).

### Watch the API server (edit → reload)

For development, run the API server from source with a file watcher so edits restart the server automatically — no manual rebuild/restart:

```bash
# one-time: build the workspace packages the API imports
pnpm build

# start the API server in watch mode (reloads on source changes)
pnpm --filter @4evergent/api dev
# or, from the repo root:
pnpm dev:watch
```

`pnpm --filter @4evergent/api dev` runs `tsx watch` against `apps/api/src/server.ts`, so the API restart is driven by source changes (equivalent to editing → rebuilding → restarting, but automatic). The script runs the API from source and therefore does **not** require `apps/api` to be built first, but the workspace packages it imports (`@4evergent/shared`, `@4evergent/agent-core`, `@4evergent/policy`, `@4evergent/stellar`, `@4evergent/database`) are resolved from their compiled `dist/` output — run `pnpm build` once first (or `pnpm dev`, which recompiles those packages in watch mode). Like `start`, the watch script loads `.env` from the repo root when present via `--env-file-if-exists`.

### Run the dashboard

```bash
# terminal 1: start the API server in watch mode (see above)
pnpm --filter @4evergent/api dev

# terminal 2: start the web dashboard
pnpm --filter @4evergent/web dev
```

The dashboard connects to `http://localhost:3000`. Set `VITE_API_BASE` env var to point to a different API URL. The dashboard is a local development tool — it provides read-only views of agents/activity/approvals and an XLM payment intent submission form. All policy enforcement, signing, and submission remain server-side.

Each package has its own `package.json` with `build`, `dev`, `test`, and `typecheck` scripts.

## Testnet setup

```bash
# The Stellar adapter defaults to testnet
export STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org

# Generate a testnet keypair (funded via friendbot):
#   curl "https://friendbot.stellar.org?addr=<PUBLIC_KEY>"
```

The MVP is validated against the testnet Horizon API. See [docs/testnet.md](docs/testnet.md) for details, and [docs/troubleshooting.md](docs/troubleshooting.md) for startup and connectivity issues.

## Adding a new agent capability

1. Add the new intent type to `packages/shared/src/types.ts` (extend the `AgentIntent` union).
2. Add validation logic to `IntentValidator` in `packages/agent-core/src/`.
3. Add a corresponding policy rule entry in `packages/policy/src/types.ts`.
4. Add the transaction builder in `packages/stellar/src/`.
5. Write unit + integration tests for steps 2–4.
6. Document the capability in `docs/capabilities.md`.

No capability is considered complete without: schema validation, policy coverage, intent test, and a negative policy-engine test.

## Agent Schedules

Agents can have persistent schedules that automatically execute typed intents on a cron-like expression. Schedules are owner-scoped and go through the same policy/approval pipeline as manual intents.

```bash
# Create a schedule
curl -X POST http://localhost:3000/agents/<agent-id>/schedules \
  -H "Content-Type: application/json" \
  -d '{
    "intent": { "type": "payment", "asset": "XLM", "destination": "G...", "amount": "10", "reason": "daily payout" },
    "scheduleExpression": "0 * * * *",
    "timezone": "UTC"
  }'

# List schedules
curl http://localhost:3000/agents/<agent-id>/schedules

# Pause/resume/disable
curl -X POST http://localhost:3000/agents/<agent-id>/schedules/<schedule-id>/pause
curl -X POST http://localhost:3000/agents/<agent-id>/schedules/<schedule-id>/resume
curl -X POST http://localhost:3000/agents/<agent-id>/schedules/<schedule-id>/disable
```

Schedules are stored in SQLite (when `dbPath` is configured) or in-memory. The scheduler polls every 60 seconds by default. Failed schedules do not stop the scheduler. The scheduler, execution queue and reconciliation worker intervals are configurable via `SCHEDULER_INTERVAL_MS`, `EXECUTION_QUEUE_INTERVAL_MS` (default 10s) and `RECONCILIATION_INTERVAL_MS` (default 30s); see [docs/testnet.md](docs/testnet.md#worker-intervals).

### Missed runs

The scheduler runs an occurrence that is due now or up to five minutes late. If a process restart leaves an occurrence more than five minutes overdue, it skips that occurrence, records the skip in the scheduler log, and advances to the next cron occurrence. If the expression is invalid or cannot produce a strictly future occurrence, the scheduler pauses it and logs why; correct the expression before resuming it. Multiple missed intervals never produce a catch-up burst. Set `SCHEDULER_MAX_LATENESS_MS` to change the grace period; the default is `300000` (five minutes). The server starts the scheduler only when `SCHEDULER_ENABLED=1`.

## Operator CLI

The `4evergent` CLI is an operator client that talks HTTP to the API server.
It does NOT sign, build, or submit Stellar transactions — all transaction
work stays server-side.

Install the published command with:

```bash
npm install --global @4evergent/cli
```

Configure `FOREGENT_API_URL` and, when using production authentication,
`FOREGENT_API_KEY` in the shell where you run the command. See
[the CLI guide](docs/cli.md) for configuration and available commands.

```bash
# Configure the API connection in the shell where you run the CLI
export FOREGENT_API_URL=http://localhost:3000
export FOREGENT_API_KEY=your-api-key

# Use the installed command
4evergent health
4evergent agent list
4evergent agent pause <id>
4evergent approval list
4evergent approval approve <id>
4evergent execution list
4evergent policy get <agent-id>
4evergent activity list <agent-id>
4evergent schedule list <agent-id>
4evergent intent submit <agent-id> <type> [args...]
4evergent completion <bash|zsh>
```

Shell completion for Bash and Zsh can be generated with `4evergent completion bash` or `4evergent completion zsh`; see [Shell completion](docs/cli.md#shell-completion) for installation instructions.

To run the source version from a repository checkout:

```bash
pnpm --filter @4evergent/cli build
npx tsx apps/cli/src/cli.ts health
```

See [docs/cli.md](docs/cli.md) for full command reference.

## Roadmap

| Phase | Goal | Status |
|-------|------|--------|
| 1 | Agent identity, policy engine, intent validation, Stellar read adapter, activity logging | ✅ Shipped |
| 2 | Full transaction pipeline (construct → simulate → authorize → sign → submit) with Signer abstraction | ✅ Shipped |
| 3 | Persistent SQLite stores, approval/reject HTTP endpoints, daily limit enforcement | ✅ Shipped |
| 4 | React web dashboard + read-only API | ✅ Shipped |
| 5 | Soroban AgentRegistry contract | ✅ Compiled, tested, deployed on Stellar Testnet |
| 6 | Soroban Permissions contract | Intentionally not deployed (needs its own DESIGN pass) |
| 7 | Multi-agent capability discovery & economy | Future |
| 8 | Agent scheduling & automation | ✅ Shipped |
| 9 | Persistent execution queue with retry & dead-letter | ✅ Shipped |
| 10 | Execution queue crash recovery | ✅ Shipped |
| 11 | Agent self-serve creation | ✅ Shipped |
| 12 | Trustline & non-XLM asset support | ✅ Shipped |
| 13-18 | Reliability hardening (atomic claim, idempotency, ambiguous submission, pre-check, docs) | ✅ Shipped |
| 19 | Operator CLI v1 (health, agent lifecycle, approval, execution) | ✅ Shipped |

---

## License

MIT. See [LICENSE](LICENSE).
