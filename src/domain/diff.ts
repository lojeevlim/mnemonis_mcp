import { DomainError } from "./context.js";
import { currentSavedRevision, getRevision } from "./queries.js";
import { MEMORY_FIELDS, type MemoryFieldName, type MemoryFieldValue, type MemorySnapshot, type WorkspaceState } from "./types.js";
import { deepEqual } from "./util.js";

export interface LineDiff {
  type: "equal" | "add" | "remove";
  text: string;
}

export interface FieldChange {
  field: MemoryFieldName;
  before: MemoryFieldValue | undefined;
  after: MemoryFieldValue | undefined;
  /** Present for the `content` field. */
  lines?: LineDiff[];
}

export interface MemoryDiff {
  memoryId: string;
  kind: "added" | "removed" | "modified";
  fields: FieldChange[];
}

/** Hand-written LCS line diff (common prefix/suffix trimmed first). */
export function diffLines(before: string, after: string): LineDiff[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: LineDiff[] = a.slice(0, start).map((text) => ({ type: "equal", text }));
  const mid = middleDiff(a.slice(start, endA), b.slice(start, endB));
  out.push(...mid);
  out.push(...a.slice(endA).map((text): LineDiff => ({ type: "equal", text })));
  return out;
}

function middleDiff(a: string[], b: string[]): LineDiff[] {
  if (a.length === 0) return b.map((text) => ({ type: "add", text }));
  if (b.length === 0) return a.map((text) => ({ type: "remove", text }));
  if (a.length * b.length > 4_000_000) {
    return [...a.map((text): LineDiff => ({ type: "remove", text })), ...b.map((text): LineDiff => ({ type: "add", text }))];
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: LineDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "equal", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "remove", text: a[i++] });
    } else {
      out.push({ type: "add", text: b[j++] });
    }
  }
  while (i < n) out.push({ type: "remove", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

/** Field-level diff of two snapshots (either side may be absent). */
export function diffSnapshots(
  before: MemorySnapshot | undefined,
  after: MemorySnapshot | undefined,
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of MEMORY_FIELDS) {
    const b = before?.[field] as MemoryFieldValue | undefined;
    const a = after?.[field] as MemoryFieldValue | undefined;
    if (deepEqual(a, b)) continue;
    const change: FieldChange = { field, before: b, after: a };
    if (field === "content") change.lines = diffLines((b as string | undefined) ?? "", (a as string | undefined) ?? "");
    out.push(change);
  }
  return out;
}

export function diffRevisions(state: WorkspaceState, fromRevisionId: string, toRevisionId: string): FieldChange[] {
  return diffSnapshots(getRevision(state, fromRevisionId).snapshot, getRevision(state, toRevisionId).snapshot);
}

/** What approving a pending revision would change: pending snapshot vs the memory's current saved snapshot. */
export function diffPending(state: WorkspaceState, revisionId: string): MemoryDiff {
  const rev = getRevision(state, revisionId);
  if (rev.status !== "pending") throw new DomainError("not_pending", "Only pending changes can be diffed this way");
  const before = currentSavedRevision(state, rev.memoryId)?.snapshot;
  return {
    memoryId: rev.memoryId,
    kind: before ? "modified" : "added",
    fields: diffSnapshots(before, rev.snapshot),
  };
}
