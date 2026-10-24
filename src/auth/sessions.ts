import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

/** `ms_` + 32 random bytes base64url: a shape distinct from the `mn_` MCP tokens, so the shape alone picks the verifier. */
export const SESSION_RE = /^ms_[A-Za-z0-9_-]{43}$/;
export const MAX_ACTIVE_SESSIONS = 10;
export const DEFAULT_IDLE_DAYS = 7;
export const DEFAULT_MAX_DAYS = 30;
/** last_seen_at is written at most this often per session. */
export const TOUCH_INTERVAL_MS = 60_000;
const USER_AGENT_MAX = 200;
const DAY_S = 86_400;

export interface SessionPolicy {
  idleDays: number;
  maxDays: number;
  /** Active sessions kept per user (oldest are revoked beyond it). */
  maxActive?: number;
}

export const mintSession = (): string => `ms_${randomBytes(32).toString("base64url")}`;
export const hashSession = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

export interface CreatedSession {
  id: string;
  token: string;
  /** Earliest of (idle expiry, absolute expiry): when the session ends if it is not used again. */
  expiresAt: Date;
}

export interface SessionPrincipal {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  expiresAt: Date;
}

const clipAgent = (ua: string | undefined | null): string | null => {
  if (!ua) return null;
  // eslint-disable-next-line no-control-regex
  const s = ua.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, USER_AGENT_MAX);
  return s || null;
};

/**
 * Creates a session for an active user (null when the user is gone or disabled, or when `expectedHash` is given and the stored password hash no longer equals it: the password changed after it was verified). Serialized per user so the cap
 * cannot be raced past; the oldest sessions beyond the cap are revoked. This user's finished sessions (past absolute expiry, or revoked over 7 days ago) are purged opportunistically.
 */
export async function createSession(pool: pg.Pool, userId: string, policy: SessionPolicy, userAgent?: string | null, expectedHash?: string): Promise<CreatedSession | null> {
  const maxActive = policy.maxActive ?? MAX_ACTIVE_SESSIONS;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query("SELECT 1 FROM users WHERE id = $1 AND disabled_at IS NULL AND ($2::text IS NULL OR password_hash = $2) FOR UPDATE", [userId, expectedHash ?? null]);
    if (u.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      "DELETE FROM sessions WHERE user_id = $1 AND (expires_at < now() OR revoked_at < now() - interval '7 days')",
      [userId],
    );
    const token = mintSession();
    const row = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO sessions (user_id, token_hash, user_agent, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4::int)) RETURNING id, expires_at`,
      [userId, hashSession(token), clipAgent(userAgent), policy.maxDays * DAY_S],
    );
    await client.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE id IN (SELECT id FROM sessions
                      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
                      ORDER BY created_at DESC, id OFFSET $2)`,
      [userId, maxActive],
    );
    await client.query("COMMIT");
    const abs = row.rows[0]!.expires_at;
    const idle = new Date(Date.now() + policy.idleDays * DAY_S * 1000);
    return { id: row.rows[0]!.id, token, expiresAt: idle < abs ? idle : abs };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Resolves a presented `ms_` token. Returns null ONLY for credential refusals (malformed, unknown, revoked, past
 * the absolute or idle expiry, user disabled/deleted); THROWS on database errors so the HTTP layer answers 503.
 * Sliding expiry: last_seen_at is refreshed when it is older than TOUCH_INTERVAL_MS.
 */
export async function verifySession(pool: pg.Pool, token: string, policy: Pick<SessionPolicy, "idleDays">): Promise<SessionPrincipal | null> {
  if (typeof token !== "string" || !SESSION_RE.test(token)) return null;
  const r = await pool.query<{ id: string; user_id: string; email: string; display_name: string; last_seen_at: Date; expires_at: Date; db_now: Date }>(
    `SELECT s.id, s.user_id, s.last_seen_at, s.expires_at, u.email, u.display_name, now() AS db_now
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(secs => $2::int) AND u.disabled_at IS NULL`,
    [hashSession(token), policy.idleDays * DAY_S],
  );
  const row = r.rows[0];
  if (!row) return null;
  const now = row.db_now.getTime();
  let lastSeen = row.last_seen_at.getTime();
  if (now - lastSeen >= TOUCH_INTERVAL_MS) {
    // Conditional so two concurrent requests do not both write; a failure here must not fail authentication.
    await pool
      .query("UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND revoked_at IS NULL AND last_seen_at < now() - make_interval(secs => $2::int)", [row.id, TOUCH_INTERVAL_MS / 1000])
      .then(() => (lastSeen = now), () => undefined);
  }
  const idleEnd = lastSeen + policy.idleDays * DAY_S * 1000;
  return {
    sessionId: row.id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    expiresAt: new Date(Math.min(idleEnd, row.expires_at.getTime())),
  };
}

/** Revokes one session, scoped to its owner. Idempotent; true when newly revoked. */
export async function revokeSession(pool: pg.Pool, userId: string, sessionId: string): Promise<boolean> {
  const r = await pool.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [sessionId, userId]);
  return (r.rowCount ?? 0) > 0;
}

/** Revokes every active session of the user, optionally sparing one (the caller's own after a password change). Returns the count. */
export async function revokeUserSessions(pool: Pick<pg.Pool, "query">, userId: string, exceptSessionId?: string): Promise<number> {
  const r = await pool.query(
    "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)",
    [userId, exceptSessionId ?? null],
  );
  return r.rowCount ?? 0;
}
