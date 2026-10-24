import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type pg from "pg";
import { createPgAudit } from "../audit.js";
import { normalizeEmail } from "../auth/email.js";
import { createPasswordHasher, passwordProblemMessage, validatePassword, type PasswordHasher } from "../auth/password.js";
import { revokeUserSessions } from "../auth/sessions.js";
import { clearForUser, forgetIps } from "../auth/throttle.js";
import { MAX_IMPORT_BYTES } from "../domain/index.js";
import { parseImportJson } from "../store/importJson.js";
import { PgStore } from "../store/pgStore.js";
import { StoreError } from "../store/types.js";
import type { Quotas } from "../store/quota.js";

export const USAGE = `Usage: npm run user -- <command>

  list                                  id, email, createdAt, disabled, hasPassword (never a hash)
  reset <email> [--generate] [--revoke-tokens]
                                        set a new password (hidden prompt, or --generate prints a one-time temporary
                                        password to stdout); revokes ALL sessions and clears the login lockout.
                                        --revoke-tokens also revokes the user's MCP tokens
  disable <email> | enable <email>      block / allow sign-in (disable also revokes all sessions)
  unlock <email>                        clear the login lockout and failure counters
  import-file <email> [path] [--force]  import a legacy workspace.json (default ~/.mnemonis/workspace.json) into the user's
                                        workspace; refuses unless it is empty (rev 0) or --force. The file is never modified
`;

export interface OperatorDeps {
  pool: pg.Pool;
  /** stdout: results (and, with --generate, ONLY the temporary password). */
  out(line: string): void;
  /** stderr: notices and errors. */
  err(line: string): void;
  /** Hidden-input prompt (no echo). */
  readPassword(question: string): Promise<string>;
  hasher?: PasswordHasher;
  /** Where the default workspace.json lives (default: the OS home directory). */
  home?: string;
  quotas?: Partial<Quotas>;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  disabled_at: Date | null;
}

const OPTIONS = {
  generate: { type: "boolean" },
  "revoke-tokens": { type: "boolean" },
  force: { type: "boolean" },
} as const;

/** A temporary password: 18 random bytes (24 base64url characters), far past the policy minimum. */
const generatePassword = (): string => randomBytes(18).toString("base64url");

/**
 * Runs one operator command against the database. Returns the process exit code (0 ok, 1 failed, 2 usage).
 * Every state change writes an audit row (via "operator", action names and outcomes only: never passwords, hashes or content).
 */
