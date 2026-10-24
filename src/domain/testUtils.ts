import { createSequentialContext } from "./context.js";
import { createMemory } from "./memoryOps.js";
import { createEmptyWorkspace } from "./state.js";
import type { Actor, Memory, WorkspaceState } from "./types.js";

export const A = "tester";
export const USER: Actor = { kind: "user", name: A };
export const AGENT: Actor = { kind: "agent", name: "bot" };

export function setup() {
  return { ctx: createSequentialContext(), state: createEmptyWorkspace() };
}

/** Creates a memory as the user: it is saved immediately (long term). */
export function seedSaved(
  state: WorkspaceState,
  ctx = createSequentialContext(),
  input: { id?: string; title?: string; content?: string } = {},
): { state: WorkspaceState; memory: Memory; ctx: ReturnType<typeof createSequentialContext> } {
  const created = createMemory(state, ctx, {
    title: input.title ?? "Base",
    content: input.content ?? "line1\nline2\nline3",
    id: input.id,
    actor: USER,
  });
  return { state: created.state, memory: created.value, ctx };
}
