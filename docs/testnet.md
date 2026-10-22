# Testnet Setup Guide

## Prerequisites

- **Node.js >= 22** (required for `node:sqlite` built-in module)
- **pnpm >= 9** (workspace package manager)
- Rust toolchain (for Soroban contracts, Phase 3+)

## Full Testnet Execution Workflow

### 1. Install dependencies

```bash
pnpm install --frozen-lockfile
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your testnet credentials
```

The API server loads `.env` from the repository root automatically
(`node --env-file-if-exists`) when started via `pnpm --filter @4evergent/api start`
or `pnpm --filter @4evergent/api dev`. Real environment variables always take
precedence over `.env` values. `.env` is gitignored — never commit it.

Note: the live smoke test and direct `node` invocations do NOT load `.env`;
export variables in your shell for those (`export STELLAR_TESTNET_SECRET_KEY=...`).

### 3. Verify Horizon Testnet connectivity

```bash
# Run live smoke test (no secrets required, only reads Horizon root)
npx tsx packages/stellar/test/live-smoke.ts
```

This verifies:
- Horizon endpoint is reachable
- Network passphrase matches Testnet
- StellarSimulator can call real Horizon API (simulation gate works)

### 4. Configure Testnet account

```bash
# Generate a testnet keypair
node -e "const {Keypair}=require('@stellar/stellar-sdk'); const k=Keypair.random(); console.log('Public:', k.publicKey()); console.log('Secret:', k.secret());"

# Fund the account via friendbot
curl "https://friendbot.stellar.org?addr=<YOUR_PUBLIC_KEY>"

# Set environment
export STELLAR_TESTNET_SECRET_KEY=<YOUR_SECRET_KEY>
```

### 5. Verify account funding

```bash
node -e "
const {StellarAdapter} = require('./packages/agent-core/dist/index.js');
const a = new StellarAdapter('https://horizon-testnet.stellar.org');
a.getAccount('<YOUR_PUBLIC_KEY>').then(acc => {
  console.log('Address:', acc.address);
  console.log('Sequence:', acc.sequence);
  console.log('Balances:', acc.balances);
});
"
```

### 6. Run tests (deterministic, no secrets required)

```bash
pnpm test  # 290 tests PASS
```

### 7. Run simulation (no submission)

```bash
# Start API server (without LIVE_SUBMIT)
pnpm --filter @4evergent/api start

# Submit intent for simulation/approval
curl -X POST http://localhost:3000/agents/<agent-id>/intents \
  -H "Content-Type: application/json" \
  -d '{"type":"payment","asset":"XLM","destination":"G...","amount":"0.001","reason":"test"}'
```

Intent will be simulated against real Testnet Horizon. If policy allows and no approval required, it will be submitted ONLY if `LIVE_SUBMIT=1`.

### 8. Enable live submission (explicit)

```bash
# Stop server, restart with LIVE_SUBMIT=1
LIVE_SUBMIT=1 pnpm --filter @4evergent/api start
```

### 9. Execute Testnet transaction

With `LIVE_SUBMIT=1`, intents that pass policy + simulation + approval will be signed and submitted to Testnet.

### 10. Verify transaction status

```bash
curl http://localhost:3000/agents/<agent-id>/executions
```

