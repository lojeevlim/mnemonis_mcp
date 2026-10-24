import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createClientNames, sanitizeClientName } from "../clientNames.js";
import type { AdapterConfig } from "../config.js";
import { watchContract, type ContractWatcher } from "../contract.js";
import {
  bearerValue,
  clientBucket,
  clientIp,
  createFailureLimiter,
  errorBody,
  hostGuard,
  originGuard,
  plausibleBearer,
  type FailureLimiter,
} from "../http/guards.js";
import { createUpstream, type Upstream } from "../upstream/client.js";
import { mapPreflight, mapToolResult, type Outcome } from "../upstream/errors.js";
import { READ_TOOLS, TOOL_NAMES, TOOL_SCHEMAS, toolPath, type ToolName } from "./schemas.js";
import { SERVER_INSTRUCTIONS, TOOL_META, UNTRUSTED_NOTICE } from "./tools.js";

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const WWW_AUTHENTICATE = 'Bearer realm="mnemonis"';

export interface AdapterOptions {
  config: AdapterConfig;
  upstream?: Upstream;
  failureLimiter?: FailureLimiter;
  /** Operator log sink (class-only lines: never tokens, bodies or API messages). */
  log?: (line: string) => void;
  /** Skip the startup contract check (unit tests that fake the whole API). */
  watchContract?: boolean;
}

export interface Adapter {
  app: Hono;
  contract: ContractWatcher | null;
  close(): void;
}

/** Per-MCP-request state shared with the tool handlers; it is how a tool-level 401 becomes an HTTP 401. */
interface RequestCtx {
  authorization: string;
  clientName: string;
  requestId: string;
  forwardedFor: string | undefined;
  unauthorized: boolean;
  tooMany: number | null;
}

/** `notice` always comes first and is always the adapter's: an upstream field of that name can neither replace nor precede it. */
const toolJson = (data: Record<string, unknown>, isError = false): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ notice: UNTRUSTED_NOTICE, ...Object.fromEntries(Object.entries(data).filter(([k]) => k !== "notice")) }) }],
  ...(isError ? { isError: true } : {}),
});

function initializeName(messages: unknown[]): string | null {
  for (const m of messages) {
    if (m && typeof m === "object" && (m as { method?: unknown }).method === "initialize") {
      const n = (m as { params?: { clientInfo?: { name?: unknown } } }).params?.clientInfo?.name;
      return typeof n === "string" ? n : null;
    }
  }
  return null;
}

/** A tools/call the adapter can send upstream as-is: known tool, arguments valid for it (then the API call IS the auth check). */
function isForwardableToolCall(m: unknown): boolean {
  if (!m || typeof m !== "object" || (m as { method?: unknown }).method !== "tools/call") return false;
  const p = (m as { params?: { name?: unknown; arguments?: unknown } }).params;
  const name = p?.name;
  if (typeof name !== "string" || !(TOOL_NAMES as readonly string[]).includes(name)) return false;
  return TOOL_SCHEMAS[name as ToolName].safeParse(p?.arguments ?? {}).success;
}

