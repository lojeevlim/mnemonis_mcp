import { StoreError } from "./types.js";

/** Per-user storage quotas (MNEMONIS_MAX_WORKSPACE_BYTES / MNEMONIS_MAX_MEMORIES). */
export interface Quotas {
  /** Serialized workspace JSON, in bytes. */
  maxWorkspaceBytes: number;
  /** Number of memories (all statuses, including archived). */
  maxMemories: number;
}

export const DEFAULT_QUOTAS: Quotas = { maxWorkspaceBytes: 5 * 1024 * 1024, maxMemories: 5000 };

const mb = (n: number): string => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`);

/**
 * Throws StoreError("too_large") when a write would take the workspace over a quota. A write that does not GROW the
 * workspace is always allowed, so a user who is over a (newly lowered) quota can still archive, review and export.
 * `current` is only measured when the new state is over a limit.
 */
export function assertWithinQuota(json: string, state: { memories: object }, current: () => { json: string; memories: number }, q: Quotas): void {
  const bytes = Buffer.byteLength(json, "utf8");
  const memories = Object.keys(state.memories).length;
  if (bytes <= q.maxWorkspaceBytes && memories <= q.maxMemories) return;
  const before = current();
  if (bytes > q.maxWorkspaceBytes && bytes > Buffer.byteLength(before.json, "utf8")) {
    throw new StoreError("too_large", `Your workspace has reached its size limit of ${mb(q.maxWorkspaceBytes)}. Nothing was saved.`);
  }
  if (memories > q.maxMemories && memories > before.memories) {
    throw new StoreError("too_large", `Your workspace has reached its limit of ${q.maxMemories} memories. Nothing was saved.`);
  }
}
