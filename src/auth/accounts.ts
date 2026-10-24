import type pg from "pg";
import { createEmptyWorkspace, SCHEMA_VERSION } from "../domain/index.js";
import type { PgStore } from "../store/pgStore.js";
import {
  createToken,
  listTokens,
  revokeToken,
  verifyMcpToken,
  type CreateTokenResult,
  type McpPrincipal,
  type TokenInfo,
} from "./apiTokens.js";
import { normalizeEmail } from "./email.js";
import { reapExpired } from "./maintenance.js";
import { createPasswordHasher, exceedsPasswordBytes, PasswordBusyError, passwordProblemMessage, validatePassword, type PasswordHasher } from "./password.js";
import { stripUnsafeChars } from "./sanitize.js";
import { createSession, revokeSession, revokeUserSessions, verifySession, type SessionPrincipal } from "./sessions.js";
import { clearForUserTx, clearKeys, emailHash, forgetIps, isKnownIp, refundAttempt, rememberIp, reauthKey, reserveAttempt, SOFT, softKey, STRICT, strictKey } from "./throttle.js";

export { normalizeEmail } from "./email.js";
export { lockSecondsFor } from "./throttle.js";

export interface Profile {
  id: string;
  email: string;
  displayName: string;
}

export type CreatedToken = Extract<CreateTokenResult, { ok: true }> & { prefix: string; createdAt: Date };

export interface AuthResult {
  /** The opaque `ms_` session token (shown once, never stored in plaintext). */
  token: string;
  expiresAt: Date;
  user: Profile;
}

/** A refusal the HTTP layer shows to the client (as opposed to infrastructure errors, which are thrown as-is). */
export class AccountError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 403 | 409 | 429,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

export const INVALID_CREDENTIALS = (): AccountError => new AccountError("invalid_credentials", "Invalid email or password", 401);

const NAME_MAX = 100;
const USER_LOCK_KEY = 726_002; // pg advisory lock serializing user creation (MAX_USERS)
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const rateLimited = (wait: number): AccountError => new AccountError("rate_limited", "Too many attempts. Try again later.", 429, wait);

export interface AccountConfig {
  maxMcpTokens: number;
  allowRegistration: boolean;
  allowedEmails: string[];
  maxUsers: number;
  sessionIdleDays: number;
  sessionMaxDays: number;
  /** Concurrent password hashes when the service builds its own hasher (default 2). */
  hashConcurrency?: number;
}

export interface RequestContext {
  userAgent?: string | null;
  /** The validated IP bucket of the client (see http/ip.ts), never raw header text. */
  ip?: string | null;
}

/**
 * What the HTTP layer needs for credentials and account data. Every method is scoped to a userId that comes from
 * the authenticated context. Refusals are AccountError; infrastructure failures THROW other errors (HTTP: 503/500);
 * verifySession / verifyMcp return null only for credential refusals.
 */
export interface AccountService {
  registrationOpen(): Promise<boolean>;
  register(input: { email: string; password: string; displayName?: string }, ctx?: RequestContext): Promise<AuthResult>;
  login(input: { email: string; password: string }, ctx?: RequestContext): Promise<AuthResult>;
  logout(userId: string, sessionId: string): Promise<void>;
  changePassword(userId: string, sessionId: string, currentPassword: string, newPassword: string, ctx?: RequestContext): Promise<void>;
  deleteAccount(userId: string, password: string): Promise<void>;
  verifySession(token: string): Promise<SessionPrincipal | null>;
  verifyMcp(token: string): Promise<McpPrincipal | null>;
  createToken(userId: string, opts: { label: string; expiresInDays?: number }): Promise<CreatedToken | { ok: false; reason: "invalid" | "limit" }>;
  listTokens(userId: string): Promise<TokenInfo[]>;
  /** "revoked" = newly revoked, "already" = was already revoked by this user, "not_found" = unknown or not theirs. */
  revokeToken(userId: string, tokenId: string): Promise<"revoked" | "already" | "not_found">;
  profile(userId: string): Promise<Profile | null>;
}

function emailAllowed(email: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const domain = email.slice(email.lastIndexOf("@"));
  return allowed.some((a) => (a.startsWith("@") ? a === domain : a === email));
}

function cleanDisplayName(raw: unknown, email: string): string {
  const fromInput = typeof raw === "string" ? [...stripUnsafeChars(raw).trim()].slice(0, NAME_MAX).join("").trim() : "";
  if (fromInput) return fromInput;
  return [...stripUnsafeChars(email.split("@")[0]!).trim()].slice(0, NAME_MAX).join("") || "User";
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  disabled_at: Date | null;
}

export interface AccountServiceOptions {
  hasher?: PasswordHasher;
}

