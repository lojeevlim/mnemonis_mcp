import { ConfigError, parseConfig } from "./config.js";
import { startAdapter } from "./mcp/server.js";

async function main(): Promise<void> {
  const config = parseConfig();
  const running = await startAdapter({ config });
  console.log(`Mnemonis MCP adapter listening on http://${config.host}:${running.port}/mcp`);
  console.log(`  forwarding to the Mnemonis API at ${config.apiUrl} (no database, no secrets)`);
  console.log(`  claude mcp add --transport http mnemonis http://localhost:${running.port}/mcp --header "Authorization: Bearer mn_..."`);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\n${signal} received, shutting down...`);
    void running.close(3000).finally(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((e: unknown) => {
  if (e instanceof ConfigError) console.error(`Cannot start: ${e.message}`);
  else if ((e as NodeJS.ErrnoException)?.code === "EADDRINUSE") console.error("Cannot start: the port is already in use (set MCP_PORT to another value).");
  else console.error(`Cannot start: ${e instanceof Error ? e.name : "unknown error"}`);
  process.exit(1);
});
