import { SCHEMA_VERSION, validateWorkspaceState, type ValidationResult } from "./state.js";
import type { MemorySnapshot, Revision } from "./types.js";
import { deepEqual, isPlainObject, isReservedKey } from "./util.js";

const CORRUPT: ValidationResult = { ok: false, reason: "corrupt" };

type Rec = Record<string, unknown>;

/** Own, non-reserved entry of an untrusted map (never reaches Object.prototype). */
function pick(map: Rec, key: unknown): Rec | undefined {
  if (typeof key !== "string" || isReservedKey(key) || !Object.hasOwn(map, key)) return undefined;
  const v = map[key];
  return isPlainObject(v) ? v : undefined;
}

/** A required v1 map: plain object whose keys are all safe. Throws (=> corrupt) otherwise. */
function mapOf(raw: Rec, name: string): Rec {
  const m = raw[name];
  if (!isPlainObject(m)) throw new Error(`${name} is not a map`);
  for (const k of Object.keys(m)) if (isReservedKey(k)) throw new Error(`reserved key in ${name}`);
  return m;
}

interface V1Parts {
  commits: Rec;
  branches: Rec;
  revisions: Rec;
}

/** Branch holding the single timeline: "main", else a branch with a head, else the current one. */
function timelineBranch(raw: Rec, { branches }: V1Parts): Rec | undefined {
  return (
    pick(branches, "main") ??
    Object.values(branches).find((b): b is Rec => isPlainObject(b) && typeof b.headCommitId === "string") ??
    pick(branches, raw.currentBranchId)
  );
}

/** Commit ids reachable from `head` through ALL parents (merge second parents included). */
function ancestorCommits(commits: Rec, head: unknown): Set<string> {
  const seen = new Set<string>();
  const stack: unknown[] = [head];
  while (stack.length) {
    const id = stack.pop();
    if (typeof id !== "string" || seen.has(id)) continue;
    const c = pick(commits, id);
    if (!c) continue; // unknown refs are ignored
    seen.add(id);
    if (Array.isArray(c.parentIds)) stack.push(...c.parentIds);
  }
  return seen;
}

/**
 * v1 (branches / commits / drafts) -> v2 (one timeline of revisions). The input is UNTRUSTED: lookups are
 * own-property only, reference chains use visited sets and unknown references degrade to null. The result
 * is NOT trusted either; the caller runs the strict v2 validator on it.
 */
