import { DomainError, type DomainContext } from "./context.js";
import type { Actor, Collection, Mutation, Relation, RelationProvenance, WorkspaceState } from "./types.js";
import { assertActor, assertRelationLimits } from "./limits.js";
import { assertSafeId, freshId, requireText, safeGet } from "./util.js";
import { currentSavedRevision, getMemory, listMemories, memoryIdsWithSaved, pendingRevisionFor } from "./queries.js";

const hasSaved = (state: WorkspaceState, memoryId: string): boolean => !!currentSavedRevision(state, memoryId);

/**
 * Adds a relation.
 *  - user actor: saved at once; both endpoints must have a saved revision.
 *  - agent actor: PENDING until a user approves it; an endpoint may itself be a pending (never yet saved) memory.
 * Rejected relations do not block proposing the same link again.
 */
export function addRelation(
  state: WorkspaceState,
  ctx: DomainContext,
  args: {
    fromId: string;
    toId: string;
    label: string;
    provenance: RelationProvenance;
    id?: string;
    actor: Actor;
  },
): Mutation<Relation> {
  assertActor(args.actor);
  if (typeof args.label !== "string") throw new DomainError("invalid_input", "label must be a string");
  const label = requireText(args.label, "label");
  assertRelationLimits(label, args.provenance);
  if (args.fromId === args.toId) throw new DomainError("invalid_input", "A memory cannot relate to itself");
  for (const id of [args.fromId, args.toId]) {
    if (!safeGet(state.memories, id)) throw new DomainError("memory_not_found", `Memory not found: ${id}`);
  }
  const isUser = args.actor.kind === "user";
  for (const id of [args.fromId, args.toId]) {
    const ok = isUser ? hasSaved(state, id) : !!getMemory(state, id);
    if (!ok) {
      throw new DomainError(
        "endpoint_not_saved",
        isUser ? `Memory has not been saved yet: ${id}` : `Memory has no saved or pending version: ${id}`,
      );
    }
  }
  const dup = Object.values(state.relations).some(
    (r) => r.status !== "rejected" && r.fromId === args.fromId && r.toId === args.toId && r.label === label,
  );
  if (dup) throw new DomainError("duplicate_relation", "Relation already exists");
  if (args.id !== undefined) assertSafeId(args.id, "relation");
  const id = args.id ?? freshId(ctx, "rel", (x) => Object.hasOwn(state.relations, x));
  if (safeGet(state.relations, id)) throw new DomainError("duplicate_id", `Relation id already exists: ${id}`);
  const now = ctx.now();
  const rel: Relation = {
    id,
    fromId: args.fromId,
    toId: args.toId,
    label,
    provenance: args.provenance,
    createdAt: now,
    status: isUser ? "saved" : "pending",
    decidedAt: isUser ? now : null,
  };
  return { state: { ...state, relations: { ...state.relations, [rel.id]: rel } }, value: rel };
}

/**
 * User removes a link (agents get "forbidden"). A SAVED link is hard-deleted; a pending or rejected link
 * is never deleted: it is marked rejected so the record stays. `ctx` stamps decidedAt (falls back to the
 * wall clock when omitted).
 */
export function removeRelation(
  state: WorkspaceState,
  args: { id: string; actor: Actor },
  ctx?: DomainContext,
): Mutation {
  if (!args.actor || args.actor.kind !== "user") throw new DomainError("forbidden", "Only a user can remove links");
  const rel = safeGet(state.relations, args.id);
  if (!rel) throw new DomainError("relation_not_found", `Relation not found: ${args.id}`);
  if (rel.status === "rejected") return { state, value: undefined };
  if (rel.status === "pending") {
    const next = rejectRelationsIn(state, [rel.id], () => (ctx ? ctx.now() : new Date().toISOString()));
    return { state: next, value: undefined };
  }
  const relations = { ...state.relations };
  delete relations[args.id];
  return { state: { ...state, relations }, value: undefined };
}

/**
 * Relations (optionally touching one memory). By default only SAVED relations whose BOTH endpoints
 * currently have a saved revision (a link to a memory that is pending-only or was rejected never shows).
 * `includePending` additionally lists pending (proposed) relations, whatever their endpoints.
 */
export function listRelations(
  state: WorkspaceState,
  memoryId?: string,
  opts: { includePending?: boolean } = {},
): Relation[] {
  const saved = memoryIdsWithSaved(state);
  return Object.values(state.relations).filter(
    (r) =>
      (!memoryId || r.fromId === memoryId || r.toId === memoryId) &&
      ((r.status === "saved" && saved.has(r.fromId) && saved.has(r.toId)) ||
        (opts.includePending === true && r.status === "pending")),
  );
}

export interface PendingRelation {
  relationId: string;
  fromId: string;
  toId: string;
  label: string;
  /** Who proposed it (provenance.createdBy). */
  author: string;
  provenance: RelationProvenance;
  createdAt: string;
  fromTitle: string;
  toTitle: string;
  /** True when both endpoints already have a saved revision (so it can be approved now). */
  ready: boolean;
}

/** Relations proposed by agents and waiting for review, oldest first. */
export function listPendingRelations(state: WorkspaceState): PendingRelation[] {
  return Object.values(state.relations)
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.status === "pending")
    .sort((a, b) => (a.r.createdAt === b.r.createdAt ? a.i - b.i : a.r.createdAt < b.r.createdAt ? -1 : 1))
    .map(({ r }) => ({
      relationId: r.id,
      fromId: r.fromId,
      toId: r.toId,
      label: r.label,
      author: r.provenance.createdBy,
      provenance: r.provenance,
      createdAt: r.createdAt,
      fromTitle: getMemory(state, r.fromId)?.title ?? r.fromId,
      toTitle: getMemory(state, r.toId)?.title ?? r.toId,
      ready: hasSaved(state, r.fromId) && hasSaved(state, r.toId),
    }));
}

