import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditLog } from "../src/audit.js";
import { ensureToken, readToken } from "../src/auth/token.js";
import { startHttpServer, type RunningServer } from "../src/http/server.js";
import { createRateLimiter, type RateLimiter } from "../src/service/guards.js";
import { createMemoryService, type MemoryService } from "../src/service/memoryService.js";
import { FileStore } from "../src/store/fileStore.js";

export interface TestServer {
  dir: string;
  token: string;
  url: string;
  port: number;
  service: MemoryService;
  store: FileStore;
  server: RunningServer;
  headers(extra?: Record<string, string>): Record<string, string>;
  api(path: string, init?: RequestInit): Promise<Response>;
  op(name: string, body?: unknown): Promise<Response>;
  close(): Promise<void>;
}

export async function startTestServer(
  opts: { maxPending?: number; limiter?: RateLimiter; userName?: string; allowedOrigins?: string[] } = {},
): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "mnemonis-http-"));
  const store = FileStore.open({ dir });
  const { token } = ensureToken(dir);
  const service = createMemoryService({ store });
  const server = await startHttpServer({
    service,
    audit: createAuditLog(dir),
    getToken: () => readToken(dir),
    allowedOrigins: opts.allowedOrigins ?? ["http://localhost:5173"],
    limiter: opts.limiter ?? createRateLimiter(),
    maxPending: opts.maxPending,
    userName: opts.userName,
    host: "127.0.0.1",
    port: 0,
  });
  const url = `http://127.0.0.1:${server.port}`;
  const headers = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${url}${path}`, { ...init, headers: headers(init.headers as Record<string, string>) });
  return {
    dir,
    token,
    url,
    port: server.port,
    service,
    store,
    server,
    headers,
    api,
    op: (name, body = {}) =>
      api(`/api/ops/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    async close() {
      await server.close();
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Raw HTTP request so the Host header can be forged (fetch hides it). */
export function rawRequest(
  port: number,
  opts: { path: string; method?: string; host: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: opts.path, method: opts.method ?? "GET", headers: { ...opts.headers, Host: opts.host } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
