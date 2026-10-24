import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe as baseDescribe, expect, it } from "vitest";
import { AGENT_CONTRACT_VERSION, CONTRACT_LIMITS, TOOL_NAMES, toolPath } from "../src/agent/schemas.js";
import { agentHeaders, agentPost, startTestServer, TEST_DB_URL } from "./helpers.js";

const describe = baseDescribe.skipIf(!TEST_DB_URL);

/**
 * Generates (UPDATE_CONTRACT=1) or verifies contract/agent-v1/*.json: one request+response example per endpoint, the limits and
 * the error table. The adapter project vendors these files (scripts/sync-contract.mjs) and replays them against its client,
 * so a drift between the two projects fails a test on one side or the other.
 */
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "contract", "agent-v1");
const UPDATE = process.env.UPDATE_CONTRACT === "1";

/** Replaces random ids with stable placeholders (by first appearance) and timestamps with a fixed instant. */
function scrubber() {
  const seen = new Map<string, string>();
  const counters: Record<string, number> = {};
  const id = (m: string, prefix: string) => {
    if (!seen.has(m)) seen.set(m, `${prefix}_${(counters[prefix] = (counters[prefix] ?? 0) + 1)}`);
    return seen.get(m)!;
  };
  const text = (s: string) =>
    s.replace(/\b(mem|rev|rel|col)_[A-Za-z0-9-]+/g, (m, p: string) => id(m, p)).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/g, "2026-01-01T00:00:00.000Z");
  return <T>(v: T): T => JSON.parse(text(JSON.stringify(v))) as T;
}

function check(file: string, value: unknown): void {
  const path = join(DIR, file);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (UPDATE) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path, text);
    return;
  }
  expect(existsSync(path), `${file} missing: run UPDATE_CONTRACT=1 npx vitest run test/agentContract.test.ts`).toBe(true);
  expect(JSON.parse(text), `${file} drifted: run UPDATE_CONTRACT=1 npx vitest run test/agentContract.test.ts`).toEqual(JSON.parse(readFileSync(path, "utf8")));
}

/** The status/error table of the contract (documentation of every code a client must handle). */
const ERROR_TABLE = [
  { status: 400, code: "invalid_input", note: "bad JSON, unknown key, out-of-range value" },
  { status: 401, code: "unauthorized", note: "identical body for every credential failure; WWW-Authenticate: Bearer realm=\"mnemonis\"" },
  { status: 403, code: "forbidden_host", note: "Host header not allowed (configuration)" },
  { status: 403, code: "forbidden_origin", note: "any Origin header (configuration)" },
  { status: 404, code: "memory_not_found", note: "also relation_not_found, revision_not_found, not_found" },
  { status: 409, code: "conflict", note: "also not_pending, proposal_outdated, duplicate_relation, memory_archived, endpoint_not_saved, not_saved" },
  { status: 413, code: "too_large", note: "request body over 512 KiB" },
  { status: 415, code: "unsupported_media_type", note: "Content-Type is not application/json" },
  { status: 422, code: "too_large", note: "domain caps / per-user workspace quota" },
  { status: 426, code: "contract_unsupported", note: "X-Mnemonis-Contract missing or not supported" },
  { status: 429, code: "rate_limited", note: "per-user limit; Retry-After header" },
  { status: 429, code: "inbox_full", note: "pending cap reached; tool-level error" },
  { status: 429, code: "too_many_failed_attempts", note: "pre-auth failure limiter; Retry-After header" },
  { status: 500, code: "internal", note: "masked" },
  { status: 503, code: "unavailable", note: "backend unavailable" },
];

