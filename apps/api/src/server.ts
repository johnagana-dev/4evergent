#!/usr/bin/env node
/**
 * 4evergent API server entry point.
 *
 * Usage:
 *   node apps/api/dist/server.js
 *
 * Environment:
 *   STELLAR_TESTNET_SECRET_KEY  — Testnet secret key (required for signing)
 *   STELLAR_HORIZON_URL         — Horizon URL (default: https://horizon-testnet.stellar.org)
 *   PORT                        — Server port (default: 3000)
 *   HOST                        — Bind host (default: 127.0.0.1; set 0.0.0.0 in a container)
 *   DATABASE_PATH               — SQLite file path (optional, in-memory if unset)
 *   DEV_OWNER_ID                — Development owner identity (default: "operator")
 *   RECONCILIATION_INTERVAL_MS  — Reconciliation worker interval in ms (default: 30000)
 *   EXECUTION_QUEUE_INTERVAL_MS — Execution queue worker interval in ms (default: 10000)
 *   SCHEDULER_INTERVAL_MS       — Scheduler poll interval in ms (default: 60000)
 *
 * LIVE_SUBMIT must be explicitly set to "1" to enable real Testnet submission.
 *
 * AUTH MODE:
 *   Production:
 *     Set API_KEYS to enable production auth.
 *     Format: API_KEYS=key1:owner1:subject1,key2:owner2:subject2
 *     ProductionApiKeyAuthProvider validates Bearer tokens against configured keys.
 *
 *   Development:
 *     Loopback binds (127.0.0.1/::1) automatically use DevAuthProvider.
 *     A non-loopback bind WITHOUT API_KEYS is refused at startup unless
 *     ALLOW_DEV_AUTH=1 is explicitly set — the API never serves unauthenticated
 *     traffic on a public interface by accident.
 */

import { createApiServer } from "./index.js";
import { TestnetLocalSigner, TESTNET_HORIZON_URL } from "@4evergent/stellar";
import { DevAuthProvider, ProductionApiKeyAuthProvider } from "@4evergent/shared";
import { createAuthModule } from "./auth.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

