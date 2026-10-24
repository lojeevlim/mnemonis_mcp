import { describe, expect, it } from "vitest";
import { archiveMemory, createMemory, rollbackMemory, updateMemory } from "./memoryOps.js";
import {
  approveAll,
  approveRevision,
  describeChange,
  rejectAll,
  rejectRevision,
} from "./versioning.js";
import {
  getMemory,
  latestRevisionId,
  latestSavedRevisionId,
  listMemories,
  listPending,
  memoryHistory,
  pendingChanges,
  pendingRevisionMap,
  timeline,
} from "./queries.js";
import { diffPending } from "./diff.js";
import { AGENT, seedSaved, setup, USER } from "./testUtils.js";
import type { MemorySnapshot } from "./types.js";

const snap = (over: Partial<MemorySnapshot> = {}): MemorySnapshot => ({
  title: "T",
  content: "c",
  type: "fact",
  tags: [],
  collectionId: null,
  archived: false,
  metadata: {},
  ...over,
});

describe("describeChange", () => {
  it("describes create, edits, archive and restore", () => {
    expect(describeChange(undefined, snap())).toBe("Created");
    expect(describeChange(snap(), snap({ content: "d" }))).toBe("Edited content");
    expect(describeChange(snap(), snap({ content: "d", tags: ["x"] }))).toBe("Edited content, tags");
    expect(describeChange(snap(), snap({ collectionId: "c1", title: "U" }))).toBe("Edited title, collection");
    expect(describeChange(snap(), snap({ archived: true }))).toBe("Archived");
    expect(describeChange(snap({ archived: true }), snap())).toBe("Restored");
    expect(describeChange(snap(), snap())).toBe("Edited");
  });
});

function withProposal() {
  const base = seedSaved(setup().state, undefined, { id: "m1", content: "orig" });
  const s = updateMemory(base.state, base.ctx, { id: "m1", patch: { content: "agent" }, actor: AGENT }).state;
  return { ...base, state: s, revId: pendingChanges(s)[0].revisionId };
}

