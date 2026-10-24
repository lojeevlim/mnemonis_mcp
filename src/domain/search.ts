import { listMemories } from "./queries.js";
import type { Json, Memory, MemoryStatus, WorkspaceState } from "./types.js";

export interface SearchOptions {
  query?: string;
  type?: string;
  collectionId?: string | null;
  status?: MemoryStatus;
  tag?: string;
  /** Archived memories are hidden when no status filter is given, unless this is true. */
  includeArchived?: boolean;
  /** Also search memories that have no saved version yet (new proposals awaiting review). */
  includePending?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  memory: Memory;
  score: number;
  matchedOn: string[];
}

export interface SearchResult {
  items: SearchHit[];
  total: number;
  limit: number;
  offset: number;
}

const tokenize = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function metadataText(v: Json): string {
  if (v === null) return "";
  if (typeof v === "object") return Object.values(v).map(metadataText).join(" ");
  return String(v);
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

function tokenScore(m: Memory, query: string): { score: number; matchedOn: string[] } {
  const q = query.toLowerCase();
  const matched = new Set<string>();
  let tier = 0;
  const title = m.title.toLowerCase();
  if (m.id.toLowerCase() === q) {
    tier = 10_000;
    matched.add("id");
  } else if (title === q) {
    tier = 5_000;
    matched.add("title");
  } else if (title.startsWith(q)) {
    tier = 3_000;
    matched.add("title");
  }

  const tokens = tokenize(query);
  const titleTokens = tokenize(m.title);
  const tagTokens = m.tags.flatMap(tokenize);
  const content = m.content.toLowerCase();
  const meta = [m.type, ...Object.entries(m.metadata).map(([k, v]) => `${k} ${metadataText(v)}`)].join(" ").toLowerCase();

  let score = 0;
  for (const t of tokens) {
    let s = 0;
    if (titleTokens.includes(t)) {
      s += 20;
      matched.add("title");
    } else if (titleTokens.some((x) => x.startsWith(t))) {
      s += 12;
      matched.add("title");
    } else if (title.includes(t)) {
      s += 6;
      matched.add("title");
    }
    if (tagTokens.includes(t)) {
      s += 15;
      matched.add("tags");
    } else if (tagTokens.some((x) => x.startsWith(t))) {
      s += 8;
      matched.add("tags");
    }
    const c = countOccurrences(content, t);
    if (c > 0) {
      s += Math.min(c, 5) * 2;
      matched.add("content");
    }
    if (meta.includes(t)) {
      s += 3;
      matched.add("metadata");
    }
    if (s === 0 && tier === 0) return { score: 0, matchedOn: [] }; // AND semantics
    score += s;
  }
  return { score: tier + score, matchedOn: [...matched] };
}

/**
 * Token search first; when it finds nothing (e.g. punctuation-only queries like "#" have no
 * tokens, "c++" splits into "c"), fall back to a literal substring match on title/content.
 */
function scoreMemory(m: Memory, query: string): { score: number; matchedOn: string[] } {
  const r = tokenScore(m, query);
  if (r.score > 0) return r;
  const q = query.toLowerCase();
  const matchedOn: string[] = [];
  let score = 0;
  if (m.title.toLowerCase().includes(q)) {
    score += 6;
    matchedOn.push("title");
  }
  if (m.content.toLowerCase().includes(q)) {
    score += 2;
    matchedOn.push("content");
  }
  return { score, matchedOn };
}

/** Pure search over an already-materialized list of memories. */
export function searchMemories(memories: Memory[], opts: SearchOptions = {}): SearchResult {
  const limit = Math.max(1, opts.limit ?? 20);
  const offset = Math.max(0, opts.offset ?? 0);
  const query = (opts.query ?? "").trim();
  const wantArchived = opts.includeArchived || opts.status !== undefined;

  const hits: SearchHit[] = [];
  for (const m of memories) {
    if (opts.type !== undefined && m.type !== opts.type) continue;
    if (opts.collectionId !== undefined && m.collectionId !== opts.collectionId) continue;
    if (opts.status !== undefined && m.status !== opts.status) continue;
    if (opts.tag !== undefined && !m.tags.some((t) => t.toLowerCase() === opts.tag?.toLowerCase())) continue;
    if (!wantArchived && m.archived) continue;
    if (!query) {
      hits.push({ memory: m, score: 0, matchedOn: [] });
      continue;
    }
    const r = scoreMemory(m, query);
    if (r.score > 0) hits.push({ memory: m, score: r.score, matchedOn: r.matchedOn });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (a.memory.updatedAt < b.memory.updatedAt ? 1 : a.memory.updatedAt > b.memory.updatedAt ? -1 : 0) ||
      a.memory.id.localeCompare(b.memory.id),
  );
  return { items: hits.slice(offset, offset + limit), total: hits.length, limit, offset };
}

/** Searches the memories in the workspace. */
export function searchWorkspace(state: WorkspaceState, opts: SearchOptions = {}): SearchResult {
  return searchMemories(listMemories(state, { includePending: opts.includePending }), opts);
}
