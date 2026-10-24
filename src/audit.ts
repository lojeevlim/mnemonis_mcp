import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface AuditEntry {
  /** Which door the call came through. */
  via: "rest" | "mcp";
  /** Caller label (REST user name or MCP client name). Never a token. */
  client: string;
  /** Effective actor kind the write ran as (REST ops: "user" or a downgraded "agent"). */
  actorKind?: "user" | "agent";
  /** Operation or tool name. */
  action: string;
  /** Record ids touched (never content). */
  ids?: string[];
  ok: boolean;
  /** Error code when !ok. */
  code?: string;
}

export interface AuditLog {
  record(entry: AuditEntry): void;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** Append-only JSONL audit log (<dir>/audit.log). Only ids, names and outcomes: no content, no tokens. */
export function createAuditLog(dir: string): AuditLog {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "audit.log");
  let first = true;
  return {
    record(entry) {
      const line = {
        time: new Date().toISOString(),
        via: entry.via,
        client: clip(entry.client, 100),
        ...(entry.actorKind ? { actorKind: entry.actorKind } : {}),
        action: clip(entry.action, 100),
        ...(entry.ids?.length ? { ids: entry.ids.slice(0, 50).map((i) => clip(i, 100)) } : {}),
        ok: entry.ok,
        ...(entry.code ? { code: clip(entry.code, 60) } : {}),
      };
      try {
        appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
        if (first) {
          first = false;
          chmodSync(file, 0o600);
        }
      } catch {
        /* auditing must never break a request */
      }
    },
  };
}

export const noAudit: AuditLog = { record() {} };

/** Collects string ids from a value (e.g. {id}, {memoryId}) for the audit trail. */
export function idsOf(...values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v === null || typeof v !== "object") continue;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((k === "id" || k.endsWith("Id")) && typeof x === "string") out.push(x);
      else if (k.endsWith("Ids") && Array.isArray(x)) out.push(...x.filter((i): i is string => typeof i === "string"));
    }
  }
  return out;
}
