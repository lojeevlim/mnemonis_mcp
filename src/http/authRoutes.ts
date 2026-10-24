import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AuditLog } from "../audit.js";
import { AccountError, type AccountService, type AuthResult } from "../auth/accounts.js";
import { clientKey, createFailureLimiter, type AppEnv, type FailureLimiter } from "./auth.js";
import { errorBody } from "./cors.js";
import { accountFailure, readJson, tooBig } from "./rest.js";

/** Public auth bodies are tiny: email + password (+ display name). */
export const MAX_AUTH_BODY_BYTES = 2048;

/** Per-client limiters for the public endpoints (every attempt counts, not only failures). */
export interface AuthLimiters {
  register: FailureLimiter;
  login: FailureLimiter;
  config: FailureLimiter;
}

export const createAuthLimiters = (): AuthLimiters => ({
  register: createFailureLimiter({ max: 10, windowMs: 60_000 }),
  login: createFailureLimiter({ max: 10, windowMs: 60_000 }),
  config: createFailureLimiter({ max: 60, windowMs: 60_000 }),
});

const registerBody = z.strictObject({
  email: z.string().max(320),
  password: z.string().max(1024),
  displayName: z.string().max(400).optional(),
});
// No password max here on purpose: an oversize password (the 2 KB body limit still applies) gets the same uniform 401 as any wrong one.
const loginBody = z.strictObject({ email: z.string().max(320), password: z.string() });

export interface PublicAuthOptions {
  accounts: AccountService;
  audit: AuditLog;
  limiters: AuthLimiters;
  trustProxy: boolean;
}

const authBody = (r: AuthResult) => ({
  token: r.token,
  expiresAt: r.expiresAt.toISOString(),
  user: { id: r.user.id, email: r.user.email, displayName: r.user.displayName },
});

/**
 * Mounts the unauthenticated auth endpoints. They are registered BEFORE the session middleware, each behind its own
 * per-client limiter and a 2 KB body limit. Audit entries record the outcome and an IP bucket, never the email or password.
 */
export function registerPublicAuth(app: Hono<AppEnv>, { accounts, audit, limiters, trustProxy }: PublicAuthOptions): void {
  const tooMany = (c: Context) => {
    c.header("Retry-After", "60");
    return c.json(errorBody("rate_limited", "Too many requests. Try again later."), 429);
  };

  const handler =
    (action: "auth:register" | "auth:login", limiter: FailureLimiter, schema: z.ZodType<{ email: string; password: string; displayName?: string }>, status: 200 | 201) =>
    async (c: Context) => {
      const ip = clientKey(c, trustProxy);
      if (limiter.blocked(ip)) return tooMany(c);
      limiter.fail(ip);
      const client = `ip:${ip}`;
      const raw = await readJson(c);
      const parsed = raw.ok ? schema.safeParse(raw.value) : null;
      if (!parsed?.success) return c.json(errorBody("invalid_input", "Body must be a JSON object with the expected fields"), 400);
      const ctx = { userAgent: c.req.header("user-agent"), ip: ip === "unknown" ? null : ip };
      try {
        const r = action === "auth:register" ? await accounts.register(parsed.data, ctx) : await accounts.login(parsed.data, ctx);
        audit.record({ userId: r.user.id, via: "rest", client, actorKind: "user", action, ok: true });
        return c.json(authBody(r), status);
      } catch (e) {
        audit.record({ userId: null, via: "rest", client, action, ok: false, code: e instanceof AccountError ? e.code : "unavailable" });
        return accountFailure(c, e);
      }
    };

  app.post("/api/auth/register", bodyLimit({ maxSize: MAX_AUTH_BODY_BYTES, onError: tooBig }), handler("auth:register", limiters.register, registerBody, 201));
  app.post("/api/auth/login", bodyLimit({ maxSize: MAX_AUTH_BODY_BYTES, onError: tooBig }), handler("auth:login", limiters.login, loginBody, 200));

  app.get("/api/auth/config", async (c) => {
    const ip = clientKey(c, trustProxy);
    if (limiters.config.blocked(ip)) return tooMany(c);
    limiters.config.fail(ip);
    try {
      return c.json({ registrationOpen: await accounts.registrationOpen() });
    } catch (e) {
      return accountFailure(c, e);
    }
  });
}