describe("approve / reject", () => {
  it("approve saves the proposal with its note and stamps savedAt", () => {
    const { state, ctx, revId } = withProposal();
    const { state: s, value } = approveRevision(state, ctx, { revisionId: revId, actor: USER });
    expect(value).toMatchObject({ status: "saved", origin: "agent", note: "Edited content" });
    expect(value.savedAt).not.toBeNull();
    expect(value.decidedAt).toBe(value.savedAt);
    expect(getMemory(s, "m1")).toMatchObject({ content: "agent", status: "saved", hasPending: false });
    expect(pendingChanges(s)).toHaveLength(0);
    expect(timeline(s)[0].id).toBe(revId);
    expect(memoryHistory(s, "m1").map((r) => r.id)[0]).toBe(revId);
    expect(latestSavedRevisionId(s, "m1")).toBe(revId);
  });

  it("approve of a new agent memory makes it visible", () => {
    const { ctx, state } = setup();
    const c = createMemory(state, ctx, { id: "n", title: "N", actor: AGENT });
    const rev = pendingChanges(c.state)[0].revisionId;
    const s = approveRevision(c.state, ctx, { revisionId: rev, actor: USER }).state;
    expect(listMemories(s).map((m) => m.id)).toEqual(["n"]);
    expect(getMemory(s, "n")?.status).toBe("saved");
  });

  it("agents cannot approve or reject (single and bulk)", () => {
    const { state, ctx, revId } = withProposal();
    expect(() => approveRevision(state, ctx, { revisionId: revId, actor: AGENT })).toThrow(/Only a user/);
    expect(() => rejectRevision(state, ctx, { revisionId: revId, actor: AGENT })).toThrow(/Only a user/);
    expect(() => approveAll(state, ctx, { actor: AGENT })).toThrow(/Only a user/);
    expect(() => rejectAll(state, ctx, { actor: AGENT })).toThrow(/Only a user/);
    // an actor that merely claims a user name but is an agent is still refused
    expect(() => approveRevision(state, ctx, { revisionId: revId, actor: { kind: "agent", name: USER.name } })).toThrow();
    expect(pendingChanges(state)).toHaveLength(1);
  });

  it("needs a pending revision", () => {
    const { state, ctx, revId } = withProposal();
    const saved = approveRevision(state, ctx, { revisionId: revId, actor: USER }).state;
    expect(() => approveRevision(saved, ctx, { revisionId: revId, actor: USER })).toThrow(/not waiting/);
    expect(() => rejectRevision(saved, ctx, { revisionId: revId, actor: USER })).toThrow(/not waiting/);
    expect(() => approveRevision(saved, ctx, { revisionId: "ghost", actor: USER })).toThrow(/not found/);
    expect(() => approveRevision(saved, ctx, { revisionId: "__proto__", actor: USER })).toThrow(/not found/);
    try {
      approveRevision(saved, ctx, { revisionId: revId, actor: USER });
    } catch (e) {
      expect((e as { code: string }).code).toBe("not_pending");
    }
  });

  it("refuses an outdated proposal (parent is no longer the current saved revision)", () => {
    const { state, ctx, revId } = withProposal();
    // simulate a hand-edited / imported state where the memory moved on under the proposal
    const moved = JSON.parse(JSON.stringify(state)) as typeof state;
    moved.revisions[revId].parentRevisionId = null;
    try {
      approveRevision(moved, ctx, { revisionId: revId, actor: USER });
      expect.unreachable();
    } catch (e) {
      expect((e as { code: string }).code).toBe("proposal_outdated");
    }
    expect(() => approveAll(moved, ctx, { actor: USER })).toThrow(/changed/);
    // rejecting an outdated proposal is always possible
    expect(pendingChanges(rejectRevision(moved, ctx, { revisionId: revId, actor: USER }).state)).toHaveLength(0);
  });

  it("reject keeps the revision (never deletes) and leaves saved content alone", () => {
    const { state, ctx, revId } = withProposal();
    const count = Object.keys(state.revisions).length;
    const { state: s, value } = rejectRevision(state, ctx, { revisionId: revId, actor: USER });
    expect(Object.keys(s.revisions)).toHaveLength(count);
    expect(value).toMatchObject({ status: "rejected", savedAt: null });
    expect(value.decidedAt).not.toBeNull();
    expect(getMemory(s, "m1")).toMatchObject({ content: "orig", hasPending: false, status: "saved" });
    expect(memoryHistory(s, "m1")).toHaveLength(1);
    expect(memoryHistory(s, "m1", { includeUnsaved: true })).toHaveLength(2);
    expect(timeline(s)).toHaveLength(1);
  });

  it("a rejected create stays hidden from listMemories", () => {
    const { ctx, state } = setup();
    const c = createMemory(state, ctx, { id: "n", title: "N", actor: AGENT });
    const s = rejectRevision(c.state, ctx, { revisionId: pendingChanges(c.state)[0].revisionId, actor: USER }).state;
    expect(listMemories(s)).toEqual([]);
    expect(listMemories(s, { includePending: true })).toEqual([]);
    expect(getMemory(s, "n")).toBeUndefined();
    expect(s.memories.n).toBeDefined(); // identity is kept
  });

  it("after reject the agent can propose again", () => {
    const { state, ctx, revId } = withProposal();
    const s = rejectRevision(state, ctx, { revisionId: revId, actor: USER }).state;
    const s2 = updateMemory(s, ctx, { id: "m1", patch: { content: "again" }, actor: AGENT }).state;
    expect(pendingChanges(s2)).toHaveLength(1);
    expect(s2.revisions[revId].status).toBe("rejected");
  });
});

