/* eslint-disable @typescript-eslint/no-explicit-any -- tests feed deliberately malformed input */
import { describe, expect, it } from "vitest";
import { DomainError } from "./context.js";
import { LIMITS, assertActor } from "./limits.js";
import { archiveMemory, appendRevision, createMemory, restoreMemory, rollbackMemory, updateMemory } from "./memoryOps.js";
import { getMemory } from "./queries.js";
import { addRelation, approveRelation, rejectRelation } from "./relations.js";
import { createEmptyWorkspace, savedAgentOriginCount, validateWorkspaceState } from "./state.js";
import { AGENT, seedSaved, setup, USER } from "./testUtils.js";
import { approveAll, approveRevision, rejectAll, rejectRevision } from "./versioning.js";
import v1Seed from "./__fixtures__/v1-seed.json";
import { migrateWorkspaceState } from "./migrate.js";

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof DomainError)) throw e; // a TypeError etc. fails the test
    return e.code;
  }
  return undefined;
};

const BAD_ACTORS: [string, unknown][] = [
  ["undefined", undefined],
  ["null", null],
  ["string", "user"],
  ["array", []],
  ["no name", { kind: "user" }],
  ["blank name", { kind: "agent", name: "   " }],
  ["non-string name", { kind: "agent", name: 5 }],
  ["upper-case kind", { kind: "USER", name: "x" }],
  ["system kind", { kind: "system", name: "x" }],
  ["no kind", { name: "x" }],
  ["long name", { kind: "agent", name: "n".repeat(101) }],
  ["control char", { kind: "agent", name: "a\nb" }],
  ["NUL", { kind: "user", name: "a\u0000" }],
];

describe("assertActor", () => {
  it("accepts valid actors (name up to 100 chars)", () => {
    expect(() => assertActor(USER)).not.toThrow();
    expect(() => assertActor({ kind: "agent", name: "n".repeat(100) })).not.toThrow();
  });
  it.each(BAD_ACTORS)("rejects %s with invalid_input", (_n, actor) => {
    expect(codeOf(() => assertActor(actor))).toBe("invalid_input");
  });
});

describe("malformed actor on every write path", () => {
  it.each(BAD_ACTORS)("%s", (_n, actor: any) => {
    const { state, ctx } = seedSaved(setup().state, undefined, { id: "m1" });
    const agent = updateMemory(state, ctx, { id: "m1", patch: { title: "P" }, actor: AGENT }).state;
    const pendingId = Object.values(agent.revisions).find((r) => r.status === "pending")!.id;
    const other = seedSaved(state, ctx, { id: "m2", title: "Two" }).state;
    const rel = addRelation(other, ctx, { fromId: "m1", toId: "m2", label: "l", provenance: { origin: "process", createdBy: "b" }, actor: AGENT });
    const relId = rel.value.id;
    const snap = getMemory(state, "m1")!;
    const calls = [
      () => createMemory(state, ctx, { title: "T", actor }),
      () => updateMemory(state, ctx, { id: "m1", patch: { title: "X" }, actor }),
      () => archiveMemory(state, ctx, { id: "m1", actor }),
      () => restoreMemory(state, ctx, { id: "m1", actor }),
      () => rollbackMemory(state, ctx, { memoryId: "m1", toRevisionId: snap.revisionId, actor }),
      () => appendRevision(state, ctx, { memoryId: "m1", snapshot: { title: "Z", content: "", type: "fact", tags: [], collectionId: null, archived: false, metadata: {} }, actor }),
      () => approveRevision(agent, ctx, { revisionId: pendingId, actor }),
      () => rejectRevision(agent, ctx, { revisionId: pendingId, actor }),
      () => approveAll(agent, ctx, { actor }),
      () => rejectAll(agent, ctx, { actor }),
      () => approveRelation(rel.state, ctx, { relationId: relId, actor }),
      () => rejectRelation(rel.state, ctx, { relationId: relId, actor }),
      () => addRelation(other, ctx, { fromId: "m1", toId: "m2", label: "z", provenance: { origin: "user", createdBy: "u" }, actor }),
    ];
    for (const call of calls) expect(codeOf(call)).toBe("invalid_input");
  });

  it("a valid non-user actor is still forbidden to approve/reject", () => {
    const { state, ctx } = seedSaved(setup().state, undefined, { id: "m1" });
    const s = updateMemory(state, ctx, { id: "m1", patch: { title: "P" }, actor: AGENT }).state;
    const id = Object.values(s.revisions).find((r) => r.status === "pending")!.id;
    expect(codeOf(() => approveRevision(s, ctx, { revisionId: id, actor: AGENT }))).toBe("forbidden");
    expect(codeOf(() => rejectAll(s, ctx, { actor: AGENT }))).toBe("forbidden");
  });
});

