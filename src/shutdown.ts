import type { PgAudit } from "./audit.js";

export const SHUTDOWN_GRACE_MS = 10_000;
export const AUDIT_FLUSH_TIMEOUT_MS = 5_000;

interface Closable {
  close(graceMs?: number): Promise<void>;
}

const withTimeout = (p: Promise<unknown>, ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
    p.then(
      () => (clearTimeout(t), resolve()),
      () => (clearTimeout(t), resolve()),
    );
  });

/**
 * Ordered graceful shutdown: stop accepting and drain in-flight requests (bounded), THEN flush the audit queue
 * (bounded; requests finishing during the drain may still enqueue entries), THEN close the database pool.
 */
export async function shutdown(
  parts: { server: Closable; audit: Pick<PgAudit, "flush">; pool: { end(): Promise<void> } },
  limits: { graceMs?: number; flushMs?: number } = {},
): Promise<void> {
  await withTimeout(parts.server.close(limits.graceMs ?? SHUTDOWN_GRACE_MS), (limits.graceMs ?? SHUTDOWN_GRACE_MS) + 1_000);
  await withTimeout(parts.audit.flush(), limits.flushMs ?? AUDIT_FLUSH_TIMEOUT_MS);
  await withTimeout(parts.pool.end(), 5_000);
}
