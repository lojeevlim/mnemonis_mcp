import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe as baseDescribe, expect, it } from "vitest";
import { createFailureLimiter } from "../src/http/auth.js";
import { startTestAdapter } from "./adapterHelpers.js";
import { startTestServer, TEST_DB_URL } from "./helpers.js";

const describe = baseDescribe.skipIf(!TEST_DB_URL);

/** MCP client -> adapter -> real API -> test database: the whole chain with nothing faked. */
const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const x of open.splice(0).reverse()) await x.close().catch(() => undefined);
});

async function setup(opts: Parameters<typeof startTestServer>[0] = {}) {
  const t = await startTestServer(opts);
  const adapter = await startTestAdapter(t.url);
  open.push({ close: () => t.close() }, { close: () => adapter.close() });
  const mcpUrl = `http://127.0.0.1:${adapter.port}/mcp`;
  const connect = async (token: string, name = "e2e-agent") => {
    const c = new Client({ name, version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    open.push({ close: () => c.close() });
    return c;
  };
  const raw = (token: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(mcpUrl, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
  return { t, adapter, mcpUrl, connect, raw };
}
const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const callBody = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_status", arguments: {} } };

describe("adapter end to end", () => {
  it("a save through MCP is pending in the user's REST state and appears for the agent only after the user approves it", async () => {
    const { t, connect } = await setup();
    const { token } = await t.a.mcpToken();
    const c = await connect(token, "e2e-claude");
    const saved = text(await c.callTool({ name: "memory_save", arguments: { title: "E2E", content: "through the adapter" } }));
    expect(saved.status).toBe("pending");
    const state = (await (await t.api("/api/state")).json()) as { state: { revisions: Record<string, { status: string; origin: string; author: string }> } };
    expect(state.state.revisions[saved.revisionId]).toMatchObject({ status: "pending", origin: "agent", author: "e2e-claude" });
    expect(text(await c.callTool({ name: "memory_list", arguments: {} })).memories).toEqual([]);
    expect((await t.op("approve", { revisionId: saved.revisionId })).status).toBe(200);
    expect(text(await c.callTool({ name: "memory_list", arguments: {} })).memories.map((m: { title: string }) => m.title)).toEqual(["E2E"]);
  });

  it("a revoked token is HTTP 401 on initialize, tools/list and tools/call, immediately and with no cache", async () => {
    const { t, connect, raw } = await setup();
    const { token, id } = await t.a.mcpToken();
    const c = await connect(token);
    expect((await c.listTools()).tools).toHaveLength(11);
    for (const body of [init, list, callBody]) expect((await raw(token, body)).status).toBe(200);
    expect((await t.a.api(`/api/tokens/${id}`, { method: "DELETE" })).status).toBe(204);
    for (const body of [init, list, callBody]) {
      const r = await raw(token, body);
      expect(r.status, JSON.stringify(body.method)).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe('Bearer realm="mnemonis"');
    }
    await expect(c.callTool({ name: "memory_status", arguments: {} })).rejects.toThrow();
  });

  it("no, wrong-shaped, session and foreign tokens are all the same 401", async () => {
    const { t, raw } = await setup();
    for (const token of [t.a.session, `mn_${"Z".repeat(43)}`, "mn_short", ""]) {
      const r = await raw(token, init);
      expect(r.status, token.slice(0, 6)).toBe(401);
    }
    expect((await fetch(`${t.url}/api/agent/ping`)).status).toBe(401); // and the API itself, directly
  });

  it("users are isolated through the adapter", async () => {
    const { t, connect } = await setup();
    const a = await connect((await t.a.mcpToken()).token);
    const b = await connect((await t.b.mcpToken()).token);
    const saved = text(await a.callTool({ name: "memory_save", arguments: { title: "A only" } }));
    expect(text(await b.callTool({ name: "memory_status", arguments: {} })).pending.total).toBe(0);
    const r = text(await b.callTool({ name: "memory_diff", arguments: { revisionId: saved.revisionId } }));
    expect(r.error.code).toMatch(/not_found/);
  });

  it("a disabled account's token is refused", async () => {
    const { t, raw } = await setup();
    const { token } = await t.a.mcpToken();
    expect((await raw(token, init)).status).toBe(200);
    await t.pool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [t.a.id]);
    expect((await raw(token, init)).status).toBe(401);
  });

  it("the API's own failure limiter surfaces as HTTP 429 + Retry-After through the adapter", async () => {
    const { raw } = await setup({ agentFailureLimiter: createFailureLimiter({ max: 2, windowMs: 60_000 }) });
    const bad = `mn_${"Q".repeat(43)}`;
    expect((await raw(bad, init)).status).toBe(401);
    expect((await raw(bad, init)).status).toBe(401);
    const r = await raw(bad, init);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
  });

  it("API write guards reach the model as tool errors (inbox_full, rate_limited)", async () => {
    const { t, connect } = await setup({ maxPending: 1 });
    const c = await connect((await t.a.mcpToken()).token);
    expect(text(await c.callTool({ name: "memory_save", arguments: { title: "1" } })).status).toBe("pending");
    const full = (await c.callTool({ name: "memory_save", arguments: { title: "2" } })) as { isError?: boolean };
    expect(full.isError).toBe(true);
    expect(text(full).error.code).toBe("inbox_full");
  });
});
