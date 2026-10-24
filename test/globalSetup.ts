import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

/** Brings TEST_DATABASE_URL (a throw-away database; createPool refuses a remote host) up to the current schema before any test runs. */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const pool = createPool({ connectionString: url, statementTimeoutMs: 0, max: 1 });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