export function createAdapter(opts: AdapterOptions): Adapter {
  const { config } = opts;
  const log = opts.log ?? ((l: string) => console.error(l));
  const upstream =
    opts.upstream ?? createUpstream({ apiUrl: config.apiUrl, readTimeoutMs: config.readTimeoutMs, writeTimeoutMs: config.writeTimeoutMs, adapterSecret: config.adapterSecret });
  const failures = opts.failureLimiter ?? createFailureLimiter();
  const names = createClientNames();
  const contract = opts.watchContract === false ? null : watchContract(upstream, { log });
  let actualPort = config.port;
  const app = new Hono();

  app.use("*", hostGuard({ getPort: () => actualPort, allowedHosts: config.allowedHosts }));
  app.use("*", originGuard(config.allowedOrigins));
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/healthz", (c) => {
    const s = contract?.state() ?? { status: "ok" as const };
    return s.status === "ok" ? c.json({ ok: true }) : c.json({ ok: false, status: s.status }, 503);
  });

  const unauthorized = (c: import("hono").Context) => {
    c.header("WWW-Authenticate", WWW_AUTHENTICATE);
    return c.json(errorBody("unauthorized", "Missing or invalid credentials"), 401);
  };
  const tooMany = (c: import("hono").Context, retryAfter: number) => {
    c.header("Retry-After", String(retryAfter));
    return c.json(errorBody("too_many_failed_attempts", "Too many failed attempts. Try again later."), 429);
  };

  const forward = async (name: ToolName, args: Record<string, unknown>, ctx: RequestCtx): Promise<CallToolResult> => {
    if (ctx.unauthorized || ctx.tooMany !== null) return toolJson({ error: { code: "internal", message: "Request aborted" } }, true);
    const kind = READ_TOOLS.includes(name) ? "read" : "write";
    const r = await upstream.request({
      method: "POST",
      path: `/api/agent${toolPath(name)}`,
      body: JSON.stringify(args),
      kind,
      headers: { authorization: ctx.authorization, client: ctx.clientName, requestId: ctx.requestId, forwardedFor: ctx.forwardedFor },
    });
    const out: Outcome = mapToolResult(r, { kind, log: (line) => log(`${line} (tool ${name}, request ${ctx.requestId})`) });
    switch (out.type) {
      case "data":
        return toolJson(out.data);
      case "toolError":
        return toolJson({ error: out.error }, true);
      case "unauthorized":
        ctx.unauthorized = true;
        return toolJson({ error: { code: "unauthorized", message: "Missing or invalid credentials" } }, true);
      case "tooMany":
        ctx.tooMany = out.retryAfter;
        return toolJson({ error: { code: "rate_limited", message: "Too many failed attempts" } }, true);
    }
  };

  const buildServer = (ctx: RequestCtx): McpServer => {
    const server = new McpServer({ name: "mnemonis", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });
    for (const name of TOOL_NAMES) {
      server.registerTool(name, { ...TOOL_META[name], inputSchema: TOOL_SCHEMAS[name] }, ((args: Record<string, unknown>) => forward(name, args, ctx)) as never);
    }
    return server;
  };

  app.post("/mcp", bodyLimit({ maxSize: config.maxBodyBytes, onError: (c) => c.json(errorBody("too_large", "Request body is too large"), 413) }), async (c) => {
    if (contract && contract.state().status === "mismatch") {
      return c.json(errorBody("contract_mismatch", "The Mnemonis API and this adapter speak incompatible contracts"), 503);
    }
    const ip = clientIp(c, config.trustProxy);
    const bucket = clientBucket(ip);
    if (failures.blocked(bucket)) {
      return tooMany(c, 60);
    }
    const authorization = c.req.header("authorization");
    if (!plausibleBearer(authorization)) {
      failures.fail(bucket);
      return unauthorized(c);
    }
    const inboundId = c.req.header("x-request-id");
    const requestId = inboundId !== undefined && REQUEST_ID_RE.test(inboundId) ? inboundId : randomUUID();
    c.header("X-Request-Id", requestId);

    let body: unknown;
    let parseFailed = false;
    try {
      body = await c.req.json();
    } catch {
      parseFailed = true;
    }
    // One JSON-RPC message per HTTP request: a batch would multiply upstream calls (and failures) behind a single request.
    if (!parseFailed && Array.isArray(body)) {
      return c.json({ jsonrpc: "2.0", error: { code: -32600, message: "batch requests are not supported" }, id: null }, 400);
    }
    const messages = parseFailed ? [] : [body];

    const token = bearerValue(authorization);
    const announced = sanitizeClientName(initializeName(messages));
    const ctx: RequestCtx = {
      authorization,
      clientName: announced || names.get(token) || "",
      requestId,
      forwardedFor: ip ?? undefined,
      unauthorized: false,
      tooMany: null,
    };

    // Every request that will not itself reach the API with the caller's credential (initialize, tools/list, notifications,
    // invalid tool calls...) is first checked with GET /api/agent/ping. A tools/call that is forwarded uses its own call.
    const needsPreflight = parseFailed || messages.length === 0 || !messages.every(isForwardableToolCall);
    if (needsPreflight) {
      const pf = mapPreflight(
        await upstream.request({ method: "GET", path: "/api/agent/ping", kind: "read", headers: { authorization, client: ctx.clientName, requestId, forwardedFor: ctx.forwardedFor } }),
      );
      if (pf.type === "unauthorized") {
        failures.fail(bucket);
        return unauthorized(c);
      }
      if (pf.type === "tooMany") return tooMany(c, pf.retryAfter);
      if (pf.type === "unavailable") {
        log(`preflight failed (request ${requestId})`);
        return c.json(errorBody("upstream_unavailable", "The Mnemonis API is unavailable. Try again shortly."), 503);
      }
    }
    if (parseFailed) return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
    if (announced) names.remember(token, announced);

    const server = buildServer(ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const res = await transport.handleRequest(c.req.raw, { parsedBody: body });
      if (ctx.unauthorized) {
        failures.fail(bucket);
        return unauthorized(c);
      }
      if (ctx.tooMany !== null) return tooMany(c, ctx.tooMany);
      // The SDK returns a bare Response: headers set on the Hono context do not reach it, so they are applied here.
      const out = new Response(res.body, res);
      out.headers.set("X-Request-Id", requestId);
      out.headers.set("X-Content-Type-Options", "nosniff");
      out.headers.set("Cache-Control", "no-store");
      return out;
    } finally {
      void server.close().catch(() => undefined);
    }
  });
  app.all("/mcp", (c) => c.json(errorBody("method_not_allowed", "Use POST for /mcp"), 405, { Allow: "POST" }));

  app.notFound((c) => c.json(errorBody("not_found", "Not found"), 404));
  app.onError((e, c) => {
    log(`request failed: ${e instanceof Error ? e.name : "error"}`);
    return c.json(errorBody("internal", "Internal error"), 500);
  });

  // getPort needs the port after listen (PORT 0); startAdapter sets it.
  Object.defineProperty(app, "setPort", { value: (p: number) => (actualPort = p) });
  return {
    app,
    contract,
    close() {
      contract?.stop();
      upstream.close();
    },
  };
}

export interface RunningAdapter {
  port: number;
  adapter: Adapter;
  close(graceMs?: number): Promise<void>;
}

/** Listens on host:port (port 0 = ephemeral). Rejects on listen errors such as EADDRINUSE. */
export function startAdapter(opts: AdapterOptions): Promise<RunningAdapter> {
  const adapter = createAdapter(opts);
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: adapter.app.fetch, hostname: opts.config.host, port: opts.config.port }, (info: AddressInfo) => {
      (adapter.app as unknown as { setPort(p: number): void }).setPort(info.port);
      server.off("error", reject);
      resolve({
        port: info.port,
        adapter,
        close: (graceMs = 0) =>
          new Promise<void>((res) => {
            adapter.close();
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
    server.once("error", (e) => {
      adapter.close();
      reject(e);
    });
  });
}
