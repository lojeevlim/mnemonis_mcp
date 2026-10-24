import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe as baseDescribe, expect, it } from "vitest";
import {
  createSession,
  hashSession,
  mintSession,
  revokeSession,
  revokeUserSessions,
  SESSION_RE,
  TOUCH_INTERVAL_MS,
  verifySession,
} from "../src/auth/sessions.js";
import { createPool } from "../src/db/pool.js";
import { TEST_DB_URL } from "./helpers.js";

const describe = baseDescribe.skipIf(!TEST_DB_URL);
const policy = { idleDays: 7, maxDays: 30 };

describe("sessions (postgres)", () => {
  let pool: Pool;
  const tag = randomUUID().slice(0, 8);
  const users: string[] = [];

  const newUser = async (name: string, disabled = false): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      "INSERT INTO users (email, display_name, disabled_at) VALUES ($1, $2, $3) RETURNING id",
      [`${name}-${tag}@sessions-${tag}.example.test`, name, disabled ? new Date() : null],
    );
    users.push(r.rows[0]!.id);
    return r.rows[0]!.id;
  };
  const row = async (id: string) => (await pool.query("SELECT * FROM sessions WHERE id = $1", [id])).rows[0];

  beforeAll(() => {
    pool = createPool({ connectionString: TEST_DB_URL });
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [users]); // cascades sessions
    await pool.end();
  });

  it("mints ms_ tokens (43 base64url chars) distinct from mn_ and stores only the sha256", async () => {
    expect(mintSession()).toMatch(SESSION_RE);
    expect(mintSession()).not.toBe(mintSession());
    const uid = await newUser("shape");
    const s = (await createSession(pool, uid, policy, "UA"))!;
    expect(s.token).toMatch(SESSION_RE);
    const r = await row(s.id);
    expect(Buffer.compare(r.token_hash, hashSession(s.token))).toBe(0);
    expect((await pool.query("SELECT s::text AS dump FROM sessions s WHERE id = $1", [s.id])).rows[0].dump).not.toContain(s.token);
    const p = (await verifySession(pool, s.token, policy))!;
    expect(p).toMatchObject({ sessionId: s.id, userId: uid, displayName: "shape" });
    expect(p.email).toContain(`shape-${tag}@`);
  });

  it("truncates and cleans the stored user agent", async () => {
    const uid = await newUser("ua");
    const s = (await createSession(pool, uid, policy, `${"x".repeat(300)}\n\u0000evil`))!;
    const ua = (await row(s.id)).user_agent as string;
    expect(ua.length).toBe(200);
    expect([...ua].some((ch) => ch.charCodeAt(0) < 32)).toBe(false);
    expect((await row((await createSession(pool, uid, policy))!.id)).user_agent).toBeNull();
  });

  it("applies the absolute expiry (expires_at) and reports min(idle, absolute) as the session end", async () => {
    const uid = await newUser("abs");
    const s = (await createSession(pool, uid, { idleDays: 7, maxDays: 30 }))!;
    const abs = (await row(s.id)).expires_at as Date;
    expect(abs.getTime() - Date.now()).toBeGreaterThan(29.9 * 86_400_000);
    expect(s.expiresAt.getTime() - Date.now()).toBeLessThan(7.01 * 86_400_000);
    // a short absolute lifetime wins over the idle window
    const short = (await createSession(pool, uid, { idleDays: 7, maxDays: 1 }))!;
    expect(short.expiresAt.getTime() - Date.now()).toBeLessThan(1.01 * 86_400_000);
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [s.id]);
    expect(await verifySession(pool, s.token, policy)).toBeNull();
  });

  it("expires after the idle window and slides while in use", async () => {
    const uid = await newUser("idle");
    const s = (await createSession(pool, uid, policy))!;
    await pool.query("UPDATE sessions SET last_seen_at = now() - interval '6 days' WHERE id = $1", [s.id]);
    const used = (await verifySession(pool, s.token, policy))!;
    expect(used).not.toBeNull();
    // last_seen was refreshed, so the session now ends ~7 days from NOW, not 1 day from the stale value
    expect(used.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(Date.now() - (await row(s.id)).last_seen_at.getTime()).toBeLessThan(10_000);

    await pool.query("UPDATE sessions SET last_seen_at = now() - interval '7 days 1 minute' WHERE id = $1", [s.id]);
    expect(await verifySession(pool, s.token, policy)).toBeNull();
    // and a stricter idle policy applies to existing sessions too
    const t = (await createSession(pool, uid, policy))!;
    await pool.query("UPDATE sessions SET last_seen_at = now() - interval '2 days' WHERE id = $1", [t.id]);
    expect(await verifySession(pool, t.token, { idleDays: 1 })).toBeNull();
  });

  it("throttles last_seen_at writes to once per minute", async () => {
    const uid = await newUser("throttle");
    const s = (await createSession(pool, uid, policy))!;
    const before = (await row(s.id)).last_seen_at as Date;
    await verifySession(pool, s.token, policy);
    await verifySession(pool, s.token, policy);
    expect((await row(s.id)).last_seen_at.getTime()).toBe(before.getTime()); // < 60s old: untouched
    const stale = new Date(Date.now() - TOUCH_INTERVAL_MS - 5_000);
    await pool.query("UPDATE sessions SET last_seen_at = $2 WHERE id = $1", [s.id, stale]);
    await verifySession(pool, s.token, policy);
    expect((await row(s.id)).last_seen_at.getTime()).toBeGreaterThan(stale.getTime() + 30_000);
  });

  it("revocation is immediate, idempotent and owner-scoped", async () => {
    const owner = await newUser("rev-owner");
    const other = await newUser("rev-other");
    const s = (await createSession(pool, owner, policy))!;
    expect(await revokeSession(pool, other, s.id)).toBe(false);
    expect(await verifySession(pool, s.token, policy)).not.toBeNull();
    expect(await revokeSession(pool, owner, s.id)).toBe(true);
    expect(await verifySession(pool, s.token, policy)).toBeNull();
    expect(await revokeSession(pool, owner, s.id)).toBe(false);
  });

  it("revokeUserSessions revokes all of a user's sessions, optionally sparing one, and never another user's", async () => {
    const uid = await newUser("revall");
    const other = await newUser("revall-other");
    const keep = (await createSession(pool, uid, policy))!;
    const a = (await createSession(pool, uid, policy))!;
    const b = (await createSession(pool, uid, policy))!;
    const theirs = (await createSession(pool, other, policy))!;
    expect(await revokeUserSessions(pool, uid, keep.id)).toBe(2);
    expect(await verifySession(pool, keep.token, policy)).not.toBeNull();
    expect(await verifySession(pool, a.token, policy)).toBeNull();
    expect(await verifySession(pool, b.token, policy)).toBeNull();
    expect(await verifySession(pool, theirs.token, policy)).not.toBeNull();
    expect(await revokeUserSessions(pool, uid)).toBe(1);
    expect(await verifySession(pool, keep.token, policy)).toBeNull();
  });

  it("caps active sessions per user: the oldest are revoked", async () => {
    const uid = await newUser("cap");
    const made: { id: string; token: string }[] = [];
    for (let i = 0; i < 12; i++) made.push((await createSession(pool, uid, { ...policy, maxActive: 10 }))!);
    const active = (await pool.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL", [uid])).rows[0].n;
    expect(active).toBe(10);
    for (const s of made.slice(0, 2)) expect(await verifySession(pool, s.token, policy)).toBeNull();
    for (const s of made.slice(2)) expect(await verifySession(pool, s.token, policy)).not.toBeNull();
  });

  it("the default cap is 10 and one user's cap never touches another's sessions", async () => {
    const a = await newUser("cap-a");
    const b = await newUser("cap-b");
    const bs = (await createSession(pool, b, policy))!;
    for (let i = 0; i < 11; i++) await createSession(pool, a, policy);
    expect((await pool.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL", [a])).rows[0].n).toBe(10);
    expect(await verifySession(pool, bs.token, policy)).not.toBeNull();
  });

  it("a disabled user cannot get or keep a session; a deleted user's sessions are gone", async () => {
    const uid = await newUser("dis");
    const s = (await createSession(pool, uid, policy))!;
    await pool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [uid]);
    expect(await verifySession(pool, s.token, policy)).toBeNull();
    expect(await createSession(pool, uid, policy)).toBeNull();
    await pool.query("UPDATE users SET disabled_at = NULL WHERE id = $1", [uid]);
    expect(await verifySession(pool, s.token, policy)).not.toBeNull();

    const gone = await newUser("gone");
    const g = (await createSession(pool, gone, policy))!;
    await pool.query("DELETE FROM users WHERE id = $1", [gone]);
    expect(await verifySession(pool, g.token, policy)).toBeNull();
    expect((await pool.query("SELECT 1 FROM sessions WHERE id = $1", [g.id])).rowCount).toBe(0);
    expect(await createSession(pool, randomUUID(), policy)).toBeNull();
  });

  it("malformed tokens are refused without touching the database", async () => {
    const broken = { query: () => { throw new Error("must not be called"); } } as unknown as Pool;
    for (const t of ["", "ms_", `mn_${"A".repeat(43)}`, `ms_${"A".repeat(42)}`, `ms_${"A".repeat(44)}`, `ms_${"!".repeat(43)}`, "a.b.c", undefined as unknown as string]) {
      expect(await verifySession(broken, t, policy), String(t)).toBeNull();
    }
  });

  it("purges long-finished sessions when the user creates a new one", async () => {
    const uid = await newUser("purge");
    const old = (await createSession(pool, uid, policy))!;
    await pool.query("UPDATE sessions SET expires_at = now() - interval '2 days' WHERE id = $1", [old.id]);
    await createSession(pool, uid, policy);
    expect(await row(old.id)).toBeUndefined();
  });
});
