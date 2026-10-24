import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TOKEN_FILE = "token";

export const tokenPath = (dir: string): string => join(dir, TOKEN_FILE);

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort (not supported everywhere) */
  }
}

function writeToken(dir: string, token: string): void {
  ensureDir(dir);
  const file = tokenPath(dir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const generate = (): string => randomBytes(32).toString("base64url");

/** The stored token, or null when none exists / the file is empty. */
export function readToken(dir: string): string | null {
  const file = tokenPath(dir);
  if (!existsSync(file)) return null;
  const t = readFileSync(file, "utf8").trim();
  return t.length >= 16 ? t : null;
}

/** Reads the token, creating one (0600, dir 0700) on first run. `created` is true only for a new token. */
export function ensureToken(dir: string): { token: string; created: boolean } {
  const existing = readToken(dir);
  if (existing) return { token: existing, created: false };
  const token = generate();
  writeToken(dir, token);
  return { token, created: true };
}

/** Replaces the token. Running servers pick the new one up on the next request. */
export function rotateToken(dir: string): string {
  const token = generate();
  writeToken(dir, token);
  return token;
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant-time comparison (both sides hashed first so lengths never leak). */
export function verifyToken(presented: string | null | undefined, expected: string | null): boolean {
  if (!presented || !expected) return false;
  return timingSafeEqual(sha256(presented), sha256(expected));
}

/** Short non-reversible identifier for rate-limit buckets and the audit log (never the token itself). */
export function tokenId(token: string): string {
  return createHash("sha256").update("mnemonis-token-id:").update(token).digest("hex").slice(0, 12);
}

/** The exact command to register this server with Claude Code. */
export function claudeAddCommand(token: string, port = 8787): string {
  return `claude mcp add --transport http mnemonis http://localhost:${port}/mcp --header "Authorization: Bearer ${token}"`;
}
