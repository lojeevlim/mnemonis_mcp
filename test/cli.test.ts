import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliDeps } from "../src/cli/run.js";
import { readHidden } from "../src/cli/prompt.js";
import { loadCliEnv, parseEnvFile } from "../src/cli/env.js";
import { clearSession, loadSession, saveSession, sessionPaths, type Session } from "../src/cli/session.js";
import { assertAnonKey, CliError, parseOrigin } from "../src/cli/supabase.js";
import { hasUnsafeChars } from "../src/auth/sanitize.js";
import { startTestServer, TEST_DB_URL, type TestServer } from "./helpers.js";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeKey = (role: string) => `${b64({ alg: "HS256" })}.${b64({ role })}.sig`;
const ANON = fakeKey("anon");
const SB = "http://127.0.0.1:1";
const API = "http://127.0.0.1:8787";
/** A session bound to SB / API unless overridden. */
const sess = (o: Partial<Session> = {}): Session => ({ access_token: "a", refresh_token: "r", expires_at: 123, supabaseUrl: SB, apiUrl: API, ...o });
const FAR = () => Math.floor(Date.now() / 1000) + 3600;

interface MockApi {
  url: string;
  hits: string[];
  close: () => Promise<void>;
}
/** A throwaway local HTTP server standing in for the Mnemonis API. */
async function mockApi(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<MockApi> {
  const hits: string[] = [];
  const srv = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => handler(req, res, b));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    hits,
    close: () =>
      new Promise<void>((r) => {
        srv.closeAllConnections();
        srv.close(() => r());
      }),
  };
}
const json = (res: ServerResponse, v: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(v));

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mn-cli-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function harness(extra: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = { env: {}, out: (l) => out.push(l), err: (l) => err.push(l), home, ...extra };
  return { out, err, run: (...argv: string[]) => runCli(argv, deps), text: () => [...out, ...err].join("\n") };
}

describe("session store", () => {
  it("writes the dir 0700 and the file 0600 and round-trips", () => {
    const s = sess();
    saveSession(s, home);
    const { dir, file } = sessionPaths(home);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadSession(home)).toEqual(s);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort()).toEqual(["access_token", "apiUrl", "expires_at", "refresh_token", "supabaseUrl"]);
  });
  it("tightens a loose dir on save", () => {
    saveSession(sess(), home);
    const { dir, file } = sessionPaths(home);
    chmodSync(dir, 0o755);
    saveSession(sess({ access_token: "b" }), home);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it("refuses to load a file with loose permissions", () => {
    saveSession(sess(), home);
    chmodSync(sessionPaths(home).file, 0o644);
    expect(() => loadSession(home)).toThrow(/permissions are 644/);
    chmodSync(sessionPaths(home).file, 0o640);
    expect(() => loadSession(home)).toThrow(/must be 600/);
  });
  it("refuses a symlinked session file and a non-regular file", () => {
    saveSession(sess(), home);
    const { dir, file } = sessionPaths(home);
    const real = join(dir, "real.json");
    writeFileSync(real, readFileSync(file), { mode: 0o600 });
    rmSync(file);
    symlinkSync(real, file);
    expect(() => loadSession(home)).toThrow(/Refusing/);
    rmSync(file);
    mkdirSync(file);
    expect(() => loadSession(home)).toThrow(/Refusing/);
  });
  it("refuses a symlinked session directory for save, load and clear", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "mn-cli-else-"));
    try {
      symlinkSync(elsewhere, sessionPaths(home).dir);
      expect(() => saveSession(sess(), home)).toThrow(/symlink/);
      expect(() => loadSession(home)).toThrow(/symlink/);
      expect(() => clearSession(home)).toThrow(/symlink/);
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
  it("ignores leftover tmp files and leaves no tmp behind, even when the save fails", () => {
    saveSession(sess(), home);
    const { dir, file } = sessionPaths(home);
    writeFileSync(`${file}.1234.tmp`, "stale", { mode: 0o600 });
    saveSession(sess({ access_token: "b" }), home);
    expect(readdirSync(dir).sort()).toEqual(["cli-session.json", "cli-session.json.1234.tmp"]);
    expect(loadSession(home)?.access_token).toBe("b");
    // a failing rename (target is a directory) must unlink its own tmp
    rmSync(file);
    mkdirSync(file);
    expect(() => saveSession(sess(), home)).toThrow();
    expect(readdirSync(dir).sort()).toEqual(["cli-session.json", "cli-session.json.1234.tmp"]);
  });
  it("clear deletes; corrupt or incomplete file reads as no session", () => {
    saveSession(sess(), home);
    expect(clearSession(home)).toBe(true);
    expect(existsSync(sessionPaths(home).file)).toBe(false);
    expect(clearSession(home)).toBe(false);
    saveSession(sess(), home);
    writeFileSync(sessionPaths(home).file, "{nope", { mode: 0o600 });
    expect(loadSession(home)).toBeNull();
    writeFileSync(sessionPaths(home).file, JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: 1 }), { mode: 0o600 });
    expect(loadSession(home)).toBeNull();
  });
});

