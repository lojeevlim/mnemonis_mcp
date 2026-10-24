import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";

export interface AuditEntry {
  /** The authenticated user the call ran as (taken from the auth context, never from request input). */
  userId: string;
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
        userId: entry.userId,
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

export interface PgAudit extends AuditLog {
  /** Writes everything queued so far (best effort; never throws). Used on shutdown and in tests. */
  flush(): Promise<void>;
  /** Entries lost to queue overflow or database errors since start. */
  dropped(): number;
}

export const AUDIT_QUEUE_MAX = 1000;
const AUDIT_BATCH = 100;
const AUDIT_DELAY_MS = 200;

/**
 * Postgres audit trail (audit_log table). record() only enqueues into a bounded in-memory queue; a batched
 * writer persists it in the background. Overflow and database errors drop entries and bump a counter, so auditing
 * can never block or fail a request. Entries carry ids, names and outcomes only: no content, no tokens.
 */
export function createPgAudit(pool: pg.Pool, opts: { maxQueue?: number } = {}): PgAudit {
  const maxQueue = opts.maxQueue ?? AUDIT_QUEUE_MAX;
  const queue: AuditEntry[] = [];
  let lost = 0;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const writeBatch = async (batch: AuditEntry[]): Promise<void> => {
    const params: unknown[] = [];
    const rows = batch.map((e, i) => {
      const o = i * 8;
      params.push(
        e.userId,
        e.via,
        clip(e.client, 100),
        e.actorKind ?? null,
        clip(e.action, 100),
        (e.ids ?? []).slice(0, 50).map((x) => clip(x, 100)),
        e.ok,
        e.code ? clip(e.code, 60) : null,
      );
      return `($${o + 1}::uuid,$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6}::text[],$${o + 7},$${o + 8})`;
    });
    await pool.query(`INSERT INTO audit_log (user_id,via,client,actor_kind,action,ids,ok,code) VALUES ${rows.join(",")}`, params);
  };

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const batch = queue.splice(0, AUDIT_BATCH);
      try {
        await writeBatch(batch);
      } catch {
        // One bad row (e.g. FK violation for a deleted user) must not drop the others: retry row by row.
        let failed = 0;
        for (const entry of batch) {
          try {
            await writeBatch([entry]);
          } catch {
            failed++;
          }
        }
        if (failed > 0) {
          lost += failed;
          console.error(`audit: database write failed, ${failed} entr${failed === 1 ? "y" : "ies"} dropped`);
        }
      }
    }
  };

  const kick = (): Promise<void> => {
    running ??= drain().finally(() => {
      running = undefined;
    });
    return running;
  };

  return {
    record(entry) {
      if (queue.length >= maxQueue) {
        lost++;
        return;
      }
      queue.push(entry);
      if (!timer && !running) {
        timer = setTimeout(() => {
          timer = undefined;
          void kick();
        }, AUDIT_DELAY_MS);
        timer.unref();
      }
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      // Entries recorded while a drain runs are picked up by that drain's loop; loop to be sure none are left.
      while (queue.length > 0 || running) await kick();
    },
    dropped: () => lost,
  };
}

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
