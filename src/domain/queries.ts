import { DomainError } from "./context.js";
import type {
  ChangeKind,
  Memory,
  MemorySnapshot,
  Origin,
  Revision,
  WorkspaceState,
} from "./types.js";
import { safeGet } from "./util.js";

export interface PendingChange {
  memoryId: string;
  revisionId: string;
  kind: ChangeKind;
  title: string;
  author: string;
  origin: Origin;
  createdAt: string;
  note: string;
}

export function getRevision(state: WorkspaceState, revisionId: string): Revision {
  const r = safeGet(state.revisions, revisionId);
  if (!r) throw new DomainError("revision_not_found", `Revision not found: ${revisionId}`);
  return r;
}

export function changeKind(before: MemorySnapshot | undefined, after: MemorySnapshot): ChangeKind {
  if (!before) return "create";
  if (!before.archived && after.archived) return "archive";
  if (before.archived && !after.archived) return "restore";
  return "update";
}

interface RevisionIndex {
  /** memoryId -> current saved revision (head of its saved chain). */
  saved: Map<string, Revision>;
  /** memoryId -> its (single) pending revision. */
  pending: Map<string, Revision>;
}

/**
 * Head of one memory's saved chain: the saved revision no other saved revision of that memory has as
 * parent. Independent of key order. Valid states have exactly one; on crafted data fall back to the
 * latest savedAt (then latest in iteration order) so reads never throw.
 */
function chainHead(savedOfMemory: Revision[]): Revision | undefined {
  if (savedOfMemory.length === 0) return undefined;
  const parents = new Set<string>();
  for (const r of savedOfMemory) if (r.parentRevisionId !== null) parents.add(r.parentRevisionId);
  const tips = savedOfMemory.filter((r) => !parents.has(r.id));
  const pool = tips.length ? tips : savedOfMemory;
  let best = pool[0];
  for (const r of pool) if ((r.savedAt ?? "") >= (best.savedAt ?? "")) best = r;
  return best;
}

/** One pass over all revisions. */
function indexRevisions(state: WorkspaceState): RevisionIndex {
  const savedBy = new Map<string, Revision[]>();
  const pending = new Map<string, Revision>();
  for (const r of Object.values(state.revisions)) {
    if (r.status === "saved") {
      const list = savedBy.get(r.memoryId);
      if (list) list.push(r);
      else savedBy.set(r.memoryId, [r]);
    } else if (r.status === "pending") pending.set(r.memoryId, r);
  }
  const saved = new Map<string, Revision>();
  for (const [id, list] of savedBy) saved.set(id, chainHead(list) as Revision);
  return { saved, pending };
}

/** Ids of the memories that currently have at least one saved revision (one pass). */
export function memoryIdsWithSaved(state: WorkspaceState): Set<string> {
  const out = new Set<string>();
  for (const r of Object.values(state.revisions)) if (r.status === "saved") out.add(r.memoryId);
  return out;
}

/** The current saved revision of a memory (head of its saved chain), if any. */
export function currentSavedRevision(state: WorkspaceState, memoryId: string): Revision | undefined {
  return chainHead(Object.values(state.revisions).filter((r) => r.memoryId === memoryId && r.status === "saved"));
}

export function latestSavedRevisionId(state: WorkspaceState, memoryId: string): string | null {
  return currentSavedRevision(state, memoryId)?.id ?? null;
}

/** The open proposal (pending revision) of a memory, if any. */
export function pendingRevisionFor(state: WorkspaceState, memoryId: string): Revision | undefined {
  for (const r of Object.values(state.revisions)) {
    if (r.memoryId === memoryId && r.status === "pending") return r;
  }
  return undefined;
}

/** memoryId -> its pending revision. */
export function pendingRevisionMap(state: WorkspaceState): Record<string, Revision> {
  const out: Record<string, Revision> = {};
  for (const [id, r] of indexRevisions(state).pending) out[id] = r;
  return out;
}

/** Open proposals, in the order they were made (oldest first). */
export function pendingChanges(state: WorkspaceState): PendingChange[] {
  const { saved, pending } = indexRevisions(state);
  const out: PendingChange[] = [];
  const ordered = Object.values(state.revisions)
    .map((rev, i) => ({ rev, i }))
    .sort((x, y) => (x.rev.createdAt === y.rev.createdAt ? x.i - y.i : x.rev.createdAt < y.rev.createdAt ? -1 : 1))
    .map((x) => x.rev);
  for (const rev of ordered) {
    if (rev.status !== "pending" || pending.get(rev.memoryId) !== rev) continue;
    if (!safeGet(state.memories, rev.memoryId)) continue;
    out.push({
      memoryId: rev.memoryId,
      revisionId: rev.id,
      kind: changeKind(saved.get(rev.memoryId)?.snapshot, rev.snapshot),
      title: rev.snapshot.title,
      author: rev.author,
      origin: rev.origin,
      createdAt: rev.createdAt,
      note: rev.note,
    });
  }
  return out;
}

