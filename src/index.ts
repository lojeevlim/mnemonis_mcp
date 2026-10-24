import { createAccountService } from "./auth/accounts.js";
import { createJwtVerifier } from "./auth/jwt.js";
import { createUserDirectory } from "./auth/users.js";
import { createPgAudit } from "./audit.js";
import { ConfigError, parseConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { parseAllowedOrigins } from "./http/cors.js";
import { startHttpServer } from "./http/server.js";
import { createMemoryServices } from "./service/memoryService.js";
import { shutdown } from "./shutdown.js";
import { PgStore } from "./store/pgStore.js";

const isLoopbackHost = (h: string) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(h.toLowerCase());

async function main(): Promise<void> {
  const cfg = parseConfig();
  const pool = createPool({ connectionString: cfg.databaseUrl });
  const audit = createPgAudit(pool);

  let server;
  try {
    if (cfg.autoMigrate) {
      const applied = await migrate(pool);
      if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
    } else {
      console.log("  Database schema is not migrated automatically: run `npm run db:migrate` (or set MNEMONIS_AUTO_MIGRATE=1).");
    }
    const store = new PgStore(pool);
    server = await startHttpServer({
      services: createMemoryServices({ store }),
      audit,
      verifier: createJwtVerifier(cfg),
      directory: createUserDirectory(pool, store, cfg),
      accounts: createAccountService(pool, cfg),
      allowedOrigins: parseAllowedOrigins(cfg.allowedOrigins.join(",")),
      allowedHosts: cfg.allowedHosts,
      trustProxy: cfg.trustProxy,
      host: cfg.host,
      port: cfg.port,
    });
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw e;
  }

  if (!isLoopbackHost(cfg.host)) {
    if (cfg.trustProxy) {
      console.warn("  WARNING: MNEMONIS_TRUST_PROXY is on: X-Forwarded-For is trusted for the failed-auth limiter, so the app must only be reachable through your proxy.");
    } else {
      console.warn(`  WARNING: HOST ${cfg.host} is not loopback and MNEMONIS_TRUST_PROXY is off: behind a reverse proxy all clients share one failed-auth limiter bucket (the proxy's address).`);
    }
  }

  const port = server.port;
  console.log(`Mnemonis MCP server listening on http://${cfg.host}:${port}`);
  console.log(`  REST: http://localhost:${port}/api/state   MCP: http://localhost:${port}/mcp`);
  console.log(`  Auth: JWT issuer ${cfg.authIssuer}, audience ${cfg.authAudience}, signup mode ${cfg.signupMode}`);
  console.log("\nTo connect an MCP client, sign in to get a JWT, then mint an MCP token (shown once):");
  console.log(`  curl -X POST http://localhost:${port}/api/tokens -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" -d '{"label":"claude-code"}'`);
  console.log(`  claude mcp add --transport http mnemonis http://localhost:${port}/mcp --header "Authorization: Bearer mn_..."\n`);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) {
      console.log(`\n${signal} received again, forcing exit.`);
      process.exit(1);
    }
    stopping = true;
    console.log(`\n${signal} received, shutting down (send it again to force exit)...`);
    void (async () => {
      try {
        await shutdown({ server, audit, pool });
      } catch {
        /* best effort */
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((e: unknown) => {
  if (e instanceof ConfigError) {
    console.error(`Cannot start: ${e.message}`);
  } else if ((e as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    console.error("Cannot start: the port is already in use (set PORT to another value).");
  } else {
    // Driver errors can carry connection details; report the class only.
    console.error(`Cannot start: ${e instanceof Error ? (e.name === "Error" ? e.message : e.name) : "unknown error"}`);
  }
  process.exit(1);
});
