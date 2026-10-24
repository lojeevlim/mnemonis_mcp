import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { tokenId, verifyToken } from "../auth/token.js";
import type { AuditLog } from "../audit.js";
import { createMcpHandler } from "../mcp/server.js";
import { createRateLimiter, type RateLimiter } from "../service/guards.js";
import type { MemoryService } from "../service/memoryService.js";
import { corsGuard, deny, errorBody, hostGuard } from "./cors.js";
import { healthBody, MAX_BODY_BYTES, registerRest, tooBig } from "./rest.js";

export interface AppOptions {
  service: MemoryService;
  audit: AuditLog;
  /** Current token (read per request so `npm run token -- --rotate` takes effect at once). */
  getToken: () => string | null;
  allowedOrigins: string[];
  getPort: () => number;
  userName?: string;
  limiter?: RateLimiter;
  maxPending?: number;
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();
  const guard = { allowedOrigins: opts.allowedOrigins, getPort: opts.getPort };
  const limiter = opts.limiter ?? createRateLimiter();

  app.use("*", hostGuard(guard));
  app.use("*", corsGuard(guard));
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    if (c.req.path === "/api/health") return next();
    const token = opts.getToken();
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
    if (!m || !verifyToken(m[1], token)) {
      c.header("WWW-Authenticate", 'Bearer realm="mnemonis"');
      return deny(c, 401, "unauthorized", "Missing or invalid bearer token");
    }
    await next();
  });

  app.get("/api/health", async (c) => c.json(healthBody((await opts.service.getState()).rev)));

  registerRest(app, { service: opts.service, audit: opts.audit, userName: opts.userName });

  const mcp = createMcpHandler({ service: opts.service, audit: opts.audit, limiter, maxPending: opts.maxPending });
  app.all("/mcp", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooBig }), (c) => {
    const token = opts.getToken();
    return mcp(c, token ? tokenId(token) : "none");
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
  close(): Promise<void>;
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
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
            (server as unknown as HttpServer).closeAllConnections?.();
          }),
      });
    });
    server.once("error", reject);
  });
}
