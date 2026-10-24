import { getConnInfo } from "@hono/node-server/conninfo";
import { isIP } from "node:net";
import type { Context, MiddlewareHandler } from "hono";
import { ipBucket } from "./ip.js";

export const errorBody = (code: string, message: string) => ({ error: { code, message } });

export const MAX_AUTH_HEADER_CHARS = 8192;

/** True for a syntactically plausible `Authorization: Bearer <credential>` header. Validity is the API's decision, never ours. */
export function plausibleBearer(header: string | undefined | null): header is string {
  return typeof header === "string" && header.length <= MAX_AUTH_HEADER_CHARS && /^Bearer [A-Za-z0-9._~+/-]+=*$/i.test(header);
}

/** The credential part of a header accepted by plausibleBearer (used only as a cache key after hashing). */
export const bearerValue = (header: string): string => header.slice(7).trim();

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** DNS-rebinding defence: loopback names WITH our port plus exact configured Host values. */
export function hostAllowed(host: string | undefined, port: number, extraAllowedHosts: readonly string[] = []): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return LOOPBACK_HOSTS.some((l) => h === `${l}:${port}`) || extraAllowedHosts.some((x) => x.toLowerCase() === h);
}

export function hostGuard(opts: { getPort: () => number; allowedHosts: string[] }): MiddlewareHandler {
  return async (c, next) => {
    if (!hostAllowed(c.req.header("host"), opts.getPort(), opts.allowedHosts)) {
      return c.json(errorBody("forbidden_host", "Host header not allowed"), 403);
    }
    await next();
  };
}

/** MCP clients send no Origin. Any Origin not on the (normally empty) list is refused, and no CORS header is ever added. */
export function originGuard(allowedOrigins: string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins);
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowed.has(origin)) return c.json(errorBody("forbidden_origin", "Origin not allowed"), 403);
    await next();
  };
}

export interface FailureLimiter {
  blocked(key: string): boolean;
  fail(key: string): void;
}

/** Per-client counter: `max` failures per window, at most `maxKeys` tracked clients. */
export function createFailureLimiter(opts: { max?: number; windowMs?: number; maxKeys?: number; now?: () => number } = {}): FailureLimiter {
  const { max = 30, windowMs = 60_000, maxKeys = 10_000, now = Date.now } = opts;
  const failures = new Map<string, number[]>();
  const live = (key: string, t: number): number[] => (failures.get(key) ?? []).filter((x) => t - x < windowMs);
  return {
    blocked(key) {
      const recent = live(key, now());
      if (recent.length === 0) failures.delete(key);
      else failures.set(key, recent);
      return recent.length >= max;
    },
    fail(key) {
      const t = now();
      if (!failures.has(key) && failures.size >= maxKeys) {
        for (const [k, v] of failures) if (v.length === 0 || t - v[v.length - 1]! >= windowMs) failures.delete(k);
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

/** Socket address, or (trustProxy) the LAST X-Forwarded-For entry when it is an IP literal. Null when unknown. */
export function clientIp(c: Context, trustProxy: boolean): string | null {
  if (trustProxy) {
    const last = c.req.header("x-forwarded-for")?.split(",").pop()?.trim();
    if (last && isIP(last.replace(/^\[(.*)\]$/, "$1"))) return last.replace(/^\[(.*)\]$/, "$1");
  }
  try {
    const a = getConnInfo(c).remote.address;
    return a && isIP(a.replace(/%.*$/, "")) ? a.replace(/%.*$/, "") : null;
  } catch {
    return null;
  }
}

/** Limiter bucket of a client (IPv6 by /64), "unknown" when the address is unknown. */
export const clientBucket = (ip: string | null): string => ipBucket(ip) ?? "unknown";
