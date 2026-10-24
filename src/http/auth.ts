import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import type { AccountService } from "../auth/accounts.js";
import { TOKEN_RE } from "../auth/apiTokens.js";
import type { JwtVerifier } from "../auth/jwt.js";
import type { UserDirectory } from "../auth/users.js";
import { errorBody } from "./cors.js";

export interface AuthContext {
  userId: string;
  /** The user's display name (the human actor name on REST writes). */
  displayName: string;
  kind: "jwt" | "mcp";
  /** Set for MCP tokens only. */
  tokenId?: string;
}

export type AppEnv = { Variables: { auth: AuthContext } };

export const MAX_AUTH_HEADER_CHARS = 8192;
const BEARER_RE = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;
const JWT_SHAPE_RE = /^[^.]+\.[^.]+\.[^.]+$/;

/** Exactly one, strictly formatted `Authorization: Bearer <credential>` header, or null. */
export function parseBearer(header: string | undefined | null): string | null {
  if (header === undefined || header === null || header.length > MAX_AUTH_HEADER_CHARS) return null;
  return BEARER_RE.exec(header)?.[1] ?? null;
}

export interface FailureLimiter {
  /** True when this client has used up its failure budget (call before authenticating). */
  blocked(key: string): boolean;
  /** Records one failed authentication. */
  fail(key: string): void;
}

/** Per-client failed-auth counter: `max` failures per window, at most `maxKeys` tracked clients. */
export function createFailureLimiter(opts: { max?: number; windowMs?: number; maxKeys?: number; now?: () => number } = {}): FailureLimiter {
  const { max = 30, windowMs = 60_000, maxKeys = 10_000, now = Date.now } = opts;
  const failures = new Map<string, number[]>();
  const live = (key: string, t: number): number[] => (failures.get(key) ?? []).filter((x) => t - x < windowMs);
  return {
    blocked(key) {
      const t = now();
      const recent = live(key, t);
      if (recent.length === 0) failures.delete(key);
      else failures.set(key, recent);
      return recent.length >= max;
    },
    fail(key) {
      const t = now();
      if (!failures.has(key) && failures.size >= maxKeys) {
        for (const [k, v] of failures) if (v.length === 0 || t - v[v.length - 1] >= windowMs) failures.delete(k);
        for (const k of failures.keys()) {
          if (failures.size < maxKeys) break;
          failures.delete(k);
        }
      }
      const recent = live(key, t);
      recent.push(t);
      failures.set(key, recent.slice(-max));
    },
  };
}

/**
 * Key for the pre-auth failure limiter. The socket address by default (coarse: clients behind one NAT/proxy share
 * a bucket). X-Forwarded-For is honoured only when MNEMONIS_TRUST_PROXY is set, and then only its last entry
 * (the one appended by our own proxy) is used, never client-supplied earlier entries.
 */
export function clientKey(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const last = c.req.header("x-forwarded-for")?.split(",").pop()?.trim();
    if (last && last.length <= 64) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface AuthOptions {
  verifier: JwtVerifier;
  directory: UserDirectory;
  accounts: Pick<AccountService, "verifyMcp">;
  failureLimiter: FailureLimiter;
  trustProxy: boolean;
}

const unauthorized = (c: Context) => {
  c.header("WWW-Authenticate", 'Bearer realm="mnemonis"');
  return c.json(errorBody("unauthorized", "Missing or invalid credentials"), 401);
};

const unavailable = (c: Context, e: unknown) => {
  // Only the error class name is logged: never tokens, claims or driver messages.
  console.error(`auth backend unavailable: ${e instanceof Error ? e.name : "error"}`);
  return c.json(errorBody("unavailable", "Service unavailable"), 503);
};

/**
 * The credential type picks the verifier; the two are never tried in turn. /api/* takes only a JWT (three dot-
 * separated segments), /mcp takes only an `mn_` token of kind mcp. Every credential refusal is the same 401.
 */
export function createAuthMiddleware(kind: "jwt" | "mcp", o: AuthOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = clientKey(c, o.trustProxy);
    if (o.failureLimiter.blocked(key)) {
      c.header("Retry-After", "60");
      return c.json(errorBody("rate_limited", "Too many failed attempts. Try again later."), 429);
    }
    const refuse = () => {
      o.failureLimiter.fail(key);
      return unauthorized(c);
    };
    const cred = parseBearer(c.req.header("authorization"));
    if (cred === null) return refuse();
    try {
      if (kind === "jwt") {
        if (!JWT_SHAPE_RE.test(cred)) return refuse();
        const claims = await o.verifier.verify(cred);
        if (!claims) return refuse();
        const user = await o.directory.resolveJwtUser(claims);
        if (!user) return refuse();
        c.set("auth", { userId: user.userId, displayName: user.displayName, kind: "jwt" });
      } else {
        if (!TOKEN_RE.test(cred)) return refuse(); // wrong shape: refused before any database access
        const p = await o.accounts.verifyMcp(cred);
        if (!p) return refuse();
        c.set("auth", { userId: p.userId, displayName: p.displayName, kind: "mcp", tokenId: p.tokenId });
      }
    } catch (e) {
      return unavailable(c, e);
    }
    await next();
  };
}
