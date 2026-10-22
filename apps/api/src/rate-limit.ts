/**
 * Dependency-free, in-memory sliding-window rate limiter.
 *
 * Scope: the browser credential endpoints in `auth.ts` (email login/register,
 * Stellar challenge/verify). It is a small helper, not a general gateway
 * limiter — the API is a single stateful Node process and the auth module's
 * state is already in-memory (see `apps/api/src/auth.ts`).
 *
 * Memory bounding:
 *   - Per key, only timestamps inside the active window are retained, and the
 *     per-key history is capped at `maxAttempts` (older hits cannot change a
 *     decision).
 *   - The key map is capped at `maxKeys`; expired keys are pruned and, if the
 *     cap is still exceeded, the oldest-inserted keys are evicted.
 *
 * Proxy Trust Boundary & Security Contract:
 *   When `trustProxy` (AUTH_TRUST_PROXY=1) is enabled, `clientKey()` uses the
 *   client IP from the `X-Forwarded-For` header. The upstream reverse proxy
 *   (e.g., Nginx, Caddy, AWS ALB, Cloudflare) MUST be configured to overwrite
 *   or safely sanitize client-supplied forwarding headers (e.g. Nginx
 *   `proxy_set_header X-Forwarded-For $remote_addr;`). If an upstream proxy
 *   merely appends to an existing untrusted header without sanitization, an
 *   attacker can inject a forged leading IP into `X-Forwarded-For` to bypass
 *   per-IP rate limiting.
 */

import { isIP } from "node:net";

export interface RateLimitConfig {
  /** Attempts allowed per window, per key. */
  maxAttempts: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Hard cap on tracked keys; oldest keys are evicted past this. */
  maxKeys: number;
}

export interface RateLimitDecision {
  limited: boolean;
  /** Whole seconds a client should wait before retrying (>= 1 when limited). */
  retryAfterSeconds: number;
}

function positiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private lastSweep = 0;

  constructor(config: RateLimitConfig) {
    this.maxAttempts = positiveInt(config.maxAttempts, 1);
    this.windowMs = positiveInt(config.windowMs, 1);
    this.maxKeys = positiveInt(config.maxKeys, 1);
  }

  private pruneKey(key: string, cutoff: number): number[] {
    const times = this.hits.get(key);
    if (!times) return [];
    const active = times.filter((t) => t > cutoff);
    if (active.length === 0) this.hits.delete(key);
    else if (active.length !== times.length) this.hits.set(key, active);
    return active;
  }

  /** Inspect a key without recording an attempt (aside from expiry pruning). */
  check(key: string, now = Date.now()): RateLimitDecision {
    const active = this.pruneKey(key, now - this.windowMs);
    if (active.length < this.maxAttempts) return { limited: false, retryAfterSeconds: 0 };
    const oldest = active[0] ?? now;
    const retryAfterMs = oldest + this.windowMs - now;
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  /** Record one attempt for `key`. */
  record(key: string, now = Date.now()): void {
    const active = this.pruneKey(key, now - this.windowMs);
    active.push(now);
    if (active.length > this.maxAttempts) active.splice(0, active.length - this.maxAttempts);
    this.hits.set(key, active);
    // Amortized global sweep: at most once per window, plus whenever the key
    // cap is exceeded. Keeps the map bounded without an O(keys) sweep per call.
    if (this.hits.size > this.maxKeys || now - this.lastSweep >= this.windowMs) {
      this.evict(now);
      this.lastSweep = now;
    }
  }

  /** Clear a key's counter (e.g. after a successful sign-in). */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Number of tracked keys — for tests and diagnostics. */
  get size(): number {
    return this.hits.size;
  }

  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    for (const key of [...this.hits.keys()]) this.pruneKey(key, cutoff);
    if (this.hits.size <= this.maxKeys) return;
    let excess = this.hits.size - this.maxKeys;
    for (const key of this.hits.keys()) {
      this.hits.delete(key);
      if (--excess <= 0) break;
    }
  }
}

/**
 * Derive a rate-limit key for a request.
 *
 * Default: the TCP peer address (`req.socket.remoteAddress`).
 *
 * When `trustProxy` is true (via `AUTH_TRUST_PROXY=1`), the client IP is
 * extracted from the `X-Forwarded-For` header.
 *
 * Security Requirement for Reverse Proxies:
 * The trusted reverse proxy MUST overwrite or safely sanitize client-supplied
 * `X-Forwarded-For` headers before forwarding. If a proxy merely appends to an
 * incoming untrusted header, an attacker can prepend an arbitrary IP to evade
 * rate limits.
 *
 * To enforce basic hygiene, the extracted hop must be a valid IPv4 or IPv6
 * address; non-IP tokens or malformed strings fall back to the TCP socket
 * address to avoid spoofed keys or injection attacks. Absent both, the request
 * shares an `"unknown"` bucket.
 */
export function clientKey(
  req: {
    socket?: { remoteAddress?: string };
    headers?: Record<string, string | string[] | undefined>;
  },
  trustProxy = false
): string {
  if (trustProxy) {
    const raw = req.headers?.["x-forwarded-for"];
    const first = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim();
    if (first && isIP(first) !== 0) return first;
  }
  const peer = req.socket?.remoteAddress;
  return peer ?? "unknown";
}
