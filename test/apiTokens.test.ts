import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createToken, hashToken, listTokens, mintToken, revokeToken, TOKEN_RE, verifyMcpToken } from "../src/auth/apiTokens.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

const url = process.env.TEST_DATABASE_URL;

describe("token format", () => {
  it("mints mn_ + 43 base64url chars, unique, and hashes to 32 bytes", () => {
    const a = mintToken();
    expect(a).toMatch(TOKEN_RE);
    expect(mintToken()).not.toBe(a);
    expect(hashToken(a)).toHaveLength(32);
  });

  it("wrong-shaped tokens never reach the database", async () => {
    const query = vi.fn();
    const fake = { query } as unknown as Pool;
    for (const t of ["", "mn_short", `mn_${"A".repeat(44)}`, `xx_${"A".repeat(43)}`, `mn_${"A".repeat(42)}!`, `${mintToken()}\n`]) {
      expect(await verifyMcpToken(fake, t)).toBeNull();
    }
    expect(query).not.toHaveBeenCalled();
  });
});

describe("revokeToken input validation", () => {
  it("rejects non-UUID ids without querying", async () => {
    const query = vi.fn();
    const fake = { query } as unknown as Pool;
    for (const id of ["-".repeat(36), "g".repeat(8) + "-0000-0000-0000-000000000000", "0".repeat(36), "", "00000000-0000-0000-0000-00000000000"]) {
      expect(await revokeToken(fake, "u", id)).toBe(false);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("verifyMcpToken propagates database errors instead of returning null", async () => {
    const fake = { query: vi.fn().mockRejectedValue(new Error("db down")) } as unknown as Pool;
    await expect(verifyMcpToken(fake, mintToken())).rejects.toThrow("db down");
  });

  it("strips bidi and zero-width characters from labels", async () => {
    const calls: unknown[][] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.startsWith("SELECT 1")) return { rowCount: 1, rows: [{}] };
        if (sql.startsWith("SELECT count")) return { rows: [{ n: 0 }] };
        if (sql.startsWith("INSERT")) {
          calls.push(params ?? []);
          return { rows: [{ id: "i", expires_at: new Date() }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const fake = { connect: async () => client } as unknown as Pool;
    const r = await createToken(fake, "u", { label: "\u202Elap\u200Btop\u2066\uFEFF" });
    expect(r).toMatchObject({ ok: true, label: "laptop" });
    expect(calls[0]![3]).toBe("laptop");
  });
});

describe.skipIf(!url)("api tokens (postgres)", () => {
  let pool: Pool;
  const userIds: string[] = [];

  async function newUser(disabled = false): Promise<string> {
    const id = randomUUID();
    await pool.query("INSERT INTO users (id, email, display_name, disabled_at) VALUES ($1, $2, 'Tok User', $3)", [id, `${id}@example.test`, disabled ? new Date() : null]);
    userIds.push(id);
    return id;
  }
  async function mk(userId: string, label = "laptop") {
    const r = await createToken(pool, userId, { label });
    if (!r.ok) throw new Error("create failed");
    return r;
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url });
    await migrate(pool);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
    await pool.end();
  });

  it("create, verify, list, revoke lifecycle", async () => {
    const uid = await newUser();
    const t = await mk(uid, "  my\u0007 laptop\n ");
    expect(t.token).toMatch(TOKEN_RE);
    expect(t.label).toBe("my laptop");
    expect(await verifyMcpToken(pool, t.token)).toEqual({ tokenId: t.id, userId: uid, displayName: "Tok User" });

    const list = await listTokens(pool, uid);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: t.id, label: "my laptop", revokedAt: null });
    expect(JSON.stringify(list)).not.toContain(t.token);
    expect(Object.keys(list[0]!)).not.toContain("tokenHash");
    const days = (t.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);

    expect(await revokeToken(pool, uid, t.id)).toBe(true);
    expect(await verifyMcpToken(pool, t.token)).toBeNull(); // immediate
    expect(await revokeToken(pool, uid, t.id)).toBe(false); // idempotent
    expect(await revokeToken(pool, uid, "not-a-uuid")).toBe(false);
    expect(await revokeToken(pool, uid, "-".repeat(36))).toBe(false);
    expect(await revokeToken(pool, uid, "0".repeat(8) + "-----------------------------")).toBe(false);
    expect((await listTokens(pool, uid))[0]!.revokedAt).not.toBeNull();
  });

  it("stores only the hash, never the plaintext", async () => {
    const uid = await newUser();
    const t = await mk(uid);
    const row = (await pool.query("SELECT * FROM api_tokens WHERE id = $1", [t.id])).rows[0];
    expect(Buffer.compare(row.token_hash, hashToken(t.token))).toBe(0);
    expect(JSON.stringify(row)).not.toContain(t.token);
    expect(row.kind).toBe("mcp");
  });

  it("rejects expired tokens", async () => {
    const uid = await newUser();
    const t = await mk(uid);
    await pool.query("UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1", [t.id]);
    expect(await verifyMcpToken(pool, t.token)).toBeNull();
  });

  it("rejects tokens of disabled users", async () => {
    const uid = await newUser();
    const t = await mk(uid);
    await pool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [uid]);
    expect(await verifyMcpToken(pool, t.token)).toBeNull();
    const dis = await newUser(true);
    expect(await createToken(pool, dis, { label: "x" })).toEqual({ ok: false, reason: "invalid" });
  });

  it("cross-user revoke does not revoke", async () => {
    const a = await newUser();
    const b = await newUser();
    const t = await mk(a);
    expect(await revokeToken(pool, b, t.id)).toBe(false);
    expect(await verifyMcpToken(pool, t.token)).not.toBeNull();
  });

  it("unknown well-formed tokens are rejected; web-kind tokens are not accepted", async () => {
    expect(await verifyMcpToken(pool, mintToken())).toBeNull();
    const uid = await newUser();
    const tok = mintToken();
    await pool.query("INSERT INTO api_tokens (user_id, kind, token_hash) VALUES ($1, 'web', $2)", [uid, hashToken(tok)]);
    expect(await verifyMcpToken(pool, tok)).toBeNull();
  });

  it("verifyMcpToken throws on a closed pool (infrastructure error, not a credential refusal)", async () => {
    const uid = await newUser();
    const t = await mk(uid);
    const p2 = createPool({ connectionString: url });
    await p2.end();
    await expect(verifyMcpToken(p2, t.token)).rejects.toThrow();
  });

  it("validates label and expiry, and enforces the active cap (even concurrently)", async () => {
    const uid = await newUser();
    for (const o of [{ label: "" }, { label: " \n " }, { label: "x".repeat(81) }, { label: "a", expiresInDays: 0 }, { label: "a", expiresInDays: 366 }, { label: "a", expiresInDays: 1.5 }]) {
      expect(await createToken(pool, uid, o)).toEqual({ ok: false, reason: "invalid" });
    }
    expect((await createToken(pool, uid, { label: "x".repeat(80), expiresInDays: 365 })).ok).toBe(true);

    const capped = await newUser();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => createToken(pool, capped, { label: `t${i}`, maxActive: 3 })));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "limit")).toBe(true);
    // revoking frees a slot
    const first = results.find((r) => r.ok)!;
    if (first.ok) await revokeToken(pool, capped, first.id);
    expect((await createToken(pool, capped, { label: "again", maxActive: 3 })).ok).toBe(true);
  });

  it("updates last_used_at at most once per interval", async () => {
    const uid = await newUser();
    const t = await mk(uid);
    const lastUsed = async () => (await pool.query("SELECT last_used_at FROM api_tokens WHERE id = $1", [t.id])).rows[0].last_used_at as Date | null;
    await verifyMcpToken(pool, t.token);
    await vi.waitFor(async () => expect(await lastUsed()).not.toBeNull());
    await pool.query("UPDATE api_tokens SET last_used_at = NULL WHERE id = $1", [t.id]);
    await verifyMcpToken(pool, t.token);
    await new Promise((r) => setTimeout(r, 100));
    expect(await lastUsed()).toBeNull(); // throttled
  });
});
