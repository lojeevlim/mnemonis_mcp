import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUpstream } from "../src/upstream/client.js";
import { TOOL_NAMES } from "../src/mcp/schemas.js";
import { UNTRUSTED_NOTICE } from "../src/mcp/tools.js";
import { createFailureLimiter } from "../src/http/guards.js";
import { INIT_PARAMS, loadFixtures, MCP_HEADERS, replayFixtures, rpc, startAdapterFor, startFakeApi, TOKEN, type FakeApi } from "./fakeApi.js";

let api: FakeApi;
let adapter: Awaited<ReturnType<typeof startAdapterFor>>;
const clients: Client[] = [];

beforeEach(async () => {
  api = await startFakeApi();
  adapter = await startAdapterFor(api.url);
  api.requests.length = 0; // the startup contract check
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await adapter.close();
  await api.close();
});

async function connect(headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }, name = "fake-client"): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${adapter.url}/mcp`), { requestInit: { headers } }));
  clients.push(client);
  return client;
}
const post = (body: string, headers: Record<string, string> = {}) =>
  fetch(`${adapter.url}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}`, ...headers }, body });
type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = (await c.callTool({ name, arguments: args })) as ToolResult;
  return { isError: r.isError === true, data: JSON.parse(r.content[0]!.text) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const paths = () => api.requests.map((r) => `${r.method} ${r.path}`);

describe("tool surface", () => {
  it("lists exactly the 11 tools, strict, no actor/origin/source, no approve/delete", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      const schema = t.inputSchema as { properties?: Record<string, unknown>; additionalProperties?: unknown };
      expect(schema.additionalProperties).toBe(false);
      for (const k of ["actor", "origin", "provenance", "source", "author", "createdBy"]) expect(Object.keys(schema.properties ?? {})).not.toContain(k);
      expect(t.name).not.toMatch(/approve|reject|delete|commit|branch|restore|rollback/);
    }
    for (const n of ["memory_save", "memory_update", "memory_link", "memory_archive"]) {
      expect(tools.find((t) => t.name === n)?.description).toMatch(/approve/i);
      expect(tools.find((t) => t.name === n)?.annotations?.readOnlyHint).toBe(false);
    }
    expect(tools.find((t) => t.name === "memory_search")?.annotations?.readOnlyHint).toBe(true);
  });
});

describe("replaying the contract fixtures", () => {
  it.each(loadFixtures().map((f) => [f.tool, f] as const))("%s: outbound request == fixture, result == notice + fixture response", async (_tool, fx) => {
    const c = await connect();
    const base = replayFixtures();
    api.setHandler((req, i) => (req.path === fx.path ? { body: fx.response.body } : base(req, i))); // this fixture, not a sibling with the same request
    api.requests.length = 0;
    const r = await call(c, fx.tool, fx.request.body);
    const sent = api.requests.filter((q) => q.path === fx.path);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("POST");
    expect(JSON.parse(sent[0]!.body)).toEqual(fx.request.body);
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ notice: UNTRUSTED_NOTICE, ...fx.response.body });
    expect(Object.keys(r.data)[0]).toBe("notice");
  });
});

describe("header allow-list and forwarding", () => {
  it("forwards Authorization verbatim and only the allow-listed headers; drops everything else", async () => {
    const c = await connect(
      { Authorization: `Bearer ${TOKEN}`, Cookie: "session=ms_stolen", "X-Api-Key": "k", "X-Forwarded-For": "6.6.6.6", "X-Mnemonis-Client": "forged", "X-Evil": "1", "X-Mnemonis-Contract": "9" },
      "real-client",
    );
    await call(c, "memory_status", {});
    const sent = api.requests.at(-1)!;
    expect(sent.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent.headers["x-mnemonis-contract"]).toBe("1");
    expect(sent.headers["x-mnemonis-client"]).toBe("real-client");
    expect(sent.headers["x-forwarded-for"]).toBe("127.0.0.1"); // the resolved socket address, not the forged list
    expect(sent.headers["x-request-id"]).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    const allowed = new Set(["accept", "authorization", "connection", "content-length", "content-type", "host", "x-forwarded-for", "x-mnemonis-client", "x-mnemonis-contract", "x-request-id"]);
    for (const q of api.requests) for (const k of Object.keys(q.headers)) expect(allowed.has(k), `${q.path}: ${k}`).toBe(true);
  });

  it("sanitises a hostile client name (control chars, non ASCII, length) and omits it when empty", async () => {
    const c = await connect(undefined, `evil\r\nX-Injected: 1\u0000é${"x".repeat(200)}`);
    await call(c, "memory_status", {});
    const name = api.requests.at(-1)!.headers["x-mnemonis-client"] as string;
    expect(name).toMatch(/^[\x20-\x7e]{1,100}$/);
    expect(api.requests.at(-1)!.headers["x-injected"]).toBeUndefined();
    const blank = await connect({ Authorization: `Bearer mn_${"C".repeat(43)}` }, "   ");
    await call(blank, "memory_status", {});
    expect(api.requests.at(-1)!.headers["x-mnemonis-client"]).toBeUndefined();
  });

  it("an inbound valid X-Request-Id is propagated, an invalid one replaced", async () => {
    await post(rpc("tools/list"), { "X-Request-Id": "req-abcdefgh" });
    expect(api.requests.at(-1)!.headers["x-request-id"]).toBe("req-abcdefgh");
    const r = await post(rpc("tools/list"), { "X-Request-Id": "bad id!" });
    expect(api.requests.at(-1)!.headers["x-request-id"]).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    expect(r.headers.get("x-request-id")).toBe(api.requests.at(-1)!.headers["x-request-id"]);
  });
});

describe("preflight and the 401 mapping", () => {
  it("initialize, tools/list and notifications first call GET /api/agent/ping; a valid tools/call does not", async () => {
    api.requests.length = 0;
    expect((await post(rpc("initialize", INIT_PARAMS))).status).toBe(200);
    expect(paths()).toEqual(["GET /api/agent/ping"]);
    expect(api.requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    api.requests.length = 0;
    expect((await post(rpc("tools/list"))).status).toBe(200);
    expect(paths()).toEqual(["GET /api/agent/ping"]);
    api.requests.length = 0;
    expect([200, 202]).toContain((await post(rpc("notifications/initialized", {}, undefined))).status);
    expect(paths()).toEqual(["GET /api/agent/ping"]);
    api.requests.length = 0;
    const ok = await post(rpc("tools/call", { name: "memory_status", arguments: {} }));
    expect(ok.status).toBe(200);
    expect(paths()).toEqual(["POST /api/agent/memory/status"]);
  });

  it("a tools/call that cannot be forwarded (unknown tool, invalid arguments) is still preflighted", async () => {
    api.requests.length = 0;
    await post(rpc("tools/call", { name: "memory_search", arguments: {} }));
    expect(paths()).toEqual(["GET /api/agent/ping"]);
    api.requests.length = 0;
    await post(rpc("tools/call", { name: "memory_delete", arguments: {} }));
    expect(paths()).toEqual(["GET /api/agent/ping"]);
    api.requests.length = 0;
    await post("{not json");
    expect(paths()).toEqual(["GET /api/agent/ping"]);
  });

  const refuse = () => api.setHandler(() => ({ status: 401, headers: { "WWW-Authenticate": 'Bearer realm="mnemonis"' }, body: { error: { code: "unauthorized", message: "Missing or invalid credentials" } } }));

  it("upstream 401 on preflight is HTTP 401 + WWW-Authenticate for initialize, tools/list and an invalid tools/call", async () => {
    refuse();
    for (const body of [rpc("initialize", INIT_PARAMS), rpc("tools/list"), rpc("tools/call", { name: "memory_search", arguments: {} }), "{bad"]) {
      const r = await post(body);
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe('Bearer realm="mnemonis"');
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
    }
  });

  it("upstream 401 on a forwarded tools/call is HTTP 401 (not a tool result)", async () => {
    refuse();
    const r = await post(rpc("tools/call", { name: "memory_save", arguments: { title: "x" } }));
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe('Bearer realm="mnemonis"');
    expect(api.requests).toHaveLength(1); // one attempt, no retry of a 4xx
  });

  it("a missing or malformed Authorization header is 401 without any upstream call", async () => {
    api.requests.length = 0;
    for (const headers of [{ Authorization: "" }, { Authorization: "Basic abc" }, { Authorization: "Bearer a b" }]) {
      const r = await fetch(`${adapter.url}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, ...headers }, body: rpc("tools/list") });
      expect(r.status).toBe(401);
    }
    const bare = await fetch(`${adapter.url}/mcp`, { method: "POST", headers: MCP_HEADERS, body: rpc("tools/list") });
    expect(bare.status).toBe(401);
    expect(api.requests).toHaveLength(0);
  });

  it("the SDK client cannot connect with a refused token", async () => {
    refuse();
    const c = new Client({ name: "x", version: "1" });
    await expect(c.connect(new StreamableHTTPClientTransport(new URL(`${adapter.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }))).rejects.toThrow();
  });

  it("upstream 429 too_many_failed_attempts is HTTP 429 + Retry-After", async () => {
    api.setHandler(() => ({ status: 429, headers: { "Retry-After": "42" }, body: { error: { code: "too_many_failed_attempts", message: "x" } } }));
    for (const body of [rpc("tools/list"), rpc("tools/call", { name: "memory_status", arguments: {} })]) {
      const r = await post(body);
      expect(r.status).toBe(429);
      expect(r.headers.get("retry-after")).toBe("42");
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("too_many_failed_attempts");
    }
  });

  it("preflight failures other than 401/429 are HTTP 503 (no tool result is faked)", async () => {
    for (const status of [403, 426, 500, 503]) {
      api.setHandler(() => ({ status, body: { error: { code: "x", message: "y" } } }));
      const r = await post(rpc("tools/list"));
      expect(r.status, String(status)).toBe(503);
    }
    api.setHandler(() => ({ raw: "not json at all" }));
    expect((await post(rpc("tools/list"))).status).toBe(503);
  });

  it("the adapter's own failure limiter, fed by upstream 401s, answers 429 without calling the API", async () => {
    await adapter.close();
    adapter = await startAdapterFor(api.url, { options: { failureLimiter: createFailureLimiter({ max: 2, windowMs: 60_000 }) } });
    refuse();
    expect((await post(rpc("tools/list"))).status).toBe(401);
    expect((await post(rpc("tools/list"))).status).toBe(401);
    api.requests.length = 0;
    const r = await post(rpc("tools/list"));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(api.requests).toHaveLength(0);
  });
});

describe("error mapping of tool calls", () => {
  const fail = (status: number, code: string, message = "m") => api.setHandler((req) => (req.path === "/api/agent/ping" ? { body: { ok: true, contract: 1 } } : { status, body: { error: { code, message } } }));

  it.each([
    [400, "invalid_input"],
    [404, "memory_not_found"],
    [409, "not_pending"],
    [413, "too_large"],
    [422, "too_large"],
    [429, "rate_limited"],
    [429, "inbox_full"],
  ])("%i %s becomes a tool error result with the same code", async (status, code) => {
    fail(status, code, "x".repeat(900));
    const c = await connect();
    const r = await call(c, "memory_read", { id: "mem_1" });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe(code);
    expect(r.data.error.message).toHaveLength(500); // clipped
    expect(r.data.notice).toBe(UNTRUSTED_NOTICE);
  });

  it.each([403, 426, 415])("%i is the tool error internal 'configuration problem' (logged with the request id)", async (status) => {
    fail(status, "forbidden_host", "API secret detail");
    const c = await connect();
    const r = await call(c, "memory_status", {});
    expect(r.isError).toBe(true);
    expect(r.data.error).toEqual({ code: "internal", message: "Mnemonis server configuration problem" });
    expect(JSON.stringify(r.data)).not.toContain("API secret detail");
    expect(adapter.logs.join("\n")).toMatch(new RegExp(`status ${status}.*request [A-Za-z0-9._-]{8,}`));
  });

  it("5xx is upstream_unavailable; a 200 that is not JSON is the configuration problem", async () => {
    fail(500, "internal", "stack trace here");
    const c = await connect();
    const r = await call(c, "memory_save", { title: "x" });
    expect(r.data.error.code).toBe("upstream_unavailable");
    expect(JSON.stringify(r.data)).not.toContain("stack trace");
    api.setHandler((req) => (req.path === "/api/agent/ping" ? { body: { ok: true, contract: 1 } } : { raw: "<html>proxy error</html>" }));
    expect((await call(c, "memory_status", {})).data.error).toEqual({ code: "internal", message: "Mnemonis server configuration problem" });
  });

  it("an unreachable API is upstream_unavailable for tool calls and HTTP 503 for the preflight", async () => {
    const c = await connect();
    await api.close();
    const r = await call(c, "memory_status", {});
    expect(r.data.error.code).toBe("upstream_unavailable");
    expect((await post(rpc("tools/list"))).status).toBe(503);
    api = await startFakeApi(); // so afterEach can close it
  });
});

describe("retries and timeouts", () => {
  const flaky = (statuses: number[]) =>
    api.setHandler((req) => {
      if (req.path === "/api/agent/ping") return { body: { ok: true, contract: 1 } };
      const n = api.requests.filter((r) => r.path !== "/api/agent/ping").length - 1;
      const s = statuses[Math.min(n, statuses.length - 1)]!;
      return s === 200 ? { body: { total: 0, limit: 20, offset: 0, memories: [] } } : { status: s, body: { error: { code: "unavailable", message: "x" } } };
    });
  const toolCalls = () => api.requests.filter((r) => r.path.startsWith("/api/agent/memory/"));

  it("a read is retried once on 502/503/504 and then succeeds", async () => {
    for (const s of [502, 503, 504]) {
      api.requests.length = 0;
      flaky([s, 200]);
      const c = await connect();
      const r = await call(c, "memory_list", {});
      expect(r.isError, String(s)).toBe(false);
      expect(toolCalls()).toHaveLength(2);
    }
  });

  it("a read is retried only once", async () => {
    flaky([503, 503, 200]);
    const c = await connect();
    api.requests.length = 0;
    const r = await call(c, "memory_list", {});
    expect(r.data.error.code).toBe("upstream_unavailable");
    expect(toolCalls()).toHaveLength(2);
  });

  it("reads are never retried on 4xx / 429", async () => {
    for (const s of [400, 404, 429]) {
      flaky([s, 200]);
      const c = await connect();
      api.requests.length = 0;
      expect((await call(c, "memory_read", { id: "mem_1" })).isError).toBe(true);
      expect(toolCalls(), String(s)).toHaveLength(1);
    }
  });

  it("writes are NEVER retried", async () => {
    for (const s of [502, 503, 504, 500]) {
      flaky([s, 200]);
      const c = await connect();
      api.requests.length = 0;
      const r = await call(c, "memory_save", { title: "x" });
      expect(r.data.error.code, String(s)).toBe("upstream_unavailable");
      expect(toolCalls(), String(s)).toHaveLength(1);
    }
  });

  it("a write timeout is upstream_timeout (may or may not be recorded); a read timeout is upstream_unavailable; neither is retried", async () => {
    await adapter.close();
    adapter = await startAdapterFor(api.url, { env: { MNEMONIS_UPSTREAM_READ_TIMEOUT_MS: "300", MNEMONIS_UPSTREAM_WRITE_TIMEOUT_MS: "300" } });
    api.setHandler((req) => (req.path === "/api/agent/ping" ? { body: { ok: true, contract: 1 } } : { delayMs: Infinity }));
    const c = await connect();
    api.requests.length = 0;
    const w = await call(c, "memory_save", { title: "x" });
    expect(w.isError).toBe(true);
    expect(w.data.error.code).toBe("upstream_timeout");
    expect(w.data.error.message).toMatch(/may or may not have been recorded.*memory_status/);
    const r = await call(c, "memory_status", {});
    expect(r.data.error.code).toBe("upstream_unavailable");
    expect(toolCalls()).toHaveLength(2);
  });

  it("a redirect is an error and is never followed", async () => {
    let followed = 0;
    const target = await startFakeApi(() => {
      followed++;
      return { body: {} };
    });
    api.setHandler((req) => (req.path === "/api/agent/ping" ? { body: { ok: true, contract: 1 } } : { status: 302, headers: { Location: `${target.url}/stolen` }, body: {} }));
    const c = await connect();
    const r = await call(c, "memory_status", {});
    expect(r.data.error).toEqual({ code: "internal", message: "Mnemonis server configuration problem" });
    expect(followed).toBe(0);
    await target.close();
  });

  it("an upstream response over the cap is rejected", async () => {
    await adapter.close();
    const upstream = createUpstream({ apiUrl: api.url, readTimeoutMs: 5000, writeTimeoutMs: 5000, maxResponseBytes: 2048 });
    adapter = await startAdapterFor(api.url, { options: { upstream } });
    api.setHandler((req) => (req.path === "/api/agent/ping" ? { body: { ok: true, contract: 1 } } : { body: { memories: ["x".repeat(5000)] } }));
    const c = await connect();
    expect((await call(c, "memory_list", {})).data.error).toEqual({ code: "internal", message: "Mnemonis server configuration problem" });
  });
});

describe("transport rules", () => {
  it("GET and DELETE on /mcp are 405 Allow: POST", async () => {
    for (const method of ["GET", "DELETE", "PUT"]) {
      const r = await fetch(`${adapter.url}/mcp`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
    }
  });

  it("any Origin is refused (403) and no CORS header is ever sent", async () => {
    for (const origin of ["http://evil.test", "http://localhost:5173"]) {
      const r = await post(rpc("tools/list"), { Origin: origin });
      expect(r.status).toBe(403);
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect((await fetch(`${adapter.url}/mcp`, { method: "OPTIONS", headers: { Origin: "http://evil.test" } })).status).toBe(403);
  });

  it("a configured origin is allowed through, still without CORS headers", async () => {
    await adapter.close();
    adapter = await startAdapterFor(api.url, { env: { MNEMONIS_ALLOWED_ORIGINS: "https://app.example.com" } });
    const r = await post(rpc("tools/list"), { Origin: "https://app.example.com" });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("the Host header is checked (DNS rebinding)", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: adapter.port, path: "/healthz", headers: { Host: "evil.test" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("the body cap is 413 and invalid JSON is a JSON-RPC parse error", async () => {
    await adapter.close();
    adapter = await startAdapterFor(api.url, { env: { MNEMONIS_MAX_BODY_BYTES: "2048" } });
    const big = await post(rpc("tools/call", { name: "memory_save", arguments: { title: "x", content: "y".repeat(5000) } }));
    expect(big.status).toBe(413);
    const bad = await post("{nope");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });

  it("unknown paths are 404 and the adapter has no REST/API surface of its own", async () => {
    for (const p of ["/api/state", "/api/agent/ping", "/api/auth/config", "/"]) expect((await fetch(`${adapter.url}${p}`)).status).toBe(404);
  });
});

describe("tokens never reach the operator log", () => {
  it("covers success, refusal, failure and timeout paths", async () => {
    await adapter.close();
    adapter = await startAdapterFor(api.url, { env: { MNEMONIS_UPSTREAM_READ_TIMEOUT_MS: "200" } });
    const c = await connect();
    await call(c, "memory_status", {});
    api.setHandler(() => ({ status: 403, body: { error: { code: "forbidden_host", message: `echo ${TOKEN}` } } }));
    await call(c, "memory_status", {});
    api.setHandler(() => ({ status: 401, body: { error: { code: "unauthorized", message: "x" } } }));
    await post(rpc("tools/list"));
    api.setHandler(() => ({ delayMs: Infinity }));
    await post(rpc("tools/list"));
    api.setHandler(() => ({ raw: "garbage" }));
    await call(c, "memory_status", {}).catch(() => undefined);
    expect(adapter.logs.length).toBeGreaterThan(0);
    expect(adapter.logs.join("\n")).not.toContain(TOKEN);
    expect(adapter.logs.join("\n")).not.toContain("A".repeat(43));
  });
});

describe("client names", () => {
  it("initialize's clientInfo.name reaches later tool calls (cached per token), and one token's name never reaches another's", async () => {
    const c = await connect({ Authorization: `Bearer ${TOKEN}` }, "name-one");
    await call(c, "memory_save", { title: "x" });
    expect(api.requests.at(-1)!.headers["x-mnemonis-client"]).toBe("name-one");
    const other = `mn_${"B".repeat(43)}`;
    const r = await fetch(`${adapter.url}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${other}` }, body: rpc("tools/call", { name: "memory_status", arguments: { recent: 10 } }) });
    expect(r.status).toBe(200);
    expect(api.requests.at(-1)!.headers["x-mnemonis-client"]).toBeUndefined();
  });
});

describe("contract handshake and /healthz", () => {
  const contractBody = (version: number, minSupported: number, tools: readonly string[] = TOOL_NAMES) => ({ contract: "mnemonis-agent", version, minSupported, tools });

  it("/healthz is 200 once the contract is confirmed", async () => {
    const r = await fetch(`${adapter.url}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("an incompatible contract (or a missing tool) makes /healthz and /mcp 503 contract_mismatch", async () => {
    for (const body of [contractBody(2, 2), contractBody(1, 1, TOOL_NAMES.slice(1))]) {
      const bad = await startFakeApi((req) => (req.path === "/api/agent/contract" ? { body } : replayFixtures()(req, 0)));
      const a = await startAdapterFor(bad.url);
      expect((await fetch(`${a.url}/healthz`)).status).toBe(503);
      const r = await fetch(`${a.url}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}` }, body: rpc("tools/list") });
      expect(r.status).toBe(503);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("contract_mismatch");
      await a.close();
      await bad.close();
    }
  });

  it("a newer API that still supports contract 1 is accepted", async () => {
    const newer = await startFakeApi((req) => (req.path === "/api/agent/contract" ? { body: contractBody(2, 1, [...TOOL_NAMES, "memory_extra"]) } : replayFixtures()(req, 0)));
    const a = await startAdapterFor(newer.url);
    expect((await fetch(`${a.url}/healthz`)).status).toBe(200);
    await a.close();
    await newer.close();
  });

  it("an unreachable API at startup does not crash: /healthz is 503 until it appears", async () => {
    const down = await startFakeApi();
    const url = down.url;
    await down.close();
    const a = await startAdapterFor(url, { waitForContract: false });
    expect((await fetch(`${a.url}/healthz`)).status).toBe(503);
    await a.close();
  });
});
