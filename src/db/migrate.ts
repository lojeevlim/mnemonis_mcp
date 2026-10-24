import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { createPool } from "./pool.js";

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const LOCK_KEY = 726_001; // arbitrary advisory-lock id so concurrent runners serialize

/** Applies migrations/*.sql in filename order, each in its own transaction, recording them in schema_migrations. Returns applied names. */
export async function migrate(pool: pg.Pool, dir: string = DEFAULT_DIR): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  let unlocked = false;
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      try {
        await client.query("BEGIN");
        await client.query(readFileSync(join(dir, file), "utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${e instanceof Error ? e.message : "unknown error"}`, { cause: e });
      }
      applied.push(file);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).then(() => (unlocked = true), () => undefined);
    client.release(!unlocked); // destroy the connection if unlock failed (closing it drops the session lock)
  }
  return applied;
}

// CLI: `npm run db:migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pool = createPool({ statementTimeoutMs: 0 }); // 0 = no statement timeout, long migrations must not be cancelled
  migrate(pool)
    .then((applied) => console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date."))
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : "Migration failed");
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
