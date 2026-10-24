import { DomainError, type DomainContext } from "./context.js";

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Keys that must never be used as ids / map keys (prototype pollution and lookup hazards). */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export const isReservedKey = (k: string): boolean => RESERVED_KEYS.has(k);

/** Own-property lookup: never returns Object.prototype members for "__proto__", "toString", etc. */
export function safeGet<T>(map: Readonly<Record<string, T>>, key: string | null | undefined): T | undefined {
  if (key === null || key === undefined) return undefined;
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

export function assertSafeId(id: string, what: string): void {
  if (isReservedKey(id)) throw new DomainError("invalid_input", `${what} id is reserved: ${id}`);
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

/** True for finite-number / string / boolean / null / array / plain-object trees (bounded depth). */
export function isJsonValue(v: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1));
  if (isPlainObject(v)) return Object.values(v).every((x) => isJsonValue(x, depth + 1));
  return false;
}

export function normalizeTags(tags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const t = raw.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function requireText(value: string | undefined, what: string): string {
  const v = (value ?? "").trim();
  if (!v) throw new DomainError("invalid_input", `${what} is required`);
  return v;
}

export function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * A new id that is not yet taken. Regenerates a few times (a clock/counter collision is harmless);
 * fails with "duplicate_id" rather than ever overwriting an existing record.
 */
export function freshId(ctx: DomainContext, prefix: string, taken: (id: string) => boolean): string {
  for (let i = 0; i < 100; i++) {
    const id = ctx.newId(prefix);
    if (!isReservedKey(id) && !taken(id)) return id;
  }
  throw new DomainError("duplicate_id", `Could not generate an unused ${prefix} id`);
}
