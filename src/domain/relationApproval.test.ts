/* eslint-disable @typescript-eslint/no-explicit-any -- hostile / legacy shaped data */
import { describe, expect, it } from "vitest";
import { createMemory, updateMemory } from "./memoryOps.js";
import { getMemory, listMemories, pendingChanges } from "./queries.js";
import {
  addRelation,
  approveRelation,
  listPendingRelations,
  listRelations,
  pendingCount,
  rejectRelation,
  removeRelation,
} from "./relations.js";
import { searchWorkspace } from "./search.js";
import { validateWorkspaceState } from "./state.js";
import { AGENT, seedSaved, setup, USER } from "./testUtils.js";
import { approveAll, approveAllDetailed, approveRevision, rejectAll, rejectRevision } from "./versioning.js";
import type { WorkspaceState } from "./types.js";

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

describe("agent relations wait for approval", () => {
  it("a user link is saved at once; an agent link is pending and invisible in listings", () => {
    const { state, ctx } = two();
    const u = addRelation(state, ctx, { fromId: "m1", toId: "m2", label: "knows", provenance: USERP, actor: USER });
    expect(u.value).toMatchObject({ status: "saved" });
    expect(u.value.decidedAt).toBe(u.value.createdAt);
    const a = addRelation(u.state, ctx, { fromId: "m2", toId: "m1", label: "cites", provenance: PROC, actor: AGENT });
    expect(a.value).toMatchObject({ status: "pending", decidedAt: null, provenance: PROC });
    expect(listRelations(a.state).map((r) => r.label)).toEqual(["knows"]);
    expect(listRelations(a.state, "m1").map((r) => r.label)).toEqual(["knows"]);
    expect(listRelations(a.state, undefined, { includePending: true })).toHaveLength(2);
    expect(pendingCount(a.state)).toBe(1);
  });

  it("listPendingRelations describes proposals with titles and author", () => {
    const { state, ctx } = two();
    const a = addRelation(state, ctx, { fromId: "m1", toId: "m2", label: "cites", provenance: PROC, actor: AGENT });
    expect(listPendingRelations(a.state)).toEqual([
      {
        relationId: a.value.id,
        fromId: "m1",
        toId: "m2",
        label: "cites",
        author: "bot",
        provenance: PROC,
        createdAt: a.value.createdAt,
        fromTitle: "One",
        toTitle: "Two",
        ready: true,
      },
    ]);
  });

  it("requires an actor, existing endpoints, and saved endpoints for a saved link", () => {
    const { state, ctx } = two();
    expect(codeOf(() => (addRelation as any)(state, ctx, { fromId: "m1", toId: "m2", label: "x", provenance: USERP }))).toBe("invalid_input");
    expect(codeOf(() => addRelation(state, ctx, { fromId: "m1", toId: "zz", label: "x", provenance: PROC, actor: AGENT }))).toBe("memory_not_found");
    const pend = createMemory(state, ctx, { id: "p", title: "P", actor: AGENT });
    // a user cannot save a link to a pending-only memory...
    expect(codeOf(() => addRelation(pend.state, ctx, { fromId: "m1", toId: "p", label: "x", provenance: USERP, actor: USER }))).toBe("endpoint_not_saved");
    // ...but an agent may propose one
    const ok = addRelation(pend.state, ctx, { fromId: "m1", toId: "p", label: "x", provenance: PROC, actor: AGENT });
    expect(ok.value.status).toBe("pending");
    expect(listPendingRelations(ok.state)[0]).toMatchObject({ ready: false, toTitle: "P" });
  });

  it("a rejected link does not block proposing it again", () => {
    const { state, ctx } = two();
    const a = addRelation(state, ctx, { fromId: "m1", toId: "m2", label: "l", provenance: PROC, actor: AGENT });
    expect(codeOf(() => addRelation(a.state, ctx, { fromId: "m1", toId: "m2", label: "l", provenance: PROC, actor: AGENT }))).toBe("duplicate_relation");
    const r = rejectRelation(a.state, ctx, { relationId: a.value.id, actor: USER });
    expect(r.value).toMatchObject({ status: "rejected" });
    expect(r.value.decidedAt).not.toBeNull();
    expect(addRelation(r.state, ctx, { fromId: "m1", toId: "m2", label: "l", provenance: PROC, actor: AGENT }).value.status).toBe("pending");
  });
});