function parseRetentionDays(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseRetentionInterval(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Parse an optional positive-integer env var; undefined when unset/invalid. */
function envPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : undefined;
}

/**
 * Parse a worker interval env var. Unset or empty means "use the worker's
 * built-in default" (returns undefined). Anything else must be a finite number
 * greater than zero; otherwise this throws so startup fails fast with a clear
 * message instead of silently falling back to the default.
 */
export function parseIntervalEnv(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ${name}: expected a positive number of milliseconds, got '${value}'.`
    );
  }
  return parsed;
}

export interface WorkerIntervals {
  reconciliationIntervalMs: number | undefined;
  executionQueueIntervalMs: number | undefined;
  schedulerIntervalMs: number | undefined;
}

/** Read and validate all worker interval env vars. Throws on the first invalid value. */
export function readWorkerIntervals(env: NodeJS.ProcessEnv): WorkerIntervals {
  return {
    reconciliationIntervalMs: parseIntervalEnv("RECONCILIATION_INTERVAL_MS", env.RECONCILIATION_INTERVAL_MS),
    executionQueueIntervalMs: parseIntervalEnv("EXECUTION_QUEUE_INTERVAL_MS", env.EXECUTION_QUEUE_INTERVAL_MS),
    schedulerIntervalMs: parseIntervalEnv("SCHEDULER_INTERVAL_MS", env.SCHEDULER_INTERVAL_MS),
  };
}

function parseApiKeys(envVar: string | undefined): Record<string, { ownerId: string; subject: string }> {
  if (!envVar) return {};
  const keys: Record<string, { ownerId: string; subject: string }> = {};
  const entries = envVar.split(",").map((e) => e.trim()).filter(Boolean);

  for (const entry of entries) {
    const parts = entry.split(":");
    if (parts.length < 2) {
      console.error(`FATAL: Invalid API_KEYS format. Expected key:ownerId[:subject], got: ${entry}`);
      process.exit(1);
    }
    const [key, ownerId, subject] = parts;
    if (!key || !ownerId) {
      console.error(`FATAL: API key and ownerId are required. Got: ${entry}`);
      process.exit(1);
    }
    keys[key] = { ownerId, subject: subject || `key:${key.slice(0, 8)}` };
  }

  return keys;
}

/** Loopback addresses that keep development ergonomics (no API_KEYS needed). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export type AuthModeDecision =
  | { mode: "production"; reason: string }
  | { mode: "development"; reason: string; devOptIn: boolean }
  | { mode: "refuse"; reason: string };

/**
 * Pure auth-mode selection used at startup. Kept exported and side-effect free
 * so the fail-closed rule is directly testable.
 *
 * Rules:
 * 1. API_KEYS present  -> production auth (unchanged behavior, precedence over
 *    any dev opt-in flag).
 * 2. Loopback bind     -> development auth (preserves local ergonomics).
 * 3. Public bind + no API_KEYS + ALLOW_DEV_AUTH=1 -> development auth, explicit opt-in.
 * 4. Public bind + no API_KEYS -> refuse startup (fail closed).
 */
export function decideAuthMode(input: {
  host: string;
  hasApiKeys: boolean;
  allowDevAuth: boolean;
}): AuthModeDecision {
  const isLoopback = LOOPBACK_HOSTS.has(input.host);
  if (input.hasApiKeys) {
    return { mode: "production", reason: "API_KEYS configured" };
  }
  if (isLoopback) {
    return { mode: "development", reason: "loopback bind, API_KEYS unset", devOptIn: false };
  }
  if (input.allowDevAuth) {
    return { mode: "development", reason: "ALLOW_DEV_AUTH=1 explicitly set", devOptIn: true };
  }
  return {
    mode: "refuse",
    reason:
      `refusing to start: bind host '${input.host}' is not loopback and API_KEYS is unset. ` +
      "Set API_KEYS for production authentication, bind to 127.0.0.1, or explicitly set ALLOW_DEV_AUTH=1.",
  };
}

async function main() {
  const horizonUrl = process.env.STELLAR_HORIZON_URL || TESTNET_HORIZON_URL;
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  const dbPath = process.env.DATABASE_PATH || undefined;
  const devOwnerId = process.env.DEV_OWNER_ID || "operator";

  let workerIntervals: WorkerIntervals;
  try {
    workerIntervals = readWorkerIntervals(process.env);
  } catch (err: any) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }

  // Validate network configuration at startup
  if (!horizonUrl.includes("testnet")) {
    console.error(
      `FATAL: STELLAR_HORIZON_URL must point to Testnet (got: ${horizonUrl}). Mainnet execution is not supported.`
    );
    process.exit(1);
  }

  let signer;
  try {
    signer = new TestnetLocalSigner(TESTNET_PASSPHRASE);
  } catch (err: any) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }

  // Phase 28T + production safety: auth provider selection fails closed when a
  // public bind would otherwise fall through to DevAuthProvider.
  const apiKeys = parseApiKeys(process.env.API_KEYS);
  const decision = decideAuthMode({
    host,
    hasApiKeys: Object.keys(apiKeys).length > 0,
    allowDevAuth: process.env.ALLOW_DEV_AUTH === "1",
  });

  if (decision.mode === "refuse") {
    console.error(`FATAL: ${decision.reason}`);
    process.exit(1);
  }

  const authProvider =
    decision.mode === "production"
      ? new ProductionApiKeyAuthProvider({ apiKeys })
      : new DevAuthProvider({ defaultOwnerId: devOwnerId });

  // Phase 28U: USER authentication module (browser sessions). The bearer
  // provider above stays as the machine/API-key fallback.
  const webOrigin = process.env.WEB_ORIGIN || "http://localhost:5173";
  const authModule = createAuthModule({
    dbPath,
    fallbackProvider: authProvider,
    config: {
      webOrigin,
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        redirectUri: process.env.GOOGLE_REDIRECT_URI,
      },
      sessionTtlSeconds: process.env.SESSION_TTL_SECONDS
        ? Number(process.env.SESSION_TTL_SECONDS)
        : undefined,
      cookieSecure:
        process.env.COOKIE_SECURE === "1" ? true
        : process.env.COOKIE_SECURE === "0" ? false
        : undefined,
      cookieSameSite:
        process.env.COOKIE_SAMESITE === "none" ? "none"
        : process.env.COOKIE_SAMESITE === "strict" ? "strict"
        : "lax",
      stellarDomain: process.env.STELLAR_DOMAIN || new URL(webOrigin).hostname,
      allowRegistration: process.env.ALLOW_REGISTRATION === "0" ? false : true,
      rateLimit: {
        maxAttempts: envPositiveInt(process.env.AUTH_RATE_LIMIT_MAX),
        windowSeconds: envPositiveInt(process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS),
        maxKeys: envPositiveInt(process.env.AUTH_RATE_LIMIT_MAX_KEYS),
        trustProxy: process.env.AUTH_TRUST_PROXY === "1",
      },
    },
  });

  if (decision.mode === "production") {
    console.log(`[4evergent] Auth: production (${Object.keys(apiKeys).length} API key(s) configured)`);
  } else {
    console.log(
      `[4evergent] Auth: development (ownerId: ${devOwnerId})` +
        (decision.devOptIn ? " [ALLOW_DEV_AUTH=1 — public bind without API_KEYS]" : "")
    );
  }

  console.log(`[4evergent] Starting API server on ${host}:${port}`);
  console.log(`[4evergent] Horizon: ${horizonUrl}`);
  console.log(`[4evergent] Network: Testnet`);
  console.log(`[4evergent] Signer: ${signer.getAccountId().slice(0, 12)}...`);
  console.log(`[4evergent] Database: ${dbPath ?? "in-memory"}`);
  console.log(`[4evergent] Live submission: ${process.env.LIVE_SUBMIT === "1" ? "ENABLED" : "disabled"}`);

  try {
    const server = await createApiServer({
      port,
      horizonUrl,
      signer,
      dbPath,
      scheduler: {
        enabled: process.env.SCHEDULER_ENABLED === "1",
        intervalMs: workerIntervals.schedulerIntervalMs,
        maxLatenessMs: Number.isFinite(Number(process.env.SCHEDULER_MAX_LATENESS_MS)) && Number(process.env.SCHEDULER_MAX_LATENESS_MS) >= 0
          ? Number(process.env.SCHEDULER_MAX_LATENESS_MS)
          : 5 * 60_000,
      },
      retention: {
        enabled: process.env.DATA_RETENTION_ENABLED !== "0",
        intervalMs: parseRetentionInterval(process.env.DATA_RETENTION_INTERVAL_MS, 24 * 60 * 60_000),
        authSessionDays: parseRetentionDays(process.env.AUTH_SESSION_RETENTION_DAYS, 30),
        dailySpendingDays: parseRetentionDays(process.env.DAILY_SPENDING_RETENTION_DAYS, 90),
      },
      executionQueue: { enabled: true, intervalMs: workerIntervals.executionQueueIntervalMs },
      reconciliation: { enabled: true, intervalMs: workerIntervals.reconciliationIntervalMs },
      authProvider,
      authModule,
      corsOrigin: webOrigin,
    });

    await server.listen(port, host);
    console.log(`[4evergent] Server listening on http://${host}:${port}`);
  } catch (err: any) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }
}

// Only run main() when executed directly — importing decideAuthMode (tests)
// must not start a server or call process.exit().
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectRun) {
  void main();
}
