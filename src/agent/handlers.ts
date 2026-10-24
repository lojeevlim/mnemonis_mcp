import { z } from "zod";
import {
  diffPending,
  diffRevisions,
  DomainError,
  getMemory,
  listMemories,
  listPendingRelations,
  listRelations,
  memoryHistory,
  pendingChanges,
  pendingRevisionFor,
  searchWorkspace,
  timeline,
  type Memory,
  type Revision,
  type WorkspaceState,
} from "../domain/index.js";
import { MAX_PENDING_AGENT_ITEMS, type AgentWriter } from "../service/guards.js";
import type { MemoryService } from "../service/memoryService.js";
import type { AGENT_SCHEMAS, ToolName } from "./schemas.js";

const WRITE_NOTE =
  "Saved as a draft proposal. It is NOT part of long-term memory until the user approves it in the Mnemonis Inbox (in the Mnemonis web app).";

export interface HandlerDeps {
  service: MemoryService;
  writer: AgentWriter;
  /** Pending-item cap reported by memory_status (the guard enforces it). */
  maxPending?: number;
}

export interface HandlerResult {
  data: Record<string, unknown>;
  /** Extra values whose ids are audited. */
  ids?: unknown[];
}

// ---- views (explicit field picks: nothing internal leaks) ----

const memoryView = (m: Memory) => ({
  id: m.id,
  title: m.title,
  content: m.content,
  type: m.type,
  tags: m.tags,
  collectionId: m.collectionId,
  metadata: m.metadata,
  status: m.status,
  archived: m.archived,
  hasPendingProposal: m.hasPending,
  source: m.source,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
  revisionId: m.revisionId,
});

const revisionView = (r: Revision) => ({
  revisionId: r.id,
  memoryId: r.memoryId,
  title: r.snapshot.title,
  author: r.author,
  origin: r.origin,
  status: r.status,
  note: r.note,
  createdAt: r.createdAt,
  savedAt: r.savedAt,
});

/** Content of a memory that has been saved at least once. Pending-only memories are metadata only. */
function readMemory(state: WorkspaceState, id: string) {
  if (!Object.hasOwn(state.memories, id)) throw new DomainError("memory_not_found", `Memory not found: ${id}`);
  const shown = getMemory(state, id);
  if (!shown) throw new DomainError("memory_not_found", `Memory not found: ${id}`);
  const proposal = pendingRevisionFor(state, id);
  const proposalMeta = proposal
    ? { revisionId: proposal.id, author: proposal.author, createdAt: proposal.createdAt, note: proposal.note }
    : null;
  const saved = listMemories(state).find((m) => m.id === id);
  if (!saved) {
    return {
      memory: { id, status: "pending", pendingOnly: true, contentAvailable: false },
      pendingProposal: proposalMeta,
      message: "This memory is a new proposal that has not been approved yet, so its content is not part of memory. Use memory_diff with the proposal revisionId to inspect it.",
    };
  }
  return { memory: memoryView(saved), pendingProposal: proposalMeta };
}

/** Memory.revisionId is the SAVED revision when one exists, so the proposal id is looked up explicitly. */
const proposalId = (state: WorkspaceState, memoryId: string): string | null => pendingRevisionFor(state, memoryId)?.id ?? null;

type Args<N extends ToolName> = z.infer<(typeof AGENT_SCHEMAS)[N]>;
export type AgentHandlers = { [N in ToolName]: (args: Args<N>) => Promise<HandlerResult> };

/**
 * The tool bodies, independent of any transport: the internal /api/agent/* routes and the legacy /mcp endpoint both
 * call these. Arguments are already validated against AGENT_SCHEMAS.
 */