describe("anon key allowlist", () => {
  const rejected: [string, string][] = [
    ["service_role JWT", fakeKey("service_role")],
    ["authenticated JWT", fakeKey("authenticated")],
    ["supabase_admin JWT", fakeKey("supabase_admin")],
    ["uppercase ANON role", fakeKey("ANON")],
    ["role-less JWT", `${b64({ alg: "x" })}.${b64({ sub: "1" })}.sig`],
    ["array payload", `${b64({ alg: "x" })}.${b64([1])}.sig`],
    ["non-JSON payload", "aaa.bbb.ccc"],
    ["two parts", `${b64({})}.${b64({ role: "anon" })}`],
    ["bad base64url chars", `${b64({})}.${b64({ role: "anon" })}.si g`],
    ["sb_secret_", "sb_secret_abc"],
    ["SB_SECRET_ (any case)", "SB_SECRET_abc"],
    ["Sb_Publishable_ (case-sensitive)", "Sb_Publishable_abc"],
    ["empty publishable suffix", "sb_publishable_"],
    ["opaque", "just-some-opaque-key"],
    ["empty", ""],
  ];
  it.each(rejected)("refuses %s without printing it", (_n, key) => {
    let msg = "";
    try {
      assertAnonKey(key);
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/SUPABASE_ANON_KEY/);
    if (key) expect(msg).not.toContain(key);
  });
  it("accepts a publishable key and an anon JWT", () => {
    expect(() => assertAnonKey("sb_publishable_abc123")).not.toThrow();
    expect(() => assertAnonKey(ANON)).not.toThrow();
  });
  it.each(rejected.slice(0, 4))("login refuses %s before prompting or any network call", async (_n, key) => {
    let asked = false;
    let called = false;
    const h = harness({
      env: { SUPABASE_URL: SB, SUPABASE_ANON_KEY: key },
      askPassword: async () => ((asked = true), "pw"),
      fetch: (async () => ((called = true), new Response("{}"))) as typeof fetch,
    });
    expect(await h.run("login", "--email", "a@b.c")).toBe(1);
    expect(asked || called).toBe(false);
    expect(h.text()).not.toContain(key);
  });
  it("a refresh re-checks the key and makes no network call", async () => {
    saveSession(sess({ expires_at: 1 }), home);
    let called = false;
    const h = harness({ env: { SUPABASE_URL: SB, SUPABASE_ANON_KEY: fakeKey("service_role"), MNEMONIS_API_URL: API }, fetch: (async () => ((called = true), new Response("{}"))) as typeof fetch });
    expect(await h.run("me")).toBe(1);
    expect(called).toBe(false);
    expect(h.err.join("")).toMatch(/SUPABASE_ANON_KEY/);
  });
});

