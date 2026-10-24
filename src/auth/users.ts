import type pg from "pg";
import type { Config } from "../config.js";
import type { PgStore } from "../store/pgStore.js";
import type { JwtClaims } from "./jwt.js";
import { hasUnsafeChars, stripUnsafeChars } from "./sanitize.js";

export interface ResolvedUser {
  userId: string;
  displayName: string;
}

export interface UserDirectory {
  /**
   * Maps verified JWT claims to a local user, provisioning on first sight when signup policy allows.
   * Error contract: returns null ONLY for policy refusals (closed signup, unverified/disallowed/invalid email,
   * email already bound to another subject, disabled user). THROWS on database/infrastructure errors so the HTTP
   * layer can log and answer 503 instead of a misleading 401.
   *
   * Allowlist/open signup trust `emailVerified`, which comes only from the top-level `email_verified` claim.
   * With Supabase, "Confirm email" MUST be enabled or unverified addresses cannot be told apart.
   */
  resolveJwtUser(claims: JwtClaims): Promise<ResolvedUser | null>;
}

const EMAIL_MAX = 254;
const NAME_MAX = 100;

function normalizeEmail(raw: string | undefined): string | null {
  const e = (raw ?? "").trim().toLowerCase();
  if (e.length === 0 || e.length > EMAIL_MAX || hasUnsafeChars(e)) return null;
  if (!/^[^@\s]+@[^@\s]+$/.test(e)) return null;
  return e;
}

export function sanitizeDisplayName(claims: Pick<JwtClaims, "fullName" | "name">, email: string): string {
  for (const cand of [claims.fullName, claims.name]) {
    const s = [...stripUnsafeChars(cand ?? "").trim()].slice(0, NAME_MAX).join("").trim();
    if (s) return s;
  }
  const local = [...stripUnsafeChars(email.split("@")[0]!).trim()].slice(0, NAME_MAX).join("");
  return local || "User";
}

function emailAllowed(email: string, allowed: string[]): boolean {
  const domain = email.slice(email.lastIndexOf("@"));
  return allowed.some((a) => (a.startsWith("@") ? a === domain : a === email));
}

interface UserRow {
  id: string;
  display_name: string;
  disabled_at: Date | null;
}

export function createUserDirectory(pool: pg.Pool, store: PgStore, cfg: Pick<Config, "signupMode" | "allowedEmails">): UserDirectory {
  const bySubject = async (sub: string): Promise<UserRow | undefined> =>
    (await pool.query<UserRow>("SELECT id, display_name, disabled_at FROM users WHERE auth_subject = $1", [sub])).rows[0];

  const finish = async (row: UserRow): Promise<ResolvedUser | null> => {
    if (row.disabled_at) return null;
    await store.ensureWorkspace(row.id); // self-heals a half-provisioned user
    return { userId: row.id, displayName: row.display_name };
  };

  return {
    async resolveJwtUser(claims) {
      const sub = claims.sub;
      if (typeof sub !== "string" || sub.length === 0 || sub.length > 128) return null;

      const existing = await bySubject(sub);
      if (existing) return finish(existing);

      if (cfg.signupMode === "closed") return null;
      const email = normalizeEmail(claims.email);
      if (!email) return null;
      // Both open and allowlist require a verified email (prevents squatting someone else's address).
      if (!claims.emailVerified) return null;
      if (cfg.signupMode === "allowlist" && !emailAllowed(email, cfg.allowedEmails)) return null;

      try {
        const row = (
          await pool.query<UserRow>(
            `INSERT INTO users (email, display_name, auth_subject) VALUES ($1, $2, $3)
             ON CONFLICT (auth_subject) DO UPDATE SET auth_subject = EXCLUDED.auth_subject
             RETURNING id, display_name, disabled_at`,
            [email, sanitizeDisplayName(claims, email), sub],
          )
        ).rows[0]!;
        return finish(row);
      } catch (e) {
        const err = e as { code?: string; constraint?: string };
        if (err.code === "23505" && err.constraint === "users_email_lower_key") {
          // Same email under a different subject: never link accounts. (A concurrent first request for this very
          // subject may have won the race; if so it is the same account.)
          const again = await bySubject(sub);
          return again ? finish(again) : null;
        }
        throw e;
      }
    },
  };
}
