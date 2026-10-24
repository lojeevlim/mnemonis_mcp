import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AccountService } from "../auth/accounts.js";
import type { JwtVerifier } from "../auth/jwt.js";
import type { UserDirectory } from "../auth/users.js";
import type { AuditLog } from "../audit.js";
import { createMcpHandler } from "../mcp/server.js";
import { createRateLimiter, type RateLimiter } from "../service/guards.js";
import type { MemoryServices } from "../service/memoryService.js";
import { createAuthMiddleware, createFailureLimiter, type AppEnv, type FailureLimiter } from "./auth.js";
import { corsGuard, errorBody, hostGuard } from "./cors.js";
import { healthBody, MAX_BODY_BYTES, registerRest, tooBig } from "./rest.js";

export interface AppOptions {
  services: MemoryServices;
  audit: AuditLog;
  verifier: JwtVerifier;
  directory: UserDirectory;
  accounts: AccountService;
  allowedOrigins: string[];
  /** Extra Host header values accepted besides loopback:port (MNEMONIS_ALLOWED_HOSTS). */
  allowedHosts?: string[];
  /** Honour X-Forwarded-For for the pre-auth failure limiter (MNEMONIS_TRUST_PROXY). */
  trustProxy?: boolean;
  getPort: () => number;
  limiter?: RateLimiter;
  failureLimiter?: FailureLimiter;
  maxPending?: number;
}

export function createApp(opts: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const guard = { allowedOrigins: opts.allowedOrigins, getPort: opts.getPort, allowedHosts: opts.allowedHosts };
  const limiter = opts.limiter ?? createRateLimiter();
  const authOpts = {
    verifier: opts.verifier,
    directory: opts.directory,
    accounts: opts.accounts,
    failureLimiter: opts.failureLimiter ?? createFailureLimiter(),
    trustProxy: opts.trustProxy ?? false,
  };

  app.use("*", hostGuard(guard));
  app.use("*", corsGuard(guard));
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  // Public and registered before the auth middleware: no credentials, no database read, no data.
  app.get("/api/health", (c) => c.json(healthBody()));

  app.use("/api/*", createAuthMiddleware("jwt", authOpts));
  registerRest(app, { services: opts.services, audit: opts.audit, accounts: opts.accounts });

  const mcp = createMcpHandler({ services: opts.services, audit: opts.audit, limiter, maxPending: opts.maxPending });
  app.use("/mcp", createAuthMiddleware("mcp", authOpts));
  app.all("/mcp", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooBig }), (c) => {
    const a = c.get("auth");
    return mcp(c, { userId: a.userId, tokenId: a.tokenId! });
  });

  app.notFound((c) => c.json(errorBody("not_found", "Not found"), 404));
  app.onError((e, c) => {
    // Never echo error details (could contain paths); the class name is enough for the operator log.
    console.error(`request failed: ${e instanceof Error ? e.name : "error"}`);
    return c.json(errorBody("internal", "Internal error"), 500);
  });
  return app;
}

export interface RunningServer {
  port: number;
  /**
   * Stops accepting connections, then waits up to `graceMs` for in-flight requests to finish before dropping the
   * remaining connections. The default (0) drops them immediately.
   */
  close(graceMs?: number): Promise<void>;
}

/** Listens on host:port (port 0 = ephemeral). Rejects on listen errors such as EADDRINUSE. */
export function startHttpServer(opts: Omit<AppOptions, "getPort"> & { host: string; port: number }): Promise<RunningServer> {
  let actualPort = opts.port;
  const app = createApp({ ...opts, getPort: () => actualPort });
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: opts.host, port: opts.port }, (info: AddressInfo) => {
      actualPort = info.port;
      server.off("error", reject);
      resolve({
        port: info.port,
        close: (graceMs = 0) =>
          new Promise<void>((res) => {
            const http = server as unknown as HttpServer;
            let timer: NodeJS.Timeout | undefined;
            server.close(() => {
              if (timer) clearTimeout(timer);
              res();
            });
            http.closeIdleConnections?.();
            if (graceMs <= 0) http.closeAllConnections?.();
            else {
              timer = setTimeout(() => http.closeAllConnections?.(), graceMs);
              timer.unref();
            }
          }),
      });
    });
    server.once("error", reject);
  });
}
