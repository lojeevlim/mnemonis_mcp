import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { stripUnsafeChars } from "./sanitize.js";

export const TOKEN_RE = /^mn_[A-Za-z0-9_-]{43}$/;
export const DEFAULT_EXPIRES_DAYS = 90;
export const DEFAULT_MAX_ACTIVE_TOKENS = 20;
const LABEL_MAX = 80;
const LAST_USED_INTERVAL_MS = 5 * 60_000;
const THROTTLE_MAX_ENTRIES = 10_000;

export const mintToken = (): string => `mn_${randomBytes(32).toString("base64url")}`;

export const hashToken = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

export interface CreateTokenOptions {
  label: string;
  expiresInDays?: number;
  /** Active-token cap per user (default 20). */
  maxActive?: number;
}

export type CreateTokenResult =
  | { ok: true; id: string; token: string; label: string; expiresAt: Date }
  | { ok: false; reason: "invalid" | "limit" };

export interface TokenInfo {
  id: string;
  label: string | null;
  prefix: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface McpPrincipal {
  tokenId: string;
  userId: string;
  displayName: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mints and stores a token for the user. The plaintext is returned once and never stored. */
export async function createToken(pool: pg.Pool, userId: string, opts: CreateTokenOptions): Promise<CreateTokenResult> {
  const label = stripUnsafeChars(String(opts.label ?? "")).trim();
  const days = opts.expiresInDays ?? DEFAULT_EXPIRES_DAYS;
  if (label.length < 1 || [...label].length > LABEL_MAX) return { ok: false, reason: "invalid" };
  if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false, reason: "invalid" };
  const max = opts.maxActive ?? DEFAULT_MAX_ACTIVE_TOKENS;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize concurrent creations per user so the cap cannot be raced past.
    const u = await client.query("SELECT 1 FROM users WHERE id = $1 AND disabled_at IS NULL FOR UPDATE", [userId]);
    if (u.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "invalid" };
    }
    const n = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1 AND kind = 'mcp' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
      [userId],
    );
    if (n.rows[0]!.n >= max) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "limit" };
    }
    const token = mintToken();
    const row = await client.query<{ id: string; expires_at: Date }>(
      "INSERT INTO api_tokens (user_id, kind, token_hash, prefix, label, expires_at) VALUES ($1, 'mcp', $2, $3, $4, now() + make_interval(days => $5::int)) RETURNING id, expires_at",
      [userId, hashToken(token), token.slice(0, 7), label, days],
    );
    await client.query("COMMIT");
    return { ok: true, id: row.rows[0]!.id, token, label, expiresAt: row.rows[0]!.expires_at };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** The user's MCP tokens (newest first). Never includes the token or its hash. */
export async function listTokens(pool: pg.Pool, userId: string): Promise<TokenInfo[]> {
  const r = await pool.query(
    "SELECT id, label, prefix, created_at, last_used_at, expires_at, revoked_at FROM api_tokens WHERE user_id = $1 AND kind = 'mcp' ORDER BY created_at DESC, id",
    [userId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    label: x.label,
    prefix: x.prefix,
    createdAt: x.created_at,
    lastUsedAt: x.last_used_at,
    expiresAt: x.expires_at,
    revokedAt: x.revoked_at,
  }));
}

/** Idempotent. Scoped to the owner: another user's token id is untouched. Returns true if a token was newly revoked. */
export async function revokeToken(pool: pg.Pool, userId: string, tokenId: string): Promise<boolean> {
  if (typeof tokenId !== "string" || !UUID_RE.test(tokenId)) return false;
  const r = await pool.query("UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND kind = 'mcp' AND revoked_at IS NULL", [tokenId, userId]);
  return (r.rowCount ?? 0) > 0;
}

const lastUsedWritten = new Map<string, number>();

function touchLastUsed(pool: pg.Pool, tokenId: string): void {
  const now = Date.now();
  const prev = lastUsedWritten.get(tokenId);
  if (prev !== undefined && now - prev < LAST_USED_INTERVAL_MS) return;
  if (lastUsedWritten.size >= THROTTLE_MAX_ENTRIES) {
    for (const [k, t] of lastUsedWritten) if (now - t >= LAST_USED_INTERVAL_MS) lastUsedWritten.delete(k);
    if (lastUsedWritten.size >= THROTTLE_MAX_ENTRIES) lastUsedWritten.clear();
  }
  lastUsedWritten.set(tokenId, now);
  // Fire-and-forget; a failure here must never affect authentication.
  void Promise.resolve()
    .then(() => pool.query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [tokenId]))
    .catch(() => undefined);
}

/**
 * Resolves a presented `mn_` token to its owner.
 * Error contract: returns null ONLY for credential refusals (malformed, unknown, revoked, expired, disabled user).
 * THROWS on database/infrastructure errors so the HTTP layer can log and answer 503 instead of a misleading 401.
 * The fire-and-forget last_used write swallows its own errors.
 */
export async function verifyMcpToken(pool: pg.Pool, token: string): Promise<McpPrincipal | null> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const r = await pool.query<{ token_id: string; user_id: string; display_name: string }>(
    `SELECT t.id AS token_id, u.id AS user_id, u.display_name
       FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.kind = 'mcp' AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.disabled_at IS NULL`,
    [hashToken(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  touchLastUsed(pool, row.token_id);
  return { tokenId: row.token_id, userId: row.user_id, displayName: row.display_name };
}
