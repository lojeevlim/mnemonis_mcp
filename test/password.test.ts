import { describe, expect, it } from "vitest";
import { COMMON_PASSWORDS } from "../src/auth/commonPasswords.js";
import {
  createPasswordHasher,
  createSemaphore,
  DEFAULT_HASH_CONCURRENCY,
  DEFAULT_SCRYPT,
  PASSWORD_MAX_BYTES,
  PasswordBusyError,
  validatePassword,
} from "../src/auth/password.js";

const fast = { N: 2 ** 10, r: 8, p: 1 };
const GOOD = "correct horse battery staple";

describe("validatePassword", () => {
  it("accepts a long passphrase with no composition rules", () => {
    expect(validatePassword(GOOD, "me@example.com").ok).toBe(true);
    expect(validatePassword("aaaaaaaaaaab", undefined).ok).toBe(true);
    expect(validatePassword("ünïcödé-pässwörd-ok", undefined).ok).toBe(true);
  });

  it("requires 12 characters (not bytes)", () => {
    expect(validatePassword("a1B2c3D4e5F", undefined)).toEqual({ ok: false, problem: "too_short" });
    expect(validatePassword("a1B2c3D4e5F6", undefined).ok).toBe(true);
    expect(validatePassword("日本語日本語日本語日本語", undefined).ok).toBe(true); // 12 characters, 36 bytes
  });

  it("caps at 128 BYTES", () => {
    expect(validatePassword("x1".repeat(64), undefined).ok).toBe(true); // 128 bytes
    expect(validatePassword("x".repeat(PASSWORD_MAX_BYTES) + "y", undefined)).toEqual({ ok: false, problem: "too_long" });
    expect(validatePassword("é".repeat(65), undefined)).toEqual({ ok: false, problem: "too_long" }); // 130 bytes, 65 chars
  });

  it("rejects common passwords, repeats and runs, case-insensitively and with trailing digits", () => {
    for (const p of ["password1234", "PASSWORD123456", "Password!!!!!!", "qwertyuiop12", "aaaaaaaaaaaa", "123456789012", "abcdefghijkl", "iloveyou2024", "Letmein123456"]) {
      expect(validatePassword(p, undefined), p).toEqual({ ok: false, problem: "common" });
    }
    expect(COMMON_PASSWORDS.has("password")).toBe(true);
  });

  it("rejects a password equal to the email local part", () => {
    expect(validatePassword("jonathan.smith", "Jonathan.Smith@example.com")).toEqual({ ok: false, problem: "matches_email" });
    expect(validatePassword("jonathan.smith!", "Jonathan.Smith@example.com").ok).toBe(true);
  });

  it("also rejects the full email address and the local part followed only by digits", () => {
    const email = "jonathan.smith@example.com";
    for (const p of ["Jonathan.Smith@Example.com", "jonathan.smith@example.com", "jonathan.smith2024", "Jonathan.Smith123456", "jonathan.smith1"]) {
      expect(validatePassword(p, email), p).toEqual({ ok: false, problem: "matches_email" });
    }
    for (const p of ["jonathan.smith-2024x", "2024jonathan.smith", "jonathan.smith.example!"]) {
      expect(validatePassword(p, email).ok, p).toBe(true);
    }
  });

  it("the extended common list refuses more well-known passwords", () => {
    for (const p of ["correcthorsebatterystaple", "ilovemyfamily", "temppassword123", "p@ssword123456", "letmeinletmein", "adminadmin123"]) {
      expect(validatePassword(p, undefined), p).toEqual({ ok: false, problem: "common" });
    }
  });
});

