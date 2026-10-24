import { DomainError } from "./context.js";
import type { Actor, MemoryProvenance, MemorySnapshot, RelationProvenance } from "./types.js";
import { deepEqual } from "./util.js";

/** Size caps for the domain write path. Agents (untrusted writers) get tight caps; users generous ones. */
export const LIMITS = {
  title: 200,
  tagCount: 20,
  tagLength: 50,
  agentContent: 50_000,
  userContent: 1_000_000,
  agentMetadataBytes: 8 * 1024,
  userMetadataBytes: 1_000_000,
  label: 200,
  type: 100,
  source: 500,
  provenance: 200,
  actorName: 100,
} as const;

const tooLarge = (msg: string) => new DomainError("too_large", msg);
const invalid = (msg: string) => new DomainError("invalid_input", msg);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The single actor guard. Throws DomainError "invalid_input" unless `actor` is an object with kind exactly
 * "user" | "agent" and a non-blank string name (max 100 chars, no control characters). Never a TypeError.
 */
export function assertActor(actor: unknown): asserts actor is Actor {
  if (typeof actor !== "object" || actor === null || Array.isArray(actor)) throw invalid("actor is required");
  const { kind, name } = actor as { kind?: unknown; name?: unknown };
  if (kind !== "user" && kind !== "agent") throw invalid('actor.kind must be "user" or "agent"');
  if (typeof name !== "string" || !name.trim()) throw invalid("actor.name is required");
  if (name.length > LIMITS.actorName) throw invalid(`actor.name is too long (max ${LIMITS.actorName} characters)`);
  if (CONTROL_CHARS.test(name)) throw invalid("actor.name must not contain control characters");
}

function assertStringMax(value: unknown, max: number, what: string): void {
  if (typeof value !== "string") throw invalid(`${what} must be a string`);
  if (value.length > max) throw tooLarge(`${what} is too long (max ${max} characters)`);
}

/** Write-time caps for a new memory's identity fields (source, provenance). Non-strings are "invalid_input". */
export function assertIdentityLimits(identity: { source: unknown; provenance: unknown }): void {
  assertStringMax(identity.source, LIMITS.source, "source");
  const p = identity.provenance as Partial<MemoryProvenance> | null;
  if (typeof p !== "object" || p === null) throw invalid("provenance must be an object");
  assertStringMax(p.origin, LIMITS.provenance, "provenance.origin");
  assertStringMax(p.createdBy, LIMITS.provenance, "provenance.createdBy");
}

/** Write-time caps for a new relation's label (already trimmed) and provenance strings. */
export function assertRelationLimits(label: string, provenance: unknown): void {
  assertStringMax(label, LIMITS.label, "label");
  const p = provenance as Partial<RelationProvenance> | null;
  if (typeof p !== "object" || p === null) throw invalid("provenance must be an object");
  assertStringMax(p.createdBy, LIMITS.provenance, "provenance.createdBy");
  if (p.process !== undefined) assertStringMax(p.process, LIMITS.provenance, "provenance.process");
}

/**
 * Throws DomainError "too_large" when a snapshot written by `actor` exceeds the caps. Only fields that
 * differ from `base` are checked, so an old oversized value never blocks editing an unrelated field.
 */
export function assertWithinLimits(snapshot: MemorySnapshot, actor: Actor, base?: MemorySnapshot): void {
  const changed = (k: keyof MemorySnapshot) => !base || !deepEqual(base[k], snapshot[k]);
  const isAgent = actor.kind === "agent";
  if (changed("title") && snapshot.title.length > LIMITS.title) {
    throw tooLarge(`Title is too long (max ${LIMITS.title} characters)`);
  }
  if (changed("type") && snapshot.type.length > LIMITS.type) {
    throw tooLarge(`Type is too long (max ${LIMITS.type} characters)`);
  }
  const maxContent = isAgent ? LIMITS.agentContent : LIMITS.userContent;
  if (changed("content") && snapshot.content.length > maxContent) {
    throw tooLarge(`Content is too long (max ${maxContent} characters)`);
  }
  if (changed("tags")) {
    if (snapshot.tags.length > LIMITS.tagCount) throw tooLarge(`Too many tags (max ${LIMITS.tagCount})`);
    if (snapshot.tags.some((t) => t.length > LIMITS.tagLength)) {
      throw tooLarge(`A tag is too long (max ${LIMITS.tagLength} characters)`);
    }
  }
  if (changed("metadata")) {
    const max = isAgent ? LIMITS.agentMetadataBytes : LIMITS.userMetadataBytes;
    if (new TextEncoder().encode(JSON.stringify(snapshot.metadata)).length > max) {
      throw tooLarge(`Metadata is too large (max ${max} bytes)`);
    }
  }
}
