import { homedir } from "node:os";
import { join } from "node:path";
import { claudeAddCommand, ensureToken, readToken } from "./auth/token.js";
import { createAuditLog } from "./audit.js";
import { parseAllowedOrigins } from "./http/cors.js";
import { startHttpServer } from "./http/server.js";
import { createMemoryService } from "./service/memoryService.js";
import { FileStore, StoreError } from "./store/fileStore.js";

async function main(): Promise<void> {
  const dir = process.env.MNEMONIS_DATA_DIR || join(homedir(), ".mnemonis");
  const host = process.env.HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.PORT ?? "8787", 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT: ${process.env.PORT}`);

  const store = FileStore.open({ dir });
  const { token, created } = ensureToken(dir);
  const service = createMemoryService({ store });

  let server;
  try {
    server = await startHttpServer({
      service,
      audit: createAuditLog(dir),
      getToken: () => readToken(dir),
      allowedOrigins: parseAllowedOrigins(process.env.MNEMONIS_ALLOWED_ORIGINS),
      userName: process.env.MNEMONIS_USER_NAME,
      host,
      port,
    });
  } catch (e) {
    await store.close();
    throw e;
  }

  console.log(`Mnemonis MCP server listening on http://${host}:${server.port} (data: ${dir})`);
  console.log(`  REST: http://localhost:${server.port}/api/state   MCP: http://localhost:${server.port}/mcp`);
  if (created) {
    console.log(`\nFirst run: created an access token (${join(dir, "token")}, shown only now; \`npm run token\` prints it again):\n`);
    console.log(`  ${token}\n`);
    console.log(`Register with Claude Code:\n  ${claudeAddCommand(token, server.port)}\n`);
  } else {
    console.log("  Token: run `npm run token` to show it (or `npm run token -- --rotate`).");
  }

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} received, shutting down...`);
    void (async () => {
      try {
        await server.close();
        await store.close();
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((e: unknown) => {
  if (e instanceof StoreError) {
    console.error(`Cannot start: ${e.message}`);
  } else if ((e as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    console.error("Cannot start: the port is already in use (set PORT to another value).");
  } else {
    console.error(`Cannot start: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  process.exit(1);
});
