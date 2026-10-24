// Smoke test: a throw-away multi-user server (local JWT issuer, TEST_DATABASE_URL) on a random port.
// Health, JWT REST, mcp token creation, MCP tools, and the credential-kind separation. Never touches ~/.mnemonis;
// every row it creates is removed at the end.
import { randomUUID } from "node:crypto";
import { createPgAudit } from "../src/audit.js";
import { createAccountService } from "../src/auth/accounts.js";
import { createJwtVerifier } from "../src/auth/jwt.js";
import { createUserDirectory } from "../src/auth/users.js";
import { createPool } from "../src/db/pool.js";
import { startHttpServer } from "../src/http/server.js";
import { createMemoryServices } from "../src/service/memoryService.js";
import { PgStore } from "../src/store/pgStore.js";
import { AUDIENCE, ISSUER, makeKey, resolverFor, signToken } from "../test/jwtFixtures.js";

const dbUrl = process.env.TEST_DATABASE_URL;
if (!dbUrl) {
  console.error("TEST_DATABASE_URL is not set (the smoke test uses a throw-away database, never DATABASE_URL).");
  process.exit(1);
}

const tag = randomUUID().slice(0, 8);
const sub = `smoke-${tag}`;
const email = `smoke-${tag}@smoke.example.test`;
const pool = createPool({ connectionString: dbUrl });
const store = new PgStore(pool);
const audit = createPgAudit(pool);
const key = await makeKey(`k-${tag}`);
const cfg = { authIssuer: ISSUER, authJwksUrl: `${ISSUER}/.well-known/jwks.json`, authAudience: AUDIENCE, authAlgs: ["ES256"] };
const server = await startHttpServer({
  services: createMemoryServices({ store }),
  audit,
  verifier: createJwtVerifier(cfg, { keyResolver: resolverFor(key) }),
  directory: createUserDirectory(pool, store, { signupMode: "open", allowedEmails: [] }),
  accounts: createAccountService(pool, { maxMcpTokens: 20 }),
  allowedOrigins: ["http://localhost:5173"],
  host: "127.0.0.1",
  port: 0,
});
const base = `http://127.0.0.1:${server.port}`;
let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed = true;
};

try {
  const jwt = await signToken(key, { sub, email, email_verified: true });
  const jwtAuth = { Authorization: `Bearer ${jwt}` };

  const health = await fetch(`${base}/api/health`);
  const healthText = await health.text();
  check("GET /api/health (no auth) is exactly {ok:true}", health.status === 200 && healthText === '{"ok":true}', healthText);

  check("GET /api/state without credentials -> 401", (await fetch(`${base}/api/state`)).status === 401);

  const state = await fetch(`${base}/api/state`, { headers: jwtAuth });
  const stateBody = (await state.json()) as { rev: number };
  check("JWT GET /api/state (first login provisions the user)", state.status === 200 && stateBody.rev === 0, `rev=${stateBody.rev}`);

  const minted = await fetch(`${base}/api/tokens`, { method: "POST", headers: { ...jwtAuth, "Content-Type": "application/json" }, body: JSON.stringify({ label: "smoke" }) });
  const mintedBody = (await minted.json()) as { token: string };
  check("JWT POST /api/tokens creates an mcp token", minted.status === 201 && mintedBody.token?.startsWith("mn_"));
  const mcpAuth = { Authorization: `Bearer ${mintedBody.token}` };

  const mcpHeaders = { ...mcpAuth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const rpc = async (body: unknown) => (await fetch(`${base}/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify(body) })).json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
  const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  check("MCP tools/list with the mcp token", tools.result.tools.length === 11, `${tools.result.tools.length} tools`);
  const call = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_save", arguments: { title: "From MCP" } } });
  const payload = JSON.parse(call.result.content[0].text);
  check("MCP memory_save is pending", !call.result.isError && payload.status === "pending", payload.message);

  const jwtOnMcp = await fetch(`${base}/mcp`, { method: "POST", headers: { ...jwtAuth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
  check("JWT on /mcp -> 401", jwtOnMcp.status === 401);

  const approveBody = JSON.stringify({ revisionId: payload.revisionId });
  const mcpApprove = await fetch(`${base}/api/ops/approve`, { method: "POST", headers: { ...mcpAuth, "Content-Type": "application/json" }, body: approveBody });
  check("mcp token on /api/ops/approve -> 401", mcpApprove.status === 401);

  const approve = await fetch(`${base}/api/ops/approve`, { method: "POST", headers: { ...jwtAuth, "Content-Type": "application/json" }, body: approveBody });
  check("JWT approve works", approve.status === 200, `status ${approve.status}`);
} finally {
  await server.close();
  await audit.flush();
  // audit_log.user_id is ON DELETE SET NULL, so delete this run's audit rows before the user (tokens/workspace cascade).
  await pool.query("DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE auth_subject = $1)", [sub]);
  await pool.query("DELETE FROM users WHERE auth_subject = $1", [sub]);
  await pool.end();
}
console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE OK");
process.exit(failed ? 1 : 0);
