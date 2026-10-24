// Non-global on purpose: RegExp.test() on a /g regex is stateful (lastIndex). Escapes are unicode escape sequences, never literals.
// Covers control chars (C0, DEL, C1, LS/PS), bidi overrides/embeddings/isolates, and zero-width/BOM chars.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEST = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200d\u2060\ufeff]/;
// eslint-disable-next-line no-control-regex
const UNSAFE_STRIP = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200d\u2060\ufeff]/g;

export const hasUnsafeChars = (s: string): boolean => UNSAFE_TEST.test(s);
export const stripUnsafeChars = (s: string): string => s.replace(UNSAFE_STRIP, "");
