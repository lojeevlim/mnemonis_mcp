import { ORIGINS, RELATION_STATUSES, REVISION_STATUSES, type Relation, type WorkspaceState } from "./types.js";
import { isJsonValue, isPlainObject, isReservedKey } from "./util.js";

export const SCHEMA_VERSION = 2;

export function createEmptyWorkspace(): WorkspaceState {
  return { schemaVersion: SCHEMA_VERSION, memories: {}, revisions: {}, relations: {}, collections: {} };
}

export type ValidationResult =
  | { ok: true; state: WorkspaceState }
  | { ok: false; reason: "corrupt" | "version-mismatch" };

/** Upper bound for imported / stored workspace JSON (characters). */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

type Rec = Record<string, unknown>;
const CORRUPT: ValidationResult = { ok: false, reason: "corrupt" };

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** Own entries of a map whose keys are safe and equal to each value's `id`. */
function entriesOf(map: unknown): [string, Rec][] | null {
  if (!isPlainObject(map)) return null;
  const out: [string, Rec][] = [];
  for (const key of Object.keys(map)) {
    const v = map[key];
    if (isReservedKey(key) || !isPlainObject(v) || v.id !== key) return null;
    out.push([key, v]);
  }
  return out;
}

const has = (map: Rec, key: unknown): boolean => isStr(key) && !isReservedKey(key) && Object.hasOwn(map, key);

function validSnapshot(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  return (
    isStr(v.title) &&
    isStr(v.content) &&
    isStr(v.type) &&
    isStrArray(v.tags) &&
    isStrOrNull(v.collectionId) &&
    typeof v.archived === "boolean" &&
    isPlainObject(v.metadata) &&
    isJsonValue(v.metadata)
  );
}

/** True when following `next` from any node revisits a node (cycle). Iterative, safe on bad data. */
function hasCycle(ids: string[], next: (id: string) => string[]): boolean {
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  for (const root of ids) {
    if (state.has(root)) continue;
    const stack: { id: string; rest: string[] }[] = [{ id: root, rest: [...next(root)] }];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const child = top.rest.pop();
      if (child === undefined) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const st = state.get(child);
      if (st === 1) return true;
      if (st === 2) continue;
      state.set(child, 1);
      stack.push({ id: child, rest: [...next(child)] });
    }
  }
  return false;
}

/**
 * Per memory: saved revisions form ONE linear chain (first has parent null, each next one's parent is the
 * previous saved), and a pending revision's parent is the chain head (null when nothing is saved yet).
 * Independent of key order.
 */
function validChains(revisions: [string, Rec][]): boolean {
  const savedBy = new Map<string, Rec[]>();
  const pendingBy = new Map<string, Rec>();
  for (const [, r] of revisions) {
    const mid = r.memoryId as string;
    if (r.status === "saved") savedBy.set(mid, [...(savedBy.get(mid) ?? []), r]);
    else if (r.status === "pending") pendingBy.set(mid, r);
  }
  const heads = new Map<string, string>();
  for (const [mid, list] of savedBy) {
    const ids = new Set(list.map((r) => r.id as string));
    const used = new Set<string>();
    const roots: Rec[] = [];
    for (const r of list) {
      const p = r.parentRevisionId as string | null;
      if (p === null) roots.push(r);
      else if (!ids.has(p) || used.has(p)) return false; // parent must be a saved sibling, used once
      else used.add(p);
    }
    // One root + every parent link inside the set and used once + no cycles (checked globally) = a line.
    if (roots.length !== 1) return false;
    const tips = list.filter((r) => !used.has(r.id as string));
    if (tips.length !== 1) return false;
    heads.set(mid, tips[0].id as string);
  }
  for (const [mid, r] of pendingBy) {
    if (r.parentRevisionId !== (heads.get(mid) ?? null)) return false;
  }
  return true;
}

