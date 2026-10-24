import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JwtClaims } from "../src/auth/jwt.js";
import { createJwtVerifier } from "../src/auth/jwt.js";
import { createUserDirectory, sanitizeDisplayName } from "../src/auth/users.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { PgStore } from "../src/store/pgStore.js";
import { AUDIENCE, ISSUER, makeKey, resolverFor, signToken } from "./jwtFixtures.js";

const url = process.env.TEST_DATABASE_URL;

describe("sanitizeDisplayName", () => {
  it("prefers full_name, then name, then email local part; strips control chars; clips to 100; never empty", () => {
    expect(sanitizeDisplayName({ fullName: "Ann", name: "B" }, "x@y.test")).toBe("Ann");
    expect(sanitizeDisplayName({ name: "Bob" }, "x@y.test")).toBe("Bob");
    expect(sanitizeDisplayName({}, "carol@y.test")).toBe("carol");
    expect(sanitizeDisplayName({ fullName: "A\u0000n\nn" }, "x@y.test")).toBe("Ann");
    expect(sanitizeDisplayName({ fullName: "Ann\u202E" }, "x@y.test")).toBe("Ann");
    expect(sanitizeDisplayName({ fullName: "\u202Aa\u202Bb\u202Cc\u202Dd\u202Ee\u2066f\u2067g\u2068h\u2069i" }, "x@y.test")).toBe("abcdefghi");
    expect(sanitizeDisplayName({ fullName: "a\u200Bb\u200Cc\u200Dd\u2060e\uFEFFf\u2028g\u2029h" }, "x@y.test")).toBe("abcdefgh");
    expect(sanitizeDisplayName({ fullName: "\u202E\u200B" }, "eve\u202E@y.test")).toBe("eve");
    expect(sanitizeDisplayName({ fullName: " \n\t " }, "dave@y.test")).toBe("dave");
    expect([...sanitizeDisplayName({ fullName: "é".repeat(300) }, "x@y.test")]).toHaveLength(100);
    expect(sanitizeDisplayName({}, "@y.test")).toBe("User");
  });
});