export function createAccountService(pool: pg.Pool, store: PgStore, cfg: AccountConfig, opts: AccountServiceOptions = {}): AccountService {
  const hasher = opts.hasher ?? createPasswordHasher({ maxConcurrent: cfg.hashConcurrency });
  void hasher.warm(); // the dummy hash is computed now, so the first unknown-email login is not distinguishable by timing
  let lastReap = 0;
  /** Opportunistic bounded cleanup (throttle rows, known IPs, finished sessions), at most once a minute per process. */
  const maybeReap = (): void => {
    const now = Date.now();
    if (now - lastReap < 60_000) return;
    lastReap = now;
    void reapExpired(pool, { idleDays: cfg.sessionIdleDays }).catch(() => undefined);
  };
  const policy = { idleDays: cfg.sessionIdleDays, maxDays: cfg.sessionMaxDays };
  const profileOf = (r: { id: string; email: string; display_name: string }): Profile => ({ id: r.id, email: r.email, displayName: r.display_name });

  const userCount = async (): Promise<number> => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM users")).rows[0]!.n;

  const openSession = async (user: Profile, ctx?: RequestContext, expectedHash?: string): Promise<AuthResult> => {
    const s = await createSession(pool, user.id, policy, ctx?.userAgent, expectedHash);
    if (!s) throw INVALID_CREDENTIALS();
    await rememberIp(pool, user.id, ctx?.ip ?? null);
    return { token: s.token, expiresAt: s.expiresAt, user };
  };

  /** Re-checks the user's own password for sensitive operations, with a persisted per-user failure backoff (survives restarts). */
  const requirePassword = async (userId: string, password: string): Promise<UserRow> => {
    const key = reauthKey(userId);
    const wait = await reserveAttempt(pool, [{ key, schedule: STRICT, enforce: true }]); // counted before the verify, cleared on success
    if (wait) throw rateLimited(wait);
    const row = (await pool.query<UserRow>("SELECT id, email, display_name, password_hash, disabled_at FROM users WHERE id = $1", [userId])).rows[0];
    let ok: boolean;
    try {
      ok = !!row && !row.disabled_at && !!row.password_hash && typeof password === "string" && (await hasher.verify(password, row.password_hash));
    } catch (e) {
      if (e instanceof PasswordBusyError) await refundAttempt(pool, [key]).catch(() => undefined); // never checked: not a failure
      throw e;
    }
    if (!ok || !row) {
      throw new AccountError("invalid_password", "Password is incorrect", 403);
    }
    await clearKeys(pool, [key]);
    return row;
  };

  return {
    async registrationOpen() {
      return cfg.allowRegistration && (await userCount()) < cfg.maxUsers;
    },

    async register(input, ctx) {
      const closed = () => new AccountError("registration_closed", "Registration is closed", 403);
      if (!cfg.allowRegistration) throw closed();
      const email = normalizeEmail(input.email);
      if (!email) throw new AccountError("invalid_input", "Enter a valid email address", 400);
      if (!emailAllowed(email, cfg.allowedEmails)) throw closed();
      const check = validatePassword(input.password, email);
      if (!check.ok) throw new AccountError("invalid_input", passwordProblemMessage[check.problem], 400);
      const displayName = cleanDisplayName(input.displayName, email);

      // Cheap pre-checks before the expensive hash (the transaction below is the authority).
      if ((await pool.query("SELECT 1 FROM users WHERE lower(email) = $1", [email])).rowCount) throw new AccountError("email_taken", "That email is already registered", 409);
      if ((await userCount()) >= cfg.maxUsers) throw closed();

      const passwordHash = await hasher.hash(input.password);
      const client = await pool.connect();
      let user: Profile;
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [USER_LOCK_KEY]);
        const n = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM users")).rows[0]!.n;
        if (n >= cfg.maxUsers) {
          await client.query("ROLLBACK");
          throw closed();
        }
        const row = (
          await client.query<{ id: string }>(
            "INSERT INTO users (email, display_name, password_hash, password_updated_at) VALUES ($1, $2, $3, now()) RETURNING id",
            [email, displayName, passwordHash],
          )
        ).rows[0]!;
        await client.query("INSERT INTO workspaces (user_id, rev, schema_version, state) VALUES ($1, 0, $2, $3::jsonb)", [
          row.id,
          SCHEMA_VERSION,
          JSON.stringify(createEmptyWorkspace()),
        ]);
        await client.query("COMMIT");
        user = { id: row.id, email, displayName };
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        const err = e as { code?: string; constraint?: string };
        if (err.code === "23505" && err.constraint === "users_email_lower_key") throw new AccountError("email_taken", "That email is already registered", 409);
        throw e;
      } finally {
        client.release();
      }
      return openSession(user, ctx);
    },

    /**
     * Login with persisted throttling (see throttle.ts): a strict (email, IP bucket) lock and a short soft email lock that a
     * known-good IP bypasses. Unknown / unusable emails take exactly the same path and the same stored structure.
     */
    async login(input, ctx) {
      const email = normalizeEmail(input.email);
      const password = typeof input.password === "string" ? input.password : "";
      const eh = emailHash(email ?? `invalid:${String(input.email).slice(0, 320)}`);
      const bucket = ctx?.ip ?? null;
      const soft = softKey(eh);
      const strict = strictKey(eh, bucket ?? "unknown");

      const row = email
        ? (await pool.query<UserRow>("SELECT id, email, display_name, password_hash, disabled_at FROM users WHERE lower(email) = $1", [email])).rows[0]
        : undefined;
      const known = await isKnownIp(pool, row?.id ?? NIL_UUID, bucket); // same query for unknown emails
      // The attempt is counted BEFORE the verify (atomically with the lock check), so a concurrent burst cannot all pass the
      // check; a success clears the counters below. A known-good IP is not refused by the soft lock.
      const wait = await reserveAttempt(pool, [
        { key: strict, schedule: STRICT, enforce: true },
        { key: soft, schedule: SOFT, enforce: !known },
      ]);
      if (wait) throw rateLimited(wait);

      let ok = false;
      try {
        if (row && row.password_hash && !row.disabled_at && !exceedsPasswordBytes(password)) ok = await hasher.verify(password, row.password_hash);
        else await hasher.dummyVerify(password);
      } catch (e) {
        if (e instanceof PasswordBusyError) await refundAttempt(pool, [strict, soft]).catch(() => undefined); // never checked: not a failure
        throw e;
      }

      if (!ok || !row) throw INVALID_CREDENTIALS();

      await clearKeys(pool, [strict, soft]);
      const stored = row.password_hash!;
      let current = stored; // the hash the session must still match (re-checked under the user row lock)
      if (hasher.needsRehash(stored)) {
        // Best effort and never fatal (a busy hasher or a database hiccup must not turn a correct login into a 503).
        // Guarded by the old hash so a concurrent password change is never overwritten with the previous password.
        try {
          const upgraded = await hasher.hash(password);
          const up = await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1 AND password_hash = $3", [row.id, upgraded, stored]);
          if (up.rowCount) current = upgraded;
        } catch {
          /* keep the old hash; the next login retries */
        }
      }
      await store.ensureWorkspace(row.id); // self-heals a user created before this schema had a workspace
      maybeReap();
      return openSession(profileOf(row), ctx, current); // refuses when the password changed since it was verified
    },

    async logout(userId, sessionId) {
      await revokeSession(pool, userId, sessionId);
    },

    async changePassword(userId, sessionId, currentPassword, newPassword, ctx) {
      const row = await requirePassword(userId, currentPassword);
      const check = validatePassword(newPassword, row.email);
      if (!check.ok) throw new AccountError("invalid_input", passwordProblemMessage[check.problem], 400);
      if (newPassword === currentPassword) throw new AccountError("invalid_input", "The new password must differ from the current one", 400);
      const hash = await hasher.hash(newPassword);
      // One transaction: the new hash and the revocation of the other sessions land together or not at all (a failed revoke
      // must never leave other sessions alive under a changed password).
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Conditional on the hash that was just verified: a password changed in between is never overwritten.
        const upd = await client.query("UPDATE users SET password_hash = $2, password_updated_at = now() WHERE id = $1 AND password_hash = $3", [userId, hash, row.password_hash]);
        if (!upd.rowCount) throw new AccountError("conflict", "Your password was changed meanwhile. Try again.", 409);
        await clearForUserTx(client, row.email, userId);
        await forgetIps(client, userId); // no previously trusted address stays trusted after a password change
        await revokeUserSessions(client, userId, sessionId);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
      await rememberIp(pool, userId, ctx?.ip ?? null);
    },

    async deleteAccount(userId, password) {
      await requirePassword(userId, password);
      // Cascades to sessions, api_tokens and the workspace; audit_log.user_id becomes NULL.
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    },

    verifySession: (token) => verifySession(pool, token, policy),
    verifyMcp: (token) => verifyMcpToken(pool, token),
    async createToken(userId, o) {
      const r = await createToken(pool, userId, { ...o, maxActive: cfg.maxMcpTokens });
      if (!r.ok) return r;
      const row = (
        await pool.query<{ prefix: string; created_at: Date }>("SELECT prefix, created_at FROM api_tokens WHERE id = $1 AND user_id = $2", [r.id, userId])
      ).rows[0];
      return { ...r, prefix: row?.prefix ?? r.token.slice(0, 7), createdAt: row?.created_at ?? new Date() };
    },
    listTokens: (userId) => listTokens(pool, userId),
    async revokeToken(userId, tokenId) {
      if (await revokeToken(pool, userId, tokenId)) return "revoked";
      const mine = (await listTokens(pool, userId)).find((t) => t.id === tokenId);
      return mine?.revokedAt ? "already" : "not_found";
    },
    async profile(userId) {
      const r = await pool.query<{ id: string; email: string; display_name: string }>("SELECT id, email, display_name FROM users WHERE id = $1", [userId]);
      return r.rows[0] ? profileOf(r.rows[0]) : null;
    },
  };
}
