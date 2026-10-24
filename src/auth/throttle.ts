import { createHash } from "node:crypto";
import type pg from "pg";

/**
 * Persistent login throttling (tables login_throttle and known_login_ips, migration 0004).
 *
 * Two locks guard a login, both stored under sha256 keys so unknown emails behave exactly like known ones, also after a restart:
 *  - SOFT (email only): after SOFT.after failures across ALL clients the email is locked for a fixed, short SOFT.base seconds
 *    (never escalated). The counter restarts as soon as that lock lapses (SOFT.decayS = the lock length), so an attacker who
 *    knows an email can keep it locked for unknown addresses only by sending SOFT.after fresh failures per lock period (not
 *    a trickle of one per minute); a correct password from an IP bucket that logged in to this account within
 *    KNOWN_IP_TTL_DAYS is never refused by it, so the real owner on a known address is not locked out at all.
 *  - STRICT (email + IP bucket): STRICT.after failures lock that pair for 60 s, doubling to 900 s. It only ever affects the
 *    client address that produced the failures.
 * Re-authentication (change password / delete account) uses a per-user strict-style backoff stored the same way.
 */
export interface Schedule {
  /** Failures before the first lock. */
  after: number;
  /** First lock length (seconds), doubled per further failure. */
  base: number;
  /** Lock length cap (seconds). */
  max: number;
  /** A failure counter that has been idle this long (seconds) restarts at 1. 0 = never decays. */
  decayS: number;
  /** Rows are reaped this long (seconds) after their last failure. */
  ttlS: number;
}

export const SOFT: Schedule = { after: 10, base: 60, max: 60, decayS: 60, ttlS: 3600 };
export const STRICT: Schedule = { after: 5, base: 60, max: 900, decayS: 0, ttlS: 86_400 };

/** Seconds of a lock after `failures` failures under a schedule (0 = not locked). Mirrors the SQL in recordFailure. */
export const lockSecondsFor = (failures: number, s: Schedule = STRICT): number =>
  failures < s.after ? 0 : Math.min(s.max, s.base * 2 ** Math.min(failures - s.after, 10));

export const KNOWN_IP_TTL_DAYS = 30;
export const MAX_KNOWN_IPS_PER_USER = 20;
const KNOWN_IP_REFRESH_S = 3600;

const sha256hex = (...parts: string[]): string => createHash("sha256").update(parts.join("\u0000")).digest("hex");

/** Hash of a normalized email (the throttle subject). An unusable email is hashed from its raw text (capped) under a separate prefix, so it never shares a bucket with other input. */
export const emailHash = (email: string): string => sha256hex("mnemonis-login", email);

export interface ThrottleKey {
  key: string;
  scope: "email" | "email_ip" | "reauth";
  subject: string;
}

export const softKey = (eh: string): ThrottleKey => ({ key: `e:${eh}`, scope: "email", subject: eh });
export const strictKey = (eh: string, ipBucket: string): ThrottleKey => ({ key: `ei:${sha256hex(eh, ipBucket)}`, scope: "email_ip", subject: eh });
export const reauthKey = (userId: string): ThrottleKey => ({ key: `r:${sha256hex("mnemonis-reauth", userId)}`, scope: "reauth", subject: userId });

type Queryable = Pick<pg.Pool, "query">;

/** The throttle store is momentarily unavailable (deadlock or lock timeout): the HTTP layer answers 503 with Retry-After, never a verdict about the password. */
export class ThrottleBusyError extends Error {
  constructor() {
    super("Login throttle busy");
    this.name = "ThrottleBusyError";
  }
}

const LOCK_TIMEOUT = "2s";
/** First key of the two-int advisory lock: a keyspace of its own (the single-bigint form used elsewhere, e.g. user creation, is a different keyspace). */
export const THROTTLE_LOCK_CLASS = 726_104;

