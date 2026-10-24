// Smoke test: real server on a random port with a temp data dir; health + one REST op + one MCP tool call.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditLog } from "../src/audit.js";
import { ensureToken, readToken } from "../src/auth/token.js";
import { startHttpServer } from "../src/http/server.js";
import { createMemoryService } from "../src/service/memoryService.js";
import { FileStore } from "../src/store/fileStore.js";

const dir = mkdtempSync(join(tmpdir(), "mnemonis-smoke-"));
const store = FileStore.open({ dir });
const { token } = ensureToken(dir);
const server = await startHttpServer({
  service: createMemoryService({ store }),
  audit: createAuditLog(dir),
  getToken: () => readToken(dir),
  allowedOrigins: ["http://localhost:5173"],
  host: "127.0.0.1",
  port: 0,
});
const base = `http://127.0.0.1:${server.port}`;
const auth = { Authorization: `Bearer ${token}` };
let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failed = true;
};

try {
  const health = await fetch(`${base}/api/health`);
  check("GET /api/health (no auth)", health.status === 200, await health.text());

  const noAuth = await fetch(`${base}/api/state`);
  check("GET /api/state without token -> 401", noAuth.status === 401);

  const op = await fetch(`${base}/api/ops/createMemory`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Smoke memory", content: "hello" }),
  });
  const opBody = (await op.json()) as { rev: number; value: { status: string } };
  check("POST /api/ops/createMemory", op.status === 200 && opBody.value.status === "saved", `rev=${opBody.rev}`);

  const mcpHeaders = { ...auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const rpc = async (body: unknown) => (await fetch(`${base}/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify(body) })).json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
  const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  check("MCP tools/list", tools.result.tools.length === 11, `${tools.result.tools.length} tools`);
  const call = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_save", arguments: { title: "From MCP" } } });
  const payload = JSON.parse(call.result.content[0].text);
  check("MCP memory_save is pending", !call.result.isError && payload.status === "pending", payload.message);
} finally {
  await server.close();
  await store.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE OK");
process.exit(failed ? 1 : 0);
