import type pg from "pg";
import { KNOWN_IP_TTL_DAYS } from "./throttle.js";

export const MAX_THROTTLE_ROWS = 50_000;
const BATCH = 1000;
export const REVOKED_SESSION_KEEP_DAYS = 7;

export interface ReapResult {
  throttle: number;
  knownIps: number;
  sessions: number;
}

// The throttle deletes lock their rows with SKIP LOCKED: the reaper never waits on a row a login holds, so it cannot take part in a deadlock.

/** Safety bound on the number of batches one table gets per call, so a pathological backlog cannot loop forever. */
const MAX_BATCHES = 1000;

/** Runs a batched DELETE until a batch comes back short (fewer than `batch` rows), returning the total deleted. */
async function drain(batch: number, run: () => Promise<number | null>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = (await run()) ?? 0;
    total += n;
    if (n < batch) break;
  }
  return total;
}

/**
 * One cleanup pass. Every table is deleted in batches of `batch` rows (so no single statement holds long locks) and the pass
 * keeps going until a batch comes back short:
 *  - login_throttle rows past their expiry, plus the rows beyond MAX_THROTTLE_ROWS (soonest expires_at first, then oldest updated_at)
 *  - known_login_ips past the 30-day TTL
 *  - sessions past their absolute expiry, past their idle expiry, or revoked more than 7 days ago
 */
export async function reapExpired(pool: pg.Pool, opts: { idleDays?: number; batch?: number; maxThrottleRows?: number } = {}): Promise<ReapResult> {
  const batch = opts.batch ?? BATCH;
  const idle = opts.idleDays ?? 7;
  const t1 = await drain(batch, async () =>
    (await pool.query("DELETE FROM login_throttle WHERE key IN (SELECT key FROM login_throttle WHERE expires_at < now() LIMIT $1 FOR UPDATE SKIP LOCKED)", [batch])).rowCount,
  );
  const t2 = await drain(batch, async () =>
    (
      await pool.query(
        "DELETE FROM login_throttle WHERE key IN (SELECT key FROM login_throttle ORDER BY expires_at DESC, updated_at DESC, key OFFSET $1 LIMIT $2 FOR UPDATE SKIP LOCKED)",
        [opts.maxThrottleRows ?? MAX_THROTTLE_ROWS, batch],
      )
    ).rowCount,
  );
  const k = await drain(batch, async () =>
    (
      await pool.query(
        `DELETE FROM known_login_ips WHERE (user_id, ip_hash) IN
           (SELECT user_id, ip_hash FROM known_login_ips WHERE last_success_at < now() - make_interval(days => $1::int) LIMIT $2)`,
        [KNOWN_IP_TTL_DAYS, batch],
      )
    ).rowCount,
  );
  const s = await drain(batch, async () =>
    (
      await pool.query(
        `DELETE FROM sessions WHERE id IN (
           SELECT id FROM sessions
            WHERE expires_at < now()
               OR last_seen_at < now() - make_interval(days => $1::int + 1)
               OR revoked_at < now() - make_interval(days => $2::int)
            LIMIT $3)`,
        [idle, REVOKED_SESSION_KEEP_DAYS, batch],
      )
    ).rowCount,
  );
  return { throttle: t1 + t2, knownIps: k, sessions: s };
}

/** Runs reapExpired on a timer (errors are swallowed: cleanup must never take the server down). Returns a stop function. */
export function startMaintenance(pool: pg.Pool, opts: { intervalMs?: number; idleDays?: number } = {}): () => void {
  const timer = setInterval(() => void reapExpired(pool, { idleDays: opts.idleDays }).catch(() => undefined), opts.intervalMs ?? 10 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
