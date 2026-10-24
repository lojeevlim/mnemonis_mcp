import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "./config.js";

const base = { DATABASE_URL: "postgres://u:s3cret@db/x", SUPABASE_URL: "https://abc.supabase.co" };

describe("parseConfig", () => {
  it("derives supabase issuer, jwks and audience with secure defaults", () => {
    const c = parseConfig(base);
    expect(c.authIssuer).toBe("https://abc.supabase.co/auth/v1");
    expect(c.authJwksUrl).toBe("https://abc.supabase.co/auth/v1/.well-known/jwks.json");
    expect(c.authAudience).toBe("authenticated");
    expect(c.authAlgs).toEqual(["ES256", "RS256", "EdDSA"]);
    expect(c).toMatchObject({ signupMode: "closed", maxMcpTokens: 20, trustProxy: false, autoMigrate: false, host: "127.0.0.1", port: 8787 });
  });

  it("strips a trailing slash and allows overrides", () => {
    const c = parseConfig({ ...base, SUPABASE_URL: "https://abc.supabase.co/", AUTH_AUDIENCE: "x" });
    expect(c.authIssuer).toBe("https://abc.supabase.co/auth/v1");
    expect(c.authAudience).toBe("x");
  });

  it("normalises SUPABASE_URL to its origin", () => {
    for (const u of ["https://abc.supabase.co/some/path/?q=1#f", "https://abc.supabase.co//", "https://abc.supabase.co/auth/v1"]) {
      const c = parseConfig({ ...base, SUPABASE_URL: u });
      expect(c.authIssuer).toBe("https://abc.supabase.co/auth/v1");
      expect(c.authJwksUrl).toBe("https://abc.supabase.co/auth/v1/.well-known/jwks.json");
    }
    expect(() => parseConfig({ ...base, SUPABASE_URL: "not a url" })).toThrowError(/SUPABASE_URL/);
  });

  it("validates MNEMONIS_ALLOWED_EMAILS entries without echoing them", () => {
    for (const bad of ["plainstring", "zq@", "@", "zq@b@c", "zq b@c.test", "@@zq.test"]) {
      try {
        parseConfig({ ...base, MNEMONIS_ALLOWED_EMAILS: `ok@x.test,${bad}` });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).toMatch(/MNEMONIS_ALLOWED_EMAILS/);
        expect((e as Error).message).not.toContain("zq");
      }
    }
    expect(parseConfig({ ...base, MNEMONIS_ALLOWED_EMAILS: "a@x.test,@y.test" }).allowedEmails).toEqual(["a@x.test", "@y.test"]);
  });

  it("requires all three auth settings without SUPABASE_URL", () => {
    expect(() => parseConfig({ DATABASE_URL: "postgres://x" })).toThrowError(/AUTH_ISSUER[\s\S]*AUTH_JWKS_URL[\s\S]*AUTH_AUDIENCE/);
    const c = parseConfig({ DATABASE_URL: "postgres://x", AUTH_ISSUER: "https://i", AUTH_JWKS_URL: "https://i/jwks", AUTH_AUDIENCE: "a" });
    expect(c.authIssuer).toBe("https://i");
  });

  it("requires DATABASE_URL", () => {
    expect(() => parseConfig({ SUPABASE_URL: base.SUPABASE_URL })).toThrowError(ConfigError);
  });

  it("refuses HS*, none and unknown algorithms", () => {
    for (const a of ["HS256", "none", "ES256,HS512", "foo"]) {
      expect(() => parseConfig({ ...base, AUTH_ALGS: a })).toThrowError(/AUTH_ALGS/);
    }
    expect(parseConfig({ ...base, AUTH_ALGS: "ES256, RS256" }).authAlgs).toEqual(["ES256", "RS256"]);
  });

  it("refuses plain http except loopback", () => {
    expect(() => parseConfig({ ...base, SUPABASE_URL: "http://abc.supabase.co" })).toThrowError(/https/);
    expect(() => parseConfig({ ...base, AUTH_JWKS_URL: "http://evil.test/jwks" })).toThrowError(/AUTH_JWKS_URL/);
    expect(() => parseConfig({ ...base, AUTH_ISSUER: "http://evil.test" })).toThrowError(/AUTH_ISSUER/);
    expect(parseConfig({ ...base, SUPABASE_URL: "http://127.0.0.1:54321" }).authIssuer).toBe("http://127.0.0.1:54321/auth/v1");
    expect(parseConfig({ ...base, SUPABASE_URL: "http://localhost:54321" }).authJwksUrl).toMatch(/^http:\/\/localhost/);
  });

  it("parses signup mode, allowlist and lists", () => {
    const c = parseConfig({
      ...base,
      MNEMONIS_SIGNUP_MODE: "allowlist",
      MNEMONIS_ALLOWED_EMAILS: "A@x.com, @Corp.io",
      MNEMONIS_ALLOWED_ORIGINS: "https://a.test, https://b.test",
      MNEMONIS_ALLOWED_HOSTS: "App.test",
      MNEMONIS_TRUST_PROXY: "true",
      MNEMONIS_AUTO_MIGRATE: "1",
      MNEMONIS_MAX_MCP_TOKENS: "5",
      PORT: "0",
    });
    expect(c.signupMode).toBe("allowlist");
    expect(c.allowedEmails).toEqual(["a@x.com", "@corp.io"]);
    expect(c.allowedOrigins).toEqual(["https://a.test", "https://b.test"]);
    expect(c.allowedHosts).toEqual(["app.test"]);
    expect(c.trustProxy).toBe(true);
    expect(c.autoMigrate).toBe(true);
    expect(c.maxMcpTokens).toBe(5);
    expect(c.port).toBe(0);
    expect(() => parseConfig({ ...base, MNEMONIS_SIGNUP_MODE: "allowlist" })).toThrowError(/ALLOWED_EMAILS/);
    expect(() => parseConfig({ ...base, MNEMONIS_SIGNUP_MODE: "bogus" })).toThrowError(/SIGNUP_MODE/);
    expect(parseConfig({ ...base, MNEMONIS_SIGNUP_MODE: "open" }).signupMode).toBe("open");
  });

  it("never prints secret values in errors", () => {
    for (const env of [
      { DATABASE_URL: "postgres://u:s3cret@db/x", PORT: "s3cret" },
      { ...base, AUTH_ALGS: "s3cret" },
      { ...base, AUTH_JWKS_URL: "http://s3cret.test/jwks" },
      { DATABASE_URL: "postgres://u:s3cret@db/x", SUPABASE_URL: "http://s3cret.test" },
    ]) {
      try {
        parseConfig(env);
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).not.toContain("s3cret");
      }
    }
  });
});
