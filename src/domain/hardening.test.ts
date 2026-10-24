import { describe, expect, it } from "vitest";
import { createSequentialContext, type DomainContext } from "./context.js";
import { LIMITS } from "./limits.js";
import { createMemory, updateMemory } from "./memoryOps.js";
import { getMemory, listMemories, pendingChanges } from "./queries.js";
import {
  addRelation,
  createCollection,
  listRelations,
  pendingCount,
  removeRelation,
} from "./relations.js";
import { createEmptyWorkspace, validateWorkspaceState } from "./state.js";
import { AGENT, seedSaved, setup, USER } from "./testUtils.js";
import type { WorkspaceState } from "./types.js";
import { approveAll, approveAllDetailed, rejectAll, rejectRevision } from "./versioning.js";

const PROC = { origin: "process" as const, createdBy: "bot", process: "bot" };
const USERP = { origin: "user" as const, createdBy: "tester" };
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

function two() {
  const a = seedSaved(setup().state, undefined, { id: "m1", title: "One" });
  const b = seedSaved(a.state, a.ctx, { id: "m2", title: "Two" });
  return { state: b.state, ctx: b.ctx };
}

describe("size caps", () => {
  it("rejects long titles, too many / long tags for everyone", () => {
    const { ctx, state } = setup();
    for (const actor of [USER, AGENT]) {
      expect(codeOf(() => createMemory(state, ctx, { title: "x".repeat(201), actor }))).toBe("too_large");
      expect(codeOf(() => createMemory(state, ctx, { title: "x", tags: Array.from({ length: 21 }, (_, i) => `t${i}`), actor }))).toBe("too_large");
      expect(codeOf(() => createMemory(state, ctx, { title: "x", tags: ["y".repeat(51)], actor }))).toBe("too_large");
    }
    expect(createMemory(state, ctx, { title: "x".repeat(200), tags: ["y".repeat(50)], actor: USER }).value.title).toHaveLength(200);
  });

  it("agent content <= 50_000, user content generous", () => {
    const { ctx, state } = setup();
    expect(codeOf(() => createMemory(state, ctx, { title: "a", content: "c".repeat(LIMITS.agentContent + 1), actor: AGENT }))).toBe("too_large");
    expect(createMemory(state, ctx, { title: "a", content: "c".repeat(LIMITS.agentContent), actor: AGENT }).value).toBeTruthy();
    const big = createMemory(state, ctx, { title: "a", content: "c".repeat(500_000), actor: USER });
    expect(big.value.content).toHaveLength(500_000);
    expect(codeOf(() => createMemory(state, ctx, { title: "a", content: "c".repeat(1_000_001), actor: USER }))).toBe("too_large");
  });

  it("agent metadata <= 8KB; applies on update too and leaves state untouched", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1" });
    const metadata = { k: "v".repeat(9000) };
    expect(codeOf(() => updateMemory(base.state, base.ctx, { id: "m1", patch: { metadata }, actor: AGENT }))).toBe("too_large");
    expect(codeOf(() => updateMemory(base.state, base.ctx, { id: "m1", patch: { content: "c".repeat(50_001) }, actor: AGENT }))).toBe("too_large");
    expect(updateMemory(base.state, base.ctx, { id: "m1", patch: { metadata }, actor: USER }).value.metadata).toEqual(metadata);
    expect(pendingChanges(base.state)).toHaveLength(0);
  });

  it("an old oversized value does not block editing another field", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1" });
    const rev = Object.values(base.state.revisions)[0];
    const fat: WorkspaceState = {
      ...base.state,
      revisions: { [rev.id]: { ...rev, snapshot: { ...rev.snapshot, title: "t".repeat(300) } } },
    };
    expect(updateMemory(fat, base.ctx, { id: "m1", patch: { tags: ["a"] }, actor: USER }).value.tags).toEqual(["a"]);
  });
});

