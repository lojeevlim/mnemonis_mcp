import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemory, createSequentialContext, listMemories, SCHEMA_VERSION } from "../src/domain/index.js";
import { FileStore, StoreError } from "../src/store/fileStore.js";

const USER = { kind: "user", name: "me" } as const;
let dir: string;
let stores: FileStore[];

const open = (opts: Partial<Parameters<typeof FileStore.open>[0]> = {}) => {
  const s = FileStore.open({ dir, ...opts });
  stores.push(s);
  return s;
};
const readEnv = () => JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
const names = () => readdirSync(dir);

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "mnemonis-store-")), "data");
  stores = [];
});
afterEach(async () => {
  await Promise.all(stores.map((s) => s.close()));
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

describe("FileStore", () => {
  it("first run creates an empty workspace at rev 0 with private permissions", async () => {
    const s = open();
    const snap = await s.read();
    expect(snap.rev).toBe(0);
    expect(Object.keys(snap.state.memories)).toHaveLength(0);
    expect(readEnv()).toMatchObject({ schemaVersion: SCHEMA_VERSION, rev: 0 });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "workspace.json")).mode & 0o777).toBe(0o600);
  });

  it("uses createInitial only when no file exists", async () => {
    const ctx = createSequentialContext();
    const initial = () =>
      createMemory({ schemaVersion: SCHEMA_VERSION, memories: {}, revisions: {}, relations: {}, collections: {} }, ctx, {
        title: "seed",
        actor: USER,
      }).state;
    const s = open({ createInitial: initial });
    expect(listMemories((await s.read()).state)).toHaveLength(1);
    await s.close();
    const again = open({ createInitial: () => { throw new Error("must not be called"); } });
    expect(listMemories((await again.read()).state)).toHaveLength(1);
  });

  it("rev increments per change, persists, and survives reopen; .bak holds the previous good file", async () => {
    const ctx = createSequentialContext();
    const s = open();
    const a = await s.transact((st) => createMemory(st, ctx, { title: "one", actor: USER }));
    expect(a.rev).toBe(1);
    const b = await s.transact((st) => createMemory(st, ctx, { title: "two", actor: USER }));
    expect(b.rev).toBe(2);
    expect(JSON.parse(readFileSync(join(dir, "workspace.json.bak"), "utf8")).rev).toBe(1);
    expect(readEnv().rev).toBe(2);
    await s.close();
    const reopened = open();
    const snap = await reopened.read();
    expect(snap.rev).toBe(2);
    expect(listMemories(snap.state)).toHaveLength(2);
  });

  it("an unchanged state or a throwing mutation neither persists nor bumps rev", async () => {
    const s = open();
    await s.transact((st) => ({ state: st, value: null }));
    await expect(s.transact(() => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect((await s.read()).rev).toBe(0);
  });

  it("100 parallel creates are serialized with no loss", async () => {
    const ctx = createSequentialContext();
    const s = open();
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => s.transact((st) => createMemory(st, ctx, { title: `m${i}`, actor: USER }))),
    );
    const snap = await s.read();
    expect(snap.rev).toBe(100);
    expect(listMemories(snap.state)).toHaveLength(100);
    expect(readEnv().rev).toBe(100);
  });

  it("a failed write leaves memory, file and rev unchanged; a leftover tmp file is harmless", async () => {
    const ctx = createSequentialContext();
    const s = open();
    await s.transact((st) => createMemory(st, ctx, { title: "keep", actor: USER }));
    const before = readFileSync(join(dir, "workspace.json"), "utf8");
    mkdirSync(join(dir, "workspace.json.tmp")); // makes the tmp write fail
    await expect(s.transact((st) => createMemory(st, ctx, { title: "lost", actor: USER }))).rejects.toThrow();
    expect((await s.read()).rev).toBe(1);
    expect(readFileSync(join(dir, "workspace.json"), "utf8")).toBe(before);
    rmSync(join(dir, "workspace.json.tmp"), { recursive: true });
    writeFileSync(join(dir, "workspace.json.tmp"), "{ half written");
    const ok = await s.transact((st) => createMemory(st, ctx, { title: "after", actor: USER }));
    expect(ok.rev).toBe(2);
    expect(readEnv().rev).toBe(2);
  });

  it("corrupt file: quarantined copy, refuses to start, original untouched", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workspace.json"), "{ not json");
    expect(() => FileStore.open({ dir })).toThrowError(StoreError);
    expect(names().some((n) => /^workspace\.corrupt-.*\.json$/.test(n))).toBe(true);
    expect(readFileSync(join(dir, "workspace.json"), "utf8")).toBe("{ not json");
    expect(existsSync(join(dir, "workspace.lock"))).toBe(false); // lock released on failure
  });

  it("structurally invalid state and bad rev are treated as corrupt", () => {
    mkdirSync(dir, { recursive: true });
    for (const body of [
      { schemaVersion: SCHEMA_VERSION, state: { schemaVersion: SCHEMA_VERSION, memories: 1 }, rev: 0 },
      { schemaVersion: SCHEMA_VERSION, state: { schemaVersion: SCHEMA_VERSION, memories: {}, revisions: {}, relations: {}, collections: {} }, rev: -1 },
    ]) {
      writeFileSync(join(dir, "workspace.json"), JSON.stringify(body));
      expect(() => FileStore.open({ dir })).toThrowError(expect.objectContaining({ code: "corrupt" }));
    }
  });

  it("missing workspace.json with an existing .bak refuses to reseed", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workspace.json.bak"), "{}");
    expect(() => FileStore.open({ dir })).toThrowError(expect.objectContaining({ code: "missing_with_backup" }));
  });

  it("lockfile: a live owner blocks a second open, close releases, a stale pid is taken over", async () => {
    const s = open();
    expect(() => FileStore.open({ dir })).toThrowError(expect.objectContaining({ code: "lock_held" }));
    await s.close();
    expect(existsSync(join(dir, "workspace.lock"))).toBe(false);
    writeFileSync(join(dir, "workspace.lock"), "999999");
    const taken = open({ isPidAlive: () => false });
    expect((await taken.read()).rev).toBe(0);
    expect(readFileSync(join(dir, "workspace.lock"), "utf8")).toBe(String(process.pid));
  });

  it("replace validates untrusted JSON, honours ifMatchRev, and accepts a bare or wrapped state", async () => {
    const s = open();
    const empty = JSON.stringify({ schemaVersion: SCHEMA_VERSION, memories: {}, revisions: {}, relations: {}, collections: {} });
    await expect(s.replace(empty, { ifMatchRev: 5 })).rejects.toMatchObject({ code: "conflict" });
    await expect(s.replace("nope")).rejects.toMatchObject({ code: "corrupt" });
    await expect(s.replace(JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: { x: 1 } }))).rejects.toMatchObject({ code: "corrupt" });
    expect((await s.replace(empty, { ifMatchRev: 0 })).rev).toBe(1);
    expect((await s.replace(JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: JSON.parse(empty) }))).rev).toBe(2);
  });

  it("operations after close are rejected", async () => {
    const s = open();
    await s.close();
    await expect(s.read()).rejects.toMatchObject({ code: "io" });
  });
});