describe("password hasher", () => {
  const h = createPasswordHasher({ params: fast });

  it("hashes to the documented format with a fresh salt each time", async () => {
    const a = await h.hash(GOOD);
    const b = await h.hash(GOOD);
    expect(a).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{88}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(GOOD);
  });

  it("verifies the right password and refuses the wrong ones", async () => {
    const stored = await h.hash(GOOD);
    expect(await h.verify(GOOD, stored)).toBe(true);
    expect(await h.verify(`${GOOD}!`, stored)).toBe(false);
    expect(await h.verify("", stored)).toBe(false);
    expect(await h.verify("x".repeat(500), stored)).toBe(false); // over the byte cap: never hashed
  });

  it("treats malformed or hostile stored hashes as a mismatch (never throws, never burns unbounded CPU)", async () => {
    const good = await h.hash(GOOD);
    const [, , r, p, salt, hash] = good.split("$");
    const bad = [
      "",
      "plain",
      "scrypt$1024$8$1$x",
      `scrypt$abc$8$1$${salt}$${hash}`,
      `scrypt$1000$8$1$${salt}$${hash}`, // not a power of two
      `scrypt$${2 ** 24}$8$1$${salt}$${hash}`, // memory bomb
      `scrypt$1024$${r}$99$${salt}$${hash}`,
      `scrypt$1024$64$${p}$${salt}$${hash}`,
      `bcrypt$1024$8$1$${salt}$${hash}`,
      `scrypt$1024$8$1$${salt}$${hash.slice(4)}`,
    ];
    for (const s of bad) expect(await h.verify(GOOD, s), s).toBe(false);
  });

  it("a corrupt stored hash costs the same work as a real verification (no timing signal), and is still false", async () => {
    const prod = createPasswordHasher(); // real parameters: a skipped hash would be ~0 ms, a real one tens of ms
    await prod.warm();
    const t0 = performance.now();
    expect(await prod.verify(GOOD, "garbage-not-a-hash")).toBe(false);
    expect(await prod.verify(GOOD, `scrypt$${2 ** 24}$8$1$AAAA$BBBB`)).toBe(false);
    expect(performance.now() - t0).toBeGreaterThan(30); // two verifications' worth of scrypt
    const t1 = performance.now();
    expect(await prod.verify("x".repeat(500), "garbage-not-a-hash")).toBe(false); // over the byte cap: never hashed
    expect(performance.now() - t1).toBeLessThan(30);
  });

  it("warm() computes the dummy hash up front and never rejects", async () => {
    const w = createPasswordHasher({ params: fast, maxConcurrent: 1, maxQueue: 0 });
    await expect(w.warm()).resolves.toBeUndefined();
    expect(await w.dummyVerify(GOOD)).toBe(false);
    // a failing warm-up (queue already full) does not reject and does not poison later use
    const busy = createPasswordHasher({ params: fast, maxConcurrent: 1, maxQueue: 0 });
    const blocker = busy.hash(GOOD);
    await expect(busy.warm()).resolves.toBeUndefined();
    await blocker;
    expect(await busy.dummyVerify(GOOD)).toBe(false);
  });

  it("flags weaker parameters for upgrade and not stronger or equal ones", async () => {
    const weak = await createPasswordHasher({ params: { N: 2 ** 10, r: 8, p: 1 } }).hash(GOOD);
    const strong = createPasswordHasher({ params: { N: 2 ** 11, r: 8, p: 1 } });
    expect(strong.needsRehash(weak)).toBe(true);
    expect(h.needsRehash(weak)).toBe(false);
    expect(h.needsRehash(await strong.hash(GOOD))).toBe(false);
    expect(h.needsRehash("garbage")).toBe(true);
    // a weaker hash still verifies under the stronger hasher (so login can upgrade it)
    expect(await strong.verify(GOOD, weak)).toBe(true);
  });

  it("dummyVerify does the work of a verification and is always false", async () => {
    expect(await h.dummyVerify(GOOD)).toBe(false);
    expect(await h.dummyVerify("")).toBe(false);
    expect(await h.dummyVerify("x".repeat(500))).toBe(false);
    const t0 = performance.now();
    await h.dummyVerify(GOOD);
    const dummy = performance.now() - t0;
    const stored = await h.hash(GOOD);
    const t1 = performance.now();
    await h.verify("wrong-password-here", stored);
    const real = performance.now() - t1;
    // same order of magnitude (generous bound: this guards against a dummy that skips the hash entirely)
    expect(dummy).toBeGreaterThan(real / 10);
  });

  it("the production defaults are scrypt N=2^15, r=8, p=1", async () => {
    expect(DEFAULT_SCRYPT).toEqual({ N: 32768, r: 8, p: 1 });
    const prod = createPasswordHasher();
    const stored = await prod.hash(GOOD);
    expect(stored.startsWith("scrypt$32768$8$1$")).toBe(true);
    expect(await prod.verify(GOOD, stored)).toBe(true);
    expect(prod.needsRehash(stored)).toBe(false);
  });
});

describe("concurrency semaphore", () => {
  it("defaults to 2 concurrent hashes so the 4-thread libuv pool is never starved", () => {
    expect(DEFAULT_HASH_CONCURRENCY).toBe(2);
  });

  it("runs at most N at once and queues the rest", async () => {
    const gate = createSemaphore(2, 10);
    let running = 0;
    let peak = 0;
    const task = () =>
      gate.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 15));
        running--;
      });
    await Promise.all(Array.from({ length: 8 }, task));
    expect(peak).toBe(2);
    expect(gate.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it("rejects with PasswordBusyError when the queue is full, and recovers afterwards", async () => {
    const gate = createSemaphore(1, 1);
    let release!: () => void;
    const blocker = gate.run(() => new Promise<void>((r) => (release = r)));
    const queued = gate.run(async () => "queued");
    await expect(gate.run(async () => "overflow")).rejects.toBeInstanceOf(PasswordBusyError);
    release();
    await blocker;
    expect(await queued).toBe("queued");
    expect(await gate.run(async () => "after")).toBe("after");
  });

  it("releases the slot when the task throws", async () => {
    const gate = createSemaphore(1, 1);
    await expect(gate.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await gate.run(async () => "ok")).toBe("ok");
  });

  it("the hasher surfaces a full queue as PasswordBusyError", async () => {
    const h = createPasswordHasher({ params: fast, maxConcurrent: 1, maxQueue: 0 });
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => h.hash(GOOD)));
    expect(results.some((r) => r.status === "rejected" && r.reason instanceof PasswordBusyError)).toBe(true);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });
});
