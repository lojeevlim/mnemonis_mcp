import { parseConfig } from "../adapter/src/config.js";
import { startAdapter, type RunningAdapter } from "../adapter/src/mcp/server.js";
import { startTestServer as startApi, TEST_DB_URL, type TestServer, type TestServerOptions, type TestUser } from "./helpers.js";

export { TEST_DB_URL };
export type { TestServer, TestUser };

export interface AdapterOptions {
  env?: Record<string, string>;
}

/** Starts the real MCP adapter (no database, no domain) on an ephemeral port in front of `apiUrl`. */
export async function startTestAdapter(apiUrl: string, o: AdapterOptions = {}): Promise<RunningAdapter> {
  const config = parseConfig({ MNEMONIS_API_URL: apiUrl, MCP_PORT: "0", ...o.env });
  const running = await startAdapter({ config, log: () => undefined });
  await running.adapter.contract?.settled();
  return running;
}

/**
 * The usual API test server PLUS an adapter in front of it. `url` is the ADAPTER's base URL (so `${url}/mcp` goes through the
 * adapter and on to /api/agent/*); REST helpers (api, op, headers...) keep talking to the API directly.
 */
export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  const api = await startApi(opts);
  const adapter = await startTestAdapter(api.url);
  return {
    ...api,
    url: `http://127.0.0.1:${adapter.port}`,
    port: adapter.port,
    async close() {
      await adapter.close();
      await api.close();
    },
  };
}
