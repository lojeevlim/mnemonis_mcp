/* eslint-disable @typescript-eslint/no-explicit-any -- tests mutate untrusted-shaped data */
import { describe, expect, it } from "vitest";
import { createMemory, updateMemory } from "./memoryOps.js";
import { addRelation, createCollection } from "./relations.js";
import { getMemory, listMemories, memoryHistory, pendingChanges } from "./queries.js";
import { searchWorkspace } from "./search.js";
import { MAX_IMPORT_BYTES, validateWorkspaceState } from "./state.js";
import { A, AGENT, seedSaved, setup, USER } from "./testUtils.js";
import { approveRevision } from "./versioning.js";
import type { WorkspaceState } from "./types.js";

describe("stale / no-op proposals", () => {
  it("an agent edit-and-back leaves no proposal and does not shadow saved content", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1", content: "a" });
    const { ctx } = base;
    let s = updateMemory(base.state, ctx, { id: "m1", patch: { content: "temporary" }, actor: AGENT }).state;
    s = updateMemory(s, ctx, { id: "m1", patch: { content: "a" }, actor: AGENT }).state;
    expect(pendingChanges(s)).toHaveLength(0);
    expect(getMemory(s, "m1")).toMatchObject({ content: "a", status: "saved" });
    expect(memoryHistory(s, "m1").every((r) => r.status === "saved")).toBe(true);
  });

  it("approving then editing builds on the approved revision", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1", content: "a" });
    const { ctx } = base;
    let s = updateMemory(base.state, ctx, { id: "m1", patch: { content: "agent" }, actor: AGENT }).state;
    s = approveRevision(s, ctx, { revisionId: pendingChanges(s)[0].revisionId, actor: USER }).state;
    s = updateMemory(s, ctx, { id: "m1", patch: { title: "T2" }, actor: USER }).state;
    expect(getMemory(s, "m1")).toMatchObject({ content: "agent", title: "T2" });
    expect(memoryHistory(s, "m1")).toHaveLength(3);
  });
});

function validState(): WorkspaceState {
  const base = seedSaved(setup().state, undefined, { id: "m1" });
  const { ctx } = base;
  let s = createMemory(base.state, ctx, { id: "m2", title: "Two", actor: USER }).state;
  s = updateMemory(s, ctx, { id: "m1", patch: { title: "prop" }, actor: AGENT }).state;
  s = addRelation(s, ctx, { fromId: "m1", toId: "m2", label: "rel", provenance: { origin: "user", createdBy: A }, actor: USER }).state;
  return JSON.parse(JSON.stringify(s));
}
const mutate = (fn: (s: any) => void) => {
  const s = validState();
  fn(s);
  return validateWorkspaceState(s);
};
const firstRev = (s: any) => s.revisions[Object.keys(s.revisions)[0]];

describe("deep validation", () => {
  it("accepts a valid state", () => {
    expect(validateWorkspaceState(validState()).ok).toBe(true);
  });

  it("reports a different schema version as version-mismatch", () => {
    const s = validState() as any;
    s.schemaVersion = 1;
    expect(validateWorkspaceState(s)).toEqual({ ok: false, reason: "version-mismatch" });
  });

  const cases: [string, (s: any) => void][] = [
    ["snapshot content not string", (s) => (firstRev(s).snapshot.content = 5)],
    ["snapshot type not string", (s) => (firstRev(s).snapshot.type = null)],
    ["tags with non-string", (s) => (firstRev(s).snapshot.tags = ["a", 1])],
    ["collectionId number", (s) => (firstRev(s).snapshot.collectionId = 3)],
    ["archived not boolean", (s) => (firstRev(s).snapshot.archived = "no")],
    ["metadata array", (s) => (firstRev(s).snapshot.metadata = [])],
    ["metadata nested non-json", (s) => (firstRev(s).snapshot.metadata = { a: Number.POSITIVE_INFINITY })],
    ["revision createdAt", (s) => (firstRev(s).createdAt = 1)],
    ["revision author", (s) => delete firstRev(s).author],
    ["revision note", (s) => delete firstRev(s).note],
    ["revision origin", (s) => (firstRev(s).origin = "alien")],
    ["revision status", (s) => (firstRev(s).status = "draft")],
    ["revision savedAt undefined", (s) => delete firstRev(s).savedAt],
    ["revision decidedAt number", (s) => (firstRev(s).decidedAt = 4)],
    ["saved revision without savedAt", (s) => (firstRev(s).savedAt = null)],
    ["revision parent dangling", (s) => (firstRev(s).parentRevisionId = "ghost")],
    ["revision parent undefined", (s) => delete firstRev(s).parentRevisionId],
    ["revision parent of another memory", (s) => {
      const revs = Object.values(s.revisions) as any[];
      revs.find((r) => r.memoryId === "m2").parentRevisionId = revs.find((r) => r.memoryId === "m1").id;
    }],
    ["revision memory dangling", (s) => (firstRev(s).memoryId = "ghost")],
    ["two pending revisions for one memory", (s) => {
      const pending = (Object.values(s.revisions) as any[]).find((r) => r.status === "pending");
      const id = "rev_dup";
      s.revisions[id] = { ...pending, id };
    }],
    ["legacy branch fields do not rescue a bad status", (s) => {
      firstRev(s).branchId = "main";
      firstRev(s).status = 1;
    }],
    ["map key != id", (s) => (s.memories.m1.id = "other")],
    ["memory provenance", (s) => (s.memories.m1.provenance = "x")],
    ["memory createdAt", (s) => (s.memories.m1.createdAt = null)],
    ["relation label", (s) => (s.relations[Object.keys(s.relations)[0]].label = 1)],
    ["relation provenance origin", (s) => (s.relations[Object.keys(s.relations)[0]].provenance.origin = "alien")],
    ["relation dangling", (s) => (s.relations[Object.keys(s.relations)[0]].toId = "ghost")],
    ["collection shape", (s) => (s.collections.c = { id: "c", name: 1 })],
    ["missing collections map", (s) => delete s.collections],
    ["revisions not a map", (s) => (s.revisions = [])],
  ];
  it.each(cases)("rejects: %s", (_n, fn) => {
    expect(mutate(fn)).toEqual({ ok: false, reason: "corrupt" });
  });

  it("rejects cycles in revision parents", () => {
    expect(mutate((s) => {
      const r = Object.values(s.revisions).filter((x: any) => x.memoryId === "m1") as any[];
      r[0].parentRevisionId = r[0].id;
    }).ok).toBe(false);
    expect(mutate((s) => {
      const r = Object.values(s.revisions).filter((x: any) => x.memoryId === "m1") as any[];
      r[0].parentRevisionId = r[1].id;
      r[1].parentRevisionId = r[0].id;
    }).ok).toBe(false);
  });

  it("exposes a size cap constant", () => {
    expect(MAX_IMPORT_BYTES).toBeGreaterThan(1024);
  });
});