export async function runUserCommand(argv: string[], deps: OperatorDeps): Promise<number> {
  const { pool, out, err } = deps;
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    err(`${e instanceof Error ? e.message : "Invalid arguments"}\n\n${USAGE}`);
    return 2;
  }
  const [cmd, ...rest] = parsed.positionals;
  const flags = parsed.values;
  const usage = (): number => {
    err(USAGE);
    return 2;
  };
  const audit = createPgAudit(pool);
  const record = (action: string, userId: string | null, ok: boolean, code?: string): void =>
    audit.record({ userId, via: "operator", client: "operator-cli", action, ok, ...(code ? { code } : {}) });

  const find = async (rawEmail: string | undefined): Promise<UserRow | null> => {
    const email = normalizeEmail(rawEmail);
    if (!email) {
      err("That is not a valid email address.");
      return null;
    }
    const r = await pool.query<UserRow>("SELECT id, email, display_name, disabled_at FROM users WHERE lower(email) = $1", [email]);
    if (!r.rows[0]) err("No such user.");
    return r.rows[0] ?? null;
  };

  try {
    switch (cmd) {
      case "list": {
        if (rest.length) return usage();
        const r = await pool.query<{ id: string; email: string; created_at: Date; disabled_at: Date | null; has_password: boolean }>(
          "SELECT id, email, created_at, disabled_at, password_hash IS NOT NULL AS has_password FROM users ORDER BY created_at, id",
        );
        out(["id", "email", "createdAt", "disabled", "hasPassword"].join("\t"));
        for (const u of r.rows) out([u.id, u.email, u.created_at.toISOString(), u.disabled_at ? "yes" : "no", u.has_password ? "yes" : "no"].join("\t"));
        return 0;
      }

      case "reset": {
        if (rest.length !== 1) return usage();
        const user = await find(rest[0]);
        if (!user) return 1;
        let password: string;
        if (flags.generate) password = generatePassword();
        else {
          password = await deps.readPassword("New password: ");
          if (password !== (await deps.readPassword("Repeat new password: "))) {
            err("The passwords do not match. Nothing was changed.");
            return 1;
          }
          const check = validatePassword(password, user.email);
          if (!check.ok) {
            err(`${passwordProblemMessage[check.problem]}. Nothing was changed.`);
            return 1;
          }
        }
        const hash = await (deps.hasher ?? createPasswordHasher()).hash(password);
        await pool.query("UPDATE users SET password_hash = $2, password_updated_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1", [user.id, hash]);
        await clearForUser(pool, user.email, user.id);
        await forgetIps(pool, user.id);
        const sessions = await revokeUserSessions(pool, user.id);
        let tokens = 0;
        if (flags["revoke-tokens"]) {
          tokens = (await pool.query("UPDATE api_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [user.id])).rowCount ?? 0;
        }
        record(flags["revoke-tokens"] ? "user:reset+revoke-tokens" : "user:reset", user.id, true);
        if (flags.generate) {
          err("Temporary password (shown once; the user should change it after signing in) on stdout:");
          out(password);
        }
        err(`Password reset. Revoked ${sessions} session(s)${flags["revoke-tokens"] ? ` and ${tokens} MCP token(s)` : ""}; login lockout cleared.`);
        return 0;
      }

      case "disable":
      case "enable": {
        if (rest.length !== 1) return usage();
        const user = await find(rest[0]);
        if (!user) return 1;
        if (cmd === "disable") {
          await pool.query("UPDATE users SET disabled_at = COALESCE(disabled_at, now()) WHERE id = $1", [user.id]);
          const sessions = await revokeUserSessions(pool, user.id);
          out(`User disabled. Revoked ${sessions} session(s); MCP tokens stop working while the user is disabled.`);
        } else {
          await pool.query("UPDATE users SET disabled_at = NULL WHERE id = $1", [user.id]);
          out("User enabled.");
        }
        record(`user:${cmd}`, user.id, true);
        return 0;
      }

      case "unlock": {
        if (rest.length !== 1) return usage();
        const user = await find(rest[0]);
        if (!user) return 1;
        const cleared = await clearForUser(pool, user.email, user.id);
        await pool.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [user.id]);
        record("user:unlock", user.id, true);
        out(`Login lockout cleared (${cleared} throttle record(s) removed).`);
        return 0;
      }

      case "import-file": {
        if (rest.length < 1 || rest.length > 2) return usage();
        const user = await find(rest[0]);
        if (!user) return 1;
        const path = rest[1] ?? join(deps.home ?? homedir(), ".mnemonis", "workspace.json");
        let json: string;
        try {
          if (statSync(path).size > MAX_IMPORT_BYTES) throw new StoreError("corrupt", "Import failed: file is too large");
          json = readFileSync(path, "utf8"); // read-only: the source file is never written, moved or deleted
          parseImportJson(json); // validates + migrates (migrateWorkspaceState); throws StoreError without echoing content
        } catch (e) {
          err(e instanceof StoreError ? e.message : "Cannot read the file.");
          record("user:import-file", user.id, false, "invalid_file");
          return 1;
        }
        const store = new PgStore(pool, deps.quotas);
        await store.ensureWorkspace(user.id);
        const mine = store.forUser(user.id);
        const before = await mine.read();
        const s = before.state;
        const empty = before.rev === 0 && [s.memories, s.revisions, s.relations, s.collections].every((m) => Object.keys(m).length === 0);
        if (!empty && !flags.force) {
          err(`The user's workspace is not empty (revision ${before.rev}). Nothing was imported; pass --force to replace it.`);
          record("user:import-file", user.id, false, "workspace_not_empty");
          return 1;
        }
        let after;
        try {
          after = await mine.replace(json, { ifMatchRev: before.rev });
        } catch (e) {
          err(e instanceof StoreError ? e.message : "Import failed.");
          record("user:import-file", user.id, false, e instanceof StoreError ? e.code : "io");
          return 1;
        }
        const n = (m: object): number => Object.keys(m).length;
        out(
          `Imported: ${n(after.state.memories)} memories, ${n(after.state.revisions)} revisions, ${n(after.state.relations)} relations, ${n(after.state.collections)} collections (revision ${after.rev}).`,
        );
        record("user:import-file", user.id, true);
        return 0;
      }

      default:
        return usage();
    }
  } catch (e) {
    // Driver errors can carry connection details: report the class only.
    err(`Failed: ${e instanceof Error ? (e.name === "Error" ? e.message : e.name) : "unknown error"}`);
    return 1;
  } finally {
    await audit.flush();
  }
}
