import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe as baseDescribe, expect, it } from "vitest";
import { createAccountService, type AccountService } from "../src/auth/accounts.js";
import { createToken, verifyMcpToken } from "../src/auth/apiTokens.js";
import { createSession, verifySession } from "../src/auth/sessions.js";
import { rememberIp } from "../src/auth/throttle.js";
import { createPool } from "../src/db/pool.js";
import { createSequentialContext } from "../src/domain/index.js";
import { runUserCommand, type OperatorDeps } from "../src/operator/commands.js";
import { createMemoryService } from "../src/service/memoryService.js";
import { PgStore } from "../src/store/pgStore.js";
import { fastHasher, TEST_DB_URL } from "./helpers.js";
import { MemoryStore } from "./memoryStore.js";

const describe = baseDescribe.skipIf(!TEST_DB_URL);
const policy = { idleDays: 7, maxDays: 30 };
const USER = { kind: "user", name: "t" } as const;

describe("operator CLI (npm run user)", () => {
  let pool: Pool;
  let accounts: AccountService;
  const tag = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const dirs: string[] = [];
  const email = (n: string) => `${n}-${tag}@op-${tag}.example.test`;
  const pw = (n: string) => `Pw-${tag}-${n}-zebra-lamp`;

  const mkUser = async (name: string, password: string | null = pw(name)): Promise<string> => {
    const hash = password === null ? null : await fastHasher().hash(password);
    const r = await pool.query<{ id: string }>("INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id", [email(name), name, hash]);
    userIds.push(r.rows[0]!.id);
    await new PgStore(pool).ensureWorkspace(r.rows[0]!.id);
    return r.rows[0]!.id;
  };

  const run = async (argv: string[], over: Partial<OperatorDeps> & { prompts?: string[] } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const prompts = [...(over.prompts ?? [])];
    const code = await runUserCommand(argv, {
      pool,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      readPassword: async () => {
        if (prompts.length === 0) throw new Error("unexpected prompt");
        return prompts.shift()!;
      },
      hasher: fastHasher(),
      ...over,
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  const login = (n: string, password: string, ip = "127.0.0.1") => accounts.login({ email: email(n), password }, { ip });
  const hashOf = async (id: string) => (await pool.query("SELECT password_hash FROM users WHERE id = $1", [id])).rows[0].password_hash as string | null;
  const auditFor = async (id: string) => (await pool.query("SELECT via, client, action, ok, code, ids FROM audit_log WHERE user_id = $1 ORDER BY id", [id])).rows;

  beforeAll(() => {
    pool = createPool({ connectionString: TEST_DB_URL });
    accounts = createAccountService(pool, new PgStore(pool), { maxMcpTokens: 20, allowRegistration: true, allowedEmails: [], maxUsers: 1_000_000, sessionIdleDays: 7, sessionMaxDays: 30 }, { hasher: fastHasher() });
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  afterAll(async () => {
    await pool.query("DELETE FROM audit_log WHERE user_id = ANY($1::uuid[])", [userIds]);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
    await pool.end();
  });

  describe("list", () => {
    it("shows id, email, createdAt, disabled and hasPassword, and never a hash", async () => {
      const a = await mkUser("lista");
      const legacy = await mkUser("listlegacy", null);
      await pool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [legacy]);
      const r = await run(["list"]);
      expect(r.code).toBe(0);
      const lines = r.out.split("\n");
      expect(lines[0]).toBe("id\temail\tcreatedAt\tdisabled\thasPassword");
      const rowA = lines.find((l) => l.startsWith(a))!.split("\t");
      expect(rowA).toEqual([a, email("lista"), expect.stringMatching(/^\d{4}-\d\d-\d\dT/), "no", "yes"]);
      expect(lines.find((l) => l.startsWith(legacy))!.split("\t").slice(3)).toEqual(["yes", "no"]);
      expect(r.out).not.toContain("scrypt$");
      expect(r.out).not.toMatch(/password_hash|\$[A-Za-z0-9+/=]{20,}/);
    });
  });

  describe("reset", () => {
    it("prompts twice (no echo), sets the password, revokes ALL sessions, clears the lockout and known IPs, spares MCP tokens by default", async () => {
      const id = await mkUser("reset1");
      const s1 = (await createSession(pool, id, policy))!;
      const s2 = (await createSession(pool, id, policy))!;
      const tok = await createToken(pool, id, { label: "keep" });
      if (!tok.ok) throw new Error("token");
      for (let i = 0; i < 5; i++) await login("reset1", `wrong-password-${i}-xx`).catch(() => undefined);
      await expect(login("reset1", pw("reset1"))).rejects.toMatchObject({ code: "rate_limited" });
      await rememberIp(pool, id, "192.0.2.77");
      await pool.query("UPDATE users SET failed_logins = 3, locked_until = now() + interval '5 minutes' WHERE id = $1", [id]);

      const next = `New-${tag}-passphrase-quartz`;
      const r = await run(["reset", email("reset1")], { prompts: [next, next] });
      expect(r.code).toBe(0);
      expect(r.out + r.err).not.toContain(next);
      expect(r.err).toMatch(/Revoked 2 session/);
      expect(await verifySession(pool, s1.token, policy)).toBeNull();
      expect(await verifySession(pool, s2.token, policy)).toBeNull();
      expect(await verifyMcpToken(pool, tok.token)).not.toBeNull(); // tokens untouched without --revoke-tokens
      expect((await pool.query("SELECT 1 FROM login_throttle WHERE subject = ANY($1)", [[id]])).rowCount).toBe(0);
      expect((await pool.query("SELECT failed_logins, locked_until FROM users WHERE id = $1", [id])).rows[0]).toEqual({ failed_logins: 0, locked_until: null });
      expect((await pool.query("SELECT 1 FROM known_login_ips WHERE user_id = $1", [id])).rowCount).toBe(0);
      // the lockout is gone for real, the old password is dead and the new one works
      await expect(login("reset1", pw("reset1"))).rejects.toMatchObject({ code: "invalid_credentials" });
      expect((await login("reset1", next)).token).toMatch(/^ms_/);
      const audit = await auditFor(id);
      expect(audit).toEqual([expect.objectContaining({ via: "operator", client: "operator-cli", action: "user:reset", ok: true })]);
      expect(JSON.stringify(audit)).not.toContain(next);
    });

    it("--revoke-tokens also revokes the user's MCP tokens", async () => {
      const id = await mkUser("reset2");
      const tok = await createToken(pool, id, { label: "t" });
      if (!tok.ok) throw new Error("token");
      const r = await run(["reset", email("reset2"), "--revoke-tokens"], { prompts: ["Another-long-pass-9x", "Another-long-pass-9x"] });
      expect(r.code).toBe(0);
      expect(r.err).toMatch(/1 MCP token/);
      expect(await verifyMcpToken(pool, tok.token)).toBeNull();
      expect((await auditFor(id))[0]).toMatchObject({ action: "user:reset+revoke-tokens" });
    });

    it("--generate prints ONLY a one-time temporary password on stdout (notices go to stderr) and it works", async () => {
      const id = await mkUser("reset3");
      const r = await run(["reset", email("reset3"), "--generate"]); // no prompt needed
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^[A-Za-z0-9_-]{24}$/); // exactly one line: the password
      expect(r.err).not.toContain(r.out);
      expect((await login("reset3", r.out)).token).toMatch(/^ms_/);
      const r2 = await run(["reset", email("reset3"), "--generate"]);
      expect(r2.out).not.toBe(r.out); // fresh every time
      expect(JSON.stringify(await auditFor(id))).not.toContain(r.out);
    });

    it("a legacy user with a NULL password_hash is recoverable", async () => {
      const id = await mkUser("legacy1", null);
      await expect(login("legacy1", "anything-at-all-123")).rejects.toMatchObject({ code: "invalid_credentials" });
      const r = await run(["reset", email("legacy1")], { prompts: ["Recovered-pass-77x", "Recovered-pass-77x"] });
      expect(r.code).toBe(0);
      expect(await hashOf(id)).toMatch(/^scrypt\$/);
      expect((await login("legacy1", "Recovered-pass-77x")).token).toMatch(/^ms_/);
    });

    it("refuses mismatched or weak passwords and changes nothing", async () => {
      const id = await mkUser("reset4");
      const before = await hashOf(id);
      const mismatch = await run(["reset", email("reset4")], { prompts: ["Some-long-pass-1x", "Some-long-pass-2x"] });
      expect(mismatch.code).toBe(1);
      expect(mismatch.err).toMatch(/do not match/);
      const weak = await run(["reset", email("reset4")], { prompts: ["password1234", "password1234"] });
      expect(weak.code).toBe(1);
      expect(weak.err).toMatch(/too common/);
      const short = await run(["reset", email("reset4")], { prompts: ["short", "short"] });
      expect(short.code).toBe(1);
      expect(await hashOf(id)).toBe(before);
    });

    it("unknown or malformed emails are an error (exit 1) and usage mistakes exit 2", async () => {
      expect((await run(["reset", email("nobodyhere"), "--generate"])).code).toBe(1);
      expect((await run(["reset", "not-an-email", "--generate"])).code).toBe(1);
      expect((await run(["reset"])).code).toBe(2);
      expect((await run(["frobnicate"])).code).toBe(2);
      expect((await run([])).code).toBe(2);
      expect((await run(["reset", email("x"), "--wat"])).code).toBe(2);
    });
  });

  describe("disable / enable / unlock", () => {
    it("disable blocks sign-in and kills sessions at once; enable restores it; both are audited", async () => {
      const id = await mkUser("dis1");
      const s = (await createSession(pool, id, policy))!;
      const r = await run(["disable", email("dis1")]);
      expect(r.code).toBe(0);
      expect(await verifySession(pool, s.token, policy)).toBeNull();
      await expect(login("dis1", pw("dis1"))).rejects.toMatchObject({ code: "invalid_credentials" });
      expect((await run(["enable", email("dis1")])).code).toBe(0);
      expect((await login("dis1", pw("dis1"))).token).toMatch(/^ms_/);
      expect((await auditFor(id)).map((a) => a.action)).toEqual(["user:disable", "user:enable"]);
    });

    it("unlock clears the login lockout", async () => {
      const id = await mkUser("unl1");
      for (let i = 0; i < 5; i++) await login("unl1", `wrong-password-${i}-xx`).catch(() => undefined);
      await expect(login("unl1", pw("unl1"))).rejects.toMatchObject({ code: "rate_limited" });
      const r = await run(["unlock", email("unl1")]);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/cleared/);
      expect((await login("unl1", pw("unl1"))).token).toMatch(/^ms_/);
      expect((await auditFor(id))[0]).toMatchObject({ action: "user:unlock", via: "operator", ok: true });
    });
  });

  describe("import-file", () => {
    const fixture = async (titles: string[]): Promise<string> => {
      const svc = createMemoryService({ store: new MemoryStore(), ctx: createSequentialContext() });
      for (const title of titles) await svc.createMemory({ title, content: "body", actor: USER });
      return svc.exportJson();
    };
    const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
    const tmp = (): string => {
      const d = mkdtempSync(join(tmpdir(), "mnemonis-op-"));
      dirs.push(d);
      return d;
    };

    it("imports into an empty rev-0 workspace, prints counts only, and NEVER deletes or modifies the source file", async () => {
      const id = await mkUser("imp1");
      const dir = tmp();
      const file = join(dir, "workspace.json");
      writeFileSync(file, await fixture(["SECRET-TITLE-A", "SECRET-TITLE-B"]));
      const before = { sha: sha(file), mtime: statSync(file).mtimeMs };
      const r = await run(["import-file", email("imp1"), file]);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/Imported: 2 memories, \d+ revisions, 0 relations, 0 collections \(revision 1\)\./);
      expect(r.out + r.err).not.toContain("SECRET-TITLE");
      expect(existsSync(file)).toBe(true);
      expect({ sha: sha(file), mtime: statSync(file).mtimeMs }).toEqual(before);
      expect(Object.keys((await new PgStore(pool).forUser(id).read()).state.memories)).toHaveLength(2);
      expect((await auditFor(id))[0]).toMatchObject({ action: "user:import-file", ok: true, via: "operator" });
    });

    it("uses ~/.mnemonis/workspace.json by default", async () => {
      const id = await mkUser("imp2");
      const home = tmp();
      mkdirSync(join(home, ".mnemonis"));
      const file = join(home, ".mnemonis", "workspace.json");
      writeFileSync(file, await fixture(["one"]));
      const r = await run(["import-file", email("imp2")], { home });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/Imported: 1 memories/);
      expect(existsSync(file)).toBe(true);
      expect(Object.keys((await new PgStore(pool).forUser(id).read()).state.memories)).toHaveLength(1);
    });

    it("refuses a non-empty workspace (nothing changes, source intact) unless --force", async () => {
      const id = await mkUser("imp3");
      const dir = tmp();
      const file = join(dir, "w.json");
      writeFileSync(file, await fixture(["from-file-1", "from-file-2", "from-file-3"]));
      const store = new PgStore(pool);
      await createMemoryService({ store: store.forUser(id) }).createMemory({ title: "already here", actor: USER }); // rev 1
      const sourceSha = sha(file);
      const refused = await run(["import-file", email("imp3"), file]);
      expect(refused.code).toBe(1);
      expect(refused.err).toMatch(/not empty/);
      expect(refused.err).toMatch(/--force/);
      const snap = await store.forUser(id).read();
      expect(snap.rev).toBe(1);
      expect(Object.keys(snap.state.memories)).toHaveLength(1);
      expect(existsSync(file) && sha(file) === sourceSha).toBe(true);
      expect((await auditFor(id)).at(-1)).toMatchObject({ action: "user:import-file", ok: false, code: "workspace_not_empty" });

      const forced = await run(["import-file", email("imp3"), file, "--force"]);
      expect(forced.code).toBe(0);
      expect(forced.out).toMatch(/Imported: 3 memories/);
      expect(Object.keys((await store.forUser(id).read()).state.memories)).toHaveLength(3);
      expect(existsSync(file) && sha(file) === sourceSha).toBe(true);
    });

    it("also refuses when the revision is not 0 even if the workspace looks empty", async () => {
      const id = await mkUser("imp4");
      await pool.query("UPDATE workspaces SET rev = 4 WHERE user_id = $1", [id]);
      const file = join(tmp(), "w.json");
      writeFileSync(file, await fixture(["x"]));
      expect((await run(["import-file", email("imp4"), file])).code).toBe(1);
    });

    it("validates the file with the domain migrator: garbage, wrong shapes, NUL and a missing file are refused without echoing content", async () => {
      await mkUser("imp5");
      const dir = tmp();
      const bad = join(dir, "bad.json");
      for (const content of ["not json at all SECRET-CONTENT", '{"state":{"schemaVersion":99,"memories":[]}}', "{}", '{"a":"b\\u0000"}']) {
        writeFileSync(bad, content);
        const r = await run(["import-file", email("imp5"), bad]);
        expect(r.code, content).toBe(1);
        expect(r.err).toMatch(/Import failed/);
        expect(r.err).not.toContain("SECRET-CONTENT");
        expect(readFileSync(bad, "utf8")).toBe(content); // untouched
      }
      const missing = await run(["import-file", email("imp5"), join(dir, "nope.json")]);
      expect(missing.code).toBe(1);
      expect(missing.err).toMatch(/Cannot read/);
      expect((await new PgStore(pool).forUser((await pool.query("SELECT id FROM users WHERE lower(email) = $1", [email("imp5")])).rows[0].id).read()).rev).toBe(0);
    });

    it("applies the per-user quotas (an over-quota file is refused, not truncated)", async () => {
      const id = await mkUser("imp6");
      const file = join(tmp(), "w.json");
      writeFileSync(file, await fixture(["a", "b", "c"]));
      const r = await run(["import-file", email("imp6"), file], { quotas: { maxMemories: 2 } });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/limit of 2 memories/);
      expect((await new PgStore(pool).forUser(id).read()).rev).toBe(0);
    });
  });

  describe("as a real terminal-only process", () => {
    const child = (args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", "src/operator/index.ts", ...args], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "", DATABASE_URL: TEST_DB_URL! },
        encoding: "utf8",
        input: "", // stdin is not a TTY
        timeout: 60_000,
      });

    it("list works, --generate works, and a typed password is refused when stdin is not a TTY (never read from pipes)", async () => {
      const id = await mkUser("proc1");
      const list = child(["list"]);
      expect(list.status).toBe(0);
      expect(list.stdout).toContain(email("proc1"));
      const prompt = child(["reset", email("proc1")]);
      expect(prompt.status).toBe(1);
      expect(prompt.stderr).toMatch(/only be entered interactively/);
      expect(await hashOf(id)).not.toBeNull();
      const gen = child(["reset", email("proc1"), "--generate"]);
      expect(gen.status).toBe(0);
      expect(gen.stdout.trim()).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect((await login("proc1", gen.stdout.trim())).token).toMatch(/^ms_/);
      expect(gen.stderr).not.toContain(gen.stdout.trim());
    });
  });
});