describe("approveAll / rejectAll", () => {
  function many() {
    const a = seedSaved(setup().state, undefined, { id: "m1" });
    const b = seedSaved(a.state, a.ctx, { id: "m2" });
    let s = updateMemory(b.state, b.ctx, { id: "m1", patch: { title: "A1" }, actor: AGENT }).state;
    s = updateMemory(s, b.ctx, { id: "m2", patch: { title: "B1" }, actor: AGENT }).state;
    s = createMemory(s, b.ctx, { id: "m3", title: "C1", actor: AGENT }).state;
    return { s, ctx: b.ctx };
  }

  it("approves everything and returns the ids", () => {
    const { s, ctx } = many();
    const ids = pendingChanges(s).map((c) => c.revisionId);
    expect(ids).toHaveLength(3);
    const r = approveAll(s, ctx, { actor: USER });
    expect(r.value).toEqual(ids);
    expect(pendingChanges(r.state)).toHaveLength(0);
    expect(listMemories(r.state).map((m) => m.title).sort()).toEqual(["A1", "B1", "C1"]);
    expect(timeline(r.state, 3).map((x) => x.id).sort()).toEqual([...ids].sort());
  });

  it("is atomic: one outdated proposal means nothing is approved", () => {
    const { s, ctx } = many();
    const bad = JSON.parse(JSON.stringify(s)) as typeof s;
    const second = pendingChanges(bad)[1].revisionId;
    bad.revisions[second].parentRevisionId = null;
    const snapshot = JSON.stringify(bad);
    expect(() => approveAll(bad, ctx, { actor: USER })).toThrow();
    expect(JSON.stringify(bad)).toBe(snapshot);
    expect(pendingChanges(bad)).toHaveLength(3);
  });

  it("approveAll with nothing pending is a no-op; rejectAll rejects all", () => {
    const base = seedSaved(setup().state);
    const none = approveAll(base.state, base.ctx, { actor: USER });
    expect(none.value).toEqual([]);
    expect(none.state.revisions).toEqual(base.state.revisions);
    const { s, ctx } = many();
    const r = rejectAll(s, ctx, { actor: USER });
    expect(r.value).toHaveLength(3);
    expect(pendingChanges(r.state)).toHaveLength(0);
    expect(Object.values(r.state.revisions).filter((x) => x.status === "rejected")).toHaveLength(3);
    expect(listMemories(r.state).map((m) => m.title).sort()).toEqual(["Base", "Base"]);
  });
});

describe("queries", () => {
  it("listPending is the pending list; pendingRevisionMap is keyed by memory", () => {
    const { state, revId } = withProposal();
    expect(listPending(state)).toEqual(pendingChanges(state));
    expect(Object.keys(pendingRevisionMap(state))).toEqual(["m1"]);
    expect(latestRevisionId(state, "m1")).toBe(revId);
    expect(latestRevisionId(state, "nope")).toBeNull();
  });

  it("timeline lists saved revisions newest first and honours the limit", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1" });
    let s = updateMemory(base.state, base.ctx, { id: "m1", patch: { title: "v2" }, actor: USER }).state;
    s = createMemory(s, base.ctx, { id: "m2", title: "Two", actor: USER }).state;
    s = updateMemory(s, base.ctx, { id: "m1", patch: { title: "v3" }, actor: AGENT }).state; // pending: not on the timeline
    const t = timeline(s);
    expect(t.map((r) => r.snapshot.title)).toEqual(["Two", "v2", "Base"]);
    expect(timeline(s, 2)).toHaveLength(2);
    expect(timeline(s, 0)).toEqual([]);
  });

  it("listMemories shows saved content with a pending flag; archived status when archived", () => {
    const { state } = withProposal();
    const [m] = listMemories(state);
    expect(m).toMatchObject({ content: "orig", status: "pending", hasPending: true });
    const base = seedSaved(setup().state, undefined, { id: "a" });
    const arch = archiveMemory(base.state, base.ctx, { id: "a", actor: USER }).state;
    expect(listMemories(arch)[0].status).toBe("archived");
  });

  it("diffPending shows what approving would change", () => {
    const { state, revId, ctx } = withProposal();
    const d = diffPending(state, revId);
    expect(d).toMatchObject({ memoryId: "m1", kind: "modified" });
    expect(d.fields.map((f) => f.field)).toEqual(["content"]);
    const created = createMemory(state, ctx, { id: "n", title: "N", actor: AGENT }).state;
    const nid = pendingChanges(created).find((c) => c.memoryId === "n")!.revisionId;
    expect(diffPending(created, nid).kind).toBe("added");
    expect(() => diffPending(approveRevision(state, ctx, { revisionId: revId, actor: USER }).state, revId)).toThrow(/pending/);
  });

  it("rollback by an agent is proposed", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1", content: "orig" });
    const s = updateMemory(base.state, base.ctx, { id: "m1", patch: { content: "new" }, actor: USER }).state;
    const rb = rollbackMemory(s, base.ctx, { memoryId: "m1", toRevisionId: base.memory.revisionId, actor: AGENT });
    expect(rb.value.content).toBe("new");
    expect(rb.value.status).toBe("pending");
  });
});
