// Operator CLI: `npm run user -- <command>`. Terminal-only: it talks to the database directly (DATABASE_URL, which must
// pass the local/remote guard in db/guard.ts) and exposes nothing over HTTP. Separate from the end-user client in src/cli.
import { createPool } from "../db/pool.js";
import { readHidden } from "../cli/prompt.js";
import { runUserCommand } from "./commands.js";
import { parseConfig } from "../config.js";

async function main(): Promise<number> {
  const { quotas } = (() => {
    // Quotas come from the same env vars as the server; DATABASE_URL is validated by createPool (local-only guard).
    try {
      const c = parseConfig();
      return { quotas: { maxWorkspaceBytes: c.maxWorkspaceBytes, maxMemories: c.maxMemories } };
    } catch {
      return { quotas: undefined };
    }
  })();
  let pool;
  try {
    pool = createPool({ max: 2 });
  } catch (e) {
    console.error(e instanceof Error ? e.message : "Cannot connect");
    return 1;
  }
  try {
    return await runUserCommand(process.argv.slice(2), {
      pool,
      out: (l) => console.log(l),
      err: (l) => console.error(l),
      readPassword: (q) => readHidden(q, { input: process.stdin, output: process.stderr }),
      quotas,
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`Failed: ${e instanceof Error ? e.message : "unknown error"}`);
    process.exit(1);
  },
);
