import { hasUnsafeChars } from "./sanitize.js";

export const EMAIL_MAX = 254;

/**
 * The one email normalisation used by register, login, the allowlist and the operator CLI: NFKC, trim, lowercase,
 * no control/bidi/zero-width characters, `local@domain` with a dotted domain (so `a@b` is refused). Returns null when unusable.
 * Mixed-script confusables (for example Cyrillic look-alikes) are out of scope.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > EMAIL_MAX * 4) return null;
  const e = raw.normalize("NFKC").trim().toLowerCase();
  if (e.length === 0 || e.length > EMAIL_MAX || hasUnsafeChars(e)) return null;
  return /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(e) ? e : null;
}

/** Normalises an allowlist entry: `local@domain` or `@domain` (same NFKC/trim/lowercase rules). */
export function normalizeAllowEntry(raw: string): string {
  return raw.normalize("NFKC").trim().toLowerCase();
}