describe("listRelations visibility and orphans", () => {
  it("a saved relation to a rejected create does not leak; rejecting the create rejects the record", () => {
    const { state, ctx } = two();
    const p = createMemory(state, ctx, { id: "p", title: "P", actor: AGENT });
    // simulate migration marking everything saved: a SAVED relation pointing at a pending-only memory
    const rel = addRelation(p.state, ctx, { fromId: "m1", toId: "p", label: "l", provenance: PROC, actor: AGENT });
    const savedRel: WorkspaceState = {
      ...rel.state,
      relations: { ...rel.state.relations, [rel.value.id]: { ...rel.value, status: "saved", decidedAt: "t" } },
    };
    // pending-only endpoint: hidden
    expect(listRelations(savedRel)).toHaveLength(0);
    expect(listRelations(savedRel, "m1")).toHaveLength(0);
    expect(listRelations(savedRel, "p")).toHaveLength(0);
    const rejected = rejectRevision(savedRel, ctx, { revisionId: pendingChanges(savedRel)[0].revisionId, actor: USER });
    expect(listRelations(rejected.state, "m1")).toHaveLength(0);
    expect(rejected.state.relations[rel.value.id].status).toBe("rejected");
    expect(validateWorkspaceState(rejected.state).ok).toBe(true);
  });

  it("a saved relation between saved memories shows; approving the pending memory reveals its link", () => {
    const { state, ctx } = two();
    const u = addRelation(state, ctx, { fromId: "m1", toId: "m2", label: "k", provenance: USERP, actor: USER });
    expect(listRelations(u.state, "m2")).toHaveLength(1);
    const p = createMemory(u.state, ctx, { id: "p", title: "P", actor: AGENT });
    const a = addRelation(p.state, ctx, { fromId: "m1", toId: "p", label: "l", provenance: PROC, actor: AGENT });
    expect(listRelations(a.state, "p")).toHaveLength(0);
    expect(listRelations(a.state, "p", { includePending: true })).toHaveLength(1);
    const all = approveAll(a.state, ctx, { actor: USER });
    expect(listRelations(all.state, "p")).toHaveLength(1);
  });

  it("rejectAll also clears links to never-saveable memories", () => {
    const { state, ctx } = two();
    const p = createMemory(state, ctx, { id: "p", title: "P", actor: AGENT });
    const a = addRelation(p.state, ctx, { fromId: "m1", toId: "p", label: "l", provenance: PROC, actor: AGENT });
    const r = rejectAll(a.state, ctx, { actor: USER });
    expect(r.state.relations[a.value.id].status).toBe("rejected");
    expect(pendingCount(r.state)).toBe(0);
  });
});

describe("note stays Created for an agent's own pending create", () => {
  it("agent update of its own pending-only create", () => {
    const { ctx, state } = setup();
    const c = createMemory(state, ctx, { id: "n", title: "N", actor: AGENT });
    const u = updateMemory(c.state, ctx, { id: "n", patch: { title: "N2" }, actor: AGENT });
    const [change] = pendingChanges(u.state);
    expect(change.kind).toBe("create");
    expect(change.note).toBe("Created");
    expect(getMemory(u.state, "n")?.title).toBe("N2");
  });
});