/**
 * Takes the advisory locks of the given throttle keys inside the open transaction, in ascending order of their hashtext value
 * (so two writers always lock in the same order, and a 32-bit collision cannot invert it: equal values are one lock).
 * EVERY writer of login_throttle rows takes these locks first, then touches rows, so row locks can never form a cycle.
 */
async function lockKeys(client: Queryable, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const hs = await client.query<{ h: number }>("SELECT DISTINCT hashtext(k) AS h FROM unnest($1::text[]) AS k ORDER BY h", [keys]);
  for (const { h } of hs.rows) await client.query("SELECT pg_advisory_xact_lock($1::int, $2::int)", [THROTTLE_LOCK_CLASS, h]);
}

const isBusy = (e: unknown): boolean => {
  const code = (e as { code?: string } | null)?.code;
  return code === "40P01" || code === "55P03"; // deadlock_detected, lock_not_available (lock_timeout)
};

/** Short transaction with a lock timeout. Deadlocks and lock timeouts become ThrottleBusyError; a failed ROLLBACK discards the connection. */
async function inTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK").catch((re: unknown) => {
      broken = re instanceof Error ? re : new Error("rollback failed");
    });
    throw isBusy(e) ? new ThrottleBusyError() : e;
  } finally {
    client.release(broken);
  }
}

/** Seconds until each given key may be tried again (only locked keys are present). */
export async function lockedFor(db: Queryable, keys: ThrottleKey[]): Promise<Map<string, number>> {
  const r = await db.query<{ key: string; wait: number }>(
    `SELECT key, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (locked_until - now()))))::int AS wait
       FROM login_throttle WHERE key = ANY($1::text[]) AND locked_until > now() AND expires_at > now()`,
    [keys.map((k) => k.key)],
  );
  return new Map(r.rows.map((x) => [x.key, x.wait]));
}

/** Counts one failure for the key and (re)computes its lock. */
export async function recordFailure(db: Queryable, k: ThrottleKey, s: Schedule): Promise<void> {
  await db.query(
    `INSERT INTO login_throttle (key, scope, subject, failures, expires_at)
     VALUES ($1, $2, $3, 1, now() + make_interval(secs => $4::int))
     ON CONFLICT (key) DO UPDATE SET
       failures = CASE WHEN $5::int > 0 AND login_throttle.updated_at < now() - make_interval(secs => $5::int)
                       THEN 1 ELSE login_throttle.failures + 1 END,
       updated_at = now(),
       expires_at = now() + make_interval(secs => $4::int)`,
    [k.key, k.scope, k.subject, s.ttlS, s.decayS],
  );
  await db.query(
    `UPDATE login_throttle
        SET locked_until = CASE WHEN failures >= $2::int
              THEN now() + make_interval(secs => LEAST($4::int, $3::int * power(2, LEAST(failures - $2::int, 10)))::int)
              ELSE locked_until END
      WHERE key = $1`,
    [k.key, s.after, s.base, s.max],
  );
}

export interface AttemptKey {
  key: ThrottleKey;
  schedule: Schedule;
  /** False = the key is counted but its lock does not refuse this attempt (the soft lock for a known-good IP). */
  enforce: boolean;
}

/**
 * Count-before-verify: atomically checks the locks and, when none refuses, counts this attempt as a failure on every key
 * (so concurrent guesses cannot all pass the lock check before the first failure is recorded). The caller verifies the
 * password afterwards and calls clearKeys on success; a wrong password needs no further bookkeeping.
 * A short transaction serialized per key by an advisory lock; it is never held across the (slow) password hash.
 * Returns the wait in seconds when an enforced lock refuses the attempt (nothing is counted then), else null.
 */
export async function reserveAttempt(pool: pg.Pool, keys: AttemptKey[]): Promise<number | null> {
  return inTx(pool, async (client) => {
    await lockKeys(client, keys.map((k) => k.key.key));
    const waits = await lockedFor(client, keys.map((k) => k.key));
    for (const k of keys) {
      const wait = k.enforce ? waits.get(k.key.key) : undefined;
      if (wait) return wait; // nothing written: the transaction just ends
    }
    for (const k of keys) await recordFailure(client, k.key, k.schedule);
    return null;
  });
}

