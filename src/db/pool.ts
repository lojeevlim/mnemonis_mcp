import pg from "pg";

export interface PoolOptions {
  connectionString?: string;
  /** Per-statement timeout in ms (default 10000). */
  statementTimeoutMs?: number;
  max?: number;
}

/** Pool from DATABASE_URL (or the explicit connection string). Throws if neither is set. */
export function createPool(opts: PoolOptions = {}): pg.Pool {
  const connectionString = opts.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    statement_timeout: opts.statementTimeoutMs ?? 10_000,
  });
  // An idle client dropping (server restart, network) emits "error" on the pool; unhandled it would crash the process.
  pool.on("error", () => {
    console.error("Postgres pool: idle client error (connection dropped)");
  });
  return pool;
}
