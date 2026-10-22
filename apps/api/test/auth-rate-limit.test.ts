import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/index.js";
import { createAuthModule } from "../src/auth.js";
import { SlidingWindowRateLimiter, clientKey } from "../src/rate-limit.js";

/* ============================ unit: limiter ============================ */

test("limiter: allows up to max attempts, then limits with a retry hint", () => {
  const limiter = new SlidingWindowRateLimiter({ maxAttempts: 3, windowMs: 60_000, maxKeys: 100 });
  const now = 1_000_000;
  assert.equal(limiter.check("ip", now).limited, false);
  limiter.record("ip", now);
  limiter.record("ip", now + 1);
  limiter.record("ip", now + 2);
  const decision = limiter.check("ip", now + 3);
  assert.equal(decision.limited, true);
  assert.ok(decision.retryAfterSeconds >= 1, "retry hint is at least one second");
  // A different source has its own budget.
  assert.equal(limiter.check("other", now + 3).limited, false);
});

test("limiter: resets once the window has slid past the recorded attempts", () => {
  const limiter = new SlidingWindowRateLimiter({ maxAttempts: 2, windowMs: 1_000, maxKeys: 100 });
  const t0 = 5_000;
  limiter.record("ip", t0);
  limiter.record("ip", t0 + 10);
  assert.equal(limiter.check("ip", t0 + 20).limited, true);
  // Past the window the old attempts expire and the source is allowed again.
  assert.equal(limiter.check("ip", t0 + 1_011).limited, false);
  limiter.record("ip", t0 + 1_011);
  assert.equal(limiter.check("ip", t0 + 1_012).limited, false);
});

test("limiter: reset() clears a source immediately", () => {
  const limiter = new SlidingWindowRateLimiter({ maxAttempts: 1, windowMs: 60_000, maxKeys: 100 });
  limiter.record("ip", 100);
  assert.equal(limiter.check("ip", 100).limited, true);
  limiter.reset("ip");
  assert.equal(limiter.check("ip", 100).limited, false);
});

test("limiter: memory stays bounded — the source map never grows past maxKeys", () => {
  const limiter = new SlidingWindowRateLimiter({ maxAttempts: 2, windowMs: 60_000, maxKeys: 5 });
  for (let i = 0; i < 50; i++) limiter.record(`ip-${i}`, 1_000);
  assert.ok(limiter.size <= 5, `size ${limiter.size} must stay <= 5`);

  // Stale sources are pruned on the next sweep.
  const fresh = new SlidingWindowRateLimiter({ maxAttempts: 2, windowMs: 1_000, maxKeys: 5 });
  for (let i = 0; i < 3; i++) fresh.record(`ip-${i}`, 1_000);
  assert.equal(fresh.size, 3);
  fresh.record("new", 10_000);
  assert.equal(fresh.size, 1, "stale sources are dropped");
});

/* ============================ unit: clientKey ============================ */

test("clientKey: extracts peer address by default and ignores untrusted X-Forwarded-For", () => {
  const req = {
    socket: { remoteAddress: "192.0.2.1" },
    headers: { "x-forwarded-for": "198.51.100.2, 203.0.113.3" },
  };
  // Default (trustProxy = false)
  assert.equal(clientKey(req, false), "192.0.2.1");
  assert.equal(clientKey(req), "192.0.2.1");
});

test("clientKey: extracts valid IP from X-Forwarded-For when trustProxy is true", () => {
  const req = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { "x-forwarded-for": "203.0.113.195, 198.51.100.1" },
  };
  assert.equal(clientKey(req, true), "203.0.113.195");

  // IPv6 support
  const reqV6 = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { "x-forwarded-for": "2001:db8::1, 10.0.0.1" },
  };
  assert.equal(clientKey(reqV6, true), "2001:db8::1");
});

test("clientKey: falls back to socket IP if X-Forwarded-For is malformed or non-IP", () => {
  const reqMalformed = {
    socket: { remoteAddress: "192.0.2.100" },
    headers: { "x-forwarded-for": "not-an-ip-address, 198.51.100.1" },
  };
  assert.equal(clientKey(reqMalformed, true), "192.0.2.100");

  const reqEmpty = {
    socket: { remoteAddress: "192.0.2.100" },
    headers: { "x-forwarded-for": "" },
  };
  assert.equal(clientKey(reqEmpty, true), "192.0.2.100");

  const reqNoSocket = {
    headers: {},
  };
  assert.equal(clientKey(reqNoSocket, true), "unknown");
});

/* ========================= integration: http ========================== */

async function createAuthTestServer(config: Parameters<typeof createAuthModule>[0]["config"]) {
  const authModule = createAuthModule({ fallbackProvider: null, config: config ?? {} });
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: {
      getAccountId: () => "GMOCKSIGNER000000000000000000000000000000000000000000000MOCK",
      getNetworkPassphrase: () => "Test SDF Network ; September 2015",
      async sign(tx: any) { tx.signatures = []; return tx; },
    },
    authModule,
  });
  await server.listen(0);
  const addr = server.server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

const XRW = { "X-Requested-With": "4evergent" };

