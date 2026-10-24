/* eslint-disable @typescript-eslint/no-explicit-any -- crafted untrusted-shaped states */
import { describe, expect, it } from "vitest";
import v1Drafts from "./__fixtures__/v1-drafts.json";
import { createMemory, updateMemory } from "./memoryOps.js";
import { migrateWorkspaceState } from "./migrate.js";
import { currentSavedRevision, getMemory, memoryHistory, pendingChanges, timeline } from "./queries.js";
import { createCollection, deleteCollection } from "./relations.js";
import { validateWorkspaceState } from "./state.js";
import { AGENT, seedSaved, setup, USER } from "./testUtils.js";
import { approveAll, approveRevision } from "./versioning.js";
import type { WorkspaceState } from "./types.js";

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("collections vs pending proposals", () => {
  function withProposal() {
    const s0 = setup();
    const col = createCollection(s0.state, s0.ctx, { id: "c1", name: "C" });
    const base = seedSaved(col.state, s0.ctx, { id: "m1" });
    const upd = updateMemory(base.state, base.ctx, { id: "m1", patch: { collectionId: "c1" }, actor: AGENT });
    return { state: upd.state, ctx: base.ctx };
  }

  it("deleteCollection refuses while a pending proposal's snapshot references it", () => {
    const { state } = withProposal();
    expect(getMemory(state, "m1")?.collectionId).toBeNull(); // saved content has no collection
    expect(codeOf(() => deleteCollection(state, { id: "c1" }))).toBe("collection_not_empty");
  });

  it("deleteCollection refuses for a pending-only new memory in the collection", () => {
    const s0 = setup();
    const col = createCollection(s0.state, s0.ctx, { id: "c1", name: "C" });
    const created = createMemory(col.state, s0.ctx, { id: "n", title: "N", collectionId: "c1", actor: AGENT });
    expect(codeOf(() => deleteCollection(created.state, { id: "c1" }))).toBe("collection_not_empty");
  });

  const dangling = (state: WorkspaceState): WorkspaceState => {
    const collections = { ...state.collections };
    delete collections.c1;
    return { ...state, collections };
  };

  it("approveRevision nulls a collectionId that no longer exists", () => {
    const { state, ctx } = withProposal();
    const rev = pendingChanges(state)[0].revisionId;
    const r = approveRevision(dangling(state), ctx, { revisionId: rev, actor: USER });
    expect(r.value.snapshot.collectionId).toBeNull();
    expect(getMemory(r.state, "m1")?.collectionId).toBeNull();
  });

  it("approveAll nulls dangling collection ids and stays valid", () => {
    const { state, ctx } = withProposal();
    const r = approveAll(dangling(state), ctx, { actor: USER });
    expect(getMemory(r.state, "m1")?.collectionId).toBeNull();
    expect(validateWorkspaceState(r.state).ok).toBe(true);
  });
});