describe("URL validation", () => {
  const ok: [string, string][] = [
    ["https://abc.supabase.co", "https://abc.supabase.co"],
    ["https://abc.supabase.co/", "https://abc.supabase.co"],
    ["https://abc.supabase.co/some/path/", "https://abc.supabase.co"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
    ["http://127.9.9.9", "http://127.9.9.9"],
    ["http://[::1]:8787", "http://[::1]:8787"],
    ["https://example.com:8443", "https://example.com:8443"],
  ];
  it.each(ok)("accepts %s as %s", (raw, origin) => expect(parseOrigin("X_URL", raw)).toBe(origin));
  const bad = [
    "http://example.com",
    "http://localhost.evil.com",
    "http://127.0.0.1.evil.com",
    "http://10.0.0.1",
    "ftp://example.com",
    "javascript:alert(1)",
    "not a url",
    "",
    "https://user:hunter2@example.com",
    "https://user@example.com",
    "https://example.com?a=1",
    "https://example.com?",
    "https://example.com#frag",
    "https://example.com/#",
  ];
  it.each(bad)("refuses %j naming only the variable", (raw) => {
    let msg = "";
    try {
      parseOrigin("X_URL", raw);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/^X_URL /);
    expect(msg).not.toContain("hunter2");
    expect(msg).not.toContain("example.com");
  });
  it("the CLI validates both URLs before any prompt or network call", async () => {
    for (const env of [
      { SUPABASE_URL: "http://evil.example", SUPABASE_ANON_KEY: ANON },
      { SUPABASE_URL: SB, SUPABASE_ANON_KEY: ANON, MNEMONIS_API_URL: "https://u:p@example.com" },
    ]) {
      let touched = false;
      const h = harness({
        env,
        askLine: async () => ((touched = true), "a@b.c"),
        askPassword: async () => ((touched = true), "pw"),
        fetch: (async () => ((touched = true), new Response("{}"))) as typeof fetch,
      });
      expect(await h.run("login")).toBe(1);
      expect(touched).toBe(false);
      expect(h.err.join("")).toMatch(/_URL/);
      expect(h.text()).not.toMatch(/evil\.example|u:p/);
    }
    const h = harness({ env: { MNEMONIS_API_URL: "http://example.com" }, fetch: (async () => { throw new Error("no"); }) as typeof fetch });
    expect(await h.run("health")).toBe(1);
    expect(h.err.join("")).toMatch(/MNEMONIS_API_URL/);
  });
});

describe(".env handling", () => {
  it("reads only the three CLI keys, never anything else", () => {
    const parsed = parseEnvFile(
      ['# c', "DATABASE_URL=postgres://u:secret@h/db", 'export SUPABASE_URL="https://x.supabase.co"', "SUPABASE_ANON_KEY='sb_publishable_k'", "MNEMONIS_API_URL=http://127.0.0.1:1 # note", "OTHER=1"].join("\n"),
      ["SUPABASE_URL", "SUPABASE_ANON_KEY", "MNEMONIS_API_URL"],
    );
    expect(parsed).toEqual({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "sb_publishable_k", MNEMONIS_API_URL: "http://127.0.0.1:1" });
  });
  it("loadCliEnv prefers process.env, falls back to the file, and drops unrelated variables", () => {
    const f = join(home, ".env");
    writeFileSync(f, "DATABASE_URL=postgres://secret\nSUPABASE_URL=https://file.example\nSUPABASE_ANON_KEY=sb_publishable_file\n");
    const env = loadCliEnv({ SUPABASE_URL: "https://proc.example", DATABASE_URL: "postgres://proc", PATH: "/bin" }, f);
    expect(env).toEqual({ SUPABASE_URL: "https://proc.example", SUPABASE_ANON_KEY: "sb_publishable_file", MNEMONIS_API_URL: undefined });
    expect(JSON.stringify(env)).not.toContain("postgres");
    expect(loadCliEnv({}, join(home, "missing.env"))).toEqual({ SUPABASE_URL: undefined, SUPABASE_ANON_KEY: undefined, MNEMONIS_API_URL: undefined });
  });
});

describe("hidden prompt", () => {
  it("refuses non-TTY input", async () => {
    const input = new PassThrough();
    await expect(readHidden("Password: ", { input, output: new PassThrough() })).rejects.toThrow(/interactively/);
  });
  it("does not echo what is typed", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
    const output = new PassThrough();
    let seen = "";
    output.on("data", (d) => (seen += d));
    const p = readHidden("Password: ", { input, output });
    input.write("hunter2-secret\n");
    expect(await p).toBe("hunter2-secret");
    expect(seen).toContain("Password: ");
    expect(seen).not.toContain("hunter2");
  });
  it("login rejects a password in argv and never uses it", async () => {
    let called = false;
    const h = harness({
      env: { SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_ANON_KEY: ANON },
      fetch: (async () => ((called = true), new Response("{}"))) as typeof fetch,
    });
    for (const a of [["--password", "topsecret"], ["--password=topsecret"]]) {
      expect(await h.run("login", "--email", "a@b.c", ...a)).toBe(1);
    }
    expect(called).toBe(false);
    expect(h.text()).not.toContain("topsecret");
  });
});

