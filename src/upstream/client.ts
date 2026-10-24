import http from "node:http";
import https from "node:https";

export const MAX_UPSTREAM_RESPONSE_BYTES = 5 * 1024 * 1024;
export const CONNECT_TIMEOUT_MS = 2000;
export const CONTRACT_VERSION = 1;

/** The ONLY headers the adapter sends upstream. Anything else a client sent is dropped by construction. */
export interface UpstreamHeaders {
  /** The caller's Authorization header, verbatim. Omitted only for the public contract endpoint. */
  authorization?: string;
  /** Sanitised printable ASCII, <= 100 chars; omitted when empty. */
  client?: string;
  requestId: string;
  /** A single client IP literal resolved by the adapter (never a client-supplied list). */
  forwardedFor?: string;
}

export interface UpstreamRequest {
  method: "GET" | "POST";
  /** Path below the API base, e.g. /api/agent/memory/save. */
  path: string;
  /** JSON text for POST. */
  body?: string;
  headers: UpstreamHeaders;
  /** Picks the timeout and the retry rule (writes are never retried). */
  kind: "read" | "write";
  /** Contract version header value (default 1). */
  contract?: number;
}

export type UpstreamResult =
  | { kind: "ok"; body: Record<string, unknown> }
  /** A non-200 HTTP response. `body` is the parsed JSON when there was one. */
  | { kind: "http"; status: number; body: unknown; retryAfter: number | null }
  /** No usable response: refused, reset, DNS, connect timeout. */
  | { kind: "network" }
  /** The overall read/write timeout elapsed. */
  | { kind: "timeout" }
  /** Redirect, oversize response, invalid JSON or not JSON: treated as a configuration problem. */
  | { kind: "malformed" };

export interface UpstreamOptions {
  apiUrl: string;
  readTimeoutMs: number;
  writeTimeoutMs: number;
  connectTimeoutMs?: number;
  maxResponseBytes?: number;
  /** MNEMONIS_ADAPTER_SECRET: sent on every upstream call as X-Mnemonis-Adapter-Secret (never logged). */
  adapterSecret?: string | null;
  /** Delay before the single retry of a read (default 50-200 ms of jitter). */
  retryDelayMs?: () => number;
}

export interface Upstream {
  request(req: UpstreamRequest): Promise<UpstreamResult>;
  close(): void;
}

const RETRY_STATUSES = new Set([502, 503, 504]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createUpstream(opts: UpstreamOptions): Upstream {
  const base = new URL(opts.apiUrl);
  const secure = base.protocol === "https:";
  const agent = secure ? new https.Agent({ keepAlive: true, maxSockets: 64 }) : new http.Agent({ keepAlive: true, maxSockets: 64 });
  const connectTimeout = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const maxBytes = opts.maxResponseBytes ?? MAX_UPSTREAM_RESPONSE_BYTES;
  const retryDelay = opts.retryDelayMs ?? (() => 50 + Math.random() * 150);

  const once = (req: UpstreamRequest): Promise<UpstreamResult> =>
    new Promise((resolve) => {
      let settled = false;
      const done = (r: UpstreamResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(total);
        clearTimeout(connectTimer);
        resolve(r);
      };
      const h = req.headers;
      const headers: Record<string, string> = {
        Accept: "application/json",
        "X-Mnemonis-Contract": String(req.contract ?? CONTRACT_VERSION),
        "X-Request-Id": h.requestId,
      };
      if (h.authorization !== undefined) headers.Authorization = h.authorization;
      if (h.client) headers["X-Mnemonis-Client"] = h.client;
      if (opts.adapterSecret) headers["X-Mnemonis-Adapter-Secret"] = opts.adapterSecret;
      if (h.forwardedFor) headers["X-Forwarded-For"] = h.forwardedFor;
      if (req.body !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = String(Buffer.byteLength(req.body));
      }
      const basePath = base.pathname.replace(/\/+$/, "");
      const call = (secure ? https : http).request(
        { protocol: base.protocol, hostname: base.hostname.replace(/^\[(.*)\]$/, "$1"), port: base.port || undefined, path: `${basePath}${req.path}`, method: req.method, headers, agent },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            call.destroy();
            return done({ kind: "malformed" }); // redirect: "error", never followed
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (d: Buffer) => {
            size += d.length;
            if (size > maxBytes) {
              call.destroy();
              return done({ kind: "malformed" });
            }
            chunks.push(d);
          });
          res.on("error", () => done({ kind: "network" }));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown;
            try {
              parsed = text === "" ? undefined : JSON.parse(text);
            } catch {
              parsed = undefined;
            }
            if (status === 200) {
              const isJson = /^application\/json/i.test(String(res.headers["content-type"] ?? ""));
              return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && isJson
                ? done({ kind: "ok", body: parsed as Record<string, unknown> })
                : done({ kind: "malformed" });
            }
            const ra = Number.parseInt(String(res.headers["retry-after"] ?? ""), 10);
            done({ kind: "http", status, body: parsed, retryAfter: Number.isFinite(ra) && ra >= 0 ? ra : null });
          });
        },
      );
      const total = setTimeout(
        () => {
          call.destroy();
          done({ kind: "timeout" });
        },
        req.kind === "write" ? opts.writeTimeoutMs : opts.readTimeoutMs,
      );
      let connectTimer: NodeJS.Timeout = setTimeout(() => undefined, 0);
      call.on("socket", (socket) => {
        if (!socket.connecting) return;
        clearTimeout(connectTimer);
        connectTimer = setTimeout(() => {
          call.destroy();
          done({ kind: "network" });
        }, connectTimeout);
        socket.once("connect", () => clearTimeout(connectTimer));
      });
      call.on("error", () => done({ kind: "network" }));
      if (req.body !== undefined) call.write(req.body);
      call.end();
    });

  return {
    async request(req) {
      const first = await once(req);
      // Reads (and the ping preflight) are retried once on connect errors / 502 / 503 / 504; never on 4xx or 429; writes never.
      const retryable = first.kind === "network" || (first.kind === "http" && RETRY_STATUSES.has(first.status));
      if (req.kind === "read" && retryable) {
        await sleep(retryDelay());
        return once(req);
      }
      return first;
    },
    close() {
      agent.destroy();
    },
  };
}
