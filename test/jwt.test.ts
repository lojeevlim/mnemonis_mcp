import { errors, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createJwtVerifier, type JwtVerifier } from "../src/auth/jwt.js";
import { AUDIENCE, ISSUER, makeKey, resolverFor, signToken, unsignedToken, type TestKey } from "./jwtFixtures.js";

const cfg = { authIssuer: ISSUER, authJwksUrl: "https://test.example/jwks", authAudience: AUDIENCE, authAlgs: ["ES256", "RS256", "EdDSA"] };

describe("createJwtVerifier", () => {
  let key: TestKey;
  let other: TestKey;
  let v: JwtVerifier;

  beforeAll(async () => {
    key = await makeKey("k1");
    other = await makeKey("k1"); // same kid, different key pair
    v = createJwtVerifier(cfg, { keyResolver: resolverFor(key) });
  });

  it("accepts a valid token and maps claims", async () => {
    const t = await signToken(key, { sub: "u1", email: "a@b.test", email_verified: true, user_metadata: { full_name: "Ann" } });
    expect(await v.verify(t)).toEqual({ sub: "u1", email: "a@b.test", emailVerified: true, fullName: "Ann", name: undefined });
  });

  it("takes emailVerified only from the top-level claim, never user_metadata", async () => {
    const meta = await v.verify(await signToken(key, { sub: "u", email: "a@b.test", user_metadata: { email_verified: true } }));
    expect(meta?.emailVerified).toBe(false);
    expect((await v.verify(await signToken(key, { sub: "u", email: "a@b.test", email_verified: true })))?.emailVerified).toBe(true);
    expect((await v.verify(await signToken(key, { sub: "u", email: "a@b.test" })))?.emailVerified).toBe(false);
    // strict boolean only
    expect((await v.verify(await signToken(key, { sub: "u", email_verified: "true" })))?.emailVerified).toBe(false);
    expect((await v.verify(await signToken(key, { sub: "u", email_verified: 1 })))?.emailVerified).toBe(false);
  });

  it("requires the issuer to match exactly (a trailing slash is a different issuer)", async () => {
    expect(await v.verify(await signToken(key, { sub: "u" }, { issuer: `${ISSUER}/` }))).toBeNull();
    const slashed = createJwtVerifier({ ...cfg, authIssuer: `${ISSUER}/` }, { keyResolver: resolverFor(key) });
    expect(await slashed.verify(await signToken(key, { sub: "u" }))).toBeNull();
  });

  it("accepts other allowed algorithms", async () => {
    const rs = await makeKey("rs", "RS256");
    const ed = await makeKey("ed", "EdDSA");
    const vv = createJwtVerifier(cfg, { keyResolver: resolverFor(rs, ed) });
    expect((await vv.verify(await signToken(rs, { sub: "u" }, { alg: "RS256" })))?.sub).toBe("u");
    expect((await vv.verify(await signToken(ed, { sub: "u" }, { alg: "EdDSA" })))?.sub).toBe("u");
  });

  it("rejects expired, future nbf, wrong iss and wrong aud", async () => {
    expect(await v.verify(await signToken(key, { sub: "u" }, { exp: -60 }))).toBeNull();
    expect(await v.verify(await signToken(key, { sub: "u" }, { nbf: 600 }))).toBeNull();
    expect(await v.verify(await signToken(key, { sub: "u" }, { issuer: "https://evil.test/auth/v1" }))).toBeNull();
    expect(await v.verify(await signToken(key, { sub: "u" }, { audience: "other" }))).toBeNull();
  });

  it("rejects alg none", async () => {
    expect(await v.verify(unsignedToken({ sub: "u" }, "k1"))).toBeNull();
  });

  it("rejects HS256 alg confusion (public JWK used as HMAC secret)", async () => {
    const secret = new TextEncoder().encode(JSON.stringify(key.publicJwk));
    const now = Math.floor(Date.now() / 1000);
    const t = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setSubject("u")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(now + 300)
      .sign(secret);
    expect(await v.verify(t)).toBeNull();
    // even if HS256 were (mis)configured, an EC JWK cannot verify an HMAC token
    const loose = createJwtVerifier({ ...cfg, authAlgs: ["HS256", "ES256"] }, { keyResolver: resolverFor(key) });
    expect(await loose.verify(t)).toBeNull();
  });

  it("rejects a flipped signature character", async () => {
    const t = await signToken(key, { sub: "u" });
    const i = t.length - 5;
    const flipped = t.slice(0, i) + (t[i] === "A" ? "B" : "A") + t.slice(i + 1);
    expect(await v.verify(flipped)).toBeNull();
  });

  it("rejects unknown kid and tokens from another key pair", async () => {
    const unknown = await makeKey("nope");
    expect(await v.verify(await signToken(unknown, { sub: "u" }))).toBeNull();
    expect(await v.verify(await signToken(other, { sub: "u" }))).toBeNull();
  });

  it("rejects missing sub, empty/oversized sub, anonymous users and non-authenticated roles", async () => {
    expect(await v.verify(await signToken(key, {}, { omitSub: true }))).toBeNull();
    expect(await v.verify(await signToken(key, { sub: "" }, { omitSub: true }))).toBeNull();
    expect(await v.verify(await signToken(key, { sub: "x".repeat(129) }, { omitSub: true }))).toBeNull();
    expect(await v.verify(await signToken(key, { sub: "u", is_anonymous: true }))).toBeNull();
    expect(await v.verify(await signToken(key, { sub: "u", role: "anon" }))).toBeNull();
  });

  it("rejects oversized and malformed tokens", async () => {
    const t = await signToken(key, { sub: "u", pad: "x".repeat(9000) });
    expect(await v.verify(t)).toBeNull();
    for (const bad of ["", "abc", "a.b.c", "mn_" + "A".repeat(43)]) expect(await v.verify(bad)).toBeNull();
  });

  it("throws (not null) when the JWKS endpoint is unreachable, so callers can answer 503", async () => {
    const down = createJwtVerifier({ ...cfg, authJwksUrl: "http://127.0.0.1:1/jwks" });
    await expect(down.verify(await signToken(key, { sub: "u" }))).rejects.toBeInstanceOf(Error);
  });

  it("throws for key-source failures but returns null for credential failures", async () => {
    const infra: [string, JWTVerifyGetKey][] = [
      ["timeout", async () => { throw new errors.JWKSTimeout(); }],
      ["non-200 / generic", async () => { throw new errors.JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response"); }],
      ["invalid key set", async () => { throw new errors.JWKSInvalid("bad set"); }],
      ["invalid remote key", async () => { throw new errors.JWKInvalid("bad key"); }],
      ["network", async () => { throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }); }],
    ];
    const t = await signToken(key, { sub: "u" });
    for (const [name, keyResolver] of infra) {
      await expect(createJwtVerifier(cfg, { keyResolver }).verify(t), name).rejects.toBeDefined();
    }
    const refusals: [string, JWTVerifyGetKey][] = [
      ["unknown kid", async () => { throw new errors.JWKSNoMatchingKey(); }],
      ["multiple keys", async () => { throw new errors.JWKSMultipleMatchingKeys(); }],
      ["plain TypeError", async () => { throw new TypeError("malformed"); }],
    ];
    for (const [name, keyResolver] of refusals) {
      expect(await createJwtVerifier(cfg, { keyResolver }).verify(t), name).toBeNull();
    }
    // a real unknown kid against a real key set stays a refusal
    expect(await createJwtVerifier(cfg, { keyResolver: resolverFor(await makeKey("other-kid")) }).verify(t)).toBeNull();
  });
});