describe("contract fixtures (contract/agent-v1)", () => {
  it("matches (or regenerates) the committed fixtures", async () => {
    const t = await startTestServer();
    try {
      const { token } = await t.a.mcpToken();
      const scrub = scrubber();
      const examples: { file: string; entry: unknown }[] = [];
      const record = async (tool: (typeof TOOL_NAMES)[number], body: Record<string, unknown>, label: string) => {
        const r = await agentPost(t.url, token, tool, body);
        const response = (await r.json()) as unknown;
        expect(r.status, `${tool} ${label}`).toBe(200);
        examples.push({ file: `${tool}.${label}.json`, entry: { tool, method: "POST", path: `/api/agent${toolPath(tool)}`, request: { body }, response: { status: 200, body: response } } });
        return response as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      };

      // pending-only memory
      const saved1 = await record("memory_save", { title: "Prefers tabs", content: "Use tabs", type: "preference", tags: ["style"], metadata: { source: "chat" } }, "pending");
      await record("memory_read", { id: saved1.memoryId }, "pending_only");
      await record("memory_diff", { revisionId: saved1.revisionId }, "pending");
      await record("memory_status", { recent: 10 }, "default");
      expect((await t.op("approve", { revisionId: saved1.revisionId })).status).toBe(200);
      const saved2 = await record("memory_save", { title: "Second note" }, "minimal");
      expect((await t.op("approve", { revisionId: saved2.revisionId })).status).toBe(200);

      await record("memory_search", { query: "tabs", limit: 20, offset: 0 }, "hit");
      await record("memory_list", { limit: 20, offset: 0 }, "default");
      await record("memory_read", { id: saved1.memoryId }, "saved");
      const upd = await record("memory_update", { id: saved1.memoryId, content: "Use tabs everywhere" }, "pending");
      await record("memory_update", { id: saved2.memoryId, title: "Second note" }, "no_change");
      await record("memory_diff", { revisionId: upd.revisionId }, "modified");
      const link = await record("memory_link", { fromId: saved1.memoryId, toId: saved2.memoryId, label: "relates to" }, "pending");
      expect((await t.op("approveRelation", { relationId: link.relationId })).status).toBe(200);
      await record("memory_related", { id: saved1.memoryId }, "outgoing");
      const hist = await record("memory_history", { id: saved1.memoryId, limit: 20 }, "default");
      await record("memory_diff", { fromRevisionId: hist.revisions[0].revisionId, toRevisionId: hist.revisions[0].revisionId }, "revisions");
      await record("memory_archive", { id: saved2.memoryId }, "pending");

      // every tool has at least one example
      expect([...new Set(examples.map((e) => (e.entry as { tool: string }).tool))].sort()).toEqual([...TOOL_NAMES].sort());
      for (const e of examples) check(e.file, scrub(e.entry));

      const ping = await fetch(`${t.url}/api/agent/ping`, { headers: agentHeaders(token) });
      check("ping.json", { method: "GET", path: "/api/agent/ping", response: { status: ping.status, body: await ping.json() } });
      const contract = await fetch(`${t.url}/api/agent/contract`);
      check("contract.json", { method: "GET", path: "/api/agent/contract", response: { status: contract.status, body: await contract.json() } });
      check("limits.json", { contract: AGENT_CONTRACT_VERSION, ...CONTRACT_LIMITS });
      check("errors.json", ERROR_TABLE);

      // real error examples (bodies are asserted live; the table above documents the rest)
      const bad = await agentPost(t.url, token, "memory_save", { title: "x", actor: { kind: "user", name: "me" } });
      const nf = await agentPost(t.url, token, "memory_read", { id: "mem_nope" });
      const np = await agentPost(t.url, token, "memory_diff", { revisionId: hist.revisions[0].revisionId }); // a saved (not pending) revision
      const no = await fetch(`${t.url}/api/agent/ping`, { headers: { "X-Mnemonis-Contract": "1" } });
      check("error-examples.json", scrub({
        invalid_input: { status: bad.status, body: await bad.json() },
        memory_not_found: { status: nf.status, body: await nf.json() },
        not_pending: { status: np.status, body: await np.json() },
        unauthorized: { status: no.status, body: await no.json(), wwwAuthenticate: no.headers.get("www-authenticate") },
      }));
    } finally {
      await t.close();
    }
  });
});
