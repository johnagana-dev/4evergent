/**
 * USER AUTHENTICATION module (Phase 28U).
 *
 * Separate from API-KEY auth:
 *   - USER AUTH  = login/session for humans (Google OAuth, Stellar wallet
 *     signature, email+password). Browser sessions live in an HttpOnly
 *     SameSite cookie backed by a server-side session store. Logout deletes
 *     the server-side record — the session is really invalidated.
 *   - API-KEY AUTH (AuthProvider passed in via options, e.g.
 *     ProductionApiKeyAuthProvider / DevAuthProvider) remains for machine
 *     clients (CLI, service integrations). The session principal takes
 *     precedence; the bearer provider is the fallback, never the reverse.
 *
 * SECURITY NOTES
 * - No credentials, OAuth codes, tokens, or secrets are ever logged here.
 * - Passwords: scrypt (Node default N=16384/r=8/p=1, 64-byte key), per-user
 *   random salt, constant-time compare.
 * - Stellar: signature proves key ownership (ed25519 over a server-issued,
 *   single-use, expiring challenge). Public key only — never a secret.
 * - Google: server-side authorization-code flow. id_token verified against
 *   Google JWKS (iss + aud + nonce). client_secret never leaves the server.
 * - CSRF: cookie-authenticated state-changing requests must carry the
 *   X-Requested-With header (SameSite=Lax is the first layer; this is the
 *   second). Bearer/API-key requests are unaffected.
 * - ponytail: registration is open (this deployment model has no invite
 *   system). Upgrade path: allowRegistration=false + seeded admin.
 * - ponytail: pending OAuth states and Stellar challenges live in memory;
 *   fine for a single API process. Upgrade path: shared store when the API
 *   is horizontally scaled.
 */

import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { jwtVerify, createRemoteJWKSet } from "jose";
import type { AuthProvider, AuthenticatedPrincipal } from "@4evergent/shared";
import { SlidingWindowRateLimiter, clientKey } from "./rate-limit.js";

export const SESSION_COOKIE_NAME = "four_eg_session";

/** Conservative credential-endpoint rate limit: 10 attempts / 60s / source. */
export const DEFAULT_AUTH_RATE_LIMIT_MAX = 10;
export const DEFAULT_AUTH_RATE_LIMIT_WINDOW_SECONDS = 60;
export const DEFAULT_AUTH_RATE_LIMIT_MAX_KEYS = 10_000;

export type AuthMethod = "email" | "google" | "stellar";

export interface AuthModuleConfig {
  /** Where the browser app lives. Used for the post-OAuth redirect. */
  webOrigin?: string;
  /** Exact Google redirect_uri registered in the OAuth console. */
  google?: { clientId?: string; clientSecret?: string; redirectUri?: string };
  sessionTtlSeconds?: number;
  /** Force Secure cookie flag; default: auto-detect (https / x-forwarded-proto). */
  cookieSecure?: boolean;
  cookieSameSite?: "lax" | "strict" | "none";
  /** Domain string embedded in the Stellar auth challenge. */
  stellarDomain?: string;
  /** Open registration endpoint. Default true (bootstrap-friendly, testnet MVP). */
  allowRegistration?: boolean;
  /** Abuse protection for the credential endpoints (see rate-limit.ts). */
  rateLimit?: {
    /** Attempts allowed per window, per source. Default 10. */
    maxAttempts?: number;
    /** Window length in seconds. Default 60. */
    windowSeconds?: number;
    /** Hard cap on tracked sources. Default 10000. */
    maxKeys?: number;
    /** Trust the first X-Forwarded-For hop (only behind a proxy you control). */
    trustProxy?: boolean;
  };
}

export interface PrincipalResolution {
  principal: AuthenticatedPrincipal | null;
  /** "session" = browser user session cookie; "fallback" = bearer provider (API key / dev). */
  via: "session" | "fallback" | null;
  /** True when a session principal is present but the request failed the CSRF check. */
  csrfFail: boolean;
}

interface StoredUser {
  id: string;
  email: string | null;
  stellarPublicKey: string | null;
  displayName: string;
  subject: string;
  passwordHash: Buffer | null;
  passwordSalt: Buffer | null;
  createdAt: string;
}

