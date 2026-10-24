import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assertDatabaseHostAllowed, RemoteDatabaseError } from "./guard.js";
import { createPool } from "./pool.js";

const REMOTE = "postgres://postgres:s3cretpw@db.abcdefgh.supabase.co:5432/postgres";

describe("assertDatabaseHostAllowed", () => {
  it("accepts localhost, 127.0.0.1, ::1 and unix sockets", () => {
    for (const u of [
      "postgres://u:p@localhost:5433/x",
      "postgres://u:p@LOCALHOST/x",
      "postgresql://u:p@127.0.0.1:5432/x",
      "postgres://u:p@[::1]:5432/x",
      "postgres:///x?host=/var/run/postgresql",
    ]) {
      expect(() => assertDatabaseHostAllowed(u, {}), u).not.toThrow();
    }
  });

  it("refuses any other host, including look-alikes, with a clear message that never contains the URL", () => {
    for (const u of [REMOTE, "postgres://u:p@10.0.0.5/x", "postgres://u:p@localhost.evil.test/x", "postgres://u:p@127.0.0.1.evil.test/x", "postgres://u:p@0.0.0.0/x", "postgres://u:p@db/x"]) {
      try {
        assertDatabaseHostAllowed(u, {});
        expect.unreachable(u);
      } catch (e) {
        expect(e).toBeInstanceOf(RemoteDatabaseError);
        expect((e as Error).message).toMatch(/MNEMONIS_ALLOW_REMOTE_DB=true/);
        for (const leaked of ["s3cretpw", "supabase", "abcdefgh", "evil", "postgres://"]) expect((e as Error).message).not.toContain(leaked);
      }
    }
  });

  it("an empty URL host (postgres:///db) takes PGHOST into account: a non-local PGHOST is refused, unset or local/socket PGHOST is fine", () => {
    for (const pgHost of ["db.abcdefgh.supabase.co", "10.0.0.5", "localhost,db.remote.test", " Remote.Test "]) {
      for (const u of ["postgres:///db", "postgres://u:p@/db", "postgres:///db?host="]) {
        try {
          assertDatabaseHostAllowed(u, { PGHOST: pgHost });
          expect.unreachable(`${u} ${pgHost}`);
        } catch (e) {
          expect(e).toBeInstanceOf(RemoteDatabaseError);
          expect((e as Error).message).toMatch(/MNEMONIS_ALLOW_REMOTE_DB=true/);
          for (const leaked of ["supabase", "abcdefgh", "10.0.0.5", "remote.test"]) expect((e as Error).message.toLowerCase()).not.toContain(leaked);
        }
      }
    }
    for (const env of [{}, { PGHOST: "" }, { PGHOST: "localhost" }, { PGHOST: "127.0.0.1" }, { PGHOST: "/var/run/postgresql" }]) {
      expect(() => assertDatabaseHostAllowed("postgres:///db", env), JSON.stringify(env)).not.toThrow();
    }
    expect(() => assertDatabaseHostAllowed("postgres:///db?host=/var/run/postgresql", { PGHOST: "db.remote.test" })).not.toThrow(); // explicit socket wins
    expect(() => assertDatabaseHostAllowed("postgres:///db", { PGHOST: "db.remote.test", MNEMONIS_ALLOW_REMOTE_DB: "true" })).not.toThrow();
  });

  it("refuses unparseable values rather than guessing", () => {
    for (const u of ["", "not a url", "mysql://localhost/x"]) expect(() => assertDatabaseHostAllowed(u, {}), u).toThrowError(RemoteDatabaseError);
  });

  it("the explicit opt-in MNEMONIS_ALLOW_REMOTE_DB=true (or 1) allows a remote host; anything else does not", () => {
    expect(() => assertDatabaseHostAllowed(REMOTE, { MNEMONIS_ALLOW_REMOTE_DB: "true" })).not.toThrow();
    expect(() => assertDatabaseHostAllowed(REMOTE, { MNEMONIS_ALLOW_REMOTE_DB: "1" })).not.toThrow();
    for (const v of [undefined, "", "false", "yes", "TRUE"]) {
      expect(() => assertDatabaseHostAllowed(REMOTE, { MNEMONIS_ALLOW_REMOTE_DB: v }), String(v)).toThrowError(RemoteDatabaseError);
    }
  });

  it("every pool (server, db:migrate, operator CLI, tests, smoke) goes through the guard", () => {
    const prev = process.env.MNEMONIS_ALLOW_REMOTE_DB;
    delete process.env.MNEMONIS_ALLOW_REMOTE_DB;
    try {
      expect(() => createPool({ connectionString: REMOTE })).toThrowError(RemoteDatabaseError);
      const p = createPool({ connectionString: "postgres://u:p@localhost:1/x" });
      void p.end();
    } finally {
      if (prev !== undefined) process.env.MNEMONIS_ALLOW_REMOTE_DB = prev;
    }
  });
});

describe("entry points refuse a remote DATABASE_URL before connecting (child processes, explicit env, no .env loaded)", () => {
  const run = (entry: string, extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["--import", "tsx", entry, "list"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: REMOTE, ...extra },
      encoding: "utf8",
      timeout: 60_000,
    });

  for (const [name, entry] of [
    ["db:migrate (src/db/migrate.ts)", "src/db/migrate.ts"],
    ["dev/start (src/index.ts)", "src/index.ts"],
    ["operator CLI (src/operator/index.ts)", "src/operator/index.ts"],
  ] as const) {
    it(`${name} exits 1 with a clear message that never contains the URL`, () => {
      const r = run(entry);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/MNEMONIS_ALLOW_REMOTE_DB=true/);
      for (const leaked of ["s3cretpw", "supabase", "abcdefgh"]) {
        expect(r.stderr).not.toContain(leaked);
        expect(r.stdout).not.toContain(leaked);
      }
    });
  }
});
