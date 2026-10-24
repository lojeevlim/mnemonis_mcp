import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import type pg from "pg";
import { createPgAudit, type PgAudit } from "../src/audit.js";
import { createAccountService, type AccountService } from "../src/auth/accounts.js";
import { createToken } from "../src/auth/apiTokens.js";
import { createJwtVerifier, type JwtVerifier } from "../src/auth/jwt.js";
import { createUserDirectory } from "../src/auth/users.js";
import type { SignupMode } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import type { FailureLimiter } from "../src/http/auth.js";
import { startHttpServer, type RunningServer } from "../src/http/server.js";
import { createRateLimiter, type RateLimiter } from "../src/service/guards.js";
import { createMemoryServices, type MemoryService, type MemoryServices } from "../src/service/memoryService.js";
import { PgStore } from "../src/store/pgStore.js";
import { AUDIENCE, ISSUER, makeKey, resolverFor, signToken, type TestKey } from "./jwtFixtures.js";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;

export interface TestUser {
  id: string;
  sub: string;
  email: string;
  displayName: string;
  /** A valid access token for this user (JWT). */
  jwt: string;
  service: MemoryService;
  /** Authorization header with the JWT (REST). */
  headers(extra?: Record<string, string>): Record<string, string>;
  api(path: string, init?: RequestInit): Promise<Response>;
  op(name: string, body?: unknown): Promise<Response>;
  /** Mints a fresh MCP token straight in the database (the plaintext is returned once). */
  mcpToken(label?: string): Promise<{ id: string; token: string }>;
  /** Authorization header with an MCP token (/mcp). */
  mcpHeaders(token: string, extra?: Record<string, string>): Record<string, string>;
}

export interface TestServer {
  url: string;
  port: number;
  pool: pg.Pool;
  store: PgStore;
  services: MemoryServices;
  audit: PgAudit;
  accounts: AccountService;
  key: TestKey;
  /** Unique per server; every user/email created by this server (also via HTTP) carries it. */
  tag: string;
  server: RunningServer;
  a: TestUser;
  b: TestUser;
  /** Signs a JWT for any claims (sub is namespaced with the tag when `plainSub` is not set). */
  sign(claims: Record<string, unknown>, o?: Parameters<typeof signToken>[2]): Promise<string>;
  /** User A shortcuts (the old single-user API). */
  api: TestUser["api"];
  op: TestUser["op"];
  headers: TestUser["headers"];
  service: MemoryService;
  close(): Promise<void>;
}

export interface TestServerOptions {
  maxPending?: number;
  limiter?: RateLimiter;
  failureLimiter?: FailureLimiter;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  trustProxy?: boolean;
  signupMode?: SignupMode;
  allowedEmails?: string[];
  maxMcpTokens?: number;
  /** Replace the pool used by the HTTP layer (e.g. a broken one for 503 tests). Data setup still uses the real DB. */
  httpPool?: pg.Pool;
  accounts?: (real: AccountService) => AccountService;
  audit?: PgAudit;
  /** Replace the JWT verifier (e.g. one whose key source is down). */
  verifier?: JwtVerifier;
}

/** A real multi-user server on an ephemeral port against TEST_DATABASE_URL, with users A and B pre-provisioned. */
export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  if (!TEST_DB_URL) throw new Error("TEST_DATABASE_URL is not set");
  const pool = createPool({ connectionString: TEST_DB_URL, max: 8 });
  const tag = randomUUID().slice(0, 8);
  const key = await makeKey(`k-${tag}`);
  const store = new PgStore(pool);
  const services = createMemoryServices({ store });
  const audit = opts.audit ?? createPgAudit(pool);
  const httpPool = opts.httpPool ?? pool;
  const httpStore = opts.httpPool ? new PgStore(opts.httpPool) : store;
  const cfg = { authIssuer: ISSUER, authJwksUrl: `${ISSUER}/.well-known/jwks.json`, authAudience: AUDIENCE, authAlgs: ["ES256"] };
  const realAccounts = createAccountService(httpPool, { maxMcpTokens: opts.maxMcpTokens ?? 20 });
  const accounts = opts.accounts ? opts.accounts(realAccounts) : realAccounts;
  const server = await startHttpServer({
    services: opts.httpPool ? createMemoryServices({ store: httpStore }) : services,
    audit,
    verifier: opts.verifier ?? createJwtVerifier(cfg, { keyResolver: resolverFor(key) }),
    directory: createUserDirectory(httpPool, httpStore, { signupMode: opts.signupMode ?? "closed", allowedEmails: opts.allowedEmails ?? [] }),
    accounts,
    allowedOrigins: opts.allowedOrigins ?? ["http://localhost:5173"],
    allowedHosts: opts.allowedHosts,
    trustProxy: opts.trustProxy,
    limiter: opts.limiter ?? createRateLimiter(),
    // Every test request comes from 127.0.0.1: keep the pre-auth limiter out of the way unless a test sets one.
    failureLimiter: opts.failureLimiter ?? { blocked: () => false, fail: () => undefined },
    maxPending: opts.maxPending,
    host: "127.0.0.1",
    port: 0,
  });
  const url = `http://127.0.0.1:${server.port}`;

  const sign = (claims: Record<string, unknown>, o?: Parameters<typeof signToken>[2]) => signToken(key, claims, o);

  const makeUser = async (name: string): Promise<TestUser> => {
    const sub = `${tag}-${name}`;
    const email = `${name}-${tag}@${tag}.example.test`;
    const displayName = `User ${name.toUpperCase()}`;
    const row = await pool.query<{ id: string }>("INSERT INTO users (email, display_name, auth_subject) VALUES ($1, $2, $3) RETURNING id", [email, displayName, sub]);
    const id = row.rows[0]!.id;
    await store.ensureWorkspace(id);
    const jwt = await sign({ sub, email, email_verified: true });
    const headers = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${jwt}`, ...extra });
    const api = (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, { ...init, headers: headers(init.headers as Record<string, string>) });
    return {
      id,
      sub,
      email,
      displayName,
      jwt,
      service: services.forUser(id),
      headers,
      api,
      op: (op, body = {}) => api(`/api/ops/${op}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      async mcpToken(label = "test") {
        const r = await createToken(pool, id, { label });
        if (!r.ok) throw new Error(`token creation failed: ${r.reason}`);
        return { id: r.id, token: r.token };
      },
      mcpHeaders: (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra }),
    };
  };

  const a = await makeUser("a");
  const b = await makeUser("b");
  let closed = false;
  return {
    url,
    port: server.port,
    pool,
    store,
    services,
    audit,
    accounts,
    key,
    tag,
    server,
    a,
    b,
    sign,
    api: a.api,
    op: a.op,
    headers: a.headers,
    service: a.service,
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
      await audit.flush();
      // audit_log.user_id is ON DELETE SET NULL: remove this server's rows first so none are left behind.
      const ids = `SELECT id FROM users WHERE auth_subject LIKE $1`;
      await pool.query(`DELETE FROM audit_log WHERE user_id IN (${ids})`, [`${tag}-%`]);
      await pool.query("DELETE FROM users WHERE auth_subject LIKE $1 OR email LIKE $2", [`${tag}-%`, `%@${tag}.example.test`]); // cascades tokens + workspaces
      await pool.end();
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

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

/** Connects an MCP SDK client to /mcp with the given headers; the caller closes it. */
export async function connectMcp(url: string, headers: Record<string, string>, name = "test-agent"): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } }));
  return client;
}

export async function callTool(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as ToolResult;
  const data = JSON.parse(r.content[0].text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { isError: r.isError === true, data, raw: r.content[0].text };
}
