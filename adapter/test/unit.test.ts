import { describe, expect, it } from "vitest";
import { createClientNames, MAX_CLIENT_NAMES, rememberBounded, sanitizeClientName } from "../src/clientNames.js";
import { checkContract } from "../src/contract.js";
import { ConfigError, parseConfig, validApiUrl } from "../src/config.js";
import { hostAllowed, plausibleBearer } from "../src/http/guards.js";
import { TOOL_NAMES, TOOL_SCHEMAS, toolPath } from "../src/mcp/schemas.js";
import { mapPreflight, mapToolResult, type Outcome } from "../src/upstream/errors.js";
import type { UpstreamResult } from "../src/upstream/client.js";
import { loadFixtures, readContractFile } from "./fakeApi.js";

interface Limits {
  id: { min: number; max: number };
  title: { min: number; max: number };
  content: { max: number };
  type: { min: number; max: number };
  tags: { maxCount: number; tagMin: number; tagMax: number };
  metadataBytes: { max: number };
  label: { min: number; max: number };
  query: { min: number; max: number };
  limit: { min: number; max: number; default: number };
  statusRecent: { min: number; max: number; default: number };
  offset: { min: number; max: number; default: number };
  status: string[];
}
const L = readContractFile<Limits>("limits.json");
const S = TOOL_SCHEMAS;
const ok = (schema: keyof typeof S, v: unknown) => S[schema].safeParse(v).success;