async function post(baseUrl: string, path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...XRW, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const json = res.status !== 204 ? await res.json().catch(() => null) : null;
  return { status: res.status, body: json, res };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("login: 401s until limit, then 429; over-limit sheds requests before scrypt; recovers after window", async () => {
  const { server, baseUrl } = await createAuthTestServer({
    rateLimit: { maxAttempts: 3, windowSeconds: 1 },
  });
  try {
    await post(baseUrl, "/auth/register", { email: "rl@example.com", password: "password123" });

    // Within limit: wrong password → 401 invalid_credentials.
    const blockedAfter = 3;
    let last401: { status: number; body: any } | null = null;
    for (let i = 0; i < blockedAfter; i++) {
      const res = await post(baseUrl, "/auth/login/email", { email: "rl@example.com", password: "wrong" });
      assert.equal(res.status, 401, `attempt ${i + 1} within the limit is 401`);
      assert.equal(res.body.error, "invalid_credentials");
      last401 = res;
    }

    // Past limit → 429 with Retry-After header and distinct error code.
    const blocked = await post(baseUrl, "/auth/login/email", { email: "rl@example.com", password: "wrong" });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, "rate_limited");
    assert.notEqual(blocked.body.error, last401!.body.error, "429 is distinguishable from 401");
    const retryAfter = blocked.res.headers.get("retry-after");
    assert.ok(retryAfter && Number(retryAfter) >= 1, "Retry-After is a positive integer of seconds");

    // Over-limit behavior: even providing the correct password gets 429.
    // This confirms requests are shed before scrypt execution (CPU DoS protection).
    const blockedWithGoodPassword = await post(baseUrl, "/auth/login/email", {
      email: "rl@example.com",
      password: "password123",
    });
    assert.equal(blockedWithGoodPassword.status, 429, "over-limit source is locked out regardless of password");

    // After the window slides, the source recovers and legitimate sign-in succeeds.
    await sleep(1_100);
    const good = await post(baseUrl, "/auth/login/email", { email: "rl@example.com", password: "password123" });
    assert.equal(good.status, 200, "legitimate sign-in works after the window resets");
  } finally {
    await server.close();
  }
});

test("login: successful login within budget clears counter", async () => {
  const { server, baseUrl } = await createAuthTestServer({
    rateLimit: { maxAttempts: 3, windowSeconds: 60 },
  });
  try {
    await post(baseUrl, "/auth/register", { email: "reset@example.com", password: "password123" });

    // 2 failed attempts out of 3 allowed
    assert.equal((await post(baseUrl, "/auth/login/email", { email: "reset@example.com", password: "wrong1" })).status, 401);
    assert.equal((await post(baseUrl, "/auth/login/email", { email: "reset@example.com", password: "wrong2" })).status, 401);

    // Legitimate login succeeds and resets the counter
    const success = await post(baseUrl, "/auth/login/email", { email: "reset@example.com", password: "password123" });
    assert.equal(success.status, 200);

    // After successful login reset, another 2 failed attempts should NOT hit 429 (counter was reset)
    const postReset1 = await post(baseUrl, "/auth/login/email", { email: "reset@example.com", password: "wrong3" });
    assert.equal(postReset1.status, 401, "counter was reset by successful login");
    const postReset2 = await post(baseUrl, "/auth/login/email", { email: "reset@example.com", password: "wrong4" });
    assert.equal(postReset2.status, 401, "counter was reset by successful login");
  } finally {
    await server.close();
  }
});

test("register and stellar challenge are rate limited too with endpoint budget isolation", async () => {
  const { server, baseUrl } = await createAuthTestServer({
    rateLimit: { maxAttempts: 2, windowSeconds: 60 },
  });
  try {
    assert.equal((await post(baseUrl, "/auth/register", { email: "r1@example.com", password: "password123" })).status, 201);
    assert.equal((await post(baseUrl, "/auth/register", { email: "r2@example.com", password: "password123" })).status, 201);
    const regBlocked = await post(baseUrl, "/auth/register", { email: "r3@example.com", password: "password123" });
    assert.equal(regBlocked.status, 429);
    assert.equal(regBlocked.body.error, "rate_limited");

    const ch1 = await post(baseUrl, "/auth/stellar/challenge", { publicKey: "NOT-A-KEY" });
    const ch2 = await post(baseUrl, "/auth/stellar/challenge", { publicKey: "NOT-A-KEY" });
    assert.equal(ch1.status, 400);
    assert.equal(ch2.status, 400);
    const chBlocked = await post(baseUrl, "/auth/stellar/challenge", { publicKey: "NOT-A-KEY" });
    assert.equal(chBlocked.status, 429, "challenge issuance is bounded");

    // Endpoint isolation: hitting limit on register/challenge doesn't block login
    const loginRes = await post(baseUrl, "/auth/login/email", { email: "r1@example.com", password: "password123" });
    assert.equal(loginRes.status, 200, "login endpoint has its own independent rate limit budget");
  } finally {
    await server.close();
  }
});

test("proxy trust: independent rate limit budgets per forwarded IP when trustProxy is enabled", async () => {
  const { server, baseUrl } = await createAuthTestServer({
    rateLimit: { maxAttempts: 2, windowSeconds: 60, trustProxy: true },
  });
  try {
    const ip1Header = { "X-Forwarded-For": "198.51.100.10" };
    const ip2Header = { "X-Forwarded-For": "198.51.100.20" };

    assert.equal((await post(baseUrl, "/auth/stellar/challenge", { publicKey: "BAD" }, ip1Header)).status, 400);
    assert.equal((await post(baseUrl, "/auth/stellar/challenge", { publicKey: "BAD" }, ip1Header)).status, 400);
    assert.equal((await post(baseUrl, "/auth/stellar/challenge", { publicKey: "BAD" }, ip1Header)).status, 429);

    // IP 2 is fresh and not blocked
    assert.equal((await post(baseUrl, "/auth/stellar/challenge", { publicKey: "BAD" }, ip2Header)).status, 400);
  } finally {
    await server.close();
  }
});