interface SessionRecord {
  token: string;
  userId: string;
  subject: string;
  ownerId: string;
  method: AuthMethod;
  expiresAt: number;
}

/* ------------------------------------------------------------------ stores */

class UserStore {
  private byId = new Map<string, StoredUser>();
  private db: DatabaseSync | null;

  constructor(dbPath?: string) {
    if (dbPath) {
      this.db = new DatabaseSync(dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS auth_users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE,
          stellar_pub TEXT UNIQUE,
          display_name TEXT NOT NULL,
          subject TEXT NOT NULL UNIQUE,
          password_hash BLOB,
          password_salt BLOB,
          created_at TEXT NOT NULL
        );
      `);
    } else {
      this.db = null;
    }
  }

  private rowToUser(r: Record<string, unknown>): StoredUser {
    return {
      id: String(r.id),
      email: (r.email as string | null) ?? null,
      stellarPublicKey: (r.stellar_pub as string | null) ?? null,
      displayName: String(r.display_name),
      subject: String(r.subject),
      passwordHash: (r.password_hash as Buffer | null) ?? null,
      passwordSalt: (r.password_salt as Buffer | null) ?? null,
      createdAt: String(r.created_at),
    };
  }

  insert(user: StoredUser): void {
    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO auth_users (id, email, stellar_pub, display_name, subject, password_hash, password_salt, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          user.id,
          user.email,
          user.stellarPublicKey,
          user.displayName,
          user.subject,
          user.passwordHash,
          user.passwordSalt,
          user.createdAt
        );
    }
    this.byId.set(user.id, user);
  }

  private all(): StoredUser[] {
    if (this.db) {
      const rows = this.db.prepare("SELECT * FROM auth_users").all() as Record<string, unknown>[];
      return rows.map((r) => this.rowToUser(r));
    }
    return [...this.byId.values()];
  }

  findByEmail(email: string): StoredUser | null {
    return this.all().find((u) => u.email === email) ?? null;
  }

  findByStellarPublicKey(pub: string): StoredUser | null {
    return this.all().find((u) => u.stellarPublicKey === pub) ?? null;
  }

  findBySubject(subject: string): StoredUser | null {
    return this.all().find((u) => u.subject === subject) ?? null;
  }

  findById(id: string): StoredUser | null {
    if (this.byId.has(id)) return this.byId.get(id)!;
    const row = this.db?.prepare("SELECT * FROM auth_users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToUser(row) : null;
  }
}

class SessionStore {
  private map = new Map<string, SessionRecord>();
  private db: DatabaseSync | null;

  constructor(dbPath?: string) {
    if (dbPath) {
      this.db = new DatabaseSync(dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS auth_sessions (
          token TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          subject TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          method TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_exp ON auth_sessions(expires_at);
      `);
    } else {
      this.db = null;
    }
  }

  create(rec: SessionRecord): void {
    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO auth_sessions (token, user_id, subject, owner_id, method, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(rec.token, rec.userId, rec.subject, rec.ownerId, rec.method, rec.expiresAt);
    } else {
      this.map.set(rec.token, rec);
    }
  }

  get(token: string): SessionRecord | null {
    let rec: SessionRecord | null | undefined;
    if (this.db) {
      const row = this.db.prepare("SELECT * FROM auth_sessions WHERE token = ?").get(token) as Record<string, unknown> | undefined;
      rec = row
        ? {
            token: String(row.token),
            userId: String(row.user_id),
            subject: String(row.subject),
            ownerId: String(row.owner_id),
            method: String(row.method) as AuthMethod,
            expiresAt: Number(row.expires_at),
          }
        : null;
    } else {
      rec = this.map.get(token);
    }
    if (!rec) return null;
    if (rec.expiresAt <= Date.now()) {
      this.delete(token);
      return null;
    }
    return rec;
  }

  delete(token: string): void {
    if (this.db) this.db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
    else this.map.delete(token);
  }

  deleteExpiredBefore(cutoff: number, limit = 500): number {
    if (!Number.isFinite(cutoff) || !Number.isInteger(limit) || limit <= 0) return 0;
    if (this.db) {
      const result = this.db.prepare(`
        DELETE FROM auth_sessions
        WHERE token IN (
          SELECT token FROM auth_sessions WHERE expires_at <= ? ORDER BY expires_at ASC LIMIT ?
        )
      `).run(cutoff, limit);
      return Number(result.changes);
    }
    let removed = 0;
    for (const [token, session] of this.map) {
      if (session.expiresAt <= cutoff) {
        this.map.delete(token);
        removed++;
        if (removed >= limit) break;
      }
    }
    return removed;
  }
}