describe.skipIf(!url)("user directory (postgres)", () => {
  let pool: Pool;
  let store: PgStore;
  const tag = randomUUID().slice(0, 8);
  const dom = `${tag}.example.test`;
  const emails: string[] = [];

  const claims = (over: Partial<JwtClaims> = {}): JwtClaims => {
    const email = `u-${randomUUID().slice(0, 8)}@${dom}`;
    emails.push(email);
    return { sub: `sub-${randomUUID()}`, email, emailVerified: true, ...over };
  };
  const dir = (signupMode: "closed" | "allowlist" | "open", allowedEmails: string[] = []) => createUserDirectory(pool, store, { signupMode, allowedEmails });
  const count = async (sql: string, p: unknown[]) => Number((await pool.query(sql, p)).rows[0].n);

  beforeAll(async () => {
    pool = createPool({ connectionString: url });
    store = new PgStore(pool);
    await migrate(pool);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE lower(email) LIKE $1", [`%@${dom}`]);
    await pool.end();
  });

  it("provisions a user and workspace on first sight, then reuses them", async () => {
    const c = claims({ email: `  Mixed.Case@${dom}  `, fullName: "Mixed Case" });
    const d = dir("open");
    const a = await d.resolveJwtUser(c);
    expect(a).toMatchObject({ displayName: "Mixed Case" });
    expect((await pool.query("SELECT email FROM users WHERE id = $1", [a!.userId])).rows[0].email).toBe(`mixed.case@${dom}`);
    expect(await count("SELECT count(*) n FROM workspaces WHERE user_id = $1", [a!.userId])).toBe(1);
    expect(await d.resolveJwtUser(c)).toEqual(a);
    expect(await count("SELECT count(*) n FROM users WHERE auth_subject = $1", [c.sub])).toBe(1);
  });

  it("open mode also requires a verified email", async () => {
    const c = claims();
    const d = dir("open");
    expect(await d.resolveJwtUser({ ...c, emailVerified: false })).toBeNull();
    expect(await count("SELECT count(*) n FROM users WHERE auth_subject = $1", [c.sub])).toBe(0);
    expect(await d.resolveJwtUser(c)).not.toBeNull();
  });

  it("allowlist denies an email verified only via user_metadata (no top-level claim)", async () => {
    const key = await makeKey("u1");
    const verifier = createJwtVerifier(
      { authIssuer: ISSUER, authJwksUrl: "https://test.example/jwks", authAudience: AUDIENCE, authAlgs: ["ES256"] },
      { keyResolver: resolverFor(key) },
    );
    const email = `m-${randomUUID().slice(0, 8)}@${dom}`;
    emails.push(email);
    const d = dir("allowlist", [email]);
    const sub = `sub-${randomUUID()}`;
    const viaMeta = await verifier.verify(await signToken(key, { sub, email, user_metadata: { email_verified: true } }));
    expect(viaMeta?.emailVerified).toBe(false);
    expect(await d.resolveJwtUser(viaMeta!)).toBeNull();
    const viaTop = await verifier.verify(await signToken(key, { sub, email, email_verified: true }));
    expect(await d.resolveJwtUser(viaTop!)).not.toBeNull();
  });

  it("falls back to the email local part for the display name", async () => {
    const c = claims({ email: `local.part@${dom}` });
    expect((await dir("open").resolveJwtUser(c))!.displayName).toBe("local.part");
  });

  it("20 concurrent first requests create exactly one user and one workspace", async () => {
    const c = claims();
    const d = dir("open");
    const res = await Promise.all(Array.from({ length: 20 }, () => d.resolveJwtUser(c)));
    expect(res.every((r) => r !== null && r.userId === res[0]!.userId)).toBe(true);
    expect(await count("SELECT count(*) n FROM users WHERE auth_subject = $1", [c.sub])).toBe(1);
    expect(await count("SELECT count(*) n FROM workspaces WHERE user_id = $1", [res[0]!.userId])).toBe(1);
  });

  it("refuses to link a different subject with the same email", async () => {
    const first = claims();
    const d = dir("open");
    const a = await d.resolveJwtUser(first);
    const second: JwtClaims = { sub: `sub-${randomUUID()}`, email: first.email!.toUpperCase(), emailVerified: true };
    expect(await d.resolveJwtUser(second)).toBeNull();
    expect(await count("SELECT count(*) n FROM users WHERE auth_subject = $1", [second.sub])).toBe(0);
    expect((await pool.query("SELECT auth_subject FROM users WHERE id = $1", [a!.userId])).rows[0].auth_subject).toBe(first.sub);
  });

  it("closed mode provisions nobody but still serves existing users", async () => {
    const c = claims();
    expect(await dir("closed").resolveJwtUser(c)).toBeNull();
    expect(await count("SELECT count(*) n FROM users WHERE auth_subject = $1", [c.sub])).toBe(0);
    const a = await dir("open").resolveJwtUser(c);
    expect(await dir("closed").resolveJwtUser(c)).toEqual(a);
  });

  it("allowlist mode requires a verified, matching email (exact or @domain)", async () => {
    const exact = claims();
    const d = dir("allowlist", [exact.email!, "@other.example.test"]);
    expect(await d.resolveJwtUser({ ...exact, emailVerified: false })).toBeNull();
    expect(await d.resolveJwtUser(claims())).toBeNull(); // not listed
    expect(await d.resolveJwtUser(exact)).not.toBeNull();
    const byDomain = claims();
    expect(await dir("allowlist", [`@${dom}`]).resolveJwtUser(byDomain)).not.toBeNull();
    expect(await dir("allowlist", [`@x${dom}`]).resolveJwtUser(claims())).toBeNull(); // suffix must not match
  });

  it("requires a sane email for provisioning", async () => {
    const d = dir("open");
    expect(await d.resolveJwtUser({ sub: `sub-${randomUUID()}`, emailVerified: true })).toBeNull();
    expect(await d.resolveJwtUser({ sub: `sub-${randomUUID()}`, email: "   ", emailVerified: true })).toBeNull();
    expect(await d.resolveJwtUser({ sub: `sub-${randomUUID()}`, email: "not-an-email", emailVerified: true })).toBeNull();
    expect(await d.resolveJwtUser({ sub: `sub-${randomUUID()}`, email: `${"a".repeat(250)}@${dom}`, emailVerified: true })).toBeNull();
    for (const bad of ["a\u202Eb", "a\u200Bb", "a\u0000b", "a\nb", "a\u2028b", "a\u2066b", "a\uFEFFb"]) {
      for (let i = 0; i < 2; i++) expect(await d.resolveJwtUser({ sub: `sub-${randomUUID()}`, email: `${bad}@${dom}`, emailVerified: true })).toBeNull();
    }
  });

  it("returns null for disabled users", async () => {
    const c = claims();
    const a = await dir("open").resolveJwtUser(c);
    await pool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [a!.userId]);
    expect(await dir("open").resolveJwtUser(c)).toBeNull();
  });

  it("throws (does not return null) on database errors", async () => {
    const p2 = createPool({ connectionString: url });
    const d2 = createUserDirectory(p2, new PgStore(p2), { signupMode: "open", allowedEmails: [] });
    await p2.end(); // closed pool: every query rejects
    await expect(d2.resolveJwtUser(claims())).rejects.toThrow();
  });

  it("self-heals a user whose workspace is missing", async () => {
    const c = claims();
    const d = dir("open");
    const a = await d.resolveJwtUser(c);
    await pool.query("DELETE FROM workspaces WHERE user_id = $1", [a!.userId]);
    expect(await d.resolveJwtUser(c)).toEqual(a);
    expect(await count("SELECT count(*) n FROM workspaces WHERE user_id = $1", [a!.userId])).toBe(1);
  });
});