describe("prototype-pollution hardening", () => {
  it("rejects __proto__ / constructor / prototype keys and ids from a malicious import, without crashing", () => {
    const base = JSON.stringify(validState());
    for (const key of ["__proto__", "constructor", "prototype"]) {
      for (const map of ["memories", "revisions", "relations", "collections"]) {
        const s = JSON.parse(base);
        const entry = (Object.values(s[map])[0] ?? {}) as Record<string, unknown>;
        const body = JSON.stringify(s[map]);
        const evil = `${JSON.stringify(key)}:${JSON.stringify({ ...entry, id: key })}`;
        const json = JSON.stringify(s).replace(`"${map}":${body}`, `"${map}":{${evil}${body === "{}" ? "" : ","}${body.slice(1)}`);
        expect(validateWorkspaceState(JSON.parse(json))).toEqual({ ok: false, reason: "corrupt" });
      }
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects a JSON.parse-created own __proto__ key and dangling refs", () => {
    const evil = JSON.parse(
      `{"schemaVersion":2,"memories":{"__proto__":{"id":"__proto__","createdAt":"t","source":"s","provenance":{"origin":"o","createdBy":"c"}}},"revisions":{},"relations":{},"collections":{}}`,
    );
    expect(validateWorkspaceState(evil).ok).toBe(false);
    const dangling = validState() as any;
    dangling.revisions[Object.keys(dangling.revisions)[0]].parentRevisionId = "constructor";
    expect(validateWorkspaceState(dangling).ok).toBe(false);
  });

  it("domain lookups never return Object.prototype members", () => {
    const base = seedSaved(setup().state, undefined, { id: "m1" });
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(getMemory(base.state, id)).toBeUndefined();
      expect(() => updateMemory(base.state, base.ctx, { id, patch: { title: "x" }, actor: USER })).toThrow(/not found/);
      expect(() => addRelation(base.state, base.ctx, { fromId: id, toId: "m1", label: "l", provenance: { origin: "user", createdBy: A }, actor: USER })).toThrow(/not found/);
    }
  });

  it("refuses to create entities with reserved ids", () => {
    const { state, ctx } = setup();
    for (const id of ["__proto__", "constructor", "prototype"]) {
      expect(() => createMemory(state, ctx, { id, title: "t", actor: USER })).toThrow(/reserved/);
      expect(() => createMemory(state, ctx, { id, title: "t", actor: AGENT })).toThrow(/reserved/);
      expect(() => createCollection(state, ctx, { name: "c", id })).toThrow(/reserved/);
    }
    const s = createMemory(createMemory(state, ctx, { title: "a", id: "a", actor: USER }).state, ctx, { title: "b", id: "b", actor: USER }).state;
    expect(() => addRelation(s, ctx, { id: "__proto__", fromId: "a", toId: "b", label: "l", provenance: { origin: "user", createdBy: A }, actor: USER })).toThrow(/reserved/);
    expect(listMemories(s)).toHaveLength(2);
  });
});

describe("search punctuation fallback", () => {
  it("falls back to substring match for punctuation-only and symbol queries", () => {
    const { state, ctx } = setup();
    let s = createMemory(state, ctx, { id: "a", title: "Use # for headings", content: "markdown", actor: USER }).state;
    s = createMemory(s, ctx, { id: "b", title: "Languages", content: "I like c++ and rust", actor: USER }).state;
    s = createMemory(s, ctx, { id: "c", title: "Unrelated", content: "nothing", actor: USER }).state;
    expect(searchWorkspace(s, { query: "#" }).items.map((i) => i.memory.id)).toEqual(["a"]);
    expect(searchWorkspace(s, { query: "++" }).items.map((i) => i.memory.id)).toEqual(["b"]);
    expect(searchWorkspace(s, { query: "c++" }).items.map((i) => i.memory.id)).toContain("b");
    expect(searchWorkspace(s, { query: "!!!" }).total).toBe(0);
  });
});