export function createAgentHandlers({ service, writer, maxPending }: HandlerDeps): AgentHandlers {
  return {
    async memory_search(a) {
      const { state } = await service.getState();
      const r = searchWorkspace(state, { ...a, includePending: false });
      return {
        data: {
          total: r.total,
          limit: r.limit,
          offset: r.offset,
          results: r.items.map((h) => ({ score: h.score, matchedOn: h.matchedOn, memory: memoryView(h.memory) })),
        },
      };
    },

    async memory_read(a) {
      const { state } = await service.getState();
      return { data: readMemory(state, a.id) };
    },

    async memory_list(a) {
      const { state } = await service.getState();
      const r = searchWorkspace(state, { ...a, includePending: false });
      return { data: { total: r.total, limit: r.limit, offset: r.offset, memories: r.items.map((h) => memoryView(h.memory)) } };
    },

    async memory_related(a) {
      const { state } = await service.getState();
      if (!Object.hasOwn(state.memories, a.id)) throw new DomainError("memory_not_found", `Memory not found: ${a.id}`);
      const byId = new Map(listMemories(state).map((m) => [m.id, m]));
      const related = listRelations(state, a.id).map((r) => {
        const otherId = r.fromId === a.id ? r.toId : r.fromId;
        return {
          relationId: r.id,
          label: r.label,
          direction: r.fromId === a.id ? "outgoing" : "incoming",
          memory: { id: otherId, title: byId.get(otherId)?.title ?? null, type: byId.get(otherId)?.type ?? null },
        };
      });
      return { data: { memoryId: a.id, related } };
    },

    async memory_history(a) {
      const { state } = await service.getState();
      if (!Object.hasOwn(state.memories, a.id)) throw new DomainError("memory_not_found", `Memory not found: ${a.id}`);
      return { data: { memoryId: a.id, revisions: memoryHistory(state, a.id).slice(0, a.limit).map(revisionView) } };
    },

    async memory_status(a) {
      const { state, rev } = await service.getState();
      const proposals = pendingChanges(state);
      const links = listPendingRelations(state);
      return {
        data: {
          pending: {
            total: proposals.length + links.length,
            proposals: proposals.length,
            links: links.length,
            inboxCap: maxPending ?? MAX_PENDING_AGENT_ITEMS,
            note: "Pending items are visible only to the user until approved in the Mnemonis Inbox.",
          },
          recentSavedChanges: timeline(state, a.recent).map(revisionView),
          workspaceRev: rev,
        },
      };
    },

    async memory_diff(a) {
      const { state } = await service.getState();
      if (a.revisionId !== undefined && a.fromRevisionId === undefined && a.toRevisionId === undefined) {
        const d = diffPending(state, a.revisionId);
        return { data: { kind: d.kind, memoryId: d.memoryId, fields: d.fields }, ids: [d] };
      }
      if (a.revisionId === undefined && a.fromRevisionId !== undefined && a.toRevisionId !== undefined) {
        return { data: { fields: diffRevisions(state, a.fromRevisionId, a.toRevisionId) } };
      }
      throw new DomainError("invalid_input", "Pass either revisionId, or both fromRevisionId and toRevisionId");
    },

    // ---- writes (always pending) ----

    async memory_save(a) {
      const r = await writer.save(a);
      return {
        data: { status: "pending", message: WRITE_NOTE, memoryId: r.value.id, revisionId: proposalId(r.state, r.value.id) },
        ids: [{ id: r.value.id, revisionId: proposalId(r.state, r.value.id) }],
      };
    },

    async memory_update(a) {
      const { id: memoryId, ...patch } = a;
      if (Object.values(patch).every((v) => v === undefined)) {
        throw new DomainError("invalid_input", "Pass at least one field to change");
      }
      const r = await writer.update({ id: memoryId, patch });
      const revisionId = proposalId(r.state, memoryId);
      if (!revisionId) return { data: { status: "no_change", message: "Nothing to propose: the memory already has these values.", memoryId } };
      return { data: { status: "pending", message: WRITE_NOTE, memoryId, revisionId }, ids: [{ revisionId }] };
    },

    async memory_link(a) {
      const r = await writer.link(a);
      return { data: { status: "pending", message: WRITE_NOTE, relationId: r.value.id }, ids: [{ relationId: r.value.id }] };
    },

    async memory_archive(a) {
      const r = await writer.archive(a);
      const revisionId = proposalId(r.state, a.id);
      if (!revisionId) return { data: { status: "no_change", message: "Nothing to propose: the memory is already archived.", memoryId: a.id } };
      return { data: { status: "pending", message: WRITE_NOTE, memoryId: a.id, revisionId }, ids: [{ revisionId }] };
    },
  };
}
