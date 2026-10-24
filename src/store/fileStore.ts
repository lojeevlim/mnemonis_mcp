import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  createEmptyWorkspace,
  migrateWorkspaceState,
  SCHEMA_VERSION,
  type Mutation,
  type WorkspaceState,
} from "../domain/index.js";
import { parseImportJson } from "./importJson.js";
import { StoreError, type Snapshot, type UserStore, type WorkspaceStore } from "./types.js";

export { StoreError, type Snapshot, type StoreErrorCode } from "./types.js";

export interface FileStoreOptions {
  dir: string;
  /** Initial workspace when no file exists yet (default: empty). */
  createInitial?: () => WorkspaceState;
  /** Test hook: decides whether a lock owner pid is alive. */
  isPidAlive?: (pid: number) => boolean;
}

const FILE = "workspace.json";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Single-file workspace store: { schemaVersion, state, rev } in <dir>/workspace.json.
 * One process owns it (lockfile); inside the process every change goes through a promise queue.
 */
export class FileStore implements UserStore, WorkspaceStore {
  private readonly file: string;
  private readonly tmp: string;
  private readonly bak: string;
  private readonly lockFile: string;
  private current: Snapshot;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly opts: FileStoreOptions,
    snapshot: Snapshot,
  ) {
    this.file = join(opts.dir, FILE);
    this.tmp = `${this.file}.tmp`;
    this.bak = `${this.file}.bak`;
    this.lockFile = join(opts.dir, "workspace.lock");
    this.current = snapshot;
  }

  /** Acquires the lock, loads + validates the file (or creates the initial workspace). Throws StoreError. */
  static open(opts: FileStoreOptions): FileStore {
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    const alive = opts.isPidAlive ?? pidAlive;
    const lockFile = join(opts.dir, "workspace.lock");
    FileStore.acquireLock(lockFile, alive);
    try {
      const file = join(opts.dir, FILE);
      const store = new FileStore(opts, FileStore.load(opts, file));
      if (!existsSync(file)) store.persist(store.current);
      return store;
    } catch (e) {
      FileStore.releaseLock(lockFile);
      throw e;
    }
  }

  private static acquireLock(lockFile: string, alive: (pid: number) => boolean): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lockFile, "wx", 0o600);
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const pid = Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10);
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
        throw new StoreError("lock_held", `Workspace is locked by running process ${pid} (${lockFile})`);
      }
      unlinkSync(lockFile); // stale lock from a dead process
    }
    throw new StoreError("lock_held", `Could not acquire workspace lock (${lockFile})`);
  }

  private static releaseLock(lockFile: string): void {
    try {
      if (readFileSync(lockFile, "utf8").trim() === String(process.pid)) unlinkSync(lockFile);
    } catch {
      /* already gone */
    }
  }

  private static load(opts: FileStoreOptions, file: string): Snapshot {
    if (!existsSync(file)) {
      if (existsSync(`${file}.bak`)) {
        throw new StoreError("missing_with_backup", `${file} is missing but ${file}.bak exists; restore it manually`);
      }
      return { rev: 0, state: (opts.createInitial ?? createEmptyWorkspace)() };
    }
    const raw = readFileSync(file, "utf8");
    const snapshot = FileStore.parse(raw);
    if (snapshot) return snapshot;
    const quarantine = join(opts.dir, `workspace.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    copyFileSync(file, quarantine);
    throw new StoreError("corrupt", `${file} is unreadable; a copy was saved to ${quarantine}. Fix or remove it, then restart.`);
  }

  private static parse(raw: string): Snapshot | null {
    try {
      const env = JSON.parse(raw) as { state?: unknown; rev?: unknown } | null;
      if (env === null || typeof env !== "object") return null;
      const rev = env.rev === undefined ? 0 : env.rev;
      if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 0) return null;
      const v = migrateWorkspaceState(env.state);
      return v.ok ? { rev, state: v.state } : null;
    } catch {
      return null;
    }
  }

  /** Single-workspace store: every user id maps to the same workspace. */
  forUser(): UserStore {
    return this;
  }

  /** Latest committed snapshot (waits for queued writes so callers read their own writes). */
  read(): Promise<Snapshot> {
    return this.enqueue(() => this.current);
  }

  /**
   * Serialized read-modify-write. `fn` receives the latest state and returns the next state plus a value
   * (a domain mutation). Throwing leaves state and file untouched. An unchanged state (same object) is
   * not persisted and does not bump rev.
   */
  transact<T>(fn: (state: WorkspaceState) => Mutation<T>): Promise<Snapshot & { value: T }> {
    return this.enqueue(() => {
      const result = fn(this.current.state);
      if (result.state !== this.current.state) this.commit(result.state);
      return { ...this.current, value: result.value };
    });
  }

  /** Replace the whole workspace from untrusted JSON (import / reset). Optional optimistic-concurrency check. */
  replace(json: string, opts: { ifMatchRev?: number } = {}): Promise<Snapshot> {
    return this.enqueue(() => {
      if (opts.ifMatchRev !== undefined && opts.ifMatchRev !== this.current.rev) {
        throw new StoreError("conflict", `Revision mismatch (current ${this.current.rev})`);
      }
      this.commit(parseImportJson(json));
      return this.current;
    });
  }

  /** Replace with an already validated state (e.g. empty reset). */
  write(state: WorkspaceState): Promise<Snapshot> {
    return this.enqueue(() => {
      this.commit(state);
      return this.current;
    });
  }

  /** Waits for queued work, then releases the lock. The store is unusable afterwards. */
  async close(): Promise<void> {
    await this.queue;
    if (this.closed) return;
    this.closed = true;
    FileStore.releaseLock(this.lockFile);
  }

  private commit(state: WorkspaceState): void {
    const next: Snapshot = { rev: this.current.rev + 1, state };
    this.persist(next); // throws => memory untouched
    this.current = next;
  }

  private enqueue<T>(op: () => T): Promise<T> {
    if (this.closed) return Promise.reject(new StoreError("io", "Store is closed"));
    const run = this.queue.then(op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** tmp file in the same dir + fsync + rename; the previous good file is kept as .bak. */
  private persist(snapshot: Snapshot): void {
    const body = JSON.stringify({ schemaVersion: SCHEMA_VERSION, state: snapshot.state, rev: snapshot.rev });
    const fd = openSync(this.tmp, "w", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (existsSync(this.file)) copyFileSync(this.file, this.bak);
    renameSync(this.tmp, this.file);
    try {
      const dirFd = openSync(this.opts.dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      /* directory fsync is best effort (unsupported on some platforms) */
    }
  }
}