describe("approveAll robustness and filters", () => {
  const ghostState = () => {
    const { state, ctx } = two();
    const p = createMemory(state, ctx, { id: "p", title: "P", actor: AGENT });
    const good = addRelation(p.state, ctx, { fromId: "m1", toId: "m2", label: "k", provenance: PROC, actor: AGENT });
    const ghost = {
      ...good.state,
      memories: { ...good.state.memories, g: { id: "g", createdAt: "t", source: "s", provenance: { origin: "user", createdBy: "x" } } },
    };
    const bad: WorkspaceState = {
      ...ghost,
      relations: { ...ghost.relations, bad: { ...good.value, id: "bad", toId: "g", label: "z" } },
    };
    return { bad, ctx, goodId: good.value.id };
  };

  it("approves everything approvable and reports the skipped link; revision ids still returned by approveAll", () => {
    const { bad, ctx, goodId } = ghostState();
    const d = approveAllDetailed(bad, ctx, { actor: USER });
    expect(d.value.approvedRevisionIds).toHaveLength(1);
    expect(d.value.approvedRelationIds).toEqual([goodId]);
    expect(d.value.skippedRelationIds).toEqual(["bad"]);
    expect(approveAll(bad, ctx, { actor: USER }).value).toHaveLength(1);
  });

  it("rejected-only endpoint link is skipped", () => {
    const { state, ctx } = two();
    const p = createMemory(state, ctx, { id: "p", title: "P", actor: AGENT });
    const a = addRelation(p.state, ctx, { fromId: "m1", toId: "p", label: "l", provenance: PROC, actor: AGENT });
    // reject only the revision directly, leaving the relation pending (inconsistent import)
    const rid = pendingChanges(a.state)[0].revisionId;
    const inconsistent: WorkspaceState = {
      ...a.state,
      revisions: { ...a.state.revisions, [rid]: { ...a.state.revisions[rid], status: "rejected", decidedAt: "t" } },
    };
    const d = approveAllDetailed(inconsistent, ctx, { actor: USER });
    expect(d.value.skippedRelationIds).toEqual([a.value.id]);
  });

  it("an outdated proposal still aborts everything", () => {
    const { state, ctx } = two();
    const s = updateMemory(state, ctx, { id: "m1", patch: { title: "A" }, actor: AGENT }).state;
    const bad = JSON.parse(JSON.stringify(s)) as WorkspaceState;
    bad.revisions[pendingChanges(bad)[0].revisionId].parentRevisionId = null;
    expect(codeOf(() => approveAll(bad, ctx, { actor: USER }))).toBe("proposal_outdated");
  });

  it("filters: only the given ids are approved / rejected; stale ids ignored", () => {
    const { state, ctx } = two();
    let s = updateMemory(state, ctx, { id: "m1", patch: { title: "A" }, actor: AGENT }).state;
    s = updateMemory(s, ctx, { id: "m2", patch: { title: "B" }, actor: AGENT }).state;
    const rel = addRelation(s, ctx, { fromId: "m1", toId: "m2", label: "k", provenance: PROC, actor: AGENT });
    const [first, second] = pendingChanges(rel.state);
    const a = approveAllDetailed(rel.state, ctx, { actor: USER, revisionIds: [first.revisionId, "ghost"], relationIds: [] });
    expect(a.value.approvedRevisionIds).toEqual([first.revisionId]);
    expect(a.value.ignoredIds).toEqual(["ghost"]);
    expect(pendingChanges(a.state).map((c) => c.revisionId)).toEqual([second.revisionId]);
    expect(a.state.relations[rel.value.id].status).toBe("pending");
    const r = rejectAll(rel.state, ctx, { actor: USER, revisionIds: [second.revisionId], relationIds: [rel.value.id] });
    expect(r.value).toEqual([second.revisionId]);
    expect(r.state.relations[rel.value.id].status).toBe("rejected");
    expect(pendingChanges(r.state).map((c) => c.revisionId)).toEqual([first.revisionId]);
    expect(approveAll(rel.state, ctx, { actor: USER, revisionIds: [] }).value).toEqual([]);
  });

  it("validateWorkspaceState rejects a pending relation to a missing memory", () => {
    const { state, ctx } = two();
    const a = addRelation(state, ctx, { fromId: "m1", toId: "m2", label: "k", provenance: PROC, actor: AGENT });
    const bad = { ...a.state, relations: { ...a.state.relations, [a.value.id]: { ...a.value, toId: "nope" } } };
    expect(validateWorkspaceState(bad).ok).toBe(false);
  });
});

describe("removeRelation", () => {
  it("is user-only", () => {
    const { state, ctx } = two();
    const u = addRelation(state, ctx, { fromId: "m1", toId: "m2", label: "k", provenance: USERP, actor: USER });
    expect(codeOf(() => removeRelation(u.state, { id: u.value.id, actor: AGENT }))).toBe("forbidden");
    expect(codeOf(() => removeRelation(u.state, { id: u.value.id } as never))).toBe("forbidden");
  });

  it("hard-deletes saved links but keeps pending / rejected ones as rejected records", () => {
    const { state, ctx } = two();
    const u = addRelation(state, ctx, { fromId: "m1", toId: "m2", label: "k", provenance: USERP, actor: USER });
    expect(removeRelation(u.state, { id: u.value.id, actor: USER }, ctx).state.relations[u.value.id]).toBeUndefined();
    const a = addRelation(state, ctx, { fromId: "m1", toId: "m2", label: "c", provenance: PROC, actor: AGENT });
    const r = removeRelation(a.state, { id: a.value.id, actor: USER }, ctx);
    expect(r.state.relations[a.value.id]).toMatchObject({ status: "rejected" });
    expect(r.state.relations[a.value.id].decidedAt).not.toBeNull();
    const again = removeRelation(r.state, { id: a.value.id, actor: USER }, ctx);
    expect(again.state.relations[a.value.id].status).toBe("rejected");
    expect(codeOf(() => removeRelation(r.state, { id: "zzz", actor: USER }))).toBe("relation_not_found");
  });
});

