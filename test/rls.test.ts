import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

const url = process.env.TEST_DATABASE_URL;
const TABLES = ["users", "workspaces", "api_tokens", "audit_log", "schema_migrations"];
const PROBE = "rls_probe_anon";

describe.skipIf(!url)("row-level security (postgres)", () => {
  let pool: Pool;
  const email = `rls-${randomUUID().slice(0, 8)}@rls.example.test`;
  let userId: string | undefined;

  const dropProbe = async (): Promise<void> => {
    const { rowCount } = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [PROBE]);
    if (rowCount) {
      await pool.query(`DROP OWNED BY ${PROBE}`);
      await pool.query(`DROP ROLE ${PROBE}`);
    }
  };

  beforeAll(async () => {
    pool = createPool({ connectionString: url });
    await migrate(pool);
  });

  afterAll(async () => {
    try {
      await pool.query("DELETE FROM audit_log WHERE client = 'rls-test'");
      if (userId) await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      await dropProbe();
    } finally {
      await pool.end();
    }
  });

  it("enables RLS with zero policies on every table, and re-running migrate is a no-op", async () => {
    const rls = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      "SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)",
      [TABLES],
    );
    expect(rls.rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    for (const r of rls.rows) expect(r.relrowsecurity, r.relname).toBe(true);
    const pol = await pool.query("SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1)", [TABLES]);
    expect(pol.rows).toEqual([]);
    expect(await migrate(pool)).toEqual([]);
  });

  it("denies a non-owner role even when rows exist, while the owner still reads them", async () => {
    userId = (await pool.query<{ id: string }>("INSERT INTO users (email, display_name) VALUES ($1, 'RLS') RETURNING id", [email])).rows[0]!.id;
    await pool.query("INSERT INTO audit_log (user_id, client, action) VALUES ($1, 'rls-test', 'probe')", [userId]);
    await dropProbe();
    await pool.query(`CREATE ROLE ${PROBE} NOLOGIN`);
    const client = await pool.connect();
    try {
      await client.query(`GRANT USAGE ON SCHEMA public TO ${PROBE}`);
      await client.query(`GRANT SELECT ON ${TABLES.join(", ")} TO ${PROBE}`);
      await client.query(`SET ROLE ${PROBE}`);
      for (const t of TABLES) {
        const rows = await client.query(`SELECT * FROM ${t}`);
        expect(rows.rowCount, t).toBe(0);
      }
      await expect(client.query("INSERT INTO users (email, display_name) VALUES ('x@rls.example.test', 'x')")).rejects.toThrow();
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
    }
    const owner = await pool.query("SELECT 1 FROM users WHERE id = $1", [userId]);
    expect(owner.rowCount).toBe(1);
  });
});