/** Validates (and returns the relations normalised: missing status => saved). null = invalid. */
function validate(raw: Rec): Record<string, Relation> | null {
  const memories = entriesOf(raw.memories);
  const revisions = entriesOf(raw.revisions);
  const relations = entriesOf(raw.relations);
  const collections = entriesOf(raw.collections);
  if (!memories || !revisions || !relations || !collections) return null;
  const memMap = raw.memories as Rec;
  const revMap = raw.revisions as Rec;

  for (const [, m] of memories) {
    const p = m.provenance;
    if (!isStr(m.createdAt) || !isStr(m.source)) return null;
    if (!isPlainObject(p) || !isStr(p.origin) || !isStr(p.createdBy)) return null;
  }
  for (const [, c] of collections) {
    if (!isStr(c.name) || !isStr(c.description) || !isStr(c.createdAt)) return null;
  }
  for (const [, r] of relations) {
    const p = r.provenance;
    if (!has(memMap, r.fromId) || !has(memMap, r.toId) || !isStr(r.label) || !isStr(r.createdAt)) return null;
    if (!isPlainObject(p) || (p.origin !== "user" && p.origin !== "process") || !isStr(p.createdBy)) return null;
    if (p.process !== undefined && !isStr(p.process)) return null;
    if (p.demo !== undefined && typeof p.demo !== "boolean") return null;
    if (r.status !== undefined && !(isStr(r.status) && (RELATION_STATUSES as readonly string[]).includes(r.status))) return null;
    if (r.decidedAt !== undefined && !isStrOrNull(r.decidedAt)) return null;
  }
  const pendingMemories = new Set<string>();
  for (const [, r] of revisions) {
    if (!has(memMap, r.memoryId) || !validSnapshot(r.snapshot)) return null;
    if (!isStr(r.createdAt) || !isStr(r.author) || !isStr(r.note)) return null;
    if (!isStr(r.origin) || !(ORIGINS as readonly string[]).includes(r.origin)) return null;
    if (!isStr(r.status) || !(REVISION_STATUSES as readonly string[]).includes(r.status)) return null;
    if (!isStrOrNull(r.savedAt) || !isStrOrNull(r.decidedAt)) return null;
    if (r.status === "saved" && r.savedAt === null) return null;
    if (r.parentRevisionId !== null && !has(revMap, r.parentRevisionId)) return null;
    if (r.parentRevisionId !== null && (revMap[r.parentRevisionId as string] as Rec).memoryId !== r.memoryId) return null;
    if (r.status === "pending") {
      // Invariant: at most one pending revision per memory.
      if (pendingMemories.has(r.memoryId as string)) return null;
      pendingMemories.add(r.memoryId as string);
    }
  }
  const parentOf = (id: string) => {
    const p = (revMap[id] as Rec).parentRevisionId;
    return isStr(p) ? [p] : [];
  };
  if (hasCycle(revisions.map(([id]) => id), parentOf)) return null;
  if (!validChains(revisions)) return null;
  const out: Record<string, Relation> = {};
  for (const [id, r] of relations) {
    const status = r.status === undefined ? "saved" : r.status;
    out[id] = {
      ...(r as unknown as Relation),
      status: status as Relation["status"],
      decidedAt: r.decidedAt === undefined ? (status === "saved" ? (r.createdAt as string) : null) : (r.decidedAt as string | null),
    };
  }
  return out;
}

/**
 * Deep structural + referential validation of untrusted (localStorage / imported) data:
 * field types, id === map key, reserved keys, dangling references and cycles in
 * revision parents. Historic revisions may legitimately reference a
 * collection that was later deleted, so snapshot.collectionId is type-checked only.
 */
export function validateWorkspaceState(raw: unknown): ValidationResult {
  if (!isPlainObject(raw)) return CORRUPT;
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: typeof raw.schemaVersion === "number" ? "version-mismatch" : "corrupt" };
  }
  let relations: Record<string, Relation> | null;
  try {
    relations = validate(raw);
  } catch {
    return CORRUPT;
  }
  if (!relations) return CORRUPT;
  return { ok: true, state: { ...(raw as unknown as WorkspaceState), relations } };
}

/**
 * Number of SAVED revisions with origin "agent" in a (validated) state. The validator deliberately does not
 * constrain revision origin, so an import may carry them; a UI can surface this count in an import preview.
 */
export function savedAgentOriginCount(state: WorkspaceState): number {
  return Object.values(state.revisions).filter((r) => r.status === "saved" && r.origin === "agent").length;
}
