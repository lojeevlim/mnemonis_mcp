import { createEmptyWorkspace, type Mutation, type WorkspaceState } from "../src/domain/index.js";
import { parseImportJson } from "../src/store/importJson.js";
import { StoreError, type Snapshot, type UserStore } from "../src/store/types.js";

/** In-memory UserStore with the same serialized read-modify-write contract as PgStore: for service/guard tests that need no database. */
export class MemoryStore implements UserStore {
  private current: Snapshot = { rev: 0, state: createEmptyWorkspace() };
  private queue: Promise<unknown> = Promise.resolve();

  private enqueue<T>(op: () => T): Promise<T> {
    const run = this.queue.then(op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  read(): Promise<Snapshot> {
    return this.enqueue(() => this.current);
  }

  transact<T>(fn: (state: WorkspaceState) => Mutation<T>): Promise<Snapshot & { value: T }> {
    return this.enqueue(() => {
      const result = fn(this.current.state);
      if (result.state !== this.current.state) this.current = { rev: this.current.rev + 1, state: result.state };
      return { ...this.current, value: result.value };
    });
  }

  replace(json: string, opts: { ifMatchRev?: number } = {}): Promise<Snapshot> {
    return this.enqueue(() => {
      if (opts.ifMatchRev !== undefined && opts.ifMatchRev !== this.current.rev) {
        throw new StoreError("conflict", `Revision mismatch (current ${this.current.rev})`);
      }
      this.current = { rev: this.current.rev + 1, state: parseImportJson(json) };
      return this.current;
    });
  }

  write(state: WorkspaceState): Promise<Snapshot> {
    return this.enqueue(() => (this.current = { rev: this.current.rev + 1, state }));
  }

  async close(): Promise<void> {
    await this.queue;
  }
}
