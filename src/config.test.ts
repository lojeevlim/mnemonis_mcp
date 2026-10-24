import { describe, expect, it } from "vitest";
import { ConfigError, isLoopbackHost, parseConfig, proxyWarnings } from "./config.js";

const base = { DATABASE_URL: "postgres://u:s3cret@localhost/x" };

describe("parseConfig", () => {
  it("has secure defaults: loopback host, registration open only on loopback, 100 users, 7/30 day sessions", () => {
    const c = parseConfig(base);
    expect(c).toMatchObject({
      allowRegistration: true,
      allowedEmails: [],
      maxUsers: 100,
      sessionIdleDays: 7,
      sessionMaxDays: 30,
      maxMcpTokens: 20,
      trustProxy: false,
      autoMigrate: false,
      host: "127.0.0.1",
      port: 8787,
    });
  });

  it("requires DATABASE_URL", () => {
    expect(() => parseConfig({})).toThrowError(ConfigError);
    expect(() => parseConfig({ DATABASE_URL: "  " })).toThrowError(/DATABASE_URL/);
  });

  it("registration defaults to closed on a non-loopback HOST", () => {
    expect(parseConfig({ ...base, HOST: "0.0.0.0" }).allowRegistration).toBe(false);
    expect(parseConfig({ ...base, HOST: "localhost" }).allowRegistration).toBe(true);
    expect(parseConfig({ ...base, HOST: "::1" }).allowRegistration).toBe(true);
    expect(parseConfig({ ...base, MNEMONIS_ALLOW_REGISTRATION: "false" }).allowRegistration).toBe(false);
  });

  it("fails fast when registration is enabled on a non-loopback HOST without explicit allowed origins", () => {
    expect(() => parseConfig({ ...base, HOST: "0.0.0.0", MNEMONIS_ALLOW_REGISTRATION: "true" })).toThrowError(/MNEMONIS_ALLOWED_ORIGINS/);
    const ok = parseConfig({ ...base, HOST: "0.0.0.0", MNEMONIS_ALLOW_REGISTRATION: "1", MNEMONIS_ALLOWED_ORIGINS: "https://app.example.com" });
    expect(ok.allowRegistration).toBe(true);
    // explicitly closed needs nothing extra
    expect(parseConfig({ ...base, HOST: "0.0.0.0", MNEMONIS_ALLOW_REGISTRATION: "false" }).allowRegistration).toBe(false);
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
    expect(parseConfig({ ...base, MNEMONIS_ALLOWED_EMAILS: "A@x.test, @Y.test" }).allowedEmails).toEqual(["a@x.test", "@y.test"]);
  });

  it("parses user and session limits and rejects out-of-range values", () => {
    const c = parseConfig({ ...base, MNEMONIS_MAX_USERS: "5", MNEMONIS_SESSION_IDLE_DAYS: "2", MNEMONIS_SESSION_MAX_DAYS: "10" });
    expect(c).toMatchObject({ maxUsers: 5, sessionIdleDays: 2, sessionMaxDays: 10 });
    for (const env of [{ MNEMONIS_MAX_USERS: "0" }, { MNEMONIS_MAX_USERS: "x" }, { MNEMONIS_SESSION_IDLE_DAYS: "0" }, { MNEMONIS_SESSION_MAX_DAYS: "366" }]) {
      expect(() => parseConfig({ ...base, ...env })).toThrowError(ConfigError);
    }
    expect(() => parseConfig({ ...base, MNEMONIS_SESSION_IDLE_DAYS: "20", MNEMONIS_SESSION_MAX_DAYS: "10" })).toThrowError(/SESSION_IDLE_DAYS/);
  });

  it("parses origins, hosts, proxy, migrate, token cap and port", () => {
    const c = parseConfig({
      ...base,
      MNEMONIS_ALLOWED_ORIGINS: "https://a.test, https://b.test",
      MNEMONIS_ALLOWED_HOSTS: "App.test",
      MNEMONIS_TRUST_PROXY: "true",
      MNEMONIS_AUTO_MIGRATE: "1",
      MNEMONIS_MAX_MCP_TOKENS: "5",
      PORT: "0",
    });
    expect(c.allowedOrigins).toEqual(["https://a.test", "https://b.test"]);
    expect(c.allowedHosts).toEqual(["app.test"]);
    expect(c.trustProxy).toBe(true);
    expect(c.autoMigrate).toBe(true);
    expect(c.maxMcpTokens).toBe(5);
    expect(c.port).toBe(0);
  });

  it("ignores the removed Supabase / JWT settings", () => {
    const c = parseConfig({ ...base, SUPABASE_URL: "https://x.supabase.co", AUTH_ISSUER: "x", MNEMONIS_SIGNUP_MODE: "open" });
    expect(Object.keys(c).some((k) => /auth|supabase|signup/i.test(k))).toBe(false);
  });

  it("never prints secret values in errors", () => {
    for (const env of [
      { DATABASE_URL: "postgres://u:s3cret@db/x", PORT: "s3cret" },
      { ...base, MNEMONIS_MAX_USERS: "s3cret" },
      { ...base, MNEMONIS_ALLOW_REGISTRATION: "s3cret" },
      { ...base, MNEMONIS_ALLOWED_EMAILS: "s3cret" },
    ]) {
      try {
        parseConfig(env);
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).not.toContain("s3cret");
      }
    }
  });

  it("quota, hashing and remote-database settings: defaults, overrides and range checks", () => {
    expect(parseConfig(base)).toMatchObject({ maxWorkspaceBytes: 5 * 1024 * 1024, maxMemories: 5000, hashConcurrency: 2 });
    const c = parseConfig({ ...base, MNEMONIS_MAX_WORKSPACE_BYTES: "2048", MNEMONIS_MAX_MEMORIES: "10", MNEMONIS_HASH_CONCURRENCY: "4" });
    expect(c).toMatchObject({ maxWorkspaceBytes: 2048, maxMemories: 10, hashConcurrency: 4 });
    for (const env of [{ MNEMONIS_MAX_WORKSPACE_BYTES: "10" }, { MNEMONIS_MAX_MEMORIES: "0" }, { MNEMONIS_HASH_CONCURRENCY: "0" }, { MNEMONIS_HASH_CONCURRENCY: "99" }]) {
      expect(() => parseConfig({ ...base, ...env })).toThrowError(ConfigError);
    }
  });

  it("refuses a DATABASE_URL whose host is not local unless MNEMONIS_ALLOW_REMOTE_DB is set, without echoing the URL", () => {
    const remote = { DATABASE_URL: "postgres://postgres:s3cretpw@db.abcdefgh.supabase.co:5432/postgres" };
    try {
      parseConfig(remote);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toMatch(/MNEMONIS_ALLOW_REMOTE_DB/);
      for (const leaked of ["s3cretpw", "supabase", "abcdefgh", "postgres://"]) expect((e as Error).message).not.toContain(leaked);
    }
    expect(parseConfig({ ...remote, MNEMONIS_ALLOW_REMOTE_DB: "true" }).databaseUrl).toBe(remote.DATABASE_URL);
    expect(() => parseConfig({ ...remote, MNEMONIS_ALLOW_REMOTE_DB: "false" })).toThrowError(/MNEMONIS_ALLOW_REMOTE_DB/);
    for (const local of ["postgres://u:p@localhost:5433/x", "postgres://u:p@127.0.0.1/x", "postgresql://u:p@[::1]:5432/x"]) {
      expect(parseConfig({ DATABASE_URL: local }).databaseUrl).toBe(local);
    }
  });

  it("proxyWarnings: loud for a non-loopback HOST, silent on loopback, never fatal", () => {
    expect(proxyWarnings({ host: "127.0.0.1", trustProxy: false })).toEqual([]);
    expect(proxyWarnings({ host: "0.0.0.0", trustProxy: false }).join(" ")).toMatch(/MNEMONIS_TRUST_PROXY is unset/);
    expect(proxyWarnings({ host: "0.0.0.0", trustProxy: true }).join(" ")).toMatch(/ONLY through your proxy/);
    expect(() => parseConfig({ ...base, HOST: "0.0.0.0", MNEMONIS_ALLOW_REGISTRATION: "false" })).not.toThrow();
  });

  it("normalises allowlist entries like emails (NFKC, lowercase)", () => {
    expect(parseConfig({ ...base, MNEMONIS_ALLOWED_EMAILS: "\uff21@\uff58.test, @\uff39.TEST" }).allowedEmails).toEqual(["a@x.test", "@y.test"]);
  });

  it("isLoopbackHost", () => {
    for (const h of ["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "192.168.1.5", "example.com", "::"]) expect(isLoopbackHost(h)).toBe(false);
  });
});