describe("auth against a mock Supabase", () => {
  let srv: Server;
  let base: string;
  let calls: { grant: string | null; apikey: string | undefined; body: Record<string, string>; path: string; auth: string | undefined }[];
  let respond: (grant: string | null, body: Record<string, string>) => { status: number; json: unknown };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => res(b));
    });
  beforeAll(async () => {
    srv = createServer(async (req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      const body = JSON.parse((await readBody(req)) || "{}") as Record<string, string>;
      const grant = u.searchParams.get("grant_type");
      calls.push({ grant, apikey: req.headers.apikey as string | undefined, body, path: u.pathname + u.search, auth: req.headers.authorization });
      const r = respond(grant, body);
      res.writeHead(r.status, { "Content-Type": "application/json" }).end(JSON.stringify(r.json));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));
  beforeEach(() => {
    calls = [];
    respond = (grant) => ({ status: 200, json: { access_token: `at-${grant}`, refresh_token: "rt2", expires_in: 3600 } });
  });
  const env = () => ({ SUPABASE_URL: base, SUPABASE_ANON_KEY: ANON });

  it("login posts the password grant with the apikey header and stores no password", async () => {
    const h = harness({ env: env(), askPassword: async () => "s3cret-pw" });
    expect(await h.run("login", "--email", "me@example.test")).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ grant: "password", apikey: ANON, body: { email: "me@example.test", password: "s3cret-pw" } });
    expect(readFileSync(sessionPaths(home).file, "utf8")).not.toContain("s3cret-pw");
    expect(loadSession(home)?.access_token).toBe("at-password");
    expect(h.text()).not.toContain("s3cret-pw");
  });
  it("failed login prints a clean error and stores nothing", async () => {
    respond = () => ({ status: 400, json: { error_description: "Invalid login credentials" } });
    const h = harness({ env: env(), askPassword: async () => "wrong-pw" });
    expect(await h.run("login", "--email", "me@example.test")).toBe(1);
    expect(h.err.join("")).toContain("Invalid login credentials");
    expect(h.text()).not.toContain("wrong-pw");
    expect(loadSession(home)).toBeNull();
  });
  it("refreshes before a call when expiring within 60s, and tells the user to log in when refresh fails", async () => {
    const seen: string[] = [];
    const api = createServer((req, res) => {
      seen.push(String(req.headers.authorization));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "1", email: "e", displayName: "d" }));
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    try {
      const now = () => 1_000_000;
      saveSession(sess({ access_token: "old", refresh_token: "rt1", expires_at: 1_000_030, supabaseUrl: base, apiUrl }), home);
      const h = harness({ env: { ...env(), MNEMONIS_API_URL: apiUrl }, now });
      expect(await h.run("me")).toBe(0);
      expect(calls.map((c) => c.grant)).toEqual(["refresh_token"]);
      expect(calls[0]!.body.refresh_token).toBe("rt1");
      expect(seen).toEqual(["Bearer at-refresh_token"]);
      expect(loadSession(home)?.refresh_token).toBe("rt2");
      // fresh token: no refresh
      calls = [];
      saveSession(sess({ access_token: "fresh", refresh_token: "rt1", expires_at: 1_000_500, supabaseUrl: base, apiUrl }), home);
      expect(await h.run("me")).toBe(0);
      expect(calls).toHaveLength(0);
      // refresh failure
      respond = () => ({ status: 400, json: { error: "invalid_grant" } });
      saveSession(sess({ access_token: "old", refresh_token: "dead", expires_at: 1_000_000, supabaseUrl: base, apiUrl }), home);
      const h2 = harness({ env: { ...env(), MNEMONIS_API_URL: apiUrl }, now });
      expect(await h2.run("me")).toBe(1);
      expect(h2.err.join("")).toMatch(/login/);
      expect(h2.text()).not.toContain("dead");
    } finally {
      await new Promise<void>((r) => api.close(() => r()));
    }
  });
  it("on 401 refreshes once and retries; a second 401 asks for login", async () => {
    let n = 0;
    let always401 = false;
    const api = createServer((req, res) => {
      n++;
      const ok = !always401 && req.headers.authorization === "Bearer at-refresh_token";
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" }).end(JSON.stringify(ok ? { id: "1", email: "e", displayName: "d" } : { error: { code: "unauthorized", message: "no" } }));
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    try {
      saveSession(sess({ access_token: "stale", refresh_token: "rt1", expires_at: FAR(), supabaseUrl: base, apiUrl }), home);
      const h = harness({ env: { ...env(), MNEMONIS_API_URL: apiUrl } });
      expect(await h.run("me")).toBe(0);
      expect(n).toBe(2);
      expect(calls).toHaveLength(1);
      always401 = true;
      calls = [];
      const h2 = harness({ env: { ...env(), MNEMONIS_API_URL: apiUrl } });
      expect(await h2.run("me")).toBe(1);
      expect(calls).toHaveLength(1);
      expect(h2.err.join("")).toMatch(/login/);
    } finally {
      await new Promise<void>((r) => api.close(() => r()));
    }
  });
  it("stores the issuing hosts in the session", async () => {
    const h = harness({ env: { ...env(), MNEMONIS_API_URL: `${base}/ignored/path` }, askPassword: async () => "pw" });
    expect(await h.run("login", "--email", "me@example.test")).toBe(0);
    expect(loadSession(home)).toMatchObject({ supabaseUrl: base, apiUrl: base });
    expect(h.out.join("")).toContain(sessionPaths(home).file);
  });

  it("refuses to use or refresh a session on different hosts", async () => {
    const fetched: string[] = [];
    const f = (async (u: string) => (fetched.push(String(u)), new Response("{}"))) as unknown as typeof fetch;
    saveSession(sess({ expires_at: 1, supabaseUrl: base, apiUrl: API }), home);
    for (const e of [
      { ...env(), MNEMONIS_API_URL: "http://127.0.0.1:9" }, // other API host
      { SUPABASE_URL: "http://127.0.0.1:2", SUPABASE_ANON_KEY: ANON, MNEMONIS_API_URL: API }, // other Supabase host
      { SUPABASE_ANON_KEY: ANON, MNEMONIS_API_URL: API }, // no Supabase host
    ]) {
      const h = harness({ env: e, fetch: f });
      expect(await h.run("me")).toBe(1);
      expect(h.err.join("")).toMatch(/different .*hosts.*login again/);
    }
    expect(fetched).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("skips the refresh when another process already refreshed the session", async () => {
    const SBX = "http://127.0.0.1:2";
    const hits: string[] = [];
    saveSession(sess({ access_token: "old", refresh_token: "rt-old", expires_at: FAR(), supabaseUrl: SBX, apiUrl: API }), home);
    const f = (async (u: string, init: RequestInit) => {
      hits.push(String(u));
      const auth = (init.headers as Record<string, string>).Authorization;
      if (String(u).startsWith(SBX)) return new Response(JSON.stringify({ access_token: "mine", refresh_token: "rt-mine", expires_in: 3600 }));
      if (auth === "Bearer old") {
        // meanwhile, another process refreshed and saved a newer session
        saveSession(sess({ access_token: "other", refresh_token: "rt-other", expires_at: FAR() + 100, supabaseUrl: SBX, apiUrl: API }), home);
        return new Response("{}", { status: 401 });
      }
      return new Response(JSON.stringify({ id: "1", email: "e", displayName: "d" }));
    }) as unknown as typeof fetch;
    const h = harness({ env: { SUPABASE_URL: SBX, SUPABASE_ANON_KEY: ANON, MNEMONIS_API_URL: API }, fetch: f });
    expect(await h.run("me")).toBe(0);
    expect(hits.some((u) => u.startsWith(SBX))).toBe(false);
    expect(loadSession(home)?.refresh_token).toBe("rt-other");
  });

  it("logout revokes remotely (scope local) and deletes the file", async () => {
    saveSession(sess({ access_token: "the-access", supabaseUrl: base }), home);
    const h = harness({ env: env() });
    expect(await h.run("logout")).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/auth/v1/logout?scope=local", apikey: ANON, auth: "Bearer the-access" });
    expect(h.out.join("")).toMatch(/revoked remotely/);
    expect(existsSync(sessionPaths(home).file)).toBe(false);
  });
  it("logout says plainly when it could only delete locally", async () => {
    respond = () => ({ status: 500, json: {} });
    saveSession(sess({ supabaseUrl: base }), home);
    const h = harness({ env: env() });
    expect(await h.run("logout")).toBe(0);
    expect(h.out.join("")).toMatch(/deleted only; NOT revoked remotely/);
    expect(existsSync(sessionPaths(home).file)).toBe(false);
    // no Supabase config at all, and a session from a different Supabase host: never sent anywhere
    for (const e of [{}, { SUPABASE_URL: "http://127.0.0.1:2", SUPABASE_ANON_KEY: ANON }]) {
      calls = [];
      saveSession(sess({ supabaseUrl: base }), home);
      const g = harness({ env: e });
      expect(await g.run("logout")).toBe(0);
      expect(g.out.join("")).toMatch(/NOT revoked remotely/);
      expect(calls).toEqual([]);
      expect(existsSync(sessionPaths(home).file)).toBe(false);
    }
    const none = harness({ env: env() });
    expect(await none.run("logout")).toBe(0);
    expect(none.out.join("")).toBe("No stored session.");
  });

  it("every request refuses redirects and carries a timeout signal", async () => {
    const seen: RequestInit[] = [];
    const f = (async (_u: string, init: RequestInit) => (seen.push(init), new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 60 })))) as unknown as typeof fetch;
    const h = harness({ env: env(), askPassword: async () => "pw", fetch: f });
    await h.run("login", "--email", "a@b.c");
    saveSession(sess({ expires_at: FAR(), supabaseUrl: base, apiUrl: API }), home);
    await harness({ env: { ...env(), MNEMONIS_API_URL: API }, fetch: f }).run("me");
    await harness({ env: env(), fetch: f }).run("logout");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const init of seen) {
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it("does not follow a redirect (the token never reaches the target)", async () => {
    const target = await mockApi((_q, res) => json(res, { id: "x", email: "stolen", displayName: "d" }));
    const redirector = await mockApi((_q, res) => res.writeHead(302, { Location: `${target.url}/api/me` }).end());
    try {
      saveSession(sess({ expires_at: FAR(), supabaseUrl: base, apiUrl: redirector.url }), home);
      const h = harness({ env: { ...env(), MNEMONIS_API_URL: redirector.url } });
      expect(await h.run("me")).toBe(1);
      expect(h.err.join("")).toMatch(/Cannot reach/);
      expect(target.hits).toEqual([]);
      // and the Supabase side: a redirecting auth endpoint fails the login
      const authRedirect = await mockApi((_q, res) => res.writeHead(307, { Location: `${target.url}/x` }).end());
      try {
        const g = harness({ env: { SUPABASE_URL: authRedirect.url, SUPABASE_ANON_KEY: ANON }, askPassword: async () => "pw" });
        expect(await g.run("login", "--email", "a@b.c")).toBe(1);
        expect(target.hits).toEqual([]);
      } finally {
        await authRedirect.close();
      }
    } finally {
      await redirector.close();
      await target.close();
    }
  });
  it("gives up on a server that never answers", async () => {
    const hang = await mockApi(() => undefined);
    try {
      saveSession(sess({ expires_at: FAR(), supabaseUrl: base, apiUrl: hang.url }), home);
      const h = harness({ env: { ...env(), MNEMONIS_API_URL: hang.url }, timeoutMs: 150 });
      const t0 = Date.now();
      expect(await h.run("me")).toBe(1);
      expect(h.err.join("")).toMatch(/Cannot reach/);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(await harness({ env: { MNEMONIS_API_URL: hang.url }, timeoutMs: 150 }).run("health")).toBe(1);
    } finally {
      await hang.close();
    }
  });
});

describe("no session / unreachable server", () => {
  it("asks to log in without a session", async () => {
    const h = harness({ env: {} });
    expect(await h.run("me")).toBe(1);
    expect(h.err.join("")).toMatch(/login/);
  });
  it("reports an unreachable server without a stack trace or token", async () => {
    saveSession(sess({ access_token: "tok-secret", expires_at: FAR(), supabaseUrl: SB, apiUrl: "http://127.0.0.1:1" }), home);
    const h = harness({ env: { SUPABASE_URL: SB, MNEMONIS_API_URL: "http://127.0.0.1:1" } });
    expect(await h.run("me")).toBe(1);
    expect(h.text()).toMatch(/Cannot reach/);
    expect(h.text()).not.toMatch(/tok-secret|\n\s+at /);
  });
  it("unknown command exits non-zero; usage without a command goes to stderr", async () => {
    expect(await harness().run("bogus")).toBe(1);
    const h = harness();
    expect(await h.run()).toBe(1);
    expect(h.out).toEqual([]);
    expect(h.err.join("")).toMatch(/Usage:/);
    const g = harness();
    expect(await g.run("help")).toBe(0);
    expect(g.out.join("")).toMatch(/Usage:/);
  });
  it("validates --days locally (1..365) before any request", async () => {
    let called = false;
    for (const d of ["0", "366", "-1", "abc", "1.5", "1000", ""]) {
      const h = harness({ fetch: (async () => ((called = true), new Response("{}"))) as typeof fetch });
      expect(await h.run("tokens", "create", "x", `--days=${d}`)).toBe(1);
      expect(h.err.join("")).toMatch(/--days/);
    }
    expect(called).toBe(false);
  });
});

describe.skipIf(!TEST_DB_URL)("CLI against a real test server", () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer();
  });
  afterAll(async () => {
    await t.close();
  });
  const cli = async (user = t.a) => {
    saveSession(sess({ access_token: user.jwt, refresh_token: "unused", expires_at: FAR(), supabaseUrl: SB, apiUrl: t.url }), home);
    return harness({ env: { SUPABASE_URL: SB, MNEMONIS_API_URL: t.url } });
  };

  it("health and me", async () => {
    const h = await cli();
    expect(await h.run("health")).toBe(0);
    expect(h.out.join("")).toContain("OK");
    expect(await h.run("me")).toBe(0);
    expect(h.out.join("\n")).toContain(t.a.email);
    expect(h.out.join("\n")).toContain(t.a.displayName);
  });

  it("tokens create/list/revoke prints the token once with the claude line", async () => {
    const h = await cli();
    expect(await h.run("tokens", "create", "my laptop", "--days", "7")).toBe(0);
    const text = h.out.join("\n");
    const token = /mn_[A-Za-z0-9_-]+/.exec(text)?.[0];
    expect(token).toBeTruthy();
    expect(text.split(token!).length - 1).toBe(1); // printed exactly once
    expect(text).toMatch(/shell history/);
    expect(text).toMatch(/long-lived/);
    expect(text).toContain(`claude mcp add --transport http mnemonis ${t.url}/mcp --header "Authorization: Bearer ${token}"`);
    const id = /Token (\S+) created/.exec(text)![1]!;
    h.out.length = 0;
    expect(await h.run("tokens", "list")).toBe(0);
    expect(h.out.join("\n")).toContain("my laptop");
    expect(h.out.join("\n")).not.toContain(token!);
    expect(await h.run("tokens", "revoke", id)).toBe(0);
    h.out.length = 0;
    await h.run("tokens", "list");
    expect(h.out.join("\n")).toContain("revoked");
    expect(await h.run("tokens", "create", "x", "--days", "0")).toBe(1);
    expect(h.err.join("")).toMatch(/--days/);
  });

  it("inbox lists agent proposals; approve, reject and approve-all work", async () => {
    const agent = { kind: "agent", name: "claude-test" };
    const mk = async (title: string) => {
      const r = (await (await t.op("createMemory", { title, content: "c", actor: agent })).json()) as { state: { revisions: Record<string, { id: string; memoryId: string; snapshot: { title: string } }> } };
      return Object.values(r.state.revisions).find((x) => x.snapshot.title === title)!.id;
    };
    const r1 = await mk("Proposal one");
    const r2 = await mk("Proposal two");
    const r3 = await mk("Proposal three");
    const h = await cli();
    expect(await h.run("inbox")).toBe(0);
    let text = h.out.join("\n");
    for (const id of [r1, r2, r3]) expect(text).toContain(id);
    expect(text).toContain("Proposal one");
    expect(text).toContain("claude-test");

    expect(await h.run("approve", r1)).toBe(0);
    expect(await h.run("reject", r2)).toBe(0);
    h.out.length = 0;
    await h.run("inbox");
    text = h.out.join("\n");
    expect(text).not.toContain(r1);
    expect(text).not.toContain(r2);
    expect(text).toContain(r3);

    // approve-all needs --yes or a TTY confirmation
    const noTty = await cli();
    expect(await runCli(["approve-all"], { env: { SUPABASE_URL: SB, MNEMONIS_API_URL: t.url }, out: () => undefined, err: (l) => noTty.err.push(l), home, io: { input: new PassThrough(), output: new PassThrough() } })).toBe(1);
    expect(noTty.err.join("")).toMatch(/--yes/);
    expect(noTty.err.join("")).toMatch(/1 revision\(s\)/);
    let asked = "";
    const no = await cli();
    no.err.length = 0;
    expect(await runCli(["approve-all"], { env: { SUPABASE_URL: SB, MNEMONIS_API_URL: t.url }, out: (l) => no.out.push(l), err: () => undefined, home, confirm: async (q) => ((asked = q), false) })).toBe(1);
    expect(asked).toMatch(/1 revision\(s\) and 0 relation\(s\)/);
    expect((await t.a.service.getState()).state.revisions[r3]!.status).toBe("pending");
    expect(await h.run("approve-all", "--yes")).toBe(0);
    expect(h.out.join("\n")).toMatch(/1 revision\(s\)/);
    h.out.length = 0;
    await h.run("inbox");
    expect(h.out.join("\n")).toContain("Inbox is empty");
    const state = await t.a.service.getState();
    expect(state.state.revisions[r1]!.status).toBe("saved");
    expect(state.state.revisions[r2]!.status).toBe("rejected");
    expect(state.state.revisions[r3]!.status).toBe("saved");
  });

  it("approve-relation and reject-relation work, and the inbox lists pending relations", async () => {
    const agent = { kind: "agent", name: "linker" };
    const mem = async (title: string) => ((await (await t.op("createMemory", { title })).json()) as { value: { id: string } }).value.id;
    const [m1, m2, m3] = [await mem("Rel A"), await mem("Rel B"), await mem("Rel C")];
    const link = async (to: string, label: string) =>
      ((await (await t.op("addRelation", { fromId: m1, toId: to, label, actor: agent })).json()) as { value: { id: string } }).value.id;
    const ra = await link(m2, "supports");
    const rb = await link(m3, "contradicts");
    const h = await cli();
    expect(await h.run("inbox")).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain(ra);
    expect(text).toContain(rb);
    expect(text).toContain("supports");
    expect(await h.run("approve-relation", ra)).toBe(0);
    expect(await h.run("reject-relation", rb)).toBe(0);
    expect(h.out.join("\n")).toMatch(/Relation \S+ approved\./);
    expect(h.out.join("\n")).toMatch(/Relation \S+ rejected\./);
    const st = (await t.a.service.getState()).state;
    expect(st.relations[ra]!.status).toBe("saved");
    expect(st.relations[rb]!.status).toBe("rejected");
    expect(await h.run("approve-relation", "nope")).toBe(1);
    expect(h.err.join("")).toMatch(/not_found/);
  });

  it("prints server errors cleanly as code: message", async () => {
    const h = await cli();
    expect(await h.run("approve", "does-not-exist")).toBe(1);
    expect(h.err.join("")).toMatch(/^revision_not_found: /);
    expect(h.text()).not.toContain(t.a.jwt);
    expect(h.text()).not.toMatch(/\n\s+at /);
  });

  it("an invalid access token with a dead refresh asks for login", async () => {
    saveSession(sess({ access_token: "garbage", refresh_token: "dead", expires_at: FAR(), supabaseUrl: SB, apiUrl: t.url }), home);
    const h = harness({ env: { SUPABASE_URL: SB, MNEMONIS_API_URL: t.url } }); // no anon key: refresh cannot succeed
    expect(await h.run("me")).toBe(1);
    expect(h.text()).not.toContain("garbage");
  });
});

