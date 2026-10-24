import type { UpstreamResult } from "./client.js";

export type Outcome =
  | { type: "data"; data: Record<string, unknown> }
  | { type: "toolError"; error: { code: string; message: string } }
  /** Upstream said 401: the MCP request itself must be answered with HTTP 401. */
  | { type: "unauthorized" }
  /** Upstream said 429 too_many_failed_attempts: answer HTTP 429 + Retry-After. */
  | { type: "tooMany"; retryAfter: number };

export const MAX_ERROR_MESSAGE = 500;
const TOOL_ERROR_STATUSES = new Set([400, 404, 409, 413, 422]);

export const CONFIG_PROBLEM = "Mnemonis server configuration problem";
export const UNAVAILABLE = "The Mnemonis API is unavailable. Try again shortly.";
export const WRITE_TIMEOUT = "The Mnemonis API did not answer in time. The proposal may or may not have been recorded; call memory_status before retrying.";

const clip = (s: string) => (s.length > MAX_ERROR_MESSAGE ? s.slice(0, MAX_ERROR_MESSAGE) : s);
const errorOf = (body: unknown): { code: string; message: string } | null => {
  const e = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  return e && typeof e.code === "string" && typeof e.message === "string" ? { code: e.code, message: e.message } : null;
};
const toolError = (code: string, message: string): Outcome => ({ type: "toolError", error: { code, message: clip(message) } });

/**
 * Maps one upstream result of a tool call to what the MCP client gets (table: architecture 5, "Adapter mapping").
 * `log` receives a class-only line for the operator (never a token, body or message from the API).
 */
export function mapToolResult(r: UpstreamResult, ctx: { kind: "read" | "write"; log: (line: string) => void }): Outcome {
  switch (r.kind) {
    case "ok":
      return { type: "data", data: r.body };
    case "network":
      return toolError("upstream_unavailable", UNAVAILABLE);
    case "timeout":
      return ctx.kind === "write" ? toolError("upstream_timeout", WRITE_TIMEOUT) : toolError("upstream_unavailable", UNAVAILABLE);
    case "malformed":
      ctx.log("upstream response malformed");
      return toolError("internal", CONFIG_PROBLEM);
    case "http": {
      const e = errorOf(r.body);
      if (r.status === 401) return { type: "unauthorized" };
      if (r.status === 429) {
        if (e?.code === "too_many_failed_attempts") return { type: "tooMany", retryAfter: r.retryAfter ?? 60 };
        return e ? toolError(e.code, e.message) : toolError("rate_limited", "Too many requests. Try again later.");
      }
      if (TOOL_ERROR_STATUSES.has(r.status) && e) return toolError(e.code, e.message);
      if (r.status >= 500) return toolError("upstream_unavailable", UNAVAILABLE);
      ctx.log(`upstream refused the request with status ${r.status}`);
      return toolError("internal", CONFIG_PROBLEM);
    }
  }
}

export type Preflight = { type: "ok" } | { type: "unauthorized" } | { type: "tooMany"; retryAfter: number } | { type: "unavailable" };

/** Maps the GET /api/agent/ping result: only 200 continues; a refusal of the credential is HTTP 401; everything else is HTTP 503. */
export function mapPreflight(r: UpstreamResult): Preflight {
  if (r.kind === "ok") return { type: "ok" };
  if (r.kind === "http") {
    if (r.status === 401) return { type: "unauthorized" };
    if (r.status === 429 && errorOf(r.body)?.code === "too_many_failed_attempts") return { type: "tooMany", retryAfter: r.retryAfter ?? 60 };
  }
  return { type: "unavailable" };
}