/** Everything waiting for review: memory proposals plus pending relations (the Inbox badge). */
export function pendingCount(state: WorkspaceState): number {
  let n = 0;
  for (const r of Object.values(state.revisions)) if (r.status === "pending") n++;
  for (const r of Object.values(state.relations)) if (r.status === "pending") n++;
  return n;
}

function requireUser(actor: Actor): void {
  assertActor(actor);
  if (actor.kind !== "user") throw new DomainError("forbidden", "Only a user can approve or reject changes");
}

function requirePendingRelation(state: WorkspaceState, relationId: string): Relation {
  const rel = safeGet(state.relations, relationId);
  if (!rel) throw new DomainError("relation_not_found", `Relation not found: ${relationId}`);
  if (rel.status !== "pending") throw new DomainError("not_pending", "This link is not waiting for review");
  return rel;
}

/** Throws unless both endpoints of `rel` have a saved revision in `state`. */
export function requireEndpointsSaved(state: WorkspaceState, rel: Relation): void {
  if (!hasSaved(state, rel.fromId) || !hasSaved(state, rel.toId)) {
    throw new DomainError("endpoint_not_saved", "Approve the linked memories first");
  }
}

/** Marks pending relations saved (callers have already checked them). */
export function approveRelationsIn(state: WorkspaceState, ids: string[], now: () => string): WorkspaceState {
  const relations = { ...state.relations };
  for (const id of ids) {
    const stamp = now();
    relations[id] = { ...relations[id], status: "saved", decidedAt: stamp };
  }
  return { ...state, relations };
}

export function rejectRelationsIn(state: WorkspaceState, ids: string[], now: () => string): WorkspaceState {
  const relations = { ...state.relations };
  for (const id of ids) {
    const stamp = now();
    relations[id] = { ...relations[id], status: "rejected", decidedAt: stamp };
  }
  return { ...state, relations };
}

/** User approves a proposed link. Both linked memories must already be saved. */
export function approveRelation(
  state: WorkspaceState,
  ctx: DomainContext,
  args: { relationId: string; actor: Actor },
): Mutation<Relation> {
  requireUser(args.actor);
  const rel = requirePendingRelation(state, args.relationId);
  requireEndpointsSaved(state, rel);
  const next = approveRelationsIn(state, [rel.id], () => ctx.now());
  return { state: next, value: next.relations[rel.id] };
}

export function rejectRelation(
  state: WorkspaceState,
  ctx: DomainContext,
  args: { relationId: string; actor: Actor },
): Mutation<Relation> {
  requireUser(args.actor);
  const rel = requirePendingRelation(state, args.relationId);
  const next = rejectRelationsIn(state, [rel.id], () => ctx.now());
  return { state: next, value: next.relations[rel.id] };
}

/**
 * Auto-rejects the relations (pending AND saved ones) touching a memory that can never be saved: it has
 * no saved revision and no open proposal (e.g. its create was rejected). Such links are invisible anyway;
 * the records are kept as rejected.
 */
export function rejectOrphanedRelations(state: WorkspaceState, ctx: DomainContext, memoryId: string): WorkspaceState {
  if (hasSaved(state, memoryId) || pendingRevisionFor(state, memoryId)) return state;
  const ids = Object.values(state.relations)
    .filter((r) => (r.status === "pending" || r.status === "saved") && (r.fromId === memoryId || r.toId === memoryId))
    .map((r) => r.id);
  return ids.length ? rejectRelationsIn(state, ids, () => ctx.now()) : state;
}

export function createCollection(
  state: WorkspaceState,
  ctx: DomainContext,
  args: { name: string; description?: string; id?: string },
): Mutation<Collection> {
  const name = requireText(args.name, "name");
  const col: Collection = {
    id: args.id ?? freshId(ctx, "col", (x) => Object.hasOwn(state.collections, x)),
    name,
    description: args.description ?? "",
    createdAt: ctx.now(),
  };
  assertSafeId(col.id, "collection");
  if (safeGet(state.collections, col.id)) throw new DomainError("duplicate_id", `Collection exists: ${col.id}`);
  return { state: { ...state, collections: { ...state.collections, [col.id]: col } }, value: col };
}

export function updateCollection(
  state: WorkspaceState,
  args: { id: string; name?: string; description?: string },
): Mutation<Collection> {
  const cur = safeGet(state.collections, args.id);
  if (!cur) throw new DomainError("collection_not_found", `Collection not found: ${args.id}`);
  const next: Collection = {
    ...cur,
    ...(args.name !== undefined && { name: requireText(args.name, "name") }),
    ...(args.description !== undefined && { description: args.description }),
  };
  return { state: { ...state, collections: { ...state.collections, [cur.id]: next } }, value: next };
}

/** Refuses to delete a collection any memory (saved or awaiting review) still references. */
export function deleteCollection(state: WorkspaceState, args: { id: string }): Mutation {
  if (!safeGet(state.collections, args.id)) throw new DomainError("collection_not_found", `Collection not found: ${args.id}`);
  const usedBySaved = listMemories(state, { includePending: true }).some((m) => m.collectionId === args.id);
  // A proposal still waiting for review may point at the collection too: approving it would dangle.
  const usedByProposal = Object.values(state.revisions).some(
    (r) => r.status === "pending" && r.snapshot.collectionId === args.id,
  );
  if (usedBySaved || usedByProposal) {
    throw new DomainError("collection_not_empty", "Collection still has memories");
  }
  const collections = { ...state.collections };
  delete collections[args.id];
  return { state: { ...state, collections }, value: undefined };
}
