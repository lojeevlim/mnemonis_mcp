import { describe, expect, it } from "vitest";
import { createMemory } from "./memoryOps.js";
import { createCollection } from "./relations.js";
import { searchWorkspace } from "./search.js";
import { archiveMemory, updateMemory } from "./memoryOps.js";
import { AGENT, USER, setup } from "./testUtils.js";

function build() {
  const { ctx, state } = setup();
  let s = createCollection(state, ctx, { name: "Work", id: "col_work" }).state;
  const add = (input: Parameters<typeof createMemory>[2]) => {
    s = createMemory(s, ctx, input).state;
  };
  add({ id: "alpha", title: "Alpha", content: "nothing here", type: "fact", actor: USER });
  add({ id: "m_pg", title: "Postgres", content: "database notes", type: "technical_decision", tags: ["db"], collectionId: "col_work", actor: USER });
  add({ id: "m_pg2", title: "Why Postgres over Mongo", content: "relational", type: "technical_decision", tags: ["db", "decision"], actor: USER });
  add({ id: "m_body", title: "Notes", content: "We chose alpha twice: alpha alpha", type: "meeting_note", actor: USER });
  add({ id: "m_meta", title: "Meta", content: "x", type: "reference", metadata: { owner: "zeta", nested: { k: "quasar" } }, actor: USER });
  add({ id: "m_tag", title: "Tagged", content: "x", tags: ["quasar"], actor: USER });
  return { s, ctx };
}

describe("search", () => {
  it("ranks exact id > exact title > prefix title > token matches", () => {
    const { s } = build();
    const byId = searchWorkspace(s, { query: "ALPHA" });
    expect(byId.items[0].memory.id).toBe("alpha"); // id (case-insensitive) and exact title
    expect(byId.items.map((i) => i.memory.id)).toContain("m_body");

    const r = searchWorkspace(s, { query: "postgres" });
    expect(r.items.map((i) => i.memory.id)).toEqual(["m_pg", "m_pg2"]); // exact title before token title match

    const prefix = searchWorkspace(s, { query: "Why Post" });
    expect(prefix.items[0].memory.id).toBe("m_pg2");

    const idExact = searchWorkspace(s, { query: "m_pg2" });
    expect(idExact.items[0].memory.id).toBe("m_pg2");
    expect(idExact.items[0].matchedOn).toContain("id");
  });

  it("scores title/tag/content/metadata tokens with AND semantics", () => {
    const { s } = build();
    expect(searchWorkspace(s, { query: "quasar" }).items.map((i) => i.memory.id).sort()).toEqual(["m_meta", "m_tag"]);
    expect(searchWorkspace(s, { query: "quasar" }).items[0].memory.id).toBe("m_tag"); // tag outweighs metadata
    expect(searchWorkspace(s, { query: "database relational" }).total).toBe(0);
    expect(searchWorkspace(s, { query: "zeta" }).items[0].matchedOn).toContain("metadata");
    expect(searchWorkspace(s, { query: "!!!" }).total).toBe(0);
  });

  it("filters by type, collection, tag and status", () => {
    const { s, ctx } = build();
    expect(searchWorkspace(s, { type: "technical_decision" }).total).toBe(2);
    expect(searchWorkspace(s, { collectionId: "col_work" }).total).toBe(1);
    expect(searchWorkspace(s, { collectionId: null }).total).toBe(5);
    expect(searchWorkspace(s, { tag: "DB" }).total).toBe(2);
    expect(searchWorkspace(s, { status: "pending" }).total).toBe(0);
    expect(searchWorkspace(s, { status: "saved" }).total).toBe(6);
    const arch = archiveMemory(s, ctx, { id: "alpha", actor: USER }).state;
    expect(searchWorkspace(arch, {}).total).toBe(5); // archived hidden by default
    expect(searchWorkspace(arch, { includeArchived: true }).total).toBe(6);
    expect(searchWorkspace(arch, { status: "archived" }).total).toBe(1);
    expect(searchWorkspace(s, { type: "fact" }).total).toBe(2);
  });

  it("flags memories with an open proposal as pending and searches saved content", () => {
    const { s, ctx } = build();
    const p = updateMemory(s, ctx, { id: "alpha", patch: { content: "zebra" }, actor: AGENT }).state;
    expect(searchWorkspace(p, { status: "pending" }).items.map((i) => i.memory.id)).toEqual(["alpha"]);
    expect(searchWorkspace(p, { query: "zebra" }).total).toBe(0); // proposals are not searchable until approved
  });

  it("hides never-saved proposals unless includePending is set", () => {
    const { s, ctx } = build();
    const p = createMemory(s, ctx, { id: "newone", title: "Brand new", actor: AGENT }).state;
    expect(searchWorkspace(p, { query: "brand" }).total).toBe(0);
    expect(searchWorkspace(p, { query: "brand", includePending: true }).items[0].memory.id).toBe("newone");
  });

  it("paginates and reports total", () => {
    const { s } = build();
    const p1 = searchWorkspace(s, { limit: 4, offset: 0 });
    const p2 = searchWorkspace(s, { limit: 4, offset: 4 });
    expect(p1.total).toBe(6);
    expect(p1.items).toHaveLength(4);
    expect(p2.items).toHaveLength(2);
    expect(new Set([...p1.items, ...p2.items].map((i) => i.memory.id)).size).toBe(6);
    expect(searchWorkspace(s, { limit: 4, offset: 99 }).items).toEqual([]);
  });
});