Or check on [Stellar Expert](https://stellar.expert/explorer/testnet) with your txHash.

## Live Smoke Test

```bash
# Without secrets — only verify network + simulation
npx tsx packages/stellar/test/live-smoke.ts
```

## Live End-to-End Test

Full live E2E validation (signing + submission + on-chain confirmation +
reconciliation). Runs against the real Stellar Testnet.

```bash
# OPT-IN GATES (both required):
#   - STELLAR_TESTNET_SECRET_KEY: funded TESTNET key (never committed)
#   - LIVE_SUBMIT=1: explicit live submission enable

# 1. Fund a testnet account (once):
#    node -e "const {Keypair}=require('@stellar/stellar-sdk'); const k=Keypair.random(); console.log(k.secret());" > /tmp/stellar-secret
#    curl "https://friendbot.stellar.org?addr=<PUBLIC_KEY_FROM_ABOVE>"

# 2. Run live E2E:
STELLAR_TESTNET_SECRET_KEY=$(cat /tmp/stellar-secret) LIVE_SUBMIT=1 \
  npx tsx packages/stellar/test/live-e2e.ts
```

Expected output (all 8 steps pass):
```
network: Test SDF Network ; September 2015
network_guard: testnet=accept, mainnet=reject
policy: allow
simulation: success
outcome: submitted
tx_hash: <64-hex>
submission: submitted
confirmation: confirmed in ledger <N>
reconciliation: submitted → confirmed
result: PASS
```

Without `STELLAR_TESTNET_SECRET_KEY` the script runs the network + simulation
preflight only and stops before signing. Without `LIVE_SUBMIT=1` it stops
before submission (simulation gate verified, no real transaction sent).

## Testnet Local Signer

`TestnetLocalSigner` (`packages/stellar/src/testnet-local-signer.ts`) is development infrastructure. It:
- Loads a secret key from `STELLAR_TESTNET_SECRET_KEY`
- Is testnet-only (the pipeline asserts the network passphrase matches)
- Never exposes the secret key through any method
- Never returns the secret key through the `Signer` interface
- Is never returned through API responses
- Is never logged

## Soroban Contract: agent-registry (deployed)

| Field | Value |
|---|---|
| Contract | `contracts/agent-registry` (crate `agent-registry`) |
| Network | **Stellar Testnet only** (`Test SDF Network ; September 2015`) |
| Contract ID | `CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7` |
| Deployed | 2026-09-28 (UTC) |
| Deployer | local CLI identity `deployer` (testnet key, never committed) |
| Built wasm | `contracts/target/wasm32-unknown-unknown/release/agent_registry.wasm`, 9,549 bytes optimized |
| Wasm hash | `83656ffddd08a22e1977b6cf129af4d6515be7e8494d843ded1aa1c0ef3f8445` |
| Explorer | https://stellar.expert/explorer/testnet/contract/CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7 |
| Stellar Lab | https://lab.stellar.org/r/testnet/contract/CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7 |
| Upload tx | https://stellar.expert/explorer/testnet/tx/baebfc6bddb46e406fd5cd6d202798983c733498fc9952ba1e14f141071a2d1c |
| Create tx | https://stellar.expert/explorer/testnet/tx/bd88d3b35cbd02eb00056d9169848093e7ade2d6f3f2e4069c00f09d7fa9247f |

`contracts/permissions` is **not deployed** on any network: it is excluded from
the contracts workspace, is not compiled or tested, and lacks authorization
checks. See `contracts/permissions/README.md`.

### Prerequisites

Pinned toolchain comes from `contracts/rust-toolchain.toml` (Rust 1.81.0 with the
`wasm32-unknown-unknown` target). Install the CLI if missing:

```bash
cargo install --locked stellar-cli
```

Verified with: `rustc --version`, `cargo --version`, `stellar --version`,
`rustup target list --installed`.

### Build

Always run cargo from `contracts/` so the pinned toolchain and `Cargo.lock` apply:

```bash
cd contracts
cargo test --locked
cargo +1.81.0 test --locked                     # 15 unit tests expected
stellar contract build                          # wasm artifact + optimized hash printed
```

Artifact: `contracts/target/wasm32-unknown-unknown/release/agent_registry.wasm`.

### Deploy (testnet)

Create and fund a throwaway testnet identity. The secret key stays in the local
CLI config (`~/.config/stellar/identity/`, mode `0600`) — never commit it, never
print it, and `.gitignore` already covers `.env*`:

```bash
stellar keys generate deployer --network testnet --fund
stellar keys address deployer                   # public key only
```

Deploy and give it a local alias:

```bash
cd contracts
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/agent_registry.wasm \
  --source deployer --network testnet --alias agent_registry
```

`--network testnet` is required and there is no mainnet path in this repo. The
command prints the contract ID; it also stores the ID under the alias in the
local CLI config.

### Verify

```bash
# read-only call (query returns null for an id that was never registered)
stellar contract invoke --id  --source deployer --network testnet --send=no \
  -- query --id not_registered

# write then read back
stellar contract invoke --id  --source deployer --network testnet \
  -- register --caller $(stellar keys address deployer) --id deploy_smoke \
    --display_name "Deploy Smoke" --stellar_address $(stellar keys address deployer) \
    --capabilities '["pay"]'
stellar contract invoke --id  --source deployer --network testnet --send=no \
  -- query --id deploy_smoke

# confirm the on-chain wasm matches the local build (sha256 == wasm hash above)
stellar contract fetch --id  --network testnet --out-file /tmp/fetched.wasm
sha256sum /tmp/fetched.wasm
```

Verified on 2026-09-28: `query` on an unknown id returned `null`; after
`register`, `query` returned the record with `"active": true`; the fetched wasm
sha256 equalled `83656ffddd08a22e1977b6cf129af4d6515be7e8494d843ded1aa1c0ef3f8445`.

### Worker intervals

The background workers poll on fixed intervals that can be tuned with environment variables (milliseconds, positive numbers only; an invalid value stops startup with a `FATAL` error):

| Variable | Worker | Default |
| --- | --- | --- |
| `RECONCILIATION_INTERVAL_MS` | Transaction status reconciliation | `30000` |
| `EXECUTION_QUEUE_INTERVAL_MS` | Execution queue | `10000` |
| `SCHEDULER_INTERVAL_MS` | Schedule polling | `60000` |

A faster reconciliation loop is handy for a testnet demo; a slower one reduces Horizon load. The startup log lines (`[reconciler] started, interval: ...`) show the effective value.

## Safety Guards (Phase 21)

- **Network validation**: Only Testnet URL + passphrase accepted. Mainnet explicitly rejected.
- **Live submission gate**: `LIVE_SUBMIT=1` required. Default = disabled.
- **Secret isolation**: Private key never in database, logs, API responses, error messages.
- **Atomic claim**: `updateIfStatus(queued→executing)` CAS prevents concurrent execution.
- **Idempotency**: `Idempotency-Key` header prevents duplicate financial execution.
- **Pre-check**: Horizon lookup before blind retry prevents duplicate submission.

## Known Limitations

- Only Stellar Testnet supported. Mainnet execution not supported.
- Exactly-once not guaranteed (Stellar classic limitation).
- Single-process architecture (no distributed workers).
- Production authentication not implemented.
- No live transaction has been executed by CI. All tests use deterministic mocks.

## Integrating with agent-registry from TypeScript

See [`soroban-integration.md`](soroban-integration.md) for a TypeScript consumer
guide: the Rust→TS type mapping for `AgentInfo` and the `Error` enum, the
four entry points with parameters and return shapes, the authorization model,
and a verified `query()` snippet against the deployed contract.

The CLI verification above (`stellar contract invoke -- query`) is the shell
equivalent of the SDK call documented there.
