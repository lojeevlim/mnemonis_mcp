import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { isCommonPassword } from "./commonPasswords.js";

export const PASSWORD_MIN_CHARS = 12;
/** Bytes, not characters: checked BEFORE hashing so a huge body can never reach scrypt. */
export const PASSWORD_MAX_BYTES = 128;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LEN = 64;
const SALT_LEN = 16;
const MAXMEM = 128 * 1024 * 1024;
/** Bounds applied to stored parameters so a corrupted or hostile row cannot demand unbounded CPU or memory. */
const MIN_N = 2 ** 10;
const MAX_N = 2 ** 16;
const MAX_R = 8;
const MAX_P = 4;

export type PasswordProblem = "too_short" | "too_long" | "common" | "matches_email";

export const passwordProblemMessage: Record<PasswordProblem, string> = {
  too_short: `Password must be at least ${PASSWORD_MIN_CHARS} characters`,
  too_long: `Password must be at most ${PASSWORD_MAX_BYTES} bytes`,
  common: "That password is too common; choose another",
  matches_email: "Password must not be based on your email address",
};

/** Policy: min 12 characters, max 128 bytes, no composition rules, no very common passwords, not based on the email (address, local part, or local part plus digits). */
export function validatePassword(password: string, email?: string): { ok: true } | { ok: false; problem: PasswordProblem } {
  if (typeof password !== "string") return { ok: false, problem: "too_short" };
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) return { ok: false, problem: "too_long" };
  if ([...password].length < PASSWORD_MIN_CHARS) return { ok: false, problem: "too_short" };
  if (email) {
    const lower = password.normalize("NFKC").toLowerCase();
    const full = email.toLowerCase();
    const local = full.split("@")[0]!;
    // the whole address, the local part, or the local part followed only by digits (alice2024)
    if (lower === full || (local.length > 0 && (lower === local || (lower.startsWith(local) && /^\d+$/.test(lower.slice(local.length)))))) {
      return { ok: false, problem: "matches_email" };
    }
  }
  if (isCommonPassword(password)) return { ok: false, problem: "common" };
  return { ok: true };
}

/** True when the password is too large to ever be hashed or compared (callers treat it as a plain mismatch). */
export const exceedsPasswordBytes = (password: string): boolean => Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES;

export class PasswordBusyError extends Error {
  constructor() {
    super("Too many password operations in progress");
    this.name = "PasswordBusyError";
  }
}

/** Counting semaphore with a bounded wait queue: scrypt runs on the libuv pool and would otherwise starve the server. */
export function createSemaphore(maxConcurrent: number, maxQueue: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= maxConcurrent) {
        if (waiting.length >= maxQueue) throw new PasswordBusyError();
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else active++;
      try {
        return await fn();
      } finally {
        const next = waiting.shift();
        if (next) next(); // hand the slot over without releasing it
        else active--;
      }
    },
    stats: () => ({ active, waiting: waiting.length }),
  };
}

const derive = (password: string, salt: Buffer, { N, r, p }: ScryptParams): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LEN, { N, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });

interface Parsed extends ScryptParams {
  salt: Buffer;
  hash: Buffer;
}

function parse(stored: string): Parsed | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = [parts[1]!, parts[2]!, parts[3]!].map((x) => (/^\d{1,9}$/.test(x) ? Number(x) : NaN)) as [number, number, number];
  if (!Number.isInteger(Math.log2(N)) || N < MIN_N || N > MAX_N || !(r >= 1 && r <= MAX_R) || !(p >= 1 && p <= MAX_P)) return null;
  const salt = Buffer.from(parts[4]!, "base64");
  const hash = Buffer.from(parts[5]!, "base64");
  if (salt.length !== SALT_LEN || hash.length !== KEY_LEN) return null;
  return { N, r, p, salt, hash };
}

export interface PasswordHasherOptions {
  params?: ScryptParams;
  /** Concurrent scrypt hashes (default 2: each one occupies a libuv threadpool thread, the pool has 4 by default). */
  maxConcurrent?: number;
  maxQueue?: number;
}

export const DEFAULT_HASH_CONCURRENCY = 2;

export interface PasswordHasher {
  readonly params: ScryptParams;
  /** `scrypt$N$r$p$<salt b64>$<hash b64>` */
  hash(password: string): Promise<string>;
  /** false for a mismatch AND for any malformed stored hash. Throws PasswordBusyError when the queue is full. */
  verify(password: string, stored: string): Promise<boolean>;
  /** True when the stored hash uses weaker parameters than this hasher's (or cannot be parsed). */
  needsRehash(stored: string): boolean;
  /** Burns the same work as a real verification (unknown user / no password / disabled): always false. */
  dummyVerify(password: string): Promise<false>;
  /** Computes the dummy hash up front so the first unknown-email login costs the same as any other. Never rejects. */
  warm(): Promise<void>;
}

export function createPasswordHasher(opts: PasswordHasherOptions = {}): PasswordHasher {
  const params = opts.params ?? DEFAULT_SCRYPT;
  const gate = createSemaphore(opts.maxConcurrent ?? DEFAULT_HASH_CONCURRENCY, opts.maxQueue ?? 32);
  let dummy: Promise<Parsed> | undefined;
  const dummyHash = (): Promise<Parsed> =>
    (dummy ??= gate.run(async () => {
      const salt = randomBytes(SALT_LEN);
      return { ...params, salt, hash: await derive(randomBytes(16).toString("hex"), salt, params) };
    }).catch((e: unknown) => {
      dummy = undefined;
      throw e;
    }));

  const dummyVerify = async (password: string): Promise<false> => {
    const d = await dummyHash();
    if (!exceedsPasswordBytes(password)) {
      const key = await gate.run(() => derive(password, d.salt, d));
      timingSafeEqual(key, d.hash);
    }
    return false;
  };

  return {
    params,
    async hash(password) {
      const salt = randomBytes(SALT_LEN);
      const key = await gate.run(() => derive(password, salt, params));
      return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64")}$${key.toString("base64")}`;
    },
    async verify(password, stored) {
      const parsed = parse(stored);
      if (!parsed) return dummyVerify(password); // a corrupt stored hash costs the same as a real one (no timing signal)
      if (exceedsPasswordBytes(password)) return false;
      const key = await gate.run(() => derive(password, parsed.salt, parsed));
      return timingSafeEqual(key, parsed.hash);
    },
    needsRehash(stored) {
      const p = parse(stored);
      return !p || p.N < params.N || p.r < params.r || p.p < params.p;
    },
    dummyVerify,
    async warm() {
      await dummyHash().then(() => undefined, () => undefined);
    },
  };
}
