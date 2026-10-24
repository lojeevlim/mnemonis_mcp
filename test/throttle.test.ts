import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe as baseDescribe, expect, it } from "vitest";
import { clearForUserTx, clearKeys, emailHash, lockedFor, recordFailure, refundAttempt, reserveAttempt, SOFT, softKey, STRICT, strictKey, THROTTLE_LOCK_CLASS, ThrottleBusyError } from "../src/auth/throttle.js";
import { reapExpired } from "../src/auth/maintenance.js";
import { createPool } from "../src/db/pool.js";
import { TEST_DB_URL } from "./helpers.js";

const describe = baseDescribe.skipIf(!TEST_DB_URL);

describe("login throttle store", () => {
  let pool: Pool;
  const tag = randomUUID().slice(0, 8);
  const subjects: string[] = [];
  const mk = (name: string) => {
    const eh = emailHash(`${name}-${tag}@throttle.example.test`);
    subjects.push(eh);
    return eh;
  };
  beforeAll(() => {
    pool = createPool({ connectionString: TEST_DB_URL });
  });
  afterAll(async () => {
    await pool.query("DELETE FROM login_throttle WHERE subject = ANY($1::text[])", [subjects]);
    await pool.end();
  });

  it("the soft counter restarts once its lock lapses: a lapsed lock is not re-armed by a single further failure", async () => {
    const k = softKey(mk("decay"));
    for (let i = 0; i < SOFT.after; i++) await recordFailure(pool, k, SOFT);
    expect((await lockedFor(pool, [k])).get(k.key)).toBeGreaterThan(0);
    // still locked: the failure counter has not decayed yet
    await pool.query("UPDATE login_throttle SET updated_at = now() - interval '30 seconds', locked_until = now() + interval '30 seconds' WHERE key = $1", [k.key]);
    await recordFailure(pool, k, SOFT);
    expect((await pool.query("SELECT failures FROM login_throttle WHERE key = $1", [k.key])).rows[0].failures).toBe(SOFT.after + 1);
    // the lock has lapsed: the next failure starts over at 1 and does not lock
    await pool.query("UPDATE login_throttle SET updated_at = now() - make_interval(secs => $2::int + 1), locked_until = now() - interval '1 second' WHERE key = $1", [k.key, SOFT.base]);
    expect((await lockedFor(pool, [k])).size).toBe(0);
    await recordFailure(pool, k, SOFT);
    const row = (await pool.query("SELECT failures, locked_until FROM login_throttle WHERE key = $1", [k.key])).rows[0];
    expect(row.failures).toBe(1);
    expect(row.locked_until.getTime()).toBeLessThan(Date.now());
    expect((await lockedFor(pool, [k])).size).toBe(0);
  });

  it("writers that lock the same keys in opposite orders (reserve, refund, clear, clear-for-user, reaper) never deadlock", async () => {
    const eh = mk("order");
    const a = softKey(eh);
    const b = strictKey(eh, "198.51.100.7");
    const ctx = `order-${tag}`;
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      const ab = i % 2 === 0;
      const keys = ab ? [{ key: a, schedule: SOFT, enforce: false }, { key: b, schedule: STRICT, enforce: false }] : [{ key: b, schedule: STRICT, enforce: false }, { key: a, schedule: SOFT, enforce: false }];
      jobs.push(reserveAttempt(pool, keys));
      jobs.push(refundAttempt(pool, ab ? [a, b] : [b, a]));
      jobs.push(clearKeys(pool, ab ? [b, a] : [a, b]));
      jobs.push(
        (async () => {
          const c = await pool.connect();
          try {
            await c.query("BEGIN");
            await c.query("SET LOCAL lock_timeout = '5s'");
            await clearForUserTx(c, `${ctx}@throttle.example.test`, "00000000-0000-0000-0000-000000000000");
            await c.query("COMMIT");
          } catch (e) {
            await c.query("ROLLBACK").catch(() => undefined);
            throw e;
          } finally {
            c.release();
          }
        })(),
      );
      if (i % 8 === 0) jobs.push(reapExpired(pool, { batch: 10 }));
    }
    const results = await Promise.allSettled(jobs);
    const failures = results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason as Error);
    expect(failures.map((f) => f.message)).toEqual([]); // no 40P01 and no lock timeout
  }, 30_000);

  it("a lock that is held too long surfaces as ThrottleBusyError (not a hang), and the held key is untouched", async () => {
    const k = softKey(mk("held"));
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [THROTTLE_LOCK_CLASS, k.key]);
      const t0 = Date.now();
      await expect(reserveAttempt(pool, [{ key: k, schedule: SOFT, enforce: true }])).rejects.toBeInstanceOf(ThrottleBusyError);
      expect(Date.now() - t0).toBeLessThan(6000);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    expect((await pool.query("SELECT 1 FROM login_throttle WHERE key = $1", [k.key])).rowCount).toBe(0);
    expect(await reserveAttempt(pool, [{ key: k, schedule: SOFT, enforce: true }])).toBeNull(); // usable again
  }, 15_000);
});