/** Alias: the Inbox list. */
export const listPending = pendingChanges;

/** Latest revision of a memory: its open proposal if any, else the current saved revision. */
export function latestRevisionId(state: WorkspaceState, memoryId: string): string | null {
  const { saved, pending } = indexRevisions(state);
  return (pending.get(memoryId) ?? saved.get(memoryId))?.id ?? null;
}

function materialize(
  state: WorkspaceState,
  memoryId: string,
  saved: Revision | undefined,
  pending: Revision | undefined,
): Memory | undefined {
  const identity = safeGet(state.memories, memoryId);
  const shown = saved ?? pending;
  if (!identity || !shown) return undefined;
  const snap = shown.snapshot;
  return {
    ...identity,
    ...snap,
    tags: [...snap.tags],
    status: pending ? "pending" : snap.archived ? "archived" : "saved",
    hasPending: !!pending,
    updatedAt: shown.savedAt ?? shown.createdAt,
    revisionId: shown.id,
  };
}

/**
 * Memories as the user sees them: saved content (never the proposal's), flagged `pending` while a
 * proposal is open. Memories that have no saved revision yet (new agent proposals, or rejected ones)
 * are hidden unless `includePending` is set (rejected ones stay hidden either way).
 */
export function listMemories(state: WorkspaceState, opts: { includePending?: boolean } = {}): Memory[] {
  const { saved, pending } = indexRevisions(state);
  const out: Memory[] = [];
  for (const id of Object.keys(state.memories)) {
    const s = saved.get(id);
    if (!s && !opts.includePending) continue;
    const m = materialize(state, id, s, pending.get(id));
    if (m) out.push(m);
  }
  return out.sort((a, b) =>
    a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : a.updatedAt < b.updatedAt ? 1 : -1,
  );
}

/** One memory including pending-only ones; undefined only when it has no saved or pending revision. */
export function getMemory(state: WorkspaceState, memoryId: string): Memory | undefined {
  return materialize(state, memoryId, currentSavedRevision(state, memoryId), pendingRevisionFor(state, memoryId));
}

/**
 * Revisions of a memory, newest first. By default only SAVED revisions (its real history), walked
 * along the saved chain from the current revision back; `includeUnsaved` lists every revision
 * (pending / rejected / superseded too) by creation time.
 */
export function memoryHistory(
  state: WorkspaceState,
  memoryId: string,
  opts: { includeUnsaved?: boolean } = {},
): Revision[] {
  const mine = Object.values(state.revisions).filter((r) => r.memoryId === memoryId);
  if (opts.includeUnsaved) {
    return mine
      .map((r, i) => ({ r, i }))
      .sort((a, b) => (a.r.createdAt === b.r.createdAt ? b.i - a.i : a.r.createdAt < b.r.createdAt ? 1 : -1))
      .map((x) => x.r);
  }
  return walkChain(mine.filter((r) => r.status === "saved"));
}

/** One memory's saved revisions as a chain, newest first (visited set: safe on cyclic data). */
function walkChain(savedRevs: Revision[]): Revision[] {
  const byId = new Map(savedRevs.map((r) => [r.id, r]));
  const out: Revision[] = [];
  const seen = new Set<string>();
  let cur = chainHead(savedRevs);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = cur.parentRevisionId === null ? undefined : byId.get(cur.parentRevisionId);
  }
  return out;
}

/** Position of each saved revision in its memory's chain (0 = first saved). */
function chainPositions(state: WorkspaceState): Map<string, number> {
  const groups = new Map<string, Revision[]>();
  for (const r of Object.values(state.revisions)) {
    if (r.status !== "saved") continue;
    const g = groups.get(r.memoryId);
    if (g) g.push(r);
    else groups.set(r.memoryId, [r]);
  }
  const pos = new Map<string, number>();
  for (const g of groups.values()) {
    const hist = walkChain(g);
    hist.forEach((r, i) => pos.set(r.id, hist.length - 1 - i));
  }
  return pos;
}

/** Saved revisions across all memories, newest saved first (ties: later in its chain, then later appended). */
export function timeline(state: WorkspaceState, limit?: number): Revision[] {
  const pos = chainPositions(state);
  const saved = Object.values(state.revisions)
    .filter((r) => r.status === "saved")
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ta = a.r.savedAt ?? "";
      const tb = b.r.savedAt ?? "";
      if (ta !== tb) return ta < tb ? 1 : -1;
      const pa = pos.get(a.r.id) ?? 0;
      const pb = pos.get(b.r.id) ?? 0;
      return pa === pb ? b.i - a.i : pb - pa;
    })
    .map((x) => x.r);
  return limit === undefined ? saved : saved.slice(0, Math.max(0, limit));
}
