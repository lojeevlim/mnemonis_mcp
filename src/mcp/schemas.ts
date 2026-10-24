import { z } from "zod";

/**
 * Tool input schemas. They DUPLICATE the API's (the API validates again and is authoritative): the adapter keeps no shared
 * code with it, and adapter/test/schemas.test.ts checks these against the vendored contract/agent-v1/limits.json.
 */
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

export const READ_TOOLS: readonly ToolName[] = ["memory_search", "memory_read", "memory_list", "memory_related", "memory_history", "memory_status", "memory_diff"];

/** tool name -> path below /api/agent (memory_search -> /memory/search). */
export const toolPath = (name: ToolName): string => `/memory/${name.slice("memory_".length)}`;

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const TAG_LENGTH = 50;
const TAG_COUNT = 20;
const TITLE = 200;
const AGENT_CONTENT = 50_000;
const AGENT_METADATA_BYTES = 8 * 1024;
const MAX_RELATION_LABEL = 200;

const id = z.string().min(1).max(200).describe("Memory id");
const revisionId = z.string().min(1).max(200);
const limit = (def: number, max: number) => z.number().int().min(1).max(max).default(def);
const offset = z.number().int().min(0).max(1_000_000).default(0);
const filters = {
  type: z.string().min(1).max(100).optional().describe("Only this memory type"),
  tag: z.string().min(1).max(TAG_LENGTH).optional().describe("Only memories with this tag"),
  collectionId: z.string().min(1).max(200).nullable().optional().describe("Only this collection (null = uncollected)"),
  status: z.enum(["saved", "pending", "archived"]).optional().describe("Filter by status"),
  includeArchived: z.boolean().optional().describe("Include archived memories (default false)"),
};
const jsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);
const metadata = z.record(z.string(), jsonValue).describe(`Small JSON object (max ${AGENT_METADATA_BYTES} bytes)`);
const title = z.string().min(1).max(TITLE);
const content = z.string().max(AGENT_CONTENT).describe("Markdown text");
const type = z.string().min(1).max(100).describe("e.g. preference, fact, project, technical_decision, procedure");
const tags = z.array(z.string().min(1).max(TAG_LENGTH)).max(TAG_COUNT);
const collectionId = z.string().min(1).max(200).nullable();

export const TOOL_SCHEMAS = {
  memory_search: z.strictObject({ query: z.string().min(1).max(500).describe("Keywords (max 500 characters)"), ...filters, limit: limit(20, 100), offset }),
  memory_read: z.strictObject({ id }),
  memory_list: z.strictObject({ ...filters, limit: limit(20, 100), offset }),
  memory_related: z.strictObject({ id }),
  memory_history: z.strictObject({ id, limit: limit(20, 100) }),
  memory_status: z.strictObject({ recent: limit(10, 50).describe("How many recent saved changes to show") }),
  memory_diff: z.strictObject({ revisionId: revisionId.optional(), fromRevisionId: revisionId.optional(), toRevisionId: revisionId.optional() }),
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
  memory_link: z.strictObject({ fromId: id, toId: id, label: z.string().min(1).max(MAX_RELATION_LABEL).describe("Short relation label, e.g. 'depends on'") }),
  memory_archive: z.strictObject({ id }),
} as const satisfies Record<ToolName, z.ZodType>;