/* --------------------------------------------------------------- utilities */

function parseCookies(req: { headers: Record<string, string | string[] | undefined> }): Record<string, string> {
  const raw = req.headers["cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const out: Record<string, string> = {};
  if (!value) return out;
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq > -1) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function isStateChanging(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 64);
}

function verifyPassword(password: string, salt: Buffer, hash: Buffer): boolean {
  const candidate = hashPassword(password, salt);
  return candidate.length === hash.length && timingSafeEqual(candidate, hash);
}

/**
 * Stellar auth challenge message. The signed payload binds: purpose, account,
 * domain, challenge id, timestamps, and a server nonce — so a signature can
 * only ever authenticate THIS account on THIS service for ONE session.
 */
export function buildStellarChallengeMessage(input: {
  publicKey: string;
  domain: string;
  challengeId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}): string {
  return [
    "4evergent authentication challenge",
    `account: ${input.publicKey}`,
    `domain: ${input.domain}`,
    `challenge: ${input.challengeId}`,
    `issued: ${input.issuedAt}`,
    `expires: ${input.expiresAt}`,
    `nonce: ${input.nonce}`,
  ].join("\n");
}

/* -------------------------------------------------------------- main entry */

export interface AuthModule {
  /** Resolve the request principal: session cookie first, then the bearer fallback provider. */
  authenticate(
    req: { headers: Record<string, string | string[] | undefined> },
    method: string
  ): Promise<PrincipalResolution>;
  /** Handle /auth/* routes. Returns true when the request was handled. */
  handleRoutes(req: any, res: any, url: string, method: string): Promise<boolean>;
  /** Direct session lookup for /auth/me. */
  sessionFor(req: { headers: Record<string, string | string[] | undefined> }): SessionRecord | null;
  /** Remove up to `limit` sessions whose expiration is at/before cutoff. */
  sweepExpiredSessions(cutoff: number, limit?: number): number;
  configStatus(): { email: boolean; google: boolean; stellar: boolean; registration: boolean };
}

