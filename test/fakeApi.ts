import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config.js";
import { startAdapter, type AdapterOptions, type RunningAdapter } from "../src/mcp/server.js";

export const CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "contract", "agent-v1");

export interface Fixture {
  tool: string;
  method: "POST";
  path: string;
  request: { body: Record<string, unknown> };
  response: { status: number; body: Record<string, unknown> };
}

/** The vendored example per tool (first file wins): the fake API replays these. */
export function loadFixtures(): Fixture[] {
  return readdirSync(CONTRACT_DIR)
    .filter((f) => /^memory_.*\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(CONTRACT_DIR, f), "utf8")) as Fixture);
}
export const readContractFile = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(CONTRACT_DIR, name), "utf8")) as T;

export interface Captured {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw body text (overrides `body`). */
  raw?: string;
  /** Respond after this many ms (or never with Infinity). */
  delayMs?: number;
}

export type FakeHandler = (req: Captured, index: number) => FakeResponse | Promise<FakeResponse>;

export interface FakeApi {
  url: string;
  requests: Captured[];
  setHandler(h: FakeHandler): void;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

const safeParse = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** Default behaviour: valid ping/contract and the fixture response for every tool endpoint. */
export function replayFixtures(): FakeHandler {
  const all = loadFixtures();
  return (req) => {
    if (req.method === "GET" && req.path === "/api/agent/ping") return { body: { ok: true, contract: 1 } };
    if (req.method === "GET" && req.path === "/api/agent/contract") return { body: readContractFile<{ response: { body: unknown } }>("contract.json").response.body };
    const sameBody = (f: Fixture) => JSON.stringify(f.request.body) === JSON.stringify(safeParse(req.body));
    const f = all.find((x) => x.path === req.path && sameBody(x)) ?? all.find((x) => x.path === req.path);
    return f ? { body: f.response.body } : { status: 404, body: { error: { code: "not_found", message: "Not found" } } };
  };
}

export async function startFakeApi(handler: FakeHandler = replayFixtures()): Promise<FakeApi> {
  let current = handler;
  const requests: Captured[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer(async (req, res) => {
    const captured: Captured = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: await readBody(req) };
    const index = requests.push(captured) - 1;
    const r = await current(captured, index);
    if (r.delayMs !== undefined) {
      if (!Number.isFinite(r.delayMs)) return; // never answers
      await new Promise((ok) => setTimeout(ok, r.delayMs));
    }
    const text = r.raw ?? JSON.stringify(r.body ?? {});
    res.writeHead(r.status ?? 200, { "Content-Type": "application/json", ...r.headers });
    res.end(text);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setHandler: (h) => (current = h),
    close: () =>
      new Promise<void>((ok) => {
        for (const s of sockets) s.destroy();
        server.close(() => ok());
      }),
  };
}

/** An adapter on an ephemeral port in front of `apiUrl`. Operator log lines are collected in `logs`. */
export async function startAdapterFor(
  apiUrl: string,
  o: { env?: Record<string, string>; options?: Partial<AdapterOptions>; waitForContract?: boolean } = {},
): Promise<RunningAdapter & { url: string; logs: string[] }> {
  const logs: string[] = [];
  const config = parseConfig({ MNEMONIS_API_URL: apiUrl, MCP_PORT: "0", ...o.env });
  const running = await startAdapter({ config, log: (l) => logs.push(l), ...o.options });
  if (o.waitForContract !== false) await running.adapter.contract?.settled();
  return Object.assign(running, { url: `http://127.0.0.1:${running.port}`, logs });
}

export const TOKEN = `mn_${"A".repeat(43)}`;
export const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
export const rpc = (method: string, params: unknown = {}, id: number | undefined = 1) => JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params });
export const INIT_PARAMS = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-client", version: "0" } };
