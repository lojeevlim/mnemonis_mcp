import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeAddCommand, ensureToken, readToken, rotateToken, tokenId, tokenPath, verifyToken } from "../src/auth/token.js";

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "mnemonis-tok-")), "data");
});
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

describe("token", () => {
  it("creates once with 0600 file in a 0700 dir and stays stable", () => {
    const a = ensureToken(dir);
    expect(a.created).toBe(true);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(tokenPath(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const b = ensureToken(dir);
    expect(b).toEqual({ token: a.token, created: false });
    expect(readToken(dir)).toBe(a.token);
  });

  it("rotate replaces it (still 0600)", () => {
    const a = ensureToken(dir).token;
    const r = rotateToken(dir);
    expect(r).not.toBe(a);
    expect(readToken(dir)).toBe(r);
    expect(statSync(tokenPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("verifyToken is exact and rejects empty/missing", () => {
    expect(verifyToken("abc", "abc")).toBe(true);
    expect(verifyToken("abd", "abc")).toBe(false);
    expect(verifyToken("abcd", "abc")).toBe(false);
    expect(verifyToken("", "abc")).toBe(false);
    expect(verifyToken("abc", null)).toBe(false);
    expect(verifyToken(undefined, "abc")).toBe(false);
  });

  it("tokenId does not reveal the token", () => {
    expect(tokenId("secret-token-value")).toMatch(/^[0-9a-f]{12}$/);
    expect(tokenId("secret-token-value")).not.toContain("secret");
  });

  it("claude add command has the verified flag syntax", () => {
    expect(claudeAddCommand("T")).toBe(
      'claude mcp add --transport http mnemonis http://localhost:8787/mcp --header "Authorization: Bearer T"',
    );
  });
});