describe("output hygiene and token states against a mock API", () => {
  const ESC = "\u001b[2J\u001b]0;pwn\u0007";
  const BIDI = "\u202eevil\u2066x\u200b";
  const dirty = (s: string) => s.split("\n").some((l) => hasUnsafeChars(l));
  const hostile = (req: IncomingMessage, res: ServerResponse) => {
    const u = req.url ?? "";
    if (u === "/api/me") return json(res, { id: `id${ESC}`, email: `e${BIDI}`, displayName: `d${ESC}` });
    if (u === "/api/tokens" && req.method === "GET") {
      const past = new Date(Date.now() - 86_400_000).toISOString();
      const future = new Date(Date.now() + 86_400_000).toISOString();
      return json(res, {
        tokens: [
          { id: `t1${ESC}`, label: `lab${BIDI}`, prefix: `mn_${ESC}`, createdAt: past, expiresAt: past, revokedAt: null },
          { id: "t2", label: "live", prefix: "mn_live", createdAt: past, expiresAt: future, revokedAt: null },
          { id: "t3", label: "gone", prefix: "mn_gone", createdAt: past, expiresAt: future, revokedAt: past },
          { id: "t4", label: "forever", prefix: "mn_inf", createdAt: past, expiresAt: null, revokedAt: null },
        ],
      });
    }
    if (u === "/api/tokens" && req.method === "POST") return json(res, { id: `id${ESC}`, token: "mn_good-Token_123", expiresAt: null });
    if (u === "/api/state") {
      const rev = { id: `rv${ESC}`, memoryId: "m1", status: "pending", origin: "agent", author: `au${BIDI}`, createdAt: "2026-01-01T00:00:00.000Z", note: "", kind: "create", snapshot: { title: `ti${ESC}` } };
      const rel = { id: `rl${ESC}`, fromId: "m1", toId: "m-unknown", label: `la${BIDI}`, status: "pending", provenance: { origin: "process", createdBy: "u", process: `pr${ESC}` }, createdAt: "2026-01-01T00:00:00.000Z" };
      return json(res, { state: { memories: { m1: { id: "m1" } }, revisions: { [rev.id]: rev }, relations: { [rel.id]: rel }, collections: {} } });
    }
    if (u === "/api/ops/approveAll") return json(res, { value: { approvedRevisionIds: [] } }); // not an array
    if (u.startsWith("/api/ops/")) return json(res, { value: null });
    if (req.method === "DELETE") return void res.writeHead(204).end();
    json(res, { error: { code: "x", message: "y" } }, 404);
  };
  let api: MockApi;
  beforeAll(async () => {
    api = await mockApi(hostile);
  });
  afterAll(() => api.close());
  const go = () => {
    saveSession(sess({ expires_at: FAR(), supabaseUrl: SB, apiUrl: api.url }), home);
    return harness({ env: { SUPABASE_URL: SB, MNEMONIS_API_URL: api.url } });
  };

  it("sanitizes everything the server supplies", async () => {
    const h = go();
    for (const argv of [["me"], ["tokens", "list"], ["tokens", "create", "l"], ["inbox"], ["approve-all", "--yes"], ["tokens", "revoke", `x${ESC}`], ["approve", `x${BIDI}`]]) {
      expect(await h.run(...argv)).toBe(0);
    }
    const all = [...h.out, ...h.err].join("\n");
    expect(dirty(all)).toBe(false);
    expect(all).toMatch(/lab/);
    expect(all).toMatch(/rv/);
    // the unknown-memory fallback id and all fields were printed, but cleaned
    expect(all).toContain("m-unknown");
  });
  it("lists active, expired and revoked tokens", async () => {
    const h = go();
    expect(await h.run("tokens", "list")).toBe(0);
    const line = (id: string) => h.out.find((l) => l.startsWith(id))!;
    expect(line("t1")).toMatch(/expired/);
    expect(line("t2")).toMatch(/active/);
    expect(line("t3")).toMatch(/revoked/);
    expect(line("t4")).toMatch(/active/);
  });
  it("tolerates a non-array approveAll value", async () => {
    const h = go();
    expect(await h.run("approve-all", "--yes")).toBe(0);
    expect(h.err).toEqual([]);
  });
  it("refuses and never prints a malformed token", async () => {
    const bad = await mockApi((_q, res) => json(res, { id: "i", token: "mn_bad token\u001b[31m", expiresAt: null }));
    try {
      saveSession(sess({ expires_at: FAR(), supabaseUrl: SB, apiUrl: bad.url }), home);
      for (const token of ["mn_bad token\u001b[31m", "xx_abc", "mn_", "mn_a\nb", 5]) {
        const srv = await mockApi((_q, res) => json(res, { id: "i", token, expiresAt: null }));
        try {
          saveSession(sess({ expires_at: FAR(), supabaseUrl: SB, apiUrl: srv.url }), home);
          const h = harness({ env: { SUPABASE_URL: SB, MNEMONIS_API_URL: srv.url } });
          expect(await h.run("tokens", "create", "l")).toBe(1);
          expect(h.out).toEqual([]);
          expect(h.err.join("")).toMatch(/malformed token/);
          expect(h.err.join("")).not.toContain(String(token));
        } finally {
          await srv.close();
        }
      }
    } finally {
      await bad.close();
    }
  });
});