describe("current saved revision is chain-based, not key-order based", () => {
  const snap = { title: "T", content: "", type: "fact", tags: [], collectionId: null, archived: false, metadata: {} };
  const rev = (id: string, parent: string | null, savedAt: string, status = "saved") => ({
    id,
    memoryId: "m",
    snapshot: { ...snap, content: id },
    parentRevisionId: parent,
    createdAt: savedAt,
    author: "a",
    origin: "user",
    status,
    note: "",
    savedAt: status === "saved" ? savedAt : null,
    decidedAt: savedAt,
  });
  const state = (revs: any[]): any => ({
    schemaVersion: 2,
    memories: { m: { id: "m", createdAt: "t", source: "s", provenance: { origin: "user", createdBy: "a" } } },
    revisions: Object.fromEntries(revs.map((r) => [r.id, r])),
    relations: {},
    collections: {},
  });

  it("ids \"9\" then \"10\" (JS iterates 9, 10) interpret the chain correctly, whatever the key order", () => {
    // chain: 10 is FIRST (parent null), 9 is SECOND. Key order alone would say 10 is last.
    const raw = state([rev("10", null, "2026-01-01T00:00:00.000Z"), rev("9", "10", "2026-01-02T00:00:00.000Z")]);
    expect(Object.keys(raw.revisions)).toEqual(["9", "10"]);
    const v = validateWorkspaceState(raw);
    expect(v.ok).toBe(true);
    const s = (v as { ok: true; state: WorkspaceState }).state;
    expect(currentSavedRevision(s, "m")?.id).toBe("9");
    expect(memoryHistory(s, "m").map((r) => r.id)).toEqual(["9", "10"]);
    expect(timeline(s).map((r) => r.id)).toEqual(["9", "10"]);
    expect(getMemory(s, "m")?.revisionId).toBe("9");
  });

  it("a pending revision must be based on the chain head (not the last key)", () => {
    const ok = state([
      rev("10", null, "2026-01-01T00:00:00.000Z"),
      rev("9", "10", "2026-01-02T00:00:00.000Z"),
      rev("11", "9", "2026-01-03T00:00:00.000Z", "pending"),
    ]);
    expect(validateWorkspaceState(ok).ok).toBe(true);
    const bad = state([
      rev("10", null, "2026-01-01T00:00:00.000Z"),
      rev("9", "10", "2026-01-02T00:00:00.000Z"),
      rev("11", "10", "2026-01-03T00:00:00.000Z", "pending"),
    ]);
    expect(validateWorkspaceState(bad)).toEqual({ ok: false, reason: "corrupt" });
    const pendingOnly = state([rev("5", "ghost", "2026-01-03T00:00:00.000Z", "pending")]);
    expect(validateWorkspaceState(pendingOnly).ok).toBe(false);
    const create = state([rev("5", null, "2026-01-03T00:00:00.000Z", "pending")]);
    expect(validateWorkspaceState(create).ok).toBe(true);
  });

  it("rejects saved revisions that do not form a single linear chain", () => {
    const t = (n: number) => `2026-01-0${n}T00:00:00.000Z`;
    // two roots
    expect(validateWorkspaceState(state([rev("9", null, t(1)), rev("10", null, t(2))])).ok).toBe(false);
    // fork: two children of the same parent
    expect(validateWorkspaceState(state([rev("a", null, t(1)), rev("b", "a", t(2)), rev("c", "a", t(3))])).ok).toBe(false);
    // parent is a non-saved revision
    expect(validateWorkspaceState(state([rev("a", null, t(1)), rev("x", "a", t(2), "rejected"), rev("b", "x", t(3))])).ok).toBe(false);
    // a proper chain is fine, rejected / superseded ones may hang anywhere
    expect(validateWorkspaceState(state([rev("a", null, t(1)), rev("x", "a", t(2), "rejected"), rev("b", "a", t(3))])).ok).toBe(true);
  });
});

describe("migration orphan memories", () => {
  it("a memory with neither saved nor pending revision gets its latest tip promoted to pending", () => {
    const raw: any = clone(v1Drafts);
    raw.memories.orphan = { id: "orphan", createdAt: "2026-02-01T00:00:30.000Z", source: "manual", provenance: { origin: "user", createdBy: "alice" } };
    const base = { memoryId: "orphan", branchId: "main", commitId: null, author: "alice" };
    const snapshot = { title: "Orphan", content: "x", type: "fact", tags: [], collectionId: null, archived: false, metadata: {} };
    // drafts whose parent chain reaches a SAVED revision of another memory (rev_1): skipped by the normal rules
    raw.revisions.orph_1 = { ...base, id: "orph_1", snapshot, parentRevisionId: "rev_1", createdAt: "2026-02-01T00:00:31.000Z" };
    raw.revisions.orph_2 = { ...base, id: "orph_2", snapshot: { ...snapshot, content: "y" }, parentRevisionId: "orph_1", createdAt: "2026-02-01T00:00:32.000Z" };
    const r = migrateWorkspaceState(raw);
    expect(r.ok).toBe(true);
    const s = (r as { ok: true; state: WorkspaceState }).state;
    expect(s.revisions.orph_2).toMatchObject({ status: "pending", origin: "import", note: "Carried over from v1", parentRevisionId: null, savedAt: null });
    expect(s.revisions.orph_1.status).toBe("superseded");
    expect(pendingChanges(s).some((p) => p.memoryId === "orphan")).toBe(true);
    expect(getMemory(s, "orphan")?.status).toBe("pending");
  });

  it("every migrated memory with revisions has a saved or pending revision", () => {
    const r = migrateWorkspaceState(clone(v1Drafts));
    const s = (r as { ok: true; state: WorkspaceState }).state;
    for (const id of Object.keys(s.memories)) {
      const revs = Object.values(s.revisions).filter((x) => x.memoryId === id);
      if (revs.length) expect(revs.some((x) => x.status === "saved" || x.status === "pending")).toBe(true);
    }
  });
});
