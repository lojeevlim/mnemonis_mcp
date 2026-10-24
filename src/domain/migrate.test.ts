/* eslint-disable @typescript-eslint/no-explicit-any -- v1 payloads are untrusted-shaped data */
import { describe, expect, it } from "vitest";
import v1Seed from "./__fixtures__/v1-seed.json";
import v1Drafts from "./__fixtures__/v1-drafts.json";
import v1Merge from "./__fixtures__/v1-merge.json";
import { migrateWorkspaceState } from "./migrate.js";
import { validateWorkspaceState } from "./state.js";
import { getMemory, listMemories, memoryHistory, pendingChanges, timeline } from "./queries.js";
import type { Revision, WorkspaceState } from "./types.js";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function migrate(raw: unknown): WorkspaceState {
  const r = migrateWorkspaceState(raw);
  if (!r.ok) throw new Error(`migration failed: ${r.reason}`);
  return r.state;
}

/** Everything v1 held must still be there. */
function expectPreserved(raw: any, s: WorkspaceState) {
  expect(s.schemaVersion).toBe(2);
  expect(s.memories).toEqual(raw.memories);
  // every v1 relation becomes a saved v2 relation (nothing else changes)
  expect(s.relations).toEqual(
    Object.fromEntries(
      Object.entries<any>(raw.relations).map(([k, r]) => [k, { ...r, status: "saved", decidedAt: r.createdAt }]),
    ),
  );
  expect(s.collections).toEqual(raw.collections);
  expect(Object.keys(s.revisions).sort()).toEqual(Object.keys(raw.revisions).sort());
  for (const [id, r] of Object.entries<any>(raw.revisions)) {
    expect(s.revisions[id].snapshot).toEqual(r.snapshot);
    expect(s.revisions[id].memoryId).toBe(r.memoryId);
    expect(s.revisions[id].createdAt).toBe(r.createdAt);
    expect(s.revisions[id].author).toBe(r.author);
  }
  for (const gone of ["currentBranchId", "commits", "branches", "pendingMerge"]) expect(gone in s).toBe(false);
  for (const r of Object.values(s.revisions)) {
    expect("branchId" in r || "commitId" in r).toBe(false);
  }
  expect(validateWorkspaceState(s).ok).toBe(true);
  const pendingPerMemory = new Map<string, number>();
  for (const r of Object.values(s.revisions)) {
    if (r.status === "pending") pendingPerMemory.set(r.memoryId, (pendingPerMemory.get(r.memoryId) ?? 0) + 1);
  }
  for (const n of pendingPerMemory.values()) expect(n).toBe(1);
}

describe("migrateWorkspaceState: version handling", () => {
  it("returns a valid v2 state untouched", () => {
    const v2 = migrate(v1Seed);
    const again = migrateWorkspaceState(clone(v2));
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.state).toEqual(v2);
  });

  it("reports unknown versions and junk without throwing", () => {
    expect(migrateWorkspaceState({ schemaVersion: 99 })).toEqual({ ok: false, reason: "version-mismatch" });
    expect(migrateWorkspaceState({ schemaVersion: 0 })).toEqual({ ok: false, reason: "version-mismatch" });
    expect(migrateWorkspaceState({ schemaVersion: "1" })).toEqual({ ok: false, reason: "corrupt" });
    expect(migrateWorkspaceState({})).toEqual({ ok: false, reason: "corrupt" });
    for (const junk of [null, undefined, 5, "x", [], [1]]) {
      expect(migrateWorkspaceState(junk)).toEqual({ ok: false, reason: "corrupt" });
    }
  });

  it("validates v2 strictly (bad v2 is corrupt)", () => {
    const v2: any = clone(migrate(v1Seed));
    v2.revisions[Object.keys(v2.revisions)[0]].status = "bogus";
    expect(migrateWorkspaceState(v2)).toEqual({ ok: false, reason: "corrupt" });
  });
});

