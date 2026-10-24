import { describe, expect, it } from "vitest";
import { diffLines, diffRevisions, diffSnapshots } from "./diff.js";
import { updateMemory } from "./memoryOps.js";
import { memoryHistory } from "./queries.js";
import { seedSaved, setup, USER } from "./testUtils.js";

describe("diffLines", () => {
  it("handles equal, add, remove, replace", () => {
    expect(diffLines("a\nb", "a\nb").every((l) => l.type === "equal")).toBe(true);
    expect(diffLines("", "x\ny").map((l) => l.type)).toEqual(["add", "add"]);
    expect(diffLines("x\ny", "").map((l) => l.type)).toEqual(["remove", "remove"]);
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { type: "equal", text: "a" },
      { type: "remove", text: "b" },
      { type: "add", text: "B" },
      { type: "equal", text: "c" },
    ]);
  });
  it("finds an LCS in the middle", () => {
    const d = diffLines("1\n2\n3\n4\n5", "1\n3\n4\nX\n5");
    expect(d.filter((l) => l.type === "remove").map((l) => l.text)).toEqual(["2"]);
    expect(d.filter((l) => l.type === "add").map((l) => l.text)).toEqual(["X"]);
  });
});

describe("domain diffs", () => {
  it("diffs revisions field-by-field with line diff for content", () => {
    const base = seedSaved(setup().state);
    const s = updateMemory(base.state, base.ctx, {
      id: base.memory.id,
      patch: { title: "T2", content: "line1\nlineX\nline3", tags: ["z"] },
      actor: USER,
    }).state;
    const newRev = memoryHistory(s, base.memory.id)[0].id;
    const d = diffRevisions(s, base.memory.revisionId, newRev);
    expect(d.map((f) => f.field).sort()).toEqual(["content", "tags", "title"]);
    const content = d.find((f) => f.field === "content");
    expect(content?.lines?.filter((l) => l.type !== "equal")).toHaveLength(2);
  });

  it("diffSnapshots against nothing lists every non-empty field", () => {
    const base = seedSaved(setup().state);
    const snapshot = Object.values(base.state.revisions)[0].snapshot;
    expect(diffSnapshots(undefined, snapshot).map((f) => f.field)).toContain("title");
    expect(diffSnapshots(snapshot, snapshot)).toEqual([]);
  });
});