describe("zod schemas vs the vendored contract limits", () => {
  it("ids, titles, content, type, tags, label, query", () => {
    expect(ok("memory_read", { id: "x".repeat(L.id.max) })).toBe(true);
    expect(ok("memory_read", { id: "x".repeat(L.id.max + 1) })).toBe(false);
    expect(ok("memory_read", { id: "" })).toBe(false);
    expect(ok("memory_save", { title: "x".repeat(L.title.max) })).toBe(true);
    expect(ok("memory_save", { title: "x".repeat(L.title.max + 1) })).toBe(false);
    expect(ok("memory_save", { title: "" })).toBe(false);
    expect(ok("memory_save", { title: "t", content: "x".repeat(L.content.max) })).toBe(true);
    expect(ok("memory_save", { title: "t", content: "x".repeat(L.content.max + 1) })).toBe(false);
    expect(ok("memory_save", { title: "t", type: "x".repeat(L.type.max) })).toBe(true);
    expect(ok("memory_save", { title: "t", type: "x".repeat(L.type.max + 1) })).toBe(false);
    expect(ok("memory_save", { title: "t", tags: Array(L.tags.maxCount).fill("x") })).toBe(true);
    expect(ok("memory_save", { title: "t", tags: Array(L.tags.maxCount + 1).fill("x") })).toBe(false);
    expect(ok("memory_save", { title: "t", tags: ["x".repeat(L.tags.tagMax)] })).toBe(true);
    expect(ok("memory_save", { title: "t", tags: ["x".repeat(L.tags.tagMax + 1)] })).toBe(false);
    expect(ok("memory_link", { fromId: "a", toId: "b", label: "x".repeat(L.label.max) })).toBe(true);
    expect(ok("memory_link", { fromId: "a", toId: "b", label: "x".repeat(L.label.max + 1) })).toBe(false);
    expect(ok("memory_search", { query: "x".repeat(L.query.max) })).toBe(true);
    expect(ok("memory_search", { query: "x".repeat(L.query.max + 1) })).toBe(false);
    expect(ok("memory_search", { query: "" })).toBe(false);
  });

  it("limit, offset, recent, status and their defaults", () => {
    expect(S.memory_list.parse({})).toMatchObject({ limit: L.limit.default, offset: L.offset.default });
    expect(ok("memory_list", { limit: L.limit.max })).toBe(true);
    expect(ok("memory_list", { limit: L.limit.max + 1 })).toBe(false);
    expect(ok("memory_list", { limit: L.limit.min - 1 })).toBe(false);
    expect(ok("memory_list", { offset: L.offset.max })).toBe(true);
    expect(ok("memory_list", { offset: L.offset.max + 1 })).toBe(false);
    expect(ok("memory_list", { offset: -1 })).toBe(false);
    expect(S.memory_status.parse({}).recent).toBe(L.statusRecent.default);
    expect(ok("memory_status", { recent: L.statusRecent.max })).toBe(true);
    expect(ok("memory_status", { recent: L.statusRecent.max + 1 })).toBe(false);
    for (const s of L.status) expect(ok("memory_list", { status: s })).toBe(true);
    expect(ok("memory_list", { status: "deleted" })).toBe(false);
  });

  it("metadata is a JSON object (the byte cap is enforced by the API)", () => {
    expect(L.metadataBytes.max).toBe(8192);
    expect(ok("memory_save", { title: "t", metadata: { a: [1, { b: null }] } })).toBe(true);
    expect(ok("memory_save", { title: "t", metadata: "x" })).toBe(false);
  });

  it("every schema is strict: no actor/origin/source/provenance", () => {
    for (const name of TOOL_NAMES) {
      for (const k of ["actor", "origin", "source", "provenance"]) {
        expect(S[name].safeParse({ id: "m", title: "t", query: "q", fromId: "a", toId: "b", label: "l", [k]: "x" }).success, `${name}.${k}`).toBe(false);
      }
    }
  });

  it("the fixtures' request bodies are valid input of their tool, and every tool has a fixture", () => {
    const fixtures = loadFixtures();
    for (const f of fixtures) {
      expect(S[f.tool as keyof typeof S].safeParse(f.request.body).success, `${f.tool}`).toBe(true);
      expect(f.path).toBe(`/api/agent${toolPath(f.tool as (typeof TOOL_NAMES)[number])}`);
    }
    expect([...new Set(fixtures.map((f) => f.tool))].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("the vendored contract lists the same 11 tools", () => {
    const c = readContractFile<{ response: { body: { tools: string[]; version: number } } }>("contract.json");
    expect([...c.response.body.tools].sort()).toEqual([...TOOL_NAMES].sort());
    expect(checkContract(c.response.body)).toEqual({ status: "ok", version: 1 });
  });
});

const ctx = (kind: "read" | "write") => ({ kind, log: () => undefined });
const http = (status: number, body: unknown, retryAfter: number | null = null): UpstreamResult => ({ kind: "http", status, body, retryAfter });
const err = (code: string, message = "m") => ({ error: { code, message } });

describe("error mapper (architecture 5: Adapter mapping, every row)", () => {
  const rows: [string, UpstreamResult, "read" | "write", Outcome][] = [
    ["200", { kind: "ok", body: { a: 1 } }, "read", { type: "data", data: { a: 1 } }],
    ["400", http(400, err("invalid_input", "bad")), "read", { type: "toolError", error: { code: "invalid_input", message: "bad" } }],
    ["404", http(404, err("memory_not_found")), "read", { type: "toolError", error: { code: "memory_not_found", message: "m" } }],
    ["409", http(409, err("conflict")), "write", { type: "toolError", error: { code: "conflict", message: "m" } }],
    ["413", http(413, err("too_large")), "write", { type: "toolError", error: { code: "too_large", message: "m" } }],
    ["422", http(422, err("too_large")), "write", { type: "toolError", error: { code: "too_large", message: "m" } }],
    ["429 rate_limited", http(429, err("rate_limited"), 5), "write", { type: "toolError", error: { code: "rate_limited", message: "m" } }],
    ["429 inbox_full", http(429, err("inbox_full")), "write", { type: "toolError", error: { code: "inbox_full", message: "m" } }],
    ["429 too_many_failed_attempts", http(429, err("too_many_failed_attempts"), 17), "read", { type: "tooMany", retryAfter: 17 }],
    ["429 too_many_failed_attempts without Retry-After", http(429, err("too_many_failed_attempts")), "read", { type: "tooMany", retryAfter: 60 }],
    ["401", http(401, err("unauthorized")), "read", { type: "unauthorized" }],
    ["403", http(403, err("forbidden_host")), "read", { type: "toolError", error: { code: "internal", message: "Mnemonis server configuration problem" } }],
    ["426", http(426, err("contract_unsupported")), "write", { type: "toolError", error: { code: "internal", message: "Mnemonis server configuration problem" } }],
    ["415", http(415, err("unsupported_media_type")), "write", { type: "toolError", error: { code: "internal", message: "Mnemonis server configuration problem" } }],
    ["400 with a malformed body", http(400, "<html>"), "read", { type: "toolError", error: { code: "internal", message: "Mnemonis server configuration problem" } }],
    ["malformed", { kind: "malformed" }, "read", { type: "toolError", error: { code: "internal", message: "Mnemonis server configuration problem" } }],
    ["500", http(500, err("internal")), "read", { type: "toolError", error: { code: "upstream_unavailable", message: "The Mnemonis API is unavailable. Try again shortly." } }],
    ["502", http(502, undefined), "write", { type: "toolError", error: { code: "upstream_unavailable", message: "The Mnemonis API is unavailable. Try again shortly." } }],
    ["503", http(503, err("unavailable")), "read", { type: "toolError", error: { code: "upstream_unavailable", message: "The Mnemonis API is unavailable. Try again shortly." } }],
    ["504", http(504, undefined), "read", { type: "toolError", error: { code: "upstream_unavailable", message: "The Mnemonis API is unavailable. Try again shortly." } }],
    ["connect error", { kind: "network" }, "write", { type: "toolError", error: { code: "upstream_unavailable", message: "The Mnemonis API is unavailable. Try again shortly." } }],
    ["read timeout", { kind: "timeout" }, "read", { type: "toolError", error: { code: "upstream_unavailable", message: "The Mnemonis API is unavailable. Try again shortly." } }],
  ];
  it.each(rows)("%s", (_n, result, kind, expected) => {
    expect(mapToolResult(result, ctx(kind))).toEqual(expected);
  });

  it("a write timeout is upstream_timeout and tells the model to check memory_status first", () => {
    const o = mapToolResult({ kind: "timeout" }, ctx("write"));
    expect(o).toMatchObject({ type: "toolError", error: { code: "upstream_timeout" } });
    expect((o as { error: { message: string } }).error.message).toMatch(/may or may not have been recorded.*memory_status/);
  });

  it("messages are clipped to 500 characters", () => {
    const o = mapToolResult(http(400, err("invalid_input", "x".repeat(2000))), ctx("read")) as { error: { message: string } };
    expect(o.error.message).toHaveLength(500);
  });

  it("preflight: only 200 continues, 401 and 429-failed are passed on, everything else is unavailable", () => {
    expect(mapPreflight({ kind: "ok", body: {} })).toEqual({ type: "ok" });
    expect(mapPreflight(http(401, err("unauthorized")))).toEqual({ type: "unauthorized" });
    expect(mapPreflight(http(429, err("too_many_failed_attempts"), 9))).toEqual({ type: "tooMany", retryAfter: 9 });
    for (const r of [http(429, err("rate_limited")), http(403, err("x")), http(426, err("x")), http(500, err("x")), http(404, err("x")), { kind: "network" }, { kind: "timeout" }, { kind: "malformed" }] as UpstreamResult[]) {
      expect(mapPreflight(r)).toEqual({ type: "unavailable" });
    }
  });
});

describe("client names", () => {
  it("sanitises to printable ASCII, trimmed, at most 100", () => {
    expect(sanitizeClientName("claude-code")).toBe("claude-code");
    expect(sanitizeClientName("  a\r\nb\u0000c  ")).toBe("a  b c");
    expect(sanitizeClientName("é")).toBe("");
    expect(sanitizeClientName("x".repeat(300))).toHaveLength(100);
    expect(sanitizeClientName(5)).toBe("");
    expect(sanitizeClientName(undefined)).toBe("");
  });

  it("the cache is bounded (oldest evicted, never cleared) and keyed by a token hash", () => {
    const m = new Map<string, string>();
    for (let i = 0; i < 20; i++) rememberBounded(m, `k${i}`, "v", 5);
    expect([...m.keys()]).toEqual(["k15", "k16", "k17", "k18", "k19"]);
    rememberBounded(m, "k15", "v2", 5);
    expect([...m.keys()].at(-1)).toBe("k15");
    const names = createClientNames(3);
    for (let i = 0; i < 10; i++) names.remember(`mn_${i}`, `n${i}`);
    expect(names.size()).toBe(3);
    expect(names.get("mn_9")).toBe("n9");
    expect(names.get("mn_0")).toBeUndefined();
    expect(MAX_CLIENT_NAMES).toBe(1000);
  });
});

describe("guards", () => {
  it("plausibleBearer is a shape check only (validity is the API's decision)", () => {
    expect(plausibleBearer(`Bearer mn_${"A".repeat(43)}`)).toBe(true);
    expect(plausibleBearer("bearer anything-goes_here")).toBe(true);
    for (const bad of [undefined, "", "Basic abc", "Bearer", "Bearer a b", "Bearer a,b", `Bearer ${"x".repeat(9000)}`]) expect(plausibleBearer(bad as string)).toBe(false);
  });

  it("host allow-list: loopback with the port, plus exact configured hosts", () => {
    expect(hostAllowed("localhost:8788", 8788)).toBe(true);
    expect(hostAllowed("127.0.0.1:8788", 8788)).toBe(true);
    expect(hostAllowed("localhost:1", 8788)).toBe(false);
    expect(hostAllowed("mcp.example.com", 8788)).toBe(false);
    expect(hostAllowed("MCP.example.com", 8788, ["mcp.example.com"])).toBe(true);
    expect(hostAllowed(undefined, 8788)).toBe(false);
  });
});

describe("config", () => {
  it("defaults: API 127.0.0.1:8787, adapter 127.0.0.1:8788, no database", () => {
    expect(parseConfig({})).toMatchObject({
      apiUrl: "http://127.0.0.1:8787",
      host: "127.0.0.1",
      port: 8788,
      allowedHosts: [],
      allowedOrigins: [],
      trustProxy: false,
      readTimeoutMs: 10_000,
      writeTimeoutMs: 20_000,
      maxBodyBytes: 1_048_576,
    });
    expect(Object.keys(parseConfig({}))).not.toContain("databaseUrl");
  });

  it("MNEMONIS_API_URL: https or loopback http; private http only with the opt-in; no credentials/query/fragment", () => {
    for (const u of ["https://api.example.com", "http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) expect(validApiUrl(u, false), u).toBe(true);
    for (const u of ["http://api.example.com", "http://api:8787", "http://10.0.0.5:8787", "ftp://x", "nope", "https://u:p@x.com", "https://x.com?a=1", "https://x.com#f"]) expect(validApiUrl(u, false), u).toBe(false);
    for (const u of ["http://api:8787", "http://10.0.0.5:8787", "http://192.168.1.2:8787", "http://172.20.0.2:8787"]) expect(validApiUrl(u, true), u).toBe(true);
    expect(validApiUrl("http://api.example.com", true)).toBe(false); // a public name is never allowed over http
    expect(() => parseConfig({ MNEMONIS_API_URL: "http://api.example.com" })).toThrow(ConfigError);
    expect(() => parseConfig({ MNEMONIS_API_URL: "http://api.example.com" })).toThrow(/MNEMONIS_API_URL/);
    expect(parseConfig({ MNEMONIS_API_URL: "http://api:8787/", MNEMONIS_API_ALLOW_INSECURE_PRIVATE: "true" }).apiUrl).toBe("http://api:8787");
  });

  it("MCP_PORT / MCP_HOST and the list settings", () => {
    const c = parseConfig({ MCP_PORT: "9000", MCP_HOST: "0.0.0.0", MNEMONIS_ALLOWED_HOSTS: "MCP.example.com, b:1", MNEMONIS_ALLOWED_ORIGINS: "https://a.example/", MNEMONIS_TRUST_PROXY: "true" });
    expect(c).toMatchObject({ port: 9000, host: "0.0.0.0", allowedHosts: ["mcp.example.com", "b:1"], allowedOrigins: ["https://a.example"], trustProxy: true });
    expect(() => parseConfig({ MCP_PORT: "70000" })).toThrow(ConfigError);
  });
});