describe("approveRelation / rejectRelation", () => {
  it("approve makes the link saved and visible; only users may decide", () => {
    const { state, ctx } = two();
    const a = addRelation(state, ctx, { fromId: "m1", toId: "m2", label: "l", provenance: PROC, actor: AGENT });
    expect(codeOf(() => approveRelation(a.state, ctx, { relationId: a.value.id, actor: AGENT }))).toBe("forbidden");
    expect(codeOf(() => rejectRelation(a.state, ctx, { relationId: a.value.id, actor: AGENT }))).toBe("forbidden");
    const ok = approveRelation(a.state, ctx, { relationId: a.value.id, actor: USER });
    expect(ok.value.status).toBe("saved");
    expect(listRelations(ok.state)).toHaveLength(1);
    expect(pendingCount(ok.state)).toBe(0);
    expect(codeOf(() => approveRelation(ok.state, ctx, { relationId: a.value.id, actor: USER }))).toBe("not_pending");
    expect(codeOf(() => rejectRelation(ok.state, ctx, { relationId: a.value.id, actor: USER }))).toBe("not_pending");
    expect(codeOf(() => approveRelation(ok.state, ctx, { relationId: "nope", actor: USER }))).toBe("relation_not_found");
    // saved links are still removable as before
    expect(listRelations(removeRelation(ok.state, { id: a.value.id, actor: USER }).state)).toHaveLength(0);
  });

  it("approve fails while an endpoint is unsaved, works once the memory is approved", () => {
    const { state, ctx } = two();
    const p = createMemory(state, ctx, { id: "p", title: "P", actor: AGENT });
    const a = addRelation(p.state, ctx, { fromId: "m1", toId: "p", label: "l", provenance: PROC, actor: AGENT });
    expect(codeOf(() => approveRelation(a.state, ctx, { relationId: a.value.id, actor: USER }))).toBe("endpoint_not_saved");
    const rev = pendingChanges(a.state)[0].revisionId;
    const m = approveRevision(a.state, ctx, { revisionId: rev, actor: USER });
    expect(approveRelation(m.state, ctx, { relationId: a.value.id, actor: USER }).value.status).toBe("saved");
  });

  it("pending links never reach search or memory listings", () => {
    const { state, ctx } = two();
    const a = addRelation(state, ctx, { fromId: "m1", toId: "m2", label: "l", provenance: PROC, actor: AGENT });
    expect(listMemories(a.state)).toHaveLength(2);
    expect(searchWorkspace(a.state, {}).total).toBe(2);
    expect(listRelations(a.state, "m2")).toHaveLength(0);
  });
});