function migrateV1(raw: Rec): unknown {
  const memories = mapOf(raw, "memories");
  const relations = mapOf(raw, "relations");
  const collections = mapOf(raw, "collections");
  const parts: V1Parts = {
    commits: mapOf(raw, "commits"),
    branches: mapOf(raw, "branches"),
    revisions: mapOf(raw, "revisions"),
  };
  const { commits, branches } = parts;
  const old = Object.entries(parts.revisions).map(([key, v]) => {
    if (!isPlainObject(v) || v.id !== key) throw new Error("bad revision");
    return v;
  });
  const timeline = timelineBranch(raw, parts);
  const timelineId = typeof timeline?.id === "string" ? timeline.id : null;
  const savedCommits = ancestorCommits(commits, timeline?.headCommitId);

  // 1. Revisions on the main timeline's history are SAVED (commit message = note, commit time = savedAt).
  const saved: Revision[] = [];
  const savedIds = new Set<string>();
  const rest: Rec[] = [];
  for (const r of old) {
    const commit = typeof r.commitId === "string" && savedCommits.has(r.commitId) ? pick(commits, r.commitId) : undefined;
    if (!commit) {
      rest.push(r);
      continue;
    }
    saved.push({
      ...convert(r, parts.revisions),
      origin: "user",
      status: "saved",
      note: commit.message as string,
      savedAt: commit.timestamp as string,
      decidedAt: commit.timestamp as string,
    });
    savedIds.add(r.id as string);
  }
  // v2 needs each memory's saved revisions to form ONE linear chain: order by time (stable on ties) and
  // re-parent every saved revision to the previous saved one of the same memory.
  saved.sort((a, b) => (a.savedAt === b.savedAt ? 0 : (a.savedAt as string) < (b.savedAt as string) ? -1 : 1));
  const current = new Map<string, Revision>();
  for (const r of saved) {
    r.parentRevisionId = current.get(r.memoryId)?.id ?? null;
    current.set(r.memoryId, r);
  }

  // 2. Everything else: per memory at most ONE proposal (the latest unsaved tip), the rest superseded.
  interface Candidate {
    rev: Rec;
    order: number;
    note: string;
  }
  const best = new Map<string, Candidate>();
  const tips = new Map<string, Candidate>(); // latest unsaved revision per (branch, memory)
  rest.forEach((r, order) => {
    const branchId = typeof r.branchId === "string" ? r.branchId : "";
    const onTimeline = branchId === timelineId && r.commitId === null;
    const name = pick(branches, branchId)?.name;
    const note = onTimeline ? "Unsaved draft carried over" : `Carried over from memory line ${typeof name === "string" ? name : branchId}`;
    tips.set(`${branchId}\u0000${String(r.memoryId)}`, { rev: r, order, note });
  });
  for (const cand of tips.values()) {
    const memoryId = cand.rev.memoryId as string;
    const base = current.get(memoryId);
    const onTimeline = cand.rev.branchId === timelineId;
    if (base && deepEqual(base.snapshot, cand.rev.snapshot)) continue;
    // A draft on the timeline itself only counts when it is built on the current saved revision.
    if (onTimeline && nearestSaved(cand.rev, parts.revisions, savedIds) !== (base?.id ?? null)) continue;
    const cur = best.get(memoryId);
    const newer =
      !cur ||
      (cand.rev.createdAt as string) > (cur.rev.createdAt as string) ||
      (cand.rev.createdAt === cur.rev.createdAt && cand.order > cur.order);
    if (newer) best.set(memoryId, cand);
  }

  // A memory must not end up with neither a saved nor a pending revision: carry its latest unsaved tip over.
  for (const id of Object.keys(memories)) {
    if (current.has(id) || best.has(id)) continue;
    let latest: Candidate | undefined;
    rest.forEach((r, order) => {
      if (r.memoryId !== id) return;
      if (!latest || (r.createdAt as string) >= (latest.rev.createdAt as string)) {
        latest = { rev: r, order, note: "Carried over from v1" };
      }
    });
    if (latest) best.set(id, latest);
  }

  const others: Revision[] = rest.map((r) => {
    const cand = best.get(r.memoryId as string);
    const base = convert(r, parts.revisions);
    if (cand && cand.rev === r) {
      return {
        ...base,
        parentRevisionId: current.get(r.memoryId as string)?.id ?? null,
        origin: "import",
        status: "pending",
        note: cand.note,
        savedAt: null,
        decidedAt: null,
      };
    }
    return { ...base, origin: "import", status: "superseded", note: "Superseded during upgrade", savedAt: null, decidedAt: r.createdAt as string };
  });

  const revisions: Record<string, Revision> = {};
  for (const r of [...saved, ...others]) revisions[r.id] = r;
  const out: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    memories: { ...memories },
    revisions,
    relations: Object.fromEntries(
      Object.entries(relations).map(([k, r]) => [
        k,
        isPlainObject(r) ? { ...r, status: "saved", decidedAt: typeof r.createdAt === "string" ? r.createdAt : null } : r,
      ]),
    ),
    collections: { ...collections },
  };
  return out;
}

/** v1 revision -> v2 shape with a dangling / cross-memory parent reset to null. Review fields are set by the caller. */
function convert(r: Rec, all: Rec): Revision {
  const parent = pick(all, r.parentRevisionId);
  return {
    id: r.id as string,
    memoryId: r.memoryId as string,
    snapshot: r.snapshot as MemorySnapshot,
    parentRevisionId: parent && parent.memoryId === r.memoryId ? (r.parentRevisionId as string) : null,
    createdAt: r.createdAt as string,
    author: r.author as string,
    origin: "import",
    status: "superseded",
    note: "",
    savedAt: null,
    decidedAt: null,
  };
}

/** Walks a draft's parent chain (visited set) to the first SAVED revision id, or null. */
function nearestSaved(draft: Rec, all: Rec, savedIds: Set<string>): string | null {
  const seen = new Set<string>();
  let cur: Rec | undefined = pick(all, draft.parentRevisionId);
  while (cur && typeof cur.id === "string" && !seen.has(cur.id)) {
    if (savedIds.has(cur.id)) return cur.id;
    seen.add(cur.id);
    cur = pick(all, cur.parentRevisionId);
  }
  return null;
}

/**
 * Accepts persisted / imported workspace data of any known schema and returns a STRICTLY validated v2 state.
 * v2 is validated as is; v1 is migrated (see migrateV1). Anything else is `version-mismatch` / `corrupt`.
 * Never throws.
 */
export function migrateWorkspaceState(raw: unknown): ValidationResult {
  if (!isPlainObject(raw)) return CORRUPT;
  if (raw.schemaVersion === SCHEMA_VERSION) return validateWorkspaceState(raw);
  if (raw.schemaVersion === 1) {
    let migrated: unknown;
    try {
      migrated = migrateV1(raw);
    } catch {
      return CORRUPT;
    }
    return validateWorkspaceState(migrated);
  }
  return { ok: false, reason: typeof raw.schemaVersion === "number" ? "version-mismatch" : "corrupt" };
}