/** Gives back one reserved attempt (the password check never ran, e.g. the hasher was busy): that is not a client failure. */
export async function refundAttempt(pool: pg.Pool, keys: ThrottleKey[]): Promise<void> {
  const ks = keys.map((k) => k.key);
  await inTx(pool, async (client) => {
    await lockKeys(client, ks);
    await client.query("UPDATE login_throttle SET failures = GREATEST(failures - 1, 0) WHERE key = ANY($1::text[])", [ks]);
  });
}

export async function clearKeys(pool: pg.Pool, keys: ThrottleKey[]): Promise<void> {
  const ks = keys.map((k) => k.key);
  await inTx(pool, async (client) => {
    await lockKeys(client, ks);
    await client.query("DELETE FROM login_throttle WHERE key = ANY($1::text[])", [ks]);
  });
}

/** Removes every throttle row of a user inside an OPEN transaction (it takes the row locks of the keys first, in the common order). */
export async function clearForUserTx(client: Queryable, email: string, userId: string): Promise<number> {
  const subjects = [emailHash(email), userId];
  const found = await client.query<{ key: string }>("SELECT key FROM login_throttle WHERE subject = ANY($1::text[])", [subjects]);
  await lockKeys(client, found.rows.map((r) => r.key));
  const r = await client.query("DELETE FROM login_throttle WHERE key = ANY($1::text[])", [found.rows.map((x) => x.key)]);
  return r.rowCount ?? 0;
}

/** Removes every throttle row of a user (all IPs and the reauth counter): operator unlock / reset. */
export async function clearForUser(pool: pg.Pool, email: string, userId: string): Promise<number> {
  return inTx(pool, (client) => clearForUserTx(client, email, userId));
}

const ipHash = (userId: string, bucket: string): Buffer => createHash("sha256").update(`mnemonis-ip\u0000${userId}\u0000${bucket}`).digest();

/** True when this IP bucket logged in successfully to this account within KNOWN_IP_TTL_DAYS. */
export async function isKnownIp(pool: pg.Pool, userId: string, bucket: string | null): Promise<boolean> {
  if (!bucket) return false;
  const r = await pool.query(
    "SELECT 1 FROM known_login_ips WHERE user_id = $1 AND ip_hash = $2 AND last_success_at > now() - make_interval(days => $3::int)",
    [userId, ipHash(userId, bucket), KNOWN_IP_TTL_DAYS],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Records a successful login from this bucket. Keeps at most MAX_KNOWN_IPS_PER_USER (newest) and drops entries past the TTL. */
export async function rememberIp(pool: pg.Pool, userId: string, bucket: string | null): Promise<void> {
  if (!bucket) return;
  await pool.query(
    `INSERT INTO known_login_ips (user_id, ip_hash) VALUES ($1, $2)
     ON CONFLICT (user_id, ip_hash) DO UPDATE SET last_success_at = now()
       WHERE known_login_ips.last_success_at < now() - make_interval(secs => $3::int)`,
    [userId, ipHash(userId, bucket), KNOWN_IP_REFRESH_S],
  );
  await pool.query(
    `DELETE FROM known_login_ips WHERE user_id = $1 AND (
       last_success_at < now() - make_interval(days => $3::int)
       OR ip_hash IN (SELECT ip_hash FROM known_login_ips WHERE user_id = $1 ORDER BY last_success_at DESC, ip_hash OFFSET $2))`,
    [userId, MAX_KNOWN_IPS_PER_USER, KNOWN_IP_TTL_DAYS],
  );
}

/** After a password change or reset no previously trusted address stays trusted. */
export async function forgetIps(pool: Queryable, userId: string): Promise<void> {
  await pool.query("DELETE FROM known_login_ips WHERE user_id = $1", [userId]);
}