describe("migrating the old demo seed", () => {
  const raw = v1Seed as any;
  const s = migrate(raw);

  it("keeps every memory, relation, collection and revision", () => {
    expectPreserved(raw, s);
    expect(Object.keys(s.memories)).toHaveLength(19);
    expect(Object.keys(s.collections)).toHaveLength(3);
    expect(Object.keys(s.relations)).toHaveLength(16);
  });

  it("main timeline revisions become saved with the commit message as note", () => {
    const commits = Object.values<any>(raw.commits);
    const messages = new Set(commits.map((c) => c.message));
    const saved = Object.values(s.revisions).filter((r) => r.status === "saved");
    expect(saved.length).toBeGreaterThanOrEqual(19);
    for (const r of saved) {
      expect(messages.has(r.note)).toBe(true);
      expect(r.origin).toBe("user");
      expect(r.savedAt).toBe(r.decidedAt);
    }
    const first = saved.find((r) => r.memoryId === "mem_profile") as Revision;
    expect(first.note).toBe("Add profile, project and core decisions");
    expect(listMemories(s)).toHaveLength(18); // the experiment's new memory is not saved
    expect(getMemory(s, "mem_proj_mnemonis")?.content).toContain("backend and MCP server are next");
    expect(memoryHistory(s, "mem_proj_mnemonis").map((r) => r.note)).toEqual([
      "Update project status and seed task",
      "Add profile, project and core decisions",
    ]);
    expect(timeline(s)[0].note).toBe("Update project status and seed task");
  });

  it("the experiment line becomes exactly two pending import proposals", () => {
    const pending = pendingChanges(s);
    expect(pending.map((p) => p.memoryId).sort()).toEqual(["mem_dec_custom_graph", "mem_research_ranking"]);
    for (const p of pending) {
      expect(p).toMatchObject({ origin: "import", note: "Carried over from memory line experiment/ranking" });
    }
    const update = pending.find((p) => p.memoryId === "mem_dec_custom_graph")!;
    expect(update.kind).toBe("update");
    const saved = memoryHistory(s, "mem_dec_custom_graph")[0];
    expect(s.revisions[update.revisionId].parentRevisionId).toBe(saved.id);
    expect(getMemory(s, "mem_dec_custom_graph")).toMatchObject({ hasPending: true, status: "pending" });
    const created = pending.find((p) => p.memoryId === "mem_research_ranking")!;
    expect(created.kind).toBe("create");
    expect(s.revisions[created.revisionId].parentRevisionId).toBeNull();
    expect(listMemories(s, { includePending: true })).toHaveLength(19);
  });

  it("is JSON-safe and deterministic", () => {
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(migrate(clone(raw))).toEqual(s);
  });
});