describe("approveAll / rejectAll with relations", () => {
  it("approveAll approves memories and links (links to a new memory included) atomically", () => {
    const { state, ctx } = two();
    const p = createMemory(state, ctx, { id: "p", title: "P", actor: AGENT });
    const a = addRelation(p.state, ctx, { fromId: "m1", toId: "p", label: "l", provenance: PROC, actor: AGENT });
    const b = addRelation(a.state, ctx, { fromId: "m1", toId: "m2", label: "k", provenance: PROC, actor: AGENT });
    expect(pendingCount(b.state)).toBe(3);
    const r = approveAll(b.state, ctx, { actor: USER });
    expect(r.value).toHaveLength(1);
    expect(listRelations(r.state)).toHaveLength(2);
    expect(pendingCount(r.state)).toBe(0);
    expect(getMemory(r.state, "p")?.status).toBe("saved");
    expect(validateWorkspaceState(r.state).ok).toBe(true);
  });

  it("approveAll skips a link that cannot be approved instead of locking everything", () => {
    const { state, ctx } = two();
    const a = addRelation(state, ctx, { fromId: "m1", toId: "m2", label: "k", provenance: PROC, actor: AGENT });
    // a corrupt proposal: pending link to a memory with no saved or pending revision
    const ghost = { ...a.state, memories: { ...a.state.memories, g: { id: "g", createdAt: "t", source: "s", provenance: { origin: "user", createdBy: "x" } } } };
    const bad: WorkspaceState = {
      ...ghost,
      relations: { ...ghost.relations, bad: { ...a.value, id: "bad", toId: "g", label: "z" } },
    };
    const r = approveAllDetailed(bad, ctx, { actor: USER });
    expect(r.value.approvedRelationIds).toEqual([a.value.id]);
    expect(r.value.skippedRelationIds).toEqual(["bad"]);
    expect(r.state.relations.bad.status).toBe("pending");
    expect(bad.relations[a.value.id].status).toBe("pending"); // input untouched
  });

  it("approveAll / rejectAll are user only", () => {
    const { state, ctx } = two();
    expect(codeOf(() => approveAll(state, ctx, { actor: AGENT }))).toBe("forbidden");
    expect(codeOf(() => rejectAll(state, ctx, { actor: AGENT }))).toBe("forbidden");
  });

  it("rejectAll rejects links too and keeps them as rejected records", () => {
    const { state, ctx } = two();
    const a = addRelation(state, ctx, { fromId: "m1", toId: "m2", label: "k", provenance: PROC, actor: AGENT });
    const r = rejectAll(a.state, ctx, { actor: USER });
    expect(r.state.relations[a.value.id].status).toBe("rejected");
    expect(pendingCount(r.state)).toBe(0);
    expect(listRelations(r.state, undefined, { includePending: true })).toHaveLength(0);
  });

  it("rejecting a memory create auto-rejects pending links touching it", () => {
    const { state, ctx } = two();
    const p = createMemory(state, ctx, { id: "p", title: "P", actor: AGENT });
    const a = addRelation(p.state, ctx, { fromId: "m1", toId: "p", label: "l", provenance: PROC, actor: AGENT });
    const other = addRelation(a.state, ctx, { fromId: "m1", toId: "m2", label: "k", provenance: PROC, actor: AGENT });
    const r = rejectRevision(other.state, ctx, { revisionId: pendingChanges(other.state)[0].revisionId, actor: USER });
    expect(r.state.relations[a.value.id]).toMatchObject({ status: "rejected" });
    expect(r.state.relations[a.value.id].decidedAt).not.toBeNull();
    expect(r.state.relations[other.value.id].status).toBe("pending"); // unrelated link untouched
  });

  it("rejecting an edit of an already-saved memory leaves its links alone", () => {
    const { state, ctx } = two();
    const a = addRelation(state, ctx, { fromId: "m1", toId: "m2", label: "k", provenance: PROC, actor: AGENT });
    const e = updateMemory(a.state, ctx, { id: "m1", patch: { title: "Edited" }, actor: AGENT });
    const r = rejectRevision(e.state, ctx, { revisionId: pendingChanges(e.state)[0].revisionId, actor: USER });
    expect(r.state.relations[a.value.id].status).toBe("pending");
  });
});

describe("relation status in stored data", () => {
  const base = () => {
    const { state, ctx } = two();
    const u = addRelation(state, ctx, { fromId: "m1", toId: "m2", label: "k", provenance: USERP, actor: USER });
    return JSON.parse(JSON.stringify(u.state)) as any;
  };

  it("v2 data without status / decidedAt loads and is normalised to saved", () => {
    const raw = base();
    const id = Object.keys(raw.relations)[0];
    delete raw.relations[id].status;
    delete raw.relations[id].decidedAt;
    const v = validateWorkspaceState(raw);
    expect(v.ok).toBe(true);
    const rel = (v as { ok: true; state: WorkspaceState }).state.relations[id];
    expect(rel.status).toBe("saved");
    expect(rel.decidedAt).toBe(rel.createdAt);
    expect(raw.relations[id].status).toBeUndefined(); // input not mutated
    expect(listRelations((v as { ok: true; state: WorkspaceState }).state)).toHaveLength(1);
  });

  it("rejects hostile status / decidedAt values", () => {
    for (const mutate of [
      (r: any) => (r.status = "alien"),
      (r: any) => (r.status = 1),
      (r: any) => (r.status = null),
      (r: any) => (r.status = { __proto__: 1 }),
      (r: any) => (r.decidedAt = 5),
      (r: any) => (r.decidedAt = {}),
    ]) {
      const raw = base();
      mutate(raw.relations[Object.keys(raw.relations)[0]]);
      expect(validateWorkspaceState(raw)).toEqual({ ok: false, reason: "corrupt" });
    }
  });

  it("accepts pending and rejected relations", () => {
    const raw = base();
    const id = Object.keys(raw.relations)[0];
    raw.relations[id].status = "pending";
    raw.relations[id].decidedAt = null;
    expect(validateWorkspaceState(raw).ok).toBe(true);
    raw.relations[id].status = "rejected";
    raw.relations[id].decidedAt = "2026-01-01T00:00:00.000Z";
    expect(validateWorkspaceState(raw).ok).toBe(true);
  });
});
