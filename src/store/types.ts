import type { Mutation, WorkspaceState } from "../domain/index.js";

export interface Snapshot {
  rev: number;
  state: WorkspaceState;
}

export type StoreErrorCode = "lock_held" | "corrupt" | "missing_with_backup" | "conflict" | "io";

/** Messages never contain file contents or driver errors; paths only for operator-facing startup errors. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

/** One user's workspace: serialized read-modify-write with an optimistic revision counter. */
export interface UserStore {
  /** Latest committed snapshot. */
  read(): Promise<Snapshot>;
  /** Serialized read-modify-write; an unchanged state (same object) is not persisted and does not bump rev. */
  transact<T>(fn: (state: WorkspaceState) => Mutation<T>): Promise<Snapshot & { value: T }>;
  /** Replace the whole workspace from untrusted JSON (import / reset). Optional optimistic-concurrency check. */
  replace(json: string, opts?: { ifMatchRev?: number }): Promise<Snapshot>;
  /** Replace with an already validated state (e.g. empty reset). */
  write(state: WorkspaceState): Promise<Snapshot>;
}

export interface WorkspaceStore {
  forUser(userId: string): UserStore;
}