describe("migrating drafts, branches and merges", () => {
  const raw = v1Drafts as any;
  const s = migrate(raw);

  it("preserves everything and keeps merged branch history (second parents) as saved", () => {
    expectPreserved(raw, s);
    expect(s.revisions.rev_13).toMatchObject({ status: "saved", note: "other work" }); // via merge second parent
    expect(s.revisions.rev_16).toMatchObject({ status: "saved", note: "Integrate other into main" });
    expect(s.revisions.rev_11).toMatchObject({ status: "saved", note: "main edit" });
    expect(s.revisions.rev_6.status).not.toBe("saved"); // feature was never merged
    expect(getMemory(s, "m3")?.content).toBe("three other");
    expect(memoryHistory(s, "m3").map((r) => r.id)).toEqual(["rev_16", "rev_13", "rev_3"]);
  });

  it("main drafts become pending (import), earlier/no-op drafts superseded", () => {
    expect(s.revisions.rev_18).toMatchObject({ status: "pending", origin: "import", note: "Unsaved draft carried over", parentRevisionId: "rev_2", savedAt: null });
    expect(s.revisions.rev_17.status).toBe("superseded");
    expect(s.revisions.rev_19).toMatchObject({ status: "pending", note: "Unsaved draft carried over" }); // pending archive
    expect(pendingChanges(s).find((p) => p.memoryId === "m3")?.kind).toBe("archive");
    // draft equal to the saved snapshot: nothing to review
    expect(s.revisions.rev_20.status).toBe("superseded");
    expect(s.revisions.rev_21.status).toBe("superseded");
    expect(getMemory(s, "m1")?.content).toBe("a\nB-main\nc");
  });

  it("other memory lines contribute at most one proposal per memory (latest wins)", () => {
    // m2: feature edit (older) vs main draft (newer) -> main draft
    expect(s.revisions.rev_7.status).toBe("superseded");
    // m1: only the feature line differs from main
    expect(s.revisions.rev_6).toMatchObject({ status: "pending", note: "Carried over from memory line feature/x", parentRevisionId: "rev_11" });
    // m4 exists only on the feature line: latest tip is its draft
    expect(s.revisions.rev_10).toMatchObject({ status: "pending", parentRevisionId: null });
    expect(s.revisions.rev_8.status).toBe("superseded");
    expect(pendingChanges(s).map((p) => p.memoryId).sort()).toEqual(["m1", "m2", "m3", "m4"]);
    expect(listMemories(s).map((m) => m.id).sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("drops an in-progress merge (pendingMerge with conflicts) but keeps all data", () => {
    const m = v1Merge as any;
    expect(m.pendingMerge?.conflicts.length).toBeGreaterThan(0);
    const out = migrate(m);
    expectPreserved(m, out);
    expect("pendingMerge" in out).toBe(false);
  });
});

describe("migrating untrusted / hostile v1 payloads", () => {
  const fresh = () => clone(v1Drafts) as any;

  it("a dangling or cross-memory parentRevisionId becomes null", () => {
    const raw = fresh();
    raw.revisions.rev_6.parentRevisionId = "ghost";
    raw.revisions.rev_2.parentRevisionId = "rev_1"; // belongs to another memory
    const s = migrate(raw);
    expect(s.revisions.rev_6.parentRevisionId).toBe("rev_11"); // re-parented proposal
    expect(s.revisions.rev_2.parentRevisionId).toBeNull();
    const raw2 = fresh();
    raw2.revisions.rev_11.parentRevisionId = "ghost";
    // saved revisions are re-chained per memory, so the dangling parent is replaced by the previous saved revision
    const s2 = migrate(raw2);
    expect(s2.revisions.rev_11.parentRevisionId).not.toBe("ghost");
    expect(validateWorkspaceState(s2).ok).toBe(true);
  });

  it("a cyclic commit chain and unknown commit refs do not hang or throw", () => {
    const raw = fresh();
    raw.commits.commit_4.parentIds = ["commit_15", "ghost", "__proto__"];
    raw.commits.commit_12.parentIds = ["commit_12", "commit_4"];
    const r = migrateWorkspaceState(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expectPreserved(raw, r.state);
  });

  it("a cyclic revision parent chain is corrupt, not a hang", () => {
    const raw = fresh();
    raw.revisions.rev_17.parentRevisionId = "rev_18";
    expect(migrateWorkspaceState(raw)).toEqual({ ok: false, reason: "corrupt" });
  });

  it("reserved keys anywhere in the maps are corrupt (never become own keys or pollute)", () => {
    for (const map of ["memories", "revisions", "commits", "branches", "relations", "collections"]) {
      const raw = fresh();
      const entry = clone(Object.values(raw[map])[0] ?? { id: "__proto__" }) as any;
      for (const key of ["__proto__", "constructor", "prototype"]) {
        const evil = JSON.parse(`{${JSON.stringify(key)}:${JSON.stringify({ ...entry, id: key })}}`);
        for (const k of Object.keys(raw[map])) evil[k] = raw[map][k];
        raw[map] = evil;
        expect(migrateWorkspaceState(raw)).toEqual({ ok: false, reason: "corrupt" });
      }
    }
    expect(({} as Record<string, unknown>).id).toBeUndefined();
  });

  it("hostile ids as references (head, commitId, parent) are ignored safely", () => {
    const raw = fresh();
    raw.branches.main.headCommitId = "constructor";
    const r = migrateWorkspaceState(raw);
    // nothing is reachable from the head: everything is unsaved, but nothing is lost or thrown
    expect(r.ok).toBe(true);
    if (r.ok) expectPreserved(raw, r.state);
    const raw2 = fresh();
    raw2.revisions.rev_6.commitId = "__proto__";
    expect(migrateWorkspaceState(raw2).ok).toBe(true);
  });

  it("falls back to another branch / currentBranchId when there is no main", () => {
    const raw = fresh();
    raw.branches = { other: raw.branches.other, feat: raw.branches.feat };
    raw.currentBranchId = "other";
    for (const c of Object.values<any>(raw.commits)) if (c.branchId === "main") c.branchId = "other";
    for (const r of Object.values<any>(raw.revisions)) if (r.branchId === "main") r.branchId = "other";
    const r = migrateWorkspaceState(raw);
    expect(r.ok).toBe(true);
    const empty = fresh();
    empty.branches = {};
    expect(migrateWorkspaceState(empty).ok).toBe(true); // nothing saved: everything proposed, nothing lost
  });

  it.each([
    ["memories not a map", (r: any) => (r.memories = [])],
    ["memories missing", (r: any) => delete r.memories],
    ["revisions null", (r: any) => (r.revisions = null)],
    ["commits missing", (r: any) => delete r.commits],
    ["branches a string", (r: any) => (r.branches = "x")],
    ["revision key != id", (r: any) => (r.revisions.rev_1.id = "other")],
    ["revision not an object", (r: any) => (r.revisions.rev_1 = 5)],
    ["snapshot malformed", (r: any) => (r.revisions.rev_1.snapshot = { title: 1 })],
    ["commit message missing on a used commit", (r: any) => delete r.commits.commit_4.message],
    ["commit timestamp not a string", (r: any) => (r.commits.commit_4.timestamp = 5)],
    ["relation dangling", (r: any) => (r.relations[Object.keys(r.relations)[0]].toId = "ghost")],
    ["revision memory unknown", (r: any) => (r.revisions.rev_1.memoryId = "ghost")],
    ["memory shape", (r: any) => (r.memories.m1.provenance = 3)],
  ])("malformed v1 is corrupt, never a throw: %s", (_n, fn) => {
    const raw = fresh();
    fn(raw);
    expect(() => migrateWorkspaceState(raw)).not.toThrow();
    expect(migrateWorkspaceState(raw)).toEqual({ ok: false, reason: "corrupt" });
  });

  it("does not mutate its input", () => {
    const raw = fresh();
    const before = JSON.stringify(raw);
    migrate(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });
});