describe("agent-supplied string caps", () => {
  const prov = { origin: "process" as const, createdBy: "bot" };
  function two() {
    const a = seedSaved(setup().state, undefined, { id: "m1", title: "One" });
    const b = seedSaved(a.state, a.ctx, { id: "m2", title: "Two" });
    return b;
  }
  it("relation label", () => {
    const { state, ctx } = two();
    const add = (label: any, actor = AGENT) => () => addRelation(state, ctx, { fromId: "m1", toId: "m2", label, provenance: prov, actor });
    expect(codeOf(add("x".repeat(LIMITS.label)))).toBeUndefined();
    expect(codeOf(add("x".repeat(LIMITS.label + 1)))).toBe("too_large");
    expect(codeOf(add("x".repeat(LIMITS.label + 1), USER))).toBe("too_large");
    expect(codeOf(add("   "))).toBe("invalid_input");
    expect(codeOf(add(42))).toBe("invalid_input");
    expect(codeOf(add(undefined))).toBe("invalid_input");
  });
  it("relation provenance strings", () => {
    const { state, ctx } = two();
    const add = (provenance: any) => () => addRelation(state, ctx, { fromId: "m1", toId: "m2", label: "l", provenance, actor: AGENT });
    expect(codeOf(add({ origin: "process", createdBy: "x".repeat(201) }))).toBe("too_large");
    expect(codeOf(add({ origin: "process", createdBy: "b", process: "x".repeat(201) }))).toBe("too_large");
    expect(codeOf(add({ origin: "process", createdBy: 1 }))).toBe("invalid_input");
    expect(codeOf(add(undefined))).toBe("invalid_input");
    expect(codeOf(add({ origin: "process", createdBy: "x".repeat(200), process: "y".repeat(200) }))).toBeUndefined();
  });
  it("snapshot type is capped, but only when changed", () => {
    const { state, ctx } = setup();
    for (const actor of [USER, AGENT]) {
      expect(codeOf(() => createMemory(state, ctx, { title: "t", type: "x".repeat(101), actor }))).toBe("too_large");
    }
    const ok = createMemory(state, ctx, { id: "m", title: "t", type: "x".repeat(100), actor: USER });
    expect(codeOf(() => updateMemory(ok.state, ctx, { id: "m", patch: { type: "y".repeat(101) }, actor: AGENT }))).toBe("too_large");
    // oversized legacy type stays editable for unrelated fields
    const legacy = structuredClone(ok.state);
    for (const r of Object.values(legacy.revisions)) r.snapshot.type = "z".repeat(150);
    expect(codeOf(() => updateMemory(legacy, ctx, { id: "m", patch: { title: "new" }, actor: USER }))).toBeUndefined();
    expect(codeOf(() => updateMemory(legacy, ctx, { id: "m", patch: { title: "new" }, actor: AGENT }))).toBeUndefined();
  });
  it("source and memory provenance", () => {
    const { state, ctx } = setup();
    const mk = (extra: any, actor = AGENT) => () => createMemory(state, ctx, { title: "t", actor, ...extra });
    expect(codeOf(mk({ source: "s".repeat(500) }))).toBeUndefined();
    expect(codeOf(mk({ source: "s".repeat(501) }))).toBe("too_large");
    expect(codeOf(mk({ source: "s".repeat(501) }, USER))).toBe("too_large");
    expect(codeOf(mk({ source: 5 }))).toBe("invalid_input");
    expect(codeOf(mk({ provenance: { origin: "o".repeat(201), createdBy: "b" } }))).toBe("too_large");
    expect(codeOf(mk({ provenance: { origin: "agent", createdBy: "b".repeat(201) } }))).toBe("too_large");
    expect(codeOf(mk({ provenance: { origin: "agent", createdBy: 3 } }))).toBe("invalid_input");
    expect(codeOf(mk({ provenance: null }))).toBeUndefined(); // null falls back to the default (nullish)
  });
});

