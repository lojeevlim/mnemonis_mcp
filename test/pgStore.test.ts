import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemory, createEmptyWorkspace, listMemories, SCHEMA_VERSION } from "../src/domain/index.js";
import { createPool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { createSystemContext } from "../src/service/memoryService.js";
import { parseImportJson } from "../src/store/importJson.js";
import { PgStore } from "../src/store/pgStore.js";
import { StoreError } from "../src/store/types.js";

const USER = { kind: "user", name: "me" } as const;
const ctx = createSystemContext();
const url = process.env.TEST_DATABASE_URL;

describe("parseImportJson NUL handling", () => {
  it("rejects raw and escaped NUL characters", () => {
    const base = { schemaVersion: SCHEMA_VERSION, state: createEmptyWorkspace() };
    expect(() => parseImportJson(JSON.stringify(base).replace("{", '{"x":"\\u0000",'))).toThrowError(StoreError);
    expect(() => parseImportJson(`{"a":"b\u0000"}`)).toThrowError(/NUL/);
    expect(() => parseImportJson(JSON.stringify(base).replace("{", '{"x":"\\u0000",'))).toThrowError(/NUL/);
  });
});

// Needs a throwaway Postgres: set TEST_DATABASE_URL (see .env.example, `npm run db:up`). Skipped otherwise.
describe.skipIf(!url)("PgStore", () => {
  let pool: Pool;
  let store: PgStore;
  const userIds: string[] = [];

  async function newUser(): Promise<string> {
    const id = randomUUID();
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Test')", [id, `${id}@example.test`]);
    await store.ensureWorkspace(id);
    userIds.push(id);
    return id;
  }
  const add = (title: string) => (s: ReturnType<typeof createEmptyWorkspace>) =>
    createMemory(s, ctx, { title, content: "c", actor: USER });

  beforeAll(async () => {
    pool = createPool({ connectionString: url });
    store = new PgStore(pool);
    await migrate(pool);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
    await pool.end();
  });

  it("ensureWorkspace is idempotent and starts at rev 0", async () => {
    const id = await newUser();
    await store.ensureWorkspace(id);
    const snap = await store.forUser(id).read();
    expect(snap.rev).toBe(0);
    expect(snap.state.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("bumps rev only on a real change", async () => {
    const u = store.forUser(await newUser());
    const same = await u.transact((s) => ({ state: s, value: 1 }));
    expect(same.rev).toBe(0);
    const changed = await u.transact(add("a"));
    expect(changed.rev).toBe(1);
    expect(listMemories((await u.read()).state)).toHaveLength(1);
  });

  it("serializes parallel transacts on one user (no lost update)", async () => {
    const u = store.forUser(await newUser());
    await Promise.all(Array.from({ length: 10 }, (_, i) => u.transact(add(`m${i}`))));
    const snap = await u.read();
    expect(snap.rev).toBe(10);
    expect(listMemories(snap.state)).toHaveLength(10);
  });

  it("isolates users", async () => {
    const a = store.forUser(await newUser());
    const b = store.forUser(await newUser());
    await a.transact(add("only-a"));
    expect(listMemories((await b.read()).state)).toHaveLength(0);
    expect((await b.read()).rev).toBe(0);
  });

  it("rolls back when fn throws and rethrows the original error", async () => {
    const u = store.forUser(await newUser());
    const boom = new Error("boom");
    await expect(
      u.transact(() => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect((await u.read()).rev).toBe(0);
    await u.transact(add("after")); // lock was released
    expect((await u.read()).rev).toBe(1);
  });

  it("replace: conflict on wrong ifMatchRev, success on right one", async () => {
    const u = store.forUser(await newUser());
    const json = JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: createEmptyWorkspace() });
    await expect(u.replace(json, { ifMatchRev: 5 })).rejects.toMatchObject({ code: "conflict" });
    expect((await u.replace(json, { ifMatchRev: 0 })).rev).toBe(1);
  });

  it("replace validates input", async () => {
    const u = store.forUser(await newUser());
    await expect(u.replace("not json")).rejects.toMatchObject({ code: "corrupt" });
    await expect(u.replace(JSON.stringify({ nope: true }))).rejects.toBeInstanceOf(StoreError);
    expect((await u.read()).rev).toBe(0);
  });

  it("write replaces the state and bumps rev", async () => {
    const u = store.forUser(await newUser());
    await u.transact(add("x"));
    const snap = await u.write(createEmptyWorkspace());
    expect(snap.rev).toBe(2);
    expect(listMemories(snap.state)).toHaveLength(0);
  });

  it("wraps driver errors without leaking details", async () => {
    const err = await store.forUser("not-a-uuid").read().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err).toMatchObject({ code: "io", message: "Database error" });
  });

  it("read of a missing workspace throws StoreError io", async () => {
    await expect(store.forUser(randomUUID()).read()).rejects.toMatchObject({ code: "io" });
  });

  it("migrate is idempotent on re-run", async () => {
    expect(await migrate(pool)).toEqual([]);
  });

  it("email is case-insensitively unique", async () => {
    const tag = randomUUID();
    const first = randomUUID();
    userIds.push(first);
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'A')", [first, `${tag}@Example.test`]);
    await expect(
      pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'B')", [randomUUID(), `${tag}@EXAMPLE.TEST`]),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