describe("id collisions", () => {
  const fixedCtx = (ids: string[]): DomainContext => {
    const base = createSequentialContext();
    let i = 0;
    return { now: () => base.now(), newId: () => ids[Math.min(i++, ids.length - 1)] };
  };

  it("never overwrites an existing revision; regenerates when possible, else duplicate_id", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1" });
    const existing = Object.keys(base.state.revisions)[0];
    const regen = fixedCtx([existing, "rev_fresh"]);
    const u = updateMemory(base.state, regen, { id: "m1", patch: { title: "T" }, actor: USER });
    expect(u.state.revisions[existing]).toEqual(base.state.revisions[existing]);
    expect(u.state.revisions["rev_fresh"]).toBeDefined();
    const stuck = fixedCtx([existing]);
    expect(codeOf(() => updateMemory(base.state, stuck, { id: "m1", patch: { title: "T" }, actor: USER }))).toBe("duplicate_id");
  });

  it("memory and collection ids: explicit duplicates fail, generated ones regenerate", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1" });
    expect(codeOf(() => createMemory(base.state, base.ctx, { id: "m1", title: "x", actor: USER }))).toBe("duplicate_id");
    const m = createMemory(base.state, fixedCtx(["m1", "mem_new", "rev_x"]), { title: "x", actor: USER });
    expect(m.value.id).toBe("mem_new");
    expect(Object.keys(m.state.memories)).toContain("m1");
    const c1 = createCollection(createEmptyWorkspace(), base.ctx, { id: "c", name: "A" });
    expect(codeOf(() => createCollection(c1.state, base.ctx, { id: "c", name: "B" }))).toBe("duplicate_id");
    const c2 = createCollection(c1.state, fixedCtx(["c", "col_2"]), { name: "B" });
    expect(c2.value.id).toBe("col_2");
    expect(c2.state.collections.c.name).toBe("A");
  });
});

describe("updateMemory validation", () => {
  it("normalises tags, rejects empty title/type, JSON-unsafe metadata, unknown collection", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1" });
    const run = (patch: Parameters<typeof updateMemory>[2]["patch"]) =>
      updateMemory(base.state, base.ctx, { id: "m1", patch, actor: USER });
    expect(run({ tags: [" a ", "a", "", "b"] }).value.tags).toEqual(["a", "b"]);
    expect(run({ title: "  Trim " }).value.title).toBe("Trim");
    expect(codeOf(() => run({ title: "   " }))).toBe("invalid_input");
    expect(codeOf(() => run({ type: " " }))).toBe("invalid_input");
    expect(codeOf(() => run({ collectionId: "nope" }))).toBe("collection_not_found");
    const col = createCollection(base.state, base.ctx, { name: "C" });
    expect(updateMemory(col.state, base.ctx, { id: "m1", patch: { collectionId: col.value.id }, actor: USER }).value.collectionId).toBe(col.value.id);
    const meta = run({ metadata: { n: 1, nested: { a: [true, null] } } }).value.metadata;
    expect(meta).toEqual({ n: 1, nested: { a: [true, null] } });
    // metadata is deep-cloned (JSON round trip): later mutation of the input must not leak
    const src = { x: { y: 1 } };
    const stored = run({ metadata: src }).value.metadata;
    src.x.y = 2;
    expect(stored).toEqual({ x: { y: 1 } });
    // undefined / functions are dropped by the JSON clone; the stored state stays valid
    const odd = updateMemory(base.state, base.ctx, { id: "m1", patch: { metadata: { f: undefined } as never }, actor: USER });
    expect(validateWorkspaceState(odd.state).ok).toBe(true);
    expect(listMemories(odd.state)).toHaveLength(1);
  });
});
