import { z } from "zod";
import { LIMITS, type Json } from "../domain/index.js";
import { MAX_RELATION_LABEL } from "../service/guards.js";

/** Version of the internal /api/agent/* contract (bump only on breaking changes). */
export const AGENT_CONTRACT_VERSION = 1;

export const TOOL_NAMES = [
  "memory_search",
  "memory_read",
  "memory_list",
  "memory_related",
  "memory_history",
  "memory_status",
  "memory_diff",
  "memory_save",
  "memory_update",
  "memory_link",
  "memory_archive",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** tool name -> endpoint path below /api/agent (memory_search -> /memory/search). */
export const toolPath = (name: ToolName): string => `/memory/${name.slice("memory_".length)}`;

const id = z.string().min(1).max(200).describe("Memory id");
const revisionId = z.string().min(1).max(200);
const limit = (def: number, max: number) => z.number().int().min(1).max(max).default(def);
const offset = z.number().int().min(0).max(1_000_000).default(0);
const filters = {
  type: z.string().min(1).max(100).optional().describe("Only this memory type"),
  tag: z.string().min(1).max(LIMITS.tagLength).optional().describe("Only memories with this tag"),
  collectionId: z.string().min(1).max(200).nullable().optional().describe("Only this collection (null = uncollected)"),
  status: z.enum(["saved", "pending", "archived"]).optional().describe("Filter by status"),
  includeArchived: z.boolean().optional().describe("Include archived memories (default false)"),
};
const jsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);
const metadata = z.record(z.string(), jsonValue).describe(`Small JSON object (max ${LIMITS.agentMetadataBytes} bytes)`);
const title = z.string().min(1).max(LIMITS.title);
const content = z.string().max(LIMITS.agentContent).describe("Markdown text");
const type = z.string().min(1).max(100).describe("e.g. preference, fact, project, technical_decision, procedure");
const tags = z.array(z.string().min(1).max(LIMITS.tagLength)).max(LIMITS.tagCount);
const collectionId = z.string().min(1).max(200).nullable();

/**
 * One strict body schema per tool: the request body of POST /api/agent/memory/<name> and the MCP tool input are the
 * same shape. Unknown keys (actor, origin, source, provenance...) are rejected, never ignored.
 */
export const AGENT_SCHEMAS = {
  memory_search: z.strictObject({
    query: z.string().min(1).max(500).describe("Keywords (max 500 characters)"),
    ...filters,
    limit: limit(20, 100),
    offset,
  }),
  memory_read: z.strictObject({ id }),
  memory_list: z.strictObject({ ...filters, limit: limit(20, 100), offset }),
  memory_related: z.strictObject({ id }),
  memory_history: z.strictObject({ id, limit: limit(20, 100) }),
  memory_status: z.strictObject({ recent: limit(10, 50).describe("How many recent saved changes to show") }),
  memory_diff: z.strictObject({
    revisionId: revisionId.optional(),
    fromRevisionId: revisionId.optional(),
    toRevisionId: revisionId.optional(),
  }),
  memory_save: z.strictObject({
    title,
    content: content.optional(),
    type: type.optional(),
    tags: tags.optional(),
    collectionId: collectionId.optional(),
    metadata: metadata.optional(),
  }),
  memory_update: z.strictObject({
    id,
    title: title.optional(),
    content: content.optional(),
    type: type.optional(),
    tags: tags.optional(),
    collectionId: collectionId.optional(),
    metadata: metadata.optional(),
  }),
  memory_link: z.strictObject({
    fromId: id,
    toId: id,
    label: z.string().min(1).max(MAX_RELATION_LABEL).describe("Short relation label, e.g. 'depends on'"),
  }),
  memory_archive: z.strictObject({ id }),
} as const satisfies Record<ToolName, z.ZodType>;

export const READ_TOOLS: readonly ToolName[] = [
  "memory_search",
  "memory_read",
  "memory_list",
  "memory_related",
  "memory_history",
  "memory_status",
  "memory_diff",
];
export const isReadTool = (n: ToolName): boolean => READ_TOOLS.includes(n);

/** Machine-readable limits, written into the contract fixtures (the adapter's schemas are tested against them). */
export const CONTRACT_LIMITS = {
  id: { min: 1, max: 200 },
  title: { min: 1, max: LIMITS.title },
  content: { max: LIMITS.agentContent },
  type: { min: 1, max: 100 },
  tags: { maxCount: LIMITS.tagCount, tagMin: 1, tagMax: LIMITS.tagLength },
  metadataBytes: { max: LIMITS.agentMetadataBytes },
  label: { min: 1, max: MAX_RELATION_LABEL },
  query: { min: 1, max: 500 },
  limit: { min: 1, max: 100, default: 20 },
  statusRecent: { min: 1, max: 50, default: 10 },
  offset: { min: 0, max: 1_000_000, default: 0 },
  status: ["saved", "pending", "archived"],
  bodyBytes: { max: 512 * 1024 },
} as const;
