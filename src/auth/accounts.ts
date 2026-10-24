import type pg from "pg";
import {
  createToken,
  listTokens,
  revokeToken,
  verifyMcpToken,
  type CreateTokenResult,
  type McpPrincipal,
  type TokenInfo,
} from "./apiTokens.js";

export interface Profile {
  id: string;
  email: string;
  displayName: string;
}

export type CreatedToken = Extract<CreateTokenResult, { ok: true }> & { prefix: string; createdAt: Date };

/**
 * What the HTTP layer needs from the database for credentials and account data. Every method is scoped to a
 * userId that comes from the authenticated context. Methods THROW on infrastructure errors (the HTTP layer maps
 * those to 503/500); verifyMcp returns null only for credential refusals.
 */
export interface AccountService {
  verifyMcp(token: string): Promise<McpPrincipal | null>;
  createToken(userId: string, opts: { label: string; expiresInDays?: number }): Promise<CreatedToken | { ok: false; reason: "invalid" | "limit" }>;
  listTokens(userId: string): Promise<TokenInfo[]>;
  /** "revoked" = newly revoked, "already" = was already revoked by this user, "not_found" = unknown or not theirs. */
  revokeToken(userId: string, tokenId: string): Promise<"revoked" | "already" | "not_found">;
  profile(userId: string): Promise<Profile | null>;
}

export function createAccountService(pool: pg.Pool, cfg: { maxMcpTokens: number }): AccountService {
  return {
    verifyMcp: (token) => verifyMcpToken(pool, token),
    async createToken(userId, opts) {
      const r = await createToken(pool, userId, { ...opts, maxActive: cfg.maxMcpTokens });
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
      const row = r.rows[0];
      return row ? { id: row.id, email: row.email, displayName: row.display_name } : null;
    },
  };
}
