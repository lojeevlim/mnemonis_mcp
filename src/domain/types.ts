/**
 * Mnemonis domain types. Everything here is JSON-safe plain data so the whole
 * WorkspaceState can be serialized, persisted, or moved to a backend/MCP service.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type Metadata = Record<string, Json>;

export const BUILT_IN_MEMORY_TYPES = [
  "personal_context",
  "preference",
  "project",
  "technical_decision",
  "fact",
  "research",
  "procedure",
  "meeting_note",
  "task",
  "reference",
] as const;
export type BuiltInMemoryType = (typeof BUILT_IN_MEMORY_TYPES)[number];
/** Open union: built-ins plus any custom type string. */
export type MemoryType = BuiltInMemoryType | (string & {});

/** saved = long term; pending = a proposal is waiting for review (short term). */
export type MemoryStatus = "saved" | "pending" | "archived";

export interface MemoryProvenance {
  /** e.g. 'user' | 'agent' | 'import' | 'demo' */
  origin: string;
  createdBy: string;
}

/** Fields that never change after creation. */
export interface MemoryIdentity {
  id: string;
  createdAt: string;
  source: string;
  provenance: MemoryProvenance;
}

/** The versioned (revisioned) fields of a memory. */
export interface MemorySnapshot {
  title: string;
  /** Markdown. Untrusted data: never evaluated or interpreted by the domain. */
  content: string;
  type: MemoryType;
  tags: string[];
  collectionId: string | null;
  archived: boolean;
  metadata: Metadata;
}

export type MemoryFieldName = keyof MemorySnapshot;
export const MEMORY_FIELDS: readonly MemoryFieldName[] = [
  "title",
  "content",
  "type",
  "tags",
  "collectionId",
  "archived",
  "metadata",
];
export type MemoryFieldValue = string | string[] | boolean | null | Metadata;

/** Materialized view of a memory (derived, never stored). */
export interface Memory extends MemoryIdentity, MemorySnapshot {
  status: MemoryStatus;
  /** True when an unreviewed proposal (pending revision) exists for this memory. */
  hasPending: boolean;
  /** savedAt of the current saved revision (createdAt of the proposal for pending-only memories). */
  updatedAt: string;
  /** Current saved revision id (the pending revision id for a memory that has never been saved). */
  revisionId: string;
}

export type RevisionStatus = "saved" | "pending" | "rejected" | "superseded";
export type Origin = "user" | "agent" | "import" | "system";
export const REVISION_STATUSES: readonly RevisionStatus[] = ["saved", "pending", "rejected", "superseded"];
export const ORIGINS: readonly Origin[] = ["user", "agent", "import", "system"];

/** Who performs a write. Agents never save directly: their writes become pending revisions. */
export interface Actor {
  kind: "user" | "agent";
  name: string;
}

/** The single unit of change: one immutable snapshot of one memory plus its review state. */
export interface Revision {
  id: string;
  memoryId: string;
  snapshot: MemorySnapshot;
  parentRevisionId: string | null;
  createdAt: string;
  author: string;
  origin: Origin;
  status: RevisionStatus;
  note: string;
  /** Stamped when the revision becomes saved (user edit or approval). */
  savedAt: string | null;
  /** When it was saved / rejected / superseded. */
  decidedAt: string | null;
}

export interface RelationProvenance {
  origin: "user" | "process";
  createdBy: string;
  /** Name of the producing process/agent when origin === 'process'. */
  process?: string;
  demo?: boolean;
}

/** saved = visible link; pending = proposed by an agent, waiting for review; rejected = kept for the record. */
export type RelationStatus = "saved" | "pending" | "rejected";
export const RELATION_STATUSES: readonly RelationStatus[] = ["saved", "pending", "rejected"];

export interface Relation {
  id: string;
  fromId: string;
  toId: string;
  label: string;
  provenance: RelationProvenance;
  createdAt: string;
  /** Absent in older stored data (normalised to "saved" on load / migrate / import). */
  status: RelationStatus;
  /** When the relation was saved / rejected (null while pending). */
  decidedAt: string | null;
}

export interface Collection {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

export type ChangeKind = "create" | "update" | "archive" | "restore";

export interface WorkspaceState {
  schemaVersion: 2;
  memories: Record<string, MemoryIdentity>;
  revisions: Record<string, Revision>;
  relations: Record<string, Relation>;
  collections: Record<string, Collection>;
}

/** Every mutation returns the next state plus a value. */
export interface Mutation<T = void> {
  state: WorkspaceState;
  value: T;
}