export function createAuthModule(opts: {
  config?: AuthModuleConfig;
  dbPath?: string;
  fallbackProvider: AuthProvider | null;
}): AuthModule {
  const cfg = opts.config ?? {};
  const users = new UserStore(opts.dbPath);
  const sessions = new SessionStore(opts.dbPath);
  const ttlS = Math.max(60, Math.min(cfg.sessionTtlSeconds ?? 86400, 30 * 86400));
  const webOrigin = (cfg.webOrigin ?? "http://localhost:5173").replace(/\/+$/, "");
  const stellarDomain = cfg.stellarDomain ?? "localhost";

  // Abuse protection for the credential endpoints. Keyed by source (client IP)
  // and scoped per endpoint, so one endpoint's legitimate traffic cannot lock
  // a source out of another. In-memory, matching the rest of this module.
  const rl = cfg.rateLimit ?? {};
  const rateLimitConfig = {
    maxAttempts: positiveNumber(rl.maxAttempts, DEFAULT_AUTH_RATE_LIMIT_MAX),
    windowMs: positiveNumber(rl.windowSeconds, DEFAULT_AUTH_RATE_LIMIT_WINDOW_SECONDS) * 1000,
    maxKeys: positiveNumber(rl.maxKeys, DEFAULT_AUTH_RATE_LIMIT_MAX_KEYS),
  };
  const trustProxy = rl.trustProxy === true;
  const loginLimiter = new SlidingWindowRateLimiter(rateLimitConfig);
  const registerLimiter = new SlidingWindowRateLimiter(rateLimitConfig);
  const challengeLimiter = new SlidingWindowRateLimiter(rateLimitConfig);
  const verifyLimiter = new SlidingWindowRateLimiter(rateLimitConfig);

  const googleConfigured = Boolean(cfg.google?.clientId && cfg.google?.clientSecret);
  const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

  // transient state: OAuth state/nonce and Stellar challenges (single process)
  const pendingStates = new Map<string, { nonce: string; expiresAt: number }>();
  const pendingChallenges = new Map<
    string,
    { publicKey: string; message: string; expiresAt: number; used: boolean }
  >();

  function cookieSecure(req: any): boolean {
    if (cfg.cookieSecure === true) return true;
    if (cfg.cookieSecure === false) return false;
    const xfp = req.headers?.["x-forwarded-proto"];
    if (typeof xfp === "string" && xfp.split(",")[0]?.trim() === "https") return true;
    return Boolean(req.socket?.encrypted);
  }

  function sessionCookie(token: string, maxAgeS: number, secure: boolean): string {
    const sameSite = cfg.cookieSameSite ?? "lax";
    const parts = [
      `${SESSION_COOKIE_NAME}=${token}`,
      "Path=/",
      "HttpOnly",
      `Max-Age=${maxAgeS}`,
      `SameSite=${sameSite}`,
    ];
    if (secure || sameSite === "none") parts.push("Secure");
    return parts.join("; ");
  }

  function sessionTokenFrom(req: any): string | null {
    const token = parseCookies(req)[SESSION_COOKIE_NAME];
    return token && /^[0-9a-f]{64}$/.test(token) ? token : null;
  }

  function createSession(user: StoredUser, method: AuthMethod): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + ttlS * 1000;
    sessions.create({
      token,
      userId: user.id,
      subject: user.subject,
      ownerId: user.id,
      method,
      expiresAt,
    });
    return { token, expiresAt };
  }

  function ensureUser(partial: {
    email?: string | null;
    stellarPublicKey?: string | null;
    subject: string;
    displayName: string;
    password?: string | null;
  }): StoredUser {
    const existing = users.findBySubject(partial.subject);
    if (existing) return existing;
    const salt = partial.password ? randomBytes(16) : null;
    const user: StoredUser = {
      id: randomUUID(),
      email: partial.email ?? null,
      stellarPublicKey: partial.stellarPublicKey ?? null,
      displayName: partial.displayName,
      subject: partial.subject,
      passwordHash: partial.password && salt ? hashPassword(partial.password, salt) : null,
      passwordSalt: salt,
      createdAt: new Date().toISOString(),
    };
    users.insert(user);
    return user;
  }

  async function readJson(req: any): Promise<Record<string, unknown> | null> {
    const body = await new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => {
        data += chunk.toString();
        if (data.length > 64 * 1024) reject(new Error("body too large"));
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    }).catch(() => null);
    if (body === null) return null;
    try {
      const parsed = JSON.parse(body || "{}");
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  function sendJson(res: any, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  /**
   * Check the per-source limit for a credential endpoint. Returns the source
   * key when the request may proceed, or null after writing a 429 (with a
   * Retry-After header) when the limit is exceeded.
   *
   * Rate checking occurs BEFORE parsing or validating credentials (such as
   * running expensive scrypt hashing). This sheds traffic early and protects
   * the server from CPU exhaustion during brute-force attacks.
   */
  function rateLimitGate(limiter: SlidingWindowRateLimiter, req: any, res: any): string | null {
    const key = clientKey(req, trustProxy);
    const decision = limiter.check(key);
    if (decision.limited) {
      sendJson(res, 429, { error: "rate_limited" }, { "Retry-After": String(decision.retryAfterSeconds) });
      return null;
    }
    return key;
  }

  function redirect(res: any, location: string, headers: Record<string, string> = {}) {
    res.writeHead(302, { Location: location, ...headers });
    res.end();
  }

  /* ------------------------------------------------------------ routes */

  async function handleRoutes(req: any, res: any, url: string, method: string): Promise<boolean> {
    const [path = "", query = ""] = url.split("?");
    if (!path.startsWith("/auth/")) return false;
    const secure = cookieSecure(req);

    // ---- GET /auth/config — public capability flags, no secrets
    if (method === "GET" && path === "/auth/config") {
      sendJson(res, 200, configStatus());
      return true;
    }

    // ---- GET /auth/me — requires an actual browser session (not the dev/API-key fallback)
    if (method === "GET" && path === "/auth/me") {
      const token = sessionTokenFrom(req);
      const session = token ? sessions.get(token) : null;
      if (!session) {
        sendJson(res, 401, { error: "unauthorized" });
        return true;
      }
      const user = users.findById(session.userId);
      sendJson(res, 200, {
        subject: session.subject,
        ownerId: session.ownerId,
        method: session.method,
        displayName: user?.displayName ?? session.subject,
        email: user?.email ?? null,
      });
      return true;
    }

    // ---- POST /auth/register
    if (method === "POST" && path === "/auth/register") {
      if (cfg.allowRegistration === false) {
        sendJson(res, 403, { error: "registration_disabled" });
        return true;
      }
      const rlKey = rateLimitGate(registerLimiter, req, res);
      if (rlKey === null) return true;
      registerLimiter.record(rlKey);
      const body = await readJson(req);
      const email = normalizeEmail(body?.email);
      const password = typeof body?.password === "string" ? body.password : "";
      if (!email) {
        sendJson(res, 400, { error: "invalid_email" });
        return true;
      }
      if (password.length < 8) {
        sendJson(res, 400, { error: "weak_password", hint: "minimum 8 characters" });
        return true;
      }
      if (users.findByEmail(email)) {
        sendJson(res, 409, { error: "email_registered" });
        return true;
      }
      const displayName =
        typeof body?.displayName === "string" && body.displayName.trim().length > 0
          ? body.displayName.trim().slice(0, 80)
          : (email?.split("@")[0] ?? "user");
      const user = ensureUser({ email, subject: `email:${email}`, displayName, password });
      const { token } = createSession(user, "email");
      sendJson(res, 201, { subject: user.subject }, { "Set-Cookie": sessionCookie(token, ttlS, secure) });
      return true;
    }

    // ---- POST /auth/login/email
    if (method === "POST" && path === "/auth/login/email") {
      const rlKey = rateLimitGate(loginLimiter, req, res);
      if (rlKey === null) return true;
      const body = await readJson(req);
      const email = normalizeEmail(body?.email);
      const password = typeof body?.password === "string" ? body.password : "";
      const user = email ? users.findByEmail(email) : null;
      const ok =
        user && user.passwordHash && user.passwordSalt && password.length > 0
          ? verifyPassword(password, user.passwordSalt, user.passwordHash)
          : false;
      if (!ok || !user || !user.passwordHash || !user.passwordSalt) {
        // identical response for unknown email and wrong password — no enumeration
        loginLimiter.record(rlKey);
        sendJson(res, 401, { error: "invalid_credentials" });
        return true;
      }
      // Legitimate sign-in clears the source's counter so an authentic user who
      // made typos isn't penalised. Note: once a source has exhausted its budget
      // and is rate-limited (429), it is rejected at the gate above BEFORE reaching
      // this point, protecting server CPU from scrypt exhaustion.
      loginLimiter.reset(rlKey);
      const { token } = createSession(user, "email");
      sendJson(res, 200, { subject: user.subject }, { "Set-Cookie": sessionCookie(token, ttlS, secure) });
      return true;
    }

    // ---- POST /auth/stellar/challenge
    if (method === "POST" && path === "/auth/stellar/challenge") {
      const rlKey = rateLimitGate(challengeLimiter, req, res);
      if (rlKey === null) return true;
      challengeLimiter.record(rlKey);
      const body = await readJson(req);
      const publicKey = typeof body?.publicKey === "string" ? body.publicKey : "";
      if (!StrKey.isValidEd25519PublicKey(publicKey)) {
        sendJson(res, 400, { error: "invalid_public_key" });
        return true;
      }
      const challengeId = randomUUID();
      const issuedAt = new Date().toISOString();
      const expires = new Date(Date.now() + 5 * 60 * 1000);
      const message = buildStellarChallengeMessage({
        publicKey,
        domain: stellarDomain,
        challengeId,
        issuedAt,
        expiresAt: expires.toISOString(),
        nonce: randomBytes(16).toString("hex"),
      });
      pendingChallenges.set(challengeId, {
        publicKey,
        message,
        expiresAt: expires.getTime(),
        used: false,
      });
      sendJson(res, 200, {
        challengeId,
        message,
        expiresAt: expires.toISOString(),
        network: "testnet",
      });
      return true;
    }

    // ---- POST /auth/stellar/verify
    if (method === "POST" && path === "/auth/stellar/verify") {
      const rlKey = rateLimitGate(verifyLimiter, req, res);
      if (rlKey === null) return true;
      verifyLimiter.record(rlKey);
      const body = await readJson(req);
      const publicKey = typeof body?.publicKey === "string" ? body.publicKey : "";
      const challengeId = typeof body?.challengeId === "string" ? body.challengeId : "";
      const signature = typeof body?.signature === "string" ? body.signature : "";
      const pending = pendingChallenges.get(challengeId);
      if (!pending || pending.used || pending.expiresAt <= Date.now() || pending.publicKey !== publicKey) {
        sendJson(res, 401, { error: "challenge_invalid" });
        return true;
      }
      // Accept base64 or hex signature (Freighter returns hex, wallets vary).
      let sigBuf: Buffer | null = null;
      try {
        if (/^(0x)?[0-9a-fA-F]{128}$/.test(signature)) {
          sigBuf = Buffer.from(signature.replace(/^0x/i, ""), "hex");
        } else if (/^[0-9a-zA-Z+/]{86}==$/.test(signature)) {
          sigBuf = Buffer.from(signature, "base64");
        }
      } catch {
        sigBuf = null;
      }
      if (!sigBuf) {
        sendJson(res, 400, { error: "invalid_signature_encoding" });
        return true;
      }
      let valid = false;
      try {
        // Stellar Keypair.sign()/nacl.sign.detached() semantics: ed25519 over
        // the raw message bytes (also covers node crypto raw ed25519 — same RFC 8032 scheme).
        valid = Keypair.fromPublicKey(publicKey).verify(
          Buffer.from(pending.message, "utf8"),
          sigBuf
        );
      } catch {
        valid = false;
      }
      if (!valid) {
        try {
          // SEP-53 (Freighter signMessage): js-stellar-base hashes
          // sha256("Stellar Signed Message:\n" + message) and the wallet signs
          // THAT digest with ed25519 (nacl.sign.detached over the 32-byte hash).
          const sep53Digest = createHash("sha256")
            .update("Stellar Signed Message:\n" + pending.message, "utf8")
            .digest();
          valid = Keypair.fromPublicKey(publicKey).verify(sep53Digest, sigBuf);
        } catch {
          valid = false;
        }
      }
      if (!valid) {
        sendJson(res, 401, { error: "invalid_signature" });
        return true;
      }
      pending.used = true; // single-use, even on success
      const user = ensureUser({
        stellarPublicKey: publicKey,
        subject: `stellar:${publicKey}`,
        displayName: `${publicKey.slice(0, 6)}…${publicKey.slice(-4)}`,
      });
      const { token } = createSession(user, "stellar");
      sendJson(res, 200, { subject: user.subject }, { "Set-Cookie": sessionCookie(token, ttlS, secure) });
      return true;
    }

    // ---- GET /auth/google/start
    if (method === "GET" && path === "/auth/google/start") {
      if (!googleConfigured) {
        sendJson(res, 503, {
          error: "google_oauth_not_configured",
          requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
        });
        return true;
      }
      const state = randomBytes(16).toString("hex");
      const nonce = randomBytes(16).toString("hex");
      pendingStates.set(state, { nonce, expiresAt: Date.now() + 10 * 60 * 1000 });
      const redirectUri = cfg.google!.redirectUri ?? `${webOrigin}/auth/google/callback`;
      const params = new URLSearchParams({
        client_id: cfg.google!.clientId!,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email",
        state,
        nonce,
        prompt: "select_account",
      });
      redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
      return true;
    }

    // ---- GET /auth/google/callback
    if (method === "GET" && path === "/auth/google/callback") {
      const q = new URLSearchParams(query ?? "");
      const state = q.get("state") ?? "";
      const code = q.get("code") ?? "";
      const pending = pendingStates.get(state);
      pendingStates.delete(state); // single-use regardless of outcome
      if (!googleConfigured || !pending || pending.expiresAt <= Date.now() || !code) {
        redirect(res, `${webOrigin}/overview?auth_error=google_failed`);
        return true;
      }
      try {
        const redirectUri = cfg.google!.redirectUri ?? `${webOrigin}/auth/google/callback`;
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: cfg.google!.clientId!,
            client_secret: cfg.google!.clientSecret!,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!tokenRes.ok) throw new Error("token_exchange_failed");
        const tokens = (await tokenRes.json()) as { id_token?: string };
        if (!tokens.id_token) throw new Error("no_id_token");
        const { payload } = await jwtVerify(tokens.id_token, googleJwks, {
          issuer: ["https://accounts.google.com", "accounts.google.com"],
          audience: cfg.google!.clientId!,
        });
        if (payload.nonce !== pending.nonce) throw new Error("nonce_mismatch");
        const sub = String(payload.sub);
        const email = typeof payload.email === "string" ? normalizeEmail(payload.email) : null;
        const displayName =
          typeof payload.name === "string" && payload.name.trim() ? payload.name.trim().slice(0, 80) : (email ?? `google:${sub.slice(0, 8)}`);
        const user = ensureUser({
          email,
          subject: `google:${sub}`,
          displayName,
        });
        const { token } = createSession(user, "google");
        redirect(res, `${webOrigin}/overview`, { "Set-Cookie": sessionCookie(token, ttlS, secure) });
      } catch {
        // never echo provider error details (may contain codes)
        redirect(res, `${webOrigin}/overview?auth_error=google_failed`);
      }
      return true;
    }

    // ---- POST /auth/logout — deletes the server-side session, then clears the cookie
    if (method === "POST" && path === "/auth/logout") {
      const token = sessionTokenFrom(req);
      if (token) sessions.delete(token);
      res.writeHead(204, { "Set-Cookie": sessionCookie("deleted", 0, secure) });
      res.end();
      return true;
    }

    // Known /auth/ namespace, unknown route
    sendJson(res, 404, { error: "not_found" });
    return true;
  }

  /* --------------------------------------------------------- principal resolve */

  async function authenticate(
    req: { headers: Record<string, string | string[] | undefined> },
    method: string
  ): Promise<PrincipalResolution> {
    const token = parseCookies(req)[SESSION_COOKIE_NAME];
    const session = token && /^[0-9a-f]{64}$/.test(token) ? sessions.get(token) : null;
    if (session) {
      // Cookie sessions gate state-changing requests behind a custom header
      // (browser form posts cannot set it → forged requests fail).
      const xrw = req.headers["x-requested-with"];
      const xrwValue = Array.isArray(xrw) ? xrw[0] : xrw;
      if (isStateChanging(method) && xrwValue !== "4evergent") {
        return { principal: null, via: "session", csrfFail: true };
      }
      return {
        principal: { subject: session.subject, ownerId: session.ownerId },
        via: "session",
        csrfFail: false,
      };
    }
    if (opts.fallbackProvider) {
      const principal = await opts.fallbackProvider.authenticate({ headers: req.headers });
      if (principal) return { principal, via: "fallback", csrfFail: false };
    }
    return { principal: null, via: null, csrfFail: false };
  }

  function sessionFor(req: { headers: Record<string, string | string[] | undefined> }): SessionRecord | null {
    const token = parseCookies(req)[SESSION_COOKIE_NAME];
    return token && /^[0-9a-f]{64}$/.test(token) ? sessions.get(token) : null;
  }

  function configStatus() {
    return {
      email: true,
      google: googleConfigured,
      stellar: true,
      registration: cfg.allowRegistration !== false,
    };
  }

  return {
    authenticate,
    handleRoutes,
    sessionFor,
    configStatus,
    sweepExpiredSessions: (cutoff: number, limit?: number) => sessions.deleteExpiredBefore(cutoff, limit),
  };
}