describe("validator vs write-time caps", () => {
  it("does not reject long stored strings, but rejects non-strings", () => {
    const { state, ctx } = seedSaved(setup().state, undefined, { id: "m1" });
    const two = seedSaved(state, ctx, { id: "m2" });
    const withRel = addRelation(two.state, ctx, { fromId: "m1", toId: "m2", label: "l", provenance: { origin: "user", createdBy: "u" }, actor: USER }).state;
    const long = structuredClone(withRel) as any;
    long.memories.m1.source = "s".repeat(5000);
    long.memories.m1.provenance.createdBy = "p".repeat(5000);
    for (const r of Object.values<any>(long.relations)) {
      r.label = "l".repeat(5000);
      r.provenance.createdBy = "c".repeat(5000);
    }
    for (const r of Object.values<any>(long.revisions)) {
      r.snapshot.type = "t".repeat(5000);
      r.author = "a".repeat(5000);
    }
    expect(validateWorkspaceState(long).ok).toBe(true);

    const mutations: ((s: any) => void)[] = [
      (s) => (s.memories.m1.source = 5),
      (s) => (s.memories.m1.provenance.origin = {}),
      (s) => (s.memories.m1.provenance.createdBy = null),
      (s) => (Object.values<any>(s.relations)[0].label = 5),
      (s) => (Object.values<any>(s.relations)[0].provenance.createdBy = 5),
      (s) => (Object.values<any>(s.relations)[0].provenance.process = 5),
      (s) => (Object.values<any>(s.revisions)[0].snapshot.type = 5),
      (s) => (Object.values<any>(s.revisions)[0].author = 5),
    ];
    for (const m of mutations) {
      const bad = structuredClone(withRel) as any;
      m(bad);
      expect(validateWorkspaceState(bad).ok).toBe(false);
    }
  });

  it("v1 fixtures and an empty workspace still validate", () => {
    expect(validateWorkspaceState(createEmptyWorkspace()).ok).toBe(true);
    expect(migrateWorkspaceState(structuredClone(v1Seed)).ok).toBe(true);
  });
});

describe("import may carry saved agent-origin revisions (intentional)", () => {
  it("validateWorkspaceState does not constrain saved revision origin; savedAgentOriginCount reports it", () => {
    const { state } = seedSaved(setup().state, undefined, { id: "m1" });
    expect(savedAgentOriginCount(state)).toBe(0);
    const imported = structuredClone(state) as any;
    for (const r of Object.values<any>(imported.revisions)) {
      r.origin = "agent";
      r.author = "some-agent";
    }
    const res = validateWorkspaceState(imported);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(savedAgentOriginCount(res.state)).toBe(1);
      expect(Object.values(res.state.revisions)[0].status).toBe("saved");
    }
  });
  it("does not count pending agent proposals", () => {
    const { state, ctx } = seedSaved(setup().state, undefined, { id: "m1" });
    const s = updateMemory(state, ctx, { id: "m1", patch: { title: "P" }, actor: AGENT }).state;
    expect(savedAgentOriginCount(s)).toBe(0);
  });
});
