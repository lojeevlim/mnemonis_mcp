import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe as baseDescribe, expect, it } from "vitest";
import { reapExpired, startMaintenance } from "../src/auth/maintenance.js";
import { createSession } from "../src/auth/sessions.js";
import { rememberIp } from "../src/auth/throttle.js";
import { createPool } from "../src/db/pool.js";
import { TEST_DB_URL } from "./helpers.js";

const describe = baseDescribe.skipIf(!TEST_DB_URL);
const policy = { idleDays: 7, maxDays: 30 };

describe("reaping expired state (bounded cleanup job)", () => {
  let pool: Pool;
  const tag = randomUUID().slice(0, 8);
  const users: string[] = [];
  const keys: string[] = [];
  const newUser = async (name: string): Promise<string> => {
    const r = await pool.query<{ id: string }>("INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id", [`${name}-${tag}@maint-${tag}.example.test`, name]);
    users.push(r.rows[0]!.id);
    return r.rows[0]!.id;
  };
  const exists = async (table: string, col: string, val: unknown) => ((await pool.query(`SELECT 1 FROM ${table} WHERE ${col} = $1`, [val])).rowCount ?? 0) > 0;

  beforeAll(() => {
    pool = createPool({ connectionString: TEST_DB_URL });
  });
  afterAll(async () => {
    await pool.query("DELETE FROM login_throttle WHERE key = ANY($1::text[])", [keys]);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [users]);
    await pool.end();
  });

  it("deletes sessions past absolute expiry, past idle expiry, or revoked over 7 days ago, and keeps live and recently revoked ones", async () => {
    const uid = await newUser("sess");
    const mk = async () => (await createSession(pool, uid, policy))!.id;
    const [live, expired, idle, oldRevoked, freshRevoked] = [await mk(), await mk(), await mk(), await mk(), await mk()];
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [expired]);
    await pool.query("UPDATE sessions SET last_seen_at = now() - interval '9 days' WHERE id = $1", [idle]);
    await pool.query("UPDATE sessions SET revoked_at = now() - interval '8 days' WHERE id = $1", [oldRevoked]);
    await pool.query("UPDATE sessions SET revoked_at = now() - interval '2 days' WHERE id = $1", [freshRevoked]);
    await reapExpired(pool, { idleDays: 7, batch: 1000 }); // other test files may reap the same rows first, so assert on rows, not counts
    expect(await exists("sessions", "id", live)).toBe(true);
    expect(await exists("sessions", "id", freshRevoked)).toBe(true);
    for (const gone of [expired, idle, oldRevoked]) expect(await exists("sessions", "id", gone), gone).toBe(false);
  });

  it("deletes expired throttle rows and known-IP rows past their TTL, keeps live ones", async () => {
    const uid = await newUser("thr");
    const dead = `t:${tag}:dead`;
    const live = `t:${tag}:live`;
    keys.push(dead, live);
    await pool.query("INSERT INTO login_throttle (key, scope, subject, failures, expires_at) VALUES ($1, 'email', 's', 1, now() - interval '1 minute'), ($2, 'email', 's', 1, now() + interval '1 hour')", [dead, live]);
    await rememberIp(pool, uid, "192.0.2.10");
    await rememberIp(pool, uid, "192.0.2.11");
    await pool.query("UPDATE known_login_ips SET last_success_at = now() - interval '31 days' WHERE user_id = $1 AND ip_hash = (SELECT ip_hash FROM known_login_ips WHERE user_id = $1 ORDER BY ip_hash LIMIT 1)", [uid]);
    await reapExpired(pool); // counts are global (a concurrent reaper may win the race): the rows below are the assertion
    expect(await exists("login_throttle", "key", dead)).toBe(false);
    expect(await exists("login_throttle", "key", live)).toBe(true);
    expect(Number((await pool.query("SELECT count(*) AS n FROM known_login_ips WHERE user_id = $1", [uid])).rows[0].n)).toBe(1);
  });

  it("loops in batches until a batch comes back short, and the throttle row cap holds (soonest expires_at evicted first)", async () => {
    // Runs against its OWN login_throttle (a private schema first on the search_path of one dedicated connection), so rows that other
    // test files add or delete concurrently in public.login_throttle cannot change what the cap evicts. The other tables resolve to public.
    const schema = `maint_${tag}`;
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query("CREATE TABLE login_throttle (LIKE public.login_throttle INCLUDING ALL)");
      const own = { query: (...a: Parameters<Pool["query"]>) => client.query(...(a as Parameters<typeof client.query>)) } as unknown as Pool;
      const N = 30;
      const ks = Array.from({ length: N }, (_, i) => `t:${tag}:cap${i}`);
      for (const [i, k] of ks.entries()) {
        await client.query(
          "INSERT INTO login_throttle (key, scope, subject, failures, expires_at) VALUES ($1, 'email', $2, 1, now() + interval '2 minutes' + make_interval(secs => $3::int))",
          [k, `s:${tag}:${i}`, i],
        );
      }
      const r = await reapExpired(own, { maxThrottleRows: 10, batch: 4 }); // 20 excess rows need 5 batches of 4
      expect(r.throttle).toBe(20); // exactly the excess: it kept looping past the first batch and stopped on the short one
      const left = (await client.query<{ key: string }>("SELECT key FROM login_throttle")).rows.map((x) => x.key);
      expect(left.sort()).toEqual(ks.slice(N - 10).sort()); // the 10 latest-expiring rows survive; the soonest went first
      expect(Number((await pool.query("SELECT count(*) AS n FROM public.login_throttle WHERE key = ANY($1::text[])", [ks])).rows[0].n)).toBe(0); // public was never touched
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      client.release();
    }
  });

  it("startMaintenance runs on a timer, can be stopped, and swallows errors", async () => {
    const uid = await newUser("timer");
    const sid = (await createSession(pool, uid, policy))!.id;
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [sid]);
    const stop = startMaintenance(pool, { intervalMs: 20 });
    try {
      for (let i = 0; i < 100 && (await exists("sessions", "id", sid)); i++) await new Promise((r) => setTimeout(r, 20));
      expect(await exists("sessions", "id", sid)).toBe(false);
    } finally {
      stop();
    }
    const broken = createPool({ connectionString: "postgres://nobody:pw@127.0.0.1:1/none" });
    const stopBroken = startMaintenance(broken, { intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 60)); // no unhandled rejection
    stopBroken();
    await broken.end().catch(() => undefined);
  });

  it("login opportunistically reaps (at most once a minute per service)", async () => {
    const { startTestServer } = await import("./helpers.js");
    const s = await startTestServer();
    try {
      const sid = (await createSession(s.pool, s.a.id, policy))!.id;
      await s.pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [sid]);
      const r = await fetch(`${s.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: s.a.email, password: s.a.password }) });
      expect(r.status).toBe(200);
      for (let i = 0; i < 50 && (await exists("sessions", "id", sid)); i++) await new Promise((x) => setTimeout(x, 20));
      expect(await exists("sessions", "id", sid)).toBe(false);
    } finally {
      await s.close();
    }
  });
});
